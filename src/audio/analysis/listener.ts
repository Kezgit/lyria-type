// Hears a mix as separate layers, live, for any source: kick, snare, hats,
// bass, lead, pad and fx (anything outside the band: a bird, a car, wind).
//
// Built on the standard tools for picking a mix apart:
//
//   Harmonic/percussive separation (HPSS, Fitzgerald 2010), causal: each bin's
//   median over the last frames is its sustained (harmonic) part, the median
//   across neighbouring bins is its transient (percussive) part; soft masks
//   split the spectrum in two. Drums are found only in the percussive part,
//   so a bass guitar's ringing harmonics can't trip the hats or the snare.
//
//   Onsets per region (SuperFlux, Böck & Widmer 2013): log-compressed,
//   vibrato-suppressed spectral flux against an adaptive threshold, then told
//   apart by where the transient's energy sits and how wide it spreads:
//     hats    percussive energy mostly above 6 kHz, broadband (noise)
//     snare   broadband noise in 1–5 kHz, usually with body (150–400 Hz)
//     kick    a sub onset that sweeps down and decays (decided ~50 ms in)
//     bass    a sub onset that holds steady (ditto)
//     lead    a sharp, narrow (tonal) attack in the mids that isn't an
//             overtone of the bass
//   Each hit carries how long ago it really started, so it lands on its
//   true step of the bar.
//
//   Multi-pitch by harmonic summation with iterative cancellation (after
//   Klapuri 2006): each candidate fundamental scores the weighted sum of its
//   harmonics; the best is taken and its harmonics removed, repeat. A bass
//   note with strong overtones is one note, not a pile of pads and leads.
//   Pitches are followed frame to frame into held keys: bass below ~196 Hz,
//   lead at the last lead attack's pitch, pad for chord tones that hold.
//
//   Whatever is new in the spectrum and none of that explains, held for a
//   moment (a car, wind, birdsong, a riser), is fx: described by where it sits
//   (low..high), whether it is tonal, and which way it sweeps.
//
// `listenerSens` (per layer, ~0..2) moves the detection thresholds themselves.

export const LAYERS = ['kick', 'snare', 'hat', 'bass', 'lead', 'pad', 'fx'] as const
export type Layer = (typeof LAYERS)[number]
export const KEY_LAYERS = ['bass', 'lead', 'pad'] as const
export type KeyLayer = (typeof KEY_LAYERS)[number]

/** A layer starting a sound. */
export interface LayerHit {
  layer: Layer
  /** 0..1 */
  strength: number
  /** MIDI pitch for keyed layers. */
  pitch: number | null
  /** Seconds since the sound actually started (some hits are confirmed a little after). */
  ago: number
}

export interface LayerFrame {
  /** 0..1 how much each layer is sounding now. */
  level: Record<Layer, number>
  hits: LayerHit[]
  /** MIDI pitches held right now, per keyed layer. */
  keys: Record<KeyLayer, number[]>
  /** The fx layer described: where it sits (0 low .. 1 high), how tonal (0..1), which way it sweeps (-1 down .. 1 up). */
  fx: { place: number; tonal: number; sweep: number }
  /** 0..1 how many layers sound at once (a full mix is ~1). */
  density: number
}

/** Detection sensitivity per layer (1 = default; higher hears quieter, less certain sounds). */
export const listenerSens = Object.fromEntries(LAYERS.map((l) => [l, 1])) as Record<Layer, number>

const zeroLevels = () => Object.fromEntries(LAYERS.map((l) => [l, 0])) as Record<Layer, number>

export function silentLayers(): LayerFrame {
  return { level: zeroLevels(), hits: [], keys: { bass: [], lead: [], pad: [] }, fx: { place: 0.5, tonal: 0, sweep: 0 }, density: 0 }
}

const midiOf = (hz: number) => 69 + 12 * Math.log2(hz / 440)
const hzOf = (midi: number) => 440 * Math.pow(2, (midi - 69) / 12)
const clamp01 = (v: number) => Math.max(0, Math.min(1, v))
const sensOf = (l: Layer) => Math.max(0.2, listenerSens[l])

/** One region's onset detector: flux against its own running mean and deviation. */
class Onsets {
  private mean = 0
  private dev = 0
  private peak = 1e-3
  private prev = 0
  private prev2 = 0
  private last = -1

  constructor(private k: number, private refractory: number) {}

  /** Feed this frame's flux; returns the strength (0..1) of an onset that peaked last frame, else 0. */
  feed(flux: number, dt: number, now: number, sens: number) {
    const threshold = this.mean + (this.k / sens) * this.dev + (0.02 / sens) * this.peak
    const hit = this.prev > threshold && this.prev >= flux && this.prev > this.prev2 && now - this.last > this.refractory
    const strength = hit ? clamp01((this.prev - this.mean) / Math.max(1e-6, this.peak - this.mean)) : 0
    if (hit) this.last = now
    const a = 1 - Math.exp(-dt / 0.4)
    this.mean += (flux - this.mean) * a
    this.dev += (Math.abs(flux - this.mean) - this.dev) * a
    this.peak = Math.max(flux, this.peak * Math.pow(0.5, dt / 4), 1e-4)
    this.prev2 = this.prev
    this.prev = flux
    return strength
  }
}

interface Track {
  midi: number
  /** Harmonic salience (relative). */
  amp: number
  age: number
  missing: number
  role: 'new' | 'bass' | 'lead' | 'pad' | 'fx'
  drift: number
  sweep: number
}

interface Note {
  midi: number
  salience: number
}

