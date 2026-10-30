import { BRAND, type DotPalette } from './types'
import type { Stem } from '../../../audio/features'

// Primary: the four Google hues at full strength, one per part, in the order
// the lanes run across the page: drums gold (yellow into amber and orange),
// bass green, instruments red, vocals blue (light blue into deep blue). Quiet
// dots sit at the light end of their part's ramp, loud ones deep; the
// strongest hits reach the darkest step. Under a big haze the parts pool into
// soft fields that run warm (gold, orange, brown) through green and red into blue.

const ROW: Record<Stem, number> = { drums: 0, bass: 1, instruments: 2, vocals: 3 }
const HUE = { drums: 'yellow', bass: 'green', instruments: 'red', vocals: 'blue' } as const

export const primary: DotPalette = {
  id: 'primary',
  label: 'primary (gold · green · red · blue)',
  rows: [
    [BRAND.yellow[100], BRAND.yellow[300], BRAND.yellow[500], BRAND.yellow[700], BRAND.yellow[800], BRAND.yellow[900]],
    [BRAND.green[200], BRAND.green[300], BRAND.green[400], BRAND.green[500], BRAND.green[700], BRAND.green[800]],
    [BRAND.red[200], BRAND.red[300], BRAND.red[400], BRAND.red[500], BRAND.red[700], BRAND.red[900]],
    [BRAND.blue[100], BRAND.blue[200], BRAND.blue[300], BRAND.blue[500], BRAND.blue[800], BRAND.blue[900]],
  ],
  paint: (d) => {
    const row = ROW[d.stem]
    if (d.kind === 'ghost') return { row, t: 0, alpha: 0.4 }
    if (d.kind === 'base') return { row, t: 0.15 + 0.45 * d.lv }
    return { row, t: d.red ? 1 : 0.45 + 0.45 * d.lv, size: d.red ? 1.1 : 1 }
  },
  streak: (stem) => BRAND[HUE[stem]][200],
}
