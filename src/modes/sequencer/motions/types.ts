import type { ParamSchema } from '../../../app/params'
import type { AudioFeatures, Stem } from '../../../audio/features'

// Dot motions: explorations of how the still Dots picture moves with the
// music. The picture is generated once; every frame a motion is asked, mark by
// mark, how far to move it, how big, how opaque, how far along its colour
// gradient to shift it, and how `lit` it is: lit, any dot (a ghost too) turns
// into a full dot of its part, in its part's event colour, so motions can make
// dots appear and vanish. The haze blurs the moved marks, so it moves with them.

export interface MarkInfo {
  /** Centre and radius on the page, px (y up, origin at the page centre). */
  x: number
  y: number
  r: number
  /** Slot (time, 0..T-1 down the systems) and lane (0..N-1 across). */
  g: number
  l: number
  stem: Stem
  kind: 'ghost' | 'base' | 'event'
  /** 0..1 within its kind. */
  lv: number
  sec: number
  /** Song step the slot starts at. */
  step: number
  /** Gradient position the palette gave it. */
  t: number
  /** As a lit (event) dot of its part: radius, gradient row and position. */
  er: number
  eRow: number
  eT: number
}

export interface MotionFrame {
  time: number
  dt: number
  audio: AudioFeatures
  /** Where the music is, song steps (wrapped for a loop). */
  position: number
  /** The printed window, song steps [w0, w1), and steps per slot. */
  w0: number
  w1: number
  stepsPer: number
  /** Slots, lanes, rows per system, systems; dot pitch across / down, px. */
  T: number
  N: number
  Rw: number
  S: number
  pX: number
  pY: number
  /** Page size, px. */
  W: number
  H: number
  /** The mode's `motion amount` (0..1, 0 = still) and `motion speed` (x). */
  amount: number
  speed: number
  /** The motion's own controls (its `params`, unprefixed). */
  params: Record<string, any>
}

/** What a motion does to one mark this frame; reset to rest before each mark. */
export interface MarkMove {
  /** Offset, px. */
  dx: number
  dy: number
  /** Multiplies the radius. */
  size: number
  /** Multiplies the alpha. */
  alpha: number
  /** Added to the gradient position (clamped 0..1): shifts its colour along its ramp. */
  t: number
  /** 0..1: how far it turns into a lit dot (event radius, colour, full alpha) before size / alpha apply. */
  lit: number
  /**
   * Colour by size: shifts the gradient position by this much per lit-dot
   * radius it grows past its rest size (negative: the other way). Past the
   * ramp's ends it mirrors back (the bar shader ping-pongs), so it never clips.
   */
  hueBySize: number
}

/** Grown this far past its rest size (x), a dot has fully taken its part's colour. */
const GROWN_COLOURED = 0.6

/**
 * Rest -> moved mark: the lit blend, then size, alpha, offset and colour shift.
 * A dot scaled up past its rest size also fades toward its part's colour (and
 * full alpha) as it grows, so a swollen grey ghost never stays grey.
 */
export function applyMove(m: { x: number; y: number; radius?: number; alpha?: number; t0: number; row?: number }, info: MarkInfo, mv: MarkMove, o: {
  x: number; y: number; w: number; h: number; radius?: number; alpha?: number; t0: number; t1: number; row?: number
}) {
  const lit = Math.min(1, Math.max(0, mv.lit))
  const r0 = m.radius ?? 0
  const r = (r0 + (Math.max(r0, info.er) - r0) * lit) * Math.max(0, mv.size)
  // Colour: lit, or grown past rest size.
  const c = Math.max(lit, Math.min(1, Math.max(0, (mv.size - 1) / GROWN_COLOURED)))
  const a0 = m.alpha ?? 1
  o.x = m.x + mv.dx; o.y = m.y + mv.dy
  o.w = o.h = 2 * r; o.radius = r
  o.alpha = Math.min(1, Math.max(0, (a0 + (1 - a0) * c) * mv.alpha))
  // Same gradient: slide along it. Another (a grey ghost): take the colour as soon as it grows or lights,
  // so no grown dot stays grey; its fade in is its size and alpha.
  const same = info.eRow === m.row
  const coloured = c > 0.02
  const t = same ? m.t0 + (info.eT - m.t0) * c : coloured ? info.eT : m.t0
  o.row = same || !coloured ? m.row : info.eRow
  // Bigger than it rests: further along (or back) its ramp, by `hueBySize`.
  const grown = mv.hueBySize ? (mv.hueBySize * (r - r0)) / Math.max(0.5, info.er) : 0
  // The bar shader mirrors past the ramp's ends (palettes rest there on purpose): keep that range, don't clip to 0..1.
  o.t0 = o.t1 = Math.min(2, Math.max(-1, t + mv.t + grown))
}

export interface DotMotionInstance {
  /** Once per frame, before the marks (advance state, decay envelopes). */
  frame?(f: MotionFrame): void
  mark(i: number, m: MarkInfo, f: MotionFrame, out: MarkMove): void
}

export interface DotMotion {
  id: string
  label: string
  /** Its own controls; a mode lists them (prefixed `<id>_`) in a folder while the motion is chosen. */
  params?: ParamSchema
  /** How much of the held-note streaks to keep this frame (0..1), from its controls and the amount; default all. */
  streaks?(params: Record<string, any>, amount: number): number
  /** Called when the picture changes (new marks); keep per-mark state in here. */
  create(marks: readonly MarkInfo[]): DotMotionInstance
}

/** Window position 0..1 of the playhead (it loops through the window). */
export const playhead = (f: MotionFrame) => {
  const len = Math.max(1e-6, f.w1 - f.w0)
  return ((((f.position - f.w0) % len) + len) % len) / len
}
/** Slot under the playhead (fractional). */
export const playSlot = (f: MotionFrame) => playhead(f) * f.T
