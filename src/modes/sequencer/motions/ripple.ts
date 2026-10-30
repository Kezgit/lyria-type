import { STEM_OF, STEMS, type Stem, type Voice } from '../../../audio/features'
import { noise } from '../palettes/types'
import { playSlot, type DotMotion, type MarkInfo, type MotionFrame } from './types'

// Ripple: each note drops a stone at the mark the playhead is on in its stem's
// lanes; rings run outward through the grid. Nothing moves: the crest lights
// the dots it passes (empty points too, as new dots in their part's colour) and
// swells them, the trough behind it shrinks them away, and the ring carries a
// wave of colour along each dot's ramp, fading with distance and age. Kick big
// and slow, snare sharp, hat tiny, pitched parts soft. A faint colour shimmer
// on audio.low keeps the surface alive. Units: dot pitches, s.

/** amp: how strongly the crest lights; speed pitches/s, wavelength pitches, life s, size swell, colour wave. */
interface Drop { amp: number; speed: number; wl: number; life: number; size: number; tint: number }
const DROP: Record<Voice, Drop> = {
  kick: { amp: 2, speed: 7, wl: 3.6, life: 2.2, size: 0.5, tint: 0.28 },
  snare: { amp: 1.6, speed: 14, wl: 1.6, life: 1, size: 0.4, tint: 0.22 },
  hat: { amp: 0.5, speed: 9, wl: 0.8, life: 0.4, size: 0.15, tint: 0.08 },
  bass: { amp: 1.3, speed: 5, wl: 3, life: 1.8, size: 0.35, tint: 0.2 },
  pad: { amp: 0.9, speed: 4, wl: 3.4, life: 2.4, size: 0.25, tint: 0.16 },
  lead: { amp: 1, speed: 7, wl: 2.2, life: 1.6, size: 0.3, tint: 0.18 },
}
const POOL = 24
const KIND_RANK = { ghost: 0, base: 1, event: 2 } as const

/** Crest at u = 0, trough a wavelength behind; u in wavelengths past the front. */
const wave = (u: number) => Math.exp(-u * u * 5) - 0.65 * Math.exp(-(u + 0.8) * (u + 0.8) * 4)

/** Which parts drop stones. */
const FROM: Record<string, (s: Stem) => boolean> = { all: () => true, drums: (s) => s === 'drums', pitched: (s) => s !== 'drums' }

