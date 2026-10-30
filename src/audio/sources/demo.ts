import { STEMS, type KnownScore, type NoteEvent, type Stem, type TrackAnalysis, type Voice } from '../features'
import { analyseStems, describe } from '../analysis/track'
import { mono, type AudioSource, type OfflineTrack, type Score } from './types'

// A small synthesized loop (kick, snare, hats, bass, pad, a sung line) so every
// mode has something rhythmic to react to without loading a file. It knows
// exactly what it plays, so it reports a score: every note and the tempo. Each
// part plays into its own stem bus (drums, bass, instruments, vocals), so the
// demo has real stems like a generated track would.
// For the whole-track analysis the same synth renders the loop's stems once,
// silently (an OfflineAudioContext, one channel per stem), and they're
// analysed like loaded stems (analysis/track.ts).

const BPM = 104
const STEP = 60 / BPM / 4 // sixteenth notes
const LOOKAHEAD = 0.12
const BARS = 8
const LOOP = BARS * 16
const BASS = [41, 41, 44, 39] // MIDI roots, one per bar (repeats every 4)
const PAD = [[65, 68, 72], [65, 68, 72], [68, 72, 75], [63, 67, 70]]
/** Per bar: [step, MIDI, length in steps]. The second half answers the first. */
const LEAD = [
  [[0, 77, 2], [3, 80, 2], [6, 84, 3], [10, 82, 1], [12, 80, 3]],
  [[2, 77, 1], [4, 75, 3], [8, 77, 2], [14, 80, 2]],
  [[0, 80, 2], [3, 84, 2], [6, 87, 3], [10, 84, 1], [12, 82, 3]],
  [[0, 82, 3], [4, 79, 2], [8, 75, 3], [11, 77, 4]],
  [[0, 84, 2], [2, 82, 1], [3, 80, 3], [8, 77, 2], [11, 80, 1], [12, 84, 4]],
  [[0, 87, 3], [4, 84, 2], [7, 82, 1], [8, 80, 4], [14, 77, 2]],
  [[0, 80, 1], [2, 84, 1], [4, 87, 2], [6, 89, 3], [10, 87, 2], [12, 84, 4]],
  [[0, 82, 4], [6, 79, 2], [8, 75, 2], [10, 77, 2], [12, 79, 4]],
]

/** The whole loop as notes, step order; the synth plays from this too. */
function compose(): NoteEvent[] {
  const out: NoteEvent[] = []
  const note = (step: number, voice: Voice, pitch: number, velocity: number, length = 1) =>
    out.push({ voice, pitch, velocity, length, step })
  for (let step = 0; step < LOOP; step++) {
    const s = step % 16
    const bar = Math.floor(step / 16)
    const fill = bar === BARS - 1 && s >= 13
    if (s === 0 || s === 8 || s === 10) note(step, 'kick', 36, s === 0 ? 1 : 0.75, 2)
    if (s === 4 || s === 12) note(step, 'snare', 38, 0.85)
    if (fill) note(step, 'snare', 38, 0.35 + 0.15 * (s - 13))
    if (s % 2 === 0) note(step, 'hat', 42, s % 4 === 2 ? 1 : 0.5)
    if (s === 0 || s === 6 || s === 11) note(step, 'bass', BASS[bar % 4] - 12, s === 0 ? 1 : 0.7, s === 0 ? 3 : 2)
    if (s === 0) for (const m of PAD[bar % 4]) note(step, 'pad', m, 0.6, 16)
    // Sung an octave below where the line is written.
    for (const [at, m, len] of LEAD[bar]) if (at === s) note(step, 'lead', m - 12, 0.8, len)
  }
  return out
}

const PATTERN = compose()
/** Pattern notes per loop step. */
const AT: NoteEvent[][] = Array.from({ length: LOOP }, (_, i) => PATTERN.filter((n) => n.step === i))

const hz = (midi: number) => 440 * Math.pow(2, (midi - 69) / 12)

/** Vowel formants (Hz, relative gain); the singer moves through them note by note. */
const VOWELS: [number, number][][] = [
  [[800, 1], [1150, 0.5], [2900, 0.25]], // ah
  [[450, 1], [800, 0.45], [2830, 0.2]], // oh
  [[350, 1], [2000, 0.35], [2800, 0.25]], // ee
  [[325, 1], [700, 0.4], [2530, 0.15]], // oo
]

