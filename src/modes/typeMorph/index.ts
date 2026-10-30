import { Color } from 'three/webgpu'
import { BAND_COUNT } from '../../audio/features'
import type { ParamSchema } from '../../app/params'
import type { BarLayer, BarSpec } from '../../engine/barLayer'
import type { FrameContext, ModeDefinition, ModeInstance, ModePreset } from '../types'
import { writeGlyph, writeHalo, writeOutline } from '../shared/glyphs'
import { dotShapeKeys, dotShapeParams, noise, shapeDot, shapesDots } from '../shared/dotShape'
import { rasterise } from '../typeDots'

// Type Morph: the typed text handing over to a pattern built from its own
// letters, and back, as a wipe that travels across the block:
//   pattern   what the letters become, sampled on a square grid of `pitch`:
//               dots     a dot per inked cell, big at the heart of a stroke,
//                        small at its edge (as Type → Dots), ghosts around
//               roll     each row a lane; runs of ink become notes, rounded
//                        bars like a piano roll (split into shorter notes)
//               barcode  each column a line; runs become vertical bars, their
//                        weight by how deep in the stroke they sit
//   cycle     type -> wipe in -> pattern -> wipe out, timed in bars of the
//             music (free-running at 120 bpm when nothing plays), in seconds,
//             stepped on by onsets, following loudness, or scrubbed by hand
//   wipe      the front's direction (or radial, reading order, a noise field,
//             per lane), its width, how much whole letters move together,
//             and a drifting noise that ruffles it
//   morph     what happens in the front: goo (letter and marks blurred and
//             cut at half, metaball-like), grow, draw (notes and bars drawn
//             out along their length), streak (pulled out along the wipe),
//             fall (arriving from behind the front); the letter blurs away
//   colour    one gradient across the marks: across / down / by contour
//             (layers inside the strokes) / per line / per lane / along the
//             wipe, optionally stepped into flat layers, flowing with time;
//             under it the field (the same marks blurred and cut at half), so
//             the colours merge into clean letter-shaped pools
//   motion    in the pattern: a scanning playhead, spectrum bands per lane,
//             a travelling wave, onset pulses, breathing with loudness

const clamp01 = (v: number) => Math.min(1, Math.max(0, v))
const lerp = (a: number, b: number, t: number) => a + (b - a) * t
const smooth01 = (x: number) => { const t = clamp01(x); return t * t * (3 - 2 * t) }
const band = (a: number, b: number, x: number) => smooth01((x - a) / (b - a))
const hash = (a: number, b: number, c: number) => { const h = Math.sin(a * 127.1 + b * 311.7 + c * 74.7) * 43758.5453; return h - Math.floor(h) }
const easeOutBack = (t: number) => { const c = 1.4; const u = t - 1; return 1 + (c + 1) * u * u * u + c * u * u }

/** Marks a layer holds (4096). */
const BUDGET = 3600
/** Gradient rows this mode's ramps take on the bar layers. */
const ROW = 40

const RAMPS: Record<string, string[]> = {
  aurora: ['#a77ff0', '#22aee8', '#efe23c', '#0f8a43'],
  lagoon: ['#173f73', '#2e86de', '#5fd3f3', '#c6f2d2'],
  neon: ['#1626ff', '#3d6bff', '#79b6ff', '#e0efff'],
  ember: ['#3b0d4a', '#d7263d', '#f46036', '#fcd34d'],
  spectrum: ['#ff3b6b', '#ffb800', '#21c37a', '#2f80ff', '#a855f7'],
}
const RAMP_IDS = [...Object.keys(RAMPS), 'ink', 'custom']

const on = (...is: string[]) => ({ showIf: { key: 'pattern', is } })

