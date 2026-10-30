import type { Stem } from '../../../audio/features'
import { BRAND, type BrandHue, type DotPalette } from './types'

// Register: each part keeps its Google hue, and pitch picks the step on the
// brand ramp: low lanes deep (1100), high lanes light (200), so every part is
// a tonal column, dark to light across the page. Drums snap to three steps
// (kick 1000, snare 600, hat 200). Loudness and onsets sit a couple of steps
// darker and more opaque; ghosts at the 50/20 tint. Steps are quantised.

const STEPS = [10, 20, 50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 1000, 1100, 1200] as const
const TOP = STEPS.length - 1
const at = (step: number) => STEPS.indexOf(step as (typeof STEPS)[number])
const ROW: Record<Stem, number> = { drums: 0, bass: 1, instruments: 2, vocals: 3 }
const ramp = (h: Exclude<BrandHue, 'grey'>) => STEPS.map((s) => BRAND[h][s])
const LOW = at(1100), HIGH = at(200)
const DRUM = [at(1000), at(600), at(200)]

export const register: DotPalette = {
  id: 'register',
  label: 'register',
  rows: [ramp('red'), ramp('green'), ramp('yellow'), ramp('blue')],
  paint: (d) => {
    const row = ROW[d.stem]
    const reg = d.stem === 'drums' ? DRUM[Math.min(2, Math.floor(d.within * 3))]! : LOW + (HIGH - LOW) * d.within
    const step = (i: number) => Math.round(Math.max(0, Math.min(TOP, i))) / TOP
    if (d.kind === 'ghost') return { row, t: step(d.within < 0.5 ? at(50) : at(20)) }
    if (d.kind === 'base') return { row, t: step(reg - 1 + d.lv), alpha: 0.75 + 0.25 * d.lv }
    return { row, t: step(reg + 1 + 1.5 * d.lv + (d.red ? 1 : 0)), alpha: 1, size: d.red ? 1.15 : 1 }
  },
}
