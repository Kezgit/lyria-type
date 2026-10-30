import { Color } from 'three/webgpu'
import type { ParamSchema } from '../../app/params'
import type { BarLayer } from '../../engine/barLayer'
import type { BlurredBarLayer } from '../../engine/blurLayer'
import type { GlyphLayer } from '../../engine/glyphLayer'
import type { StretchFx } from '../../engine/stretchFx'
import type { FrameContext } from '../types'
import { writeOutline } from '../shared/glyphs'
import { dotShapeKeys, dotShapeParams, noise, shapesDots } from '../shared/dotShape'
import {
  HAIR, HEAVY, MEDIUM, MULTI, ORDER, RAMPS, ROW_INK, ROW_MULTI, SOLID, STEM_HUE, barcodeGradients, hazeKeys, hazeParams, rowOf,
  type Hue,
} from './barcode'
import { PALETTES, paletteOf, paletteRow } from './palettes'
import type { DotInfo } from './palettes/types'

// Finish: the Dots sub-mode's colour, dot shape and haze, for every other
// sub-mode, applied to whatever it drew this frame; and the four stems as
// buckets of sound, each weighted on its own (any sub-mode, Dots too).
//   stems    each stem's marks scaled: 0 hides them, 1 as drawn, 2 twice
//            the size (and full strength)
//   colour   every mark repainted as Dots paints its dots: in ink, in its
//            stem's hue, along the multi-hue gradient (offset per stem), in
//            one hue, or by one of the palette explorations. A mark's weight
//            (its size and strength, against the frame's heaviest) stands in
//            for how loud it is
//   shape    every mark resized, lengthened, rounded and turned, varied by a
//            drifting noise field (the dot shape controls)
//   dot grid Dots' matrix drawn over the picture: a square grid of
//            round dots, each taking the colour of the mark on top there and
//            sized by its weight as Dots sizes them (smallest, base, event);
//            empty places keep a faint silent dot
//   gradient your own gradient (stops anywhere, placed on the page as a
//            line or a ring, or by loudness) painting every mark, each bar
//            carrying it along its length; haze takes it too
//   mask     a painted mask (brush on the stage) hiding the marks there, or
//            keeping the gradient off them
//   haze     the marks blurred together under the crisp ones (Haze controls)
//   chars    the sub-mode's own characters (Ledger's texture, Stretch's lane
//            letters) kept, removed or swapped for typed ones; and any
//            sub-mode's marks drawn as the typed characters (instead of or
//            over the marks), picked by weight, in turn, at random or by stem
// Marks know their stem from the sub-mode (BarSpec.stem); untagged ones (page
// furniture) only take the colour. Stretch draws in a shader, not marks: it
// takes the colour (one gradient per stem), nothing else.