const params: ParamSchema = {
  pattern: { type: 'select', value: 'dots', label: 'pattern', options: { Dots: 'dots', 'Roll (piano roll)': 'roll', Barcode: 'barcode' } },
  pitch: { type: 'number', value: 4, min: 3, max: 40, step: 0.5, label: 'grid pitch (px)' },
  sub: { type: 'number', value: 4, min: 1, max: 8, step: 1, label: 'samples per cell' },
  inside: { type: 'number', value: 0.35, min: 0.05, max: 0.95, step: 0.01, label: 'ink if above' },
  depthRange: { type: 'number', value: 3, min: 1, max: 12, step: 0.5, label: 'stroke depth (cells)' },

  dotMin: { type: 'number', value: 0.12, min: 0.02, max: 0.4, step: 0.005, label: 'ghost dot (of pitch)', ...on('dots') },
  dotEdge: { type: 'number', value: 0.3, min: 0.05, max: 0.6, step: 0.005, label: 'edge dot', ...on('dots') },
  dotCore: { type: 'number', value: 0.5, min: 0.1, max: 0.9, step: 0.005, label: 'core dot', ...on('dots') },
  pad: { type: 'number', value: 2, min: 0, max: 20, step: 1, label: 'ghosts around letters (cells)', ...on('dots') },
  ghost: { type: 'number', value: 0.35, min: 0, max: 1, step: 0.01, label: 'ghost dots', ...on('dots') },
  ...Object.fromEntries(Object.entries(dotShapeParams).map(([k, d]) => [k, { ...d, ...on('dots') }])),

  laneFill: { type: 'number', value: 0.62, min: 0.05, max: 1, step: 0.01, label: 'note height (of lane)', ...on('roll') },
  barMin: { type: 'number', value: 0.25, min: 0.02, max: 1, step: 0.01, label: 'hairline (of pitch)', ...on('barcode') },
  barMax: { type: 'number', value: 0.9, min: 0.1, max: 1.5, step: 0.01, label: 'heavy (of pitch)', ...on('barcode') },
  steps: { type: 'number', value: 3, min: 0, max: 6, step: 1, label: 'weights (0 = smooth)', ...on('barcode') },
  tails: { type: 'number', value: 0.15, min: 0, max: 1, step: 0.01, label: 'bars run on past letters', ...on('barcode') },
  round: { type: 'number', value: 1, min: 0, max: 1, step: 0.01, label: 'roundness', ...on('roll', 'barcode') },
  gap: { type: 'number', value: 1, min: 0, max: 12, step: 0.5, label: 'gap between notes (px)', ...on('roll', 'barcode') },
  split: { type: 'number', value: 0.12, min: 0, max: 1, step: 0.01, label: 'split into shorter notes', ...on('roll', 'barcode') },
  minRun: { type: 'number', value: 2, min: 1, max: 12, step: 1, label: 'shortest note (cells)', ...on('roll', 'barcode') },
  guides: { type: 'number', value: 0.12, min: 0, max: 1, step: 0.01, label: 'lane lines', ...on('roll') },

  drive: {
    type: 'select', value: 'bars', label: 'cycle by',
    options: { 'bars of the music': 'bars', seconds: 'time', onsets: 'onsets', loudness: 'loudness', 'hand (scrub)': 'manual' },
  },
  typeHold: { type: 'number', value: 2, min: 0, max: 16, step: 0.25, label: 'hold as type (bars / s)' },
  wipeIn: { type: 'number', value: 1, min: 0.1, max: 16, step: 0.05, label: 'wipe to pattern (bars / s)' },
  patternHold: { type: 'number', value: 2, min: 0, max: 16, step: 0.25, label: 'hold as pattern (bars / s)' },
  wipeOut: { type: 'number', value: 1, min: 0.1, max: 16, step: 0.05, label: 'wipe back (bars / s)' },
  back: { type: 'select', value: 'through', label: 'wipe back', options: { 'on through (same way)': 'through', 'reverse (retreat)': 'reverse' } },
  progress: { type: 'number', value: 0.5, min: 0, max: 1, step: 0.001, label: 'type → pattern', showIf: { key: 'drive', is: 'manual' } },
  onsetAt: { type: 'number', value: 0.6, min: 0, max: 1, step: 0.01, label: 'onset strength to step', showIf: { key: 'drive', is: 'onsets' } },
  loudLow: { type: 'number', value: 0.25, min: 0, max: 1, step: 0.01, label: 'all type below', showIf: { key: 'drive', is: 'loudness' } },
  loudHigh: { type: 'number', value: 0.7, min: 0, max: 1, step: 0.01, label: 'all pattern above', showIf: { key: 'drive', is: 'loudness' } },

  wipe: {
    type: 'select', value: 'right', label: 'wipe',
    options: {
      'left → right': 'right', 'right → left': 'left', 'top → down': 'down', 'bottom → up': 'up', diagonal: 'diagonal',
      'radial out': 'out', 'radial in': 'in', 'reading order': 'reading', 'per lane': 'lanes', 'noise field': 'noise',
    },
  },
  width: { type: 'number', value: 0.35, min: 0.02, max: 1.5, step: 0.01, label: 'front width' },
  glyphLock: { type: 'number', value: 0.4, min: 0, max: 1, step: 0.01, label: 'letters move together' },
  jitter: { type: 'number', value: 0.08, min: 0, max: 0.6, step: 0.01, label: 'ruffle the front' },
  jitterScale: { type: 'number', value: 90, min: 10, max: 600, step: 1, label: 'ruffle scale (px)' },
  jitterLive: { type: 'number', value: 0.5, min: 0, max: 2, step: 0.01, label: 'ruffle with loudness' },

  morph: {
    type: 'select', value: 'flow', label: 'morph',
    options: { 'flow (swirl into place)': 'flow', 'goo (metaball)': 'goo', grow: 'grow', 'draw out': 'draw', 'streak along the wipe': 'streak', 'fall into place': 'fall' },
  },
  lag: { type: 'number', value: 0.35, min: 0.05, max: 2, step: 0.01, label: 'ease (s)' },
  stagger: { type: 'number', value: 0.6, min: 0, max: 1, step: 0.01, label: 'ease varies' },
  swirl: { type: 'number', value: 160, min: 20, max: 800, step: 1, label: 'swirl scale (px)' },
  bulge: { type: 'number', value: 0.3, min: 0, max: 2, step: 0.01, label: 'swell in the front' },
  stretchIn: { type: 'number', value: 3, min: 0, max: 20, step: 0.1, label: 'streak length (×)' },
  travel: { type: 'number', value: 40, min: 0, max: 400, step: 1, label: 'travel (px)' },
  scatter: { type: 'number', value: 0, min: 0, max: 1, step: 0.01, label: 'scatter' },
  gooBlur: { type: 'number', value: 2, min: 0.5, max: 16, step: 0.1, label: 'goo blur (px)' },
  gooFill: { type: 'number', value: 1.1, min: 1, max: 4, step: 0.05, label: 'goo fill' },
  typeBlur: { type: 'number', value: 8, min: 0, max: 30, step: 0.5, label: 'letter blurs away (px)' },
  melt: { type: 'number', value: 1.5, min: -4, max: 8, step: 0.1, label: 'letter swells as it goes (px)' },
  keepType: { type: 'number', value: 0, min: 0, max: 1, step: 0.01, label: 'type left under pattern' },

  ramp: { type: 'select', value: 'aurora', label: 'colours', options: Object.fromEntries(RAMP_IDS.map((r) => [r, r])) },
  c1: { type: 'color', value: '#a77ff0', label: 'colour 1', showIf: { key: 'ramp', is: 'custom' } },
  c2: { type: 'color', value: '#22aee8', label: 'colour 2', showIf: { key: 'ramp', is: 'custom' } },
  c3: { type: 'color', value: '#efe23c', label: 'colour 3', showIf: { key: 'ramp', is: 'custom' } },
  c4: { type: 'color', value: '#0f8a43', label: 'colour 4', showIf: { key: 'ramp', is: 'custom' } },
  colourBy: {
    type: 'select', value: 'mix', label: 'colour by',
    options: { 'across + contour': 'mix', across: 'across', down: 'down', 'contour (layers in the stroke)': 'contour', 'per line': 'lines', 'per lane': 'lanes', 'along the wipe': 'wipe' },
  },
  spread: { type: 'number', value: 1, min: 0, max: 3, step: 0.01, label: 'gradient spread' },
  layersN: { type: 'number', value: 0, min: 0, max: 8, step: 1, label: 'colour layers (0 = smooth)' },
  flow: { type: 'number', value: 0.02, min: -1, max: 1, step: 0.005, label: 'colour flow' },
  crisp: { type: 'number', value: 1, min: 0, max: 1, step: 0.01, label: 'crisp marks' },

  fieldOpacity: { type: 'number', value: 0.9, min: 0, max: 3, step: 0.01, label: 'colour field' },
  fieldBlur: { type: 'number', value: 2.5, min: 0, max: 40, step: 0.5, label: 'field blur (px)' },
  fieldGain: { type: 'number', value: 2, min: 1, max: 12, step: 0.1, label: 'field fill' },
  fieldEdge: { type: 'number', value: 0.85, min: 0, max: 1, step: 0.01, label: 'field edge (0 = glow, 1 = clean)' },
  fieldStretch: { type: 'number', value: 1, min: 1, max: 8, step: 0.1, label: 'field stretch (across)' },
  fieldFill: { type: 'number', value: 1, min: 0, max: 3, step: 0.01, label: 'field mark size (cells)' },
  fieldShift: { type: 'number', value: 0.15, min: -1, max: 1, step: 0.01, label: 'field colour shift' },

  smoke: { type: 'number', value: 0.7, min: 0, max: 2, step: 0.01, label: 'smoke left by the front' },
  smokeLetters: { type: 'number', value: 0.5, min: 0, max: 2, step: 0.01, label: 'letters melt into smoke' },
  smokeLast: { type: 'number', value: 1.4, min: 0.1, max: 8, step: 0.05, label: 'smoke lasts (s)' },
  smokeFlow: { type: 'number', value: 70, min: 0, max: 400, step: 1, label: 'smoke flow (px/s)' },
  smokeScale: { type: 'number', value: 180, min: 20, max: 800, step: 1, label: 'smoke eddies (px)' },
  smokeSpread: { type: 'number', value: 1.4, min: 0, max: 6, step: 0.05, label: 'smoke softens (px / frame)' },
  wind: { type: 'select', value: 'along', label: 'wind', options: { 'with the wipe': 'along', still: 'none', up: 'up', down: 'down', left: 'left', right: 'right', outward: 'outward' } },
  windSpeed: { type: 'number', value: 40, min: 0, max: 400, step: 1, label: 'wind (px/s)' },
  smokeLive: { type: 'number', value: 0.8, min: 0, max: 3, step: 0.01, label: 'smoke stirs with the music' },

  scan: { type: 'number', value: 0, min: 0, max: 1, step: 0.01, label: 'scanning playhead' },
  scanBars: { type: 'number', value: 1, min: 0.25, max: 8, step: 0.25, label: 'scan pass (bars)' },
  bands: { type: 'number', value: 0, min: 0, max: 1, step: 0.01, label: 'spectrum per lane' },
  wave: { type: 'number', value: 0, min: 0, max: 1, step: 0.01, label: 'travelling wave' },
  waveLength: { type: 'number', value: 260, min: 20, max: 1200, step: 1, label: 'wave length (px)' },
  pulse: { type: 'number', value: 0.3, min: 0, max: 1, step: 0.01, label: 'onset pulse' },
  breathe: { type: 'number', value: 0.2, min: 0, max: 1, step: 0.01, label: 'breathe with loudness' },
}