/** A sub onset waiting to be told kick or bass. */
interface LowEvent {
  at: number
  strength: number
  sub: number
  centroid: number
  body: number
  lowFlat: number
}

const FX_BANDS = 24
const fxEdge = (i: number) => 100 * Math.pow(160, i / FX_BANDS)
/** Seconds between analyses (≈ one 60 Hz frame). */
const HOP = 0.0155
const HPSS_TIME = 7 // frames in the harmonic median (~110 ms)
const HPSS_FREQ = 8 // bins either side in the percussive median
/** Below this share of steady peaks the mids are noise, not notes. */
const NOISY = 0.35
/** Highest bass note (G3). */
const BASS_TOP = 55

export class LayerListener {
  readonly fast: AnalyserNode
  readonly fine: AnalyserNode
  readonly frame: LayerFrame = silentLayers()
  /** This frame's raw measurements, for tuning. */
  readonly probe: Record<string, number> = {}

  private fastDb: Float32Array<ArrayBuffer>
  private fineDb: Float32Array<ArrayBuffer>
  private fastHz: number
  private fineHz: number
  private n: number
  private mag: Float32Array
  private history: Float32Array[] = []
  private perc: Float32Array
  private harm: Float32Array
  private comp: Float32Array
  private prevComp: Float32Array
  private raw: Float32Array
  private prevRaw: Float32Array
  private agoDb: Float32Array[] = []
  private now = 0
  /** Last frame's region measures: an onset is reported a frame after its peak, so decide on the larger of the two. */
  private last = { airSpread: 0, presSpread: 0, bodySpread: 0, midSpread: 1, hatShare: 0, presShare: 0, sub: 0, body: 0, pres: 0, air: 0, centroid: 0, presFlat: 0, airFlat: 0, lowFlat: 0 }

  private sub = new Onsets(2.2, 0.09)
  private snare = new Onsets(2.0, 0.09)
  private hat = new Onsets(1.4, 0.05)
  private mid = new Onsets(2.0, 0.08)
  private lows: LowEvent[] = []
  /** Recent kick/bass calls and why (for tuning). */
  readonly decisions: { at: number; kick: boolean; swept: number; body: number; lowFlat: number; dropped: number }[] = []
  /** When the last sub onset (kick or bass) began. */
  private lowAt = -1
  /** Hats and snares that land with a sub onset wait for its call: if it was a plucked bass note, they were its attack noise. */
  private drumsWaiting: { at: number; layer: 'hat' | 'snare'; strength: number }[] = []
  /** Recent bass calls (when their notes began). */
  private bassCalls: number[] = []
  /** Lead attacks wait ~40 ms in case a sub onset turns up with them (then they were its attack). */
  private leads: { at: number; strength: number; pitch: number }[] = []
  private subHistory: number[] = []
  private subPeak = -60
  private mixPeak = -60
  private drumQuiet = 0

  private tracks: Track[] = []
  private notePeak = 1e-3
  private leadPitch = -1
  private leadAt = -1
  private leadBin = -1
  private leadDb = -120
  private leadHeld = false
  private steady = 1
  private bassLevel = 0

  private fxNow = new Float32Array(FX_BANDS).fill(-120)
  private fxLong = new Float32Array(FX_BANDS).fill(-120)
  private fxRaw = 0
  private fxHeld = 0
  private fxPlace = 0.5
  private fxOn = false
  private highTone = 0
  private env = zeroLevels()

  constructor(ctx: AudioContext) {
    this.fast = ctx.createAnalyser()
    this.fast.fftSize = 2048
    this.fast.smoothingTimeConstant = 0
    this.fine = ctx.createAnalyser()
    this.fine.fftSize = 8192
    this.fine.smoothingTimeConstant = 0
    this.n = this.fast.frequencyBinCount
    this.fastDb = new Float32Array(this.n)
    this.fineDb = new Float32Array(this.fine.frequencyBinCount)
    this.mag = new Float32Array(this.n)
    this.perc = new Float32Array(this.n)
    this.harm = new Float32Array(this.n)
    this.comp = new Float32Array(this.n)
    this.prevComp = new Float32Array(this.n)
    this.raw = new Float32Array(this.n)
    this.prevRaw = new Float32Array(this.n)
    this.fastHz = ctx.sampleRate / this.fast.fftSize
    this.fineHz = ctx.sampleRate / this.fine.fftSize
  }

  connect(node: AudioNode) {
    node.connect(this.fast)
    node.connect(this.fine)
  }

  /** Tuning switch: skip the percussive-part checks. */
  noVeto = false
  /** Time gathered toward the next analysis hop. */
  private pending = 0