export const finishParams: ParamSchema = {
  vocals: { type: 'number', value: 1, min: 0, max: 2, step: 0.01, label: 'vocals (0 = hidden)' },
  instruments: { type: 'number', value: 1, min: 0, max: 2, step: 0.01, label: 'instruments' },
  drums: { type: 'number', value: 1, min: 0, max: 2, step: 0.01, label: 'drums' },
  bass: { type: 'number', value: 1, min: 0, max: 2, step: 0.01, label: 'bass' },

  colour: {
    type: 'select', value: 'drawn', label: 'colour',
    options: {
      'as drawn': 'drawn', ink: 'ink', 'stem hues': 'stems', 'across hues': 'across',
      'mono blue': 'blue', 'mono red': 'red', 'mono yellow': 'yellow', 'mono green': 'green',
      ...Object.fromEntries(PALETTES.map((pl) => [pl.label, pl.id])),
    },
  },
  colourOffset: { type: 'number', value: 0.2, min: 0, max: 1, step: 0.01, label: 'ramp offset per stem' },
  colourDepth: { type: 'number', value: 0.7, min: 0, max: 1, step: 0.01, label: 'weight deepens colour' },

  ...dotShapeParams,
  ...hazeParams,

  gradOn: { type: 'boolean', value: false, label: 'gradient map' },
  gradStops: { type: 'text', value: '0:#3186ff,0.5:#fc413d,1:#fec700', label: 'gradient stops' },
  gradShape: { type: 'select', value: 'linear', label: 'shape', options: { linear: 'linear', radial: 'radial', 'by loudness': 'weight' } },
  gradRepeat: { type: 'select', value: 'clamp', label: 'past the ends', options: { 'hold the end colours': 'clamp', repeat: 'repeat', mirror: 'mirror' } },
  gradX0: { type: 'number', value: -1, min: -2, max: 2, step: 0.005, label: 'start x' },
  gradY0: { type: 'number', value: 0, min: -2, max: 2, step: 0.005, label: 'start y' },
  gradX1: { type: 'number', value: 1, min: -2, max: 2, step: 0.005, label: 'end x' },
  gradY1: { type: 'number', value: 0, min: -2, max: 2, step: 0.005, label: 'end y' },
  gradWeight: { type: 'number', value: 0, min: 0, max: 1, step: 0.01, label: 'mix in loudness' },
  maskOn: { type: 'boolean', value: true, label: 'use the mask' },
  maskData: { type: 'text', value: '', label: 'mask' },
  maskWhat: { type: 'select', value: 'marks', label: 'mask hides', options: { 'the marks': 'marks', 'the gradient (marks keep their colour)': 'gradient' } },
  maskStrength: { type: 'number', value: 1, min: 0, max: 1, step: 0.01, label: 'mask strength' },
  maskInvert: { type: 'boolean', value: false, label: 'invert mask' },
  brushSize: { type: 'number', value: 60, min: 4, max: 400, step: 1, label: 'brush size (px)' },
  brushSoft: { type: 'number', value: 0.5, min: 0, max: 1, step: 0.01, label: 'brush softness' },

  dotGrid: { type: 'boolean', value: false, label: 'draw as a dot grid' },
  gridAcross: { type: 'number', value: 64, min: 12, max: 84, step: 1, label: 'dots across' },
  gridSize: { type: 'number', value: 1, min: 0.2, max: 2.5, step: 0.01, label: 'dot size (×)' },
  gridContrast: { type: 'number', value: 1, min: 0.2, max: 3, step: 0.01, label: 'size by weight (contrast)' },
  gridSolid: { type: 'number', value: 0.6, min: 0, max: 1, step: 0.01, label: 'faint marks made solid' },
  gridGhost: { type: 'number', value: 0.5, min: 0, max: 1, step: 0.01, label: 'silent dots' },
  gridHaze: {
    type: 'select', value: 'both', label: 'main haze from',
    options: { 'the picture and the dots': 'both', 'the picture (its colour wash under the dots)': 'picture', 'the dots': 'dots' },
  },
  dotHaze: { type: 'number', value: 6, min: 0, max: 80, step: 0.5, label: 'dots\' own haze (px, 0 = off)' },
  dotHazeStretch: { type: 'number', value: 1, min: 1, max: 12, step: 0.1, label: 'dot haze stretch' },
  dotHazeGain: { type: 'number', value: 2, min: 0.5, max: 8, step: 0.05, label: 'dot haze strength' },
  dotHazeOpacity: { type: 'number', value: 0.8, min: 0, max: 1, step: 0.01, label: 'dot haze opacity' },
  dotHazeEdge: { type: 'number', value: 0.3, min: 0, max: 1, step: 0.01, label: 'dot haze edge (fog → pools)' },
  dotHazeFrom: {
    type: 'select', value: 'hair', label: 'dot haze from weight',
    options: { hairline: 'hair', medium: 'medium', heavy: 'heavy', solid: 'solid' },
  },

  chars: {
    type: 'select', value: 'keep', label: 'sub-mode characters',
    options: { 'as the sub-mode draws them': 'keep', 'remove them': 'none', 'my characters': 'custom' },
  },
  charText: { type: 'text', value: '·+x#&@', label: 'my characters (light → heavy)', show: true },
  marksAs: {
    type: 'select', value: 'marks', label: 'draw marks as',
    options: { marks: 'marks', 'my characters': 'chars', 'marks + characters': 'both' },
  },
  charOrder: {
    type: 'select', value: 'weight', label: 'character per mark',
    options: { 'by weight (light → heavy)': 'weight', 'in turn': 'cycle', random: 'random', 'one per stem': 'stem' },
    showIf: { key: 'marksAs', is: ['chars', 'both'] },
  },
  charSize: { type: 'number', value: 1.2, min: 0.2, max: 4, step: 0.01, label: 'character size (× mark)', showIf: { key: 'marksAs', is: ['chars', 'both'] } },
  charMin: { type: 'number', value: 1, min: 0, max: 40, step: 0.5, label: 'skip marks under (px)', showIf: { key: 'marksAs', is: ['chars', 'both'] } },
}

/** Panel groups: the buckets for every sub-mode; colour, shape and haze for all but Dots (it has its own). */
export function finishGroups(sub: string): Record<string, string[]> {
  const buckets = {
    'Stems (buckets of sound)': ['vocals', 'instruments', 'drums', 'bass'],
    'Gradient map': ['gradOn', 'gradShape', 'gradRepeat', 'gradX0', 'gradY0', 'gradX1', 'gradY1', 'gradWeight'],
    Mask: ['maskOn', 'maskWhat', 'maskStrength', 'maskInvert', 'brushSize', 'brushSoft'],
    Characters: ['chars', 'charText', 'marksAs', 'charOrder', 'charSize', 'charMin'],
  }
  // Dots has its own shape and haze; the shared colour too (so a look made on Ledger carries over).
  if (sub === 'dots') return { ...buckets, 'Colour (shared with the other sub-modes)': ['colour', 'colourOffset', 'colourDepth'] }
  return {
    ...buckets,
    'Dot grid (as Dots)': ['dotGrid', 'gridAcross', 'gridSize', 'gridContrast', 'gridSolid', 'gridGhost', 'gridHaze'],
    'Dot haze': ['dotHaze', 'dotHazeStretch', 'dotHazeGain', 'dotHazeOpacity', 'dotHazeEdge', 'dotHazeFrom'],
    'Colour (as Dots)': ['colour', 'colourOffset', 'colourDepth'],
    'Mark shape (as Dots)': dotShapeKeys,
    'Haze (as Dots)': hazeKeys,
  }
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v))
const STEM_KEYS = ['vocals', 'instruments', 'drums', 'bass'] as const
const MONO: Record<string, Hue> = { blue: 'blue', red: 'red', yellow: 'yellow', green: 'green' }

