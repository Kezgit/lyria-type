import { STEMS, type Stem, type TrackAnalysis } from '../../audio/features'
import type { BarLayer, BarSpec } from '../../engine/barLayer'
import type { Composition } from './composition'
import type { SubMode, SubInstance } from './index'
import type { FrameContext } from '../types'

// Barcode: a song printed as one block of vertical lines in a square, after
// the barcode reference. A static generator: the picture changes only when the
// track or a setting does. Nothing is placed by hand or by chance: every mark
// is read from the analysed audio, so the same track always prints the same
// picture.
//   window    `span` bars (0 = the whole song) from the first section where
//             every stem plays, a bar, a section start, or the loudest
//             stretch; bands read only what is in the window
//   grid      the window is cut into `columns` slots, wrapped into
//             `systems`; each system has `rows` grid rows
//   slots     each slot sums up its stretch of the song: mean loudness per
//             stem (a repeated bar reads the bar it repeats, lighter: an
//             echo), any activity, the notes that overlap it, the loudest
//             drum hit per voice
//   bands     one per stem, high to low (vocals, instruments, drums, bass),
//             height on the row grid from √(the stem's prominence in the
//             window x how much it prints in that system); a quiet stem gets
//             one row, a silent one none
//   cells     each band is split into sub-rows (pitch registers; drum voices
//             hat / snare / kick); every slot x sub-row cell holds ONE line at
//             one of five weights: empty, hairline, medium, heavy, solid
//   weights   outside notes: the stem's loudness at a light step (hairline or
//             medium). Inside a note, in its register: medium to solid by
//             loudness. Drum hits: lines in their voice's sub-row (solid only
//             for strong kicks and snares at the loudest moments). Notes nest
//             as denser blocks in the band's lighter texture; loud passages
//             close up into solid bars
//   lines     the marks themselves, in ink: lines, or dots (one per cell,
//             sized by weight), or pills (a run of one weight in a sub-row
//             as one capsule; lone cells stay dots)
//   fields    the same marks blurred into colour: each sub-row's ink coverage
//             is sampled finely along time, blurred, and run through a Google
//             gradient, so the colour's flow IS the line rhythm (dense heavy
//             lines one end of the ramp, sparse hairlines the other, gaps the
//             page); drawn as thin segments ramping sample to sample, grainy
//   haze      (optional) the marks again, blurred together on screen under
//             the crisp ones; see drawHaze
//   layout    rows, or radial: time clockwise from 12 o'clock, bands as
//             concentric rings (vocals inside -> bass outside), each system a
//             further set of rings (the first outermost); cells are described
//             in (slot, depth) and a geometry places them either way
// The stems' envelopes come from the analysis, or are built from the notes
// until it lands.

/** Google ramps, light to dark: 50, 200, 500, 800, 1200. */
export const RAMPS = {
  blue: ['#bbe2ff', '#76bbff', '#3186ff', '#2051da', '#0f173a'],
  red: ['#ffdeec', '#ff7985', '#fc413d', '#be1c1b', '#3c0202'],
  yellow: ['#fdfd6d', '#ffe921', '#fec700', '#e57e00', '#652000'],
  green: ['#bff3b9', '#60d673', '#00af57', '#008052', '#002220'],
  grey: ['#e6eaf0', '#c4c7c5', '#45474d', '#2f3034', '#121317'],
}
export type Hue = keyof typeof RAMPS
/** Gradient rows: 0 = ink (white -> ink), one per hue, then the multi-hue row. */
const HUES = Object.keys(RAMPS) as Hue[]
export const ROW_INK = 0
export const rowOf = (h: Hue) => 1 + HUES.indexOf(h)
/** Hue per stem, and the order sections take hues in (fields, within hue). */
export const STEM_HUE: Record<Stem, Hue> = { vocals: 'blue', instruments: 'yellow', drums: 'red', bass: 'green' }
export const SECTION_HUES: Hue[] = ['blue', 'red', 'yellow', 'green']
/** One Google gradient across hues (fields, `across hues`): blue, purple, red, yellow, green. */
export const MULTI = ['#3186ff', '#7372fe', '#fc413d', '#fec700', '#00af57']
export const ROW_MULTI = 1 + HUES.length

/** Bands top to bottom: high to low. */
export const ORDER: Stem[] = ['vocals', 'instruments', 'drums', 'bass']
const DRUMS = ['hat', 'snare', 'kick'] as const
/** Bar instances the picture may use (the layer holds 4096); fields keep to fewer segments. */
const BUDGET = 4000
const FIELD_BUDGET = 3500

const clamp01 = (v: number) => Math.min(1, Math.max(0, v))
const mod = (a: number, n: number) => ((a % n) + n) % n

/** Linear 0..1 channel to an sRGB hex pair. */
const hex = (c: number) => {
  const s = c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055
  return Math.round(clamp01(s) * 255).toString(16).padStart(2, '0')
}

/** Line weights. */
export const EMPTY = 0, HAIR = 1, MEDIUM = 2, HEAVY = 3, SOLID = 4
/** Dot diameter per weight, as a share of the cell. */
const DOT = [0, 0.22, 0.45, 0.72, 1]

/** Haze: the marks again, blurred together on screen under the crisp ones (after Haze's field). Shared with Dots. */
export const hazeParams = {
  hazeBlur: { type: 'number', value: 0, min: 0, max: 160, step: 1, label: 'haze blur (px, 0 = off)' },
  hazeStretch: { type: 'number', value: 1, min: 1, max: 12, step: 0.1, label: 'haze stretch (along time)' },
  hazeMid: { type: 'number', value: 0.5, min: 0, max: 1, step: 0.01, label: 'haze near layer' },
  hazeGain: { type: 'number', value: 2, min: 0.5, max: 8, step: 0.05, label: 'haze strength' },
  hazeOpacity: { type: 'number', value: 1, min: 0, max: 1, step: 0.01, label: 'haze opacity' },
  hazeEdge: { type: 'number', value: 0, min: 0, max: 1, step: 0.01, label: 'haze edge (fog → pools)' },
  hazeFrom: {
    type: 'select', value: 'hair', label: 'haze from weight',
    options: { hairline: 'hair', medium: 'medium', heavy: 'heavy', solid: 'solid' },
  },
  hazeTint: {
    type: 'select', value: 'marks', label: 'haze colour',
    options: { 'as the marks': 'marks', 'stem hues': 'stems', 'section hues': 'sections' },
  },
  hazeTone: { type: 'number', value: 0.55, min: 0, max: 1, step: 0.01, label: 'haze tone (light → dark)' },
  crisp: { type: 'number', value: 1, min: 0, max: 1, step: 0.01, label: 'crisp marks' },
} as const
export const hazeKeys = Object.keys(hazeParams)