/** The loop's instruments, playing into a stem bus each; on a live or an offline context. */
class Synth {
  private sung = 0
  private lastSung = 0
  private vowel = 0

  constructor(
    private ctx: BaseAudioContext,
    private stems: Record<Stem, AudioNode>,
    private noise: AudioBuffer,
  ) {}

  /** Start the notes of one step at audio time `t`. */
  play(notes: NoteEvent[], t: number) {
    const pads: number[] = []
    let padLength = 0
    for (const n of notes) {
      if (n.voice === 'kick') this.kick(t)
      else if (n.voice === 'snare') this.snare(t, n.velocity)
      else if (n.voice === 'hat') this.hat(t, 0.35 * n.velocity)
      else if (n.voice === 'bass') this.bass(t, hz(n.pitch))
      else if (n.voice === 'lead') this.sing(t, n.pitch, n.length * STEP)
      else {
        pads.push(hz(n.pitch))
        padLength = n.length
      }
    }
    if (pads.length) this.pad(t, pads, padLength * STEP)
  }

  private env(t: number, attack: number, decay: number, peak: number, stem: Stem) {
    const g = this.ctx.createGain()
    g.gain.setValueAtTime(0.0001, t)
    g.gain.exponentialRampToValueAtTime(peak, t + attack)
    g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay)
    g.connect(this.stems[stem])
    return g
  }

  private kick(t: number) {
    const o = this.ctx.createOscillator()
    o.frequency.setValueAtTime(140, t)
    o.frequency.exponentialRampToValueAtTime(42, t + 0.12)
    o.connect(this.env(t, 0.003, 0.4, 0.9, 'drums'))
    o.start(t)
    o.stop(t + 0.5)
  }

  private noiseHit(t: number, type: BiquadFilterType, freq: number, decay: number, peak: number) {
    const n = this.ctx.createBufferSource()
    n.buffer = this.noise
    const f = this.ctx.createBiquadFilter()
    f.type = type
    f.frequency.value = freq
    n.connect(f).connect(this.env(t, 0.002, decay, peak, 'drums'))
    n.start(t, Math.random() * 0.5)
    n.stop(t + decay + 0.05)
  }

  private snare(t: number, velocity = 1) {
    this.noiseHit(t, 'bandpass', 1800, 0.18, 0.5 * velocity)
  }

  private hat(t: number, peak: number) {
    this.noiseHit(t, 'highpass', 8000, 0.05, peak)
  }

  private bass(t: number, f: number) {
    const o = this.ctx.createOscillator()
    o.type = 'triangle'
    o.frequency.value = f
    o.connect(this.env(t, 0.01, 0.35, 0.45, 'bass'))
    o.start(t)
    o.stop(t + 0.4)
  }

  /** A sung note: a buzzy source through vowel formants, sliding in from the last note, with vibrato. */
  private sing(t: number, m: number, dur: number) {
    const ctx = this.ctx
    const o = ctx.createOscillator()
    o.type = 'sawtooth'
    const from = this.lastSung && t - this.lastSung < 0.6 ? this.sung : m
    o.frequency.setValueAtTime(hz(from), t)
    o.frequency.exponentialRampToValueAtTime(hz(m), t + 0.06)
    this.sung = m
    this.lastSung = t + dur
    // Vibrato that blooms after the onset.
    const lfo = ctx.createOscillator()
    lfo.frequency.value = 5.4
    const depth = ctx.createGain()
    depth.gain.setValueAtTime(0, t)
    depth.gain.linearRampToValueAtTime(hz(m) * 0.012, t + Math.min(0.35, dur))
    lfo.connect(depth).connect(o.frequency)

    const g = ctx.createGain()
    g.gain.setValueAtTime(0, t)
    g.gain.linearRampToValueAtTime(0.5, t + 0.04)
    g.gain.setValueAtTime(0.5, t + dur)
    g.gain.linearRampToValueAtTime(0, t + dur + 0.14)
    g.connect(this.stems.vocals)
    for (const [f, a] of VOWELS[this.vowel++ % VOWELS.length]) {
      const bp = ctx.createBiquadFilter()
      bp.type = 'bandpass'
      bp.frequency.value = f
      bp.Q.value = 9
      const amp = ctx.createGain()
      amp.gain.value = a
      o.connect(bp).connect(amp).connect(g)
    }
    o.start(t)
    lfo.start(t)
    o.stop(t + dur + 0.2)
    lfo.stop(t + dur + 0.2)
  }

  private pad(t: number, freqs: number[], dur: number) {
    const lp = this.ctx.createBiquadFilter()
    lp.frequency.setValueAtTime(600, t)
    lp.frequency.linearRampToValueAtTime(2400, t + dur * 0.5)
    lp.frequency.linearRampToValueAtTime(600, t + dur)
    const g = this.ctx.createGain()
    g.gain.setValueAtTime(0, t)
    g.gain.linearRampToValueAtTime(0.06, t + 0.6)
    g.gain.linearRampToValueAtTime(0, t + dur)
    lp.connect(g).connect(this.stems.instruments)
    for (const f of freqs) {
      const o = this.ctx.createOscillator()
      o.type = 'sawtooth'
      o.frequency.value = f
      o.detune.value = (Math.random() - 0.5) * 12
      o.connect(lp)
      o.start(t)
      o.stop(t + dur)
    }
  }
}

