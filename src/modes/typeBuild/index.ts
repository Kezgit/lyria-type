import type { ParamSchema } from '../../app/params'
import type { BarLayer } from '../../engine/barLayer'
import type { BlobLayer } from '../../engine/blobLayer'
import type { GlyphLayer } from '../../engine/glyphLayer'
import type { Placement } from '../../layout/types'
import { writeGlyph } from '../shared/glyphs'
import { sequencer } from '../sequencer'
import { LOOKS, lookParams } from '../stencil'
import { rasterise } from '../typeDots'
import type { FrameContext, ModeDefinition, ModeInstance, ModePreset } from '../types'

// Type Build: the Sequencer's picture growing as its window widens (span
// from a bar or two up to the whole song, the way the Window slider fills the
// matrix), and as it grows, the music's marks gather into the typed text.
// Nothing new is drawn and nothing flows: the Sequencer draws its picture
// as usual, and each mark is then kept or dropped by where it sits.
//   inside the letters  every mark stays; the small (quiet) dots swell by
//                       and deepen by `boost`, so the letters read even where few notes land
//   outside             the strong marks thin out by `focus` as the build
//                       goes on (a share, `outside`, stays); the quiet grid
//                       dims to `grid`
//   edge                ragged by `loose` px: dots near a letter may join it
// Then it holds and shrinks back, and the next build starts. `fill` widens
// the Dots matrix to the whole frame, so the words can run right across it.

const params: ParamSchema = {
  look: { type: 'select', value: 'dots|Whole song', label: 'pattern', options: LOOKS },
  spanFrom: { type: 'number', value: 1, min: 0, max: 128, step: 1, label: 'start at (bars of the song)' },
  spanTo: { type: 'number', value: 128, min: 1, max: 256, step: 1, label: 'grow to (bars)' },
  fill: { type: 'boolean', value: true, label: 'dots fill the frame' },
  orient: { type: 'select', value: 'down', label: 'sequencer runs', options: { 'top → down (upright)': 'down', 'left → right (on its side)': 'across' } },

  textScale: { type: 'number', value: 1, min: 0.2, max: 4, step: 0.01, label: 'scale text' },
  textAngle: { type: 'number', value: 0, min: -180, max: 180, step: 1, label: 'turn text (°)' },
  textX: { type: 'number', value: 0, min: -1, max: 1, step: 0.005, label: 'move text x' },
  textY: { type: 'number', value: 0, min: -1, max: 1, step: 0.005, label: 'move text y' },

  gatherBy: {
    type: 'select', value: 'auto', label: 'words made by',
    options: { 'auto (dots: whole dots, others: cut)': 'auto', 'whole marks kept or dropped': 'marks', 'cutting the picture to the letters': 'cut' },
  },
  focus: { type: 'number', value: 1, min: 0, max: 1, step: 0.01, label: 'gather into the text' },
  tint: { type: 'number', value: 0.12, min: 0, max: 1, step: 0.01, label: 'letters tinted with ink (cut)', showIf: { key: 'gatherBy', is: ['auto', 'cut'] } },
  patScale: { type: 'number', value: 1, min: 0.25, max: 4, step: 0.01, label: 'scale picture (cut)', showIf: { key: 'gatherBy', is: ['auto', 'cut'] } },
  patX: { type: 'number', value: 0, min: -1, max: 1, step: 0.005, label: 'move picture x (cut)', showIf: { key: 'gatherBy', is: ['auto', 'cut'] } },
  patY: { type: 'number', value: 0, min: -1, max: 1, step: 0.005, label: 'move picture y (cut)', showIf: { key: 'gatherBy', is: ['auto', 'cut'] } },
  outside: { type: 'number', value: 0.06, min: 0, max: 1, step: 0.01, label: 'left outside the letters' },
  grid: { type: 'number', value: 0.35, min: 0, max: 1, step: 0.01, label: 'quiet grid outside' },
  boost: { type: 'number', value: 1.2, min: 0, max: 3, step: 0.01, label: 'quiet dots swell in letters' },
  loose: { type: 'number', value: 10, min: 0, max: 80, step: 0.5, label: 'loose edge (px)' },
  sweep: {
    type: 'select', value: 'all', label: 'words form',
    options: { 'everywhere at once': 'all', 'left → right': 'right', 'right → left': 'left', 'top → down': 'down', 'bottom → up': 'up', 'from the centre': 'out' },
  },
  sweepWidth: { type: 'number', value: 0.5, min: 0, max: 0.9, step: 0.01, label: 'sweep softness (0 = a sharp line)', showIf: { key: 'sweep', is: ['right', 'left', 'down', 'up', 'out'] } },

  drive: { type: 'select', value: 'bars', label: 'timed by', options: { 'the music (bars)': 'bars', 'the clock (seconds)': 'time', 'hand (drag a slider)': 'manual' } },
  speed: { type: 'number', value: 1, min: 0.25, max: 4, step: 0.05, label: 'overall speed (×, 2 = twice as fast)', showIf: { key: 'drive', is: ['bars', 'time'] } },
  rest: { type: 'number', value: 1, min: 0, max: 16, step: 0.25, label: 'wait before building (bars)', showIf: { key: 'drive', is: 'bars' } },
  grow: { type: 'number', value: 8, min: 0.25, max: 64, step: 0.25, label: 'building takes (bars)', showIf: { key: 'drive', is: 'bars' } },
  hold: { type: 'number', value: 4, min: 0, max: 32, step: 0.25, label: 'stay as words for (bars)', showIf: { key: 'drive', is: 'bars' } },
  shrink: { type: 'number', value: 4, min: 0.25, max: 64, step: 0.25, label: 'unbuilding takes (bars)', showIf: { key: 'drive', is: 'bars' } },
  restS: { type: 'number', value: 2, min: 0, max: 30, step: 0.1, label: 'wait before building (s)', showIf: { key: 'drive', is: 'time' } },
  growS: { type: 'number', value: 16, min: 0.5, max: 120, step: 0.1, label: 'building takes (s)', showIf: { key: 'drive', is: 'time' } },
  holdS: { type: 'number', value: 8, min: 0, max: 60, step: 0.1, label: 'stay as words for (s)', showIf: { key: 'drive', is: 'time' } },
  shrinkS: { type: 'number', value: 8, min: 0.5, max: 120, step: 0.1, label: 'unbuilding takes (s)', showIf: { key: 'drive', is: 'time' } },
  after: { type: 'select', value: 'loop', label: 'when built', options: { 'unbuild, then build again': 'loop', 'stay as words': 'stay' }, showIf: { key: 'drive', is: ['bars', 'time'] } },
  progress: { type: 'number', value: 1, min: 0, max: 1, step: 0.001, label: 'built (0 = start, 1 = words)', showIf: { key: 'drive', is: 'manual' } },
  late: { type: 'number', value: 0.35, min: 0, max: 0.9, step: 0.01, label: 'words start forming (0 = at once, 0.9 = at the end)' },
  ease: { type: 'number', value: 0.6, min: 0, max: 4, step: 0.05, label: 'smoothness (s, 0 = instant)' },
}

