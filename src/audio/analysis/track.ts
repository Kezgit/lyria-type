import { STEMS, STEM_OF, VOICES, type NoteEvent, type PartAnalysis, type Stem, type TrackAnalysis } from '../features'
import { FFT } from './offline'

// The whole track (or loop) read once for what generators need beyond the
// notes, on the notes' own step grid. Shared by every source with a score:
//   envelope    RMS per frame (`RESOLUTION` per sixteenth from step 0) of each
//               stem's audio, or of its estimate from the mix (offline.ts),
//               over that part's own loud level (~98th percentile), 0..1; a
//               part far below the loudest stays low rather than being blown up
//   active      steps whose level peaks over a gate, gaps under a beat closed
//               (peaks, so a drum part between hits still counts as playing)
//   prominence  mean level x share of steps active, the top part = 1
//   brightness  spectral centroid while it plays, log 100 Hz - 8 kHz
//   sections    per bar a vector (each stem's level, each voice's note
//               density); a section starts where the next bars differ from the
//               last few by enough, the strongest such changes first, a few
//               bars apart at least
//   repeats     per bar, the earliest bar with (nearly) the same notes per
//               stem and the same envelope shape
// Work is sliced with yields so the page keeps drawing while it runs.

/** Envelope frames per sixteenth step. */
export const RESOLUTION = 6
/** Level a part must hold through a step to count as playing. */
const GATE = 0.12
/** A part's loud level is at least this share of the loudest part's (real stems / mix estimates). */
const RELATIVE = { stems: 0.03, mix: 0.1 }
const BRIGHT: [number, number] = [100, 8000]
/** Bars compared before a candidate section start, and after it. */
const PAST = 4
const AHEAD = 2
/** Summed change (levels + half the densities) that starts a section, and over the track's usual change. */
const NOVELTY = 0.45
const NOVELTY_OVER_MEDIAN = 3
/** Similarity at which a bar counts as a repeat of an earlier one. */
const REPEAT = 0.85
const SLICE_MS = 10

const pause = () => new Promise<void>((r) => setTimeout(r, 0))

/** Await it often; it yields only once ~10 ms of work have passed. */
function breather() {
  let start = performance.now()
  return async () => {
    if (performance.now() - start < SLICE_MS) return
    await pause()
    start = performance.now()
  }
}

/** The step grid the notes are on, from step 0 to the end of the analysis. */
export interface StepGrid {
  /** Seconds of the audio at step 0 (may be < 0: the first bar starts before the audio). */
  offset: number
  /** Seconds per sixteenth. */
  sixteenth: number
  /** Steps covered (whole bars). */
  steps: number
}

/** Steps (whole bars) that cover `duration` seconds of audio from `offset`. */
export function wholeBars(duration: number, offset: number, sixteenth: number) {
  return Math.max(16, Math.ceil((duration - offset) / sixteenth / 16 - 1e-6) * 16)
}

/** Per-frame loudness and per-step centroid of one part, before normalising. */
export interface RawPart {
  /** RMS per frame on the grid. */
  rms: Float32Array
  /** Spectral centroid (Hz) per step; 0 where unknown or silent. */
  centroid: Float32Array
}

/** A part estimated from the mix: power per STFT frame, and its centroid. */
export interface FramedPart {
  power: Float32Array
  centroid: Float32Array
}

/** Frame layout of an STFT: frame n is centred at `t0 + n * hop` seconds. */
export interface Frames {
  t0: number
  hop: number
}

/** The four parts estimated from a mix, per STFT frame (see offline.ts). */
export interface MixFrames extends Frames {
  parts: Record<Stem, FramedPart>
}

// --- From isolated audio (stems, the demo's render) ----------------------------

