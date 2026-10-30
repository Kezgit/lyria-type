import { STEMS, type PartAnalysis, type Stem } from '../../audio/features'
import type { BarSpec } from '../../engine/barLayer'
import type { GlyphLayer } from '../../engine/glyphLayer'
import type { ShapedGlyph } from '../../text/shaping'
import type { Composition } from './composition'
import type { SubMode, SubInstance } from './index'

// Ledger: a song as one still page of bands set in repeated characters,
// after the Ledger reference. A static generator: the image is made once
// from the analysis and doesn't move with playback.
//
// The window (`from` + `span` bars; the whole song by default) runs left to
// right across `columns` cells in all, wrapped into `systems` rows; each cell
// aggregates its span. Every mark comes from the analysed audio, nothing is
// random:
//   bands      one per stem in each system (vocals, instruments, drums, bass,
//              top to bottom); height from how loud the stem is across that
//              system, so silent bands collapse to a sliver
//   texture    each band is a tight grid of one character: brightness (and
//              the stems' brightness order) picks it, each section shifts it
//              by its loudness and pitch / density, each bar by its own;
//              wide-ranged parts alternate two. Loud cells set every cell,
//              medium every other column, quiet and silent ever sparser,
//              fainter rows
//   fields     the palest tint (50) under every stretch the stem plays
//   blocks     loud sections (height = loudness, pale), then the notes of a
//              bar as a group block over their span and pitch range (200 for
//              new material, paler where the bar repeats an earlier one); the
//              cells a note covers set a denser character (picked by pitch)
//              toward 500; a small 1200 accent on a new bar's loudest note
//   repeats    a bar that repeats an earlier one takes that bar's characters
//              and the paler block, so repeated bars read as repeated
// Band heights, pitch ranges, section shifts and the per-section palette all
// read the window's own content. Until the analysis lands it is all derived
// from the notes.

/** Google ramps, light to dark: 50, 200, 500, 800, 1200 (grey: its own steps). Every mark stays within one ramp. */
const RAMPS = {
  blue: ['#bbe2ff', '#76bbff', '#3186ff', '#2051da', '#0f173a'],
  red: ['#ffdeec', '#ff7985', '#fc413d', '#be1c1b', '#3c0202'],
  yellow: ['#fdfd6d', '#ffe921', '#fec700', '#e57e00', '#652000'],
  green: ['#bff3b9', '#60d673', '#00af57', '#008052', '#002220'],
  grey: ['#e6eaf0', '#c4c7c5', '#45474d', '#2f3034', '#121317'],
}
type Hue = keyof typeof RAMPS
const HUES = Object.keys(RAMPS) as Hue[]
/** Gradient rows used (clear of other sub-modes'). */
const ROW_BASE = 8
const ROW = (h: Hue) => ROW_BASE + HUES.indexOf(h)
/** Yellow's palest step is strong: its tints go lighter. */
export const LEDGER_TINT: Record<Hue, number> = { blue: 1, red: 1, yellow: 0.5, green: 0.85, grey: 1 }

/** Ramp positions of the steps. */
const T50 = 0, T200 = 0.25, T1200 = 1

/** Bands top to bottom, like a score. */
const ORDER: Stem[] = ['vocals', 'instruments', 'drums', 'bass']

/** Palettes: the hue for a stem at a section (Dots offers them too). */
export const LEDGER_PALETTES: Record<string, (stem: Stem, section: number) => Hue> = {
  stems: (s) => ({ vocals: 'red', instruments: 'green', drums: 'blue', bass: 'yellow' } as const)[s],
  duo: (s) => (s === 'vocals' || s === 'drums' ? 'red' : 'green'),
  sections: (_, k) => (['blue', 'red', 'yellow', 'green'] as const)[k % 4],
  mono: () => 'blue',
  grey: () => 'grey',
}

/** Character sets: field characters ordered dark/round -> bright/sharp, and denser ones for note cells. */
const CHARSETS: Record<string, { field: string; dense: string }> = {
  ledger: { field: 'o0(cedaLtfjyvz>Y^', dense: 'OQDB8&%#MW' },
  hatch: { field: '.,:;-~=+<>x*/', dense: '#%&@8' },
  letters: { field: 'oeacsnuvrxzkt', dense: 'mwgbdhqp' },
}