/** Noise for the drums: a second of it. */
function noiseBuffer(ctx: BaseAudioContext) {
  const b = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate)
  const d = b.getChannelData(0)
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1
  return b
}

const pause = () => new Promise<void>((r) => setTimeout(r, 0))
let loopAnalysis: Promise<TrackAnalysis> | null = null

/**
 * The loop's whole-track analysis, rendered once per page: two passes of the
 * loop at 22 kHz, one channel per stem, analysed on the second pass so the
 * tails of the first (pads, the sung slide) are there as they are when it loops.
 */
function analyseLoop() {
  return (loopAnalysis ??= (async () => {
    const t0 = performance.now()
    const rate = 22050
    const loop = LOOP * STEP
    const ctx = new OfflineAudioContext({ numberOfChannels: STEMS.length, length: Math.ceil((2 * loop + 0.1) * rate), sampleRate: rate })
    ctx.destination.channelInterpretation = 'discrete'
    const merger = ctx.createChannelMerger(STEMS.length)
    merger.connect(ctx.destination)
    const buses = Object.fromEntries(STEMS.map((st, i) => {
      const g = ctx.createGain()
      g.connect(merger, 0, i)
      return [st, g]
    })) as Record<Stem, GainNode>
    const synth = new Synth(ctx, buses, noiseBuffer(ctx))
    for (let i = 0; i < 2 * LOOP; i++) {
      synth.play(AT[i % LOOP], 0.05 + i * STEP)
      if (i % 16 === 15) await pause()
    }
    const out = await ctx.startRendering()
    const byStem = Object.fromEntries(STEMS.map((st, i) => [st, out.getChannelData(i)])) as Record<Stem, Float32Array>
    const a = await analyseStems(byStem, rate, { offset: 0.05 + loop, sixteenth: STEP, steps: LOOP }, PATTERN)
    console.log(`[demo] analysis: ${describe(a)}, ${Math.round(performance.now() - t0)} ms`)
    return a
  })())
}

export class DemoSource implements AudioSource {
  readonly kind = 'demo'
  readonly audible = true
  readonly output: GainNode
  readonly stems: Record<Stem, GainNode>
  private synth: Synth
  private timer = 0
  private nextTime = 0
  private step = 0
  /** Steps scheduled since the first start; never wraps, so the clock runs on. */
  private total = 0
  /** Audio time of step 0. */
  private origin = 0
  private running = false
  private disposed = false
  private pending: { time: number; note: NoteEvent }[] = []
  /** The analysis joins this once rendered. */
  private known: KnownScore = { notes: PATTERN, loop: LOOP, analysis: null }

  readonly score: Score

