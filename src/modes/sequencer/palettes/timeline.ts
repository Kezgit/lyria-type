import { BRAND, hash, type BrandHue, type DotPalette } from './types'

// Timeline: colour follows time, not the part. The window travels blue -> green
// -> yellow -> red and hands back toward blue as g/T runs 0 -> 1 (`offset` turns
// the start); each hand-off is a dithered crossfade of dots, and sections nudge
// the journey and tilt its depth so they read as chapters. Weight picks the step
// within the hue (ghosts 20/50, base 200-500, events 600-900); the strongest
// events jump to the complementary hue. Each row holds every hue's light..dark
// pair in journey order, so a dot samples only inside its own hue's segment.

type Hue = Exclude<BrandHue, 'grey'>
const JOURNEY: Hue[] = ['blue', 'green', 'yellow', 'red']
const COMPLEMENT: Record<Hue, Hue> = { blue: 'yellow', green: 'red', yellow: 'blue', red: 'green' }
type Step = keyof typeof BRAND.blue
const pairs = (hues: Hue[], a: Step, b: Step) => hues.flatMap((h) => [BRAND[h][a], BRAND[h][b]])
/** Legs of the journey across the window: blue .. red, ending at the hand-off back to blue. */
const LEGS = 3.5
/** Half-width of a hand-off, in hues. */
const HANDOFF = 0.3

let turn = 0
/** Hue index 0..3 at slot g: the journey, nudged per section, dithered at hand-offs. */
const hueAt = (g: number, T: number, sec: number, jitter: number) => {
  const h = (g / Math.max(1, T - 1)) * LEGS + turn * 4 + (sec % 2 ? 0.2 : -0.2) + jitter * 2 * HANDOFF
  return ((Math.round(h) % 4) + 4) % 4
}
/** Position inside hue k's light..dark segment of a 4-hue paired row. */
const seg = (k: number, x: number) => (2 * k + Math.min(1, Math.max(0, x))) / 7

export const timeline: DotPalette = {
  id: 'timeline',
  label: 'timeline',
  rows: [pairs(JOURNEY, 20, 50), pairs(JOURNEY, 200, 500), pairs(JOURNEY, 600, 900), pairs(JOURNEY.map((h) => COMPLEMENT[h]), 500, 800)],
  paint: (d) => {
    turn = d.offset
    // Triangular jitter: the crossfade eases in and out rather than ramping.
    const k = hueAt(d.g, d.T, d.sec, (hash(d.g, d.l, 7) + hash(d.l, d.g, 11)) / 2 - 0.5)
    const tilt = d.sec % 2 ? 0.12 : -0.06
    if (d.red) return { row: 3, t: seg(k, 0.3 + 0.7 * d.lv), size: 1.1 }
    if (d.kind === 'ghost') return { row: 0, t: seg(k, 0.5 + tilt) }
    if (d.kind === 'base') return { row: 1, t: seg(k, d.lv + tilt) }
    return { row: 2, t: seg(k, d.lv + tilt) }
  },
  streak: (_stem, d) => BRAND[JOURNEY[hueAt(d.g, d.T, d.sec, hash(d.g, d.l, 7) - 0.5)]][200],
}