/** The character set: one of CHARSETS, or the Sequencer's typed characters (`customChars`, light -> heavy). */
function charsetOf(p: Record<string, any>) {
  const typed = p.chars === 'custom' ? [...String(p.customChars ?? '')].filter((c) => c.trim()).join('') : ''
  if (typed) return { field: typed, dense: typed.slice(Math.floor(typed.length / 2)) || typed }
  return CHARSETS[p.chars] ?? CHARSETS.ledger
}

/** Drum voices -> lane in the drums band (1 = top). */
const LANE: Record<string, number> = { hat: 1, snare: 0.5, kick: 0 }

type RGB = [number, number, number]
const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
const hex = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255)
/** Linear-space colour at t (0..1) along a ramp, interpolated in sRGB like the bar gradients. */
function rampColor(hue: Hue, t: number): RGB {
  const stops = RAMPS[hue].map(hex)
  const x = Math.min(1, Math.max(0, t)) * (stops.length - 1)
  const k = Math.min(stops.length - 2, Math.floor(x)), w = x - k
  return [0, 1, 2].map((c) => lin(stops[k][c] + (stops[k + 1][c] - stops[k][c]) * w)) as RGB
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))
const norm = (v: number, [lo, hi]: [number, number]) => (hi > lo ? clamp((v - lo) / (hi - lo), 0, 1) : 0.5)

/** What the generator reads: the analysis, or the same shape derived from the notes. */
interface Reading {
  /** Steps covered. */
  len: number
  /** Envelope frames per step. */
  res: number
  parts: Record<Stem, PartAnalysis>
  sections: number[]
  repeats: Int32Array
}

const isDrums = (s: Stem) => s === 'drums'


/** The analysis' shape from the notes alone: envelopes from velocity x length, sections where the playing set changes, repeats by bar content. */
function fromNotes(comp: Composition, len: number): Reading {
  const bars = Math.ceil(len / 16)
  const parts = {} as Record<Stem, PartAnalysis>
  const mass: Record<string, number> = {}
  for (const stem of STEMS) {
    const notes = comp.notes.filter((n) => n.stem === stem)
    const env = new Float32Array(len)
    let sum = 0
    for (const n of notes) {
      const l = Math.max(1, n.length)
      const tail = isDrums(stem) ? 2 : 0
      for (let k = 0; k < l + tail; k++) {
        const s = n.step + k
        if (s < 0 || s >= len) continue
        const v = k < l ? n.velocity * (1 - (0.4 * k) / l) : n.velocity * 0.5 * (1 - (k - l) / tail)
        env[s] += v
        sum += v
      }
    }
    let peak = 0
    for (const v of env) peak = Math.max(peak, v)
    for (let i = 0; i < len; i++) env[i] = peak > 0 ? Math.sqrt(env[i] / peak) : 0
    mass[stem] = sum
    const pitches = notes.map((n) => n.pitch)
    const range: [number, number] | null = isDrums(stem) || !pitches.length ? null : [Math.min(...pitches), Math.max(...pitches)]
    const brightness = isDrums(stem)
      ? 0.15 + 0.7 * (notes.filter((n) => n.voice === 'hat').length / Math.max(1, notes.length))
      : pitches.length ? norm(pitches.reduce((a, b) => a + b, 0) / pitches.length, [36, 84]) : 0.5
    const active: [number, number][] = []
    for (let s = 0; s < len; s++) {
      if (env[s] < 0.04) continue
      const last = active[active.length - 1]
      if (last && s - last[1] <= 2) last[1] = s + 1
      else active.push([s, s + 1])
    }
    parts[stem] = { envelope: env, prominence: 0, brightness, range, active }
  }
  const top = Math.max(1e-6, ...STEMS.map((s) => mass[s]))
  for (const s of STEMS) parts[s].prominence = mass[s] / top

  // Sections: bars where the set of playing stems changes.
  const sets = new Int32Array(bars)
  const keys: string[] = Array.from({ length: bars }, () => '')
  const byBar: string[][] = Array.from({ length: bars }, () => [])
  for (const n of comp.notes) {
    const b = Math.floor(n.step / 16)
    if (b < 0 || b >= bars) continue
    sets[b] |= 1 << STEMS.indexOf(n.stem)
    byBar[b].push(`${n.step - b * 16}:${n.voice}:${n.pitch}:${n.length}`)
  }
  const sections = [0]
  for (let b = 1; b < bars; b++) if (sets[b] !== sets[b - 1]) sections.push(b * 16)
  const repeats = new Int32Array(bars)
  const first = new Map<string, number>()
  for (let b = 0; b < bars; b++) {
    keys[b] = byBar[b].sort().join()
    const f = first.get(keys[b])
    repeats[b] = f ?? b
    if (f === undefined) first.set(keys[b], b)
  }
  return { len, res: 1, parts, sections, repeats }
}

