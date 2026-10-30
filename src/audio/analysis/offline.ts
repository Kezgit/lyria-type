import type { NoteEvent, Voice } from '../features'
import type { FramedPart, MixFrames } from './track'

// Reads a whole audio file before it plays and writes it out as a score: one
// tempo and beat grid for the track, and every note on it, so a file can be
// drawn ahead of the playhead just like generated music.
//   stft    at ~22 kHz (top octave folds onto the hats, harmlessly): 1024
//           window / 256 hop (46 / 12 ms); bins up to ~2 kHz kept for pitch
//           and sustain, the rest folded into a few bands
//   onsets  one detection function per region (kick, snare, hat, bass, lead),
//           peaks well above a running mean, gated so absent parts stay empty
//   tempo   autocorrelation of all onsets with a pull toward ~120, then a fine
//           fit of a beat grid to the whole track; the bar starts where kicks
//           and snares sit best
//   notes   each onset on its nearest sixteenth; pitched voices take a pitch
//           from a long FFT (harmonic sum on what's new since just before)
//           and a length from how long that pitch holds; pads are the steady
//           chords of each half bar
//   parts   the four stems estimated per frame for the whole-track analysis
//           (track.ts): drums = highs + rising low/noise energy, bass = the
//           lows with kick bursts taken out, vocals = mid energy that moves
//           (more where lead notes sound), instruments = the rest of the
//           steady mids
// Work is sliced with yields so the page keeps drawing while it runs.

export interface FileScore {
  bpm: number
  /** Seconds per sixteenth step. */
  sixteenth: number
  /** Track time of step 0: a bar start at or just before the beginning (<= 0). */
  offset: number
  duration: number
  /** Sorted by step. */
  notes: NoteEvent[]
  /** Track time (s) each note starts, on the grid; matches `notes`. */
  times: Float64Array
  /** The four stems estimated from the mix, per STFT frame (track time). */
  mix: MixFrames
}

const MIN_BPM = 70
const MAX_BPM = 180
const SLICE_MS = 10 // work between yields

/** Hz range per detection region. */
const KICK: [number, number] = [40, 120]
const SNARE: [number, number] = [150, 400]
const NOISE: [number, number] = [1000, 5000]
const HAT: [number, number] = [6000, 12000]
const BASS: [number, number] = [40, 250]
const LEAD: [number, number] = [250, 2000]
/** Hz ranges of the parts estimated for the whole-track analysis. */
const PART: Record<'low' | 'bass' | 'voice' | 'inst' | 'drums' | 'high', [number, number]> = {
  low: [40, 400], bass: [40, 250], voice: [300, 3000], inst: [250, 6000], drums: [60, 11000], high: [6000, 11000],
}
/** MIDI range searched for each pitched voice. */
const PITCH: Record<'bass' | 'pad' | 'lead', [number, number]> = { bass: [28, 59], pad: [48, 84], lead: [55, 96] }
/** Most notes per voice per bar (the strongest stay). */
const CAP: Record<Voice, number> = { kick: 8, snare: 8, hat: 16, bass: 8, lead: 8, pad: 12 }
/** Nominal drum pitches (as the demo uses). */
const DRUM: Partial<Record<Voice, number>> = { kick: 36, snare: 38, hat: 42 }
const HARMONIC_WEIGHT = [1, 0.6, 0.45, 0.35, 0.3]

const hz = (m: number) => 440 * Math.pow(2, (m - 69) / 12)
const pause = () => new Promise<void>((r) => setTimeout(r, 0))

/** In-place radix-2 complex FFT of size n (power of two). */
export class FFT {
  readonly n: number
  readonly re: Float64Array
  readonly im: Float64Array
  private rev: Uint32Array
  private cos: Float64Array
  private sin: Float64Array
  private windows = new Map<number, Float64Array>()