export const barcodeParams = {
  style: { type: 'select', value: 'lines', options: { lines: 'lines', fields: 'fields' } },
  arrangement: { type: 'select', value: 'rows', options: { rows: 'rows', radial: 'radial' } },
  hole: { type: 'number', value: 0.28, min: 0, max: 0.9, step: 0.01, label: 'radial hole' },

  anchor: {
    type: 'select', value: 'full', label: 'window from',
    options: { 'first full section': 'full', 'bar number': 'bars', 'section number': 'section', 'loudest stretch': 'loudest' },
  },
  from: { type: 'number', value: 0, min: 0, max: 256, step: 1, label: 'from (bar / section)' },
  span: { type: 'number', value: 16, min: 0, max: 128, step: 1, label: 'span (bars, 0 = all)' },

  columns: { type: 'number', value: 128, min: 32, max: 1024, step: 16, label: 'columns (in window)' },
  systems: { type: 'number', value: 2, min: 1, max: 8, step: 1 },
  margin: { type: 'number', value: 0.12, min: 0, max: 0.4, step: 0.005 },
  rows: { type: 'number', value: 12, min: 4, max: 40, step: 1, label: 'grid rows / system' },
  gap: { type: 'number', value: 0.5, min: 0, max: 4, step: 0.05, label: 'system gap (rows)' },
  bandGap: { type: 'number', value: 0.12, min: 0, max: 3, step: 0.01, label: 'band gap (rows)' },

  floor: { type: 'number', value: 0.12, min: 0, max: 0.95, step: 0.01, label: 'silence below' },
  gamma: { type: 'number', value: 1.4, min: 0.3, max: 4, step: 0.05, label: 'loudness contrast' },
  split: { type: 'number', value: 0.55, min: 0, max: 1, step: 0.01, label: 'hairline → medium at' },
  echo: { type: 'number', value: 0.3, min: 0, max: 1, step: 0.01, label: 'repeat echo' },
  drumSolid: { type: 'number', value: 0.85, min: 0, max: 1, step: 0.01, label: 'drums solid above' },
  minRun: { type: 'number', value: 2, min: 1, max: 32, step: 1, label: 'drop light runs under' },
  // Off: only notes and drum hits print; quiet stretches stay paper.
  texture: { type: 'boolean', value: true, label: 'loudness texture' },
  keep: {
    type: 'select', value: 'hair', label: 'lightest weight kept',
    options: { hairline: 'hair', medium: 'medium', heavy: 'heavy', solid: 'solid' },
  },

  marks: { type: 'select', value: 'lines', options: { lines: 'lines', dots: 'dots', pills: 'pills' } },
  dotSize: { type: 'number', value: 0.9, min: 0.1, max: 1.5, step: 0.01, label: 'dot size (of cell)' },
  hairline: { type: 'number', value: 1, min: 0.5, max: 4, step: 0.25, label: 'hairline (px)' },
  medium: { type: 'number', value: 0.3, min: 0.05, max: 1, step: 0.01, label: 'medium (of slot)' },
  heavy: { type: 'number', value: 0.6, min: 0.05, max: 1, step: 0.01, label: 'heavy (of slot)' },
  registers: { type: 'number', value: 3, min: 1, max: 6, step: 1, label: 'pitch registers' },
  grain: { type: 'number', value: 0.04, min: 0, max: 0.3, step: 0.005, label: 'ink grain' },
  paper: { type: 'number', value: 0.02, min: 0, max: 0.15, step: 0.005, label: 'paper grain' },

  palette: {
    type: 'select', value: 'stems', label: 'field palette',
    options: { stems: 'stems', sections: 'sections', 'mono blue': 'blue', 'mono red': 'red', 'mono yellow': 'yellow', 'mono green': 'green', 'mono grey': 'grey' },
  },
  blend: {
    type: 'select', value: 'across', label: 'field blend',
    // `within hue` keeps the brand rule (one hue's ramp per band); `across hues` runs one multi-hue Google gradient.
    options: { 'across hues (off-brand)': 'across', 'within hue (brand)': 'within' },
  },
  offset: { type: 'number', value: 0.2, min: 0, max: 1, step: 0.01, label: 'ramp offset per band' },
  blur: { type: 'number', value: 2.5, min: 0, max: 16, step: 0.1, label: 'blur (slots)' },
  gain: { type: 'number', value: 1, min: 0.2, max: 4, step: 0.05, label: 'density → colour' },
  fillGaps: { type: 'boolean', value: false, label: 'fill gaps' },
  segment: { type: 'number', value: 4, min: 1, max: 24, step: 0.5, label: 'segment (px)' },
  jitter: { type: 'number', value: 0.03, min: 0, max: 0.2, step: 0.005, label: 'colour jitter' },
  fieldMerge: { type: 'boolean', value: false, label: 'one field per band' },
  densGamma: { type: 'number', value: 1, min: 0.3, max: 4, step: 0.05, label: 'density gamma' },
  stagger: { type: 'boolean', value: false, label: 'stagger segments' },
  fieldGrain: { type: 'number', value: 0.3, min: 0, max: 0.8, step: 0.01, label: 'field grain' },
  top: { type: 'number', value: 0.95, min: 0.5, max: 1, step: 0.01, label: 'ramp top (percentile)' },
  cutoff: { type: 'number', value: 0.02, min: 0, max: 0.8, step: 0.01, label: 'drop fields below' },
  opaqueAt: { type: 'number', value: 0.12, min: 0.01, max: 1, step: 0.01, label: 'opaque at' },
  soft: { type: 'number', value: 0.75, min: 0, max: 12, step: 0.25, label: 'edge softness (px)' },

  ...hazeParams,
} as const

export const barcodeGroups = {
  Layout: ['style', 'arrangement', 'hole'],
  Window: ['anchor', 'from', 'span'],
  Page: ['columns', 'systems', 'margin', 'rows', 'gap', 'bandGap'],
  Weights: ['floor', 'gamma', 'split', 'echo', 'drumSolid', 'minRun', 'texture', 'keep'],
  Lines: ['marks', 'dotSize', 'hairline', 'medium', 'heavy', 'registers', 'grain', 'paper'],
  Fields: [
    'palette', 'blend', 'offset', 'blur', 'gain', 'densGamma', 'top', 'cutoff', 'opaqueAt', 'soft',
    'fillGaps', 'fieldMerge', 'stagger', 'segment', 'jitter', 'fieldGrain',
  ],
  Haze: hazeKeys,
}

/**
 * Until the audio analysis lands: a coarse one from the notes alone, each note
 * its velocity held over its length (drums: a quick decay), so the page already
 * reads like the music.
 */