const groups: Record<string, string[]> = {
  Pattern: ['pattern', 'pitch', 'sub', 'inside', 'depthRange'],
  Marks: ['dotMin', 'dotEdge', 'dotCore', 'pad', 'ghost', 'laneFill', 'barMin', 'barMax', 'steps', 'tails', 'round', 'gap', 'split', 'minRun', 'guides'],
  'Dot shape': dotShapeKeys,
  Cycle: ['drive', 'typeHold', 'wipeIn', 'patternHold', 'wipeOut', 'back', 'progress', 'onsetAt', 'loudLow', 'loudHigh'],
  Wipe: ['wipe', 'width', 'glyphLock', 'jitter', 'jitterScale', 'jitterLive'],
  Morph: ['morph', 'lag', 'stagger', 'swirl', 'bulge', 'stretchIn', 'travel', 'scatter', 'gooBlur', 'gooFill', 'typeBlur', 'melt', 'keepType'],
  Smoke: ['smoke', 'smokeLetters', 'smokeLast', 'smokeFlow', 'smokeScale', 'smokeSpread', 'wind', 'windSpeed', 'smokeLive'],
  Colour: ['ramp', 'c1', 'c2', 'c3', 'c4', 'colourBy', 'spread', 'layersN', 'flow', 'crisp'],
  Field: ['fieldOpacity', 'fieldBlur', 'fieldGain', 'fieldEdge', 'fieldStretch', 'fieldFill', 'fieldShift'],
  Motion: ['scan', 'scanBars', 'bands', 'wave', 'waveLength', 'pulse', 'breathe'],
}

/** Settings that change the marks themselves (everything else only moves or colours them). */
const BUILD_KEYS = ['pattern', 'pitch', 'sub', 'inside', 'depthRange', 'dotMin', 'dotEdge', 'dotCore', 'pad', 'ghost', 'laneFill', 'barMin', 'barMax', 'steps', 'tails', 'gap', 'split', 'minRun']

interface Mark {
  x: number; y: number; w: number; h: number
  /** 0..1 how deep in the stroke (0 = ghost / edge). */
  lv: number
  ghost: boolean
  /** Glyph (index), line, lane (row) and column it belongs to. */
  gi: number
  line: number
  lane: number
  col: number
}

interface Picture {
  marks: Mark[]
  /** Lane lines (roll): y and x extent. */
  guides: { y: number; x0: number; x1: number }[]
  pitch: number
  rows: number
  cols: number
  /** Extent of the marks. */
  x0: number; x1: number; y0: number; y1: number
}

/** Cells (chamfer) from each ink cell to the nearest blank one. */
function depthField(ink: Uint8Array, cols: number, rows: number) {
  const d = new Float32Array(cols * rows)
  const BIG = 1e6
  for (let i = 0; i < d.length; i++) d[i] = ink[i] ? BIG : 0
  const at = (c: number, r: number) => (c < 0 || r < 0 || c >= cols || r >= rows ? 0 : d[r * cols + c])
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c
      if (!d[i]) continue
      d[i] = Math.min(d[i], at(c - 1, r) + 1, at(c, r - 1) + 1, at(c - 1, r - 1) + 1.4142, at(c + 1, r - 1) + 1.4142)
    }
  for (let r = rows - 1; r >= 0; r--)
    for (let c = cols - 1; c >= 0; c--) {
      const i = r * cols + c
      if (!d[i]) continue
      d[i] = Math.min(d[i], at(c + 1, r) + 1, at(c, r + 1) + 1, at(c + 1, r + 1) + 1.4142, at(c - 1, r + 1) + 1.4142)
    }
  return d
}

