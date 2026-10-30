import type { Stem } from '../../audio/features'
import type { BarSpec } from '../../engine/barLayer'
import { getFont } from '../../text/fonts/registry'
import type { FrameContext, ModeDefinition, ModeInstance, ModePreset } from '../types'
import { writeGlyph, writeOutline } from '../shared/glyphs'
import { Units } from './units'
import { dotShapeKeys, dotShapeParams, shapeDot, shapesDots } from '../shared/dotShape'
import { dropFx } from '../../engine/dropFx'
import typeToDotsLook from './typeToDots.json'
import {
  HAIR, HEAVY, MEDIUM, ORDER, ROW_INK, ROW_MULTI, SOLID, STEM_HUE, barcodeGradients, drawHaze, hazeKeys, hazeParams, rowOf,
} from '../sequencer/barcode'
import { MOTIONS, motionKeys, motionOf, motionParams, motionValues } from '../sequencer/motions'
import { applyMove, type DotMotionInstance, type MarkInfo, type MarkMove, type MotionFrame } from '../sequencer/motions/types'
import { PALETTES, paletteOf, paletteRow } from '../sequencer/palettes'
import { hash } from '../sequencer/palettes/types'

// Type Dots: the text turned into a dot matrix, in the Dots look. The laid-out
// letters are drawn once to an offscreen canvas and sampled on a square grid:
//   coverage  each grid point's share of ink (box-averaged, `sub` x `sub`
//             samples per cell); above `inside` it is a letter dot, sized and
//             toned by how deep in the stroke it sits (edges small and light,
//             the heart of a stem big and dark); points within `pad` dots of
//             a letter are ghosts, a halo of the matrix around the words
//   parts     each glyph / word / line belongs to a stem (vocals, instruments,
//             drums, bass, in turn), or the stems split the page across
//   colour    as Dots: ink, stem hues, the multi-hue gradient, or any of the
//             Dots palette explorations; `accent` share of letter dots in red
//   music     the picture holds still; the Dots motions move it (breathe,
//             ripple, drift) with the live audio; the playhead runs
//             along `time` (across = reading direction) over `bars` bars
//   letters   the music lights the letters (units: glyph / word / line, see
//             units.ts): lit letters swell and darken, the rest dim
//   haze      as Dots / Barcode: the dots again, blurred together underneath
// Type → Dots: the same, but the page shows the plain text until a unit is
// lit; then each letter morphs into its dots in place, metaball-like: the
// letter and its growing dots are blurred together and cut at half (the goo
// layer), so the letter pinches and breaks into the dots and its ink blends
// into their colours. A lit unit morphs in over `morphIn`, stays `stay` s,
// and morphs back over `morphOut`. Always as laid out (no `fit`).

/** The stem each instrument a letter can be given to joins (LAYERS order: kick, snare, hats, bass, lead, pad, fx). */
const LAYER_STEM: Stem[] = ['drums', 'drums', 'drums', 'bass', 'vocals', 'instruments', 'instruments']

/** Bars the layers hold (4096). */
const BUDGET = 4000

const clamp01 = (v: number) => Math.min(1, Math.max(0, v))
const lerp = (a: number, b: number, t: number) => a + (b - a) * t
const smooth01 = (x: number) => { const t = clamp01(x); return t * t * (3 - 2 * t) }

