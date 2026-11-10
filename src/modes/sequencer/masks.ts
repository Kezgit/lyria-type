import type { AudioFeatures, Stem } from '../../audio/features'
import type { BarLayer } from '../../engine/barLayer'
import type { BlobLayer } from '../../engine/blobLayer'
import type { FrameContext } from '../types'

// Masks: invisible shapes that push the Sequencer's marks aside, like a solid
// body moving through them. Every mark drawn this frame (the dots and pills,
// their haze, streaks and blobs, placed marks, in any sub-mode) is moved out
// of each mask, onto a ring `margin` from its edge, easing back to where it
// was over `soft`: the nearer it would be, the harder it's pushed, so they
// pile up against the shape and spread smoothly away from it. Nothing is
// drawn for the mask itself.
//
//   invert     a window instead: marks show only inside it (fading out over
//              the soft edge), those near its edge pushed in from the margin
//   stroke     the shape as a band this thick (rings), not filled
//   repeater   copies of the outline grown by `spacing` each (shrunk, when
//              it's negative): with a stroke, rings within rings, the marks
//              flowing in the space between
//
// To feel alive rather than geometric, each mask:
//   follows    springs toward where it's placed (and its size, stretch, turn),
//              overshooting a little: moved or scaled, it wobbles into place
//   wobbles    its edge breathes with slow noise
//   pulses     swells with the music (all of it, or one part)
//   squashes   marks against it shrink a little, as if pressed
//
// Keyframes: a mask can hold keys on the masks' timeline (`timeline`), each
// its place, size, turn, push and rings at a moment; between keys the values
// ease (or run straight, or hold), and the mask springs after them as it
// does after a drag.
//
// Anchor point: where a mask is placed (x, y) is its anchor; the shape sits
// round it (ax, ay: -1..1 across its width and height from its centre, down
// and right as seen; 0, 0 = the centre). It scales and turns about the anchor,
// so a circle anchored at its centre grows from there.
//
// Masks are kept as text in the Sequencer's `masks` setting (saved with
// presets and scenes), the timeline's length and play in `maskTimeline`.
// Positions and sizes are in frame heights from the frame's centre (y up);
// rotation in degrees, clockwise as seen.

export type MaskShape = 'circle' | 'square' | 'rounded'

/** What keyframes animate. */
export const ANIMATED = ['x', 'y', 'w', 'h', 'r', 'ax', 'ay', 'strength', 'margin', 'soft', 'stroke', 'spacing', 'round'] as const
export type Animated = (typeof ANIMATED)[number]
export type Ease = 'ease' | 'linear' | 'hold'

export interface Key {
  /** Seconds into the timeline. */
  t: number
  /** How it moves on to the next key. */
  ease: Ease
  v: Record<Animated, number>
}

export interface Mask {
  id: string
  name: string
  on: boolean
  shape: MaskShape
  x: number
  y: number
  /** Full width and height. */
  w: number
  h: number
  /** Degrees, clockwise on screen. */
  r: number
  /** The anchor within the shape (where x, y is): -1..1 of its half width / height, right and down. */
  ax: number
  ay: number
  /** Width and height scale together (the panel's sliders). */
  lock: boolean
  /** Corner roundness (rounded), 0..1 of the short side's half. */
  round: number
  /** Marks show inside it instead of being pushed out. */
  invert: boolean
  /** Band thickness, frame heights (0 = filled). */
  stroke: number
  /** Copies of the outline (1 = just itself), each `spacing` further out (in, when negative). */
  repeat: number
  spacing: number
  /** Space kept between the shape and the marks, frame heights. */
  margin: number
  /** How far past the margin the push fades out, frame heights (0 = a hard edge). */
  soft: number
  /** How much it pushes, 0..1 (0 = off; 1 = nothing gets inside the margin). */
  strength: number
  /** How much marks against it shrink, 0..1. */
  squash: number
  /** Its edge breathing with noise, 0..1. */
  wobble: number
  /** How loosely it follows where it's put: 0 = at once, 1 = slow and jelly-like. */
  follow: number
  /** How much it swells with the music, 0..1, and with which part. */
  pulse: number
  stem: 'all' | Stem
  keys: Key[]
}

export const SHAPES: { id: MaskShape; label: string }[] = [
  { id: 'circle', label: 'Circle' },
  { id: 'square', label: 'Square' },
  { id: 'rounded', label: 'Rounded' },
]