  constructor(n: number) {
    this.n = n
    this.re = new Float64Array(n)
    this.im = new Float64Array(n)
    this.rev = new Uint32Array(n)
    const bits = Math.log2(n)
    for (let i = 0; i < n; i++) {
      let r = 0
      for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b)
      this.rev[i] = r
    }
    this.cos = new Float64Array(n / 2)
    this.sin = new Float64Array(n / 2)
    for (let i = 0; i < n / 2; i++) {
      this.cos[i] = Math.cos((2 * Math.PI * i) / n)
      this.sin[i] = Math.sin((2 * Math.PI * i) / n)
    }
  }

  run() {
    const { n, re, im, rev, cos, sin } = this
    for (let i = 0; i < n; i++) {
      const j = rev[i]
      if (j > i) {
        let t = re[i]; re[i] = re[j]; re[j] = t
        t = im[i]; im[i] = im[j]; im[j] = t
      }
    }
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1
      const stride = (n / size) | 0
      for (let k = 0; k < half; k++) {
        const c = cos[k * stride]
        const s = sin[k * stride]
        for (let a = k; a < n; a += size) {
          const b = a + half
          const tr = re[b] * c + im[b] * s
          const ti = im[b] * c - re[b] * s
          re[b] = re[a] - tr
          im[b] = im[a] - ti
          re[a] += tr
          im[a] += ti
        }
      }
    }
  }

  /** Magnitude spectrum (n/2 bins) of `length` samples of `x` from `start`, Hann windowed, zero-padded. */
  mags(x: Float32Array, start: number, length: number, out: Float32Array) {
    const { n, re, im } = this
    length = Math.min(n, length)
    let win = this.windows.get(length)
    if (!win) this.windows.set(length, (win = hann(length)))
    re.fill(0)
    im.fill(0)
    for (let i = 0; i < length; i++) {
      const j = start + i
      if (j >= 0 && j < x.length) re[i] = x[j] * win[i]
    }
    this.run()
    const scale = 4 / length
    for (let k = 0; k < n / 2; k++) out[k] = Math.sqrt(re[k] * re[k] + im[k] * im[k]) * scale
  }
}

function hann(n: number) {
  const w = new Float64Array(n)
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n)
  return w
}

function percentile(a: ArrayLike<number>, p: number) {
  if (!a.length) return 0
  const s = Float32Array.from(a).sort()
  return s[Math.min(s.length - 1, Math.floor(p * s.length))]
}

/** Half-wave rectified change over 2 frames of a band's compressed amplitude. */
function rise(amp: Float32Array, ref: number) {
  const out = new Float32Array(amp.length)
  const g = 20 / Math.max(ref, 1e-9)
  for (let n = 2; n < amp.length; n++) out[n] = Math.max(0, Math.log1p(g * amp[n]) - Math.log1p(g * amp[n - 2]))
  return out
}

/** Frames where `odf` peaks well above its running mean (and `least`), at least `gap` frames apart. */
function peaks(odf: Float32Array, gap: number, window: number, k: number, least: number): number[] {
  const n = odf.length
  const sum = new Float64Array(n + 1)
  for (let i = 0; i < n; i++) sum[i + 1] = sum[i] + odf[i]
  const floor = Math.max(least, k * percentile(odf, 0.98))
  const out: number[] = []
  for (let i = 3; i < n - 3; i++) {
    const v = odf[i]
    if (v <= floor) continue
    let max = true
    for (let j = i - 3; j <= i + 3 && max; j++) if (odf[j] > v) max = false
    if (!max) continue
    const a = Math.max(0, i - window)
    const b = Math.min(n, i + window + 1)
    if (v < 1.5 * ((sum[b] - sum[a]) / (b - a)) + floor) continue
    const last = out[out.length - 1]
    if (last !== undefined && i - last < gap) {
      if (v > odf[last]) out[out.length - 1] = i
    } else out.push(i)
  }
  return out
}

/**
 * Harmonic-sum salience per MIDI note in [lo, hi] of a magnitude spectrum.
 * Overtones count only as far as the fundamental is there too, so a chord
 * doesn't invent a root an octave or two below it.
 */
function harmonicScores(m: Float32Array, binHz: number, lo: number, hi: number) {
  const out = new Float32Array(hi - lo + 1)
  const q = Math.pow(2, 1 / 24)
  for (let p = lo; p <= hi; p++) {
    const f = hz(p)
    let s = 0
    let root = 0
    for (let h = 0; h < HARMONIC_WEIGHT.length; h++) {
      const a = Math.floor((f * (h + 1)) / q / binHz)
      const b = Math.ceil((f * (h + 1) * q) / binHz)
      if (b >= m.length) break
      let peak = 0
      for (let i = a; i <= b; i++) if (m[i] > peak) peak = m[i]
      if (h === 0) root = peak
      s += HARMONIC_WEIGHT[h] * Math.min(peak, root)
    }
    out[p - lo] = s
  }
  return out
}