const params = {
  fit: { type: 'number', value: 0.88, min: 0, max: 1, step: 0.01, label: 'fit text to page (0 = as laid out)' },
  pitch: { type: 'number', value: 5, min: 3, max: 40, step: 0.5, label: 'dot pitch (px)' },
  sub: { type: 'number', value: 4, min: 1, max: 8, step: 1, label: 'samples per dot' },
  inside: { type: 'number', value: 0.3, min: 0.05, max: 0.95, step: 0.01, label: 'letter if ink above' },
  depth: { type: 'number', value: 1, min: 0, max: 6, step: 1, label: 'stroke depth (dots)' },
  pad: { type: 'number', value: 3, min: 0, max: 40, step: 1, label: 'ghosts around letters (dots)' },
  ghost: { type: 'number', value: 0.6, min: 0, max: 1, step: 0.01, label: 'ghost dots' },

  assign: {
    type: 'select', value: 'word', label: 'part by',
    options: { glyph: 'glyph', word: 'word', line: 'line', 'across the page': 'across' },
  },
  palette: {
    type: 'select', value: 'across', label: 'dot colour',
    options: { ink: 'ink', stems: 'stems', 'across hues': 'across', ...Object.fromEntries(PALETTES.map((pl) => [pl.label, pl.id])) },
  },
  offset: { type: 'number', value: 0.2, min: 0, max: 1, step: 0.01, label: 'ramp offset per part (across)' },
  accent: { type: 'number', value: 0.04, min: 0, max: 0.3, step: 0.005, label: 'red share of letter dots' },

  dotMin: { type: 'number', value: 0.1, min: 0.02, max: 0.3, step: 0.005, label: 'ghost dot (of pitch)' },
  dotEdge: { type: 'number', value: 0.2, min: 0.05, max: 0.5, step: 0.005, label: 'edge dot' },
  dotCore: { type: 'number', value: 0.44, min: 0.1, max: 0.8, step: 0.005, label: 'core dot' },
  soft: { type: 'number', value: 0.4, min: 0, max: 1, step: 0.01, label: 'dot softness' },
  paper: { type: 'number', value: 0.03, min: 0, max: 0.15, step: 0.005, label: 'paper grain' },

  motion: { type: 'select', value: 'breathe', options: { still: 'still', ...Object.fromEntries(MOTIONS.map((m) => [m.label, m.id])) } },
  motionAmount: { type: 'number', value: 0.6, min: 0, max: 1, step: 0.01, label: 'motion amount' },
  motionSpeed: { type: 'number', value: 1, min: 0.1, max: 4, step: 0.05, label: 'motion speed' },
  time: { type: 'select', value: 'across', label: 'playhead runs', options: { across: 'across', down: 'down' } },
  bars: { type: 'number', value: 2, min: 1, max: 16, step: 1, label: 'playhead pass (bars)' },
  ...motionParams,

  react: {
    type: 'select', value: 'karaoke', label: 'letters light by',
    options: { 'reading playhead': 'karaoke', 'onsets (as Haze)': 'hits', 'their part': 'stems', loudness: 'level', 'always lit': 'none' },
  },
  grouping: { type: 'select', value: 'word', label: 'light per', options: { glyph: 'glyph', word: 'word', line: 'line' } },
  density: { type: 'number', value: 0.15, min: 0, max: 1, step: 0.01, label: 'onset density' },
  spectrum: { type: 'number', value: 0.2, min: 0, max: 1, step: 0.01, label: 'band response' },
  attack: { type: 'number', value: 0.05, min: 0.01, max: 0.6, step: 0.01 },
  release: { type: 'number', value: 0.8, min: 0.05, max: 5, step: 0.05 },
  lift: { type: 'number', value: 0.35, min: 0, max: 1.5, step: 0.01, label: 'lit dots grow' },
  darken: { type: 'number', value: 0.15, min: 0, max: 0.6, step: 0.01, label: 'lit dots darken' },
  dim: { type: 'number', value: 0.55, min: 0, max: 1, step: 0.01, label: 'unlit dim' },

  ...dotShapeParams,
  ...hazeParams,
  // Past 100%: the blurred haze is thin, so let it be pushed toward solid.
  hazeOpacity: { ...hazeParams.hazeOpacity, max: 10 },
} as const

/** Type → Dots: no fit (the dots sit on the type), lit on onsets per glyph; how the type hands over. */
const { fit: _fit, ...shared } = params
const triggerParams = {
  ...shared,
  pitch: { ...params.pitch, value: 3 },
  react: { ...params.react, value: 'hits' },
  grouping: { ...params.grouping, value: 'glyph' },
  release: { ...params.release, value: 1.3 },
  morphIn: { type: 'number', value: 0.6, min: 0.05, max: 4, step: 0.05, label: 'morph to dots (s)' },
  stay: { type: 'number', value: 0.8, min: 0, max: 8, step: 0.05, label: 'stay as dots (s)' },
  morphOut: { type: 'number', value: 1, min: 0.05, max: 4, step: 0.05, label: 'morph back (s)' },
  gooBlur: { type: 'number', value: 1.6, min: 0.5, max: 16, step: 0.1, label: 'goo blur (px)' },
  gooGain: { type: 'number', value: 1, min: 1, max: 4, step: 0.05, label: 'goo fill' },
  bulge: { type: 'number', value: 0.25, min: 0, max: 2, step: 0.01, label: 'dots swell mid-morph' },
} as const