export function newMask(shape: MaskShape, n: number): Mask {
  return {
    id: Math.random().toString(36).slice(2, 9), name: `${SHAPES.find((s) => s.id === shape)!.label} ${n}`, on: true, shape,
    x: 0, y: 0, w: 0.3, h: 0.3, r: 0, ax: 0, ay: 0, lock: true, round: 0.5, invert: false, stroke: 0, repeat: 1, spacing: 0.08,
    margin: 0.02, soft: 0.08, strength: 1, squash: 0.3, wobble: 0.2, follow: 0.5, pulse: 0.15, stem: 'all', keys: [],
  }
}

/** The shape's centre (frame heights, y up), from its anchor (x, y), size, turn and the anchor's place in it. */
export function centreOf(v: { x: number; y: number; w: number; h: number; r: number; ax: number; ay: number }) {
  // The anchor's offset from the centre (right / down as seen), turned with the shape, in y-up units.
  const ox = (v.ax * v.w) / 2, oy = (-v.ay * v.h) / 2
  const t = (-v.r * Math.PI) / 180
  return { x: v.x - (ox * Math.cos(t) - oy * Math.sin(t)), y: v.y - (ox * Math.sin(t) + oy * Math.cos(t)) }
}

/** A mask's animated values now (its own, when it has no keys). */
export function valuesOf(m: Mask): Record<Animated, number> {
  return Object.fromEntries(ANIMATED.map((k) => [k, m[k]])) as Record<Animated, number>
}

const ease = (u: number, e: Ease) => (e === 'hold' ? 0 : e === 'linear' ? u : u < 0.5 ? 4 * u * u * u : 1 - (-2 * u + 2) ** 3 / 2)

/** The mask at time `t` on the timeline: its keys' values between them (none: as it is). */
export function maskAt(m: Mask, t: number): Mask {
  if (!m.keys.length) return m
  const keys = m.keys
  let v: Record<Animated, number>
  if (t <= keys[0].t) v = keys[0].v
  else if (t >= keys[keys.length - 1].t) v = keys[keys.length - 1].v
  else {
    let i = 0
    while (keys[i + 1].t < t) i++
    const a = keys[i], b = keys[i + 1]
    const u = ease((t - a.t) / Math.max(1e-6, b.t - a.t), a.ease)
    v = Object.fromEntries(ANIMATED.map((k) => [k, a.v[k] + (b.v[k] - a.v[k]) * u])) as Record<Animated, number>
  }
  return { ...m, ...v }
}

/** Set animated values at time `t`: on the mask itself, or (keyed) as a key there, made if there isn't one. */
export function setAt(m: Mask, t: number, values: Partial<Record<Animated, number>>) {
  if (!m.keys.length) {
    Object.assign(m, values)
    return
  }
  // (Within half a frame: the same key.)
  let key = m.keys.find((k) => Math.abs(k.t - t) < 1 / 60)
  if (!key) {
    key = { t, ease: 'ease', v: valuesOf(maskAt(m, t)) }
    m.keys.push(key)
    m.keys.sort((a, b) => a.t - b.t)
  }
  Object.assign(key.v, values)
}

// --- Text ---------------------------------------------------------------------------------------

let lastText = ''
let lastMasks: Mask[] = []
/** From the setting's text (cached by text). Anything malformed is dropped; missing fields take the defaults. */
export function decodeMasks(text: unknown): Mask[] {
  if (typeof text !== 'string' || !text) return []
  if (text === lastText) return lastMasks
  let out: Mask[] = []
  try {
    const raw = JSON.parse(text)
    if (Array.isArray(raw)) {
      out = raw.filter((m) => m && typeof m === 'object').map((m, i) => {
        const base = newMask(SHAPES.some((s) => s.id === m.shape) ? m.shape : 'circle', i + 1)
        const merged = { ...base }
        for (const k of Object.keys(base) as (keyof Mask)[]) if (k !== 'keys' && typeof m[k] === typeof base[k]) (merged as any)[k] = m[k]
        const own = valuesOf(merged)
        merged.keys = (Array.isArray(m.keys) ? m.keys : [])
          .filter((k: any) => k && typeof k.t === 'number' && k.v && typeof k.v === 'object')
          .map((k: any) => ({
            t: Math.max(0, k.t), ease: (['ease', 'linear', 'hold'] as Ease[]).includes(k.ease) ? k.ease : 'ease',
            v: Object.fromEntries(ANIMATED.map((a) => [a, typeof k.v[a] === 'number' ? k.v[a] : own[a]])) as Record<Animated, number>,
          }))
          .sort((a: Key, b: Key) => a.t - b.t)
        return merged
      })
    }
  } catch {}
  lastText = text
  lastMasks = out
  return out
}