function fromNotes(comp: Composition): TrackAnalysis {
  const res = 4
  const length = Math.max(16, comp.length)
  const env = Object.fromEntries(STEMS.map((s) => [s, new Float32Array(length * res)])) as Record<Stem, Float32Array>
  const pitches = Object.fromEntries(STEMS.map((s) => [s, [] as number[]])) as Record<Stem, number[]>
  for (const n of comp.notes) {
    const e = env[n.stem]
    const drum = n.stem === 'drums'
    const len = drum ? 1.5 : Math.max(0.25, n.length)
    if (!drum) pitches[n.stem].push(n.pitch)
    for (let f = Math.floor(n.step * res); f < Math.ceil((n.step + len) * res); f++) {
      const t = f / res - n.step
      const v = n.velocity * (drum ? Math.exp(-2.5 * t) : 1 - 0.4 * (t / len))
      const i = mod(f, e.length)
      if (v > e[i]) e[i] = v
    }
  }
  const sums = STEMS.map((s) => env[s].reduce((a, b) => a + b, 0))
  const most = Math.max(1e-6, ...sums)
  const bars = Math.ceil(length / 16)
  const stems = {} as TrackAnalysis['stems']
  STEMS.forEach((s, si) => {
    const e = env[s]
    const peak = e.reduce((a, b) => Math.max(a, b), 0)
    if (peak > 0) for (let i = 0; i < e.length; i++) e[i] /= peak
    const active: [number, number][] = []
    for (let st = 0; st < length; st++) {
      let on = false
      for (let f = 0; f < res; f++) on ||= e[st * res + f] > 0.02
      if (!on) continue
      const last = active[active.length - 1]
      if (last && last[1] === st) last[1] = st + 1
      else active.push([st, st + 1])
    }
    const ps = pitches[s]
    const mean = ps.length ? ps.reduce((a, b) => a + b, 0) / ps.length : 72
    stems[s] = {
      envelope: e,
      prominence: sums[si] / most,
      brightness: s === 'drums' ? 0.6 : clamp01((mean - 36) / 48),
      range: ps.length ? [Math.min(...ps), Math.max(...ps)] : null,
      active,
    }
  })
  // Sections where the set of playing stems changes; repeats where a bar's notes match an earlier bar's.
  const sig = (b: number) => comp.notes.filter((n) => Math.floor(n.step / 16) === b).map((n) => `${n.step % 16}${n.voice}${n.pitch}`).join()
  const sigs = Array.from({ length: bars }, (_, b) => sig(b))
  const repeats = new Int32Array(bars).map((_, b) => Math.max(0, sigs.indexOf(sigs[b])))
  const playing = (b: number) => STEMS.map((s) => (stems[s].active.some(([a, z]) => a < b * 16 + 16 && z > b * 16) ? 1 : 0)).join('')
  const sections = [0]
  for (let b = 1; b < bars; b++) if (playing(b) !== playing(b - 1)) sections.push(b * 16)
  return { resolution: res, length, stems, stemmed: false, sections, repeats }
}

/**
 * The window of the song to print, in steps [from, to): `from` bars in (or the
 * `from`-th section's start, or the loudest stretch of `span` bars), `span`
 * bars long (0 = to the end).
 */
function windowOf(comp: Composition, a: TrackAnalysis, p: Record<string, any>): [number, number] {
  const song = Math.max(1, comp.loop ?? a.length ?? comp.length)
  const bars = Math.max(1, Math.ceil(song / 16))
  const spanBars = Math.round(p.span) > 0 ? Math.min(bars, Math.round(p.span)) : 0
  let start = 0
  if (p.anchor === 'section') {
    const starts = a.sections.length ? a.sections : [0]
    start = Math.floor(starts[Math.min(starts.length - 1, Math.max(0, Math.round(p.from)))] / 16)
  } else if (p.anchor === 'full') {
    // The first section where every stem that matters is playing (within the window's span).
    const starts = a.sections.length ? a.sections : [0]
    const needed = STEMS.filter((st) => a.stems[st].prominence > 0.1)
    const len = spanBars ? spanBars * 16 : 16
    const full = starts.find((st) => needed.every((n) => a.stems[n].active.some(([x, z]) => x < st + len && z > st)))
    start = Math.floor((full ?? 0) / 16)
  } else if (p.anchor === 'loudest' && spanBars) {
    // The span-bar stretch with the most sound across all stems (the earliest, on a tie).
    const perBar = new Float64Array(bars)
    for (const stem of STEMS) {
      const { envelope: env } = a.stems[stem]
      for (let f = 0; f < env.length; f++) perBar[Math.min(bars - 1, Math.floor(f / a.resolution / 16))] += env[f]
    }
    let sum = 0, best = -1
    for (let b = 0; b < bars; b++) {
      sum += perBar[b] - (b >= spanBars ? perBar[b - spanBars] : 0)
      if (b >= spanBars - 1 && sum > best + 1e-9) { best = sum; start = b - spanBars + 1 }
    }
  } else start = Math.round(p.from)
  start = Math.min(bars - 1, Math.max(0, start)) * 16
  const end = spanBars ? Math.min(song, start + spanBars * 16) : song
  return [start, Math.max(start + 1, end)]
}


/** A mark's colour: a gradient row and its ramp, across time (`along`) or down the depth (t0 at depth y0). */
interface Paint { row: number; t0: number; t1: number; along: boolean; alpha?: number; stem?: number; lv?: number }
const INK: Paint = { row: ROW_INK, t0: 1, t1: 1, along: false }

/**
 * Where a cell goes. Marks are described in (slot, depth) space: x in slots
 * from the system's start, y in px from the band stack's start (the top in
 * rows, the inner edge in radial). A geometry turns that into bars.
 */
interface Geo {
  /** Px one slot spans at depth y. */
  slotPx(y: number): number
  /** A line w px wide centred on slot position x, depth y0..y1. */
  tick(x: number, w: number, y0: number, y1: number, c: Paint): void
  /** A dot (x0 = x1) or a pill from slot centre x0 to x1, d px thick, centred on depth y. */
  dot(x0: number, x1: number, y: number, d: number, c: Paint): void
  /** A block from slot x0 to x1, depth y0..y1. */
  box(x0: number, x1: number, y0: number, y1: number, c: Paint, feather: number): void
  /** Time wraps around (radial). */
  ring: boolean
}

/** One sub-row of one band, as fields need it: where it is and its cells' weights. */
interface FieldRow {
  geo: Geo; si: number; y0: number; y1: number; g0: number
  /** Sub-rows' weights per slot, each with its share of the field's height (one part unless merged). */
  parts: { levels: Uint8Array; w: number }[]
  /** Whether each edge meets another sub-row (overlapped) rather than the band's edge (crisp). */
  inner: [boolean, boolean]
}

/** Three box blurs ≈ a gaussian of `sigma` samples; wraps for a ring. */
function blur(src: Float32Array, sigma: number, ring: boolean): Float32Array {
  const n = src.length
  if (sigma < 0.5 || n < 2) return src
  const r = Math.max(1, Math.round((Math.sqrt(4 * sigma * sigma + 1) - 1) / 2))
  let a: Float32Array = src, b: Float32Array = new Float32Array(n)
  const at = (i: number) => (ring ? a[mod(i, n)] : a[Math.min(n - 1, Math.max(0, i))])
  for (let pass = 0; pass < 3; pass++) {
    let sum = 0
    for (let i = -r; i <= r; i++) sum += at(i)
    for (let i = 0; i < n; i++) {
      b[i] = sum / (2 * r + 1)
      sum += at(i + r + 1) - at(i - r)
    }
    ;[a, b] = [b, a]
  }
  return a
}