function generate(frame: FrameContext, p: Record<string, any>): Picture {
  const { text, base, viewport } = frame
  const W = viewport.width, H = viewport.height
  const sub = Math.max(1, Math.round(p.sub))
  let pitch = Math.max(2, p.pitch)
  let cols = 0, rows = 0, ink = new Uint8Array(0)
  // Coarsen the grid until the marks fit the layers.
  for (let tries = 0; tries < 12; tries++) {
    cols = Math.max(1, Math.floor(W / pitch))
    rows = Math.max(1, Math.floor(H / pitch))
    const cover = rasterise(frame, 1, cols, rows, pitch, sub)
    ink = new Uint8Array(cols * rows)
    let n = 0
    for (let i = 0; i < ink.length; i++) if (cover[i] >= p.inside) { ink[i] = 1; n++ }
    const est = p.pattern === 'dots' ? n * (1 + (p.ghost > 0 ? Math.min(3, p.pad * 0.6) : 0)) : n / Math.max(1, p.minRun)
    if (est <= BUDGET) break
    pitch *= Math.sqrt(est / BUDGET) * 1.02
  }
  const depth = depthField(ink, cols, rows)
  // Depth 0..1 up to `depthRange` cells, or the thickest stroke if thinner (so thin type still spans the colours).
  let deepest = 1
  for (let i = 0; i < depth.length; i++) deepest = Math.max(deepest, depth[i])
  const range = Math.max(0.5, Math.min(p.depthRange, deepest) - 1)
  const lvAt = (c: number, r: number) => clamp01((depth[r * cols + c] - 1) / range)
  const X = (c: number) => (c + 0.5 - cols / 2) * pitch
  const Y = (r: number) => (rows / 2 - r - 0.5) * pitch

  // Nearest glyph per position (for letters moving together and per-line colour).
  const centres = text.glyphs.map((g) => ({ i: g.index, line: g.line, x: base[g.index]?.x ?? 0, y: base[g.index]?.y ?? 0 }))
  const glyphAt = (x: number, y: number) => {
    let best = centres[0], bd = Infinity
    for (const g of centres) {
      const d = (g.x - x) ** 2 + (g.y - y) ** 2
      if (d < bd) { bd = d; best = g }
    }
    return best ?? { i: 0, line: 0, x: 0, y: 0 }
  }

  const marks: Mark[] = []
  const guides: Picture['guides'] = []
  const add = (m: Omit<Mark, 'gi' | 'line'>) => {
    const g = glyphAt(m.x, m.y)
    marks.push({ ...m, gi: g.i, line: g.line })
  }

  if (p.pattern === 'dots') {
    // Ghosts: blank cells within `pad` of ink (square reach).
    const pad = p.ghost > 0 ? Math.round(p.pad) : 0
    for (let r = 0; r < rows; r++)
      for (let c = 0; c < cols; c++) {
        const i = r * cols + c
        if (ink[i]) {
          const lv = lvAt(c, r)
          const rad = lerp(p.dotEdge, p.dotCore, lv) * pitch
          add({ x: X(c), y: Y(r), w: 2 * rad, h: 2 * rad, lv, ghost: false, lane: r, col: c })
          continue
        }
        if (!pad) continue
        let near = false
        for (let j = -pad; j <= pad && !near; j++) for (let k = -pad; k <= pad; k++) {
          const cc = c + k, rr = r + j
          if (cc >= 0 && rr >= 0 && cc < cols && rr < rows && ink[rr * cols + cc]) { near = true; break }
        }
        if (near && marks.length < BUDGET) {
          const rad = p.dotMin * pitch
          add({ x: X(c), y: Y(r), w: 2 * rad, h: 2 * rad, lv: 0, ghost: true, lane: r, col: c })
        }
      }
  } else {
    // Runs of ink along a lane (roll: rows; barcode: columns), broken into notes.
    const roll = p.pattern === 'roll'
    const lanes = roll ? rows : cols, along = roll ? cols : rows
    const cell = (lane: number, k: number) => (roll ? lane * cols + k : k * cols + lane)
    const minRun = Math.max(1, Math.round(p.minRun))
    const weight = (lv: number) => {
      const n = Math.round(p.steps)
      const q = n > 0 ? Math.round(lv * n) / n : lv
      return lerp(p.barMin, p.barMax, q)
    }
    for (let lane = 0; lane < lanes; lane++) {
      let start = -1, sum = 0
      let first = Infinity, last = -Infinity
      const close = (end: number) => {
        const len = end - start
        if (len <= 0) return
        const lv = sum / len
        const k0 = start, k1 = end
        if (roll) {
          const x0 = X(k0) - pitch / 2, x1 = X(k1 - 1) + pitch / 2
          const w = Math.max(pitch * 0.5, x1 - x0 - p.gap)
          add({ x: (x0 + x1) / 2, y: Y(lane), w, h: pitch * p.laneFill * lerp(0.75, 1, lv), lv, ghost: false, lane, col: k0 })
        } else {
          let y1 = Y(k0) + pitch / 2, y0 = Y(k1 - 1) - pitch / 2
          // Some bars run on past the letters, as a barcode's guard bars do.
          if (p.tails > 0 && hash(lane, k0, 3) < p.tails * 0.35) {
            const run = pitch * (2 + 10 * hash(lane, k0, 5))
            if (hash(lane, k0, 9) < 0.5) y0 -= run; else y1 += run
          }
          const h = Math.max(pitch * 0.5, y1 - y0 - p.gap)
          add({ x: X(lane), y: (y0 + y1) / 2, w: weight(lv) * pitch, h, lv, ghost: false, lane: k0, col: lane })
        }
        first = Math.min(first, k0); last = Math.max(last, k1)
      }
      for (let k = 0; k <= along; k++) {
        const inked = k < along && !!ink[cell(lane, k)]
        if (inked && start < 0) { start = k; sum = 0 }
        if (start >= 0 && (!inked || (k - start >= minRun && hash(lane, k, 1) < p.split * 0.5))) {
          close(k)
          start = inked ? k : -1
          sum = 0
        }
        if (inked) sum += lvAt(roll ? k : lane, roll ? lane : k)
      }
      if (roll && first < Infinity) guides.push({ y: Y(lane), x0: X(first) - pitch / 2, x1: X(last - 1) + pitch / 2 })
      if (marks.length >= BUDGET) break
    }
  }

  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity
  for (const m of marks) {
    x0 = Math.min(x0, m.x - m.w / 2); x1 = Math.max(x1, m.x + m.w / 2)
    y0 = Math.min(y0, m.y - m.h / 2); y1 = Math.max(y1, m.y + m.h / 2)
  }
  if (!marks.length) x0 = x1 = y0 = y1 = 0
  return { marks, guides, pitch, rows, cols, x0, x1, y0, y1 }
}

const hexOf = (c: Color) => '#' + c.getHexString()

/** Curl of the noise field at (x, y) in noise units: a swirl with no sources or sinks (about -2..2). */
function curl(x: number, y: number, z: number): [number, number] {
  const e = 0.35
  const dx = noise(x + e, y, z) - noise(x - e, y, z)
  const dy = noise(x, y + e, z) - noise(x, y - e, z)
  return [dy / (2 * e), -dx / (2 * e)]
}

/** A critically damped spring per item toward its target: eased, never overshooting much, never popping. */
class Springs {
  x = new Float32Array(0)
  v = new Float32Array(0)
  /** Per item: its time constant's share (so neighbours don't move in lockstep). */
  k = new Float32Array(0)
  ready = false
  size(n: number, seed: number) {
    if (this.x.length === n) return
    this.x = new Float32Array(n); this.v = new Float32Array(n)
    this.k = Float32Array.from({ length: n }, (_, i) => hash(i, seed, 13))
    this.ready = false
  }
  step(i: number, target: number, dt: number, lag: number, vary: number) {
    if (!this.ready) { this.x[i] = target; return target }
    const tau = Math.max(0.04, lag * (1 + vary * (this.k[i] * 1.4 - 0.7)))
    const w = 2 / tau
    // Sub-steps keep it stable when a frame runs long.
    const n = Math.max(1, Math.ceil((dt * w) / 0.5))
    const h = dt / n
    let x = this.x[i], v = this.v[i]
    for (let j = 0; j < n; j++) {
      v += (w * w * (target - x) - 2 * w * v) * h
      x += v * h
    }
    this.x[i] = x; this.v[i] = v
    return x
  }
}

/** A ramp's colour at t (mirrored past 0..1, as the bars read it), linear RGB. */
function rampRGB(stops: string[], t: number, out: Color): Color {
  let u = ((t % 2) + 2) % 2
  if (u > 1) u = 2 - u
  const f = u * (stops.length - 1)
  const i = Math.min(stops.length - 2, Math.floor(f))
  const a = new Color(stops[i]), b = new Color(stops[i + 1])
  return out.copy(a).lerp(b, f - i)
}