/** The gradient a row paints with (hexes light -> dark), for colouring outside the bar shader (glyphs, Stretch). */
function rowHexes(row: number, ink: string): string[] {
  if (row === ROW_INK) return ['#ffffff', ink]
  if (row === ROW_MULTI) return MULTI
  const hue = (Object.keys(RAMPS) as Hue[]).find((h) => rowOf(h) === row)
  if (hue) return RAMPS[hue]
  for (let i = 0; i < PALETTES.length; i++)
    for (let r = 0; r < PALETTES[i].rows.length; r++) if (paletteRow(i, r) === row) return PALETTES[i].rows[r]
  return ['#ffffff', ink]
}

const ca = new Color(), cb = new Color()
/** A gradient sampled at t (0..1), linear rgb. */
function sample(hexes: readonly string[], t: number, out: [number, number, number]) {
  const x = clamp01(t) * (hexes.length - 1)
  const k = Math.min(hexes.length - 2, Math.floor(x))
  ca.set(hexes[k]).lerp(cb.set(hexes[k + 1]), x - k)
  out[0] = ca.r; out[1] = ca.g; out[2] = ca.b
  return out
}

/** A mark's paint: gradient row, position, and alpha / size factors. */
interface Paint { row: number; t: number; alpha: number; size: number }

/** How Dots would paint a mark of weight `lv` (0..1) in stem `s` (-1: none) at (u, v) on the page. */
function paintOf(p: Record<string, any>, lv: number, s: number, u: number, v: number, out: Paint): Paint {
  const d = clamp01(p.colourDepth)
  const kind: DotInfo['kind'] = lv < 0.15 ? 'ghost' : lv < 0.5 ? 'base' : 'event'
  out.alpha = 1; out.size = 1
  const id = p.colour as string
  const stem = s >= 0 ? s : 0
  /** The ramp offset per stem, as Dots applies it to every colour: at 1 the stems spread over the whole ramp (mirrored past the end). */
  const offset = (t: number) => {
    if (s < 0) return t
    const w = Math.abs(t + (p.colourOffset * stem) / 3) % 2
    return w > 1 ? 2 - w : w
  }
  if (id === 'ink' || s < 0) { out.row = ROW_INK; out.t = offset(0.25 + 0.75 * (1 - d + d * lv)); return out }
  if (id === 'stems') { out.row = rowOf(STEM_HUE[ORDER[stem]]); out.t = offset(0.15 + 0.7 * (0.5 * (1 - d) + d * lv)); return out }
  if (id === 'across') { out.row = ROW_MULTI; out.t = (0.3 + 0.5 * lv * d) + p.colourOffset * stem; out.t -= Math.floor(out.t); return out }
  if (MONO[id]) { out.row = rowOf(MONO[id]); out.t = offset(0.15 + 0.75 * (0.5 * (1 - d) + d * lv)); return out }
  const i = paletteOf(id)
  if (i < 0) { out.row = ROW_INK; out.t = lv; return out }
  const T = 64, N = 32
  const r = PALETTES[i].paint({
    kind, lv, stem: ORDER[stem], sec: 0, red: false, g: Math.round((0.5 - v) * (T - 1)), l: Math.round((u + 0.5) * (N - 1)), T, N, u, v,
    within: 0.5, offset: p.colourOffset,
  })
  out.row = paletteRow(i, r.row); out.t = offset(clamp01(r.t)); out.alpha = r.alpha ?? 1; out.size = r.size ?? 1
  return out
}

/**
 * Per mark: its weight, 0..1: mostly how deep the sub-mode painted it (its ramps run light -> dark, so a pale
 * wash stays pale), a little its size and strength against the frame's heaviest.
 */
function weightsOf(layer: BarLayer, out: Float32Array) {
  const { pos, grad } = layer
  let top = 1e-6
  for (let i = 0; i < layer.count; i++) {
    const o = i * 4
    out[i] = Math.sqrt(Math.max(0, Math.min(pos[o + 2], pos[o + 3]))) * grad[o + 2]
    top = Math.max(top, out[i])
  }
  for (let i = 0; i < layer.count; i++) {
    const o = i * 4
    out[i] = clamp01(0.7 * clamp01(0.5 * (grad[o] + grad[o + 1])) * (0.4 + 0.6 * clamp01(grad[o + 2])) + 0.3 * Math.sqrt(out[i] / top))
  }
}

const paint: Paint = { row: 0, t: 0, alpha: 1, size: 1 }
let weights = new Float32Array(4096)
const rgb: [number, number, number] = [0, 0, 0]