const groups = {
  Grid: ['fit', 'pitch', 'sub', 'inside', 'depth', 'pad', 'ghost'],
  Colour: ['assign', 'palette', 'offset', 'accent'],
  Dots: ['dotMin', 'dotEdge', 'dotCore', 'soft', 'paper'],
  Letters: ['react', 'grouping', 'density', 'spectrum', 'attack', 'release', 'lift', 'darken', 'dim'],
  Motion: ['motion', 'motionAmount', 'motionSpeed', 'time', 'bars', ...motionKeys],
  'Dot shape': dotShapeKeys,
  Haze: hazeKeys,
}
const triggerGroups = {
  ...groups,
  Grid: groups.Grid.filter((k) => k !== 'fit'),
  Letters: ['react', 'grouping', 'density', 'spectrum', 'attack', 'release', 'lift', 'darken'],
  Morph: ['morphIn', 'stay', 'morphOut', 'gooBlur', 'gooGain', 'bulge'],
}

/** Settings that only move the picture, never rebuild it. */
const MOTION_KEYS = new Set([
  ...motionKeys, ...dotShapeKeys, 'motion', 'motionAmount', 'motionSpeed', 'time', 'bars', ...hazeKeys,
  'react', 'density', 'spectrum', 'attack', 'release', 'lift', 'darken', 'dim', 'morphIn', 'stay', 'morphOut', 'gooBlur', 'gooGain', 'bulge',
])

interface Picture {
  marks: BarSpec[]
  info: MarkInfo[]
  stems: number[]
  weights: number[]
  sections: number[]
  /** Nearest glyph (index) per mark. */
  glyph: number[]
  /** Grid size: columns, rows, pitch. */
  cols: number
  rows: number
  pitch: number
}

/** Cells within `pad` cells (square) of a letter cell: a separable max. */
function nearMask(cover: Float32Array, cols: number, rows: number, inside: number, pad: number) {
  const a = new Uint8Array(cols * rows), b = new Uint8Array(cols * rows)
  for (let i = 0; i < a.length; i++) a[i] = cover[i] >= inside ? 1 : 0
  if (pad <= 0) return a
  for (let r = 0; r < rows; r++) {
    let last = -1e9
    for (let c = 0; c < cols; c++) { if (a[r * cols + c]) last = c; if (c - last <= pad) b[r * cols + c] = 1 }
    last = 1e9
    for (let c = cols - 1; c >= 0; c--) { if (a[r * cols + c]) last = c; if (last - c <= pad) b[r * cols + c] = 1 }
  }
  a.fill(0)
  for (let c = 0; c < cols; c++) {
    let last = -1e9
    for (let r = 0; r < rows; r++) { if (b[r * cols + c]) last = r; if (r - last <= pad) a[r * cols + c] = 1 }
    last = 1e9
    for (let r = rows - 1; r >= 0; r--) { if (b[r * cols + c]) last = r; if (last - r <= pad) a[r * cols + c] = 1 }
  }
  return a
}

/** Ink coverage of the laid-out text, `cols` x `rows` cells of `pitch` px centred on the page. */
export function rasterise(frame: FrameContext, zoom: number, cols: number, rows: number, pitch: number, sub: number) {
  const { text, base, fontId } = frame
  const font = getFont(fontId)
  const cw = cols * sub, ch = rows * sub
  const k = sub / pitch
  const canvas = new OffscreenCanvas(cw, ch)
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!
  ctx.fillStyle = '#000'
  ctx.textBaseline = 'alphabetic'
  // Page px (origin centre, y up) -> canvas px.
  const X = (x: number) => cw / 2 + x * k
  const Y = (y: number) => ch / 2 - y * k
  for (const g of text.glyphs) {
    const p = base[g.index]
    if (!p) continue
    const s = p.scale * zoom
    ctx.font = `${font.style} ${font.weight} ${text.fontSize * s * k}px "${font.family}"`
    const cos = Math.cos(p.rotation), sin = Math.sin(p.rotation)
    // The glyph origin (pen, baseline): the quad centre less the glyph's centre offset, rotated.
    const ox = p.x * zoom - (g.cx * cos - g.cy * sin) * s
    const oy = p.y * zoom - (g.cx * sin + g.cy * cos) * s
    ctx.save()
    ctx.translate(X(ox), Y(oy))
    ctx.rotate(-p.rotation)
    ctx.fillText(g.char, 0, 0)
    ctx.restore()
  }
  const data = ctx.getImageData(0, 0, cw, ch).data
  const cover = new Float32Array(cols * rows)
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) {
      let sum = 0
      for (let j = 0; j < sub; j++) for (let i = 0; i < sub; i++) sum += data[((r * sub + j) * cw + c * sub + i) * 4 + 3]
      cover[r * cols + c] = sum / (255 * sub * sub)
    }
  return cover
}