function create(): ModeInstance {
  let pic: Picture | null = null
  let key = ''
  const out: BarSpec[] = []
  const gooSpec: BarSpec = { x: 0, y: 0, w: 0, h: 0, t0: 0, t1: 0 }
  // The cycle: its own step clock (follows the music's, free-runs at 120 bpm when nothing plays).
  let steps = 0
  let lastPos = NaN
  let still = 0
  // Onsets / loudness drives.
  let stage: 'type' | 'in' | 'pattern' | 'out' = 'type'
  let stageT = 0
  let sinceStep = 0
  let loud = 0
  let pulseEnv = 0
  const scratch = new Color()
  const tint = new Color()
  const markS = new Springs()
  const maskS = new Springs()
  /** The letters' wipe mask grid (around the text) and each cell's glyph. */
  let mask = { cols: 1, rows: 1, x0: 0, y0: 0, pitch: 8, gi: new Int32Array(1) }

  return {
    update(frame) {
      const { layers, viewport, ink, params: p, text, base, audio, time, dt } = frame
      const W = viewport.width, H = viewport.height
      const { bars, glyphs, goo } = layers
      const field = layers.barsFar
      layers.grain.value = 0
      bars.blend = 'normal'
      if (!text.glyphs.length) { glyphs.count = 0; return }

      // Ramps: rows ROW (the chosen colours) and ROW + 1 (ink).
      const inkHex = hexOf(scratch.setRGB(ink[0], ink[1], ink[2]))
      const ramp = p.ramp === 'custom' ? [p.c1, p.c2, p.c3, p.c4] : p.ramp === 'ink' ? [inkHex, inkHex] : RAMPS[p.ramp] ?? RAMPS.aurora
      for (const layer of [bars, field.bars, goo.bars] as BarLayer[]) {
        layer.setGradient(ramp, ROW)
        layer.setGradient([inkHex, inkHex], ROW + 1)
      }

      const placed = base.reduce((s, b) => s + b.x * 1.3 + b.y * 0.7 + b.rotation + b.scale, 0)
      const k = `${frame.fontId}:${text.fontSize}:${text.glyphs.map((g) => g.char).join('')}:${placed.toFixed(2)}:${W}x${H}:${BUILD_KEYS.map((kk) => p[kk]).join(',')}`
      if (k !== key || !pic) {
        key = k
        pic = generate(frame, p)
        out.length = 0
        for (let i = 0; i < pic.marks.length; i++) out.push({ x: 0, y: 0, w: 0, h: 0, t0: 0, t1: 0 })
        markS.size(pic.marks.length, 1)
        markS.ready = false
        // Mask cells over the text (and a margin for blur and swell), ~8 px each, each with its nearest glyph.
        let bx0 = Infinity, bx1 = -Infinity, by0 = Infinity, by1 = -Infinity
        for (const g of text.glyphs) {
          const pl = base[g.index]
          if (!pl) continue
          const r = 0.5 * Math.hypot(g.w, g.h) * pl.scale
          bx0 = Math.min(bx0, pl.x - r); bx1 = Math.max(bx1, pl.x + r); by0 = Math.min(by0, pl.y - r); by1 = Math.max(by1, pl.y + r)
        }
        if (!Number.isFinite(bx0)) bx0 = bx1 = by0 = by1 = 0
        let mp = 8
        while (((bx1 - bx0) / mp + 4) * ((by1 - by0) / mp + 4) > 30000) mp *= 1.25
        const mc = Math.ceil((bx1 - bx0) / mp) + 4, mr = Math.ceil((by1 - by0) / mp) + 4
        const centres = text.glyphs.map((g) => ({ i: g.index, x: base[g.index]?.x ?? 0, y: base[g.index]?.y ?? 0 }))
        const gi = new Int32Array(mc * mr)
        for (let r = 0; r < mr; r++)
          for (let c = 0; c < mc; c++) {
            const x = bx0 - 2 * mp + (c + 0.5) * mp, y = by0 - 2 * mp + (r + 0.5) * mp
            let best = 0, bd = Infinity
            for (const g of centres) { const d = (g.x - x) ** 2 + (g.y - y) ** 2; if (d < bd) { bd = d; best = g.i } }
            gi[r * mc + c] = best
          }
        mask = { cols: mc, rows: mr, x0: bx0 - 2 * mp, y0: by0 - 2 * mp, pitch: mp, gi }
        glyphs.mask.resize(mc, mr)
        maskS.size(mc * mr, 2)
        maskS.ready = false
      }
      const P = pic

      // ---- The cycle: which way the front is going (in: type -> pattern; out: back) and how far, 0..1.
      let dir: 'in' | 'out' = 'in'
      let q = 0
      const lens = [p.typeHold, p.wipeIn, p.patternHold, p.wipeOut].map((v: number) => Math.max(0, v))
      const place = (t: number) => {
        // t in the cycle's units -> (dir, q)
        const total = lens[0] + Math.max(0.05, lens[1]) + lens[2] + Math.max(0.05, lens[3])
        let u = ((t % total) + total) % total
        if (u < lens[0]) return ['in', 0] as const
        u -= lens[0]
        if (u < Math.max(0.05, lens[1])) return ['in', smooth01(u / Math.max(0.05, lens[1]))] as const
        u -= Math.max(0.05, lens[1])
        if (u < lens[2]) return ['in', 1] as const
        u -= lens[2]
        return ['out', smooth01(u / Math.max(0.05, lens[3]))] as const
      }
      const pos = audio.beat.position
      if (pos !== lastPos && Number.isFinite(lastPos)) { steps += pos - lastPos; still = 0 } else {
        still += dt
        if (still > 0.25) steps += dt * 8
      }
      lastPos = pos
      if (p.drive === 'bars') [dir, q] = place(steps / 16)
      else if (p.drive === 'time') [dir, q] = place(time)
      else if (p.drive === 'manual') { dir = 'in'; q = clamp01(p.progress) }
      else if (p.drive === 'loudness') {
        loud += (audio.level - loud) * (1 - Math.exp(-dt / 0.35))
        dir = 'in'
        q = smooth01((loud - p.loudLow) / Math.max(0.01, p.loudHigh - p.loudLow))
      } else {
        // Onsets: a strong one steps on (type -> pattern -> type), each wipe over its seconds.
        sinceStep += dt
        stageT += dt
        const hit = audio.onset && audio.onsetStrength >= p.onsetAt && sinceStep > 0.35
        if (stage === 'type' && hit) { stage = 'in'; stageT = 0; sinceStep = 0 }
        else if (stage === 'pattern' && hit) { stage = 'out'; stageT = 0; sinceStep = 0 }
        if (stage === 'in' && stageT >= p.wipeIn) stage = 'pattern'
        if (stage === 'out' && stageT >= p.wipeOut) stage = 'type'
        if (stage === 'type') { dir = 'in'; q = 0 }
        else if (stage === 'pattern') { dir = 'in'; q = 1 }
        else if (stage === 'in') { dir = 'in'; q = smooth01(stageT / Math.max(0.05, p.wipeIn)) }
        else { dir = 'out'; q = smooth01(stageT / Math.max(0.05, p.wipeOut)) }
      }

      // ---- The wipe: each place's coordinate along it (0 = first reached .. 1 = last).
      const { x0, x1, y0, y1 } = P
      const sx = Math.max(1, x1 - x0), sy = Math.max(1, y1 - y0)
      const rmax = Math.max(1, Math.hypot(Math.max(-x0, x1), Math.max(-y0, y1)))
      const nGlyph = Math.max(1, text.glyphs.length)
      const ruffle = p.jitter * (1 + p.jitterLive * audio.level)
      const zs = time * 0.25
      const along = (x: number, y: number, gi: number, lane: number) => {
        let u: number
        switch (p.wipe) {
          case 'left': u = (x1 - x) / sx; break
          case 'down': u = (y1 - y) / sy; break
          case 'up': u = (y - y0) / sy; break
          case 'diagonal': u = 0.5 * ((x - x0) / sx + (y1 - y) / sy); break
          case 'out': u = Math.hypot(x, y) / rmax; break
          case 'in': u = 1 - Math.hypot(x, y) / rmax; break
          case 'reading': u = (gi + 0.5) / nGlyph; break
          case 'lanes': u = 0.55 * (x - x0) / sx + 0.45 * hash(lane, 0, 11); break
          case 'noise': u = clamp01(0.5 + 0.7 * noise(x / 220, y / 220, 3.7)); break
          default: u = (x - x0) / sx
        }
        if (ruffle > 0) u += ruffle * noise(x / Math.max(10, p.jitterScale), y / Math.max(10, p.jitterScale), zs)
        return u
      }
      const glyphU = new Map<number, number>()
      for (const g of text.glyphs) {
        const pl = base[g.index]
        if (pl) glyphU.set(g.index, along(pl.x, pl.y, g.index, 0))
      }
      const wd = Math.max(0.02, p.width)
      /** Whether the front, `f` (0..1) of the way across, has reached `u` (0..1 with the front's width). */
      const reached = (f: number, u: number) => smooth01((f * (1 + wd + 2 * ruffle) - ruffle - u) / wd)
      /** How far a place is from type (0) to pattern (1) now: back the way it came, or on through. */
      const sOf = (u: number) => (dir === 'in' ? reached(q, u) : p.back === 'reverse' ? reached(1 - q, u) : 1 - reached(q, u))

      // Which way the front travels here (for streak / fall).
      const wipeDir = (x: number, y: number): [number, number] => {
        switch (p.wipe) {
          case 'left': return [-1, 0]
          case 'down': return [0, -1]
          case 'up': return [0, 1]
          case 'diagonal': return [Math.SQRT1_2, -Math.SQRT1_2]
          case 'out': case 'in': {
            const d = Math.hypot(x, y) || 1
            return p.wipe === 'out' ? [x / d, y / d] : [-x / d, -y / d]
          }
          default: return [1, 0]
        }
      }

      // ---- Motion (in the pattern).
      if (audio.onset) pulseEnv = Math.max(pulseEnv, 0.4 + 0.6 * audio.onsetStrength)
      pulseEnv *= Math.exp(-dt / 0.22)
      const scanAt = p.scan > 0 ? x0 + (((steps / 16 / Math.max(0.25, p.scanBars)) % 1 + 1) % 1) * sx : 0
      const roll = p.pattern === 'roll', barcode = p.pattern === 'barcode', dots = p.pattern === 'dots'
      const flowT = time * p.flow
      const nLayers = Math.round(p.layersN)
      const lines = Math.max(1, text.lines.length)
      const colourT = (m: Mark, u: number) => {
        let t: number
        switch (p.colourBy) {
          case 'across': t = (m.x - x0) / sx; break
          case 'down': t = (y1 - m.y) / sy; break
          case 'lines': t = m.line / lines + 0.25 * (m.x - x0) / sx; break
          case 'lanes': t = barcode ? (m.x - x0) / sx : (y1 - m.y) / sy; break
          case 'wipe': t = u; break
          case 'mix': t = 0.75 * (m.x - x0) / sx + 0.15 * (y1 - m.y) / sy + 0.35 * (m.ghost ? 0 : m.lv); break
          default: t = m.ghost ? 0 : m.lv
        }
        t *= p.spread
        if (nLayers > 0) t = (Math.floor(clamp01(t) * nLayers * 0.9999) + 0.5) / nLayers
        return t + flowT
      }

      const gooing = p.morph === 'goo'
      if (gooing) {
        goo.radius = p.gooBlur
        goo.stretch = 1
        goo.gain.value = p.gooFill
        goo.edge.value = 0.92
        goo.opacity.value = 1
      }
      const fieldOn = p.fieldOpacity > 0.001
      if (fieldOn) {
        field.radius = p.fieldBlur
        field.stretch = p.fieldStretch
        field.gain.value = p.fieldGain
        field.edge.value = clamp01(p.fieldEdge)
        field.opacity.value = p.fieldOpacity
        field.bars.blend = 'normal'
      }

      const inkRow = p.ramp === 'ink'
      let sumS = 0
      for (let i = 0; i < P.marks.length; i++) {
        const m = P.marks[i], o = out[i]
        const u0 = along(m.x, m.y, m.gi, m.lane)
        const gu = glyphU.get(m.gi) ?? u0
        const u = lerp(u0, gu, p.glyphLock)
        // Eased toward where the front says it should be, each at its own pace.
        const s = clamp01(markS.step(i, sOf(u), dt, p.lag, p.stagger))
        sumS += s
        o.row = inkRow ? ROW + 1 : ROW
        o.rotation = 0
        o.grain = 0
        o.feather = 0.6
        if (s <= 0.001) { o.alpha = 0; o.w = o.h = 0; continue }

        // Motion: the pattern's life with the music (only once it's there).
        let size = 1, len = 1, dx = 0, dy = 0, tShift = 0
        const live = s
        if (p.breathe > 0) size *= 1 + p.breathe * 0.5 * (audio.level - 0.4) * live
        if (p.pulse > 0) size *= 1 + p.pulse * 0.5 * pulseEnv * live * (0.6 + 0.8 * hash(m.lane, m.col, 2))
        if (p.scan > 0) {
          const behind = scanAt - m.x
          const lit = behind >= -P.pitch && behind < sx * 0.35 ? Math.exp(-Math.max(0, behind) / (sx * 0.08)) : 0
          size *= 1 + p.scan * 0.7 * lit * live
          tShift += p.scan * 0.35 * lit
        }
        if (p.bands > 0) {
          const b = barcode ? Math.floor(clamp01((m.x - x0) / sx) * BAND_COUNT * 0.9999) : Math.floor(clamp01((m.y - y0) / sy) * BAND_COUNT * 0.9999)
          const v = audio.bands[b] ?? 0
          if (roll) size *= 1 + p.bands * 1.4 * v * live
          else if (barcode) size *= 1 + p.bands * 2 * v * live
          else size *= 1 + p.bands * v * live
          tShift += p.bands * 0.2 * v
        }
        if (p.wave > 0) {
          const ph = ((barcode ? m.y : m.x) / Math.max(20, p.waveLength)) * Math.PI * 2 - time * 2.4
          const a = p.wave * P.pitch * 2.5 * (0.35 + audio.level) * Math.sin(ph) * live
          if (barcode) dx += a; else dy += a
        }

        // Morph: how the mark arrives with the front.
        let grow = 1, draw = 1, alpha = m.ghost ? p.ghost : 1, stretch = 1
        const [wx, wy] = wipeDir(m.x, m.y)
        const swell = 1 + p.bulge * Math.sin(Math.PI * s)
        switch (p.morph) {
          case 'flow': {
            // Carried in along a swirl: far out and small at first, curling into place as it settles.
            const e = band(0, 1, s)
            const sc = 1 / Math.max(20, p.swirl)
            const [cx, cy] = curl(m.x * sc, m.y * sc, time * 0.15)
            const away = (1 - e) * (1 - e) * p.travel * 1.6
            dx += cx * away - wx * away * 0.5
            dy += cy * away - wy * away * 0.5
            grow = lerp(0.15, 1, smooth01(e * 1.25)) * swell
            alpha *= band(0, 0.4, s)
            break
          }
          case 'goo': grow = band(0.05, 0.8, s) * swell; alpha *= band(0.85, 1, s); break
          case 'grow': grow = band(0, 0.85, s) * swell; alpha *= band(0, 0.25, s); break
          case 'draw':
            draw = band(0, 0.9, s)
            grow = (dots ? band(0, 0.9, s) : 1) * swell
            alpha *= band(0, 0.15, s)
            break
          case 'streak': {
            stretch = 1 + p.stretchIn * Math.sin(Math.PI * Math.min(1, s * 1.15))
            const back = (1 - s) * p.travel
            dx -= wx * back; dy -= wy * back
            alpha *= band(0, 0.35, s)
            grow = lerp(0.6, 1, s)
            break
          }
          case 'fall': {
            const e = 1 - easeOutBack(band(0, 1, s))
            dx -= wx * p.travel * e; dy -= wy * p.travel * e
            alpha *= band(0, 0.3, s)
            grow = lerp(0.5, 1, band(0, 0.6, s))
            break
          }
        }
        if (p.scatter > 0) {
          const e = (1 - band(0, 0.9, s)) * p.scatter * p.travel * 2
          dx += (hash(m.lane, m.col, 21) - 0.5) * e
          dy += (hash(m.lane, m.col, 22) - 0.5) * e
        }

        // Geometry.
        let w = m.w, h = m.h, x = m.x + dx, y = m.y + dy
        if (dots) { w *= size * grow; h *= size * grow }
        else if (roll) {
          h *= size * Math.min(1, grow)
          w *= len * draw
          x = m.x - m.w / 2 + w / 2 + dx
          if (grow > 1) h *= grow
        } else {
          w *= size * Math.min(1, grow)
          h *= len * draw
          y = m.y + m.h / 2 - h / 2 + dy
          if (grow > 1) w *= grow
        }
        if (stretch !== 1) {
          if (dots) { w *= stretch; o.rotation = Math.atan2(wy, wx) }
          else if (Math.abs(wx) >= Math.abs(wy)) w *= stretch
          else h *= stretch
        }
        const t = colourT(m, u) + tShift
        o.x = x; o.y = y; o.w = Math.max(0, w); o.h = Math.max(0, h)
        o.radius = dots ? Math.min(o.w, o.h) / 2 : (Math.min(o.w, o.h) / 2) * clamp01(p.round)
        o.t0 = o.t1 = t
        o.alpha = clamp01(alpha)
        o.feather = dots ? 0.6 : 0.5

        if (gooing && !m.ghost && s > 0.001 && s < 0.999) {
          gooSpec.x = x; gooSpec.y = y; gooSpec.w = o.w; gooSpec.h = o.h; gooSpec.radius = o.radius; gooSpec.rotation = o.rotation
          gooSpec.t0 = gooSpec.t1 = t; gooSpec.row = o.row; gooSpec.alpha = 1 - band(0.9, 1, s); gooSpec.feather = 0.6
          goo.bars.push(gooSpec)
        }
      }
      const meanS = P.marks.length ? sumS / P.marks.length : 0

      // Dots can be any shape (shared/dotShape.ts).
      if (dots) {
        if (shapesDots(p)) for (const o of out) if (o.w > 0 && !o.rotation) shapeDot(o, p, time)
      }

      // The colour field: the marks again, blurred and pooled into the letter shapes, its colours shifted.
      if (fieldOn) for (let i = 0; i < out.length; i++) {
        const o = out[i]
        if ((o.alpha ?? 0) < 0.01 || o.w <= 0) continue
        if (P.marks[i].ghost) continue
        // At least `fieldFill` cells across, so the field fills the strokes solid before it's blurred.
        const f = P.pitch * p.fieldFill * Math.min(1, (o.alpha ?? 1) * 1.5)
        const w = Math.max(o.w, f), h = Math.max(o.h, f)
        field.bars.push({ ...o, w, h, radius: Math.min(w, h) / 2, t0: o.t0 + p.fieldShift, t1: o.t1 + p.fieldShift, feather: 0.5 })
      }
      // Lane lines (roll).
      if (roll && p.guides > 0 && meanS > 0.001) for (const g of P.guides) {
        bars.push({ x: (g.x0 + g.x1) / 2, y: g.y, w: g.x1 - g.x0, h: 1, t0: 0.5, t1: 0.5, row: ROW + 1, alpha: p.guides * meanS, feather: 0.5 })
      }
      const crisp = clamp01(p.crisp)
      if (crisp > 0.001) for (const o of out) {
        if ((o.alpha ?? 0) < 0.004 || o.w <= 0.05 || o.h <= 0.05) continue
        bars.push(crisp < 1 ? { ...o, alpha: (o.alpha ?? 1) * crisp } : o)
      }

      // The type, per pixel: a mask follows the front through each letter, blurring and swelling it away.
      const keep = clamp01(p.keepType)
      const gm = glyphs.mask
      gm.on.value = 1
      gm.rect.value.set(mask.x0, mask.y0, mask.cols * mask.pitch, mask.rows * mask.pitch)
      gm.blur.value = p.typeBlur
      gm.bleed.value = p.melt
      gm.from.value = 0.12
      gm.to.value = 0.8
      for (let r = 0; r < mask.rows; r++)
        for (let c = 0; c < mask.cols; c++) {
          const i = r * mask.cols + c
          const x = mask.x0 + (c + 0.5) * mask.pitch, y = mask.y0 + (r + 0.5) * mask.pitch
          const gi = mask.gi[i]
          const u0 = along(x, y, gi, Math.round((P.rows / 2) - y / P.pitch))
          const u = lerp(u0, glyphU.get(gi) ?? u0, p.glyphLock)
          gm.set(i, clamp01(maskS.step(i, sOf(u), dt, p.lag, p.stagger)) * (1 - keep))
        }
      gm.commit()
      markS.ready = maskS.ready = true
      const [r, g, b] = ink
      for (const gl of text.glyphs) {
        const pl = base[gl.index]
        if (!pl) continue
        writeGlyph(glyphs, gl, pl, { r, g, b, a: 1 })
        if (gooing) {
          const sg = sOf(glyphU.get(gl.index) ?? 0)
          if (sg > 0.001 && sg < 0.999) writeOutline(goo.glyphs, gl, pl, { r, g, b, a: 1 - band(0.1, 0.75, sg) })
        }
      }

      // Smoke: what the front passes through (marks arriving, letters melting) left in a flowing, fading field.
      const smoke = layers.field
      const smoking = p.smoke > 0.001 || p.smokeLetters > 0.001
      smoke.enabled = smoking
      if (smoking) {
        const stir = 1 + p.smokeLive * (audio.level + 0.6 * pulseEnv)
        smoke.flowSpeed.value = p.smokeFlow * stir
        smoke.flowScale.value = p.smokeScale
        smoke.turbulence.value = 0.15 * stir
        smoke.diffusion.value = p.smokeSpread
        smoke.keep.value = Math.exp(-dt / Math.max(0.05, p.smokeLast))
        smoke.gain.value = 1
        smoke.opacity.value = 1
        smoke.grain.value = 0
        smoke.look = 'flat'
        if (p.wind === 'along') {
          const [wx, wy] = wipeDir(0, 1)
          const back = dir === 'out' && p.back === 'reverse' ? -1 : 1
          if (p.wipe === 'out' || p.wipe === 'in') smoke.setDrift('outward', (p.wipe === 'out' ? 1 : -1) * back * p.windSpeed)
          else { smoke.setDrift('none', 0); smoke.drift.value.set(wx * back * p.windSpeed, wy * back * p.windSpeed) }
        } else smoke.setDrift(p.wind, p.windSpeed)
        const ib = smoke.injectBars
        ib.setGradient(ramp, ROW)
        ib.setGradient([inkHex, inkHex], ROW + 1)
        if (p.smoke > 0.001) for (let i = 0; i < out.length; i++) {
          const o = out[i], s = markS.x[i]
          if (s <= 0.02 || s >= 0.98 || o.w <= 0) continue
          const a = p.smoke * Math.sin(Math.PI * clamp01(s)) * 0.6
          if (a > 0.01) ib.push({ ...o, alpha: Math.min(1, a), feather: 1.5 })
        }
        if (p.smokeLetters > 0.001) for (const gl of text.glyphs) {
          const pl = base[gl.index]
          if (!pl) continue
          const sg = sOf(glyphU.get(gl.index) ?? 0)
          const a = p.smokeLetters * Math.sin(Math.PI * sg) * 0.5
          if (a < 0.01) continue
          rampRGB(ramp, colourT({ x: pl.x, y: pl.y, w: 0, h: 0, lv: 0.5, ghost: false, gi: gl.index, line: gl.line, lane: 0, col: 0 }, glyphU.get(gl.index) ?? 0), tint)
          writeHalo(smoke.inject, gl, pl, { r: tint.r, g: tint.g, b: tint.b, a, blur: 3, bleed: 1 })
        }
      }
    },
  }
}