  update(dt: number, now: number): LayerFrame {
    const f = this.frame
    f.hits.length = 0
    // Analyse on a fixed ~16 ms hop whatever the display rate: at 120 Hz
    // consecutive frames overlap so much that attacks barely register.
    this.pending += dt
    if (this.pending < HOP) return f
    dt = this.pending
    this.pending = 0
    this.now = now
    this.fast.getFloatFrequencyData(this.fastDb)
    this.fine.getFloatFrequencyData(this.fineDb)
    this.separate()
    // Pitches first: the drum pass checks lead attacks against the bass notes found here.
    this.pitches(dt)
    this.drums(dt, now)
    this.texture(dt)

    const copy = this.agoDb.length >= 3 ? this.agoDb.shift()! : new Float32Array(this.n)
    copy.set(this.fastDb)
    this.agoDb.push(copy)

    // Levels: drums are their hit envelopes; keyed layers their strongest held note.
    const decay = Math.exp(-dt / 0.25)
    for (const l of ['kick', 'snare', 'hat'] as const) this.env[l] *= decay
    for (const h of f.hits) if (h.layer === 'kick' || h.layer === 'snare' || h.layer === 'hat') this.env[h.layer] = Math.max(this.env[h.layer], h.strength)
    const keyLevel = (role: Track['role']) => {
      let a = 0
      for (const t of this.tracks) if (t.role === role) a = Math.max(a, t.amp)
      return clamp01(a / this.notePeak)
    }
    const target = { lead: Math.max(keyLevel('lead'), this.leadHeld ? 0.6 : 0), pad: keyLevel('pad'), bass: Math.max(keyLevel('bass') * 0.6, this.bassLevel) }
    for (const l of KEY_LAYERS) this.env[l] += (target[l] - this.env[l]) * (1 - Math.exp(-dt / (target[l] > this.env[l] ? 0.03 : 0.2)))
    this.env.fx += (clamp01(this.fxHeld) - this.env.fx) * (1 - Math.exp(-dt / (this.fxHeld > this.env.fx ? 0.1 : 0.6)))
    let active = 0
    for (const l of LAYERS) {
      f.level[l] = this.env[l]
      if (this.env[l] > 0.25) active++
    }
    f.density += (active / LAYERS.length - f.density) * (1 - Math.exp(-dt / 0.8))
    return f
  }

  // --- Harmonic / percussive split ------------------------------------------------

  private separate() {
    const { fastDb: db, mag, perc, harm, n } = this
    for (let i = 0; i < n; i++) mag[i] = Number.isFinite(db[i]) ? Math.pow(10, db[i] / 20) : 0
    const frame = this.history.length >= HPSS_TIME ? this.history.shift()! : new Float32Array(n)
    frame.set(mag)
    this.history.push(frame)
    const T = this.history.length
    const col = new Float32Array(T)
    const row = new Float32Array(2 * HPSS_FREQ + 1)
    const median = (a: Float32Array, len: number) => {
      // Insertion sort; the windows are tiny.
      for (let i = 1; i < len; i++) {
        const v = a[i]
        let j = i - 1
        while (j >= 0 && a[j] > v) {
          a[j + 1] = a[j]
          j--
        }
        a[j + 1] = v
      }
      return a[len >> 1]
    }
    for (let i = 0; i < n; i++) {
      for (let t = 0; t < T; t++) col[t] = this.history[t][i]
      const h = median(col, T)
      let len = 0
      for (let j = i - HPSS_FREQ; j <= i + HPSS_FREQ; j++) if (j >= 0 && j < n) row[len++] = mag[j]
      const p = median(row, len)
      // Soft (Wiener-like) masks.
      const m = (p * p) / (p * p + h * h + 1e-20)
      perc[i] = mag[i] * m
      harm[i] = mag[i] * (1 - m)
    }
  }

  // --- Drums, and the low end ------------------------------------------------------

