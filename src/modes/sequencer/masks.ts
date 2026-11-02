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
// To feel alive rather than geometric, each mask:
//   follows    springs toward where it's placed (and its size, stretch, turn),
//              overshooting a little: moved or scaled, it wobbles into place
//   wobbles    its edge breathes with slow noise
//   pulses     swells with the music (all of it, or one part)
//   squashes   marks against it shrink a little, as if pressed
//
// Masks are kept as text in the Sequencer's `masks` setting (saved with
// presets and scenes). Positions and sizes are in frame heights from the
// frame's centre (y up); rotation in degrees, clockwise as seen.

export type MaskShape = 'circle' | 'square' | 'rounded'

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
  /** Corner roundness (rounded), 0..1 of the short side's half. */
  round: number
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
}

export const SHAPES: { id: MaskShape; label: string }[] = [
  { id: 'circle', label: 'Circle' },
  { id: 'square', label: 'Square' },
  { id: 'rounded', label: 'Rounded' },
]

export function newMask(shape: MaskShape, n: number): Mask {
  return {
    id: Math.random().toString(36).slice(2, 9), name: `${SHAPES.find((s) => s.id === shape)!.label} ${n}`, on: true, shape,
    x: 0, y: 0, w: 0.3, h: 0.3, r: 0, round: 0.5, margin: 0.02, soft: 0.08, strength: 1, squash: 0.3, wobble: 0.2, follow: 0.5, pulse: 0.15, stem: 'all',
  }
}

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
        for (const k of Object.keys(base) as (keyof Mask)[]) if (typeof m[k] === typeof base[k]) (merged as any)[k] = m[k]
        return merged
      })
    }
  } catch {}
  lastText = text
  lastMasks = out
  return out
}

export const encodeMasks = (masks: Mask[]) =>
  JSON.stringify(masks.map((m) => Object.fromEntries(Object.entries(m).map(([k, v]) => [k, typeof v === 'number' ? Math.round(v * 10000) / 10000 : v]))))

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

/** The mask as it is this frame (sprung, swelling), for drawing its outline too. */
export function liveMask(m: Mask) {
  const l = live.get(m.id)
  if (!l) return { x: m.x, y: m.y, w: m.w, h: m.h, r: m.r }
  const k = 1 + l.swell
  return { x: l.x, y: l.y, w: l.w * k, h: l.h * k, r: l.r }
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

/** Signed distance (px) from a point to a mask's shape, in its own frame (centre 0, unrotated). */
function sdf(shape: MaskShape, round: number, hw: number, hh: number, x: number, y: number) {
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
  m: Mask
  cx: number; cy: number; hw: number; hh: number
  cos: number; sin: number
  margin: number; soft: number; strength: number; squash: number; wobble: number
  seed: number
}

/** Where a point goes (and how much a mark there squashes), pushed by every mask in turn. */
function push(fields: Field[], x: number, y: number, time: number, out: { x: number; y: number; k: number }) {
  out.x = x
  out.y = y
  out.k = 1
  for (const f of fields) {
    // Into the mask's frame (screen-clockwise rotation, y up).
    const dx = out.x - f.cx, dy = out.y - f.cy
    const lx = dx * f.cos - dy * f.sin, ly = dx * f.sin + dy * f.cos
    const reach = f.margin + f.soft
    // Far away: untouched (a cheap bound before the exact distance).
    const pad = reach + f.wobble * Math.min(f.hw, f.hh) * 0.2 + 8
    if (Math.abs(lx) > f.hw + pad || Math.abs(ly) > f.hh + pad) continue
    const a = Math.atan2(ly, lx)
    const edge = f.wobble * Math.min(f.hw, f.hh) * 0.18 * smoothNoise(a, time, f.seed)
    const d = sdf(f.m.shape, f.m.round, f.hw, f.hh, lx, ly) - edge
    if (d >= reach) continue
    // New distance: onto the margin ring, easing back to the true distance at the reach (smooth, no kink).
    const S = Math.max(1e-3, f.soft)
    let n = f.margin + S * Math.exp((d - reach) / S)
    // From inside, the deeper a mark was, the further out it lands: a rim of displaced marks across the
    // soft band rather than all on one line.
    if (d < 0) n += (0.85 * S - (n - f.margin)) * Math.min(1, -d / Math.max(1, Math.min(f.hw, f.hh))) * (S > 1 ? 1 : 0)
    const move = (n - d) * f.strength
    if (move <= 0) continue
    // Outward: the distance's gradient (from the centre when deep inside).
    const e = 1
    let gx = sdf(f.m.shape, f.m.round, f.hw, f.hh, lx + e, ly) - sdf(f.m.shape, f.m.round, f.hw, f.hh, lx - e, ly)
    let gy = sdf(f.m.shape, f.m.round, f.hw, f.hh, lx, ly + e) - sdf(f.m.shape, f.m.round, f.hw, f.hh, lx, ly - e)
    let gl = Math.hypot(gx, gy)
    if (gl < 1e-4) {
      gx = lx || 1
      gy = ly
      gl = Math.hypot(gx, gy)
    }
    gx /= gl
    gy /= gl
    // Back to the frame's axes.
    const wx = gx * f.cos + gy * f.sin, wy = -gx * f.sin + gy * f.cos
    out.x += wx * move
    out.y += wy * move
    // Pressed against it: smaller, the harder it's pushed.
    if (f.squash > 0) out.k *= 1 - f.squash * 0.6 * (1 - Math.exp((Math.min(d, reach) - reach) / S)) * f.strength
  }
}

const tmp = { x: 0, y: 0, k: 1 }

/** Push everything the Sequencer drew this frame out of its masks. */
export function applyMasks(frame: FrameContext, text: unknown) {
  const masks = decodeMasks(text).filter((m) => m.on && m.strength > 0)
  frameNo++
  if (!masks.length) {
    live.clear()
    return
  }
  const H = frame.viewport.height
  const fields: Field[] = masks.map((m, i) => {
    const l = step(m, frame.dt, frame.audio)
    const k = 1 + l.swell
    const t = (-l.r * Math.PI) / 180
    return {
      m, cx: l.x * H, cy: l.y * H, hw: Math.max(1, (l.w * H * k) / 2), hh: Math.max(1, (l.h * H * k) / 2),
      // Undo the turn (clockwise on screen = counter-clockwise in y-up), into the mask's frame.
      cos: Math.cos(t), sin: -Math.sin(t),
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
    }
  }
  for (const layer of [l.bars, l.barsMid.bars, l.barsFar.bars]) bars(layer)
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
  })
}