const groups = {
  Timing: ['drive', 'speed', 'rest', 'grow', 'hold', 'shrink', 'restS', 'growS', 'holdS', 'shrinkS', 'after', 'progress', 'late', 'ease'],
  Pattern: ['look', 'spanFrom', 'spanTo', 'fill', 'orient'],
  Text: ['textScale', 'textAngle', 'textX', 'textY'],
  Gather: ['gatherBy', 'focus', 'tint', 'patScale', 'patX', 'patY', 'outside', 'grid', 'boost', 'loose', 'sweep', 'sweepWidth'],
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v))
const smooth01 = (v: number) => { const t = clamp01(v); return t * t * (3 - 2 * t) }
const DEG = Math.PI / 180
/** A fixed 0..1 per place (marks keep their fate from frame to frame). */
const hash = (x: number, y: number, s: number) => {
  const h = Math.sin(Math.round(x) * 12.9898 + Math.round(y) * 78.233 + s * 37.719) * 43758.5453
  return h - Math.floor(h)
}
const PITCH = 4
/** Dots the Sequencer's dot matrix can draw (its own budget, less a margin). */
const DOT_BUDGET = 3800

/** Which of a layer's per-mark arrays (4 floats each) hold its size, its alpha, and what must not blend (snapped). */
interface Fields {
  arrays: (layer: any) => Float32Array[]
  size: [number, number][]
  alpha: [number, number]
  snap: [number, number][]
}
const BAR_FIELDS: Fields = {
  arrays: (l: BarLayer) => [l.pos, l.grad, l.style, l.line, l.lineC],
  size: [[0, 2], [0, 3], [2, 3]],
  alpha: [1, 2],
  snap: [[2, 2], [3, 0]],
}
const BLOB_FIELDS: Fields = {
  arrays: (l: BlobLayer) => [l.pos, l.style, l.color, l.color2, l.form],
  size: [[0, 2], [0, 3]],
  alpha: [2, 3],
  snap: [[4, 0], [4, 1]],
}
const GLYPH_FIELDS: Fields = {
  arrays: (l: GlyphLayer) => [l.pos, l.uv, l.size, l.color, l.fx],
  size: [[0, 3]],
  alpha: [3, 3],
  // Its atlas cell, quad size and SDF scale belong to the character, and its colour may carry data (Stretch's
  // lanes): never blended.
  snap: [[0, 2], [1, 0], [1, 1], [1, 2], [1, 3], [2, 0], [2, 1], [3, 0], [3, 1], [3, 2]],
}

