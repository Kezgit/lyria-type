import type { NoteEvent, Stem, Voice } from '../features'
import { FFT } from './offline'

// Notes from one isolated stem. A stem holds one part, so this is much simpler
// than pulling notes out of a mix:
//   drums        three bands (kick 40-150 Hz, snare noise 1-5 kHz, hats
//                6-11 kHz), an onset each; a snare's own sizzle isn't a hat
//                and a kick's click isn't a snare
//   vocals/bass  onsets in the loudness, plus pitch changes held for a few
//                frames (legato); each note's pitch from a harmonic sum on a
//                long FFT starting at it, its end where the level falls away
//   instruments  the same segments, each read as a chord (up to 3 pitches,
//                peeling off each one's harmonics before finding the next),
//                re-read on every beat so held chord changes still split
// Times are in seconds; the caller puts them on its grid.

export interface TimedNote {
  /** Seconds from the start of the track. */
  time: number
  voice: Voice
  pitch: number
  velocity: number
  /** Seconds. */
  duration: number
}

const RATE = 22050
const HOP = 256
const pause = () => new Promise<void>((r) => setTimeout(r, 0))

/** MIDI range searched per pitched stem. */
const RANGE: Record<'vocals' | 'bass' | 'instruments', [number, number]> = {
  vocals: [45, 88], bass: [24, 55], instruments: [40, 84],
}
const HARMONICS = [1, 0.7, 0.5, 0.4, 0.3, 0.25]
const hz = (m: number) => 440 * Math.pow(2, (m - 69) / 12)

/** Mono at ~22 kHz (averaging; what folds over is only hat air). */
function downsample(x: Float32Array, rate: number) {
  const k = Math.max(1, Math.round(rate / RATE))
  const out = new Float32Array(Math.floor(x.length / k))
  for (let i = 0; i < out.length; i++) {
    let s = 0
    for (let j = 0; j < k; j++) s += x[i * k + j]
    out[i] = s / k
  }
  return { x: out, rate: rate / k }
}

function percentile(a: ArrayLike<number>, p: number) {
  const s = Float32Array.from(a).sort()
  return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : 0
}

/**
 * Peaks of an onset function: local maxima above a local mean (±`window`
 * frames) by `k`, above `floor`, at least `gap` frames apart (the stronger wins).
 */
function peaks(odf: Float32Array, gap: number, window: number, k: number, floor: number): number[] {
  const out: number[] = []
  let sum = 0
  const n = odf.length
  for (let i = 0; i < Math.min(n, window); i++) sum += odf[i]
  for (let i = 0; i < n; i++) {
    if (i + window < n) sum += odf[i + window]
    if (i - window - 1 >= 0) sum -= odf[i - window - 1]
    const count = Math.min(n, i + window + 1) - Math.max(0, i - window)
    const v = odf[i]
    if (v < floor || v < (sum / count) * k) continue
    if (v < odf[i - 1] || v < odf[i + 1]) continue
    const last = out[out.length - 1]
    if (last !== undefined && i - last < gap) {
      if (v > odf[last]) out[out.length - 1] = i
      continue
    }
    out.push(i)
  }
  return out
}

/** Log energy per hop in [lo, hi] Hz from a short FFT. */
async function bandEnergies(x: Float32Array, rate: number, bands: [number, number][]) {
  const fft = new FFT(1024)
  const mags = new Float32Array(512)
  const binHz = rate / 1024
  const frames = Math.floor(x.length / HOP)
  const out = bands.map(() => new Float32Array(frames))
  let t = performance.now()
  for (let f = 0; f < frames; f++) {
    fft.mags(x, f * HOP - 512, 1024, mags)
    bands.forEach(([lo, hi], b) => {
      let e = 0
      for (let k = Math.ceil(lo / binHz); k <= Math.min(511, hi / binHz); k++) e += mags[k] * mags[k]
      out[b][f] = Math.log10(e + 1e-9)
    })
    if (performance.now() - t > 10) {
      await pause()
      t = performance.now()
    }
  }
  return out
}