function generate(frame: FrameContext, p: Record<string, any>): Picture {
  const { text, base, viewport } = frame
  const W = viewport.width, H = viewport.height
  let pitch = Math.max(2, p.pitch)
  const sub = Math.max(1, Math.round(p.sub))

  // Glyph boxes on the page, for the parts and the ghost area; `fit` scales the whole text to the page.
  const boxes = text.glyphs.map((g) => {
    const pl = base[g.index]
    const s = pl?.scale ?? 1
    return { g, x: pl?.x ?? 0, y: pl?.y ?? 0, r: 0.5 * Math.hypot(g.w, g.h) * s, hw: 0.5 * g.w * s, hh: 0.5 * g.h * s }
  })
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity
  for (const b of boxes) {
    x0 = Math.min(x0, b.x - b.hw); x1 = Math.max(x1, b.x + b.hw)
    y0 = Math.min(y0, b.y - b.hh); y1 = Math.max(y1, b.y + b.hh)
  }
  if (!boxes.length) x0 = x1 = y0 = y1 = 0
  const reach = Math.max(1e-3, 2 * Math.max(-x0, x1) / W, 2 * Math.max(-y0, y1) / H)
  const zoom = p.fit > 0 ? p.fit / reach : 1
  for (const b of boxes) { b.x *= zoom; b.y *= zoom; b.r *= zoom }
  x0 *= zoom; x1 *= zoom; y0 *= zoom; y1 *= zoom

  // Coarsen the grid until the dots fit the layer.
  let cols = 0, rows = 0, cover = new Float32Array(0), near = new Uint8Array(0)
  for (let tries = 0; tries < 12; tries++) {
    cols = Math.max(1, Math.floor(W / pitch))
    rows = Math.max(1, Math.floor(H / pitch))
    cover = rasterise(frame, zoom, cols, rows, pitch, sub)
    near = nearMask(cover, cols, rows, p.inside, p.ghost > 0 ? Math.round(p.pad) : 0)
    const n = near.reduce((a, b) => a + b, 0)
    if (n <= BUDGET) break
    pitch *= Math.sqrt(n / BUDGET) * 1.02
  }

  // Depth in the stroke: the share of letter cells within `depth` dots.
  const D = Math.max(0, Math.round(p.depth))
  const inside = (c: number, r: number) => c >= 0 && r >= 0 && c < cols && r < rows && cover[r * cols + c] >= p.inside
  const depthAt = (c: number, r: number) => {
    if (!D) return cover[r * cols + c]
    let n = 0, t = 0
    for (let j = -D; j <= D; j++) for (let i = -D; i <= D; i++) if (i * i + j * j <= D * D + D) { t++; if (inside(c + i, r + j)) n++ }
    return n / t
  }

  // Parts: which stem a letter dot belongs to, by its nearest glyph.
  const partOf = (x: number, y: number): { stem: Stem; sec: number; within: number; gi: number } => {
    let best = boxes[0], bd = Infinity
    for (const b of boxes) {
      const d = (b.x - x) ** 2 + (b.y - y) ** 2
      if (d < bd) { bd = d; best = b }
    }
    const g = best?.g
    const n = p.assign === 'glyph' ? g?.index ?? 0 : p.assign === 'line' ? g?.line ?? 0 : p.assign === 'word' ? g?.word ?? 0 : Math.floor(clamp01((x - x0) / Math.max(1, x1 - x0)) * 3.999)
    // A letter given to an instrument on the stage joins that instrument's stem.
    const given = g ? frame.parts.of[g.index] ?? -1 : -1
    const stem = given >= 0 ? LAYER_STEM[given] : ORDER[n % ORDER.length]
    return { stem, sec: g?.line ?? 0, within: best ? clamp01((x - (best.x - best.r)) / (2 * best.r)) : 0.5, gi: g?.index ?? 0 }
  }

  const pic: Picture = { marks: [], info: [], stems: [], weights: [], sections: [], glyph: [], cols, rows, pitch }
  const explore = paletteOf(p.palette)
  const pal = PALETTES[explore]
  const across = p.time !== 'down'
  const T = across ? cols : rows, N = across ? rows : cols
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) {
      if (!near[r * cols + c]) continue
      const x = (c + 0.5 - cols / 2) * pitch, y = (rows / 2 - r - 0.5) * pitch
      const letter = inside(c, r)
      const { stem, sec, within, gi } = partOf(x, y)
      const lv = letter ? clamp01(depthAt(c, r)) : 0
      const core = letter && lv > 0.85
      const kind = !letter ? 'ghost' : core ? 'event' : 'base'
      const red = letter && p.accent > 0 && hash(c, r, 7) < p.accent
      const g = across ? c : r, l = across ? r : c
      /** Gradient row, position, and alpha / size factors for a dot of this kind here. */
      const look = (k: 'ghost' | 'base' | 'event', v: number, isLetter: boolean, rd: boolean): [number, number, number, number] => {
        if (pal) {
          const out = pal.paint({ kind: k, lv: k === 'event' ? clamp01((v - 0.85) / 0.15) : v, stem, sec, red: rd, g, l, T, N, u: x / W, v: y / H, within, offset: p.offset })
          return [paletteRow(explore, out.row), clamp01(out.t), out.alpha ?? 1, out.size ?? 1]
        }
        if (rd) return [rowOf('red'), 0.5 + 0.3 * v, 1, 1]
        if (p.palette === 'ink') return [ROW_INK, isLetter ? 0.3 + 0.7 * v : 0.22, 1, 1]
        if (p.palette === 'stems') return [rowOf(STEM_HUE[stem]), isLetter ? 0.2 + 0.7 * v : 0.08, 1, 1]
        return isLetter ? [ROW_MULTI, 0.6 * v + p.offset * ORDER.indexOf(stem), 1, 1] : [ROW_INK, 0.22, 1, 1]
      }
      const [row, t, am, sm] = look(kind, lv, letter, red)
      const alpha = (letter ? lerp(0.7, 1, lv) : p.ghost) * am
      const rad = (letter ? lerp(p.dotEdge, p.dotCore, lv) : p.dotMin) * pitch * sm
      // As a lit dot (a motion lighting it): the core of its part's letters.
      const [eRow, eT, , esm] = look('event', 1, true, false)
      const er = Math.max(rad, p.dotCore * pitch * esm)
      pic.marks.push({ x, y, w: 2 * rad, h: 2 * rad, radius: rad, t0: t, t1: t, row, alpha, feather: Math.max(0.5, p.soft * rad * 0.6) })
      pic.info.push({ x, y, r: rad, g, l, stem, kind, lv, sec, step: 0, t, er, eRow, eT })
      pic.stems.push(ORDER.indexOf(stem))
      pic.weights.push(!letter ? 0 : red || lv > 0.85 ? SOLID : lv > 0.6 ? HEAVY : lv > 0.3 ? MEDIUM : HAIR)
      pic.sections.push(sec)
      pic.glyph.push(gi)
    }
  return pic
}

