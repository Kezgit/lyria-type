import { STEM_OF, STEMS, type Stem } from '../../../audio/features'
import { hash } from '../palettes/types'
import type { DotMotion } from './types'

// Live: the dots as the music is now. Each part's dots come and go with its
// live level and its hits:
//   new dots   empty points light up as new dots in the part's colour,
//              scattered: `density` of them at full level, `spark` per hit
//   the base   the picture's own dots: an `erase` share of them (scattered)
//              stop being fixed and only stand while the live music puts them
//              there (heavier dots more readily); the rest stay, dropping out
//              only when their part goes quiet (`keep` the strongest)
//   drive      by the parts' levels, their hits, or both
// Which points is reshuffled all the time (every dot on its own clock,
// `shuffle` s), so the pattern keeps shifting while the grid holds. Dots grow
// in over `fadeIn` and shrink out over `fadeOut`; each hit swells its part's
// dots (`swell`), and the bigger a dot grows the further its colour moves
// along its ramp (`size → colour`), so swollen and new dots read apart.

export const live: DotMotion = {
  id: 'live',
  label: 'live',
  params: {
    erase: { type: 'number', value: 0.5, min: 0, max: 1, step: 0.01, label: 'erase the base' },
    drive: { type: 'select', value: 'both', label: 'driven by', options: { 'levels and hits': 'both', levels: 'level', hits: 'hits' } },
    density: { type: 'number', value: 0.06, min: 0, max: 0.6, step: 0.005, label: 'new dots at full level' },
    spark: { type: 'number', value: 0.08, min: 0, max: 0.6, step: 0.005, label: 'new dots per hit' },
    keep: { type: 'number', value: 0.2, min: 0, max: 1, step: 0.01, label: 'quiet: base kept' },
    contrast: { type: 'number', value: 1.5, min: 0.3, max: 4, step: 0.05, label: 'level contrast' },
    shuffle: { type: 'number', value: 1.6, min: 0.1, max: 8, step: 0.05, label: 'reshuffle (s)' },
    fadeIn: { type: 'number', value: 0.07, min: 0.01, max: 2, step: 0.01, label: 'appear (s)' },
    fadeOut: { type: 'number', value: 0.35, min: 0.02, max: 4, step: 0.01, label: 'vanish (s)' },
    linger: { type: 'number', value: 0.6, min: 0.02, max: 4, step: 0.01, label: 'new dots linger (s)' },
    grow: { type: 'number', value: 1, min: 0.2, max: 2.5, step: 0.05, label: 'new dot size' },
    grid: { type: 'number', value: 1, min: 0, max: 1, step: 0.01, label: 'ghost grid' },
    hueBySize: { type: 'number', value: 0.5, min: -2, max: 2, step: 0.01, label: 'size → colour' },
    swell: { type: 'number', value: 0.4, min: 0, max: 2, step: 0.01, label: 'hits swell dots' },
  },
  // Erasing the base thins its held-note streaks too.
  streaks: (q, a) => 1 - q.erase * a,
  create(marks) {
    const n = marks.length
    const stem = Uint8Array.from(marks, (m) => STEMS.indexOf(m.stem))
    const ghost = Uint8Array.from(marks, (m) => (m.kind === 'ghost' ? 1 : 0))
    const weight = Float32Array.from(marks, (m) => (m.kind === 'event' ? 0.5 + 0.5 * m.lv : m.kind === 'base' ? 0.5 * m.lv : 0))
    const phase = Float32Array.from({ length: n }, (_, i) => hash(i, 11))
    /** Which base dots follow the live music (below `erase`), fixed per dot so the erasure is scattered. */
    const follows = Float32Array.from({ length: n }, (_, i) => hash(i, 23))
    const pres = new Float32Array(n).fill(1)
    const lit = new Float32Array(n)
    // Per stem: smoothed level, its running peak (to normalise), and a hit that decays.
    const level = new Float32Array(STEMS.length)
    const peak = new Float32Array(STEMS.length).fill(0.05)
    const kick = new Float32Array(STEMS.length)
    let dt = 0, time = 0

    return {
      frame(f) {
        dt = Math.min(0.1, Math.max(0, f.dt))
        time += dt * f.speed
        STEMS.forEach((s: Stem, k) => {
          const st = f.audio.stems[s]
          const v = st.level
          level[k] += (v - level[k]) * (1 - Math.exp(-dt / (v > level[k] ? 0.04 : 0.25)))
          peak[k] = Math.max(level[k], peak[k] * Math.exp(-dt / 8), 0.05)
          kick[k] *= Math.exp(-dt / 0.2)
          if (st.onset) kick[k] = Math.max(kick[k], 0.4 + 0.6 * st.onsetStrength)
        })
        for (const nt of f.audio.notes) {
          const k = STEMS.indexOf(STEM_OF[nt.voice])
          if (k >= 0) kick[k] = Math.max(kick[k], 0.4 + 0.6 * nt.velocity)
        }
      },
      mark(i, _m, f, out) {
        const q = f.params
        const k = stem[i]
        const byLevel = q.drive !== 'hits' ? Math.pow(Math.min(1, level[k] / peak[k]), q.contrast) : 0
        const byHit = q.drive !== 'level' ? kick[k] : 0
        // This dot's chance, re-drawn every `shuffle` s on its own clock.
        const h = hash(i, Math.floor(time / Math.max(0.05, q.shuffle) + phase[i]), 5)
        let want = 1, spark = 0
        if (ghost[i]) {
          // Empty points: lit as new dots while the part is loud, sparked by its hits.
          spark = h < q.density * byLevel + q.spark * byHit ? 1 : 0
        } else if (follows[i] < q.erase) {
          // Erased: stands only while the music puts it there (heavier dots more readily).
          want = h < (0.25 + 0.75 * weight[i]) * (byLevel + 3 * q.spark * byHit) ? 1 : 0
        } else {
          // Fixed: stands while its part plays; the weak drop first as it quietens.
          const L = q.drive === 'hits' ? Math.min(1, kick[k] + 0.3) : byLevel
          want = h * (1 - 0.7 * weight[i]) < q.keep + L ? 1 : 0
        }
        pres[i] += (want - pres[i]) * (1 - Math.exp(-dt / (want > pres[i] ? q.fadeIn : q.fadeOut)))
        lit[i] += (spark - lit[i]) * (1 - Math.exp(-dt / (spark > lit[i] ? q.fadeIn : q.linger)))
        const a = f.amount
        const p = pres[i] * pres[i] * (3 - 2 * pres[i])
        out.size *= (1 - a + a * p) * (1 + q.swell * byHit * a * (0.5 + 0.5 * weight[i] + 0.5 * ghost[i]))
        out.hueBySize += q.hueBySize * a
        if (ghost[i]) {
          out.lit = Math.max(out.lit, lit[i] * a)
          // New dots at `grow` size (a fresh hit swells them a touch); the bare grid at `grid`.
          out.size *= 1 + lit[i] * a * (q.grow - 1 + 0.2 * kick[k])
          out.alpha *= 1 - (1 - q.grid) * (1 - lit[i]) * a
        }
      },
    }
  },
}