/** Positive rise of a log-energy curve over `span` hops (dB-ish). */
function rise(le: Float32Array, span = 2) {
  const out = new Float32Array(le.length)
  for (let i = span; i < le.length; i++) out[i] = Math.max(0, le[i] - le[i - span]) * 10
  return out
}

/**
 * Rise in linear energy, relative to the band's loud level: leakage climbing
 * out of near-silence is a big jump in dB but a tiny one here.
 */
function linearRise(le: Float32Array) {
  const lin = Float32Array.from(le, (v) => Math.pow(10, v))
  const ref = Math.max(1e-12, percentile(lin, 0.98))
  const out = new Float32Array(le.length)
  for (let i = 2; i < le.length; i++) out[i] = Math.max(0, lin[i] - lin[i - 2]) / ref
  return out
}

/** Velocities from onset strengths, relative to the part's own loud hits. */
function velocities(strength: number[]) {
  const ref = Math.max(1e-6, percentile(strength, 0.9))
  return strength.map((s) => Math.min(1, Math.max(0.15, s / ref)))
}

// --- Drums ---------------------------------------------------------------------

async function drums(x: Float32Array, rate: number): Promise<TimedNote[]> {
  const [low, mid, high] = await bandEnergies(x, rate, [[40, 150], [1000, 5000], [6000, 11000]])
  const r = [linearRise(low), linearRise(mid), linearRise(high)]
  // Ignore bands that never carry anything (e.g. a kit with no hats).
  const loud = [low, mid, high].map((le) => percentile(le, 0.98))
  const top = Math.max(...loud)
  const gap = Math.round((0.06 * rate) / HOP)
  const win = Math.round((0.3 * rate) / HOP)
  const found = r.map((odf, b) => (loud[b] > top - 3.5 ? peaks(odf, gap, win, 1.8, 0.08) : []))
  const near = (list: number[], f: number) => list.find((g) => Math.abs(g - f) <= 2)

  const notes: TimedNote[] = []
  const push = (voice: Voice, frames: number[], strength: number[], pitch: number) => {
    const v = velocities(strength)
    frames.forEach((f, i) => notes.push({ time: (f * HOP) / rate, voice, pitch, velocity: v[i], duration: 0.1 }))
  }
  const [kicks, mids, highs] = found
  // A kick's click rises in the mid band too: only a clearly stronger mid rise is a snare.
  const snares = mids.filter((f) => {
    const k = near(kicks, f)
    return k === undefined || r[1][f] > r[0][k] * 0.8
  })
  // A snare's noise reaches the hat band: only a clearly stronger high rise is a hat.
  const hats = highs.filter((f) => {
    const s = near(snares, f)
    return s === undefined || r[2][f] > r[1][s] * 1.3
  })
  push('kick', kicks, kicks.map((f) => r[0][f]), 36)
  push('snare', snares, snares.map((f) => r[1][f]), 38)
  push('hat', hats, hats.map((f) => r[2][f]), 42)
  return notes
}

// --- Pitch -----------------------------------------------------------------------

/** Harmonic-sum score of every MIDI note in range; a weak fundamental is penalised (no phantom sub-octaves). */
function scores(m: Float32Array, binHz: number, lo: number, hi: number, out: Float32Array) {
  const at = (f: number) => {
    const k = f / binHz
    const i = Math.floor(k)
    if (i + 1 >= m.length) return 0
    return m[i] + (m[i + 1] - m[i]) * (k - i)
  }
  let peak = 0
  for (let i = 0; i < m.length; i++) peak = Math.max(peak, m[i])
  for (let c = lo; c <= hi; c++) {
    const f0 = hz(c)
    let s = 0
    for (let h = 0; h < HARMONICS.length; h++) s += HARMONICS[h] * at(f0 * (h + 1))
    out[c - lo] = at(f0) < peak * 0.08 ? s * 0.3 : s
  }
}