/** Both modes: `trigger` = Type → Dots (type until lit). */
function makeCreate(trigger: boolean) {
  return function create(): ModeInstance {
    let pic: Picture | null = null
    let key = ''
    let motion: DotMotionInstance | null = null
    let motionKey = ''
    let moved: BarSpec[] = []
    /** Trigger: the marks the haze blurs, strengthening over the whole morph (the crisp dots only land at its end). */
    let hazed: BarSpec[] = []
    /** Whether the dots were reshaped last frame (so going back to round clears their angle). */
    let shaped = false
    const move: MarkMove = { dx: 0, dy: 0, size: 1, alpha: 1, t: 0, lit: 0, hueBySize: 0 }
    const units = new Units()
    const own: Record<string, any> = {}
    /** Part per unit (for `stems`), and per glyph how lit it was last (trigger: the type's fade). */
    let unitStem: Stem[] = []
    /** Trigger, per unit: how far it has morphed to dots (0 type .. 1 dots), and how long it stays. */
    let morph = new Float32Array(0)
    let stayFor = new Float32Array(0)

    return {
      update(frame) {
        const { layers, viewport, ink, params: p, text, base, audio, time, dt } = frame
        const W = viewport.width, H = viewport.height
        const { bars } = layers
        bars.blend = 'normal'
        barcodeGradients(bars, ink)
        for (const layer of [bars, layers.barsFar.bars, layers.barsMid.bars])
          PALETTES.forEach((pl, i) => pl.rows.forEach((hexes, r) => layer.setGradient(hexes, paletteRow(i, r))))
        layers.grain.value = p.paper
        if (!trigger) layers.glyphs.count = 0
        if (!text.glyphs.length) return

        units.sync(text, p.grouping)
        // Rebuild when the text, its layout, the page or a picture setting changes.
        const placed = base.reduce((s, b) => s + b.x * 1.3 + b.y * 0.7 + b.rotation + b.scale, 0)
        const k = `${frame.fontId}:${text.fontSize}:${text.glyphs.map((g) => g.char).join('')}:${placed.toFixed(2)}:${W}x${H}:${frame.parts.key}:${JSON.stringify(p, (kk, v) => (MOTION_KEYS.has(kk) ? undefined : v))}`
        if (k !== key || !pic) {
          key = k
          pic = generate(frame, p)
          moved = pic.marks.map((m) => ({ ...m }))
          hazed = pic.marks.map((m) => ({ ...m }))
          unitStem = Array.from({ length: units.count }, (_, u) => ORDER[u % ORDER.length])
          pic.glyph.forEach((gi, i) => (unitStem[units.of[gi]] = ORDER[pic!.stems[i]]))
          motionKey = ''
        }
        units.update(audio, dt, p, (u) => unitStem[u] ?? 'vocals')
        const env = units.env
        // Trigger: a lit unit morphs to dots, stays, then morphs back (linear clocks; eased where used).
        if (trigger) {
          if (morph.length !== units.count) { morph = new Float32Array(units.count); stayFor = new Float32Array(units.count) }
          for (let u = 0; u < units.count; u++) {
            if (env[u] > 0.3) stayFor[u] = p.stay
            else stayFor[u] = Math.max(0, stayFor[u] - dt)
            const up = env[u] > 0.3 || stayFor[u] > 0
            morph[u] = clamp01(morph[u] + (up ? dt / Math.max(0.05, p.morphIn) : -dt / Math.max(0.05, p.morphOut)))
          }
        }
        const band = (a: number, b: number, x: number) => smooth01((x - a) / (b - a))
        const goo = layers.goo
        if (trigger) {
          goo.radius = p.gooBlur
          goo.stretch = 1
          goo.gain.value = p.gooGain
          goo.edge.value = 0.92
          goo.opacity.value = 1
          barcodeGradients(goo.bars, ink)
          PALETTES.forEach((pl, i) => pl.rows.forEach((hexes, r) => goo.bars.setGradient(hexes, paletteRow(i, r))))
        }

        const kind = motionOf(p.motion)
        const moving = !!kind && p.motionAmount > 0
        const across = p.time !== 'down'
        const T = across ? pic.cols : pic.rows, N = across ? pic.rows : pic.cols
        const len = Math.max(1, Math.round(p.bars)) * 16
        const f: MotionFrame = {
          time, dt, audio, position: audio.beat.position, w0: 0, w1: len, stepsPer: len / T,
          T, N, Rw: T, S: 1, pX: pic.pitch, pY: pic.pitch, W, H, amount: clamp01(p.motionAmount), speed: p.motionSpeed,
          params: kind ? motionValues(kind, p, own) : own,
        }
        if (moving) {
          const mk = `${k}:${kind!.id}:${p.time}`
          if (motionKey !== mk) {
            motionKey = mk
            motion = kind!.create(pic.info)
          }
          motion!.frame?.(f)
        }
        // Each mark: rest -> the motion's move -> how lit its letter is.
        for (let i = 0; i < pic.marks.length; i++) {
          const m = pic.marks[i], o = moved[i], info = pic.info[i]
          move.dx = 0; move.dy = 0; move.size = 1; move.alpha = 1; move.t = 0; move.lit = 0; move.hueBySize = 0
          if (moving) motion!.mark(i, info, f, move)
          const e = env[units.of[pic.glyph[i]]] ?? 0
          const ghost = info.kind === 'ghost'
          let size = move.size, alpha = move.alpha, dt0 = move.t
          if (trigger) {
            // In place: crisp only at the end of the morph; mid-morph the dot grows in the goo with its letter.
            const s = morph[units.of[pic.glyph[i]]] ?? 0
            size *= 1 + p.lift * e
            dt0 += p.darken * e
            if (!ghost && s > 0.001 && s < 0.999) {
              const gr = (m.radius ?? 0) * size * band(0.05, 0.8, s) * (1 + p.bulge * Math.sin(Math.PI * s))
              if (gr > 0.05) goo.bars.push({ ...m, x: m.x + move.dx, y: m.y + move.dy, w: 2 * gr, h: 2 * gr, radius: gr, alpha: 1 - band(0.9, 1, s), t0: clamp01(m.t0 + dt0), t1: clamp01(m.t0 + dt0) })
            }
            const h = hazed[i], hr = (m.radius ?? 0) * Math.max(0, size) * band(0, 0.7, s)
            h.x = m.x + move.dx; h.y = m.y + move.dy
            h.w = h.h = 2 * hr; h.radius = hr
            h.alpha = clamp01((m.alpha ?? 1) * alpha * smooth01(s))
            h.t0 = h.t1 = clamp01(m.t0 + dt0)
            alpha *= ghost ? band(0.4, 1, s) : band(0.85, 1, s)
          } else {
            size *= lerp(1 - 0.5 * p.dim, 1 + p.lift * (ghost ? 0.3 : 1), e)
            alpha *= lerp(1 - p.dim, 1, e)
            dt0 += p.darken * e * (ghost ? 0.3 : 1)
          }
          move.size = size; move.alpha = alpha; move.t = dt0
          applyMove(m, info, move, o)
          // Type → Dots rests as type: a dropped image's ripple and held colours show its dots (and their haze).
          if (trigger && dropFx.any) {
            const v = dropFx.reveal(o.x, o.y) * (ghost ? 0.6 : 1)
            if (v > 0.01) {
              const r = Math.max(o.radius ?? 0, (m.radius ?? 0) * 0.8)
              o.w = o.h = 2 * r; o.radius = r
              o.alpha = Math.max(o.alpha ?? 0, v)
              const hz = hazed[i]
              if (hz) { hz.w = hz.h = 2 * r; hz.radius = r; hz.alpha = Math.max(hz.alpha ?? 0, v) }
            }
          }
        }

        // Type → Dots: crisp type at rest; mid-morph the letter is in the goo, fading so it pinches into its dots.
        if (trigger) {
          const [r, g, b] = ink
          for (const gl of text.glyphs) {
            const pl = base[gl.index]
            if (!pl) continue
            const s = morph[units.of[gl.index]] ?? 0
            writeGlyph(layers.glyphs, gl, pl, { r, g, b, a: 1 - band(0, 0.1, s) })
            if (s > 0.001 && s < 0.999) writeOutline(goo.glyphs, gl, pl, { r, g, b, a: 1 - band(0.1, 0.75, s) })
          }
        }

        // Dot shape: dashes / bars of any length, roundness and angle, varied by noise (shared/dotShape.ts).
        const shaping = shapesDots(p)
        if (shaping || shaped) {
          for (const list of trigger ? [moved, hazed] : [moved]) for (const o of list) {
            if (shaping) shapeDot(o, p, time)
            else o.rotation = 0
          }
        }
        shaped = shaping
        const pc = pic
        const marks = moved
        if (p.hazeBlur > 0) drawHaze(layers, { marks: trigger ? hazed : marks, stems: pc.stems, weights: pc.weights, section: (i) => pc.sections[i] }, p, ink)
        const crisp = clamp01(p.crisp)
        if (crisp > 0.001) for (const m of marks) if ((m.alpha ?? 1) > 0.003 && (m.radius ?? 0) > 0.05) bars.push(crisp < 1 ? { ...m, alpha: (m.alpha ?? 1) * crisp } : m)
      },
    }
  }
}