/** Stems, colour and shape on one bar layer's marks (in place). */
function finishBars(layer: BarLayer, p: Record<string, any>, ink: FrameContext['ink'], W: number, H: number, time: number, doShape = true, from = 0) {
  const n = layer.count
  if (!n) return
  const { pos, grad, style, stems } = layer
  const amt = STEM_KEYS.map((k) => p[k] as number)
  const recolour = p.colour !== 'drawn'
  const shape = doShape && shapesDots(p)
  if (recolour) {
    barcodeGradients(layer, ink)
    PALETTES.forEach((pl, i) => pl.rows.forEach((hexes, r) => layer.setGradient(hexes, paletteRow(i, r))))
    if (weights.length < n) weights = new Float32Array(n)
    weightsOf(layer, weights)
  }
  const s0 = 1 / Math.max(8, p.noiseScale), z = time * p.noiseSpeed + p.noiseSeed * 17.3
  for (let i = from; i < n; i++) {
    const o = i * 4
    const s = stems[i]
    // The stem's bucket: hidden, weaker, or larger.
    if (s >= 0 && amt[s] !== 1) {
      const a = Math.max(0, amt[s])
      grad[o + 2] *= Math.min(1, a)
      if (a > 1) { pos[o + 2] *= a; pos[o + 3] *= a; style[o + 3] *= a }
    }
    if (recolour) {
      paintOf(p, weights[i], s, pos[o] / W, pos[o + 1] / H, paint)
      style[o + 2] = paint.row
      grad[o] = grad[o + 1] = paint.t
      grad[o + 2] *= paint.alpha
      if (paint.size !== 1) { pos[o + 2] *= paint.size; pos[o + 3] *= paint.size; style[o + 3] *= paint.size }
    }
    if (shape) {
      // As Dots' dot shape, on a mark of any proportion: size both ways, length along its own long side, turned.
      const nx = pos[o] * s0, ny = pos[o + 1] * s0
      const size = Math.max(0.05, p.dotSize * (1 + 0.8 * p.randSize * noise(nx, ny, z)))
      const length = Math.max(0.2, p.dotLength * (1 + 0.9 * p.randLength * noise(nx + 31.4, ny - 17.2, z + 5.1)))
      const angle = p.dotAngle + 90 * p.randAngle * noise(nx - 11.7, ny + 43.1, z - 3.3)
      const round = style[o + 3] > 0
      const wide = pos[o + 2] >= pos[o + 3]
      pos[o + 2] *= size * (wide ? length : 1)
      pos[o + 3] *= size * (wide ? 1 : length)
      const r = Math.min(pos[o + 2], pos[o + 3]) / 2
      // Roundness 1 keeps a mark's own corners (dots stay round, blocks square); below, every mark is that round.
      style[o + 3] = p.dotRound >= 1 ? (round ? r : 0) : r * clamp01(p.dotRound)
      style[o] += (angle * Math.PI) / 180
    }
  }
}

/** The gradient map's row on any bar layer. */
const GRAD_ROW = 62
/** The mask grid: values 0..255, row 0 at the top of the frame. */
export const MASK_W = 128, MASK_H = 72

