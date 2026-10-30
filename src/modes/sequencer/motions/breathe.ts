import { STEMS } from '../../../audio/features'
import { hash } from '../palettes/types'
import { playSlot, type DotMotion } from './types'

// Breathe: the matrix pulses in and out. Each part's lanes swell and fade with
// that stem's live level; its onsets pop its dots (fast attack, short decay, one
// envelope per stem); the rows under the playhead glow (bigger, a touch darker)
// with a soft lead and a longer tail; ghosts breathe on a slow sine, each with
// its own phase, so nothing is ever quite still. Events breathe most.

const KIND_W = { ghost: 0.35, base: 0.7, event: 1.25 } as const

export const breathe: DotMotion = {
  id: 'breathe',
  label: 'breathe',
  params: {
    swell: { type: 'number', value: 0.35, min: 0, max: 2, step: 0.01, label: 'swell with level' },
    fade: { type: 'number', value: 0.45, min: 0, max: 1.5, step: 0.01, label: 'fade with level' },
    pop: { type: 'number', value: 0.6, min: 0, max: 3, step: 0.01, label: 'hits pop' },
    popTone: { type: 'number', value: -0.12, min: -0.6, max: 0.6, step: 0.01, label: 'hits shift colour' },
    decay: { type: 'number', value: 0.16, min: 0.02, max: 1.5, step: 0.01, label: 'pop decay (s)' },
    glow: { type: 'number', value: 0.45, min: 0, max: 2, step: 0.01, label: 'playhead glow' },
    glowTone: { type: 'number', value: 0.1, min: -0.6, max: 0.6, step: 0.01, label: 'playhead colour shift' },
    lead: { type: 'number', value: 1.2, min: 0.2, max: 16, step: 0.1, label: 'glow ahead (rows)' },
    tail: { type: 'number', value: 6, min: 0.2, max: 64, step: 0.1, label: 'glow trail (rows)' },
    ghost: { type: 'number', value: 0.22, min: 0, max: 1.5, step: 0.01, label: 'ghosts breathe' },
    ghostRate: { type: 'number', value: 0.18, min: 0.01, max: 2, step: 0.01, label: 'ghost breath (Hz)' },
  },
  create(marks) {
    const n = marks.length
    const stem = new Uint8Array(n)
    const kw = new Float32Array(n)
    const phase = new Float32Array(n)
    const rate = new Float32Array(n)
    const pop = new Float32Array(n)
    for (let i = 0; i < n; i++) {
      const m = marks[i]
      stem[i] = STEMS.indexOf(m.stem)
      kw[i] = KIND_W[m.kind] * (0.8 + 0.4 * m.lv)
      phase[i] = hash(m.g, m.l, 3.1) * Math.PI * 2
      rate[i] = 0.75 + 0.5 * hash(m.l, m.g, 7.7)
      pop[i] = 0.6 + 0.8 * hash(m.g, m.l, 11.3)
    }
    const level = new Float32Array(STEMS.length)
    const env = new Float32Array(STEMS.length)
    let ps = 0, T = 1, time = 0

    return {
      frame(f) {
        const k = Math.exp(-f.dt / (f.params.decay / Math.sqrt(Math.max(0.1, f.speed))))
        for (let s = 0; s < STEMS.length; s++) {
          const st = f.audio.stems[STEMS[s]]
          level[s] = st.level
          env[s] *= k
          if (st.onset) env[s] = Math.max(env[s], 0.4 + 0.6 * st.onsetStrength)
        }
        ps = playSlot(f)
        T = Math.max(1, f.T)
        time += f.dt * f.speed
      },
      mark(i, m, f, out) {
        const q = f.params
        const a = f.amount, w = kw[i], s = stem[i]
        const lv = level[s], e = env[s] * pop[i]

        // Playhead band: slots ahead fall off fast, behind trail off slowly (wrapped).
        let d = m.g + 0.5 - ps
        d -= Math.round(d / T) * T
        const band = d >= 0 ? Math.exp(-(d / q.lead) * (d / q.lead)) : Math.exp(d / q.tail)

        let size = q.swell * w * (lv - 0.3) + q.pop * w * e + q.glow * band * (0.5 + 0.5 * w)
        let alpha = 1 + q.fade * w * (lv - 0.5) + 0.3 * e + 0.25 * band
        let t = q.popTone * e + q.glowTone * band

        if (m.kind === 'ghost') {
          const b = Math.sin(time * q.ghostRate * Math.PI * 2 * rate[i] + phase[i])
          size += q.ghost * b
          alpha += 0.25 * b
        }

        out.size = Math.max(0.05, 1 + a * size)
        out.alpha = Math.max(0, 1 + a * (alpha - 1))
        out.t = a * t
      },
    }
  },
}