const PAPER = { background: '#f4f5f7', ink: '#121317' }
/** As the Dots default, tighter and unstretched so the letters still read. */
const HAZE = { hazeBlur: 3, hazeStretch: 1, hazeMid: 0.47, hazeGain: 5, hazeEdge: 0.45, hazeTone: 0.62 }

const presets: Record<string, ModePreset> = {
  // Crisp dots; a reading playhead lights the words in turn, breathing gently.
  Default: { params: { motionAmount: 0.4 }, ...PAPER },
  'Onsets light letters': { params: { react: 'hits', grouping: 'glyph', motionAmount: 0.3, release: 1 }, ...PAPER },
  'Parts breathe': { params: { react: 'stems', grouping: 'word', motion: 'still', lift: 0.6, dim: 0.4 }, ...PAPER },
  'Tight haze': { params: { ...HAZE }, ...PAPER },
  'Soft haze': { params: { ...HAZE, hazeBlur: 6, hazeStretch: 2, hazeGain: 8 }, ...PAPER },
  'Coarse matrix': { params: { pitch: 10, sub: 6, depth: 2, inside: 0.25, ...HAZE, hazeBlur: 6, hazeStretch: 2, hazeGain: 8 }, ...PAPER },
  'Ink, rippling': { params: { palette: 'ink', accent: 0.06, react: 'none', motion: 'ripple', motionAmount: 0.8, ...HAZE, hazeTint: 'stems', hazeTone: 0.4 }, ...PAPER },
  ...Object.fromEntries(PALETTES.map((pl) => [`Palette · ${pl.label}`, { params: { palette: pl.id, motionAmount: 0.4 }, ...PAPER }])),
  ...Object.fromEntries(MOTIONS.map((m) => [`Motion · ${m.label}`, { params: { react: 'none', motion: m.id, motionAmount: 0.8 }, ...PAPER }])),
}