function read(comp: Composition): Reading {
  const a = comp.analysis
  const len = Math.max(16, a?.length || comp.length)
  if (!a) return fromNotes(comp, len)
  return { len, res: Math.max(1, a.resolution), parts: a.stems, sections: a.sections.length ? a.sections : [0], repeats: a.repeats }
}

/** Mean loudness of a part over steps [s0, s1). */
function loud(R: Reading, part: PartAnalysis, s0: number, s1: number): number {
  const env = part.envelope, total = env.length
  if (!total) return 0
  const f0 = Math.floor(s0 * R.res), f1 = Math.max(f0 + 1, Math.ceil(s1 * R.res))
  let sum = 0
  for (let f = f0; f < f1; f++) {
    const i = f
    if (i >= 0 && i < total) sum += env[i]
  }
  return sum / (f1 - f0)
}

/** Per stem: pitch range, two-character alternation, and the field character of every bar. */
interface Voicing {
  range: Record<Stem, [number, number] | null>
  wide: Record<Stem, boolean>
  /** Per bar: index into the field set (a repeated bar takes its original's). */
  char: Record<Stem, Int16Array>
}

const sectionOf = (R: Reading, step: number) => {
  let k = 0
  while (k + 1 < R.sections.length && R.sections[k + 1] <= step) k++
  return k
}

/** Steps [w0, w1) of the song the page shows: `from` (bars, optionally back to its section's start) for `span` bars (0 = to the end). */
function windowOf(R: Reading, p: Record<string, any>): [number, number] {
  const bars = Math.ceil(R.len / 16)
  let w0 = clamp(Math.round(p.from), 0, bars - 1) * 16
  if (p.snap) w0 = R.sections[sectionOf(R, w0)] ?? w0
  const span = Math.round(p.span)
  const w1 = span > 0 ? Math.min(R.len, w0 + span * 16) : R.len
  return [w0, Math.max(w0 + 16, w1)]
}

/** Character choices and pitch range, read over the window [w0, w1) so a close-up gets its own spread. */
function voicing(comp: Composition, R: Reading, chars: number, w0: number, w1: number): Voicing {
  const bars = Math.ceil(R.len / 16)
  const v: Voicing = { range: {} as any, wide: {} as any, char: {} as any }
  // Brightness order spreads the stems over the set, so each band has its own texture.
  const rank = [...STEMS].sort((a, b) => R.parts[a].brightness - R.parts[b].brightness || STEMS.indexOf(a) - STEMS.indexOf(b))
  const K = R.sections.length
  for (const stem of STEMS) {
    const part = R.parts[stem]
    const notes = comp.notes.filter((n) => n.stem === stem)
    const pitches = notes.filter((n) => n.step < w1 && n.step + n.length > w0).map((n) => n.pitch)
    const range = isDrums(stem) ? null : pitches.length ? ([Math.min(...pitches), Math.max(...pitches)] as [number, number]) : part.range
    v.range[stem] = range
    v.wide[stem] = !!range && range[1] - range[0] > 12
    const base = (0.5 * part.brightness + (0.5 * (rank.indexOf(stem) + 0.5)) / STEMS.length) * (chars - 1)

    // Per bar and per section: note count and pitch.
    const count = new Float32Array(bars), pitch = new Float32Array(bars)
    const sCount = new Float32Array(K), sPitch = new Float32Array(K)
    for (const n of notes) {
      const b = Math.floor(n.step / 16)
      if (b >= 0 && b < bars) {
        count[b]++
        pitch[b] += n.pitch
      }
      const k = sectionOf(R, n.step)
      sCount[k]++
      sPitch[k] += n.pitch
    }
    const busy = (c: Float32Array) => {
      const on = [...c].filter((x) => x > 0)
      return on.length ? on.reduce((a, b) => a + b, 0) / on.length : 1
    }
    // Sections: louder / higher (busier for drums) -> further along the set.
    const sLoud = R.sections.map((a, k) => loud(R, part, a, R.sections[k + 1] ?? R.len))
    const seen = sLoud.filter((_, k) => R.sections[k] < w1 && (R.sections[k + 1] ?? R.len) > w0)
    const lo = Math.min(...seen), hi = Math.max(...seen)
    const sMean = busy(sCount.map((c, k) => c / Math.max(1, (R.sections[k + 1] ?? R.len) - R.sections[k])))
    const sShift = R.sections.map((a, k) => {
      const span = Math.max(1, (R.sections[k + 1] ?? R.len) - a)
      const where = !sCount[k] ? 0.5 : range ? norm(sPitch[k] / sCount[k], range) : clamp((sCount[k] / span / sMean) * 0.5, 0, 1)
      return Math.round((norm(sLoud[k], [lo, hi]) - 0.5) * 4 + (where - 0.5) * 3)
    })
    const bMean = busy(count)
    const char = new Int16Array(bars)
    const raw = (b: number) => {
      const s = sShift[sectionOf(R, b * 16)]
      const own = !count[b] ? 0 : range ? Math.round((norm(pitch[b] / count[b], range) - 0.5) * 2) : count[b] > bMean * 1.3 ? 1 : count[b] < bMean * 0.7 ? -1 : 0
      return clamp(Math.round(base) + s + own, 0, chars - 2)
    }
    for (let b = 0; b < bars; b++) {
      const src = R.repeats[b]
      char[b] = raw(src !== undefined && src >= 0 && src < bars ? src : b)
    }
    v.char[stem] = char
  }
  return v
}