/**
 * Eases a layer's marks between frames: each mark (found again by its place)
 * glides to what the picture asks of it now; a new one grows in from nothing,
 * one that's gone shrinks and fades out. So a regenerated picture (the window
 * a bar wider) or a mark kept / dropped by the gather never cuts.
 */
class Ease {
  private state = new Map<number, Float32Array>()
  private seen = new Set<number>()
  constructor(private f: Fields) {}

  step(layer: BarLayer | BlobLayer | GlyphLayer, dt: number, tau: number) {
    const arrs = this.f.arrays(layer)
    const n = layer.count
    const A = arrs.length
    if (tau <= 0.001) { this.state.clear(); return }
    const k = 1 - Math.exp(-dt / tau)
    const pos = arrs[0]
    this.seen.clear()
    const target = new Map<number, number>()
    for (let i = 0; i < n; i++) {
      // Its place on a half-px grid, and how many marks already sit there this frame (a dot over a dot).
      const base = ((Math.round(pos[i * 4] * 2) + 16384) * 32768 + (Math.round(pos[i * 4 + 1] * 2) + 16384)) * 4
      let key = base
      while (target.has(key) && key < base + 3) key++
      target.set(key, i)
    }
    const tmp = new Float32Array(A * 4)
    const read = (i: number, out: Float32Array) => { for (let a = 0; a < A; a++) for (let c = 0; c < 4; c++) out[a * 4 + c] = arrs[a][i * 4 + c] }
    for (const [key, i] of target) {
      read(i, tmp)
      let s = this.state.get(key)
      if (!s) {
        // New: from nothing.
        s = tmp.slice()
        for (const [a, c] of this.f.size) s[a * 4 + c] = 0
        s[this.f.alpha[0] * 4 + this.f.alpha[1]] = 0
        this.state.set(key, s)
      }
      for (let j = 0; j < A * 4; j++) s[j] += (tmp[j] - s[j]) * k
      for (const [a, c] of this.f.snap) s[a * 4 + c] = tmp[a * 4 + c]
    }
    // Gone: shrink and fade, then let go.
    for (const [key, s] of this.state) {
      if (target.has(key)) continue
      for (const [a, c] of this.f.size) s[a * 4 + c] *= 1 - k * 0.6
      const ai = this.f.alpha[0] * 4 + this.f.alpha[1]
      s[ai] *= 1 - k
      if (s[ai] < 0.004) this.state.delete(key)
    }
    // Write them back: fading ones underneath (as many as fit beside the live ones), then the live ones.
    let i = 0
    const write = (st: Float32Array) => {
      for (let a = 0; a < A; a++) for (let c = 0; c < 4; c++) arrs[a][i * 4 + c] = st[a * 4 + c]
      i++
    }
    let room = layer.capacity - Math.min(layer.capacity, target.size)
    for (const [key, st] of this.state) {
      if (target.has(key)) continue
      if (room-- > 0) write(st)
      else this.state.delete(key)
    }
    for (const key of target.keys()) if (i < layer.capacity) write(this.state.get(key)!)
    layer.count = i
  }
}