/** RMS of `x` per envelope frame of the grid. */
export async function loudness(x: Float32Array, rate: number, grid: StepGrid, resolution = RESOLUTION) {
  const breathe = breather()
  const out = new Float32Array(grid.steps * resolution)
  const span = grid.sixteenth / resolution
  for (let k = 0; k < out.length; k++) {
    const a = Math.max(0, Math.round((grid.offset + k * span) * rate))
    const b = Math.min(x.length, Math.round((grid.offset + (k + 1) * span) * rate))
    let s = 0
    for (let i = a; i < b; i++) s += x[i] * x[i]
    out[k] = b > a ? Math.sqrt(s / (b - a)) : 0
    if ((k & 63) === 0) await breathe()
  }
  return out
}

/** Spectral centroid (Hz) per step of `x`, from a ~45 ms window at each step's middle; quiet steps 0. */
export async function centroids(x: Float32Array, rate: number, grid: StepGrid, rms: Float32Array, resolution = RESOLUTION) {
  const breathe = breather()
  const N = rate > 32000 ? 2048 : 1024
  const fft = new FFT(N)
  const mags = new Float32Array(N / 2)
  const binHz = rate / N
  const lo = Math.max(1, Math.round(40 / binHz))
  const hi = Math.min(N / 2 - 1, Math.round(Math.min(11000, rate * 0.45) / binHz))
  const level = stepMeans(rms, resolution)
  const loudest = Math.max(...level, 1e-9)
  const out = new Float32Array(grid.steps)
  for (let s = 0; s < grid.steps; s++) {
    if (level[s] < loudest * 0.05) continue
    const centre = Math.round((grid.offset + (s + 0.5) * grid.sixteenth) * rate)
    fft.mags(x, centre - N / 2, N, mags)
    let w = 0
    let f = 0
    for (let k = lo; k <= hi; k++) {
      w += mags[k]
      f += mags[k] * k * binHz
    }
    out[s] = w > 0 ? f / w : 0
    await breathe()
  }
  return out
}

/** Everything about one isolated part's audio. */
export async function rawPart(x: Float32Array, rate: number, grid: StepGrid, resolution = RESOLUTION): Promise<RawPart> {
  const rms = await loudness(x, rate, grid, resolution)
  return { rms, centroid: await centroids(x, rate, grid, rms, resolution) }
}

// --- From the mix (offline.ts's STFT) -----------------------------------------

/** A part's STFT frames onto the grid: RMS per envelope frame, power-weighted centroid per step. */
export async function framedPart(part: FramedPart, frames: Frames, grid: StepGrid, resolution = RESOLUTION): Promise<RawPart> {
  const breathe = breather()
  const { power, centroid } = part
  const n = power.length
  const at = (t: number) => (t - frames.t0) / frames.hop
  const rms = new Float32Array(grid.steps * resolution)
  const span = grid.sixteenth / resolution
  for (let k = 0; k < rms.length; k++) {
    const t = grid.offset + k * span
    const a = Math.max(0, Math.ceil(at(t)))
    const b = Math.min(n, Math.ceil(at(t + span)))
    let p = 0
    if (b > a) {
      for (let i = a; i < b; i++) p += power[i]
      p /= b - a
    } else {
      // Frames shorter than the hop: interpolate at the middle.
      const f = at(t + span / 2)
      const i = Math.floor(f)
      if (i >= 0 && i + 1 < n) p = power[i] + (power[i + 1] - power[i]) * (f - i)
    }
    rms[k] = Math.sqrt(Math.max(0, p))
    if ((k & 255) === 0) await breathe()
  }
  const cent = new Float32Array(grid.steps)
  for (let s = 0; s < grid.steps; s++) {
    const a = Math.max(0, Math.ceil(at(grid.offset + s * grid.sixteenth)))
    const b = Math.min(n, Math.ceil(at(grid.offset + (s + 1) * grid.sixteenth)))
    let w = 0
    let f = 0
    for (let i = a; i < b; i++) {
      w += power[i]
      f += power[i] * centroid[i]
    }
    cent[s] = w > 0 ? f / w : 0
  }
  return { rms, centroid: cent }
}