/** One glyph of the page; its atlas quad is looked up when baked. */
interface Cell {
  /** Field set index, or -1 - index into the dense set. */
  char: number
  x: number
  y: number
  rgb: RGB
  alpha: number
  bleed: number
  /** Its band's stem (index into ORDER). */
  stem: number
}

interface Page {
  marks: BarSpec[]
  cells: Cell[]
  /** Em size of every glyph, px. */
  size: number
}

const params = {
  from: { type: 'number', value: 0, min: 0, max: 512, step: 1, label: 'from (bar)' },
  span: { type: 'number', value: 0, min: 0, max: 512, step: 1, label: 'span (bars, 0 = all)' },
  snap: { type: 'boolean', value: false, label: 'snap to section' },
  columns: { type: 'number', value: 960, min: 32, max: 4096, step: 16, label: 'columns (window)' },
  systems: { type: 'number', value: 4, min: 1, max: 16, step: 1 },
  margin: { type: 'number', value: 0.06, min: 0, max: 0.3, step: 0.005 },
  aspect: { type: 'number', value: 1.3, min: 0.6, max: 4, step: 0.05, label: 'cell height' },
  gap: { type: 'number', value: 1, min: 0, max: 8, step: 1, label: 'system gap (rows)' },
  minRows: { type: 'number', value: 2, min: 1, max: 8, step: 1, label: 'silent band (rows)' },

  chars: { type: 'select', value: 'ledger', options: { Ledger: 'ledger', Hatch: 'hatch', Letters: 'letters' } },
  glyph: { type: 'number', value: 1, min: 0.3, max: 2, step: 0.01, label: 'glyph size' },
  dense: { type: 'number', value: 0.45, min: 0, max: 1, step: 0.01, label: 'dense above' },
  quiet: { type: 'number', value: 0.1, min: 0, max: 1, step: 0.01, label: 'quiet below' },
  sparse: { type: 'number', value: 4, min: 2, max: 16, step: 1, label: 'quiet spacing' },
  weight: { type: 'number', value: 0.25, min: 0, max: 1.5, step: 0.01, label: 'loud weight (px)' },

  field: { type: 'number', value: 0.6, min: 0, max: 1, step: 0.01, label: 'fields' },
  sectionCut: { type: 'number', value: 0.55, min: 0, max: 1, step: 0.01, label: 'section block above' },
  groupGap: { type: 'number', value: 1, min: 0, max: 16, step: 1, label: 'group gap (cells)' },
  blocks: { type: 'number', value: 0.85, min: 0, max: 1, step: 0.01, label: 'blocks' },
  accent: { type: 'number', value: 0.9, min: 0, max: 1.01, step: 0.01, label: 'accent above (velocity)' },

  palette: { type: 'select', value: 'stems', options: { 'Hue per stem': 'stems', 'Two hues': 'duo', 'Hue per section': 'sections', Mono: 'mono', Grey: 'grey' } },
  soft: { type: 'number', value: 0.3, min: 0, max: 6, step: 0.1, label: 'edge softness (px)' },
  grain: { type: 'number', value: 0.04, min: 0, max: 0.3, step: 0.005 },
} as const