const round4 = (_: string, v: unknown) => (typeof v === 'number' ? Math.round(v * 10000) / 10000 : v)
export const encodeMasks = (masks: Mask[]) => JSON.stringify(masks, round4)

/** The masks' timeline: its length (s), whether it plays, and where it is. Length and play are saved. */
export const timeline = { t: 0, playing: false, dur: 4 }
let timelineText = ''
export function readTimeline(text: unknown) {
  if (typeof text !== 'string' || text === timelineText) return
  timelineText = text
  try {
    const o = JSON.parse(text)
    if (typeof o.dur === 'number') timeline.dur = Math.min(120, Math.max(0.5, o.dur))
    if (typeof o.play === 'boolean') timeline.playing = o.play
  } catch {}
}
export const encodeTimeline = () => JSON.stringify({ dur: timeline.dur, play: timeline.playing })

// --- Live state: each mask springs toward its settings --------------------------------------

interface Live {
  x: number; y: number; w: number; h: number; r: number
  vx: number; vy: number; vw: number; vh: number; vr: number
  /** The music's swell, smoothed. */
  swell: number
  seen: number
}
const live = new Map<string, Live>()
let frameNo = 0

/** The mask as it is this frame (keyed, sprung, swelling), for drawing its outline too. */
export function liveMask(m: Mask) {
  const now = maskAt(m, timeline.t)
  const l = live.get(m.id)
  if (!l) return now
  const k = 1 + l.swell
  return { ...now, x: l.x, y: l.y, w: l.w * k, h: l.h * k, r: l.r }
}

function step(m: Mask, dt: number, audio: AudioFeatures) {
  let l = live.get(m.id)
  if (!l) live.set(m.id, (l = { x: m.x, y: m.y, w: m.w, h: m.h, r: m.r, vx: 0, vy: 0, vw: 0, vh: 0, vr: 0, swell: 0, seen: 0 }))
  l.seen = frameNo
  // A spring a little under critical damping: it settles with a small overshoot. Looser follows ring longer.
  const f = Math.min(1, Math.max(0, m.follow))
  if (f < 0.02) {
    Object.assign(l, { x: m.x, y: m.y, w: m.w, h: m.h, r: m.r, vx: 0, vy: 0, vw: 0, vh: 0, vr: 0 })
  } else {
    const omega = 4 + (1 - f) * 26
    const zeta = 0.45 + 0.35 * (1 - f)
    const h = Math.min(dt, 1 / 30)
    const spring = (pos: number, vel: number, target: number): [number, number] => {
      const a = -omega * omega * (pos - target) - 2 * zeta * omega * vel
      vel += a * h
      return [pos + vel * h, vel]
    }
    // Turn the short way round.
    const target = l.r + ((((m.r - l.r) % 360) + 540) % 360) - 180
    ;[l.x, l.vx] = spring(l.x, l.vx, m.x)
    ;[l.y, l.vy] = spring(l.y, l.vy, m.y)
    ;[l.w, l.vw] = spring(l.w, l.vw, m.w)
    ;[l.h, l.vh] = spring(l.h, l.vh, m.h)
    ;[l.r, l.vr] = spring(l.r, l.vr, target)
  }
  const level = m.stem === 'all' ? audio.level : (audio.stems[m.stem]?.level ?? 0)
  const want = Math.max(0, m.pulse) * 0.35 * Math.min(1, Math.max(0, level))
  l.swell += (want - l.swell) * (1 - Math.exp(-dt / (want > l.swell ? 0.06 : 0.35)))
  return l
}

// --- The push ---------------------------------------------------------------------------------

const smoothNoise = (a: number, t: number, seed: number) =>
  0.5 * Math.sin(a * 3 + t * 0.7 + seed) + 0.3 * Math.sin(a * 5 - t * 0.43 + seed * 2.1) + 0.2 * Math.sin(a * 2 + t * 1.1 + seed * 3.7)