/** Gradient stops ("t:#hex,..."), sorted; malformed ones dropped (at least two). */
export function parseStops(text: string): { t: number; c: string }[] {
  const stops = String(text ?? '').split(',').map((part) => {
    const [t, c] = part.split(':')
    return { t: clamp01(parseFloat(t)), c: (c ?? '').trim() }
  }).filter((s) => Number.isFinite(s.t) && /^#[0-9a-f]{6}$/i.test(s.c)).sort((a, b) => a.t - b.t)
  return stops.length >= 2 ? stops : [{ t: 0, c: '#3186ff' }, { t: 1, c: '#fec700' }]
}
export const stopsText = (stops: { t: number; c: string }[]) => stops.map((s) => `${+s.t.toFixed(4)}:${s.c}`).join(',')

/** The stops as evenly spaced colours (sRGB hexes), for a gradient row. */
let samplesFor = '', samples: string[] = []
export function gradientSamples(text: string) {
  if (text === samplesFor) return samples
  samplesFor = text
  const stops = parseStops(text)
  samples = Array.from({ length: 64 }, (_, i) => {
    const t = i / 63
    let k = 0
    while (k < stops.length - 2 && stops[k + 1].t < t) k++
    const a = stops[k], b = stops[k + 1]
    const u = t <= a.t ? 0 : t >= b.t ? 1 : (t - a.t) / Math.max(1e-6, b.t - a.t)
    const pa = parseInt(a.c.slice(1), 16), pb = parseInt(b.c.slice(1), 16)
    const ch = (sh: number) => Math.round(((pa >> sh) & 255) + (((pb >> sh) & 255) - ((pa >> sh) & 255)) * u)
    return `#${((ch(16) << 16) | (ch(8) << 8) | ch(0)).toString(16).padStart(6, '0')}`
  })
  return samples
}

/** The mask, decoded (cached by its text). */
let maskFor = '', mask = new Uint8Array(MASK_W * MASK_H)
function maskOf(text: string) {
  if (text !== maskFor) {
    maskFor = text
    mask = new Uint8Array(MASK_W * MASK_H)
    try {
      if (text) {
        const bin = atob(text)
        for (let i = 0; i < Math.min(bin.length, mask.length); i++) mask[i] = bin.charCodeAt(i)
      }
    } catch { /* a broken mask is no mask */ }
  }
  return mask
}
/** The mask at a frame point (px from the centre, y up), 0..1, smooth between cells; inverted if asked. */
function maskAt(p: Record<string, any>, x: number, y: number, W: number, H: number) {
  const m = maskOf(p.maskData)
  const fx = (x / W + 0.5) * MASK_W - 0.5, fy = (0.5 - y / H) * MASK_H - 0.5
  const x0 = Math.max(0, Math.min(MASK_W - 1, Math.floor(fx))), y0 = Math.max(0, Math.min(MASK_H - 1, Math.floor(fy)))
  const x1 = Math.min(MASK_W - 1, x0 + 1), y1 = Math.min(MASK_H - 1, y0 + 1)
  const u = clamp01(fx - x0), v = clamp01(fy - y0)
  const at = (cx: number, cy: number) => m[cy * MASK_W + cx] / 255
  const val = (at(x0, y0) * (1 - u) + at(x1, y0) * u) * (1 - v) + (at(x0, y1) * (1 - u) + at(x1, y1) * u) * v
  return p.maskInvert ? 1 - val : val
}
const masking = (p: Record<string, any>) => p.maskOn && !!p.maskData && p.maskStrength > 0

/** Where a frame point falls along the gradient, 0..1 (before the ends are held, repeated or mirrored). */
function gradientT(p: Record<string, any>, x: number, y: number, W: number, H: number) {
  const ax = p.gradX0 * W / 2, ay = p.gradY0 * H / 2, bx = p.gradX1 * W / 2, by = p.gradY1 * H / 2
  const dx = bx - ax, dy = by - ay
  const len2 = Math.max(1e-6, dx * dx + dy * dy)
  let t = p.gradShape === 'radial' ? Math.hypot(x - ax, y - ay) / Math.sqrt(len2) : ((x - ax) * dx + (y - ay) * dy) / len2
  if (p.gradRepeat === 'repeat') t -= Math.floor(t)
  else if (p.gradRepeat === 'mirror') { t = Math.abs(t) % 2; if (t > 1) t = 2 - t }
  return clamp01(t)
}

/** The gradient map on a bar layer's marks (from index `from`): each bar takes it along its length. */
function gradientMap(layer: BarLayer, p: Record<string, any>, W: number, H: number, from = 0) {
  if (!p.gradOn || layer.count <= from) return
  layer.setGradient(gradientSamples(p.gradStops), GRAD_ROW)
  const n = layer.count
  const byWeight = p.gradShape === 'weight'
  const mix = byWeight ? 1 : clamp01(p.gradWeight)
  if (mix > 0) { if (weights.length < n) weights = new Float32Array(n); weightsOf(layer, weights) }
  const keepOff = masking(p) && p.maskWhat === 'gradient'
  const { pos, grad, style } = layer
  for (let i = from; i < n; i++) {
    const o = i * 4
    if (style[o + 2] === GHOST_ROW) continue
    const x = pos[o], y = pos[o + 1], hw = pos[o + 2] / 2
    // Where the mask keeps the gradient off, the mark keeps its own colour.
    if (keepOff && maskAt(p, x, y, W, H) * p.maskStrength > 0.5) continue
    const lv = mix > 0 ? weights[i] : 0
    const at = (px: number) => (byWeight ? lv : gradientT(p, px, y, W, H) * (1 - mix) + lv * mix)
    style[o + 2] = GRAD_ROW
    grad[o] = at(x - hw)
    grad[o + 1] = at(x + hw)
  }
}

/** The mask hiding marks (bars, characters, haze), as painted on the stage. */
function maskMarks(layers: FrameContext['layers'], p: Record<string, any>, W: number, H: number) {
  if (!masking(p) || p.maskWhat !== 'marks') return
  const k = clamp01(p.maskStrength)
  for (const layer of [layers.bars, layers.barsFar.bars, layers.barsMid.bars, layers.field.injectBars]) {
    for (let i = 0; i < layer.count; i++) {
      const o = i * 4
      layer.grad[o + 2] *= 1 - k * maskAt(p, layer.pos[o], layer.pos[o + 1], W, H)
    }
  }
  for (const layer of [layers.outlines]) {
    for (let i = 0; i < layer.count; i++) layer.color[i * 4 + 3] *= 1 - k * maskAt(p, layer.pos[i * 4], layer.pos[i * 4 + 1], W, H)
  }
}

/** Silent dots' gradient row (past everything the sub-modes and palettes use). */
const GHOST_ROW = 63
let cellTop = new Int32Array(0)
let cellWeight = new Float32Array(0)

/**
 * The marks redrawn as Dots' matrix: every grid point takes the topmost mark covering it (its colour row and
 * tone, strength and stem) and becomes a round dot sized by that mark's weight, as Dots sizes its dots
 * (smallest -> loudest base -> biggest event); points nothing covers keep a faint silent dot. The dots are
 * added over the picture (it stays); returns the index of the first dot.
 */
function dotGrid(layer: BarLayer, p: Record<string, any>, W: number, H: number): number {
  const n = layer.count
  // Square cells, as many across as asked, within the layer's room.
  let cols = Math.max(4, Math.round(p.gridAcross))
  let pitch = W / cols
  let rows = Math.max(2, Math.floor(H / pitch))
  while (cols * rows > layer.capacity - n - 8 && cols > 4) { cols--; pitch = W / cols; rows = Math.max(2, Math.floor(H / pitch)) }
  const cells = cols * rows
  if (cellTop.length < cells) { cellTop = new Int32Array(cells); cellWeight = new Float32Array(cells) }
  cellTop.fill(-1, 0, cells)
  if (weights.length < n) weights = new Float32Array(n)
  weightsOf(layer, weights)
  const { pos, grad, style, stems } = layer
  const x0 = -W / 2 + (W - cols * pitch) / 2, y0 = H / 2 - (H - rows * pitch) / 2
  // Later marks are drawn over earlier ones: the last to cover a point is its colour.
  for (let i = 0; i < n; i++) {
    const o = i * 4
    if (grad[o + 2] < 0.01) continue
    const hw = pos[o + 2] / 2, hh = pos[o + 3] / 2
    const c0 = Math.max(0, Math.ceil((pos[o] - hw - x0) / pitch - 0.5)), c1 = Math.min(cols - 1, Math.floor((pos[o] + hw - x0) / pitch - 0.5))
    const r0 = Math.max(0, Math.ceil((y0 - (pos[o + 1] + hh)) / pitch - 0.5)), r1 = Math.min(rows - 1, Math.floor((y0 - (pos[o + 1] - hh)) / pitch - 0.5))
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) {
      const k = r * cols + c
      cellTop[k] = i
      cellWeight[k] = weights[i]
    }
  }
  // Copy the winners out before the layer is rewritten.
  const src = new Float32Array(cells * 8)
  const srcStem = new Int8Array(cells)
  for (let k = 0; k < cells; k++) {
    const i = cellTop[k]
    if (i < 0) continue
    const o = i * 4
    src.set([grad[o], grad[o + 1], grad[o + 2], style[o + 2], style[o + 1]], k * 8)
    srcStem[k] = stems[i]
  }
  // Weights by rank among the covered points (0 = the quietest, 1 = the loudest), so any picture spreads over
  // the whole range of dot sizes, as Dots' are, however pale or dark it was drawn.
  const covered: number[] = []
  for (let k = 0; k < cells; k++) if (cellTop[k] >= 0) covered.push(k)
  covered.sort((a, b) => cellWeight[a] - cellWeight[b])
  // Points of equal weight (one mark covering many) share a rank, so a mark's dots stay one size.
  const last = Math.max(1, covered.length - 1)
  for (let j = 0; j < covered.length; ) {
    let e = j
    const v = cellWeight[covered[j]]
    while (e + 1 < covered.length && cellWeight[covered[e + 1]] - v < 1e-4) e++
    const rank = (j + e) / 2 / last
    for (let q = j; q <= e; q++) cellWeight[covered[q]] = rank
    j = e + 1
  }
  layer.setGradient(['#dfe2e8', '#9aa0a6'], GHOST_ROW)
  // Over the picture, which stays as it is.
  const lerp = (a: number, b: number, t: number) => a + (b - a) * t
  const size = p.gridSize
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const k = r * cols + c
    const x = x0 + (c + 0.5) * pitch, y = y0 - (r + 0.5) * pitch
    if (cellTop[k] < 0) {
      if (p.gridGhost > 0.01) {
        const rad = 0.1 * pitch * size
        layer.push({ x, y, w: 2 * rad, h: 2 * rad, radius: rad, t0: 0.3, t1: 0.3, row: GHOST_ROW, alpha: p.gridGhost, feather: 0.6 })
      }
      continue
    }
    // Weight -> radius, as Dots: below the middle a base dot (0.1 -> 0.2 of the pitch), above it an event (0.2 -> 0.42).
    const lv = Math.pow(Math.min(1, Math.max(0, cellWeight[k])), 1 / Math.max(0.05, p.gridContrast))
    const rad = (lv < 0.5 ? lerp(0.1, 0.2, Math.sqrt(lv / 0.5)) : lerp(0.2, 0.42, (lv - 0.5) / 0.5)) * pitch * size
    const o = k * 8
    layer.push({
      x, y, w: 2 * rad, h: 2 * rad, radius: rad, t0: src[o], t1: src[o + 1], row: src[o + 3],
      alpha: lerp(src[o + 2], 1, clamp01(p.gridSolid)), feather: Math.max(0.5, rad * 0.25), stem: srcStem[k],
    })
  }
  return n
}