const groups = {
  Window: ['from', 'span', 'snap'],
  Page: ['columns', 'systems', 'margin', 'aspect', 'gap', 'minRows'],
  Texture: ['chars', 'glyph', 'dense', 'quiet', 'sparse', 'weight'],
  Blocks: ['field', 'sectionCut', 'groupGap', 'blocks', 'accent'],
  Ink: ['palette', 'soft', 'grain'],
}

/** The whole song on one page, `aspect` = cell height / width. */
function generate(comp: Composition, R: Reading, V: Voicing, p: Record<string, any>, W: number, H: number, aspect: number): Page {
  const marks: BarSpec[] = []
  const cells: Cell[] = []
  const set = charsetOf(p)
  const hueOf = LEDGER_PALETTES[p.palette] ?? LEDGER_PALETTES.stems
  const S = Math.max(1, Math.round(p.systems))
  const C = Math.max(S, Math.round(p.columns))
  const [w0, w1] = windowOf(R, p)
  const T = w1 - w0
  const cps = Math.ceil(C / S)
  const B = ORDER.length
  const minRows = Math.max(1, Math.round(p.minRows))

  // The grid fills the frame inside the margin: columns across, rows down.
  const m = p.margin * Math.min(W, H)
  const aw = W - 2 * m, ah = H - 2 * m
  const cw = aw / cps
  const gapR = Math.round(p.gap)
  const total = Math.max(S * B * minRows + (S - 1) * gapR, Math.floor(ah / (cw * aspect)))
  const ch = ah / total
  const perSys = Math.floor((total - (S - 1) * gapR) / S)
  const left = -W / 2 + m
  const top = H / 2 - m - (ah - (S * perSys + (S - 1) * gapR) * ch) / 2
  /** Song step -> global column. */
  const colAt = (s: number) => ((s - w0) * C) / T
  const stepAt = (c: number) => w0 + (c * T) / C

  const rect = (c0: number, c1: number, r0: number, r1: number): Pick<BarSpec, 'x' | 'y' | 'w' | 'h'> => ({
    x: left + ((c0 + c1) / 2) * cw, w: (c1 - c0) * cw,
    y: top - ((r0 + r1 + 1) / 2) * ch, h: (r1 - r0 + 1) * ch,
  })
  /** The stem whose band is being drawn (an index into ORDER). */
  let curStem = -1
  const bar = (spec: Pick<BarSpec, 'x' | 'y' | 'w' | 'h'>, hue: Hue, t: number, alpha: number) =>
    marks.push({ ...spec, t0: t, t1: t, row: ROW(hue), alpha, feather: p.soft, grain: p.grain, stem: curStem })

  const secOfCol = new Int32Array(C)
  // Sections counted from the window's first, so its palette starts at the first hue.
  const firstSec = sectionOf(R, w0)
  for (let c = 0; c < C; c++) secOfCol[c] = sectionOf(R, stepAt(c + 0.5)) - firstSec
  const bars = Math.ceil(R.len / 16)
  const sparse = Math.max(2, Math.round(p.sparse))

  for (let sys = 0; sys < S; sys++) {
    const g0 = sys * cps
    const cols = Math.min(cps, C - g0)
    if (cols <= 0) break
    const sysTop = sys * (perSys + gapR)

    // Loudness per cell and stem, then band heights: prominence x how much it plays here.
    const E = ORDER.map((stem) => {
      const e = new Float32Array(cols)
      for (let j = 0; j < cols; j++) e[j] = loud(R, R.parts[stem], stepAt(g0 + j), stepAt(g0 + j + 1))
      return e
    })
    // Heights from what this system of the window holds: each stem's loudness summed over its cells.
    const weights = ORDER.map((_, i) => E[i].reduce((a, v) => a + (v >= p.quiet ? v : 0), 0) / cols)
    const wsum = weights.reduce((a, b) => a + b, 0)
    const spare = perSys - B * minRows
    const exact = weights.map((w) => (wsum > 0 ? (w / wsum) * spare : spare / B))
    const rows = exact.map((e) => minRows + Math.floor(e))
    const order = exact.map((e, i) => [e - Math.floor(e), i]).sort((a, b) => b[0] - a[0] || a[1] - b[1])
    const leftover = perSys - rows.reduce((a, b) => a + b, 0)
    for (let k = 0; k < leftover; k++) rows[order[k % B][1]]++

    let r0 = sysTop
    ORDER.forEach((stem, bi) => {
      curStem = bi
      const part = R.parts[stem]
      const e = E[bi]
      const Rb = rows[bi]
      const rA = r0
      r0 += Rb
      const hueAt = (j: number) => hueOf(stem, secOfCol[g0 + j])

      // Fields: the palest tint under each stretch it plays (split where the hue changes).
      for (let j = 0; j < cols; ) {
        let k = j
        const on = e[j] >= p.quiet
        while (k < cols && e[k] >= p.quiet === on && hueAt(k) === hueAt(j)) k++
        if (on && p.field > 0) {
          let mean = 0
          for (let i = j; i < k; i++) mean += e[i]
          mean /= k - j
          const hue = hueAt(j)
          bar(rect(j, k, rA, rA + Rb - 1), hue, T50, p.field * LEDGER_TINT[hue] * (0.6 + 0.4 * mean))
        }
        j = k
      }

      // What covers each cell: 0 field, 1 loud section, 2 note group, 3 a note, 4 accent.
      const level = new Uint8Array(Rb * cols)
      const dense = new Int16Array(Rb * cols)
      const depth = new Float32Array(Rb * cols)
      const cover = (c0: number, c1: number, ra: number, rb: number, lv: number, glyph = 0, t = 0) => {
        for (let r = Math.max(0, ra); r <= Math.min(Rb - 1, rb); r++) {
          for (let c = Math.max(0, c0); c < Math.min(cols, c1); c++) {
            const i = r * cols + c
            if (lv >= level[i]) {
              level[i] = lv
              if (lv === 3) {
                dense[i] = glyph
                depth[i] = t
              }
            }
          }
        }
      }

      // Loud sections: a block as tall as the section is loud, standing on the band's floor.
      R.sections.forEach((a, k) => {
        const b = R.sections[k + 1] ?? R.len
        const l = loud(R, part, a, b)
        if (l < p.sectionCut) return
        const c0 = Math.max(0, Math.round(colAt(a)) - g0), c1 = Math.min(cols, Math.round(colAt(b)) - g0)
        if (c1 <= c0) return
        const h = clamp(Math.round(Rb * l), 1, Rb)
        const hue = hueOf(stem, k - firstSec)
        bar(rect(c0, c1, rA + Rb - h, rA + Rb - 1), hue, 0.1, p.blocks * LEDGER_TINT[hue] * 0.6)
        cover(c0, c1, Rb - h, Rb - 1, 1)
      })

      // Notes in this system as cells: pitch -> row, velocity -> height.
      const range = V.range[stem]
      const placed: { c0: number; c1: number; ra: number; rb: number; v: number; d: number; t: number; bar: number }[] = []
      for (const n of comp.notes) {
        if (n.stem !== stem) continue
        const a = Math.floor(colAt(n.step)) - g0
        const b = Math.max(a + 1, Math.round(colAt(n.step + Math.max(1, n.length))) - g0)
        if (b <= 0 || a >= cols) continue
        const u = isDrums(stem) ? LANE[n.voice] ?? 0.5 : range ? norm(n.pitch, range) : 0.5
        const h = Rb >= 3 ? clamp(Math.round(Rb * (0.12 + 0.25 * n.velocity)), 1, Rb) : 1
        const ra = Math.round((1 - u) * (Rb - h))
        // Dense character by pitch class (drums: by voice), so a pitch keeps its mark.
        const d = isDrums(stem) ? Object.keys(LANE).indexOf(n.voice) + 1 : n.pitch
        // Its cells' depth: a hit prints toward 500, a held note paler.
        const t = 0.28 + 0.25 * n.velocity * clamp(1.6 / Math.sqrt(Math.max(1, n.length)), 0.15, 1)
        const dd = ((d % set.dense.length) + set.dense.length) % set.dense.length
        placed.push({ c0: Math.max(0, a), c1: Math.min(cols, b), ra, rb: ra + h - 1, v: n.velocity, d: dd, t, bar: Math.floor(n.step / 16) })
      }
      placed.sort((x, y) => x.c0 - y.c0 || x.ra - y.ra)

      // Note groups: notes in one bar whose cells run on (within groupGap) -> a block over their span and range,
      // 200 where the bar is new material, paler where it repeats an earlier bar.
      for (let i = 0; i < placed.length; ) {
        let k = i + 1, end = placed[i].c1
        while (k < placed.length && placed[k].bar === placed[i].bar && placed[k].c0 <= end + p.groupGap) end = Math.max(end, placed[k++].c1)
        const g = placed.slice(i, k)
        let ra = Rb, rb = 0, loudest = g[0]
        for (const q of g) {
          ra = Math.min(ra, q.ra)
          rb = Math.max(rb, q.rb)
          if (q.v > loudest.v) loudest = q
        }
        const c0 = g[0].c0
        const hue = hueAt(c0)
        const fresh = (R.repeats[g[0].bar] ?? g[0].bar) === g[0].bar
        bar(rect(c0, end, rA + ra, rA + rb), hue, fresh ? T200 : 0.12, p.blocks * LEDGER_TINT[hue])
        cover(c0, end, ra, rb, 2)
        for (const q of g) cover(q.c0, q.c1, q.ra, q.rb, 3, q.d, q.t)
        // A small dark accent on the loudest note of new material, if it's loud enough.
        if (fresh && loudest.v >= p.accent) {
          const c1 = Math.min(loudest.c1, loudest.c0 + 2), r1 = Math.min(loudest.rb, loudest.ra + 1)
          bar(rect(loudest.c0, c1, rA + loudest.ra, rA + r1), hue, T1200, p.blocks)
          cover(loudest.c0, c1, loudest.ra, r1, 4)
        }
        i = k
      }

      // The character texture.
      const F = set.field.length
      for (let r = 0; r < Rb; r++) {
        const y = top - (rA + r + 0.5) * ch
        for (let j = 0; j < cols; j++) {
          const i = r * cols + j
          const lv = level[i]
          const v = e[j]
          if (lv === 0) {
            // Field: loud sets every cell, medium every other column, quiet and silent ever sparser.
            if (v >= p.dense) { /* every cell */ }
            else if (v >= p.quiet) { if (j % 2) continue }
            else if (v > 0.01) { if (j % sparse || (Rb > 2 && r % 2)) continue }
            else if (j % (sparse * 2) || r % Math.max(2, Math.ceil(Rb / 2))) continue
          }
          const hue = hueAt(j)
          const b = Math.min(bars - 1, Math.floor(stepAt(g0 + j + 0.5) / 16))
          const fc = V.char[stem][b] + (V.wide[stem] && j % 2 ? 1 : 0)
          let char: number, t: number, alpha: number
          switch (lv) {
            case 4: char = -1 - dense[i]; t = T50; alpha = 0.9; break
            case 3: char = -1 - dense[i]; t = depth[i]; alpha = 0.95; break
            case 2: char = Math.min(F - 1, fc + 3); t = 0.4; alpha = 0.8; break
            case 1: char = fc; t = 0.35; alpha = 0.75; break
            default:
              char = fc
              t = 0.25 + 0.25 * Math.min(1, v / Math.max(0.01, p.dense))
              alpha = v < p.quiet ? (v > 0.01 ? 0.35 : 0.2) : 0.5 + 0.4 * Math.min(1, v / Math.max(0.01, p.dense))
          }
          cells.push({ char, x: left + (j + 0.5) * cw, y, rgb: rampColor(hue, t), alpha, bleed: p.weight * (lv >= 3 ? 1 : Math.min(1, v)), stem: bi })
        }
      }
    })
  }
  return { marks, cells, size: ch * p.glyph }
}

