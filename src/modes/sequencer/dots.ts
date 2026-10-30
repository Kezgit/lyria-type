import { STEMS, type Stem, type TrackAnalysis } from '../../audio/features'
import type { BarSpec } from '../../engine/barLayer'
import type { BlobSpec } from '../../engine/blobLayer'
import { BLOB_FORMS, BLOB_GRADIENTS } from '../../engine/blobLayer'
import type { CompNote, Composition } from './composition'
import type { SubMode, SubInstance } from './index'
import { MOTIONS, motionKeys, motionOf, motionParams, motionValues } from './motions'
import { applyMove, type DotMotionInstance, type MarkInfo, type MarkMove, type MotionFrame } from './motions/types'
import { PALETTES, paletteOf, paletteRow } from './palettes'
import { LEDGER_PALETTES, LEDGER_TINT } from './ledger'
import { dotShapeKeys, dotShapeParams, shapeDot, shapesDots } from '../shared/dotShape'
import {
  HAIR, HEAVY, MEDIUM, ORDER, ROW_INK, ROW_MULTI, SECTION_HUES, SOLID, barcodeGradients, drawHaze, hazeKeys, hazeParams,
  rowOf, sectionAt, type Hue,
} from './barcode'

// Dots: the song falling through a dot matrix, after the dot-grid reference.
// A static generator like Barcode: the picture changes only when the track or
// a setting does, and every mark is read from the analysed audio.
//   window    `span` bars (0 = the whole song) from the first section where
//             every stem plays, a bar, a section start, or the loudest stretch
//   grid      time runs DOWN the page: the window is cut into `rows` slots per
//             system, systems side by side; ACROSS are lanes, one column each:
//             drums (kick, snare, hat), then bass, instruments, vocals, each
//             spread low -> high over its pitch range; `groupGap` blank lanes
//             between parts (default none: the grid stays continuous and parts
//             read by density). Pitched parts share the `lanes` by √(prominence in the
//             window)
//   base      every grid point holds a dot: its lane's loudness at that time
//             (the stem's envelope; a repeated bar reads the bar it repeats,
//             lighter) x how much that lane is used in the window (so columns
//             differ in density); a held note lifts its lane while it sounds.
//             Silence: the smallest, palest dot (`ghost`), so the matrix stays whole
//   events    note onsets and drum hits: bigger, darker dots by velocity x
//             loudness; the strongest share (`accent`) in Google red
//   streaks   notes held longer than `sustain` rows: a soft Google blue 200
//             streak down their lane, fading over the note
//   dots      the marks as a crisp matrix on a faint ruled grid, coloured
//             as Barcode: in ink (white -> ink by weight), each part's or
//             section's Google ramp (50 -> 1200), one hue, or the multi-hue
//             gradient offset per part; streaks in the part's 200
//   haze      (optional, as Barcode) the dots again, blurred together on
//             screen under the crisp ones
//   fields    the same music as soft, blurry blobs on a white page (the Haze
//             mode's look): each lane's events are gathered into clusters
//             (onsets within `merge` rows run together), one very soft blob
//             per cluster, as tall as it lasts and as wide/opaque as it is
//             strong; the weakest events dropped, hats a faint trail. One
//             Google colour per stem (vocals blue, instruments yellow, drums
//             red, bass green), 500 at the core fading to its 200 at the
//             edge; overlaps merge translucently. Under them a faint wash per
//             part follows its loudness
// The stems' envelopes come from the analysis, or are built from the notes
// until it lands.

/** Ledger's palettes, as dot colours (`ledger:<id>`). */
const LEDGER = 'ledger:'
const LEDGER_OPTIONS: Record<string, string> = {
  'Ledger · hue per stem': `${LEDGER}stems`, 'Ledger · two hues': `${LEDGER}duo`, 'Ledger · hue per section': `${LEDGER}sections`,
  'Ledger · mono': `${LEDGER}mono`, 'Ledger · grey': `${LEDGER}grey`,
}

/** Google ramps, light to dark: 50, 200, 500, 800, 1200. */
const RAMPS = {
  blue: ['#bbe2ff', '#76bbff', '#3186ff', '#2051da', '#0f173a'],
  red: ['#ffdeec', '#ff7985', '#fc413d', '#be1c1b', '#3c0202'],
  yellow: ['#fdfd6d', '#ffe921', '#fec700', '#e57e00', '#652000'],
  green: ['#bff3b9', '#60d673', '#00af57', '#008052', '#002220'],
  grey: ['#e6eaf0', '#c4c7c5', '#45474d', '#2f3034', '#121317'],
}

/** One Google colour per stem (500), and its 200 as the tint it fades to. */
const STEM_HUE: Record<Stem, 'blue' | 'yellow' | 'red' | 'green'> = { vocals: 'blue', instruments: 'yellow', drums: 'red', bass: 'green' }

/** Lanes left to right: drums, then the pitched parts low to high. */
const PITCHED: Stem[] = ['bass', 'instruments', 'vocals']
const DRUMS = ['kick', 'snare', 'hat'] as const
/** Blobs per layer the picture may use (each holds 4096). */
const BUDGET = 4000
/** Bar row for the ruled paper grid (past Barcode's rows). */
const ROW_RULE = 8

const clamp01 = (v: number) => Math.min(1, Math.max(0, v))
const mod = (a: number, n: number) => ((a % n) + n) % n
const lerp = (a: number, b: number, t: number) => a + (b - a) * t

type RGB = [number, number, number]
/** sRGB hex to linear rgb (what blob colours take). */
const lin = (hex: string): RGB => {
  const n = parseInt(hex.slice(1), 16)
  return [16, 8, 0].map((sh) => {
    const c = ((n >> sh) & 255) / 255
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
  }) as RGB
}
const mixc = (a: RGB, b: RGB, t: number): RGB => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)]