/** The window of the song as bars: `columns` slots wrapped into systems, as rows or rings in a centred square. */
function generate(comp: Composition, a: TrackAnalysis, columns: number, segPx: number, p: Record<string, any>, W: number, H: number): Marks {
  const marks: BarSpec[] = []
  // The stretch of song each mark stands for, in steps: [from, to) per mark.
  const times: number[] = []
  // And the band (index in ORDER) each comes from.
  const stems: number[] = []
  // And its weight (fields: solid).
  const weights: number[] = []
  let tA = 0, tB = 0, tS = 0, tW = SOLID
  const mark = (m: BarSpec) => {
    marks.push(m)
    times.push(tA, tB)
    stems.push(tS)
    weights.push(tW)
  }
  const [w0, w1] = windowOf(comp, a, p)
  const C = columns
  const S = Math.max(1, Math.round(p.systems))
  const perSys = Math.ceil(C / S)
  const U = Math.max(1, Math.round(p.rows))
  const side = Math.min(W, H) * (1 - 2 * p.margin)
  const radial = p.arrangement === 'radial'
  const fields = p.style === 'fields'
  const rMax = side / 2, rMin = rMax * p.hole
  const depth = radial ? rMax - rMin : side
  const unit = depth / (S * U + (S - 1) * p.gap)
  const sysPitch = unit * (U + p.gap)
  const res = a.resolution
  const R = Math.max(1, Math.round(p.registers))
  const regs = ORDER.map((s) => (s === 'drums' ? DRUMS.length : R))
  const stepsPer = (w1 - w0) / C
  const slotOf = (step: number) => Math.min(C - 1, Math.max(0, Math.floor((step - w0) / stepsPer)))
  const snap = Math.round
  let grain = p.grain

  const width = (level: number, px: number) =>
    level >= SOLID ? px : level === HEAVY ? Math.max(p.hairline, px * p.heavy) : level === MEDIUM ? Math.max(p.hairline, px * p.medium) : level === HAIR ? p.hairline : 0

  // Mean loudness per stem per slot; a repeated bar reads the bar it repeats, lighter.
  const loud = ORDER.map((stem) => {
    const part = a.stems[stem]
    const env = part.envelope
    const out = new Float32Array(C)
    const on = new Uint8Array(C)
    for (const [x, z] of part.active) if (z > w0 && x < w1) for (let g = slotOf(x); g <= slotOf(Math.max(x, z - 1e-3)); g++) on[g] = 1
    for (let g = 0; g < C; g++) {
      if (!on[g]) continue
      const f0 = Math.floor((w0 + g * stepsPer) * res), f1 = Math.max(f0 + 1, Math.ceil((w0 + (g + 1) * stepsPer) * res))
      let sum = 0, cnt = 0
      for (let f = f0; f < f1; f++) {
        const bar = Math.floor(f / res / 16)
        const src = a.repeats[bar] ?? bar
        const ff = f + (src - bar) * 16 * res
        if (ff < 0 || ff >= env.length) continue
        sum += env[ff] * (src !== bar ? 1 - p.echo : 1)
        cnt++
      }
      out[g] = cnt ? sum / cnt : 0
    }
    return out
  })
  // Prominence within the window: each stem's share of its loudness, relative to the loudest.
  const sums = loud.map((l) => l.reduce((x, y) => x + y, 0))
  const prominence = sums.map((x) => x / Math.max(1e-6, ...sums))
  /** 0..1 above the silence floor, contrast applied. */
  const strength = (v: number) => (v <= p.floor ? 0 : Math.pow(clamp01((v - p.floor) / (1 - p.floor)), p.gamma))

  // Cells: one weight per slot x sub-row. Outside notes, the envelope at a light step.
  const cells = ORDER.map((_, si) => {
    const c = new Uint8Array(C * regs[si])
    for (let g = 0; g < C; g++) {
      const v = loud[si][g]
      // Drums: hairline texture only, so their hits read as distinct lines.
      const lv = !p.texture || v <= p.floor ? EMPTY : strength(v) >= p.split && ORDER[si] !== 'drums' ? MEDIUM : HAIR
      c.fill(lv, g * regs[si], (g + 1) * regs[si])
    }
    return c
  })
  const raise = (si: number, g: number, r: number, lv: number) => {
    const i = g * regs[si] + r
    if (lv > cells[si][i]) cells[si][i] = lv
  }
  // Notes: medium to solid by loudness in their register; drum hits in their voice's sub-row.
  for (const n of comp.notes) {
    const si = ORDER.indexOf(n.stem)
    if (n.step >= w1 || n.step + Math.max(n.length, 0.5) <= w0) continue
    if (n.stem === 'drums') {
      if (n.step < w0) continue
      const r = DRUMS.indexOf(n.voice as (typeof DRUMS)[number])
      if (r < 0) continue
      // Kick heavy, snare heavy or medium, hats medium or hairline; solid only for the loudest kicks and snares.
      const g = slotOf(n.step)
      const strong = n.velocity > 0.6
      let lv = n.voice === 'kick' ? HEAVY : n.voice === 'snare' ? (strong ? HEAVY : MEDIUM) : strong ? MEDIUM : HAIR
      if (n.voice !== 'hat' && strong && strength(loud[si][g]) >= p.drumSolid) lv = SOLID
      raise(si, g, r, lv)
      continue
    }
    const range = a.stems[n.stem].range
    const lo = range ? range[0] : n.pitch, hi = range ? range[1] : n.pitch
    const r = R - 1 - Math.min(R - 1, Math.floor(((n.pitch - lo) / Math.max(1, hi - lo + 1)) * R))
    const g1 = Math.max(slotOf(n.step) + 1, Math.ceil((Math.min(w1, n.step + Math.max(n.length, 0.5)) - w0) / stepsPer))
    for (let g = slotOf(n.step); g < Math.min(C, g1); g++) raise(si, g, r, MEDIUM + Math.round(2 * strength(loud[si][g])))
  }

  // Drop every mark lighter than the lightest weight kept.
  const keep = { hair: HAIR, medium: MEDIUM, heavy: HEAVY, solid: SOLID }[p.keep as string] ?? HAIR
  if (keep > HAIR) for (const c of cells) for (let i = 0; i < c.length; i++) if (c[i] < keep) c[i] = EMPTY

  // Drop short runs of light marks (within a system), so nothing floats alone.
  ORDER.forEach((_, si) => {
    const n = regs[si], c = cells[si]
    const colMax = (g: number) => {
      let m = 0
      for (let r = 0; r < n; r++) m = Math.max(m, c[g * n + r])
      return m
    }
    for (let s = 0; s < S; s++) {
      const end = Math.min(C, (s + 1) * perSys)
      let g = s * perSys
      while (g < end) {
        if (!colMax(g)) { g++; continue }
        let g1 = g, peak = 0
        while (g1 < end && colMax(g1)) peak = Math.max(peak, colMax(g1++))
        if (g1 - g < p.minRun && peak <= MEDIUM) c.fill(EMPTY, g * n, g1 * n)
        g = g1
      }
    }
  })

  // Section index per slot (song-wide, so a section keeps its colour when zoomed).
  const sectionOf = new Int32Array(C)
  {
    const starts = a.sections.length ? a.sections : [0]
    starts.forEach((st, i) => {
      const next = i + 1 < starts.length ? starts[i + 1] : Infinity
      if (st >= w1 || next <= w0) return
      sectionOf.fill(i, slotOf(st), next >= w1 ? C : slotOf(next))
    })
  }

  /** Bars in rows: a rect, turned a quarter when its ramp runs down the depth. */
  const rect = (X0: number, X1: number, yT: number, yB: number, c: Paint, f: number) => {
    if (f < 0.5) {
      X0 = snap(X0); X1 = Math.max(X0 + 1, snap(X1)); yT = snap(yT); yB = Math.min(yT - 1, snap(yB))
    }
    const w = X1 - X0, h = yT - yB, base = { x: (X0 + X1) / 2, y: (yT + yB) / 2, row: c.row, alpha: c.alpha ?? 1, feather: f, grain }
    // Turned a quarter, the bar's gradient runs bottom (t0) to top (t1).
    if (!c.along && c.t0 !== c.t1) mark({ ...base, w: h, h: w, rotation: Math.PI / 2, t0: c.t1, t1: c.t0 })
    else mark({ ...base, w, h, t0: c.t0, t1: c.t1 })
  }
  /** Slots x0..x1 of system s, as steps of the song (for the next mark). */
  const when = (s: number, x0: number, x1: number, c: Paint) => {
    tS = c.stem ?? 0
    tW = c.lv ?? SOLID
    tA = w0 + (s * perSys + x0) * stepsPer
    tB = w0 + (s * perSys + x1) * stepsPer
  }
  const rowsGeo = (s: number): Geo => {
    const left = -side / 2, sysTop = side / 2 - s * sysPitch, slotW = side / perSys
    return {
      ring: false,
      slotPx: () => slotW,
      tick(x, w, y0, y1, c) {
        when(s, x - 0.5, x + 0.5, c)
        rect(left + x * slotW - w / 2, left + x * slotW + w / 2, sysTop - y0, sysTop - y1, c, 0.3)
      },
      dot(x0, x1, y, d, c) {
        when(s, x0 - 0.5, x1 + 0.5, c)
        const yy = sysTop - y
        mark({ x: left + ((x0 + x1) / 2) * slotW, y: yy, w: (x1 - x0) * slotW + d, h: d, radius: d / 2, t0: c.t0, t1: c.t1, row: c.row, alpha: c.alpha ?? 1, feather: 0.6, grain })
      },
      box(x0, x1, y0, y1, c, f) {
        when(s, x0, x1, c)
        rect(left + x0 * slotW, left + x1 * slotW, sysTop - y0, sysTop - y1, c, f)
      },
    }
  }
  // Radial: time runs clockwise from 12 o'clock, depth outward; the first system is the outermost set of rings.
  const TAU = Math.PI * 2
  const radialGeo = (s: number): Geo => {
    const rin = rMin + (S - 1 - s) * sysPitch
    const ang = (x: number) => (TAU * x) / perSys
    const slotPx = (y: number) => (TAU * (rin + y)) / perSys
    return {
      ring: true,
      slotPx,
      // A tick along the radius; its ramp runs inner (t0) to outer (t1).
      tick(x, w, y0, y1, c) {
        const th = ang(x), r = rin + (y0 + y1) / 2
        when(s, x - 0.5, x + 0.5, c)
        mark({ x: r * Math.sin(th), y: r * Math.cos(th), w: y1 - y0, h: w, rotation: Math.PI / 2 - th, t0: c.t0, t1: c.t1, row: c.row, alpha: c.alpha ?? 1, feather: 0.3, grain })
      },
      // A pill along the tangent at its middle (short enough to read as part of the ring).
      dot(x0, x1, y, d, c) {
        const th = ang((x0 + x1) / 2), r = rin + y
        when(s, x0 - 0.5, x1 + 0.5, c)
        mark({ x: r * Math.sin(th), y: r * Math.cos(th), w: (x1 - x0) * slotPx(y) + d, h: d, radius: d / 2, rotation: -th, t0: c.t0, t1: c.t1, row: c.row, alpha: c.alpha ?? 1, feather: 0.6, grain })
      },
      // An arc of short bars, each along the tangent (time ramps) or the radius (depth ramps).
      box(x0, x1, y0, y1, c, f) {
        const r0 = rin + y0, r1 = rin + y1, rm = (r0 + r1) / 2
        const per = (TAU * r1) / perSys
        const n = Math.max(1, Math.ceil(((x1 - x0) * per) / segPx))
        const lap = n > 1 ? 2 * Math.max(f, 0.5) : 0
        for (let i = 0; i < n; i++) {
          const xa = x0 + ((x1 - x0) * i) / n, xb = x0 + ((x1 - x0) * (i + 1)) / n
          const th = ang((xa + xb) / 2), len = (xb - xa) * per + lap
          when(s, xa, xb, c)
          const base = { x: rm * Math.sin(th), y: rm * Math.cos(th), row: c.row, alpha: c.alpha ?? 1, feather: f, grain }
          if (c.along) {
            const ta = c.t0 + ((c.t1 - c.t0) * i) / n, tb = c.t0 + ((c.t1 - c.t0) * (i + 1)) / n
            mark({ ...base, w: len, h: r1 - r0, rotation: -th, t0: ta, t1: tb })
          } else mark({ ...base, w: r1 - r0, h: len, rotation: Math.PI / 2 - th, t0: c.t0, t1: c.t1 })
        }
      },
    }
  }

  const fieldRows: FieldRow[] = []

  for (let s = 0; s < S; s++) {
    const g0 = s * perSys, gEnd = Math.min(C, g0 + perSys)
    if (g0 >= C) break
    const geo = radial ? radialGeo(s) : rowsGeo(s)

    // Band heights on the row grid: √prominence x √(how much the stem prints here); quiet stems get one row.
    const ink = cells.map((c, si) => {
      let sum = 0
      for (let i = g0 * regs[si]; i < gEnd * regs[si]; i++) sum += c[i]
      return sum / regs[si]
    })
    const most = Math.max(1e-6, ...ink)
    const want = ORDER.map((_, si) => (ink[si] > 0 ? Math.sqrt(prominence[si] * (ink[si] / most)) + 1e-6 : 0))
    const present = want.filter((w) => w > 0).length
    if (!present) continue
    const total = want.reduce((x, y) => x + y, 0)
    const spare = Math.max(0, U - present)
    const share = want.map((w) => (w > 0 ? (w / total) * spare : 0))
    const units = share.map((x, i) => (want[i] > 0 ? 1 + Math.floor(x) : 0))
    let extra = U - units.reduce((x, y) => x + y, 0)
    const order = share.map((x, i) => ({ i, r: want[i] > 0 ? x - Math.floor(x) : -1 })).sort((x, y) => y.r - x.r || x.i - y.i)
    for (let j = 0; extra > 0 && j < order.length; j++) {
      if (order[j].r < 0) continue
      units[order[j].i]++
      extra--
    }

    let row = 0
    ORDER.forEach((_, si) => {
      const u = units[si]
      if (!u) return
      const gap = p.bandGap * unit
      const bT = row * unit + (row ? gap / 2 : 0)
      const bB = (row + u) * unit - (row + u < U ? gap / 2 : 0)
      row += u
      // Sub-rows on the grid: as many as the band has rows for, registers merged by max.
      const n = regs[si], sub = Math.max(1, Math.min(n, u))
      const edge = (i: number) => bT + (Math.round((u * i) / sub) / u) * (bB - bT)
      const lvOf = (gg: number, q: number) => {
        let m = 0
        for (let r = Math.floor((q * n) / sub); r < Math.floor(((q + 1) * n) / sub); r++) m = Math.max(m, cells[si][gg * n + r])
        return m
      }

      if (fields) {
        // Keep each sub-row's weights; fields are drawn once every row is known (to share the segment budget).
        const parts = Array.from({ length: sub }, (_, j) => {
          const levels = new Uint8Array(gEnd - g0)
          for (let gg = g0; gg < gEnd; gg++) levels[gg - g0] = lvOf(gg, j)
          return { levels, w: (edge(j + 1) - edge(j)) / Math.max(1e-6, edge(sub) - edge(0)) }
        })
        // Merged: one field per band, its coverage the height-weighted sum of its sub-rows'.
        if (p.fieldMerge) fieldRows.push({ geo, si, y0: edge(0), y1: edge(sub), g0, parts, inner: [false, false] })
        else parts.forEach((part, j) => fieldRows.push({ geo, si, y0: edge(j), y1: edge(j + 1), g0, parts: [{ ...part, w: 1 }], inner: [j > 0, j < sub - 1] }))
        return
      }

      // Dots, in ink: one per cell, sized by weight. Pills: a run of one weight (medium or more) in a sub-row as one capsule.
      if (p.marks !== 'lines') {
        for (let j = 0; j < sub; j++) {
          const y = (edge(j) + edge(j + 1)) / 2, cellH = edge(j + 1) - edge(j)
          let gg = g0
          while (gg < gEnd) {
            const lv = lvOf(gg, j)
            let g1 = gg + 1
            if (p.marks === 'pills' && lv >= MEDIUM) while (g1 < gEnd && lvOf(g1, j) === lv) g1++
            if (lv > EMPTY) {
              const d = DOT[lv] * p.dotSize * Math.min(geo.slotPx(y), cellH)
              geo.dot(gg - g0 + 0.5, g1 - 1 - g0 + 0.5, y, Math.max(1, d), { ...INK, stem: si, lv })
            }
            gg = g1
          }
        }
        return
      }

      // Lines, in ink. Solids merge across slots while their extent matches.
      const open = new Map<string, number>()
      const close = (key: string, gg: number) => {
        const o = open.get(key)
        if (o === undefined) return
        const [yT, yB] = key.split(':').map(Number)
        geo.box(o - g0, gg - g0, yT, yB, { ...INK, stem: si }, 0.3)
        open.delete(key)
      }
      for (let gg = g0; gg < gEnd; gg++) {
        const seen = new Set<string>()
        let j = 0
        while (j < sub) {
          const lv = lvOf(gg, j)
          let j1 = j + 1
          while (j1 < sub && lvOf(gg, j1) === lv) j1++
          const yT = edge(j), yB = edge(j1)
          if (lv === SOLID) {
            const key = `${yT}:${yB}`
            seen.add(key)
            if (!open.has(key)) open.set(key, gg)
          } else if (lv > EMPTY) {
            geo.tick(gg - g0 + 0.5, width(lv, geo.slotPx((yT + yB) / 2)), yT, yB, { ...INK, stem: si, lv })
          }
          j = j1
        }
        for (const key of [...open.keys()]) if (!seen.has(key)) close(key, gg)
      }
      for (const key of [...open.keys()]) close(key, gEnd)
    })
  }

  if (fields) drawFields(fieldRows, p, width, sectionOf, (g) => (grain = g), (px) => (segPx = px))
  return { marks, times, stems, weights, window: [w0, w1], sections: a.sections.length ? a.sections : [0] }
}