// --- The analysis -------------------------------------------------------------

function percentile(a: ArrayLike<number>, p: number) {
  if (!a.length) return 0
  const s = Float32Array.from(a).sort()
  return s[Math.min(s.length - 1, Math.floor(p * s.length))]
}

/** Mean of each step's frames. */
function stepMeans(env: Float32Array, resolution: number) {
  const out = new Float32Array(Math.floor(env.length / resolution))
  for (let s = 0; s < out.length; s++) {
    let m = 0
    for (let j = 0; j < resolution; j++) m += env[s * resolution + j]
    out[s] = m / resolution
  }
  return out
}

/** Loudest frame of each step. */
function stepPeaks(env: Float32Array, resolution: number) {
  const out = new Float32Array(Math.floor(env.length / resolution))
  for (let s = 0; s < out.length; s++)
    for (let j = 0; j < resolution; j++) out[s] = Math.max(out[s], env[s * resolution + j])
  return out
}

/** A part's loud level: ~98th percentile of the frames that aren't (near) silence. */
function loudLevel(rms: Float32Array) {
  let max = 0
  for (let i = 0; i < rms.length; i++) max = Math.max(max, rms[i])
  if (max <= 0) return 0
  return percentile(rms.filter((v) => v > max * 0.01), 0.98)
}

/** Runs of steps over the gate, [start, end); gaps shorter than a beat (4 steps) are closed. */
function runs(level: Float32Array): [number, number][] {
  const out: [number, number][] = []
  for (let s = 0; s < level.length; s++) {
    if (level[s] <= GATE) continue
    const last = out[out.length - 1]
    if (last && s - last[1] < 4) last[1] = s + 1
    else out.push([s, s + 1])
  }
  return out
}

const brightness = (hz: number) =>
  Math.min(1, Math.max(0, Math.log(hz / BRIGHT[0]) / Math.log(BRIGHT[1] / BRIGHT[0])))

function silentPart(steps: number, resolution: number): PartAnalysis {
  return { envelope: new Float32Array(steps * resolution), prominence: 0, brightness: 0, range: null, active: [] }
}

/**
 * The whole analysis from each part's raw loudness and centroids. Parts left
 * out are silent. `stemmed` = real stems (else estimates from the mix, which
 * are held further under the loudest part so a missing one stays quiet).
 */
export async function trackAnalysis(
  parts: Partial<Record<Stem, RawPart>>,
  notes: NoteEvent[],
  steps: number,
  stemmed: boolean,
  resolution = RESOLUTION,
): Promise<TrackAnalysis> {
  const breathe = breather()
  const loud = Object.fromEntries(STEMS.map((s) => [s, parts[s] ? loudLevel(parts[s]!.rms) : 0])) as Record<Stem, number>
  const loudest = Math.max(...Object.values(loud))
  const floor = Math.max(1e-4, loudest * (stemmed ? RELATIVE.stems : RELATIVE.mix))

  const stems = {} as Record<Stem, PartAnalysis>
  const presence = {} as Record<Stem, number>
  for (const stem of STEMS) {
    const raw = parts[stem]
    if (!raw || loudest <= 0) {
      stems[stem] = silentPart(steps, resolution)
      presence[stem] = 0
      continue
    }
    const ref = Math.max(loud[stem], floor)
    const envelope = new Float32Array(steps * resolution)
    for (let i = 0; i < envelope.length; i++) envelope[i] = Math.min(1, (raw.rms[i] ?? 0) / ref)
    const level = stepMeans(envelope, resolution)
    const active = runs(stepPeaks(envelope, resolution))

    let on = 0
    for (const [a, b] of active) on += b - a
    let sum = 0
    for (let i = 0; i < envelope.length; i++) sum += envelope[i]
    presence[stem] = (sum / Math.max(1, envelope.length)) * (on / Math.max(1, steps))

    let w = 0
    let bright = 0
    for (let s = 0; s < steps; s++) {
      if (level[s] <= GATE || !(raw.centroid[s] > 0)) continue
      w += level[s]
      bright += level[s] * brightness(raw.centroid[s])
    }

    let range: [number, number] | null = null
    if (stem !== 'drums') {
      for (const n of notes) {
        if (STEM_OF[n.voice] !== stem) continue
        range = range ? [Math.min(range[0], n.pitch), Math.max(range[1], n.pitch)] : [n.pitch, n.pitch]
      }
    }
    stems[stem] = { envelope, prominence: 0, brightness: w > 0 ? bright / w : 0, range, active }
    await breathe()
  }
  const top = Math.max(...Object.values(presence))
  for (const stem of STEMS) stems[stem].prominence = top > 0 ? presence[stem] / top : 0

  const bars = Math.ceil(steps / 16)
  const sections = findSections(stems, notes, bars, resolution)
  await breathe()
  const repeats = await findRepeats(stems, notes, bars, resolution, breathe)
  return { resolution, length: steps, stems, stemmed, sections, repeats }
}