const params = {
  style: { type: 'select', value: 'dots', label: 'draw as', options: { dots: 'dots', fields: 'fields' } },

  anchor: {
    type: 'select', value: 'full', label: 'start from',
    options: { 'first full section': 'full', 'bar number': 'bars', 'section number': 'section', 'loudest stretch': 'loudest' },
  },
  from: { type: 'number', value: 0, min: 0, max: 256, step: 1, label: 'start (bar or section)' },
  span: { type: 'number', value: 8, min: 0, max: 128, step: 1, label: 'length (bars, 0 = all)' },

  rows: { type: 'number', value: 64, min: 8, max: 256, step: 1, label: 'rows per column' },
  lanes: { type: 'number', value: 30, min: 8, max: 128, step: 1, label: 'lanes per column' },
  systems: { type: 'number', value: 2, min: 1, max: 6, step: 1 },
  margin: { type: 'number', value: 0.06, min: 0, max: 0.4, step: 0.005 },
  gap: { type: 'number', value: 2, min: 0, max: 8, step: 0.25, label: 'space between columns' },
  groupGap: { type: 'number', value: 0, min: 0, max: 4, step: 1, label: 'space between parts' },
  square: { type: 'boolean', value: true, label: 'square dots spacing' },

  floor: { type: 'number', value: 0.1, min: 0, max: 0.6, step: 0.01, label: 'ignore quieter than' },
  gamma: { type: 'number', value: 1.3, min: 0.3, max: 4, step: 0.05, label: 'contrast' },
  echo: { type: 'number', value: 0.3, min: 0, max: 1, step: 0.01, label: 'echo repeats' },
  laneFloor: { type: 'number', value: 0.3, min: 0, max: 1, step: 0.01, label: 'quiet lanes keep' },
  held: { type: 'number', value: 0.6, min: 0, max: 1, step: 0.01, label: 'held notes lift' },
  accent: { type: 'number', value: 0.1, min: 0, max: 0.5, step: 0.005, label: 'accent amount' },
  sustain: { type: 'number', value: 1.5, min: 0.5, max: 16, step: 0.25, label: 'streak after (rows)' },

  palette: {
    type: 'select', value: 'ink', label: 'dot colour',
    options: {
      ink: 'ink', stems: 'stems', sections: 'sections', 'across hues': 'across',
      'mono blue': 'blue', 'mono red': 'red', 'mono yellow': 'yellow', 'mono green': 'green',
      ...Object.fromEntries(PALETTES.map((pl) => [pl.label, pl.id])),
      ...LEDGER_OPTIONS,
    },
  },
  colX0: { type: 'number', value: 0, min: -4, max: 4, step: 0.005, label: 'centre x' },
  colY0: { type: 'number', value: 0, min: -4, max: 4, step: 0.005, label: 'centre y' },
  colX1: { type: 'number', value: 1, min: -4, max: 4, step: 0.005, label: 'handle x' },
  colY1: { type: 'number', value: 0, min: -4, max: 4, step: 0.005, label: 'handle y' },
  colRepeat: { type: 'select', value: 'mirror', label: 'past the edge', options: { mirror: 'mirror', repeat: 'repeat', 'hold the edge': 'clamp' } },
  offset: { type: 'number', value: 0.2, min: 0, max: 1, step: 0.01, label: 'shift per part' },
  ghost: { type: 'number', value: 0.7, min: 0, max: 1, step: 0.01, label: 'silent dots' },
  dotMin: { type: 'number', value: 0.1, min: 0.02, max: 0.3, step: 0.005, label: 'smallest dot' },
  dotBase: { type: 'number', value: 0.2, min: 0.05, max: 0.5, step: 0.005, label: 'base dot size' },
  dotEvent: { type: 'number', value: 0.42, min: 0.1, max: 0.8, step: 0.005, label: 'hit dot size' },
  soft: { type: 'number', value: 0.4, min: 0, max: 1, step: 0.01, label: 'softness' },
  streak: { type: 'number', value: 0.85, min: 0, max: 1, step: 0.01, label: 'streaks' },
  streakWidth: { type: 'number', value: 1.2, min: 0.3, max: 3, step: 0.05, label: 'streak width' },
  ruling: { type: 'number', value: 0.1, min: 0, max: 0.5, step: 0.01, label: 'grid lines' },
  rulingDiv: { type: 'number', value: 3, min: 1, max: 8, step: 1, label: 'lines per dot' },
  paper: { type: 'number', value: 0.03, min: 0, max: 0.15, step: 0.005, label: 'paper grain' },

  motion: { type: 'select', value: 'still', options: { still: 'still', ...Object.fromEntries(MOTIONS.map((m) => [m.label, m.id])) } },
  motionAmount: { type: 'number', value: 0.6, min: 0, max: 1, step: 0.01, label: 'amount' },
  motionSpeed: { type: 'number', value: 1, min: 0.1, max: 4, step: 0.05, label: 'speed' },
  ...motionParams,

  form: { type: 'select', value: 'blob', label: 'field shape', options: { blob: 'blob', orb: 'orb', watercolour: 'watercolour' } },
  size: { type: 'number', value: 2.4, min: 0.3, max: 5, step: 0.05, label: 'blob size' },
  softness: { type: 'number', value: 0.7, min: 0, max: 1, step: 0.01, label: 'blob softness' },
  opacity: { type: 'number', value: 0.88, min: 0.05, max: 1, step: 0.01, label: 'blob opacity' },
  tint: { type: 'number', value: 0.6, min: 0, max: 1, step: 0.01, label: 'lighter edges' },
  merge: { type: 'number', value: 3, min: 0, max: 8, step: 0.25, label: 'merge hits within (rows)' },
  minEvent: { type: 'number', value: 0.35, min: 0, max: 1, step: 0.01, label: 'ignore hits under' },
  hats: { type: 'number', value: 0.25, min: 0, max: 1, step: 0.01, label: 'hat weight' },
  wash: { type: 'number', value: 0.12, min: 0, max: 0.6, step: 0.01, label: 'loudness wash' },
  wobble: { type: 'number', value: 0.15, min: 0, max: 0.6, step: 0.01 },
  drumGroup: { type: 'number', value: 4, min: 0, max: 8, step: 0.5, label: 'beats per drum blob' },
  fieldGrain: { type: 'number', value: 0, min: 0, max: 0.2, step: 0.01, label: 'shape grain' },

  ...dotShapeParams,
  ...hazeParams,
  // Past 100%: the blurred haze is thin, so let it be pushed toward solid.
  hazeOpacity: { ...hazeParams.hazeOpacity, max: 10 },
} as const