export const ripple: DotMotion = {
  id: 'ripple',
  label: 'ripple',
  params: {
    from: { type: 'select', value: 'all', label: 'stones from', options: { 'every part': 'all', drums: 'drums', 'pitched parts': 'pitched' } },
    light: { type: 'number', value: 1, min: 0, max: 4, step: 0.01, label: 'crest lights dots' },
    swell: { type: 'number', value: 1, min: 0, max: 4, step: 0.01, label: 'crest swells dots' },
    colour: { type: 'number', value: 1, min: -3, max: 3, step: 0.01, label: 'colour wave' },
    trough: { type: 'number', value: 2.2, min: 0, max: 6, step: 0.05, label: 'trough shrinks dots' },
    ringSpeed: { type: 'number', value: 1, min: 0.2, max: 4, step: 0.01, label: 'ring speed' },
    ringSize: { type: 'number', value: 1, min: 0.3, max: 4, step: 0.01, label: 'ring width' },
    life: { type: 'number', value: 1, min: 0.2, max: 4, step: 0.01, label: 'ring life' },
    reach: { type: 'number', value: 10, min: 1, max: 60, step: 0.5, label: 'fade with distance (dots)' },
    shimmer: { type: 'number', value: 0.05, min: 0, max: 0.5, step: 0.005, label: 'ambient shimmer' },
  },
  create(marks: readonly MarkInfo[]) {
    // Each stem's marks, sorted by slot, for finding the one under the playhead.
    const byStem = {} as Record<Stem, Int32Array>
    for (const s of STEMS) {
      const ix: number[] = []
      marks.forEach((m, i) => { if (m.stem === s) ix.push(i) })
      ix.sort((a, b) => marks[a].g - marks[b].g)
      byStem[s] = Int32Array.from(ix)
    }
    const cx = new Float32Array(POOL), cy = new Float32Array(POOL), age = new Float32Array(POOL)
    const amp = new Float32Array(POOL), spd = new Float32Array(POOL), wl = new Float32Array(POOL)
    const life = new Float32Array(POOL), size = new Float32Array(POOL), tint = new Float32Array(POOL)
    const reach = new Float32Array(POOL)
    let head = 0, live = 0, pitch = 1, low = 0

    /** The stem's mark nearest the playhead slot: events over bases over ghosts, then louder. */
    const source = (stem: Stem, slot: number) => {
      const ix = byStem[stem]
      if (!ix.length) return -1
      let lo = 0, hi = ix.length
      while (lo < hi) { const mid = (lo + hi) >> 1; if (marks[ix[mid]].g < slot) lo = mid + 1; else hi = mid }
      const near = lo < ix.length && (lo === 0 || marks[ix[lo]].g - slot <= slot - marks[ix[lo - 1]].g) ? lo : lo - 1
      const g = marks[ix[near]].g
      let best = -1, score = -1
      for (let k = near; k >= 0 && marks[ix[k]].g === g; k--) {
        const m = marks[ix[k]], sc = KIND_RANK[m.kind] + m.lv * 0.5
        if (sc > score) { score = sc; best = ix[k] }
      }
      for (let k = near + 1; k < ix.length && marks[ix[k]].g === g; k++) {
        const m = marks[ix[k]], sc = KIND_RANK[m.kind] + m.lv * 0.5
        if (sc > score) { score = sc; best = ix[k] }
      }
      return best
    }

    return {
      frame(f: MotionFrame) {
        const q = f.params
        pitch = Math.max(1, (f.pX + f.pY) * 0.5)
        const dt = Math.min(0.1, Math.max(0, f.dt)) * f.speed
        low += (f.audio.low - low) * Math.min(1, dt * 3)
        live = 0
        for (let j = 0; j < POOL; j++) {
          if (age[j] < life[j]) { age[j] += dt; if (age[j] < life[j]) live++ }
        }
        const notes = f.audio.notes
        if (!notes.length) return
        const slot = Math.floor(playSlot(f))
        for (const n of notes) {
          const d = DROP[n.voice]
          if (!(FROM[q.from] ?? FROM.all)(STEM_OF[n.voice])) continue
          const i = source(STEM_OF[n.voice], slot)
          if (i < 0) continue
          const v = 0.4 + 0.6 * n.velocity
          const j = head; head = (head + 1) % POOL
          cx[j] = marks[i].x; cy[j] = marks[i].y; age[j] = 0
          amp[j] = d.amp * v * q.light; spd[j] = d.speed * q.ringSpeed * pitch; wl[j] = d.wl * q.ringSize * pitch
          life[j] = d.life * q.life * (0.7 + 0.3 * v); size[j] = d.size * v * q.swell; tint[j] = d.tint * v * q.colour
          reach[j] = (d.speed * q.ringSpeed * life[j] + d.wl * q.ringSize * 1.5) * pitch
          live++
        }
      },
      mark(_i, m, f, out) {
        const q = f.params
        const a = f.amount
        // Ambient: a slow colour shimmer, lifted by the lows.
        const nx = m.x / pitch * 0.12, ny = m.y / pitch * 0.12, nt = f.time * 0.15 * f.speed
        let dt = (noise(nx + nt, ny - nt, 3) - 0.5) * 2 * q.shimmer * a * (0.25 + low)
        let sz = 0, glow = 0, cut = 0
        if (live) {
          for (let j = 0; j < POOL; j++) {
            const ag = age[j]
            if (ag >= life[j]) continue
            const ox = m.x - cx[j], oy = m.y - cy[j], d2 = ox * ox + oy * oy
            if (d2 > reach[j] * reach[j]) continue
            const d = Math.sqrt(d2), u = (d - spd[j] * ag) / wl[j]
            if (u > 1 || u < -2.5) continue
            const k = 1 - ag / life[j]
            const env = k * k / (1 + d / (q.reach * pitch)) * a
            const w = wave(u) * env
            // Crest: lit and swollen; trough: shrunk away; both carry the colour wave.
            if (w > 0) { glow += amp[j] * w; sz += size[j] * w } else cut -= w
            dt += tint[j] * w
          }
        }
        out.lit = Math.max(out.lit, Math.min(1, glow))
        out.size *= Math.max(0, (1 + sz) * (1 - Math.min(1, q.trough * cut)))
        out.t += dt
      },
    }
  },
}