/** Per bar: each stem's mean level, and each voice's note count over its busiest bar. */
function barFeatures(stems: Record<Stem, PartAnalysis>, notes: NoteEvent[], bars: number, resolution: number) {
  const frames = 16 * resolution
  const levels = STEMS.map((s) => {
    const env = stems[s].envelope
    return Float32Array.from({ length: bars }, (_, b) => {
      let m = 0
      const end = Math.min(env.length, (b + 1) * frames)
      for (let i = b * frames; i < end; i++) m += env[i]
      return m / frames
    })
  })
  const density = VOICES.map((v) => {
    const count = new Float32Array(bars)
    for (const n of notes) if (n.voice === v && n.step >= 0 && n.step < bars * 16) count[Math.floor(n.step / 16)]++
    const most = Math.max(...count, 1)
    return count.map((c) => c / most)
  })
  return { levels, density }
}

/** Bar-aligned section starts, in steps. */
export function findSections(stems: Record<Stem, PartAnalysis>, notes: NoteEvent[], bars: number, resolution = RESOLUTION) {
  const { levels, density } = barFeatures(stems, notes, bars, resolution)
  const minLength = bars <= 16 ? 2 : 4
  const ahead = Math.min(AHEAD, minLength)
  const avg = (a: Float32Array, from: number, to: number) => {
    let m = 0
    for (let i = from; i < to; i++) m += a[i]
    return m / Math.max(1, to - from)
  }
  // How much the next bars differ from the last few.
  const novelty = new Float32Array(bars)
  for (let b = 1; b < bars; b++) {
    const p0 = Math.max(0, b - PAST)
    const f1 = Math.min(bars, b + ahead)
    let d = 0
    for (const a of levels) {
      const past = avg(a, p0, b)
      const next = avg(a, b, f1)
      d += Math.abs(next - past)
      // A part coming in or dropping out counts extra.
      if (past > GATE / 2 !== next > GATE / 2) d += 0.2
    }
    for (const a of density) d += 0.5 * Math.abs(avg(a, b, f1) - avg(a, p0, b))
    novelty[b] = d
  }
  // Noisy estimates (a mix) change a little every bar: the bar is raised over
  // that (on tracks long enough for the usual change to be the median).
  const usual = bars > 16 ? percentile(novelty.subarray(1), 0.5) : 0
  const least = Math.max(NOVELTY, NOVELTY_OVER_MEDIAN * usual)
  const starts = [0]
  const candidates: number[] = []
  for (let b = minLength; b <= bars - minLength; b++)
    if (novelty[b] > least && novelty[b] >= novelty[b - 1] && novelty[b] >= (novelty[b + 1] ?? 0)) candidates.push(b)
  candidates.sort((a, b) => novelty[b] - novelty[a])
  for (const b of candidates) if (starts.every((s) => Math.abs(b - s) >= minLength)) starts.push(b)
  return starts.sort((a, b) => a - b).map((b) => b * 16)
}