/**
 * Fields: the lines blurred into colour. Each sub-row's line ink is rasterised
 * along time (~1.5 px samples), blurred, and the density run through the
 * palette; drawn as thin segments that ramp sample to sample.
 */
function drawFields(
  rows: FieldRow[], p: Record<string, any>, width: (lv: number, px: number) => number, sectionOf: Int32Array,
  setGrain: (g: number) => void, setSegPx: (px: number) => void,
) {
  setGrain(p.fieldGrain)
  // Segment width: the asked-for px, widened until every row fits the budget.
  const lengthPx = rows.reduce((x, r) => x + r.parts[0].levels.length * r.geo.slotPx((r.y0 + r.y1) / 2), 0)
  const segW = Math.max(p.segment, lengthPx / FIELD_BUDGET)
  // Radial arcs: one bar per segment (they are short enough to read as a curve).
  setSegPx(segW * 4)
  const within = p.blend === 'within'
  const palette: string = p.palette
  const mono = palette !== 'stems' && palette !== 'sections'
  const f = p.soft

  // Pass 1: each row's line ink, rasterised and blurred.
  const dense = rows.map(({ geo, y0, y1, parts }) => {
    const m = parts[0].levels.length
    const slotPx = geo.slotPx((y0 + y1) / 2)
    const q = Math.max(2, Math.min(24, Math.round(slotPx / 1.5)))
    const N = m * q
    // Line ink per sample: the share of the sample each line covers.
    const cov = new Float32Array(N)
    for (const { levels, w } of parts) {
      for (let k = 0; k < m; k++) {
        const lv = levels[k]
        if (!lv) continue
        const frac = lv >= SOLID ? 1 : Math.min(1, width(lv, slotPx) / slotPx)
        const c = (k + 0.5) * q, half = (frac * q) / 2
        for (let i = Math.floor(c - half); i < Math.ceil(c + half); i++) {
          if (i < 0 || i >= N) continue
          cov[i] += w * Math.max(0, Math.min(i + 1, c + half) - Math.max(i, c - half))
        }
      }
    }
    return { slotPx, q, N, dens: blur(cov, p.blur * q, geo.ring) }
  })
  // The densest the window gets (95th percentile of inked samples) sets the top of the ramp, so every track uses all of it.
  const inked: number[] = []
  for (const { dens } of dense) for (let i = 0; i < dens.length; i += 4) if (dens[i] > 0.01) inked.push(dens[i])
  inked.sort((x, y) => x - y)
  const top = Math.max(0.05, inked.length ? inked[Math.min(inked.length - 1, Math.floor(inked.length * p.top))] : 1)
  const level = (d: number) => clamp01((d / top) * p.gain)

  // Pass 2: segments.
  rows.forEach(({ geo, si, y0: ya, y1: yb, g0, parts, inner }, ri) => {
    const { slotPx, q, N, dens } = dense[ri]
    const m = parts[0].levels.length
    if (!dens.some((d) => d > 0.01)) return
    // Sub-rows overlap their neighbours by the feather so they meet without a seam; band edges stay crisp.
    const y0 = ya - (inner[0] ? f : 0), y1 = yb + (inner[1] ? f : 0)

    /** Row and ramp position for sample i. */
    const paint = (i: number): [number, number] => {
      // Density gamma > 1 keeps most of the area at the low (blue) end; only dense stretches go warm.
      const v = Math.pow(level(dens[Math.min(N - 1, i)]), p.densGamma)
      const sec = sectionOf[g0 + Math.min(m - 1, Math.floor(i / q))]
      if (mono) return [rowOf(palette as Hue), 0.1 + 0.9 * v]
      if (within) return [rowOf(palette === 'sections' ? SECTION_HUES[sec % SECTION_HUES.length] : STEM_HUE[ORDER[si]]), 0.1 + 0.9 * v]
      // Across hues: one multi-hue row, offset per band (or per section); the shader mirrors past 1.
      return [ROW_MULTI, v + p.offset * (palette === 'sections' ? sec : si)]
    }
    const step = Math.max(1, Math.ceil((segW / slotPx) * q))
    // Staggered: each band's segments start at a different phase, so transitions don't line up across bands.
    let i = 0
    let first = p.stagger ? Math.max(1, Math.round((step * (si + 1)) / (ORDER.length + 1))) : step
    while (i < N) {
      let b = Math.min(N, i + first)
      first = step
      const [rowA] = paint(i)
      // A segment never spans a change of colour row (a section boundary, within hue).
      for (let k = i + 1; k < b; k++) if (paint(k)[0] !== rowA) { b = k; break }
      let peak = 0, mean = 0
      for (let k = i; k < b; k++) {
        peak = Math.max(peak, dens[k])
        mean += dens[k]
      }
      mean /= b - i
      if (p.fillGaps || level(peak) > p.cutoff) {
        // Fade into the page where the lines thin out (unless gaps are filled).
        const alpha = p.fillGaps ? 1 : clamp01(level(mean) / p.opaqueAt)
        // A slight deterministic colour jitter from the density itself (a dithered print).
        const jit = (((mean * 9173.7) % 1) - 0.5) * p.jitter
        const ta = paint(i)[1] + jit, tb = paint(b)[1] + jit
        const ext = f / slotPx
        geo.box(i / q - ext, b / q + ext, y0, y1, { row: rowA, t0: ta, t1: tb, along: true, alpha, stem: si }, f)
      }
      i = b
    }
  })
}