const groups: Record<string, string[]> = {
  Layout: ['style'],
  Window: ['anchor', 'from', 'span'],
  Grid: ['rows', 'lanes', 'systems', 'margin', 'gap', 'groupGap', 'square'],
  Weights: ['floor', 'gamma', 'echo', 'laneFloor', 'held', 'sustain'],
  Colour: ['palette', 'offset', 'accent', 'colRepeat', 'colX0', 'colY0', 'colX1', 'colY1'],
  Motion: ['motion', 'motionAmount', 'motionSpeed', ...motionKeys],
  Dots: ['ghost', 'dotMin', 'dotBase', 'dotEvent', 'soft', 'streak', 'streakWidth', 'ruling', 'rulingDiv', 'paper'],
  Fields: ['form', 'size', 'softness', 'opacity', 'tint', 'merge', 'minEvent', 'hats', 'drumGroup', 'wash', 'wobble', 'fieldGrain'],
  'Dot shape': dotShapeKeys,
  Haze: hazeKeys,
}
/** The Fields folder only for the fields style. */
/** The Fields folder only for the fields style. */
const groupsFor = (v: Record<string, any>) =>
  v.style === 'fields' ? groups : Object.fromEntries(Object.entries(groups).filter(([title]) => title !== 'Fields'))

/**
 * Until the audio analysis lands: a coarse one from the notes alone (as
 * Barcode), each note its velocity held over its length (drums: a quick decay).
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
  const sig = (b: number) => comp.notes.filter((n) => Math.floor(n.step / 16) === b).map((n) => `${n.step % 16}${n.voice}${n.pitch}`).join()
  const sigs = Array.from({ length: bars }, (_, b) => sig(b))
  const repeats = new Int32Array(bars).map((_, b) => Math.max(0, sigs.indexOf(sigs[b])))
  const playing = (b: number) => STEMS.map((s) => (stems[s].active.some(([a, z]) => a < b * 16 + 16 && z > b * 16) ? 1 : 0)).join('')
  const sections = [0]
  for (let b = 1; b < bars; b++) if (playing(b) !== playing(b - 1)) sections.push(b * 16)
  return { resolution: res, length, stems, stemmed: false, sections, repeats }
}

/** The window of the song to print, in steps [from, to) (as Barcode). */
function windowOf(comp: Composition, a: TrackAnalysis, p: Record<string, any>): [number, number] {
  const song = Math.max(1, comp.loop ?? a.length ?? comp.length)
  const bars = Math.max(1, Math.ceil(song / 16))
  const spanBars = Math.round(p.span) > 0 ? Math.min(bars, Math.round(p.span)) : 0
  let start = 0
  if (p.anchor === 'section') {
    const starts = a.sections.length ? a.sections : [0]
    start = Math.floor(starts[Math.min(starts.length - 1, Math.max(0, Math.round(p.from)))] / 16)
  } else if (p.anchor === 'full') {
    const starts = a.sections.length ? a.sections : [0]
    const needed = STEMS.filter((st) => a.stems[st].prominence > 0.1)
    const len = spanBars ? spanBars * 16 : 16
    const full = starts.find((st) => needed.every((n) => a.stems[n].active.some(([x, z]) => x < st + len && z > st)))
    start = Math.floor((full ?? 0) / 16)
  } else if (p.anchor === 'loudest' && spanBars) {
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

interface Picture {
  /** Fields' blobs. */
  dots: BlobSpec[]
  /** The dot matrix, as round bars; per dot its part (index in Barcode's ORDER), weight and section. */
  marks: BarSpec[]
  stems: number[]
  weights: number[]
  sections: number[]
  streaks: BlobSpec[]
  ruling: BarSpec | null
  /** Per mark, what a motion needs to know of it. */
  info: MarkInfo[]
  /** The grid, for motions. */
  grid: Omit<MotionFrame, 'time' | 'dt' | 'audio' | 'position' | 'amount' | 'speed' | 'params'> | null
}
const empty = (): Picture => ({ dots: [], marks: [], stems: [], weights: [], sections: [], streaks: [], ruling: null, info: [], grid: null })

/** One note or hit, in slots (fractional), for the fields. */
interface Ev { l: number; g: number; end: number; e: number; w: number; stem: Stem; voice: string }

/** The window as a dot grid: time down, lanes across, systems side by side. */
function generate(comp: Composition, a: TrackAnalysis, rows: number, p: Record<string, any>, W: number, H: number): Picture {
  const pic = empty()
  const [w0, w1] = windowOf(comp, a, p)
  const S = Math.max(1, Math.round(p.systems))
  const Rw = Math.max(2, rows)
  const T = Rw * S
  const res = a.resolution
  const stepsPer = (w1 - w0) / T
  const slotOf = (step: number) => Math.min(T - 1, Math.max(0, Math.floor((step - w0) / stepsPer)))
  const fields = p.style === 'fields'

  // Mean loudness per stem per slot; a repeated bar reads the bar it repeats, lighter.
  const loud = Object.fromEntries(STEMS.map((stem) => {
    const part = a.stems[stem]
    const env = part.envelope
    const out = new Float32Array(T)
    const on = new Uint8Array(T)
    for (const [x, z] of part.active) if (z > w0 && x < w1) for (let g = slotOf(x); g <= slotOf(Math.max(x, z - 1e-3)); g++) on[g] = 1
    for (let g = 0; g < T; g++) {
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
    return [stem, out]
  })) as Record<Stem, Float32Array>
  const sums = Object.fromEntries(STEMS.map((s) => [s, loud[s].reduce((x, y) => x + y, 0)])) as Record<Stem, number>
  const most = Math.max(1e-6, ...STEMS.map((s) => sums[s]))
  const prom = (s: Stem) => sums[s] / most
  const strength = (v: number) => (v <= p.floor ? 0 : Math.pow(clamp01((v - p.floor) / (1 - p.floor)), p.gamma))

  // Lanes: drums (one per voice), then each pitched part low -> high, sharing the rest by √prominence.
  const notes = comp.notes.filter((n) => n.step < w1 && n.step + Math.max(n.length, 0.5) > w0)
  const drumsOn = prom('drums') > 0.02 || notes.some((n) => n.stem === 'drums')
  const pitched = PITCHED.filter((s) => prom(s) > 0.02 || notes.some((n) => n.stem === s))
  const gapL = Math.max(0, Math.round(p.groupGap))
  const nGroups = pitched.length + (drumsOn ? 1 : 0)
  let avail = Math.round(p.lanes) - (drumsOn ? DRUMS.length : 0) - gapL * Math.max(0, nGroups - 1) - pitched.length
  const share = pitched.map(() => 1)
  const want = pitched.map((s) => Math.sqrt(prom(s)) + 1e-6)
  while (avail-- > 0 && pitched.length) {
    let best = 0
    for (let i = 1; i < pitched.length; i++) if (want[i] / share[i] > want[best] / share[best] + 1e-9) best = i
    share[best]++
  }
  /** Stem per lane (null = blank). */
  const laneStem: (Stem | null)[] = []
  const start = {} as Record<Stem, number>
  const count = {} as Record<Stem, number>
  const addGroup = (s: Stem, k: number) => {
    if (laneStem.length) for (let i = 0; i < gapL; i++) laneStem.push(null)
    start[s] = laneStem.length
    count[s] = k
    for (let i = 0; i < k; i++) laneStem.push(s)
  }
  if (drumsOn) addGroup('drums', DRUMS.length)
  pitched.forEach((s, i) => addGroup(s, share[i]))
  const N = laneStem.length
  if (!N) return pic

  const laneOf = (n: CompNote) => {
    if (n.stem === 'drums') {
      const v = DRUMS.indexOf(n.voice as (typeof DRUMS)[number])
      return drumsOn && v >= 0 ? start.drums + v : -1
    }
    if (start[n.stem] === undefined) return -1
    const range = a.stems[n.stem].range
    const lo = range ? range[0] : n.pitch, hi = range ? range[1] : n.pitch
    const k = count[n.stem]
    return start[n.stem] + Math.min(k - 1, Math.max(0, Math.floor(((n.pitch - lo) / Math.max(1, hi - lo + 1)) * k)))
  }

  // How much each lane is used in the window (velocity x time), per part: unused lanes keep `laneFloor`.
  const hist = new Float32Array(N)
  for (const n of notes) {
    const l = laneOf(n)
    if (l >= 0) hist[l] += n.velocity * (n.stem === 'drums' ? 1 : Math.max(0.5, Math.min(n.step + n.length, w1) - Math.max(n.step, w0)))
  }
  const presence = new Float32Array(N)
  for (const s of [...(drumsOn ? ['drums' as Stem] : []), ...pitched]) {
    let top = 0
    for (let l = start[s]; l < start[s] + count[s]; l++) top = Math.max(top, hist[l])
    for (let l = start[s]; l < start[s] + count[s]; l++) presence[l] = lerp(p.laneFloor, 1, top > 0 ? Math.sqrt(hist[l] / top) : 0.5)
  }

  // Base: the lane's loudness x its use; held notes lift their lane while they sound.
  const base = new Float32Array(T * N)
  for (let l = 0; l < N; l++) {
    const s = laneStem[l]
    if (!s) continue
    for (let g = 0; g < T; g++) base[g * N + l] = strength(loud[s][g]) * presence[l]
  }
  // Events: onsets by velocity x loudness. Streaks: notes held `sustain` rows or more.
  const ev = new Float32Array(T * N)
  const events: Ev[] = []
  const streaks: { l: number; g0: number; g1: number; v: number }[] = []
  for (const n of notes) {
    const l = laneOf(n)
    if (l < 0) continue
    if (n.stem !== 'drums') {
      const end = Math.min(w1, n.step + Math.max(n.length, 0.5))
      for (let g = slotOf(Math.max(n.step, w0)); g <= slotOf(end - 1e-3); g++) {
        const i = g * N + l
        base[i] = Math.max(base[i], p.held * n.velocity * (0.4 + 0.6 * strength(loud[n.stem][g])))
      }
      if (n.length / stepsPer >= p.sustain) streaks.push({ l, g0: (Math.max(n.step, w0) - w0) / stepsPer, g1: (end - w0) / stepsPer, v: n.velocity })
    }
    if (n.step < w0) continue
    const g = slotOf(n.step)
    const e = n.velocity * (0.4 + 0.6 * strength(loud[n.stem][g]))
    if (e > ev[g * N + l]) ev[g * N + l] = e
    const g0 = (n.step - w0) / stepsPer
    events.push({ l, g: g0, end: g0 + (n.stem === 'drums' ? 1 : Math.max(1, n.length / stepsPer)), e, w: n.voice === 'hat' ? p.hats : 1, stem: n.stem, voice: n.voice })
  }
  // The strongest `accent` share of the events go red.
  const evs = Array.from(ev).filter((e) => e > 0).sort((x, y) => x - y)
  const accentAt = p.accent > 0 && evs.length ? evs[Math.min(evs.length - 1, Math.floor(evs.length * (1 - p.accent)))] : Infinity
  // Many equal events at the threshold (even drums): only those strictly above it, so red stays an accent.
  const tied = evs.filter((e) => e >= accentAt).length > 2 * Math.ceil(evs.length * p.accent)
  const isRed = (e: number) => (tied ? e > accentAt : e >= accentAt)

  // Geometry: lanes across, rows down, systems side by side with `gap` lanes between; centred.
  const m = p.margin * Math.min(W, H)
  const across = S * N + (S - 1) * p.gap
  let pX = (W - 2 * m) / across, pY = (H - 2 * m) / Rw
  if (p.square) pX = pY = Math.min(pX, pY)
  const d = Math.min(pX, pY)
  const gridW = across * pX, gridH = Rw * pY
  const left = -gridW / 2, top = gridH / 2
  /** Centre of slot g (fractional: down the rows) in lane l. */
  const at = (g: number, l: number) => {
    const s = Math.min(S - 1, Math.floor(g / Rw))
    return { x: left + (s * (N + p.gap) + l + 0.5) * pX, y: top - (g - s * Rw + 0.5) * pY }
  }

  pic.grid = { w0, w1, stepsPer, T, N, Rw, S, pX, pY, W, H }
  if (fields) return fieldsOf(p, { T, N, S, Rw, pX, pY, stepsPer, at, events, loud, strength, laneStem, start, count })

  // Dots: base dots (or ghosts), events over them, coloured as Barcode's marks.
  const palette: string = p.palette
  const sections = a.sections.length ? a.sections : [0]
  const sectionOfSlot = (g: number) => sectionAt(sections, w0 + g * stepsPer)
  /**
   * Where a dot's colour comes from: the colours can be moved, turned and scaled over the picture (two handles:
   * the centre, and a handle half the frame's width out at scale 1), so a dot takes the colour the palette gives
   * the place (lane, slot, part, section) that lands on it; past the edge they mirror, repeat or hold.
   */
  const span = S * (N + p.gap) - p.gap
  const placed = !(p.colX0 === 0 && p.colY0 === 0 && p.colX1 === 1 && p.colY1 === 0)
  const cAx = p.colX0 * W / 2, cAy = p.colY0 * H / 2
  const cDx = (p.colX1 - p.colX0) * W / 2, cDy = (p.colY1 - p.colY0) * H / 2
  const cScale = Math.max(1e-3, Math.hypot(cDx, cDy) / (W / 2)), cAng = Math.atan2(cDy, cDx)
  const fold = (v: number, n: number) => {
    if (n <= 1) return 0
    if (p.colRepeat === 'clamp') return Math.min(n - 1, Math.max(0, v))
    if (p.colRepeat === 'repeat') return ((v % n) + n) % n
    const m = Math.abs(v) % (2 * n)
    return m >= n ? 2 * n - 1 - m : m
  }
  const colourPlace = (x: number, y: number, g: number, l: number, stem: Stem) => {
    if (!placed) return { g, l, stem, sec: sectionOfSlot(g), u: x / W, v: y / H }
    const rx = x - cAx, ry = y - cAy, c = Math.cos(-cAng), sn = Math.sin(-cAng)
    const lx = (rx * c - ry * sn) / cScale, ly = (rx * sn + ry * c) / cScale
    const col = fold(Math.round((lx - left) / pX - 0.5), span)
    const row = fold((top - ly) / pY - 0.5, Rw)
    const s = Math.min(S - 1, Math.floor(col / (N + p.gap)))
    let l2 = Math.min(N - 1, col - s * (N + p.gap))
    // A blank lane (between parts) takes the nearest part's colours.
    for (let k = 1; laneStem[l2] == null && k < N; k++) {
      if (laneStem[l2 - k] != null) l2 -= k
      else if (laneStem[l2 + k] != null) l2 += k
    }
    const g2 = s * Rw + row
    return { g: g2, l: l2, stem: laneStem[l2] ?? stem, sec: sectionOfSlot(g2), u: lx / W, v: ly / H }
  }
  /** A dot's gradient row and ramp position: lv 0..1 within its kind (ghost < base < event). */
  const explore = paletteOf(palette)
  const pal = PALETTES[explore]
  // Ledger's colours: its hue for the stem (or section), and its steps: the palest tint for silence, pale 200
  // washes for steady parts, toward 1200 for the strongest hits.
  const ledgerHue = palette.startsWith(LEDGER) ? LEDGER_PALETTES[palette.slice(LEDGER.length)] : null
  /**
   * The ramp offset per part, for every colour (across hues has its own, stronger, below): each part moved
   * along its ramp by its place in ORDER, so at 1 the four parts spread over the whole ramp; past the end it
   * turns back (mirrors) rather than jumping.
   */
  const offsetT = (t: number, stem: Stem) => {
    const u = Math.abs(t + (p.offset * ORDER.indexOf(stem)) / 3) % 2
    return u > 1 ? 2 - u : u
  }
  const paint = (kind: 'ghost' | 'base' | 'event', lv: number, stem: Stem, sec: number, red: boolean): [number, number] => {
    if (ledgerHue) {
      const hue = ledgerHue(stem, sec)
      return [rowOf(hue), kind === 'ghost' ? 0.02 : kind === 'base' ? (0.05 + 0.2 * lv) * (0.6 + 0.4 * LEDGER_TINT[hue]) : red ? 1 : 0.25 + 0.65 * lv]
    }
    if (red) return [rowOf('red'), 0.5 + 0.3 * lv]
    if (palette === 'ink') return [ROW_INK, kind === 'ghost' ? 0.22 : kind === 'base' ? 0.25 + 0.5 * lv : 0.75 + 0.25 * lv]
    if (palette === 'across') {
      if (kind === 'ghost') return [ROW_INK, 0.22]
      return [ROW_MULTI, (kind === 'base' ? 0.3 * lv : 0.3 + 0.5 * lv) + p.offset * ORDER.indexOf(stem)]
    }
    const hue: Hue = palette === 'stems' ? STEM_HUE[stem] : palette === 'sections' ? SECTION_HUES[sec % SECTION_HUES.length] : (palette as Hue)
    return [rowOf(hue), kind === 'ghost' ? 0.08 : kind === 'base' ? 0.15 + 0.35 * lv : 0.5 + 0.4 * lv]
  }
  const dot = (g: number, l: number, r: number, kind: 'ghost' | 'base' | 'event', lv: number, alpha: number, red: boolean, weight: number) => {
    const stem = laneStem[l]!
    const { x, y } = at(g, l)
    const sec = sectionOfSlot(g)
    // The colour is the palette's for the place the (moved) colours put here.
    const cp = colourPlace(x, y, g, l, stem)
    /** Gradient row, position, and alpha / size factors, as the palette paints this kind of dot here. */
    const look = (k: 'ghost' | 'base' | 'event', v: number, rd: boolean): [number, number, number, number] => {
      if (!pal) {
        const [r0, t0] = paint(k, v, cp.stem, cp.sec, rd)
        return [r0, palette === 'across' || k === 'ghost' || rd ? t0 : offsetT(t0, cp.stem), 1, 1]
      }
      const out = pal.paint({
        kind: k, lv: v, stem: cp.stem, sec: cp.sec, red: rd, g: cp.g, l: cp.l, T, N, u: cp.u, v: cp.v,
        within: count[cp.stem] > 1 ? (cp.l - start[cp.stem]) / (count[cp.stem] - 1) : 0.5, offset: p.offset,
      })
      return [paletteRow(explore, out.row), k === 'ghost' ? clamp01(out.t) : offsetT(clamp01(out.t), cp.stem), out.alpha ?? 1, out.size ?? 1]
    }
    const [row, t, am, sm] = look(kind, lv, red)
    alpha *= am
    r *= sm
    // As a lit dot (a motion lighting it): its part's event look, a little over mid-weight.
    const [eRow, eT, , esm] = kind === 'event' ? [row, t, am, sm] : look('event', 0.6, false)
    const er = Math.max(r, (kind === 'event' ? r : lerp(p.dotBase, p.dotEvent, 0.6) * d * esm))
    pic.marks.push({ x, y, w: 2 * r, h: 2 * r, radius: r, t0: t, t1: t, row, alpha, feather: Math.max(0.5, p.soft * r * 0.6) })
    pic.info.push({ x, y, r, g, l, stem, kind, lv, sec, step: w0 + g * stepsPer, t, er, eRow, eT })
    pic.stems.push(ORDER.indexOf(stem))
    pic.weights.push(weight)
    pic.sections.push(sec)
  }
  for (let g = 0; g < T; g++) {
    for (let l = 0; l < N; l++) {
      if (!laneStem[l]) continue
      const e = ev[g * N + l], b = base[g * N + l]
      if (e > 0) dot(g, l, lerp(p.dotBase, p.dotEvent, e) * d, 'event', e, 1, isRed(e), isRed(e) || e > 0.6 ? SOLID : HEAVY)
      else if (b > 0.02) dot(g, l, lerp(p.dotMin, p.dotBase, Math.sqrt(b)) * d, 'base', b, lerp(0.6, 1, b), false, b > 0.5 ? MEDIUM : HAIR)
      // Every empty point keeps a ghost (invisible at `ghost` 0), so motions can light it.
      else dot(g, l, p.dotMin * d, 'ghost', 0, p.ghost, false, 0)
    }
  }
  // Streaks: soft segments in the part's 200 (or the section's, or the one hue), narrowing and fading over the note.
  const streakHue = (stem: Stem, g: number): Hue =>
    ledgerHue ? ledgerHue(stem, sectionOfSlot(Math.floor(g))) : palette === 'sections' ? SECTION_HUES[sectionOfSlot(Math.floor(g)) % SECTION_HUES.length] : palette in RAMPS && palette !== 'grey' ? (palette as Hue) : STEM_HUE[stem]
  const total = streaks.reduce((x, s) => x + (s.g1 - s.g0), 0)
  const segStep = 0.5 * Math.max(1, Math.ceil((total * 2) / BUDGET))
  for (const { l, g0, g1, v } of streaks) {
    // In the colours of the place the moved colours put here.
    const here = at(g0, l)
    const cp = colourPlace(here.x, here.y, g0, l, laneStem[l]!)
    const stem = cp.stem
    const color = lin(pal?.streak?.(stem, { g: cp.g, l: cp.l, T, N, sec: cp.sec }) ?? RAMPS[streakHue(stem, cp.g)][1])
    for (let g = g0; g < g1; g += segStep) {
      const u = (g - g0) / Math.max(1e-3, g1 - g0)
      const { x, y } = at(g, l)
      // `at` centres on the slot; a streak starts at the onset's slot centre.
      pic.streaks.push({
        x, y, rx: 0.4 * pX * p.streakWidth * (1 - 0.3 * u), ry: 0.6 * pY * Math.max(1, segStep * 2),
        softness: 1, color, alpha: p.streak * (0.5 + 0.5 * v) * (1 - 0.6 * u), form: 1,
      })
    }
  }
  // A faint ruled grid under the dots, `rulingDiv` lines per dot pitch, through the dot centres.
  if (p.ruling > 0) {
    const spacing = d / Math.max(1, Math.round(p.rulingDiv))
    pic.ruling = {
      x: 0, y: 0, w: gridW + pX, h: gridH + pY, t0: 0, t1: 0, alpha: 0, row: ROW_RULE, feather: 0,
      pattern: 'grid', spacing, lineWidth: 1, lineT: 0, lineAlpha: p.ruling, phase: mod(-(left + pX / 2), spacing),
    }
  }
  return pic
}

/**
 * Fields: soft blobs, one per cluster of a lane's events, over a faint wash
 * per part. Front = blobs (long clusters first, so short bright ones sit on
 * top), back = wash.
 */
function fieldsOf(
  p: Record<string, any>,
  g: {
    T: number; N: number; S: number; Rw: number; pX: number; pY: number; stepsPer: number
    at: (g: number, l: number) => { x: number; y: number }
    events: Ev[]; loud: Record<Stem, Float32Array>; strength: (v: number) => number
    laneStem: (Stem | null)[]; start: Record<Stem, number>; count: Record<Stem, number>
  },
): Picture {
  const pic = empty()
  const core = (s: Stem) => lin(RAMPS[STEM_HUE[s]][2])
  const tint = (s: Stem) => mixc(lin(RAMPS[STEM_HUE[s]][2]), lin(RAMPS[STEM_HUE[s]][1]), p.tint)
  const form = BLOB_FORMS[p.form as keyof typeof BLOB_FORMS] ?? BLOB_FORMS.blob
  /** y at a fractional time position (slots from the window start). */
  const yAt = (t: number, l: number) => g.at(t - 0.5, l)

  // Clusters: per lane, onsets within `merge` rows of the previous end run together (never across systems).
  // Kicks and snares gather `drumGroup` beats per blob (a steady beat would otherwise merge into a wall or
  // stack up as many small marks); hats run into a faint trail and are kept down to half the threshold so
  // the trail survives.
  const maxE = g.events.reduce((m, ev) => Math.max(m, ev.e), 1e-6)
  const solo = (ev: Ev) => ev.voice === 'kick' || ev.voice === 'snare'
  const kept = g.events.filter((ev) => ev.g >= 0 && ev.e / maxE >= p.minEvent * (ev.voice === 'hat' ? 0.5 : 1)).sort((a, b) => a.l - b.l || a.g - b.g)
  interface Cluster { l: number; g0: number; g1: number; e: number; w: number; n: number; stem: Stem }
  const clusters: Cluster[] = []
  let cur: Cluster | null = null
  for (const ev of kept) {
    const sys = Math.floor(ev.g / g.Rw)
    const joins = solo(ev) ? !!cur && ev.g < cur.g0 + (p.drumGroup * 4) / g.stepsPer - 1e-6 : !!cur && ev.g <= cur.g1 + p.merge
    if (cur && joins && cur.l === ev.l && Math.floor(cur.g0 / g.Rw) === sys) {
      cur.g1 = Math.max(cur.g1, ev.end)
      cur.e = Math.max(cur.e, ev.e / maxE)
      cur.w = Math.max(cur.w, ev.w)
      cur.n++
    } else {
      cur = { l: ev.l, g0: ev.g, g1: ev.end, e: ev.e / maxE, w: ev.w, n: 1, stem: ev.stem }
      clusters.push(cur)
    }
    cur.g1 = Math.min(cur.g1, (sys + 1) * g.Rw)
  }
  clusters.sort((a, b) => b.g1 - b.g0 - (a.g1 - a.g0) || a.l - b.l || a.g0 - b.g0)
  for (const c of clusters) {
    const span = c.g1 - c.g0
    const { x, y } = yAt((c.g0 + c.g1) / 2, c.l)
    // Wide and opaque by strength (and a little by how many notes it gathers); tall as it lasts, plus a soft pad.
    const wide = (0.45 + 0.55 * c.e) * (1 + 0.15 * Math.log2(c.n)) * (0.5 + 0.5 * c.w)
    pic.dots.push({
      x, y, rx: 0.5 * g.pX * p.size * wide, ry: 0.5 * g.pY * (span + 0.8 * p.size),
      softness: p.softness, wobble: p.wobble, seed: mod(c.l * 0.618 + c.g0 * 0.137, 1), form,
      color: core(c.stem), color2: tint(c.stem), gradient: BLOB_GRADIENTS.radial,
      alpha: p.opacity * c.w * (0.7 + 0.3 * c.e), grain: p.fieldGrain,
    })
  }

  // Wash: per part, every 4 rows, a very faint orb across its lanes as loud as the part is there.
  if (p.wash > 0) {
    const chunk = 4
    for (const stem of Object.keys(g.start) as Stem[]) {
      const l0 = g.start[stem], k = g.count[stem]
      for (let t = 0; t < g.T; t += chunk) {
        let sum = 0
        for (let i = t; i < Math.min(g.T, t + chunk); i++) sum += g.strength(g.loud[stem][i])
        const v = sum / chunk
        if (v < 0.02) continue
        const { x, y } = yAt(t + chunk / 2, l0 + (k - 1) / 2)
        pic.streaks.push({
          x, y, rx: 0.6 * k * g.pX, ry: 0.9 * chunk * g.pY, softness: 1, form: BLOB_FORMS.orb,
          color: tint(stem), alpha: p.wash * v * (stem === 'drums' ? p.hats + 0.3 : 1),
        })
      }
    }
  }
  return pic
}

const MOTION_KEYS = new Set(['motion', 'motionAmount', 'motionSpeed', ...motionKeys, ...dotShapeKeys])

function create(): SubInstance {
  let pic = empty()
  let key = ''
  let guess: TrackAnalysis | null = null
  let guessFor = -1
  let warned = ''
  // Motion: an instance per picture and motion; the moved marks, reused frame to frame.
  let motion: DotMotionInstance | null = null
  let motionKey = ''
  let moved: BarSpec[] = []
  let shapedCopy: BarSpec[] = []
  const move: MarkMove = { dx: 0, dy: 0, size: 1, alpha: 1, t: 0, lit: 0, hueBySize: 0 }
  let weights: number[] = []
  const own: Record<string, any> = {}

  return {
    update({ layers, viewport, ink, time, dt, audio }, comp, p) {
      const W = viewport.width, H = viewport.height
      const { front, back, bars } = layers
      front.blend = 'normal'
      back.blend = 'normal'
      bars.blend = 'normal'
      barcodeGradients(bars, ink)
      bars.setGradient([RAMPS.grey[1], RAMPS.grey[2]], ROW_RULE)
      // The explorations' rows, on the haze layers too (they blur the same marks).
      for (const layer of [bars, layers.barsFar.bars, layers.barsMid.bars])
        PALETTES.forEach((pl, i) => pl.rows.forEach((hexes, r) => layer.setGradient(hexes, paletteRow(i, r))))
      layers.grain.value = p.paper
      if (!comp.notes.length && !comp.analysis) return

      let a = comp.analysis
      if (!a) {
        if (guessFor !== comp.version) {
          guess = fromNotes(comp)
          guessFor = comp.version
        }
        a = guess!
      }
      // Motion settings move the picture, they don't regenerate it.
      const k = `${comp.version}:${W}x${H}:${JSON.stringify(p, (key, v) => (MOTION_KEYS.has(key) ? undefined : v))}`
      if (k !== key) {
        key = k
        // Fit the blob layer: fewer rows until the dots do.
        let rows = Math.max(8, Math.round(p.rows))
        pic = generate(comp, a, rows, p, W, H)
        while (Math.max(pic.dots.length, pic.marks.length) > BUDGET && rows > 8) {
          rows = Math.max(8, Math.floor(rows * 0.8))
          pic = generate(comp, a, rows, p, W, H)
        }
        pic.marks.forEach((m, i) => (m.stem = pic.stems[i]))
        if (rows !== Math.round(p.rows) && warned !== k) {
          warned = k
          console.info(`Dots: ${Math.round(p.rows)} rows needs more than ${BUDGET} dots; drawing ${rows}.`)
        }
      }

      // Move the marks: rest -> each motion's offset, size, alpha and colour shift.
      let marks = pic.marks
      const kind = motionOf(p.motion)
      if (kind && pic.grid && p.motionAmount > 0) {
        if (motionKey !== `${k}:${kind.id}`) {
          motionKey = `${k}:${kind.id}`
          motion = kind.create(pic.info)
          moved = pic.marks.map((m) => ({ ...m }))
          weights = [...pic.weights]
        }
        const f: MotionFrame = { ...pic.grid, time, dt, audio, position: comp.position, amount: clamp01(p.motionAmount), speed: p.motionSpeed, params: motionValues(kind, p, own) }
        motion!.frame?.(f)
        for (let i = 0; i < pic.marks.length; i++) {
          const m = pic.marks[i], o = moved[i]
          move.dx = 0; move.dy = 0; move.size = 1; move.alpha = 1; move.t = 0; move.lit = 0; move.hueBySize = 0
          motion!.mark(i, pic.info[i], f, move)
          applyMove(m, pic.info[i], move, o)
          // Lit dots haze like the heavy ones.
          weights[i] = move.lit > 0.3 ? Math.max(pic.weights[i], HEAVY) : pic.weights[i]
        }
        marks = moved
      } else motionKey = ''

      // Dot shape: dashes / bars of any length, roundness and angle, varied by noise (shared/dotShape.ts); on
      // copies when the marks are the picture's own.
      if (shapesDots(p)) {
        if (marks === pic.marks) {
          if (shapedCopy.length !== marks.length) shapedCopy = marks.map((m) => ({ ...m }))
          else marks.forEach((m, i) => Object.assign(shapedCopy[i], m))
          marks = shapedCopy
        }
        for (const o of marks) shapeDot(o, p, time)
      } else if (marks === moved) for (const o of moved) o.rotation = 0

      if (pic.ruling) bars.push(pic.ruling)
      const keep = kind && pic.grid && p.motionAmount > 0 && kind.streaks ? clamp01(kind.streaks(own, clamp01(p.motionAmount))) : 1
      for (const s of pic.streaks) if (keep > 0.003) back.push(keep < 1 ? { ...s, alpha: (s.alpha ?? 1) * keep } : s)
      for (const b of pic.dots) front.push(b)
      if (p.hazeBlur > 0) drawHaze(layers, { ...pic, marks, weights: marks === moved ? weights : pic.weights, section: (i) => pic.sections[i] }, p, ink)
      const crisp = clamp01(p.crisp)
      // (By size, not radius: square dots have none.)
      if (crisp > 0.001) for (const m of marks) if ((m.alpha ?? 1) > 0.003 && Math.min(m.w, m.h) > 0.1) bars.push(crisp < 1 ? { ...m, alpha: (m.alpha ?? 1) * crisp } : m)
    },
  }
}

/** Barcode's page, and a white page for the fields. */
const PAPER = { background: '#f4f5f7', ink: '#121317' }
const WHITE = { background: '#ffffff', ink: '#121317' }
/** The default: dots along the multi-hue gradient over a stretched, clean-edged haze. */
const DEFAULT = { palette: 'across', hazeBlur: 5, hazeStretch: 2, hazeMid: 0.47, hazeGain: 8, hazeEdge: 0.45, hazeTone: 0.62 }
const FIELDS = { style: 'fields', square: false, systems: 1, lanes: 24, rows: 64, paper: 0.04 }

export const dots: SubMode = {
  id: 'dots',
  label: 'Dots',
  params,
  groups,
  groupsFor,
  rebuildOn: ['style'],
  presets: {
    // 8 bars from the first section where every stem plays, one step per row, in two systems of 30 lanes.
    Default: { params: { ...DEFAULT }, ...PAPER },
    // The palette explorations, over the default's haze.
    ...Object.fromEntries(PALETTES.map((pl) => [`Palette · ${pl.label}`, { params: { ...DEFAULT, palette: pl.id }, ...PAPER }])),
    // The motion explorations, on the default (play the track to see them move).
    ...Object.fromEntries(MOTIONS.map((m) => [`Motion · ${m.label}`, { params: { ...DEFAULT, motion: m.id }, ...PAPER }])),
    // Close up: the loudest 4 bars, fewer, bigger dots.
    'Close-up': { params: { anchor: 'loudest', span: 4, rows: 32, lanes: 28, dotEvent: 0.46, streakWidth: 1.2 }, ...PAPER },
    // The whole song in three columns of dots.
    'Whole song': { params: { anchor: 'bars', from: 0, span: 0, systems: 4, lanes: 16, rows: 60, gap: 2 }, ...PAPER },
    // Each part's dots in its own Google ramp, 50 -> 1200 by weight.
    Stems: { params: { palette: 'stems', accent: 0, ghost: 0.5 }, ...WHITE },
    // Ink dots; the louder ones throw a soft haze in their part's hue.
    Haze: {
      params: { ghost: 0.5, accent: 0, hazeBlur: 8, hazeMid: 0.6, hazeGain: 3.5, hazeTint: 'stems', hazeTone: 0.4, hazeFrom: 'medium', paper: 0.06 },
      ...WHITE,
    },
    // The louder dots' haze pooling into clean-edged forms where they crowd together.
    Pools: {
      params: {
        palette: 'stems', ghost: 0.4, accent: 0, streak: 0.4, crisp: 0.8,
        hazeBlur: 9, hazeMid: 0, hazeGain: 5, hazeEdge: 0.8, hazeTint: 'stems', hazeTone: 0.45, hazeFrom: 'medium', paper: 0.06,
      },
      ...WHITE,
    },
    // One multi-hue Google gradient, each part further along it.
    'Across hues': { params: { palette: 'across', ghost: 0.5, accent: 0 }, ...WHITE },
    // The music as soft, blurry blobs (the Haze look), one Google colour per part.
    Fields: { params: { ...FIELDS }, ...WHITE },
    // Gaussian orbs, bigger and more merged.
    'Fields · orbs': { params: { ...FIELDS, form: 'orb', size: 3, opacity: 0.9, merge: 4 }, ...WHITE },
    // Watercolour edges, pigment pooling at the rim.
    'Fields · watercolour': { params: { ...FIELDS, form: 'watercolour', softness: 0.45, opacity: 0.8, fieldGrain: 0.03 }, ...WHITE },
    // The whole song in three soft columns.
    'Fields · whole song': { params: { ...FIELDS, anchor: 'bars', from: 0, span: 0, systems: 3, lanes: 14, rows: 72, gap: 1 }, ...WHITE },
  },
  create,
}