/** Per bar, the earliest bar it repeats (itself if none). */
export async function findRepeats(
  stems: Record<Stem, PartAnalysis>,
  notes: NoteEvent[],
  bars: number,
  resolution = RESOLUTION,
  breathe: () => Promise<void> = breather(),
) {
  const frames = 16 * resolution
  // Each bar's notes per stem, as voice:step-in-bar:pitch.
  const keys = Array.from({ length: bars }, () => Object.fromEntries(STEMS.map((s) => [s, new Set<string>()])) as Record<Stem, Set<string>>)
  for (const n of notes) {
    const b = Math.floor(n.step / 16)
    if (b >= 0 && b < bars) keys[b][STEM_OF[n.voice]].add(`${n.voice}:${n.step % 16}:${n.pitch}`)
  }
  const bar = (s: Stem, b: number) => stems[s].envelope.subarray(b * frames, (b + 1) * frames)
  const loud = STEMS.map((s) => Float32Array.from({ length: bars }, (_, b) => {
    const e = bar(s, b)
    let m = 0
    for (let i = 0; i < e.length; i++) m += e[i]
    return m / frames
  }))

  const similarity = (b: number, c: number) => {
    let total = 0
    let count = 0
    STEMS.forEach((s, si) => {
      const kb = keys[b][s]
      const kc = keys[c][s]
      if (!kb.size && !kc.size && loud[si][b] < 0.05 && loud[si][c] < 0.05) return
      const eb = bar(s, b)
      const ec = bar(s, c)
      let diff = 0
      let both = 0
      for (let i = 0; i < eb.length; i++) {
        diff += Math.abs(eb[i] - ec[i])
        both += eb[i] + ec[i]
      }
      const shape = both > 0 ? 1 - diff / both : 1
      let sim = shape
      if (kb.size || kc.size) {
        let shared = 0
        for (const k of kb) if (kc.has(k)) shared++
        sim = 0.6 * (shared / (kb.size + kc.size - shared)) + 0.4 * shape
      }
      total += sim
      count++
    })
    return count ? total / count : 1
  }

  const out = new Int32Array(bars)
  for (let b = 0; b < bars; b++) {
    out[b] = b
    for (let c = 0; c < b; c++) {
      if (similarity(b, c) > REPEAT) {
        out[b] = c
        break
      }
    }
    await breathe()
  }
  return out
}

/** One line for the console. */
export function describe(a: TrackAnalysis) {
  let repeated = 0
  for (let b = 0; b < a.repeats.length; b++) if (a.repeats[b] !== b) repeated++
  const parts = STEMS.filter((s) => a.stems[s].prominence > 0)
    .map((s) => `${s} ${a.stems[s].prominence.toFixed(2)}`)
    .join(', ')
  return `${a.length / 16} bars, ${a.sections.length} sections, ${repeated} repeated bars (${parts}${a.stemmed ? '' : '; estimated from the mix'})`
}

/** Analyse isolated stems on a grid (stems, the demo). */
export async function analyseStems(
  byStem: Partial<Record<Stem, Float32Array>>,
  rate: number,
  grid: StepGrid,
  notes: NoteEvent[],
) {
  const parts: Partial<Record<Stem, RawPart>> = {}
  for (const s of STEMS) if (byStem[s]) parts[s] = await rawPart(byStem[s]!, rate, grid)
  return trackAnalysis(parts, notes, grid.steps, true)
}

/** Analyse a mix from offline.ts's per-part frames. */
export async function analyseMix(mix: MixFrames, grid: StepGrid, notes: NoteEvent[]) {
  const parts: Partial<Record<Stem, RawPart>> = {}
  for (const s of STEMS) parts[s] = await framedPart(mix.parts[s], mix, grid)
  return trackAnalysis(parts, notes, grid.steps, false)
}