function create(): ModeInstance {
  const inner = sequencer.create()
  let look = ''
  let lookBase: Record<string, any> = {}
  // The text as distance (px) from its ink, on a PITCH grid over the frame.
  let key = ''
  let dist = new Float32Array(1)
  let cols = 1, rows = 1
  let steps = 0
  let secs = 0
  let lastTiming = ''
  let lastPos = NaN
  let still = 0
  const barEase = [0, 1, 2].map(() => new Ease(BAR_FIELDS))
  const blobEase = [0, 1].map(() => new Ease(BLOB_FIELDS))
  const glyphEase = [0, 1].map(() => new Ease(GLYPH_FIELDS))
  /** The letters as placed (scaled / turned / moved), and their centre. */
  let moved: Placement[] = []
  let textCentre: [number, number] = [0, 0]

  const distAt = (x: number, y: number) => {
    const c = Math.floor(cols / 2 + x / PITCH), r = Math.floor(rows / 2 - y / PITCH)
    return c < 0 || r < 0 || c >= cols || r >= rows ? 1e9 : dist[r * cols + c]
  }

  return {
    update(frame: FrameContext) {
      const { layers, viewport, params: p, text, base, audio, dt } = frame
      const W = viewport.width, H = viewport.height

      // ---- The cycle: wait -> build -> stay -> unbuild, 0..1 of the build. Its own clocks, run at
      // `speed` (so a change of speed never jumps), restarting when how it's timed changes.
      const timing = `${p.drive}:${p.after}`
      if (timing !== lastTiming) { lastTiming = timing; steps = 0; secs = 0 }
      const speed = Math.max(0.05, p.speed)
      const pos = audio.beat.position
      if (pos !== lastPos && Number.isFinite(lastPos)) { steps += (pos - lastPos) * speed; still = 0 } else {
        // Nothing playing: the music's clock free-runs at 120 bpm.
        still += dt
        if (still > 0.25) steps += dt * 8 * speed
      }
      lastPos = pos
      secs += dt * speed
      let b = clamp01(p.progress)
      if (p.drive !== 'manual') {
        const bars = p.drive === 'bars'
        const lens = bars
          ? [Math.max(0, p.rest), Math.max(0.25, p.grow), Math.max(0, p.hold), Math.max(0.25, p.shrink)]
          : [Math.max(0, p.restS), Math.max(0.5, p.growS), Math.max(0, p.holdS), Math.max(0.5, p.shrinkS)]
        const t = bars ? steps / 16 : secs
        const total = lens.reduce((s, v) => s + v, 0)
        let u = p.after === 'stay' ? Math.min(t, lens[0] + lens[1]) : ((t % total) + total) % total
        if (u < lens[0]) b = 0
        else if ((u -= lens[0]) < lens[1]) b = u / lens[1]
        else if ((u -= lens[1]) < lens[2] || p.after === 'stay') b = 1
        else b = 1 - (u - lens[2]) / lens[3]
      }

      // ---- The picture: the Sequencer, its window widening with the build.
      if (p.look !== look) {
        look = p.look
        lookBase = p.look === 'tab' ? {} : lookParams(p.look)
      }
      const seq = { ...(p.look === 'tab' ? frame.modeParams.sequencer ?? {} : lookBase) }
      const sub = seq.style as string
      const spanKey = `${sub}_span`
      // (Stretch re-bakes its whole picture when its window changes: it keeps the full window.)
      if (sub === 'stretch') seq[spanKey] = Math.max(1, Math.round(p.spanTo))
      else if (spanKey in seq) {
        const span = Math.round(p.spanFrom + (p.spanTo - p.spanFrom) * smooth01(b))
        seq[spanKey] = Math.max(1, span)
      }
      // On its side: drawn for the frame turned, then turned back (time runs left -> right).
      // (Stretch can only be drawn upright: it is turned under the letters instead, see cutTo.)
      const sideways = p.orient === 'across'
      const across = sideways && sub !== 'stretch'
      const PW = across ? H : W, PH = across ? W : H
      if (p.fill && sub === 'dots' && seq.dots_style !== 'fields') {
        // As many lanes as fill the frame's width at square spacing, rows trimmed to stay in the dot budget.
        const m = seq.dots_margin * Math.min(PW, PH)
        const aw = PW - 2 * m, ah = PH - 2 * m
        const gap = seq.dots_gap
        const r = Math.max(8, Math.min(Math.round(seq.dots_rows), Math.floor(Math.sqrt((DOT_BUDGET * ah) / aw))))
        // Fewer systems where they'd leave too few lanes each to draw letters in (a frame on its side).
        const S = Math.max(1, Math.min(Math.round(seq.dots_systems), Math.round((aw * r) / ah / 24)))
        seq.dots_systems = S
        seq.dots_rows = r
        seq.dots_lanes = Math.max(4, Math.floor(((aw * r) / ah - (S - 1) * gap) / S))
      }
      inner.update({ ...frame, viewport: { ...viewport, width: PW, height: PH }, params: seq })
      if (across) {
        for (const layer of [layers.bars, layers.barsMid.bars, layers.barsFar.bars, layers.back, layers.front, layers.field.injectBars]) {
          const q = layer.pos
          for (let i = 0; i < layer.count; i++) {
            const o = i * 4
            const x = q[o], y = q[o + 1], w = q[o + 2]
            q[o] = -y; q[o + 1] = -x; q[o + 2] = q[o + 3]; q[o + 3] = w
          }
        }
        // Characters move with the picture but stay upright.
        for (const layer of [layers.glyphs, layers.outlines]) {
          const q = layer.pos
          for (let i = 0; i < layer.count; i++) { const x = q[i * 4]; q[i * 4] = -q[i * 4 + 1]; q[i * 4 + 1] = -x }
        }
      }

      // ---- The text, placed by the layout, then scaled / turned / moved as one: a distance field.
      const ta = p.textAngle * DEG, ts = p.textScale
      const placed = base.reduce((s, q) => s + q.x * 1.3 + q.y * 0.7 + q.rotation + q.scale, 0)
      let cx = 0, cy = 0, n = 0
      for (const g of text.glyphs) { const q = base[g.index]; if (q) { cx += q.x; cy += q.y; n++ } }
      if (n) { cx /= n; cy /= n }
      const c = Math.cos(ta), s = Math.sin(ta)
      const ox = p.textX * W / 2, oy = p.textY * H / 2
      moved = base.map((q) => {
        const dx = (q.x - cx) * ts, dy = (q.y - cy) * ts
        return { x: cx + ox + dx * c - dy * s, y: cy + oy + dx * s + dy * c, rotation: q.rotation + ta, scale: q.scale * ts }
      })
      textCentre = [cx + ox, cy + oy]
      const k = `${frame.fontId}:${text.fontSize}:${text.glyphs.map((g) => g.char).join('')}:${placed.toFixed(2)}:${W}x${H}:${ts}:${ta}:${p.textX}:${p.textY}`
      if (k !== key) {
        key = k
        cols = Math.ceil(W / PITCH)
        rows = Math.ceil(H / PITCH)
        const cover = rasterise({ ...frame, base: moved }, 1, cols, rows, PITCH, 2)
        // Chamfer distance to the ink, px.
        dist = new Float32Array(cols * rows)
        for (let i = 0; i < dist.length; i++) dist[i] = cover[i] > 0.5 ? 0 : 1e9
        const D = PITCH, E = PITCH * Math.SQRT2
        for (let r = 0; r < rows; r++)
          for (let c2 = 0; c2 < cols; c2++) {
            const i = r * cols + c2
            let v = dist[i]
            if (c2 > 0) v = Math.min(v, dist[i - 1] + D)
            if (r > 0) {
              v = Math.min(v, dist[i - cols] + D)
              if (c2 > 0) v = Math.min(v, dist[i - cols - 1] + E)
              if (c2 < cols - 1) v = Math.min(v, dist[i - cols + 1] + E)
            }
            dist[i] = v
          }
        for (let r = rows - 1; r >= 0; r--)
          for (let c2 = cols - 1; c2 >= 0; c2--) {
            const i = r * cols + c2
            let v = dist[i]
            if (c2 < cols - 1) v = Math.min(v, dist[i + 1] + D)
            if (r < rows - 1) {
              v = Math.min(v, dist[i + cols] + D)
              if (c2 < cols - 1) v = Math.min(v, dist[i + cols + 1] + E)
              if (c2 > 0) v = Math.min(v, dist[i + cols - 1] + E)
            }
            dist[i] = v
          }
      }
      // Whole dots gather; anything else (long bars, characters, Stretch's trails, Pulse's field) is cut to the letters.
      const cut = p.gatherBy === 'cut' || (p.gatherBy === 'auto' && sub !== 'dots')
      if (text.glyphs.length) {
        if (cut) cutTo(frame, b, sub === 'stretch' && sideways)
        else gather(frame, b)
      }
      // ---- Every mark eases between states: matched by place, new ones grow in, gone ones fade out.
      for (const [i, layer] of [layers.bars, layers.barsMid.bars, layers.barsFar.bars].entries()) barEase[i].step(layer, dt, p.ease)
      for (const [i, layer] of [layers.back, layers.front].entries()) blobEase[i].step(layer, dt, p.ease)
      for (const [i, layer] of [layers.glyphs, layers.outlines].entries()) glyphEase[i].step(layer, dt, p.ease)
    },
  }

  /**
   * The picture cut to the letters, per pixel (the Stencil effect): as the build goes on, everything outside
   * them fades to `outside`, everywhere at once or swept across, and the letters take `tint` of the ink. `turn` shows Stretch on its side (it can only
   * be drawn upright): the picture is turned under the letters instead.
   */
  function cutTo({ layers, viewport, params: p, text, ink }: FrameContext, b: number, turn: boolean) {
    const W = viewport.width, H = viewport.height
    const fx = layers.stencil
    for (const g of text.glyphs) {
      const q = moved[g.index]
      if (q) writeGlyph(fx.glyphs, g, q, { r: 1, g: 1, b: 1, a: 1, bleed: p.loose * 0.4, blur: 1.5 })
    }
    fx.glyphs.count = text.glyphs.length
    fx.enabled = true
    const span = Math.max(0.05, 1 - p.late)
    fx.front1.value = clamp01(p.focus) * smooth01((b - p.late) / span)
    // The letters take a faint ink as they form, so they read even where the picture is sparse.
    fx.front2.value = fx.front1.value
    fx.front3.value = 0
    // Everywhere at once: a front so soft it covers the frame evenly.
    fx.soft.value = p.sweep === 'all' ? 10 : Math.max(0.02, 0.5 * p.sweepWidth)
    fx.radial.value = p.sweep === 'out' ? 1 : 0
    fx.angle.value = ({ right: 0, left: 180, down: -90, up: 90 } as Record<string, number>)[p.sweep] * DEG || 0
    fx.centre.value.set(p.sweep === 'out' ? textCentre[0] : 0, p.sweep === 'out' ? textCentre[1] : 0)
    fx.laneH.value = 0
    fx.stagger.value = 0
    fx.edge.value = 0
    fx.ghost.value = p.outside
    fx.ghostText.value = p.outside
    fx.fill.value = p.tint
    fx.patAngle.value = turn ? 90 * DEG : 0
    fx.patScale.value = p.patScale * (turn ? W / H : 1)
    fx.patOffset.value.set(p.patX * W / 2, p.patY * H / 2)
    fx.ink.value.setRGB(ink[0], ink[1], ink[2])
  }

  /** Keep, drop, swell or dim each mark by where it sits against the text, `b` (0..1) into the build. */
  function gather({ layers, viewport, params: p }: FrameContext, b: number) {
      const W = viewport.width, H = viewport.height
      // How far the marks have gathered into the text (a little behind the growth), swept across the frame.
      const span = Math.max(0.05, 1 - p.late)
      const sw = p.sweep === 'all' ? 0 : clamp01(p.sweepWidth)
      const R = Math.hypot(W, H) / 2
      const along = (x: number, y: number) => {
        switch (p.sweep) {
          case 'right': return x / W + 0.5
          case 'left': return 0.5 - x / W
          case 'down': return 0.5 - y / H
          case 'up': return y / H + 0.5
          case 'out': return Math.hypot(x, y) / R
          default: return 0
        }
      }
      const Fat = (x: number, y: number) => clamp01(p.focus) * smooth01((b - p.late - sw * span * clamp01(along(x, y))) / (span * (1 - sw)))
      if (Fat(0, 0) <= 0.001 && sw === 0) return
      /** 0..1: how much a place belongs to the letters (ragged by `loose`). */
      const inside = (x: number, y: number) => clamp01(1 - (distAt(x, y) - p.loose * hash(x, y, 3)) / (PITCH * 1.5))

      const gatherBars = (layer: BarLayer) => {
        const { pos, grad, style } = layer
        let rmax = 0
        for (let i = 0; i < layer.count; i++) rmax = Math.max(rmax, Math.min(pos[i * 4 + 2], pos[i * 4 + 3]))
        for (let i = 0; i < layer.count; i++) {
          const o = i * 4
          const x = pos[o], y = pos[o + 1], w = pos[o + 2], h = pos[o + 3]
          // Page furniture (rules across the page) stays.
          if (w > W * 0.5 || h > H * 0.5) continue
          const inn = inside(x, y)
          const F = Fat(x, y)
          if (F <= 0.001) continue
          const strong = Math.min(w, h) > 0.55 * rmax
          if (strong) {
            // Outside the letters, strong marks thin out (a fixed few stay).
            const keep = 1 - F * (1 - inn) * (1 - p.outside)
            if (hash(x, y, 1) >= keep) grad[o + 2] = 0
          } else {
            // Quiet dots: swell inside the letters, fade outside by `grid`.
            const grow = 1 + p.boost * 1.5 * F * inn
            pos[o + 2] *= grow
            pos[o + 3] *= grow
            style[o + 3] *= grow
            grad[o + 2] = Math.min(1, grad[o + 2] * (1 + 1.5 * F * inn)) * (1 - F * (1 - inn) * (1 - p.grid))
          }
        }
      }
      const gatherBlobs = (layer: BlobLayer) => {
        for (let i = 0; i < layer.count; i++) {
          const o = i * 4
          const F = Fat(layer.pos[o], layer.pos[o + 1])
          const keep = 1 - F * (1 - inside(layer.pos[o], layer.pos[o + 1])) * (1 - p.outside)
          if (hash(layer.pos[o], layer.pos[o + 1], 2) >= keep) layer.color[o + 3] = 0
        }
      }
      for (const layer of [layers.bars, layers.barsMid.bars, layers.barsFar.bars]) gatherBars(layer)
      for (const layer of [layers.back, layers.front]) gatherBlobs(layer)
  }
}