const triggerPresets: Record<string, ModePreset> = {
  // Plain type; onsets turn single letters into their dots, which settle back into type.
  // The defaults (typeToDots.json).
  Default: { params: {}, ...PAPER },
  'Words, breathing': { params: { grouping: 'word', density: 0.2, motion: 'breathe', motionAmount: 0.4 }, ...PAPER },
  'Reading playhead': { params: { react: 'karaoke', grouping: 'word', release: 1.5, motion: 'still' }, ...PAPER },
  'Dots linger': { params: { stay: 3, morphOut: 2, ghost: 0.35, motion: 'breathe', motionAmount: 0.3 }, ...PAPER },
  'Slow goo': { params: { morphIn: 1.6, morphOut: 2.4, gooBlur: 3, gooGain: 1.3, bulge: 0.6 }, ...PAPER },
  'Quick snap': { params: { morphIn: 0.2, stay: 0.3, morphOut: 0.5, gooBlur: 1.2, bulge: 0.15 }, ...PAPER },
  Hazy: { params: { ...HAZE, hazeBlur: 4, stay: 1.5 }, ...PAPER },
  ...Object.fromEntries(PALETTES.map((pl) => [`Palette · ${pl.label}`, { params: { palette: pl.id, motion: 'still' }, ...PAPER }])),
}

export const typeDots: ModeDefinition = {
  id: 'typeDots',
  label: 'Type Dots',
  params,
  groups,
  presets,
  create: makeCreate(false),
}

/**
 * Type → Dots' look as set in the app (typeToDots.json): these are its defaults, so a fresh page and its
 * Default preset start here. Copied per setting, since Type Dots shares the rest of these definitions.
 */
for (const [k, v] of Object.entries(typeToDotsLook)) {
  const defs = triggerParams as unknown as Record<string, { value: unknown } | undefined>
  const def = defs[k]
  if (def) defs[k] = { ...def, value: v }
}

export const typeToDots: ModeDefinition = {
  id: 'typeToDots',
  label: 'Type → Dots',
  params: triggerParams,
  groups: triggerGroups,
  presets: triggerPresets,
  create: makeCreate(true),
}