/** Stems and colour on a glyph layer's characters (Ledger's texture). */
function finishGlyphs(layer: GlyphLayer, p: Record<string, any>, inkHex: string, W: number, H: number) {
  const n = layer.count
  if (!n) return
  const amt = STEM_KEYS.map((k) => p[k] as number)
  const recolour = p.colour !== 'drawn'
  const { color, pos, stems } = layer
  for (let i = 0; i < n; i++) {
    const o = i * 4
    const s = stems[i]
    if (s >= 0 && amt[s] !== 1) {
      const a = Math.max(0, amt[s])
      color[o + 3] *= Math.min(1, a)
      if (a > 1) pos[o + 3] *= a
    }
    if (recolour) {
      // The character's own strength stands in for its weight.
      const lv = clamp01(color[o + 3])
      paintOf(p, lv, s, pos[o] / W, pos[o + 1] / H, paint)
      sample(rowHexes(paint.row, inkHex), paint.t, rgb)
      color[o] = rgb[0]; color[o + 1] = rgb[1]; color[o + 2] = rgb[2]
      color[o + 3] *= paint.alpha
    }
  }
}

/** Stretch: one gradient per stem from the colour (its lanes take their stem's), dark -> light as Stretch reads them. */
export function finishStretch(fx: StretchFx, p: Record<string, any>, inkHex: string) {
  if (p.colour === 'drawn') return
  const four = (hexes: readonly string[]) => [0, 1, 2, 3].map((k) => {
    sample(hexes, 1 - k / 3, rgb)
    return `#${ca.setRGB(rgb[0], rgb[1], rgb[2]).getHexString()}`
  })
  // Stretch's multi slots: vocals 0, drums 1, instruments 2, bass 3.
  const slotStem = [0, 2, 1, 3]
  const ramps = slotStem.map((s) => {
    paintOf(p, 0.7, s, 0, 0, paint)
    if (p.colour === 'across') {
      // A stretch of the multi-hue gradient, shifted per stem.
      const t0 = (p.colourOffset * s) % 1
      return four([0, 0.33, 0.66, 1].map((k) => (sample(MULTI, (t0 + 0.35 * k) % 1, rgb), `#${ca.setRGB(...rgb).getHexString()}`)))
    }
    return four(rowHexes(paint.row, inkHex))
  })
  fx.setMultiRamps(ramps)
  fx.multi.value = 1
}