  private drums(dt: number, now: number) {
    const { fastDb: db, perc, comp, prevComp, raw, prevRaw, fastHz: hz, n } = this
    for (let i = 0; i < n; i++) {
      comp[i] = Math.log1p(100 * perc[i])
      raw[i] = Math.log1p(100 * this.mag[i])
    }
    const bins = (lo: number, hi: number): [number, number] => [Math.max(1, Math.round(lo / hz)), Math.min(n - 2, Math.round(hi / hz))]
    /**
     * Log flux against last frame's max over ±1 bin, and `spread`: of the bins
     * within 30 dB of the region's loudest, the share that jumped 3 dB or more
     * (a drum lifts the whole region, a note only a few bins).
     */
    const flux = (cur: Float32Array, prev: Float32Array, lo: number, hi: number) => {
      const [a, b] = bins(lo, hi)
      let s = 0
      let top = 0
      for (let i = a; i <= b; i++) {
        const d = cur[i] - Math.max(prev[i - 1], prev[i], prev[i + 1])
        if (d > 0) s += d
        top = Math.max(top, cur[i])
      }
      // `cur` is log1p(100·m): compare in magnitude terms.
      const lin = (v: number) => Math.expm1(v) / 100
      const floor = lin(top) * 0.03
      let counted = 0
      let rose = 0
      for (let i = a; i <= b; i++) {
        const m = lin(cur[i])
        if (m < floor || m <= 0) continue
        counted++
        if (m > 1.41 * lin(Math.max(prev[i - 1], prev[i], prev[i + 1]))) rose++
      }
      return { flux: s / (b - a + 1), spread: counted ? rose / counted : 0 }
    }
    const power = (src: Float32Array, lo: number, hi: number) => {
      const [a, b] = bins(lo, hi)
      let e = 0
      for (let i = a; i <= b; i++) e += src[i] * src[i]
      return e
    }
    const dbOf = (e: number, count = 1) => 10 * Math.log10(e / count + 1e-12)
    const flatness = (lo: number, hi: number) => {
      const [a, b] = bins(lo, hi)
      let logSum = 0
      let sum = 0
      for (let i = a; i <= b; i++) {
        const p = this.mag[i] * this.mag[i] + 1e-12
        logSum += Math.log(p)
        sum += p
      }
      const count = b - a + 1
      return Math.exp(logSum / count) / (sum / count)
    }

    // Onsets on the whole spectrum (attacks are clearest there); the
    // percussive part decides below whether a transient is really a drum.
    const sub = flux(raw, prevRaw, 35, 120)
    const air = flux(raw, prevRaw, 6000, 16000)
    const pres = flux(raw, prevRaw, 1000, 5000)
    const body = flux(raw, prevRaw, 150, 400)
    const mids = flux(raw, prevRaw, 250, 2500)
    prevComp.set(comp)
    prevRaw.set(raw)

    const subDb = dbOf(power(this.mag, 35, 120), bins(35, 120)[1] - bins(35, 120)[0] + 1)
    const allDb = dbOf(power(this.mag, 35, 16000))
    this.mixPeak = Math.max(allDb, this.mixPeak - dt * 3)
    this.subPeak = Math.max(subDb, this.subPeak - dt)
    this.subHistory.push(subDb)
    if (this.subHistory.length > Math.max(3, Math.round(0.12 / dt))) this.subHistory.shift()
    const subFloor = Math.min(...this.subHistory)
    // Where the transient energy sits.
    const pAir = power(perc, 6000, 16000)
    const pPres = power(perc, 1000, 5000)
    const pBody = power(perc, 150, 400)
    const pHigh = power(perc, 150, 16000) + 1e-12
    const lowCentroid = (() => {
      const [a, b] = bins(30, 250)
      let w = 0
      let s = 0
      for (let i = a; i <= b; i++) {
        const p = this.mag[i] * this.mag[i]
        w += p
        s += p * i
      }
      return w > 0 ? (s / w) * hz : 0
    })()
    Object.assign(this.probe, { sub: sub.flux, air: air.flux, airSpread: air.spread, pres: pres.flux, presSpread: pres.spread, body: body.flux, bodySpread: body.spread, airShare: pAir / pHigh, presShare: (pPres + pBody) / pHigh, subDb, lowCentroid, mixPeak: this.mixPeak, airDb: dbOf(pAir) })

    const hits = this.frame.hits
    let drum = false
    const L = this.last
    const pk = {
      airSpread: Math.max(air.spread, L.airSpread), presSpread: Math.max(pres.spread, L.presSpread), bodySpread: Math.max(body.spread, L.bodySpread),
      midSpread: Math.min(mids.spread, L.midSpread), hatShare: Math.max(pAir / pHigh, L.hatShare), presShare: Math.max((pPres + pBody) / pHigh, L.presShare),
      sub: Math.max(sub.flux, L.sub), body: Math.max(body.flux, L.body), pres: Math.max(pres.flux, L.pres), air: Math.max(air.flux, L.air),
      centroid: Math.max(lowCentroid, L.centroid),
      presFlat: Math.max(flatness(1000, 5000), L.presFlat), airFlat: Math.max(flatness(6000, 16000), L.airFlat),
      lowFlat: Math.max(flatness(35, 300), L.lowFlat),
    }
    Object.assign(L, {
      airSpread: air.spread, presSpread: pres.spread, bodySpread: body.spread, midSpread: mids.spread, hatShare: pAir / pHigh, presShare: (pPres + pBody) / pHigh,
      sub: sub.flux, body: body.flux, pres: pres.flux, air: air.flux, centroid: lowCentroid,
      presFlat: flatness(1000, 5000), airFlat: flatness(6000, 16000), lowFlat: flatness(35, 300),
    })
    // A drum is a sudden jump in its region, not noise that churns or swells (a car, wind).
    const before = this.agoDb.length >= 3 ? this.agoDb[0] : null
    const jump = (lo: number, hi: number) => {
      if (!before) return 0
      const [a, b] = bins(lo, hi)
      let now = 0
      let then = 0
      for (let i = a; i <= b; i++) {
        now += this.mag[i] * this.mag[i]
        if (Number.isFinite(before[i])) then += Math.pow(10, before[i] / 10)
      }
      return 10 * Math.log10((now + 1e-12) / (then + 1e-12))
    }

    // Low end: a sub onset is held for ~50 ms, then called kick (it swept
    // down and fell away, punching the body) or bass (it held its pitch).
    const k = this.sub.feed(sub.flux, dt, now, Math.max(sensOf('kick'), sensOf('bass')))
    if (k > 0 && subDb - subFloor > 6 && subDb > this.subPeak - 20) {
      // `body`: how hard the body punched relative to the sub (a kick's skin, not a bass note's tone).
      this.lows.push({ at: now - dt, strength: clamp01(0.4 + k), sub: subDb, centroid: pk.centroid, body: pk.body / Math.max(1e-6, pk.sub), lowFlat: pk.lowFlat })
      this.lowAt = now - dt
    }
    const punchNow = pk.body / Math.max(1e-6, pk.sub)
    for (let i = this.lows.length - 1; i >= 0; i--) {
      const e = this.lows[i]
      // Over the ~50 ms wait, keep the most the hit showed: a kick's sweep spreads its spectrum a few ms in.
      e.lowFlat = Math.max(e.lowFlat, flatness(35, 300))
      e.body = Math.max(e.body, punchNow)
      if (now - e.at < 0.05) continue
      this.lows.splice(i, 1)
      const dropped = e.sub - subDb
      const swept = e.centroid > 0 ? (e.centroid - lowCentroid) / e.centroid : 0
      // A kick's pitch falls (the drum's skin settling), or it punches the
      // body with a noisy, untuned low end; a plucked or synth bass holds a tone.
      // A steady new low note since the hit means a plucked or synth bass,
      // however noisy its attack; a kick's pitch falls instead.
      const tone = this.tracks.some((t) => t.midi < BASS_TOP && t.missing === 0 && t.age <= now - e.at + 0.03 && Math.abs(t.sweep) < 1)
      // With a tone after it, only a big fall is a kick (kick and bass together);
      // a pluck's fading upper harmonics shift the low end only a little.
      const kick = tone ? swept > 0.3 : swept > 0.15 || (e.body > 0.35 && e.lowFlat > 0.3) || (e.body > 0.18 && e.lowFlat > 0.5)
      hits.push({ layer: kick ? 'kick' : 'bass', strength: e.strength, pitch: null, ago: now - e.at })
      if (kick && tone) hits.push({ layer: 'bass', strength: e.strength * 0.8, pitch: null, ago: now - e.at })
      if (!kick) this.bassCalls.push(e.at)
      this.decisions.push({ at: e.at, kick, swept, body: e.body, lowFlat: e.lowFlat, dropped })
      if (this.decisions.length > 400) this.decisions.shift()
      if (kick) drum = true
    }

    // Snare: broadband noise in the presence region, usually with body.
    const s = this.snare.feed(pres.flux, dt, now, sensOf('snare'))
    let snare = false
    if (s > 0 && jump(1000, 5000) > 4 && pk.presFlat > 0.22 && pk.pres > 0.5 * pk.air && (this.noVeto || pk.presShare > 0.25) && (pk.bodySpread > 0.2 || s > 0.45)) {
      this.drumsWaiting.push({ at: now - dt, layer: 'snare', strength: clamp01(0.35 + s) })
      snare = drum = true
    }
    // Hats: broadband noise whose transient energy sits mostly up high, and
    // that matters in the mix (not the faint top of a bass pluck).
    const h = this.hat.feed(air.flux, dt, now, sensOf('hat'))
    const hatShare = pk.hatShare
    // Relevant: loud enough in the mix, or most of the moment's transient energy is up high.
    const loud = dbOf(pAir) > this.mixPeak - 52 - 10 * (sensOf('hat') - 1)
    const relevant = this.noVeto || loud || (dbOf(pAir) > this.mixPeak - 60 && hatShare > 0.15 / sensOf('hat'))
    if (h > 0 && relevant && jump(6000, 16000) > 4 && pk.airFlat > 0.25 && this.highTone < 0.5 && (!snare || pk.air > 1.6 * pk.pres)) {
      this.drumsWaiting.push({ at: now - dt, layer: 'hat', strength: clamp01(0.3 + h) })
      drum = true
    }
    // Hats and snares go out once the low end around them has been called
    // (~60 ms); any that landed on a bass note's pluck are dropped.
    while (this.bassCalls.length && now - this.bassCalls[0] > 1) this.bassCalls.shift()
    for (let i = this.drumsWaiting.length - 1; i >= 0; i--) {
      const d = this.drumsWaiting[i]
      const lowNear = this.lows.some((e) => Math.abs(e.at - d.at) < 0.04)
      if (lowNear || now - d.at < 0.06) continue
      this.drumsWaiting.splice(i, 1)
      if (this.bassCalls.some((t) => Math.abs(t - d.at) < 0.04)) continue
      // A steady new low note right after: the noise was a pluck's attack.
      if (this.tracks.some((t) => t.midi < BASS_TOP && t.missing === 0 && t.age <= now - d.at + 0.03 && Math.abs(t.sweep) < 1)) continue
      hits.push({ layer: d.layer, strength: d.strength, pitch: null, ago: now - d.at })
    }
    this.drumQuiet = drum ? 0.12 : Math.max(0, this.drumQuiet - dt)
    Object.assign(this.probe, {
      hOn: h, sOn: s, relevant: relevant ? 1 : 0, highTone: this.highTone, snareHit: snare ? 1 : 0, kOn: k,
      jAir: jump(6000, 16000), fAir: flatness(6000, 16000), hatShare: pk.hatShare, jPres: jump(1000, 5000), fPres: flatness(1000, 5000),
      presShare: pk.presShare, presVsAir: pk.pres / Math.max(1e-6, pk.air), bodySpread: pk.bodySpread,
    })

    // How steady the mids are: tones hold still, noise (a car, wind) churns.
    const ago = this.agoDb.length >= 3 ? this.agoDb[0] : null
    if (ago) {
      const [a, b] = bins(250, 2500)
      let top = -Infinity
      for (let i = a; i <= b; i++) if (Number.isFinite(db[i])) top = Math.max(top, db[i])
      let peaks = 0
      let still = 0
      for (let i = a; i <= b; i++) {
        if (!Number.isFinite(db[i]) || !Number.isFinite(ago[i]) || db[i] < top - 30 || db[i] < db[i - 1] || db[i] < db[i + 1]) continue
        peaks++
        if (Math.abs(db[i] - ago[i]) < 3) still++
      }
      this.steady += ((peaks ? still / peaks : 1) - this.steady) * (1 - Math.exp(-dt / 0.15))
      if (!Number.isFinite(this.steady)) this.steady = 1
    }

    // Lead: a sharp, narrow attack in the mids (a few bins rising, not a
    // wall of noise), not an overtone of the bass.
    const m = this.mid.feed(mids.flux, dt, now, sensOf('lead'))
    if (m > 0 && ago && this.steady >= NOISY && pk.midSpread < 0.35 && !(snare && pres.flux > mids.flux)) {
      const pitch = this.attackPitch(250, 2500, ago)
      if (pitch !== null && !this.overtoneOfLow(pitch)) this.leads.push({ at: now - dt, strength: clamp01(0.35 + m), pitch })
    }
    // A mid attack landing with a sub onset (either side) is that low note's
    // bright attack (a pluck, a kick's click), not a lead.
    for (let i = this.leads.length - 1; i >= 0; i--) {
      const e = this.leads[i]
      if (Math.abs(e.at - this.lowAt) < 0.07) {
        this.leads.splice(i, 1)
        continue
      }
      if (now - e.at < 0.04) continue
      this.leads.splice(i, 1)
      hits.push({ layer: 'lead', strength: e.strength, pitch: e.pitch, ago: now - e.at })
      this.leadPitch = e.pitch
      this.leadAt = e.at
      this.leadBin = Math.round(hzOf(e.pitch) / hz)
      this.leadDb = db[this.leadBin]
    }
    if (this.leadBin > 0) {
      const level = Math.max(db[this.leadBin - 1], db[this.leadBin], db[this.leadBin + 1])
      this.leadHeld = level > this.leadDb - 15
      if (!this.leadHeld) this.leadBin = -1
    }

    // A high, clear tone: one narrow peak holding most of the 2–10 kHz energy.
    {
      const [a, b] = bins(2000, 10000)
      let top = -Infinity
      let at = -1
      let sum = 0
      let count = 0
      let pw = 0
      for (let i = a; i <= b; i++) {
        if (!Number.isFinite(db[i])) continue
        if (db[i] > top) {
          top = db[i]
          at = i
        }
        sum += db[i]
        pw += Math.pow(10, db[i] / 10)
        count++
      }
      let near = 0
      for (let i = Math.max(a, at - 4); i <= Math.min(b, at + 4); i++) near += Math.pow(10, db[i] / 10)
      const pure = count > 0 && top - sum / count > 20 && near / pw > 0.4 && top > this.subPeak - 50
      const tone = pure && !this.harmonicOfHeld(midiOf(at * hz)) ? 1 : 0
      this.highTone += (tone - this.highTone) * (1 - Math.exp(-dt / 0.05))
    }

    // Held low end: the sub's floor over ~120 ms (a kick's tail drops out of it), against the mix.
    const held = clamp01((Math.min(subFloor, subDb) - (this.mixPeak - 40)) / 24)
    this.bassLevel += (held - this.bassLevel) * (1 - Math.exp(-dt / 0.08))
  }

