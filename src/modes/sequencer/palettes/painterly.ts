import { BRAND, hash, noise, type DotInfo, type DotPalette } from './types'

// Painterly: a squeegee abstract in dots. Low-frequency noise, long across the
// lanes and short down time (and warped, like a dragged blade), splits each
// system into slate-blue and teal fields with feathered, dithered edges; a
// second, narrow-and-tall layer plus per-lane drips lays acid yellow-green
// patches over them; accents and the hardest hits cut through in hot orange /
// red, with the odd near-white highlight. Ghosts stay pale; louder dots sit
// further down their ramp; a per-dot hash jitters tone, size and alpha.

const ROWS = {
  slate: [BRAND.grey[20], BRAND.blue[50], BRAND.blue[200], BRAND.blue[700], BRAND.blue[900], BRAND.blue[1100], BRAND.grey[1100]],
  teal: [BRAND.grey[20], BRAND.blue[20], BRAND.green[50], BRAND.green[700], BRAND.green[900], BRAND.green[1100], BRAND.blue[1200]],
  acid: [BRAND.yellow[10], BRAND.yellow[20], BRAND.yellow[50], BRAND.green[100], BRAND.green[200], BRAND.green[400], BRAND.green[800]],
  hot: [BRAND.red[50], BRAND.yellow[300], BRAND.yellow[700], BRAND.yellow[800], BRAND.yellow[900], BRAND.red[600], BRAND.red[800], BRAND.red[1000]],
}
const SLATE = 0, TEAL = 1, ACID = 2, HOT = 3

/** Field scale: cycles across a system's lanes, and per slot down time (small = long horizontal drags). */
const FIELD_X = 1.4, FIELD_Y = 0.07, WARP = 0.8
/** Dither width at a slate/teal edge. */
const FEATHER = 0.12
/** Acid patches: narrow across, tall down; threshold (higher = fewer); drip share of lanes and their rate. */
const ACID_X = 5, ACID_Y = 0.025, ACID_AT = 0.7, DRIP_LANES = 0.18, DRIP_Y = 0.04
/** Hot: share of strong events (lv > HOT_LV) that go hot, and stray flecks among base dots. */
const HOT_LV = 0.75, HOT_SHARE = 0.55, FLECK = 0.012
/** Near-white highlights among base dots. */
const HIGHLIGHT = 0.015
/** Per-dot tone jitter on t. */
const JITTER = 0.07

/** The cool/acid zone at slot g, lane l (deterministic, shared by dots and streaks). */
function zone(g: number, l: number, N: number): number {
  const x = (l / Math.max(1, N - 1)) * FIELD_X, y = g * FIELD_Y
  const warp = WARP * (noise(y * 0.5, x * 0.3, 3) - 0.5)
  const f = noise(x + warp, y, 1)
  const drip = hash(l, 17) < DRIP_LANES ? 0.35 * noise(0, g * DRIP_Y, 31 + l * 13) : 0
  if (noise(x * (ACID_X / FIELD_X), g * ACID_Y, 7) + drip > ACID_AT + 0.15) return ACID
  const edge = (f - 0.5) / FEATHER
  return edge + (hash(g, l, 5) - 0.5) * 2 > 0 ? TEAL : SLATE
}

export const painterly: DotPalette = {
  id: 'painterly',
  label: 'painterly',
  rows: [ROWS.slate, ROWS.teal, ROWS.acid, ROWS.hot],
  paint: (d: DotInfo) => {
    const h = hash(d.g, d.l), h2 = hash(d.l, d.g, 9)
    const jit = (h - 0.5) * 2 * JITTER
    const size = 0.88 + 0.22 * h2
    if (d.kind === 'ghost') return { row: zone(d.g, d.l, d.N), t: 0.06 + 0.08 * h, alpha: 0.55 + 0.25 * h2, size: 0.85 + 0.1 * h2 }
    if (d.red || (d.kind === 'event' && d.lv > HOT_LV && h < HOT_SHARE))
      return { row: HOT, t: 0.45 + 0.45 * d.lv + jit, size: Math.min(1.25, size + 0.12 * d.lv), alpha: 1 }
    if (d.kind === 'base' && h > 1 - FLECK) return { row: HOT, t: 0.3 + 0.3 * d.lv, size: 0.85 }
    if (d.kind === 'base' && h < HIGHLIGHT) return { row: SLATE, t: 0.01, size: 0.95 + 0.2 * h2, alpha: 1 }
    const row = zone(d.g, d.l, d.N)
    const t = d.kind === 'base' ? 0.18 + 0.42 * d.lv : 0.5 + 0.45 * d.lv
    return { row, t: t + jit, alpha: 0.82 + 0.18 * h2, size: Math.min(1.25, d.kind === 'event' ? size + 0.1 * d.lv : size) }
  },
  streak: (_stem, d) => {
    if (hash(d.g, d.l, 21) < 0.12) return ROWS.hot[3]
    const row = zone(d.g, d.l, d.N)
    return row === ACID ? ROWS.acid[4] : row === TEAL ? ROWS.teal[3] : ROWS.slate[2]
  },
}
