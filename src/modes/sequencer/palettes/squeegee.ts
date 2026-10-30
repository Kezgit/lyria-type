import { BRAND, hash, noise, type DotInfo, type DotPalette } from './types'

// Squeegee: a hotter, bolder Richter. The page is dragged in wide horizontal
// bands down time (red, amber, yellow), each smeared across every lane with a
// hard, ragged edge where the blade stopped; per-lane runs break through to the
// band beneath, thin scraped strips of cool blue cut across, and the odd band
// is a near-black pull. Ghosts stay pale; louder dots sit further down their ramp.

const ROWS = {
  red: [BRAND.red[20], BRAND.red[100], BRAND.red[300], BRAND.red[500], BRAND.red[700], BRAND.red[900], BRAND.red[1100], BRAND.red[1200]],
  amber: [BRAND.yellow[20], BRAND.yellow[300], BRAND.yellow[600], BRAND.yellow[800], BRAND.yellow[900], BRAND.red[800], BRAND.yellow[1100], BRAND.yellow[1200]],
  yellow: [BRAND.yellow[10], BRAND.yellow[50], BRAND.yellow[200], BRAND.yellow[400], BRAND.yellow[600], BRAND.yellow[800], BRAND.yellow[1000], BRAND.yellow[1200]],
  blue: [BRAND.blue[20], BRAND.blue[200], BRAND.blue[500], BRAND.blue[800], BRAND.blue[900], BRAND.blue[1100], BRAND.blue[1200]],
}
const RED = 0, AMBER = 1, YELLOW = 2, BLUE = 3

/** Bands: mean width in slots, width wobble, ragged-edge skew across lanes (slots). */
const BAND = 14, BAND_WOBBLE = 0.9, SKEW = 3.5
/** Band hue shares (red, then amber, rest yellow) and the share of near-black pulls. */
const RED_SHARE = 0.42, AMBER_SHARE = 0.38, PULL = 0.08
/** Break-through runs to the band beneath: lane frequency, rate down time, threshold. */
const RUN_X = 0.45, RUN_Y = 0.18, RUN_AT = 0.74
/** Blue strips: width in slots, share of strip cells, and how scraped (gap threshold). */
const STRIP = 2, STRIP_SHARE = 0.11, SCRAPE = 0.38
/** Per-dot tone jitter on t. */
const JITTER = 0.06

/** Band id at slot g, lane l: the blade edge wobbles and skews across the lanes. */
function band(g: number, l: number, N: number): number {
  const x = l / Math.max(1, N - 1)
  const gg = g + SKEW * (noise(x * 3, g / BAND, 4) - 0.5) * 2
  return Math.floor(gg / BAND + BAND_WOBBLE * (noise(gg / (BAND * 3), 0, 2) - 0.5))
}
const hueOf = (b: number) => {
  const h = hash(b, 11)
  return h < RED_SHARE ? RED : h < RED_SHARE + AMBER_SHARE ? AMBER : YELLOW
}

/** Row and tone shift at slot g, lane l (shared by dots and streaks). */
function zone(g: number, l: number, N: number): { row: number; shift: number } {
  const cell = Math.floor((g + 0.37 * l / Math.max(1, N)) / STRIP)
  if (hash(cell, 41) < STRIP_SHARE && noise(l * 0.35, cell, 43) > SCRAPE) return { row: BLUE, shift: 0.1 * (hash(cell, 44) - 0.5) }
  let b = band(g, l, N)
  if (noise(l * RUN_X, g * RUN_Y, 17 + (b & 7)) > RUN_AT) b -= 1
  return { row: hueOf(b), shift: hash(b, 12) < PULL ? 0.4 : 0.14 * (hash(b, 13) - 0.5) }
}

export const squeegee: DotPalette = {
  id: 'squeegee',
  label: 'squeegee',
  rows: [ROWS.red, ROWS.amber, ROWS.yellow, ROWS.blue],
  paint: (d: DotInfo) => {
    const h = hash(d.g, d.l, 3), h2 = hash(d.l, d.g, 8)
    const jit = (h - 0.5) * 2 * JITTER
    const { row, shift } = zone(d.g, d.l, d.N)
    if (d.kind === 'ghost') return { row, t: 0.05 + 0.08 * h + 0.3 * Math.max(0, shift), alpha: 0.6 + 0.25 * h2, size: 0.85 + 0.1 * h2 }
    if (d.red) return { row: row === BLUE ? BLUE : RED, t: 0.7 + 0.25 * d.lv + jit, size: Math.min(1.3, 1 + 0.2 * d.lv), alpha: 1 }
    const t = (d.kind === 'base' ? 0.2 + 0.4 * d.lv : 0.55 + 0.4 * d.lv) + shift + jit
    return { row, t, alpha: 0.85 + 0.15 * h2, size: Math.min(1.25, 0.9 + 0.15 * h2 + (d.kind === 'event' ? 0.12 * d.lv : 0)) }
  },
  streak: (_stem, d) => {
    const { row, shift } = zone(d.g, d.l, d.N)
    const r = [ROWS.red, ROWS.amber, ROWS.yellow, ROWS.blue][row]!
    return r[shift > 0.3 ? r.length - 2 : 3]!
  },
}