  /** Strongest peak in the fast spectrum between lo and hi Hz, as a MIDI note (interpolated). */
  private peakPitch(lo: number, hi: number): number | null {
    const db = this.fastDb
    const hz = this.fastHz
    const a = Math.max(2, Math.round(lo / hz))
    const b = Math.min(db.length - 2, Math.round(hi / hz))
    let best = -1
    for (let i = a; i <= b; i++) if (best < 0 || db[i] > db[best]) best = i
    if (best < 0 || !(db[best] > -100)) return null
    const l = db[best - 1]
    const c = db[best]
    const r = db[best + 1]
    const shift = Math.max(-0.5, Math.min(0.5, (0.5 * (l - r)) / (l - 2 * c + r || 1)))
    const midi = Math.round(midiOf((best + (Number.isFinite(shift) ? shift : 0)) * hz))
    return Number.isFinite(midi) ? midi : null
  }

  /** Pitch of what just attacked: the loud peak that rose most since `ago` (not simply the loudest). */
  private attackPitch(lo: number, hi: number, ago: Float32Array): number | null {
    const db = this.fastDb
    const hz = this.fastHz
    const a = Math.max(2, Math.round(lo / hz))
    const b = Math.min(db.length - 2, Math.round(hi / hz))
    let top = -Infinity
    for (let i = a; i <= b; i++) top = Math.max(top, db[i])
    let best = -1
    let bestRise = 10
    for (let i = a; i <= b; i++) {
      if (db[i] < top - 24 || db[i] < db[i - 1] || db[i] < db[i + 1]) continue
      const rise = db[i] - ago[i]
      if (rise > bestRise) {
        best = i
        bestRise = rise
      }
    }
    return best < 0 ? null : this.peakPitch(best * hz - hz / 2, best * hz + hz / 2)
  }