/** Whether Stretch should colour its lanes by stem (so the per-stem gradients apply). */
export const stretchByStem = (p: Record<string, any>) => p.colour !== 'drawn'

/** The finish, on everything the sub-mode drew this frame. */
export function finish(frame: FrameContext, p: Record<string, any>, sub: string) {
  const { layers, viewport, ink, time } = frame
  const W = viewport.width, H = viewport.height
  const inkHex = `#${ca.setRGB(ink[0], ink[1], ink[2]).getHexString()}`
  // Dots has its own shape and haze: only its stems and the shared colour here.
  const q = sub === 'dots' ? { ...p, dotSize: 1, dotLength: 1, dotRound: 1, dotAngle: 0, randSize: 0, randLength: 0, randAngle: 0 } : p
  const grid = sub !== 'dots' && p.dotGrid
  if (grid) {
    // Stems and colour first; the main haze (far layer) from the picture, the dots or both; the dots over the
    // picture, with the dot shape on them alone; the dots' own haze (near layer). `crisp` fades the picture's
    // marks, never the dots.
    finishBars(layers.bars, q, ink, W, H, time, false)
    gradientMap(layers.bars, p, W, H)
    const main = mainHaze(p, false)
    setupHaze(layers.barsFar, layers.bars, main)
    if (p.gridHaze !== 'dots') hazeFrom(layers.barsFar, layers.bars, main, ink)
    const first = dotGrid(layers.bars, q, W, H)
    const crisp = clamp01(p.crisp)
    if (crisp < 1) for (let i = 0; i < first; i++) layers.bars.grad[i * 4 + 2] *= crisp
    finishBars(layers.bars, { ...q, vocals: 1, instruments: 1, drums: 1, bass: 1, colour: 'drawn' }, ink, W, H, time, true, first)
    gradientMap(layers.bars, p, W, H, first)
    if (p.gridHaze !== 'picture') {
      layers.barsFar.bars.copyGradients(layers.bars)
      hazeFrom(layers.barsFar, layers.bars, main, ink, first)
    }
    const own: HazeSettings = {
      radius: p.dotHaze, stretch: p.dotHazeStretch, gain: p.dotHazeGain, opacity: p.dotHazeOpacity, edge: p.dotHazeEdge,
      tint: 'marks', tone: 0.5, from: p.dotHazeFrom,
    }
    setupHaze(layers.barsMid, layers.bars, own)
    hazeFrom(layers.barsMid, layers.bars, own, ink, first)
  } else {
    finishBars(layers.bars, q, ink, W, H, time)
    gradientMap(layers.bars, p, W, H)
  }
  gradientMap(layers.field.injectBars, p, W, H)
  // Dots draws its haze itself: the shared colour repaints it too, so the glow matches the dots.
  if (sub === 'dots' && p.colour !== 'drawn') {
    const plain = { ...q, vocals: 1, instruments: 1, drums: 1, bass: 1 }
    finishBars(layers.barsFar.bars, plain, ink, W, H, time, false)
    finishBars(layers.barsMid.bars, plain, ink, W, H, time, false)
  }
  // Dots draws its haze itself: the gradient map repaints it too.
  if (sub === 'dots') for (const l of [layers.barsFar.bars, layers.barsMid.bars]) gradientMap(l, p, W, H)
  finishBars(layers.field.injectBars, q, ink, W, H, time)
  finishGlyphs(layers.outlines, q, inkHex, W, H)
  if (sub === 'stretch') {
    finishStretch(layers.stretch, q, inkHex)
    if (p.gradOn) {
      // Stretch reads its ramp dark -> light: the gradient's four stops, start to end.
      const g = gradientSamples(p.gradStops)
      const four = [0, 21, 42, 63].map((i) => g[i])
      layers.stretch.setRamp(four)
      layers.stretch.setMultiRamps([four])
    }
  }
  if (!grid) {
    if (sub !== 'dots' && p.hazeBlur > 0) haze(frame, p)
    else if (sub !== 'dots' && p.crisp < 1) for (let i = 0; i < layers.bars.count; i++) layers.bars.grad[i * 4 + 2] *= clamp01(p.crisp)
  }
  // Ledger's character texture, removed.
  if (sub === 'ledger' && p.chars === 'none') layers.outlines.count = 0
  if (p.marksAs !== 'marks') marksAsChars(frame, p)
  maskMarks(layers, p, W, H)
}

/** The typed characters, light -> heavy (spaces dropped). */
export const typedChars = (p: Record<string, any>) => [...String(p.charText ?? '')].filter((c) => c.trim()).join('')

interface HazeSettings {
  radius: number
  stretch: number
  gain: number
  opacity: number
  edge: number
  /** 'marks' (their own colours), 'stems' or 'sections' (one hue each, at `tone`). */
  tint: string
  tone: number
  /** Lightest weight hazed: hair, medium, heavy, solid. */
  from: string
}

