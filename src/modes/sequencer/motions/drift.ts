import { STEMS } from '../../../audio/features'
import { noise } from '../palettes/types'
import type { DotMotion, MarkInfo, MotionFrame, MarkMove } from './types'

// Drift: colour, not position. Two octaves of horizontally stretched,
// domain-warped noise drag across the page like wet paint, shifting each dot
// along its ramp (`shift`, folded back at the ends so nothing piles up at 0
// or 1). Loudness speeds the drag; each stem's level pushes its own
// lanes one way along the ramp; strong onsets and every bar launch a colour
// front that sweeps left to right. Alpha breathes a touch with the field and
// the dots shimmer by under a pixel.

const STEM_DIR = [-1, 1, -1, 1] // per STEMS order: vocals, drums, bass, instruments
const FRONT_GAP = 0.35 // s between onset-triggered fronts
const FRONTS = 4

const fold = (v: number) => {
  const p = ((v % 2) + 2) % 2
  return p <= 1 ? p : 2 - p
}

export const drift: DotMotion = {
  id: 'drift',
  label: 'drift',
  params: {
    shift: { type: 'number', value: 0.5, min: 0, max: 2, step: 0.01, label: 'colour shift' },
    scale: { type: 'number', value: 1, min: 0.2, max: 6, step: 0.01, label: 'field size (smaller = finer)' },
    drag: { type: 'number', value: 0.1, min: 0, max: 1, step: 0.005, label: 'drag (pages/s)' },
    dragLoud: { type: 'number', value: 0.35, min: 0, max: 2, step: 0.01, label: 'drag when loud' },
    parts: { type: 'number', value: 0.2, min: 0, max: 1, step: 0.01, label: 'parts pull apart' },
    fronts: { type: 'number', value: 0.35, min: 0, max: 1.5, step: 0.01, label: 'colour fronts' },
    frontWidth: { type: 'number', value: 0.08, min: 0.01, max: 0.5, step: 0.005, label: 'front width (pages)' },
    frontTime: { type: 'number', value: 1.8, min: 0.2, max: 8, step: 0.05, label: 'front crossing (s)' },
    everyBar: { type: 'boolean', value: true, label: 'a front every bar' },
    alpha: { type: 'number', value: 0.1, min: 0, max: 0.6, step: 0.01, label: 'alpha breathes' },
  },
  create: () => {
    let phase = 0, warp = 0, bar = -1, since = 99, next = 0, lvl = 0
    const warm = new Float32Array(STEMS.length)
    const stemIx: Record<string, number> = {}
    STEMS.forEach((s, i) => (stemIx[s] = i))
    const fPos = new Float32Array(FRONTS).fill(9), fAmp = new Float32Array(FRONTS), fSign = new Float32Array(FRONTS)
    // Per frame: field shape and gain, front speed.
    let gain = 0, fSpeed = 0

    const launch = (amp: number) => {
      fPos[next] = -0.15; fAmp[next] = amp; fSign[next] = next % 2 ? -1 : 1
      next = (next + 1) % FRONTS
      since = 0
    }

    return {
      frame(f: MotionFrame) {
        const a = f.audio, dt = Math.min(0.1, f.dt)
        const k = 1 - Math.exp(-dt * 2.5)
        lvl += (a.level - lvl) * k
        for (let i = 0; i < STEMS.length; i++) warm[i] += (a.stems[STEMS[i]].level - warm[i]) * k
        const q = f.params
        phase += dt * f.speed * (q.drag + q.dragLoud * lvl)
        warp += dt * f.speed * (0.02 + 0.06 * lvl) * (1 + 3 * q.drag)
        gain = q.shift * f.amount * (0.7 + 0.5 * lvl)
        // Fronts: one per bar, plus strong onsets.
        since += dt
        const b = Math.floor(a.beat.position / 16)
        if (b !== bar) { if (bar >= 0 && q.everyBar) launch(0.7); bar = b }
        if (a.onset && a.onsetStrength > 0.6 && since > FRONT_GAP) launch(a.onsetStrength)
        fSpeed = (1.3 / Math.max(0.05, q.frontTime)) * Math.max(0.5, f.speed)
        for (let i = 0; i < FRONTS; i++) {
          if (fPos[i] > 1.3) continue
          fPos[i] += dt * fSpeed
          fAmp[i] *= Math.exp(-dt * 0.6)
        }
      },
      mark(_i: number, m: MarkInfo, f: MotionFrame, out: MarkMove) {
        const q = f.params
        const k = 1 / Math.max(0.05, q.scale)
        const u = m.x / f.W + 0.5, v = m.y / f.H + 0.5
        // Paint drag: x is stretched (low frequency), y warped by a slower field.
        const w = noise(v * 2.2 * k + 3.1, warp, 11) - 0.5
        const x = u * 1.4 * k - phase + w * 0.9, y = v * 5.5 * k + w * 0.6
        const n = (noise(x, y, 3) - 0.5) * 1.4 + (noise(x * 2.3 + 7, y * 2.1 - phase * 0.7, 5) - 0.5) * 0.6
        const s = stemIx[m.stem] ?? 0
        let shift = n * gain + STEM_DIR[s] * q.parts * f.amount * warm[s]
        const fw = q.frontWidth
        for (let i = 0; i < FRONTS; i++) {
          const d = fPos[i] - u
          if (d < -3 * fw || d > 3 * fw) continue
          shift += fSign[i] * fAmp[i] * q.fronts * f.amount * Math.exp(-(d * d) / (fw * fw))
        }
        out.t = fold(m.t + shift) - m.t
        out.alpha = 1 + q.alpha * f.amount * n
      },
    }
  },
}
