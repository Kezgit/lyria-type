import type { ParamSchema } from '../../app/params'
import type { BarSpec } from '../../engine/barLayer'

// Dot shape, for the dot modes: each dot (a round bar) drawn as a dash or bar
// of any length, roundness and angle, its size, length and angle varied by a
// smooth noise field drifting across the page (`noiseSpeed` 0 = held still),
// so the variation is truly random but never jittery.

export const dotShapeParams: ParamSchema = {
  dotSize: { type: 'number', value: 1, min: 0.1, max: 4, step: 0.01, label: 'dot size (×)' },
  dotLength: { type: 'number', value: 1, min: 0.2, max: 12, step: 0.05, label: 'dot length (× size, 1 = round)' },
  dotRound: { type: 'number', value: 1, min: 0, max: 1, step: 0.01, label: 'roundness (0 = square)' },
  dotAngle: { type: 'number', value: 0, min: -180, max: 180, step: 1, label: 'angle (°, 90 = down)' },
  randSize: { type: 'number', value: 0, min: 0, max: 1, step: 0.01, label: 'random size' },
  randLength: { type: 'number', value: 0, min: 0, max: 1, step: 0.01, label: 'random length' },
  randAngle: { type: 'number', value: 0, min: 0, max: 1, step: 0.01, label: 'random angle' },
  noiseScale: { type: 'number', value: 160, min: 8, max: 1200, step: 1, label: 'noise scale (px)' },
  noiseSpeed: { type: 'number', value: 0.3, min: 0, max: 4, step: 0.01, label: 'noise speed (0 = still)' },
  noiseSeed: { type: 'number', value: 1, min: 0, max: 100, step: 1, label: 'noise seed' },
}
export const dotShapeKeys = Object.keys(dotShapeParams)

const hash = (x: number, y: number, z: number) => {
  const h = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453
  return h - Math.floor(h)
}
const fade = (t: number) => t * t * (3 - 2 * t)
/** Smooth value noise in 3D, -1..1. */
export function noise(x: number, y: number, z: number) {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z)
  const xf = fade(x - xi), yf = fade(y - yi), zf = fade(z - zi)
  const lerp = (a: number, b: number, t: number) => a + (b - a) * t
  const c = (dx: number, dy: number, dz: number) => hash(xi + dx, yi + dy, zi + dz)
  const v = lerp(
    lerp(lerp(c(0, 0, 0), c(1, 0, 0), xf), lerp(c(0, 1, 0), c(1, 1, 0), xf), yf),
    lerp(lerp(c(0, 0, 1), c(1, 0, 1), xf), lerp(c(0, 1, 1), c(1, 1, 1), xf), yf),
    zf,
  )
  return v * 2 - 1
}

/** Whether any dot shape setting departs from a plain round dot. */
export function shapesDots(p: Record<string, any>) {
  return p.dotSize !== 1 || p.dotLength !== 1 || p.dotRound !== 1 || p.dotAngle !== 0 || p.randSize > 0 || p.randLength > 0 || p.randAngle > 0
}

/** Reshape dot `o` (a round bar, as the modes draw it) in place; `time` in s. */
export function shapeDot(o: BarSpec, p: Record<string, any>, time: number) {
  const r0 = o.radius ?? o.w / 2
  if (r0 <= 0) return
  const s = 1 / Math.max(8, p.noiseScale)
  const z = time * p.noiseSpeed + p.noiseSeed * 17.3
  const nx = o.x * s, ny = o.y * s
  const size = Math.max(0.05, p.dotSize * (1 + 0.8 * p.randSize * noise(nx, ny, z)))
  const length = Math.max(0.2, p.dotLength * (1 + 0.9 * p.randLength * noise(nx + 31.4, ny - 17.2, z + 5.1)))
  const angle = p.dotAngle + 90 * p.randAngle * noise(nx - 11.7, ny + 43.1, z - 3.3)
  const r = r0 * size
  o.h = 2 * r
  o.w = 2 * r * length
  o.radius = r * Math.min(1, Math.max(0, p.dotRound))
  o.rotation = (angle * Math.PI) / 180
}