/** Signed distance (px) from a point to a shape's outline, in its own frame (centre 0, unrotated). */
function shapeSdf(shape: MaskShape, round: number, hw: number, hh: number, x: number, y: number) {
  if (shape === 'circle') {
    // An ellipse: how far past its radius along this direction.
    const k = Math.hypot(x / hw, y / hh)
    if (k < 1e-6) return -Math.min(hw, hh)
    return Math.hypot(x, y) * (1 - 1 / k)
  }
  const rr = shape === 'square' ? 0 : Math.min(hw, hh) * Math.min(1, Math.max(0, round))
  const qx = Math.abs(x) - (hw - rr), qy = Math.abs(y) - (hh - rr)
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - rr
}

interface Field {
  shape: MaskShape; round: number
  cx: number; cy: number; hw: number; hh: number
  cos: number; sin: number
  invert: boolean; stroke: number; repeat: number; spacing: number
  margin: number; soft: number; strength: number; squash: number; wobble: number
  seed: number
}

/** Signed distance to the mask as drawn: the outline, its band (stroke) and its copies (repeater). */
function sdf(f: Field, x: number, y: number) {
  const base = shapeSdf(f.shape, f.round, f.hw, f.hh, x, y)
  if (f.stroke <= 0 && f.repeat <= 1) return base
  let d = Infinity
  for (let i = 0; i < f.repeat; i++) {
    const di = base - i * f.spacing
    d = Math.min(d, f.stroke > 0 ? Math.abs(di) - f.stroke / 2 : di)
  }
  return d
}

/** Where a point goes, how much a mark there squashes (k), and how much of it shows (a: inverted masks). */
function push(fields: Field[], x: number, y: number, time: number, out: { x: number; y: number; k: number; a: number }) {
  out.x = x
  out.y = y
  out.k = 1
  let windows = 0
  let seen = 0
  for (const f of fields) {
    // Into the mask's frame (screen-clockwise rotation, y up).
    const dx = out.x - f.cx, dy = out.y - f.cy
    const lx = dx * f.cos - dy * f.sin, ly = dx * f.sin + dy * f.cos
    const reach = f.margin + f.soft
    const S = Math.max(1e-3, f.soft)
    const size = Math.min(f.hw, f.hh)
    if (f.invert) windows++
    // Far away: untouched (a cheap bound before the exact distance), and outside any window.
    const grow = Math.max(0, (f.repeat - 1) * f.spacing) + f.stroke / 2
    const pad = reach + f.wobble * size * 0.2 + grow + 8
    if (Math.abs(lx) > f.hw + pad || Math.abs(ly) > f.hh + pad) continue
    const edge = f.wobble * size * 0.18 * smoothNoise(Math.atan2(ly, lx), time, f.seed)
    const d = sdf(f, lx, ly) - edge
    // An inverted mask: marks outside fade over the soft edge; inside, they're pushed in from the edge.
    const dd = f.invert ? -d : d
    if (f.invert) seen = Math.max(seen, d <= 0 ? 1 : Math.max(0, 1 - d / S) ** 2)
    if (dd >= reach || (f.invert && d > 0)) continue
    // New distance: onto the margin ring, easing back to the true distance at the reach (smooth, no kink).
    let n = f.margin + S * Math.exp((dd - reach) / S)
    // From inside, the deeper a mark was, the further out it lands: a rim of displaced marks across the
    // soft band rather than all on one line.
    const depth = f.stroke > 0 ? f.stroke / 2 : size
    if (dd < 0 && S > 1) n += (0.85 * S - (n - f.margin)) * Math.min(1, -dd / Math.max(1, depth))
    const move = (n - dd) * f.strength
    if (move <= 0) continue
    // Outward (inward, inverted): the distance's gradient (from the centre when deep inside).
    const e = 1
    let gx = sdf(f, lx + e, ly) - sdf(f, lx - e, ly)
    let gy = sdf(f, lx, ly + e) - sdf(f, lx, ly - e)
    let gl = Math.hypot(gx, gy)
    if (gl < 1e-4) {
      gx = lx || 1
      gy = ly
      gl = Math.hypot(gx, gy)
    }
    const sign = f.invert ? -1 : 1
    gx = (sign * gx) / gl
    gy = (sign * gy) / gl
    // Back to the frame's axes.
    const wx = gx * f.cos + gy * f.sin, wy = -gx * f.sin + gy * f.cos
    out.x += wx * move
    out.y += wy * move
    // Pressed against it: smaller, the harder it's pushed.
    if (f.squash > 0) out.k *= 1 - f.squash * 0.6 * (1 - Math.exp((Math.min(dd, reach) - reach) / S)) * f.strength
  }
  // With windows (inverted masks), a mark shows as much as it's inside any of them.
  out.a = windows ? seen : 1
}