/** Indices of the `count` highest local maxima, highest first. */
function localMaxima(a: Float32Array, count: number) {
  const out: number[] = []
  for (let i = 0; i < a.length; i++)
    if ((a[i - 1] ?? -1) <= a[i] && (a[i + 1] ?? -1) <= a[i] && a[i] > 0) out.push(i)
  return out.sort((i, j) => a[j] - a[i]).slice(0, count)
}

function mean(a: ArrayLike<number>) {
  let s = 0
  for (let i = 0; i < a.length; i++) s += a[i]
  return a.length ? s / a.length : 0
}

/** Decode a file, mix it to mono and analyse it. */
export async function analyseFile(ctx: BaseAudioContext, file: Blob): Promise<FileScore> {
  const buffer = await ctx.decodeAudioData(await file.arrayBuffer())
  const mono = new Float32Array(buffer.length)
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const d = buffer.getChannelData(c)
    for (let i = 0; i < d.length; i++) mono[i] += d[i] / buffer.numberOfChannels
  }
  await pause()
  return analyse(mono, buffer.sampleRate)
}

export async function analyse(input: Float32Array, rate: number): Promise<FileScore> {
  let sliceStart = performance.now()
  // Down to ~22 kHz by averaging; what folds over lands in the hat band.
  const down = Math.max(1, Math.floor(rate / 22050))
  const sr = rate / down
  const x = new Float32Array(Math.floor(input.length / down))
  for (let i = 0; i < x.length; i++) {
    let s = 0
    for (let j = 0; j < down; j++) s += input[i * down + j]
    x[i] = s / down
  }
  const breathe = async () => {
    if (performance.now() - sliceStart < SLICE_MS) return
    await pause()
    sliceStart = performance.now()
  }

  // --- STFT: two real frames per complex FFT ---------------------------------
  const N = 1024
  const hop = N / 4
  const hopSec = hop / sr
  const binHz = sr / N
  const bin = (f: number) => Math.min(N / 2 - 1, Math.max(1, Math.round(f / binHz)))
  const frames = Math.max(0, Math.floor((x.length - N) / hop) + 1)
  const keep = bin(2200) + 1
  const low = new Float32Array(frames * keep)
  const bands = [KICK, SNARE, NOISE, HAT].map(([a, b]) => [bin(a), bin(Math.min(b, sr * 0.48))])
  const amp = bands.map(() => new Float32Array(frames))
  // Power and centroid per frame of the regions the estimated parts come from.
  const regions = Object.values(PART).map(([a, b]) => [bin(a), bin(Math.min(b, sr * 0.48))])
  const power = regions.map(() => new Float32Array(frames))
  const centre = regions.map(() => new Float32Array(frames))
  const fft = new FFT(N)
  const win = hann(N)
  const { re, im } = fft
  const scale = 2 / N // Hann, then halved again by unpacking
  const ma = new Float32Array(N / 2)
  const mb = new Float32Array(N / 2)

  for (let f = 0; f < frames; f += 2) {
    const s0 = f * hop
    const s1 = s0 + hop
    const second = f + 1 < frames
    for (let i = 0; i < N; i++) {
      re[i] = x[s0 + i] * win[i]
      im[i] = second ? x[s1 + i] * win[i] : 0
    }
    fft.run()
    for (let k = 1; k < N / 2; k++) {
      const j = N - k
      const a = re[k], b = im[k], c = re[j], d = im[j]
      ma[k] = Math.sqrt((a + c) ** 2 + (b - d) ** 2) * scale
      mb[k] = Math.sqrt((a - c) ** 2 + (b + d) ** 2) * scale
    }
    for (let h = 0; h < (second ? 2 : 1); h++) {
      const m = h ? mb : ma
      const n = f + h
      low.set(m.subarray(0, keep), n * keep)
      for (let b = 0; b < bands.length; b++) {
        const [lo, hi] = bands[b]
        let e = 0
        for (let k = lo; k <= hi; k++) e += m[k] * m[k]
        amp[b][n] = Math.sqrt(e / (hi - lo + 1))
      }
      for (let r = 0; r < regions.length; r++) {
        const [lo, hi] = regions[r]
        let e = 0
        let w = 0
        let c = 0
        for (let k = lo; k <= hi; k++) {
          e += m[k] * m[k]
          w += m[k]
          c += m[k] * k
        }
        power[r][n] = e
        centre[r][n] = w > 0 ? (c / w) * binHz : 0
      }
    }
    await breathe()
  }
  const [kickAmp, snareAmp, noiseAmp, hatAmp] = amp
  const refs = amp.map((a) => percentile(a, 0.95))
  const loudest = Math.max(...refs, 1e-9)

  // --- Onset detection functions ---------------------------------------------
  const kickOdf = rise(kickAmp, refs[0])
  const hatOdf = rise(hatAmp, refs[3])
  // A snare is body and noise rising together, more than a kick's sweep or a
  // hat's spill would explain.
  const snareBody = rise(snareAmp, refs[1])
  const snareNoise = rise(noiseAmp, refs[2])
  const snareOdf = new Float32Array(frames)
  for (let n = 0; n < frames; n++) {
    const body = Math.max(0, snareBody[n] - 0.5 * kickOdf[n])
    const noise = Math.max(0, snareNoise[n] - 0.5 * hatOdf[n])
    snareOdf[n] = Math.sqrt(body * noise)
  }

  // Pitched regions: per-bin log flux against a widened previous frame, so
  // vibrato and slides don't read as new notes.
  const frameMax = new Float32Array(frames)
  for (let n = 0; n < frames; n++) {
    let m = 0
    for (let k = 0; k < keep; k++) m = Math.max(m, low[n * keep + k])
    frameMax[n] = m
  }
  const gain = 20 / Math.max(percentile(frameMax, 0.95), 1e-9)
  const flux = (lo: number, hi: number) => {
    const out = new Float32Array(frames)
    for (let n = 2; n < frames; n++) {
      let s = 0
      for (let k = lo; k <= hi; k++) {
        const p = (n - 2) * keep + k
        const prev = Math.max(low[p - 1], low[p], low[p + 1])
        s += Math.max(0, Math.log1p(gain * low[n * keep + k]) - Math.log1p(gain * prev))
      }
      out[n] = s / (hi - lo + 1)
    }
    return out
  }
  const bassOdf = flux(bin(BASS[0]), bin(BASS[1]))
  await breathe()
  const leadOdf = flux(bin(LEAD[0]), bin(LEAD[1]))
  await breathe()

  // Frame index -> seconds. A transient shows most in the frame whose window
  // it has just filled the front half of.
  const frameTime = (n: number) => (n * hop + N / 2) / sr - hopSec

  // --- Tempo -------------------------------------------------------------------
  const all = new Float32Array(frames)
  const mix: [Float32Array, number][] = [[kickOdf, 1], [snareOdf, 1], [hatOdf, 0.5], [bassOdf, 0.5], [leadOdf, 0.5]]
  for (const [odf, w] of mix) {
    const p = percentile(odf, 0.98) || 1
    for (let n = 0; n < frames; n++) all[n] += (w * Math.min(odf[n], 2 * p)) / p
  }
  const m0 = mean(all)
  const centred = all.map((v) => v - m0)
  const maxLag = Math.ceil((2 * 60) / MIN_BPM / hopSec) + 2
  const ac = new Float32Array(maxLag + 1)
  for (let l = 0; l <= maxLag; l++) {
    let s = 0
    for (let n = 0; n + l < frames; n++) s += centred[n] * centred[n + l]
    ac[l] = s / Math.max(1, frames - l)
    await breathe()
  }
  const acAt = (l: number) => {
    const i = Math.floor(l)
    return i + 1 > maxLag ? 0 : ac[i] + (ac[i + 1] - ac[i]) * (l - i)
  }
  let coarse = 120
  let best = -Infinity
  for (let bpm = MIN_BPM; bpm <= MAX_BPM; bpm += 0.25) {
    const P = 60 / bpm / hopSec
    const s = (acAt(P) + 0.5 * acAt(2 * P)) * Math.exp(-Math.pow(Math.log2(bpm / 120), 2) * 2)
    if (s > best) {
      best = s
      coarse = bpm
    }
  }
  await breathe()

  // Fine: the beat grid (tempo + phase) that lands on the most onset energy
  // across the whole track. Smoothed so a frame of jitter still counts.
  const smooth = new Float32Array(frames)
  for (let n = 2; n < frames - 2; n++)
    smooth[n] = (all[n - 2] + 4 * all[n - 1] + 6 * all[n] + 4 * all[n + 1] + all[n + 2]) / 16
  const at = (p: number) => {
    const i = Math.floor(p)
    return i + 1 >= frames ? 0 : smooth[i] + (smooth[i + 1] - smooth[i]) * (p - i)
  }
  const fit = async (from: number, to: number, step: number) => {
    let top = { bpm: coarse, phase: 0, score: -Infinity }
    for (let bpm = from; bpm <= to; bpm += step) {
      const P = 60 / bpm / hopSec
      for (let ph = 0; ph < P; ph += 0.5) {
        let s = 0
        for (let p = ph; p < frames; p += P) s += at(p)
        if (s > top.score) top = { bpm, phase: ph, score: s }
      }
      await breathe()
    }
    return top
  }
  let grid = await fit(coarse * 0.97, coarse * 1.03, 0.1)
  grid = await fit(grid.bpm - 0.12, grid.bpm + 0.12, 0.005)
  // Nothing rhythmic at all (silence, a drone): a plain 120 from the start.
  if (!(best > 0 && grid.score > 0)) grid = { bpm: 120, phase: 0, score: 0 }
  const bpm = Math.min(MAX_BPM, Math.max(MIN_BPM, grid.bpm))
  const beat = 60 / bpm
  const sixteenth = beat / 4

  // --- Onsets per voice --------------------------------------------------------
  const gapFor = (sec: number) => Math.max(2, Math.round(sec / hopSec))
  const W = Math.round(0.5 / hopSec)
  const present = (b: number) => refs[b] > loudest * 0.01
  const loud = (a: Float32Array, b: number, n: number, share = 0.1) => Math.max(a[n], a[n + 1] ?? 0) > refs[b] * share
  const kicks = present(0) ? peaks(kickOdf, gapFor(0.1), W, 0.2, 0.15).filter((n) => loud(kickAmp, 0, n)) : []
  const snares = present(1) && present(2)
    ? peaks(snareOdf, gapFor(0.1), W, 0.2, 0.15).filter((n) => loud(snareAmp, 1, n) && loud(noiseAmp, 2, n, 0.25)) : []
  const hats = present(3) ? peaks(hatOdf, gapFor(0.06), W, 0.2, 0.15).filter((n) => loud(hatAmp, 3, n)) : []
  const basses = peaks(bassOdf, gapFor(0.09), W, 0.2, 0.01)
  const leads = peaks(leadOdf, gapFor(0.08), W, 0.2, 0.01)

  // Bar start: try each beat of the grid as beat 1; kicks like 1 and 3, snares 2 and 4.
  const firstBeat = frameTime(grid.phase)
  let bar = 0
  best = -Infinity
  for (let b = 0; b < 4; b++) {
    const origin = firstBeat + b * beat
    const pos = (n: number) => (((Math.round((frameTime(n) - origin) / sixteenth) % 16) + 16) % 16)
    let s = 0
    for (const n of kicks) { const p = pos(n); s += kickOdf[n] * (p === 0 ? 1 : p === 8 ? 0.5 : 0) }
    for (const n of snares) { const p = pos(n); s += snareOdf[n] * (p === 4 || p === 12 ? 1 : p === 0 ? -0.5 : 0) }
    if (s > best) {
      best = s
      bar = b
    }
  }
  let offset = firstBeat + bar * beat
  offset -= Math.ceil(offset / (16 * sixteenth)) * 16 * sixteenth
  const stepOf = (t: number) => Math.max(0, Math.round((t - offset) / sixteenth))

  // --- Notes -------------------------------------------------------------------
  type Cand = NoteEvent & { strength: number }
  const cands: Cand[] = []
  const drums = (voice: Voice, onsets: number[], odf: Float32Array) => {
    for (const n of onsets)
      cands.push({ voice, pitch: DRUM[voice]!, velocity: 0, length: 1, step: stepOf(frameTime(n)), strength: odf[n] })
  }
  // A kick decays; a low onset that holds is the bass's.
  const decay = gapFor(0.2)
  drums('kick', kicks.filter((n, i) => {
    const next = kicks[i + 1] ?? Infinity
    if (next - n <= decay || n + decay >= frames) return true
    return kickAmp[n + decay] < 0.5 * Math.max(kickAmp[n], kickAmp[n + 1])
  }), kickOdf)
  drums('snare', snares, snareOdf)
  drums('hat', hats, hatOdf)
  const drumAt = new Uint8Array(frames)
  for (const n of [...kicks, ...snares]) for (let i = Math.max(0, n - 2); i <= Math.min(frames - 1, n + 2); i++) drumAt[i] = 1

  // Pitch from a long window just after the onset, minus what was already sounding.
  const PN = N * 4
  const pfft = new FFT(PN)
  const pBin = sr / PN
  const after = new Float32Array(PN / 2)
  const before = new Float32Array(PN / 2)
  const later = new Float32Array(PN / 2)
  // The window stops where the next hit or note starts, so it hears only this one.
  const starts = [...kicks, ...snares, ...basses, ...leads].sort((a, b) => a - b)
  const nextStart = (n: number) => {
    let a = 0
    let b = starts.length
    while (a < b) {
      const m = (a + b) >> 1
      if (starts[m] <= n + 2) a = m + 1
      else b = m
    }
    return a < starts.length ? starts[a] : Infinity
  }
  const pitchAt = (n: number, lo: number, hi: number) => {
    const t = frameTime(n)
    const room = (nextStart(n) - n) * hopSec - 0.02
    const len = Math.round(Math.max(0.06, Math.min(PN / sr, room)) * sr / 256) * 256
    const s = Math.round((t + 0.015) * sr)
    pfft.mags(x, s, len, after)
    pfft.mags(x, s - len - Math.round(0.025 * sr), len, before)
    let total = 0
    let fresh = 0
    for (let k = 0; k < after.length; k++) {
      total += after[k]
      before[k] = Math.max(0, after[k] - before[k])
      fresh += before[k]
    }
    const scores = harmonicScores(fresh > 0.2 * total ? before : after, pBin, lo, hi)
    const m = mean(scores) || 1
    const top = localMaxima(scores, 3)
    // The window after: a note is still there, a drum's partial has mostly gone.
    pfft.mags(x, s + len, len, later)
    return top.map((i) => {
      const k = Math.round(hz(lo + i) / pBin)
      const now = Math.max(after[k - 1], after[k], after[k + 1])
      const next = Math.max(later[k - 1], later[k], later[k + 1])
      return { pitch: lo + i, salience: scores[i] / m, persist: Math.min(1, next / (now || 1)) }
    })
  }
  // Frames the energy at a pitch (or its octave, if a drum muddies the
  // fundamental) holds above a third of its level ~60 ms in, once a drum's
  // attack has passed; a note gone by then ends where it first fell away.
  const near = (i: number, b: number) => Math.max(low[i * keep + Math.floor(b)], low[i * keep + Math.ceil(b)])
  const hold = (n: number, pitch: number, limit: number) => {
    let longest = 1
    for (const p of [pitch, pitch + 12]) {
      const b = hz(p) / binHz
      if (b < 1 || b >= keep - 1 || (p !== pitch && riseAt(n, p) < 0.3)) continue
      const end = Math.min(frames, n + limit)
      let early = 0
      let later = 0
      for (let i = n; i < Math.min(end, n + 4); i++) early = Math.max(early, near(i, b))
      for (let i = n + 4; i < Math.min(end, n + 7); i++) later = Math.max(later, near(i, b))
      let i = n + 1
      if (later > early / 4) {
        i = Math.min(end, n + 4)
        while (i < end && near(i, b) > later / 3) i++
      } else while (i < end && near(i, b) > early / 3) i++
      longest = Math.max(longest, i - n)
    }
    return longest
  }
  // How much the bins at a pitch rose into this onset (log units).
  const riseAt = (n: number, pitch: number) => {
    const b = hz(pitch) / binHz
    if (b < 1 || b >= keep - 1 || n < 2) return 0
    const now = Math.max(near(n, b), n + 1 < frames ? near(n + 1, b) : 0)
    return Math.max(0, Math.log1p(gain * now) - Math.log1p(gain * near(n - 2, b)))
  }
  /** Bass pitch sounding at each frame (0 for none), to tell its overtones from other parts. */
  const bassAt = new Uint8Array(frames)
  const overtone = (pitch: number, n: number, steps: number[]) => bassAt[n] > 0 && steps.includes(pitch - bassAt[n])
  const pitched = async (voice: 'bass' | 'lead', onsets: number[], odf: Float32Array, minSalience: number) => {
    const [lo, hi] = PITCH[voice]
    const cap = gapFor(16 * sixteenth)
    for (let i = 0; i < onsets.length; i++) {
      await breathe()
      const n = onsets[i]
      const t = frameTime(n)
      // On a drum hit the drum's own partials can pass for a note: those didn't
      // just rise at that pitch, or fade by the next window.
      const limit = cap
      // Of the strongest few pitches, the one that holds (drums decay, notes don't).
      // The new note is also the one whose bins just rose.
      let pick: { pitch: number; held: number; score: number; salience: number } | null = null
      for (const c of pitchAt(n, lo, hi)) {
        if (c.salience < minSalience || c.pitch === lo) continue
        if (voice === 'lead' && (overtone(c.pitch, n, [12, 19, 24]) || overtone(c.pitch, Math.min(frames - 1, n + 2), [12, 19, 24]))) continue
        const r = riseAt(n, c.pitch)
        if (drumAt[n] && r < 0.5) continue
        const held = hold(n, c.pitch, limit)
        const score = c.salience * (0.3 + r) * (0.2 + c.persist)
        if (!pick || score > pick.score) pick = { ...c, held, score }
      }
      if (!pick) continue
      const length = Math.max(1, Math.round((pick.held * hopSec) / sixteenth))
      // A short low note right on a drum hit is the drum itself.
      if (voice === 'bass' && length < 2 && drumAt[n]) continue
      if (voice === 'bass') bassAt.fill(pick.pitch, n, Math.min(frames, n + pick.held))
      const strength = odf[n] * Math.min(2, pick.salience / minSalience)
      cands.push({ voice, pitch: pick.pitch, velocity: 0, length, step: stepOf(t), strength })
    }
  }
  await pitched('bass', basses, bassOdf, 1.5)
  await pitched('lead', leads, leadOdf, 2.2)

  // Pads: per half bar, the steady pitches of the mid range, held while they last.
  const midLo = bin(150)
  const midHi = bin(1000)
  const midE = new Float32Array(frames)
  for (let n = 0; n < frames; n++) {
    let e = 0
    for (let k = midLo; k <= midHi; k++) e += low[n * keep + k] ** 2
    midE[n] = e
  }
  const midRef = percentile(midE, 0.75)
  const padFloor = 0.3 / gain // ~ -36 dB under the loudest low partials
  const half = 8 * sixteenth
  const open = new Map<number, Cand>()
  const steady = new Float32Array(PN / 2)
  for (let seg = 0; offset + (seg + 1) * half <= x.length / sr; seg++) {
    const t0 = offset + seg * half
    const a = Math.max(0, Math.ceil((t0 - frameTime(0)) / hopSec))
    const b = Math.min(frames, Math.floor((t0 + half - frameTime(0)) / hopSec))
    const chosen: number[] = []
    let energy = 0
    if (b - a > 4) {
      // Steady: the mid range never drops out through the half bar.
      const e = midE.subarray(a, b)
      energy = mean(e)
      if (energy > midRef * 0.1 && percentile(e, 0.2) > energy * 0.25) {
        // What's in every one of four windows is held; hits and passing notes aren't.
        steady.fill(Infinity)
        for (let j = 0; j < 4; j++) {
          pfft.mags(x, Math.round((t0 + ((j + 0.5) * half) / 4) * sr - PN / 2), PN, after)
          for (let k = 0; k < steady.length; k++) steady[k] = Math.min(steady[k], after[k])
        }
        const [lo, hi] = PITCH.pad
        const scores = harmonicScores(steady, pBin, lo, hi)
        const m = mean(scores) || 1
        const top = Math.max(...scores)
        if (top > padFloor && top / m > 1.8) {
          for (const i of localMaxima(scores, 6)) {
            if (chosen.length >= 3 || scores[i] < top * 0.4) break
            const p = lo + i
            const mid = Math.min(frames - 1, (a + b) >> 1)
            if (overtone(p, a, [12, 19]) || overtone(p, mid, [12, 19])) continue
            if (!chosen.some((c) => Math.abs(p - c) <= 1 || [12, 19, 24].includes(p - c))) chosen.push(p)
          }
        }
      }
    }
    for (const [p] of open) if (!chosen.includes(p)) open.delete(p)
    for (const p of chosen) {
      const held = open.get(p)
      if (held && held.length + 8 <= 32) held.length += 8
      else {
        const note: Cand = { voice: 'pad', pitch: p, velocity: 0, length: 8, step: stepOf(t0), strength: energy }
        cands.push(note)
        open.set(p, note)
      }
    }
    await breathe()
  }

  // --- Tidy: one note per voice per step, quiet ones out, capped per bar --------
  const byVoice = new Map<Voice, Cand[]>()
  for (const c of cands) {
    const list = byVoice.get(c.voice) ?? []
    list.push(c)
    byVoice.set(c.voice, list)
  }
  const notes: NoteEvent[] = []
  for (const [voice, list] of byVoice) {
    const ref = percentile(list.map((c) => c.strength), 0.9) || 1
    const at = new Map<string, Cand>()
    for (const c of list) {
      c.velocity = Math.min(1, c.strength / ref)
      if (c.velocity < 0.2) continue
      const key = voice === 'pad' ? `${c.step}:${c.pitch}` : `${c.step}`
      const had = at.get(key)
      if (!had || had.velocity < c.velocity) at.set(key, c)
    }
    const bars = new Map<number, Cand[]>()
    for (const c of at.values()) {
      const b = Math.floor(c.step / 16)
      bars.set(b, [...(bars.get(b) ?? []), c])
    }
    const kept: Cand[] = []
    for (const group of bars.values()) kept.push(...group.sort((p, q) => q.velocity - p.velocity).slice(0, CAP[voice]))
    kept.sort((p, q) => p.step - q.step)
    for (let i = 0; i < kept.length; i++) {
      const c = kept[i]
      // Bass and lead are one line each: a note ends where the next starts.
      if (voice !== 'pad' && kept[i + 1]) c.length = Math.max(1, Math.min(c.length, kept[i + 1].step - c.step))
      notes.push({ voice, pitch: c.pitch, velocity: Math.max(0.1, c.velocity), length: c.length, step: c.step })
    }
  }
  notes.sort((p, q) => p.step - q.step)
  const times = Float64Array.from(notes, (n) => offset + n.step * sixteenth)
  // Frames as heard at their middle (not shifted for transients like frameTime).
  const parts: MixFrames = { t0: N / 2 / sr, hop: hopSec, parts: estimateParts(power, centre, notes, offset, sixteenth, N / 2 / sr, hopSec) }
  return { bpm, sixteenth, offset, duration: x.length / sr, notes, times, mix: parts }
}