const PAPER = { background: '#f4f5f7', ink: '#121317' }

const presets: Record<string, ModePreset> = {
  // The whole song's dot matrix filling in, the busy marks gathering into the words.
  Default: { params: {}, ...PAPER },
  // Slower: sixteen bars to build, the words held long.
  'Slow build': { params: { grow: 16, hold: 8, shrink: 8, late: 0.5 }, ...PAPER },
  // Builds once over sixteen bars, then stays as the words.
  'Build once, stay': { params: { grow: 16, after: 'stay', late: 0.4, ease: 1 }, ...PAPER },
  // Tight letters: nothing strong left outside, no loose edge, the quiet grid faint.
  Tight: { params: { outside: 0, loose: 2, grid: 0.2, boost: 1.6 }, ...PAPER },
  // Loose: a ragged, airy cluster that only suggests the words.
  Loose: { params: { outside: 0.2, loose: 28, boost: 0.4, late: 0.2 }, ...PAPER },
  // The words alone: the grid outside clears away as they form.
  'Grid clears': { params: { grid: 0, outside: 0.02, boost: 1 }, ...PAPER },
  // Dots in each part's colour.
  'Dots · stems': { params: { look: 'dots|Stems' }, ...PAPER },
  // Dots as soft fields of colour, gathering into the words.
  'Dots · fields': { params: { look: 'dots|Fields · whole song', outside: 0.1, loose: 16 }, background: '#ffffff', ink: '#121317' },
  // Barcode's columns filling in, kept only in the words.
  Barcode: { params: { look: 'barcode|Whole song', spanFrom: 1, boost: 0, loose: 4, outside: 0.04 }, ...PAPER },
  // The sequencer on its side (time runs left -> right); the words gather from the left.
  Sideways: { params: { orient: 'across', sweep: 'right', sweepWidth: 0.5 }, ...PAPER },
  // Upright, the words gathering from the left as the build goes on.
  'Sweep left → right': { params: { sweep: 'right', sweepWidth: 0.6, late: 0.25 }, ...PAPER },
  // On its side, slow, the words gathering out from the centre.
  'Sideways · from the centre': { params: { orient: 'across', sweep: 'out', sweepWidth: 0.6, grow: 16, hold: 8, shrink: 8, ease: 1 }, ...PAPER },
  // Larger text, on a slant.
  'Big · slanted': { params: { textScale: 1.6, textAngle: -12, loose: 14 }, ...PAPER },
}

export const typeBuild: ModeDefinition = {
  id: 'typeBuild',
  label: 'Type Build',
  params,
  groups,
  presets,
  create,
}