/** The page's glyphs as instance data, ready to copy into the layer each frame. */
interface Baked {
  count: number
  pos: Float32Array
  uv: Float32Array
  size: Float32Array
  color: Float32Array
  fx: Float32Array
  stems: Int8Array
}

function bake(page: Page, set: { field: string; dense: string }, glyphOf: Map<string, ShapedGlyph>, fontSize: number, cap: number): Baked {
  const n = Math.min(cap, page.cells.length)
  const b: Baked = { count: 0, pos: new Float32Array(n * 4), uv: new Float32Array(n * 4), size: new Float32Array(n * 4), color: new Float32Array(n * 4), fx: new Float32Array(n * 4), stems: new Int8Array(n) }
  const scale = page.size / (fontSize || 1)
  let i = 0
  for (const c of page.cells) {
    if (i >= n) break
    const g = glyphOf.get(c.char >= 0 ? set.field[c.char] : set.dense[-1 - c.char])
    if (!g) continue
    const o = i * 4
    // Centre the ink in the cell (the quad is centred on the ink box).
    b.pos.set([c.x, c.y, g.k, scale], o)
    b.uv.set([g.u0, g.v0, g.u1, g.v1], o)
    b.size.set([g.w, g.h, 0, 0], o)
    b.color.set([c.rgb[0], c.rgb[1], c.rgb[2], c.alpha], o)
    b.fx.set([c.bleed, 0, 0, 0], o)
    b.stems[i] = c.stem
    i++
  }
  b.count = i
  return b
}