/** The four stems guessed per frame from region power (order of PART) and the notes. */
function estimateParts(
  power: Float32Array[],
  centre: Float32Array[],
  notes: NoteEvent[],
  offset: number,
  sixteenth: number,
  t0: number,
  hop: number,
): Record<'vocals' | 'drums' | 'bass' | 'instruments', FramedPart> {
  const [low, bass, voice, inst, full, high] = power
  const frames = low.length
  const gapFor = (sec: number) => Math.max(1, Math.round(sec / hop))
  const frameAt = (t: number) => (t - t0) / hop
  /** Running minimum over ±r frames. */
  const floorOf = (a: Float32Array, r: number) => {
    const out = new Float32Array(frames)
    for (let n = 0; n < frames; n++) {
      let m = Infinity
      for (let i = Math.max(0, n - r); i <= Math.min(frames - 1, n + r); i++) if (a[i] < m) m = a[i]
      out[n] = m
    }
    return out
  }

  // Drums: the highs, plus low and broadband energy as it rises, held ~60 ms.
  const drums = new Float32Array(frames)
  const release = Math.exp(-hop / 0.06)
  for (let n = 0; n < frames; n++) {
    const hit = n >= 2 ? Math.max(0, low[n] - low[n - 2]) + 0.5 * Math.max(0, full[n] - full[n - 2]) : 0
    drums[n] = Math.max(hit + high[n], n ? drums[n - 1] * release : 0)
  }
  // Bass: what of the lows outlasts a kick's burst.
  const bassOut = floorOf(bass, gapFor(0.12))
  // Vocals and instruments are tonal: what holds through ~0.1-0.15 s, not a hit.
  const voiced = floorOf(voice, gapFor(0.05))
  const tonal = floorOf(inst, gapFor(0.08))
  // Vocals: mid energy over its slow floor, most of it where a lead note sounds.
  const moving = floorOf(voiced, gapFor(0.75))
  const sung = new Uint8Array(frames)
  for (const n of notes) {
    if (n.voice !== 'lead') continue
    const a = Math.max(0, Math.floor(frameAt(offset + n.step * sixteenth)))
    const b = Math.min(frames, Math.ceil(frameAt(offset + (n.step + n.length) * sixteenth)))
    sung.fill(1, a, b)
  }
  const vocals = new Float32Array(frames)
  const instruments = new Float32Array(frames)
  for (let n = 0; n < frames; n++) {
    const move = Math.max(0, voiced[n] - moving[n])
    vocals[n] = sung[n] ? Math.max(move, 0.5 * voiced[n]) : 0.25 * move
    instruments[n] = Math.max(0, tonal[n] - vocals[n])
  }
  return {
    drums: { power: drums, centroid: centre[4] },
    bass: { power: bassOut, centroid: centre[1] },
    vocals: { power: vocals, centroid: centre[2] },
    instruments: { power: instruments, centroid: centre[3] },
  }
}