  /** Whether `midi` is a harmonic (2nd–12th) of the bass: a held bass key, or one just struck. */
  private overtoneOfLow(midi: number) {
    const on = (base: number) => {
      const k = Math.pow(2, (midi - base) / 12)
      const r = Math.round(k)
      return r >= 2 && r <= 12 && Math.abs(k - r) / r < 0.03
    }
    // Any low fundamental sounding now, tracked a while or just appeared.
    return this.tracks.some((t) => t.midi < BASS_TOP + 5 && t.missing === 0 && on(t.midi))
  }

  /** Whether `midi` sits on a harmonic (2nd–16th) of a held note or the last lead. */
  private harmonicOfHeld(midi: number) {
    const on = (base: number) => {
      const k = Math.pow(2, (midi - base) / 12)
      const r = Math.round(k)
      return r >= 2 && r <= 16 && Math.abs(k - r) / r < 0.015
    }
    if (this.now - this.leadAt < 0.6 && on(this.leadPitch)) return true
    return this.tracks.some((t) => (t.role === 'bass' || t.role === 'lead' || t.role === 'pad') && on(t.midi))
  }

  // --- Pitch: which keys are held -----------------------------------------------------

  /** Fundamentals in the fine spectrum, by harmonic summation with iterative cancellation. */
  private fundamentals(): Note[] {
    const { fineDb: db, fineHz: hz } = this
    const lo = Math.max(3, Math.round(30 / hz))
    const hi = Math.min(db.length - 3, Math.round(5000 / hz))
    let top = -Infinity
    for (let i = lo; i <= hi; i++) if (Number.isFinite(db[i])) top = Math.max(top, db[i])
    if (!Number.isFinite(top)) return []
    // Peaks well above their neighbourhood, as (Hz, weight) with weight in a compressed scale.
    const peaks: { f: number; w: number }[] = []
    for (let i = lo; i <= hi; i++) {
      const v = db[i]
      if (!(v >= top - 50) || v < db[i - 1] || v < db[i + 1] || v < db[i - 2] || v < db[i + 2]) continue
      const w = Math.max(4, Math.min(40, Math.round(i * 0.06)))
      let around = 0
      let count = 0
      for (let j = i - w; j <= i + w; j++) {
        if (j < 1 || j >= db.length || Math.abs(j - i) < 3 || !Number.isFinite(db[j])) continue
        around += db[j]
        count++
      }
      if (!count || v - around / count < 8) continue
      const l = db[i - 1]
      const r = db[i + 1]
      const shift = Math.max(-0.5, Math.min(0.5, (0.5 * (l - r)) / (l - 2 * v + r || 1)))
      peaks.push({ f: (i + shift) * hz, w: Math.max(0, v - (top - 50)) })
    }
    if (!peaks.length) return []
    const nearest = (f: number) => {
      let best = -1
      let bestD = Math.max(0.03 * f, 1.5 * hz)
      for (let j = 0; j < peaks.length; j++) {
        const d = Math.abs(peaks[j].f - f)
        if (d < bestD && peaks[j].w > 0) {
          best = j
          bestD = d
        }
      }
      return best
    }
    // Lower harmonics count more (1/h^0.8). Unlike Klapuri's (f0+α)/(h·f0+β),
    // this doesn't favour higher candidates, so a low note with loud upper
    // harmonics stays one low note.
    const salience = (f0: number) => {
      let s = 0
      let present = 0
      for (let h = 1; h <= 12 && h * f0 < 5000; h++) {
        const j = nearest(h * f0)
        if (j < 0) continue
        s += Math.pow(h, -0.8) * peaks[j].w
        if (h <= 3) present++
      }
      // A real note shows at least two of its first three harmonics, except a
      // sub bass (808s, sine subs), which is nearly a pure tone.
      return present >= 2 || (f0 < 150 && present >= 1) ? s : 0
    }
    const notes: Note[] = []
    let first = 0
    for (let round = 0; round < 6; round++) {
      let best = 0
      let bestF = 0
      for (const p of peaks) {
        if (p.w <= 0) continue
        for (const d of [1, 2, 3]) {
          const f0 = p.f / d
          if (f0 < 30) continue
          // Never an overtone of a note already found.
          if (notes.some((n) => {
            const k = f0 / hzOf(n.midi)
            const r = Math.round(k)
            return r >= 2 && Math.abs(k - r) / r < 0.03
          })) continue
          const s = salience(f0)
          if (s > best) {
            best = s
            bestF = f0
          }
        }
      }
      if (!best || (first && best < first * (0.25 / sensOf('pad')))) break
      if (!first) first = best
      notes.push({ midi: midiOf(bestF), salience: best })
      // Cancel all of this note's harmonics (a plucked string rings far up) so they can't be counted again.
      for (let h = 1; h * bestF < 5000; h++) {
        const j = nearest(h * bestF)
        if (j >= 0) peaks[j].w *= 0.1
      }
    }
    // Octave (and other harmonic) errors: a note that sits on a whole-number
    // multiple of a lower note found too is that lower note's overtone, so it
    // folds into it (at the cost of a chord's octave doublings).
    notes.sort((a, b) => a.midi - b.midi)
    const kept: Note[] = []
    for (const n of notes) {
      const root = kept.find((k) => {
        const ratio = Math.pow(2, (n.midi - k.midi) / 12)
        const r = Math.round(ratio)
        return r >= 2 && r <= 10 && Math.abs(ratio - r) / r < 0.03
      })
      if (root) root.salience += n.salience
      else kept.push(n)
    }
    return kept
  }