/** A generated picture: its marks, each one's stretch of song ([from, to) steps, two per mark), and the window. */
export interface Marks {
  marks: BarSpec[]
  times: number[]
  /** Per mark: its band, as an index into ORDER. */
  stems: number[]
  /** Per mark: its weight (HAIR..SOLID; fields are SOLID). */
  weights: number[]
  window: [number, number]
  /** Section starts, in steps. */
  sections: number[]
}

/** The gradient rows Barcode's marks paint with, on any bar layer. */
export function barcodeGradients(bars: BarLayer, ink: FrameContext['ink']) {
  bars.setGradient(['#ffffff', `#${ink.map(hex).join('')}`], ROW_INK)
  for (const h of HUES) bars.setGradient(RAMPS[h], rowOf(h))
  bars.setGradient(MULTI, ROW_MULTI)
}

/**
 * Barcode's picture for the current track and settings, regenerated only when
 * either changes (or the viewport does); null before there is any music.
 */
export function barcodeBuilder() {
  let out: Marks | null = null
  let key = ''
  let guess: TrackAnalysis | null = null
  let guessFor = -1
  let warned = ''

  return (comp: Composition, p: Record<string, any>, W: number, H: number): Marks | null => {
    if (!comp.notes.length && !comp.analysis) return null
    let a = comp.analysis
    if (!a) {
      if (guessFor !== comp.version) {
        guess = fromNotes(comp)
        guessFor = comp.version
      }
      a = guess!
    }
    const k = `${comp.version}:${W}x${H}:${JSON.stringify(p)}`
    if (k !== key || !out) {
      key = k
      // Fit the bar layer: first longer arc segments (radial lines), then fewer columns.
      let columns = Math.max(8, Math.round(p.columns))
      let segPx = 8
      out = generate(comp, a, columns, segPx, p, W, H)
      while (out.marks.length > BUDGET && columns > 8) {
        if (p.arrangement === 'radial' && p.style !== 'fields' && segPx < 32) segPx *= 1.5
        else columns = Math.max(8, Math.floor(columns * 0.8))
        out = generate(comp, a, columns, segPx, p, W, H)
      }
      if (columns !== Math.round(p.columns) && warned !== k) {
        warned = k
        console.info(`Barcode: ${Math.round(p.columns)} columns needs more than ${BUDGET} bars; drawing ${columns}.`)
      }
      // Each mark knows its stem (for colouring and weighting by sound downstream).
      const marks = out
      marks.marks.forEach((m, i) => (m.stem = marks.stems[i]))
    }
    return out
  }
}