  constructor(private ctx: AudioContext) {
    this.output = ctx.createGain()
    this.output.gain.value = 0.7
    this.stems = Object.fromEntries(STEMS.map((st) => {
      const g = ctx.createGain()
      g.connect(this.output)
      return [st, g]
    })) as Record<Stem, GainNode>
    this.synth = new Synth(ctx, this.stems, noiseBuffer(ctx))

    const self = this
    this.score = {
      bpm: BPM,
      position: (now) => (this.running ? Math.max(0, (now - this.origin) / STEP) : null),
      get known() {
        return self.known
      },
      takeNotes: (now, out) => {
        let i = 0
        while (i < this.pending.length && this.pending[i].time <= now) out.push(this.pending[i++].note)
        if (i) this.pending.splice(0, i)
      },
    }

    // In the background, after the page has settled; playback doesn't wait.
    setTimeout(() => {
      if (this.disposed) return
      analyseLoop()
        .then((a) => {
          if (!this.disposed) this.known.analysis = a
        })
        .catch((e) => console.warn('[demo] analysis failed', e))
    }, 300)
  }

  start() {
    this.nextTime = this.ctx.currentTime + 0.05
    this.origin = this.nextTime - this.total * STEP
    this.running = true
    this.timer = window.setInterval(() => this.schedule(), 25)
  }

  /** Carry on from `step` (the loop wraps); the clock keeps counting from there. */
  seek(step: number) {
    this.step = ((Math.round(step) % LOOP) + LOOP) % LOOP
    this.total = Math.round(step)
    this.pending.length = 0
    if (this.running) this.origin = this.nextTime - this.total * STEP
  }

  stop() {
    clearInterval(this.timer)
    this.running = false
    this.pending.length = 0
  }

  dispose() {
    this.disposed = true
    this.stop()
    this.output.disconnect()
  }

  /**
   * The loop at the live rate, one channel per stem: two passes, keeping the
   * second so it wraps with the first's tails, as it sounds looping.
   */
  async renderOffline(): Promise<OfflineTrack> {
    const rate = this.ctx.sampleRate
    const loop = LOOP * STEP
    const n = Math.round(loop * rate)
    const ctx = new OfflineAudioContext({ numberOfChannels: STEMS.length, length: 2 * n + Math.ceil(0.1 * rate), sampleRate: rate })
    ctx.destination.channelInterpretation = 'discrete'
    const merger = ctx.createChannelMerger(STEMS.length)
    merger.connect(ctx.destination)
    const buses = Object.fromEntries(STEMS.map((st, i) => {
      const g = ctx.createGain()
      g.connect(merger, 0, i)
      return [st, g]
    })) as Record<Stem, GainNode>
    const synth = new Synth(ctx, buses, noiseBuffer(ctx))
    for (let i = 0; i < 2 * LOOP; i++) {
      synth.play(AT[i % LOOP], i * STEP)
      if (i % 16 === 15) await pause()
    }
    const out = await ctx.startRendering()
    const stems = Object.fromEntries(STEMS.map((st, i) => [st, out.getChannelData(i).slice(n, 2 * n)])) as Record<Stem, Float32Array>
    const mix = mono(STEMS.map((st) => stems[st]), STEMS.length * this.output.gain.value)
    // Steps from time 0; the notes of each step as it's passed (step numbers run on, as live).
    let last = -1
    const score: Score = {
      bpm: BPM,
      known: this.known,
      position: (now) => Math.max(0, now / STEP),
      takeNotes: (now, notes) => {
        const to = Math.floor(now / STEP + 1e-6)
        for (let i = last + 1; i <= to; i++) for (const nt of AT[((i % LOOP) + LOOP) % LOOP]) notes.push({ ...nt, step: i })
        last = Math.max(last, to)
      },
    }
    return { sampleRate: rate, duration: loop, channels: [mix], mono: mix, stems, score }
  }

  private schedule() {
    while (this.nextTime < this.ctx.currentTime + LOOKAHEAD) {
      for (const n of AT[this.step]) this.pending.push({ time: this.nextTime, note: { ...n, step: this.total } })
      this.synth.play(AT[this.step], this.nextTime)
      this.nextTime += STEP
      this.step = (this.step + 1) % LOOP
      this.total++
    }
  }
}