  /** The last frame's fundamentals (for tuning). */
  lastNotes: Note[] = []

  private pitches(dt: number) {
    const notes = this.fundamentals()
    this.lastNotes = notes
    let peak = 0
    for (const n of notes) peak = Math.max(peak, n.salience)
    this.notePeak = Math.max(peak, this.notePeak * Math.pow(0.5, dt / 4), 1e-3)

    for (const t of this.tracks) t.missing += dt
    const used = new Set<Note>()
    for (const t of this.tracks) {
      let best: Note | null = null
      let bestD = 0.7
      for (const n of notes) {
        const d = Math.abs(n.midi - t.midi)
        if (!used.has(n) && d < bestD) {
          best = n
          bestD = d
        }
      }
      if (best) {
        used.add(best)
        t.drift = best.midi - t.midi
        t.midi = best.midi
        t.amp = best.salience
        t.missing = 0
      }
    }
    for (const n of notes) if (!used.has(n)) this.tracks.push({ midi: n.midi, amp: n.salience, age: 0, missing: 0, role: 'new', drift: 0, sweep: 0 })
    this.tracks = this.tracks.filter((t) => t.missing < 0.1)

    const hits = this.frame.hits
    let lead = this.tracks.find((t) => t.role === 'lead')
    for (const t of this.tracks) {
      t.age += dt
      t.sweep = t.sweep * Math.exp(-dt / 0.3) + t.drift
      if (t.role === 'new' && t.midi > 70 && Math.abs(t.sweep) > 4) t.role = 'fx'
      if (t.role !== 'new') continue
      if (t.midi < BASS_TOP) {
        if (t.age >= 0.06) t.role = 'bass'
      } else if (t.midi > 100) {
        if (t.age >= 0.05) t.role = this.harmonicOfHeld(t.midi) ? 'pad' : 'fx'
      } else if (this.steady < NOISY) {
        // Peaks found in noise (a car, wind) aren't notes.
        continue
      } else if (this.now - this.leadAt < 0.35 && Math.abs(t.midi - this.leadPitch) < 0.8) {
        if (lead) lead.role = 'pad'
        t.role = 'lead'
        lead = t
      } else if (t.age >= 0.25 && t.amp > this.notePeak * (0.3 / sensOf('pad'))) {
        t.role = 'pad'
        hits.push({ layer: 'pad', strength: clamp01(t.amp / this.notePeak), pitch: Math.round(t.midi), ago: 0.25 })
      }
    }
    const keys = this.frame.keys
    for (const l of KEY_LAYERS) keys[l].length = 0
    for (const t of this.tracks) if (t.role === 'bass' || t.role === 'lead' || t.role === 'pad') keys[t.role].push(Math.round(t.midi))
    // The slow analyser lags quick leads; the fast spectrum says whether the attacked key still sounds.
    if (this.leadHeld && !keys.lead.includes(this.leadPitch)) keys.lead.unshift(this.leadPitch)
    if (keys.lead.length > 1) keys.lead.length = 1
  }

