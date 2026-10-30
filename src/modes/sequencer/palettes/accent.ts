import { BRAND, type DotPalette } from './types'
import type { Stem } from '../../../audio/features'

// Accent: intentional, never decorative. The matrix is neutral grey (ghosts
// 20/50, base dots 50 -> 800 by loudness); colour lands only where something
// happens: events in their part's hue at 500-700, the strongest at 800 and a
// touch larger, held notes in the part's 100. Rows: grey, blue, red, then
// yellow + green sharing one row with repeated guard stops between them.

type Hue = 'blue' | 'red' | 'yellow' | 'green'
const HUE: Record<Stem, Hue> = { vocals: 'blue', instruments: 'yellow', drums: 'red', bass: 'green' }
const ramp = (h: Hue) => [BRAND[h][500], BRAND[h][600], BRAND[h][700], BRAND[h][800]]
const Y = ramp('yellow'), G = ramp('green')

/** Per hue: row, first stop index (500), stop count of the row. */
const AT: Record<Hue, [number, number, number]> = { blue: [1, 0, 4], red: [2, 0, 4], yellow: [3, 0, 10], green: [3, 6, 10] }

export const accent: DotPalette = {
  id: 'accent',
  label: 'accent',
  rows: [
    [BRAND.grey[20], BRAND.grey[50], BRAND.grey[800]],
    ramp('blue'),
    ramp('red'),
    [...Y, Y[3], G[0], ...G],
  ],
  paint: (d) => {
    if (d.kind === 'ghost') return { row: 0, t: 0.25 }
    if (d.kind === 'base') return { row: 0, t: 0.5 + 0.5 * d.lv }
    const [row, k0, n] = AT[HUE[d.stem]]
    // 500 -> 700 by level; the strongest at 800.
    const k = k0 + (d.red ? 3 : 2 * d.lv)
    return { row, t: k / (n - 1), size: d.red ? 1.15 : 1 }
  },
  streak: (stem) => BRAND[HUE[stem]][100],
}