const tmp = { x: 0, y: 0, k: 1, a: 1 }

/** Push everything the Sequencer drew this frame out of its masks (keys at the timeline's time). */
export function applyMasks(frame: FrameContext, text: unknown, timelineSettings?: unknown) {
  readTimeline(timelineSettings)
  const all = decodeMasks(text)
  frameNo++
  if (all.some((m) => m.keys.length) && timeline.playing) timeline.t = (timeline.t + frame.dt) % timeline.dur
  const masks = all.filter((m) => m.on && m.strength > 0).map((m) => maskAt(m, timeline.t))
  if (!masks.length) {
    live.clear()
    return
  }
  const H = frame.viewport.height
  const fields: Field[] = masks.map((m, i) => {
    const l = step(m, frame.dt, frame.audio)
    const k = 1 + l.swell
    const t = (-l.r * Math.PI) / 180
    // (It swells and turns about its anchor too.)
    const c = centreOf({ x: l.x, y: l.y, w: l.w * k, h: l.h * k, r: l.r, ax: m.ax, ay: m.ay })
    return {
      shape: m.shape, round: m.round,
      cx: c.x * H, cy: c.y * H, hw: Math.max(1, (l.w * H * k) / 2), hh: Math.max(1, (l.h * H * k) / 2),
      // Undo the turn (clockwise on screen = counter-clockwise in y-up), into the mask's frame.
      cos: Math.cos(t), sin: -Math.sin(t),
      invert: m.invert, stroke: Math.max(0, m.stroke * H), repeat: Math.max(1, Math.round(m.repeat)), spacing: m.spacing * H,
      margin: Math.max(0, m.margin * H), soft: Math.max(0, m.soft * H), strength: Math.min(1, Math.max(0, m.strength)),
      squash: Math.min(1, Math.max(0, m.squash)), wobble: Math.max(0, m.wobble), seed: i * 1.7 + 0.3,
    }
  })
  for (const id of [...live.keys()]) if (live.get(id)!.seen !== frameNo) live.delete(id)
  const time = frame.time
  const l = frame.layers
  const bars = (layer: BarLayer) => {
    const pos = layer.pos
    for (let i = 0; i < layer.count; i++) {
      const o = i * 4
      // (Page-wide marks, like the ruled grid, stay put.)
      if (pos[o + 2] > frame.viewport.width * 0.5 || pos[o + 3] > H * 0.5) continue
      push(fields, pos[o], pos[o + 1], time, tmp)
      pos[o] = tmp.x
      pos[o + 1] = tmp.y
      if (tmp.k !== 1) {
        pos[o + 2] *= tmp.k
        pos[o + 3] *= tmp.k
        layer.style[o + 3] *= tmp.k
      }
      if (tmp.a !== 1) layer.grad[o + 2] *= tmp.a
    }
  }
  const blobs = (layer: BlobLayer) => {
    const pos = layer.pos
    for (let i = 0; i < layer.count; i++) {
      const o = i * 4
      if (pos[o + 2] > frame.viewport.width * 0.4) continue
      push(fields, pos[o], pos[o + 1], time, tmp)
      pos[o] = tmp.x
      pos[o + 1] = tmp.y
      if (tmp.k !== 1) {
        pos[o + 2] *= tmp.k
        pos[o + 3] *= tmp.k
      }
      if (tmp.a !== 1) layer.color[o + 3] *= tmp.a
    }
  }
  for (const layer of [l.bars, l.barsMid.bars, l.barsFar.bars, ...l.hazeByStem.map((h) => h.bars)]) bars(layer)
  for (const layer of [l.front, l.back]) blobs(layer)
  // Marks with their own blend mode, too.
  l.blend.eachSpec((s) => {
    push(fields, s.x, s.y, time, tmp)
    s.x = tmp.x
    s.y = tmp.y
    if (tmp.k !== 1) {
      if ('w' in s) {
        s.w *= tmp.k
        s.h *= tmp.k
        if (s.radius) s.radius *= tmp.k
      } else {
        s.rx *= tmp.k
        s.ry *= tmp.k
      }
    }
    if (tmp.a !== 1) s.alpha = (s.alpha ?? 1) * tmp.a
  })
}