  // --- Texture: whatever is new and unexplained -----------------------------------------

  private texture(dt: number) {
    const { fastDb: db, fastHz: hz } = this
    const explained = new Uint8Array(FX_BANDS)
    const bandOf = (midi: number) => Math.floor((FX_BANDS * Math.log(hzOf(midi) / 100)) / Math.log(160))
    const explain = (midi: number) => {
      for (let h = 1; h <= 8; h++) {
        const k = bandOf(midi + 12 * Math.log2(h))
        for (const j of [k - 1, k, k + 1]) if (j >= 0 && j < FX_BANDS) explained[j] = 1
      }
    }
    let tonalFx = 0
    for (const t of this.tracks) {
      if (t.role === 'fx') tonalFx++
      else explain(t.midi)
    }
    if (this.now - this.leadAt < 0.6) explain(this.leadPitch)
    for (let i = 0; i < FX_BANDS; i++) {
      const f = fxEdge(i)
      if ((f < 250 && this.env.kick + this.bassLevel > 0.05) || (f >= 1000 && f < 6000 && this.env.snare > 0.05) || (f >= 5000 && this.env.hat > 0.02)) explained[i] = 1
    }
    let novelty = 0
    let weighted = 0
    let count = 0
    for (let i = 0; i < FX_BANDS; i++) {
      const a = Math.max(1, Math.round(fxEdge(i) / hz))
      const b = Math.max(a, Math.min(db.length - 1, Math.round(fxEdge(i + 1) / hz)))
      let e = 0
      for (let j = a; j <= b; j++) if (Number.isFinite(db[j])) e += Math.pow(10, db[j] / 10)
      const level = 10 * Math.log10(e / (b - a + 1) + 1e-12)
      // ~0.3 s: a beat's pulse averages out, a passing sound doesn't.
      this.fxNow[i] += (level - this.fxNow[i]) * (1 - Math.exp(-dt / 0.3))
      // What's normal here: a slow average, never more than 24 dB behind.
      this.fxLong[i] += (this.fxNow[i] - this.fxLong[i]) * (1 - Math.exp(-dt / 6))
      this.fxLong[i] = Math.max(this.fxLong[i], this.fxNow[i] - 24)
      if (explained[i]) continue
      const rise = Math.max(0, this.fxNow[i] - this.fxLong[i] - 12 / sensOf('fx'))
      novelty += rise
      weighted += rise * i
      count++
    }
    const raw = this.drumQuiet > 0 ? 0 : count ? novelty / count / 6 : 0
    this.fxRaw += (raw - this.fxRaw) * (1 - Math.exp(-dt / 0.15))
    const tonal = clamp01(Math.max(tonalFx / 2, this.highTone))
    const present = Math.max(this.fxRaw, tonal * 0.8, this.highTone)
    // Comes in over ~0.25 s and lingers ~1 s, so a run of chirps reads as one sound.
    this.fxHeld = present > 0.5 ? Math.min(1, this.fxHeld + dt / 0.25) : Math.max(0, this.fxHeld - dt / 1)

    const fx = this.frame.fx
    let place = novelty > 0 ? weighted / novelty / (FX_BANDS - 1) : fx.place
    const tonalTrack = this.tracks.find((t) => t.role === 'fx')
    if (tonalTrack && (novelty <= 0 || tonal > 0.5)) place = clamp01((bandOf(tonalTrack.midi) + 0.5) / FX_BANDS)
    const moved = place - this.fxPlace
    this.fxPlace += moved * (1 - Math.exp(-dt / 0.2))
    fx.place = this.fxPlace
    fx.tonal += (tonal - fx.tonal) * (1 - Math.exp(-dt / 0.3))
    fx.sweep += (Math.max(-1, Math.min(1, (moved / Math.max(dt, 1e-3)) * 2)) - fx.sweep) * (1 - Math.exp(-dt / 0.4))
    // One event per sound: on above 0.5, off again below 0.15.
    if (!this.fxOn && this.fxHeld > 0.5) {
      this.fxOn = true
      this.frame.hits.push({ layer: 'fx', strength: clamp01(present), pitch: null, ago: 0.25 })
    } else if (this.fxOn && this.fxHeld < 0.15) this.fxOn = false
  }
}