/** Up to `count` pitches, strongest first; each one's harmonics are removed before the next is sought. */
function chord(m: Float32Array, binHz: number, lo: number, hi: number, count: number): number[] {
  const work = Float32Array.from(m)
  const s = new Float32Array(hi - lo + 1)
  const out: number[] = []
  let first = 0
  for (let n = 0; n < count; n++) {
    scores(work, binHz, lo, hi, s)
    let best = 0
    for (let i = 1; i < s.length; i++) if (s[i] > s[best]) best = i
    if (s[best] <= 0 || (n > 0 && s[best] < first * 0.35)) break
    if (n === 0) first = s[best]
    const c = lo + best
    out.push(c)
    // Peel off its harmonics (±1 bin around each).
    for (let h = 1; h <= HARMONICS.length; h++) {
      const k = Math.round((hz(c) * h) / binHz)
      for (let j = k - 1; j <= k + 1; j++) if (j >= 0 && j < work.length) work[j] = 0
    }
  }
  return out
}

async function pitched(x: Float32Array, rate: number, stem: 'vocals' | 'bass' | 'instruments', beat: number): Promise<TimedNote[]> {
  const voice: Voice = stem === 'vocals' ? 'lead' : stem === 'bass' ? 'bass' : 'pad'
  const [lo, hi] = RANGE[stem]

  // Loudness envelope and its onsets.
  const frames = Math.floor(x.length / HOP)
  const le = new Float32Array(frames)
  for (let f = 0; f < frames; f++) {
    let e = 0
    for (let i = f * HOP; i < Math.min(x.length, f * HOP + 512); i++) e += x[i] * x[i]
    le[f] = Math.log10(e / 512 + 1e-10)
  }
  const gate = percentile(le, 0.95) - 2 // 20 dB under the loud parts
  // Chords swell in slowly: judge their rise over a longer span, and allow fewer onsets.
  const slow = stem === 'instruments'
  const on = rise(le, slow ? 8 : 2)
  const gapS = slow ? 0.3 : 0.07
  const onsets = peaks(on, Math.round((gapS * rate) / HOP), Math.round((0.3 * rate) / HOP), slow ? 1.3 : 1.6, slow ? 1 : 2)
    .filter((f) => le[Math.min(frames - 1, f + 2)] > gate)
  // A note already sounding when the file starts has no rise to find.
  if (le[2] > gate && !(onsets[0] < 6)) onsets.unshift(0)

  // Pitch track: a long FFT starting at each frame (it hears what follows the frame).
  const N = stem === 'bass' ? 8192 : 4096
  const fft = new FFT(N)
  const mags = new Float32Array(N / 2)
  const binHz = rate / N
  const STEP = 2 // pitch every 2 hops
  const track = new Int16Array(Math.ceil(frames / STEP)).fill(-1)
  const sc = new Float32Array(hi - lo + 1)
  let t = performance.now()
  const readAt = (f: number, count: number) => {
    fft.mags(x, f * HOP, Math.min(N, Math.round(0.25 * rate)), mags)
    return chord(mags, binHz, lo, hi, count)
  }
  if (stem !== 'instruments') {
    for (let j = 0; j < track.length; j++) {
      const f = j * STEP
      if (le[f] > gate) {
        fft.mags(x, f * HOP, Math.min(N, Math.round(0.12 * rate)), mags)
        scores(mags, binHz, lo, hi, sc)
        let best = 0
        for (let i = 1; i < sc.length; i++) if (sc[i] > sc[best]) best = i
        if (sc[best] > 0) track[j] = lo + best
      }
      if (performance.now() - t > 10) {
        await pause()
        t = performance.now()
      }
    }
  }

  // Note boundaries: loudness onsets, plus (mono parts) pitch changes held ~70 ms.
  const starts = new Set(onsets)
  if (stem !== 'instruments') {
    const hold = 3
    for (let j = 1; j + hold < track.length; j++) {
      const p = track[j]
      if (p < 0 || p === track[j - 1]) continue
      let steady = true
      for (let k = 1; k <= hold; k++) if (track[j + k] !== p) steady = false
      if (steady && track[j - 1] >= 0) starts.add(j * STEP)
    }
  } else {
    // Chords: re-read on every beat inside long segments; a changed chord splits it.
    const beatF = Math.max(1, Math.round((beat * rate) / HOP))
    const sorted = [...starts].sort((a, b) => a - b)
    for (let i = 0; i < sorted.length; i++) {
      const end = sorted[i + 1] ?? frames
      let prev = readAt(sorted[i], 3).sort().join()
      for (let f = sorted[i] + beatF; f < end - beatF / 2; f += beatF) {
        if (le[f] <= gate) continue
        const now = readAt(f, 3).sort().join()
        if (now !== prev) starts.add(f)
        prev = now
        if (performance.now() - t > 10) {
          await pause()
          t = performance.now()
        }
      }
    }
  }
  const minGap = slow ? Math.round((0.25 * rate) / HOP) : 2
  const bounds = [...starts].sort((a, b) => a - b).filter((f, i, a) => i === 0 || f - a[i - 1] > minGap)

  // One note (or chord) per segment; it ends where the level falls well below its peak.
  const notes: TimedNote[] = []
  const strength: number[] = []
  for (let i = 0; i < bounds.length; i++) {
    const s = bounds[i]
    const next = bounds[i + 1] ?? frames
    // Its loudest point in the first ~0.1 s (after any swell-in), then on to where it falls away.
    let peak = -Infinity
    let at = s
    for (let f = s; f < Math.min(next, s + 8); f++) {
      if (le[f] > peak) {
        peak = le[f]
        at = f
      }
    }
    let e = at + 1
    // Ends 20 dB under its peak (or at the gate, or the next note).
    while (e < next && le[e] > Math.max(gate, peak - 2)) e++
    const duration = ((e - s) * HOP) / rate
    if (duration < 0.04) continue
    let pitches: number[]
    if (stem === 'instruments') pitches = readAt(s + 1, 3)
    else {
      // Most common pitch over the note's first frames.
      const votes = new Map<number, number>()
      for (let j = Math.ceil(s / STEP); j < Math.min(track.length, Math.ceil(e / STEP), Math.ceil(s / STEP) + 6); j++) {
        if (track[j] >= 0) votes.set(track[j], (votes.get(track[j]) ?? 0) + 1)
      }
      const best = [...votes].sort((a, b) => b[1] - a[1])[0]
      pitches = best ? [best[0]] : []
    }
    for (const p of pitches) notes.push({ time: (s * HOP) / rate, voice, pitch: p, velocity: 0, duration })
    strength.push(...pitches.map(() => Math.max(0.01, peak - gate)))
  }
  const v = velocities(strength)
  notes.forEach((n, i) => (n.velocity = v[i]))
  return notes
}

/** Every note in one isolated stem. `beat`: seconds per beat (for chord re-reads). */
export async function stemNotes(samples: Float32Array, rate: number, stem: Stem, beat: number): Promise<TimedNote[]> {
  const { x, rate: r } = downsample(samples, rate)
  if (stem === 'drums') return drums(x, r)
  return pitched(x, r, stem, beat)
}

/** Timed notes onto a grid of sixteenths starting at `offset` seconds. */
export function onGrid(notes: TimedNote[], offset: number, sixteenth: number): { note: NoteEvent; time: number }[] {
  return notes.map((n) => {
    const step = Math.round((n.time - offset) / sixteenth)
    return {
      note: { voice: n.voice, pitch: n.pitch, velocity: n.velocity, length: Math.max(1, Math.round(n.duration / sixteenth)), step },
      time: offset + step * sixteenth,
    }
  })
}