/** The main Haze settings, for the far (`near` false) or near layer. */
const mainHaze = (p: Record<string, any>, near: boolean): HazeSettings => ({
  radius: near ? p.hazeBlur * 0.3 : p.hazeBlur,
  stretch: p.hazeStretch,
  gain: near ? 1 + (p.hazeGain - 1) * 0.4 : p.hazeGain,
  opacity: near ? p.hazeOpacity * clamp01(p.hazeMid) : p.hazeOpacity,
  edge: p.hazeEdge, tint: p.hazeTint, tone: p.hazeTone, from: p.hazeFrom,
})

/** A blurred layer set up as Haze, painting with `src`'s colours (and Barcode's hues when tinting). */
function setupHaze(target: BlurredBarLayer, src: BarLayer, s: HazeSettings) {
  target.radius = s.radius
  target.stretch = s.stretch
  target.gain.value = s.gain
  target.opacity.value = s.opacity
  target.edge.value = clamp01(s.edge)
  target.bars.blend = 'normal'
  target.bars.copyGradients(src)
}

const LEVELS = [HAIR, MEDIUM, HEAVY, SOLID]
const FROM: Record<string, number> = { hair: HAIR, medium: MEDIUM, heavy: HEAVY, solid: SOLID }

/** `src`'s marks (those at least `from` in weight) into a blurred layer, in their colours or their stem's hue. */
function hazeFrom(target: BlurredBarLayer, src: BarLayer, s: HazeSettings, ink: FrameContext['ink'], first = 0, last = src.count) {
  if (s.opacity <= 0.001 || s.radius <= 0) return
  const n = src.count
  if (weights.length < n) weights = new Float32Array(n)
  weightsOf(src, weights)
  const from = FROM[s.from] ?? HAIR
  const tinted = s.tint !== 'marks'
  if (tinted) barcodeGradients(target.bars, ink)
  const { pos, grad, style, stems } = src
  for (let i = first; i < Math.min(n, last); i++) {
    const o = i * 4
    // (Silent dots never glow.)
    if (grad[o + 2] < 0.003 || style[o + 2] === GHOST_ROW || LEVELS[Math.min(3, Math.floor(weights[i] * 4))] < from) continue
    const stem = Math.max(0, stems[i])
    const row = tinted ? rowOf(s.tint === 'sections' ? 'blue' : STEM_HUE[ORDER[stem]]) : style[o + 2]
    const t0 = tinted ? s.tone : grad[o], t1 = tinted ? s.tone : grad[o + 1]
    if (!target.bars.push({
      x: pos[o], y: pos[o + 1], w: pos[o + 2], h: pos[o + 3], t0, t1, alpha: grad[o + 2],
      rotation: style[o], feather: style[o + 1], row, radius: style[o + 3], stem,
    })) break
  }
}

/** Haze: the finished marks blurred together under the crisp ones (far and near layers, as Dots and Barcode). */
function haze({ layers, ink }: FrameContext, p: Record<string, any>) {
  const bars = layers.bars
  for (const [layer, near] of [[layers.barsFar, false], [layers.barsMid, true]] as const) {
    const s = mainHaze(p, near)
    setupHaze(layer, bars, s)
    hazeFrom(layer, bars, s, ink)
  }
  const crisp = clamp01(p.crisp)
  if (crisp < 1) for (let i = 0; i < bars.count; i++) bars.grad[i * 4 + 2] *= crisp
}

/** Every mark drawn as one of the typed characters, in its colour, at its size and angle (over or instead of it). */
function marksAsChars({ layers, viewport, text, glyphsFor }: FrameContext, p: Record<string, any>) {
  const chars = typedChars(p)
  if (!chars) return
  const glyphs = glyphsFor(chars)
  if (!glyphs.length) return
  const bars = layers.bars
  const n = bars.count
  if (weights.length < n) weights = new Float32Array(n)
  weightsOf(bars, weights)
  const { pos, grad, style, stems } = bars
  const W = viewport.width, H = viewport.height
  const em = text.fontSize || 1
  const G = glyphs.length
  const only = p.marksAs === 'chars'
  let k = 0
  for (let i = 0; i < n; i++) {
    const o = i * 4
    const w = pos[o + 2], h = pos[o + 3], a = grad[o + 2]
    // Page furniture (rules across the page) and the faintest marks stay as they are.
    if (w > W * 0.5 || h > H * 0.5 || a < 0.01) continue
    const px = Math.sqrt(w * h)
    if (px < p.charMin) continue
    const j = p.charOrder === 'cycle' ? k++ % G
      : p.charOrder === 'random' ? Math.floor(((Math.sin(pos[o] * 12.9898 + pos[o + 1] * 78.233) * 43758.5453) % 1 + 1) % 1 * G)
      : p.charOrder === 'stem' ? Math.max(0, stems[i]) % G
      : Math.min(G - 1, Math.floor(weights[i] * G))
    bars.sampleRow(style[o + 2], 0.5 * (grad[o] + grad[o + 1]), rgb)
    const ok = writeOutline(layers.outlines, glyphs[j], { x: pos[o], y: pos[o + 1], rotation: style[o], scale: (px * p.charSize) / em }, {
      r: rgb[0], g: rgb[1], b: rgb[2], a: Math.min(1, a),
    })
    if (!ok) break
    if (only) grad[o + 2] = 0
  }
}