/** Section index (into `sections`) of the stretch of song starting at step t. */
export const sectionAt = (sections: number[], t: number) => {
  let i = 0
  while (i + 1 < sections.length && sections[i + 1] <= t) i++
  return i
}

/**
 * Haze: the marks again in two blurred layers under the crisp ones, as in
 * Haze's field: a near layer (a third of the radius) and a far one, each
 * blurred as one image so neighbouring lines and bands bleed into each other;
 * the gain pushes the thinned coverage back up into soft masses. Stretch
 * reaches further along time than across the bands. The haze can keep the
 * marks' colours or repaint them in their stem's (or section's) hue, so ink
 * lines sit on colour like Haze's letters on their blobs.
 */
export interface HazeSource {
  marks: BarSpec[]
  /** Per mark: its band (index into ORDER) and weight (EMPTY..SOLID). */
  stems: number[]
  weights: number[]
  /** Section index of mark i. */
  section(i: number): number
}

export function drawHaze(layers: FrameContext['layers'], out: HazeSource, p: Record<string, any>, ink: FrameContext['ink']) {
  const near = clamp01(p.hazeMid)
  const tone = clamp01(p.hazeTone)
  const tint = p.hazeTint as string
  const from = { hair: HAIR, medium: MEDIUM, heavy: HEAVY, solid: SOLID }[p.hazeFrom as string] ?? HAIR
  const set = [
    { layer: layers.barsFar, radius: p.hazeBlur, gain: p.hazeGain, opacity: p.hazeOpacity },
    { layer: layers.barsMid, radius: p.hazeBlur * 0.3, gain: 1 + (p.hazeGain - 1) * 0.4, opacity: p.hazeOpacity * near },
  ]
  for (const { layer, radius, gain, opacity } of set) {
    if (opacity <= 0.001) continue
    layer.radius = radius
    layer.stretch = p.hazeStretch
    layer.gain.value = gain
    layer.opacity.value = opacity
    layer.edge.value = clamp01(p.hazeEdge)
    layer.bars.blend = 'normal'
    barcodeGradients(layer.bars, ink)
    out.marks.forEach((m, i) => {
      if (out.weights[i] < from) return
      if (tint === 'marks') return layer.bars.push({ ...m, grain: 0 })
      const hue = tint === 'sections' ? SECTION_HUES[out.section(i) % SECTION_HUES.length] : STEM_HUE[ORDER[out.stems[i]]]
      layer.bars.push({ ...m, row: rowOf(hue), t0: tone, t1: tone, grain: 0 })
    })
  }
}