function copy(layer: GlyphLayer, b: Baked) {
  const n = Math.min(b.count, layer.capacity) * 4
  layer.pos.set(b.pos.subarray(0, n))
  layer.uv.set(b.uv.subarray(0, n))
  layer.size.set(b.size.subarray(0, n))
  layer.color.set(b.color.subarray(0, n))
  layer.fx.set(b.fx.subarray(0, n))
  layer.stems.set(b.stems.subarray(0, n / 4))
  layer.count = n / 4
}

function create(): SubInstance {
  let page: Page = { marks: [], cells: [], size: 1 }
  let baked: Baked | null = null
  let key = ''
  let shaped: ShapedGlyph[] = []

  return {
    update(frame, comp, p) {
      const { layers, viewport } = frame
      const W = viewport.width, H = viewport.height
      const set = charsetOf(p)
      const cap = layers.outlines.capacity
      const k = `${comp.version}:${W}x${H}:${JSON.stringify(p)}`
      if (k !== key) {
        key = k
        baked = null
        const R = read(comp)
        const [w0, w1] = windowOf(R, p)
        const V = voicing(comp, R, set.field.length, w0, w1)
        // Taller cells (fewer rows) until the texture fits the glyph layer; columns stay as asked.
        for (let aspect = p.aspect, tries = 0; ; aspect *= 1.1, tries++) {
          page = generate(comp, R, V, p, W, H, aspect)
          if (page.cells.length <= cap || tries > 30) break
        }
      }

      // Glyph quads for the sets, in the current font (re-baked if it changes).
      const glyphs = frame.glyphsFor(set.field + set.dense)
      if (glyphs !== shaped || !baked) {
        shaped = glyphs
        baked = bake(page, set, new Map(glyphs.map((g) => [g.char, g])), frame.text.fontSize, cap)
      }

      const bars = layers.bars
      bars.blend = 'normal'
      for (const h of HUES) bars.setGradient(RAMPS[h], ROW(h))
      layers.grain.value = p.grain
      for (const spec of page.marks) if (!bars.push(spec)) break
      copy(layers.outlines, baked)
    },
  }
}

export const ledger: SubMode = {
  id: 'ledger',
  label: 'Ledger',
  params,
  groups,
  presets: {
    // The whole song in four systems, a hue per stem.
    Default: { params: {}, background: '#f6f5f1', ink: '#121317' },
    // Each section of the song in the next Google hue.
    Sections: { params: { palette: 'sections' }, background: '#f6f5f1', ink: '#121317' },
    // Finer: more columns, more systems.
    Fine: { params: { columns: 1600, systems: 8, aspect: 1.4 }, background: '#f6f5f1', ink: '#121317' },
    // Close-up: eight bars from the second section, a column per step.
    'Close-up': { params: { from: 16, span: 8, snap: true, columns: 256, systems: 2, aspect: 1.35 }, background: '#f6f5f1', ink: '#121317' },
    // Blue only, hatch marks, on white.
    Hatch: { params: { palette: 'mono', chars: 'hatch', field: 0.45 }, background: '#ffffff', ink: '#121317' },
  },
  create,
}
