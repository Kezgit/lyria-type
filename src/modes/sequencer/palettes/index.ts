import { accent } from './accent'
import { dusk } from './dusk'
import { painterly } from './painterly'
import { primary } from './primary'
import { register } from './register'
import { squeegee } from './squeegee'
import { timeline } from './timeline'
import { MAX_ROWS, type DotPalette } from './types'

/** Dot palette explorations, by id; each owns MAX_ROWS bar-layer rows from FIRST_ROW. */
export const PALETTES: DotPalette[] = [painterly, squeegee, dusk, register, timeline, accent, primary]
/** Past Barcode's rows and Dots' ruling row. */
const FIRST_ROW = 9
export const paletteRow = (i: number, row: number) => FIRST_ROW + i * MAX_ROWS + Math.min(MAX_ROWS - 1, row)
export const paletteOf = (id: string) => PALETTES.findIndex((p) => p.id === id)