const PAPER = { background: '#f4f5f7', ink: '#121317' }
const NIGHT = { background: '#0a0b0f', ink: '#eef0f4' }

const presets: Record<string, ModePreset> = {
  // Dots in contour layers of the aurora colours, the letters gooing into them left to right, two bars each way.
  Default: { params: {}, ...PAPER },
  'Dots · bloom from the centre': { params: { wipe: 'out', morph: 'grow', bulge: 0.8, width: 0.5, colourBy: 'wipe', ramp: 'spectrum', pulse: 0.5, fieldEdge: 0.8 }, ...PAPER },
  'Dots · rain down': { params: { wipe: 'down', morph: 'fall', travel: 80, scatter: 0.3, glyphLock: 0, width: 0.25, ramp: 'lagoon', colourBy: 'down', scan: 0.5 }, ...PAPER },
  'Dots · dashes pulled down': {
    params: { wipe: 'down', morph: 'streak', stretchIn: 5, travel: 60, dotLength: 3.5, dotAngle: 90, dotRound: 0.8, randLength: 0.5, colourBy: 'across', ramp: 'spectrum', layersN: 6, fieldOpacity: 0.5 },
    ...PAPER,
  },
  'Dots · north star pools': {
    params: { pitch: 4, colourBy: 'mix', layersN: 5, ramp: 'aurora', fieldBlur: 3.5, fieldGain: 2.4, fieldEdge: 0.9, fieldOpacity: 1, crisp: 0.35, flow: 0.03, morph: 'goo', wipe: 'diagonal' },
    ...PAPER,
  },
  'Roll · neon': {
    params: { pattern: 'roll', pitch: 7, ramp: 'neon', colourBy: 'lanes', morph: 'draw', wipe: 'right', fieldBlur: 7, fieldGain: 1.6, fieldEdge: 0, fieldStretch: 2, fieldShift: 0.1, fieldOpacity: 0.8, fieldFill: 0, bands: 0.6, scan: 0.4, guides: 0.08 },
    ...NIGHT,
  },
  'Roll · waveform': {
    params: { pattern: 'roll', pitch: 6, laneFill: 0.45, split: 0.35, ramp: 'lagoon', colourBy: 'across', layersN: 5, wave: 0.6, waveLength: 320, morph: 'streak', stretchIn: 2, wipe: 'lanes', fieldOpacity: 0.6 },
    ...PAPER,
  },
  'Roll · notes play in': {
    params: { pattern: 'roll', pitch: 8, split: 0.4, minRun: 2, morph: 'draw', wipe: 'reading', width: 0.15, glyphLock: 1, colourBy: 'lines', ramp: 'ember', scan: 0.6, pulse: 0.5, guides: 0.2 },
    ...PAPER,
  },
  'Barcode · scan': {
    params: { pattern: 'barcode', pitch: 4, ramp: 'ink', colourBy: 'across', morph: 'draw', wipe: 'right', width: 0.2, bands: 0.5, tails: 0.3, fieldOpacity: 0, round: 0 },
    ...PAPER,
  },
  'Barcode · prism pull': {
    params: { pattern: 'barcode', pitch: 5, ramp: 'spectrum', colourBy: 'across', layersN: 7, morph: 'streak', stretchIn: 4, wipe: 'down', travel: 120, tails: 0.4, fieldBlur: 8, fieldEdge: 0.4, fieldStretch: 1 },
    ...PAPER,
  },
  'Onsets snap it over': { params: { drive: 'onsets', wipeIn: 0.45, wipeOut: 0.7, width: 0.2, morph: 'grow', bulge: 0.6, pulse: 0.6 }, ...PAPER },
  'Loudness tide': { params: { drive: 'loudness', wipe: 'noise', width: 0.4, jitter: 0.2, morph: 'goo', colourBy: 'wipe', ramp: 'lagoon' }, ...PAPER },
}

export const typeMorph: ModeDefinition = {
  id: 'typeMorph',
  label: 'Type Morph',
  params,
  groups,
  presets,
  create,
}