function create(): SubInstance {
  const build = barcodeBuilder()
  return {
    update({ layers, viewport, ink }, comp, p) {
      const bars = layers.bars
      // Opaque marks; field segments overlap only by their feather.
      bars.blend = 'normal'
      barcodeGradients(bars, ink)
      layers.grain.value = p.paper
      const out = build(comp, p, viewport.width, viewport.height)
      if (!out) return
      if (p.hazeBlur > 0) drawHaze(layers, { ...out, section: (i) => sectionAt(out.sections, out.times[2 * i]) }, p, ink)
      const crisp = clamp01(p.crisp)
      if (crisp > 0.001) for (const m of out.marks) bars.push(crisp < 1 ? { ...m, alpha: (m.alpha ?? 1) * crisp } : m)
    },
  }
}

const PAGE = { background: '#f4f5f7', ink: '#121317' }
const WHITE = { background: '#ffffff', ink: '#121317' }
const FIELDS = { style: 'fields', paper: 0.08 }
/** Sparse multi-hue fields (notes and hits only) for the haze to blur: gaps let the masses separate. */
const HAZE_FIELDS = {
  ...FIELDS, palette: 'stems', blend: 'across', offset: 0.12, densGamma: 1.5, blur: 1.5, columns: 192, bandGap: 0.6, gap: 1.5,
  texture: false, keep: 'medium', cutoff: 0.12, opaqueAt: 0.35, paper: 0.1,
}

export const barcode: SubMode = {
  id: 'barcode',
  label: 'Barcode',
  params: barcodeParams,
  groups: barcodeGroups,
  presets: {
    // 16 bars from the first section where every stem plays, 128 columns, in ink.
    Default: { params: {}, ...PAGE },
    // The whole song as an overview.
    'Whole song': { params: { anchor: 'bars', from: 0, span: 0, columns: 256 }, ...PAGE },
    // Close up: the loudest 8 bars of the song, sampled finely.
    'Close-up': { params: { anchor: 'loudest', span: 8, columns: 256, systems: 2, registers: 4 }, ...PAGE },
    // The window as rings of ticks, time clockwise from 12 o'clock.
    Radial: { params: { arrangement: 'radial', systems: 1, columns: 192 }, ...PAGE },
    // The lines blurred into one multi-hue Google gradient, each band offset along it.
    Fields: { params: { ...FIELDS, palette: 'stems', blend: 'across' }, ...WHITE },
    // Brand-safe: each band in its own hue's ramp, 50 -> 1200 with line density.
    'Fields · brand': { params: { ...FIELDS, palette: 'stems', blend: 'within' }, ...WHITE },
    // The whole song's form: each section further along the multi-hue gradient.
    'Fields · sections': { params: { ...FIELDS, palette: 'sections', blend: 'across', offset: 0.25, anchor: 'bars', span: 0, columns: 256, blur: 1.5 }, ...WHITE },
    // Softer, after the reference: one field per band, butted together (no gaps), long blur,
    // a blue/violet ground warming only where the lines are dense, heavier grain.
    'Fields · soft': {
      params: {
        ...FIELDS, palette: 'stems', blend: 'across', offset: 0, fieldMerge: true, blur: 6, densGamma: 1.8, fillGaps: true,
        bandGap: 0, gap: 0, stagger: true, fieldGrain: 0.45, jitter: 0.05, paper: 0.1,
      },
      ...WHITE,
    },
    // Sparse, after the score reference: only notes and hits print, each run a soft block on white,
    // pale to navy by weight; quiet stretches stay paper.
    'Fields · sparse': {
      params: {
        ...FIELDS, palette: 'blue', blend: 'within', span: 8, columns: 256, systems: 2, rows: 12, gap: 1.5, bandGap: 0.5,
        texture: false, keep: 'medium', medium: 0.08, blur: 0.6, densGamma: 1.4, cutoff: 0.12, opaqueAt: 0.35, soft: 2.5,
        segment: 3, fieldGrain: 0.15, paper: 0.05,
      },
      ...WHITE,
    },
    // After Haze: ink lines over a soft field of their stems' hues, blurred together on screen.
    'Haze lines': {
      params: {
        hazeBlur: 44, hazeMid: 0.35, hazeGain: 2.4, hazeTint: 'stems', hazeTone: 0.35, crisp: 0.45, paper: 0.06,
      },
      ...WHITE,
    },
    // The fields melted into each other: only notes and hits print, so each band blurs into soft masses on white.
    'Haze fields': {
      params: { ...HAZE_FIELDS, hazeBlur: 30, hazeMid: 0.3, hazeGain: 1.5, crisp: 0 },
      ...WHITE,
    },
    // Smeared along time: light trails, the band rhythm still legible top to bottom.
    'Haze drift': {
      params: { ...HAZE_FIELDS, hazeBlur: 8, hazeStretch: 8, hazeMid: 0.5, hazeGain: 1.5, crisp: 0 },
      ...WHITE,
    },
    // Each cell a dot, sized by its weight.
    Dots: { params: { marks: 'dots', columns: 72 }, ...PAGE },
    // Fine ink dust; only notes and hits throw a soft haze in their stem's hue.
    'Haze dust': {
      params: {
        marks: 'dots', columns: 80, dotSize: 0.8, crisp: 0.85,
        hazeBlur: 12, hazeMid: 0.6, hazeGain: 2.4, hazeTint: 'stems', hazeTone: 0.4, hazeFrom: 'medium', paper: 0.06,
      },
      ...WHITE,
    },
    // Pills whose haze pools: close marks join into clean-edged forms, lone ones stay apart.
    'Haze pools': {
      params: {
        marks: 'pills', columns: 64, crisp: 0.5,
        hazeBlur: 20, hazeMid: 0, hazeGain: 2.6, hazeEdge: 0.8, hazeTint: 'stems', hazeTone: 0.5, hazeFrom: 'medium', paper: 0.06,
      },
      ...WHITE,
    },
    // Pills trailing their haze along time.
    'Haze drift dots': {
      params: {
        marks: 'pills', columns: 64, crisp: 0.7,
        hazeBlur: 6, hazeStretch: 6, hazeMid: 0.4, hazeGain: 1.8, hazeTint: 'stems', hazeTone: 0.4, hazeFrom: 'medium', paper: 0.06,
      },
      ...WHITE,
    },
    // Rings of blurred lines.
    'Radial fields': { params: { ...FIELDS, arrangement: 'radial', systems: 1, columns: 192, palette: 'stems', blend: 'across' }, ...WHITE },
  },
  create,
}
