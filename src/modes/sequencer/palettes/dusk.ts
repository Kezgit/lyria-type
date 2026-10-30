import { BRAND, hash, noise, type DotInfo, type DotPalette } from './types'

// Dusk: a late-evening colour field. Three large, soft-edged fields stack up the
// page, deep indigo at the bottom through rose to pale yellow light at the top,
// their borders warped and dithered like brushed stain. Contrast stays low: each
// field holds a narrow tonal band and the music reads mostly as size and tone,
// with the strongest hits lit as a few luminous yellow points.

const ROWS = {
  indigo: [BRAND.blue[700], BRAND.blue[800], BRAND.blue[900], BRAND.blue[1000], BRAND.blue[1100], BRAND.blue[1200]],
  rose: [BRAND.red[20], BRAND.red[50], BRAND.red[100], BRAND.red[200], BRAND.red[300], BRAND.red[500]],
  light: [BRAND.yellow[10], BRAND.yellow[20], BRAND.red[20], BRAND.yellow[50], BRAND.yellow[100], BRAND.yellow[300]],
  glow: [BRAND.yellow[10], BRAND.yellow[50], BRAND.yellow[200], BRAND.yellow[400], BRAND.yellow[600], BRAND.yellow[800]],
}
const INDIGO = 0, ROSE = 1, LIGHT = 2, GLOW = 3

/** Field borders, as height up the page (0 bottom .. 1 top), their warp and dither width. */
const ROSE_AT = 0.42, LIGHT_AT = 0.74, WARP = 0.09, DITHER = 0.04
/** Slow tonal breathing within a field, and its scale. */
const BREATH = 0.12, BREATH_SCALE = 1.6
/** Luminous events: level above which a share of events glows. */
const GLOW_LV = 0.82, GLOW_SHARE = 0.4
/** Per-dot tone jitter on t. */
const JITTER = 0.04

/** Height up the page from slot and lane (time runs down), warped like a soft brushed edge. */
function height(g: number, l: number, T: number, N: number): number {
  const x = l / Math.max(1, N - 1), y = g / Math.max(1, T - 1)
  return 1 - y + WARP * (noise(x * 1.3, y * 2.2, 5) - 0.5) * 2
}
function field(g: number, l: number, T: number, N: number): number {
  const h = height(g, l, T, N) + (hash(g, l, 6) - 0.5) * 2 * DITHER
  return h < ROSE_AT ? INDIGO : h < LIGHT_AT ? ROSE : LIGHT
}

export const dusk: DotPalette = {
  id: 'dusk',
  label: 'dusk',
  rows: [ROWS.indigo, ROWS.rose, ROWS.light, ROWS.glow],
  paint: (d: DotInfo) => {
    const h = hash(d.g, d.l, 2), h2 = hash(d.l, d.g, 7)
    const row = field(d.g, d.l, d.T, d.N)
    const breath = BREATH * (noise((d.l / Math.max(1, d.N - 1)) * BREATH_SCALE, (d.g / Math.max(1, d.T - 1)) * BREATH_SCALE * 2, 9) - 0.5)
    const jit = (h - 0.5) * 2 * JITTER
    if (d.kind === 'ghost') return { row, t: 0.08 + breath + jit, alpha: 0.45 + 0.2 * h2, size: 0.8 + 0.1 * h2 }
    if (d.red || (d.kind === 'event' && d.lv > GLOW_LV && h < GLOW_SHARE))
      return { row: GLOW, t: 0.35 + 0.45 * d.lv + jit, alpha: 1, size: Math.min(1.35, 1.05 + 0.25 * d.lv) }
    const t = (d.kind === 'base' ? 0.2 + 0.25 * d.lv : 0.45 + 0.3 * d.lv) + breath + jit
    const size = d.kind === 'base' ? 0.72 + 0.35 * d.lv : 0.95 + 0.25 * d.lv
    return { row, t, alpha: 0.7 + 0.2 * d.lv + 0.1 * h2, size: Math.min(1.25, size * (0.94 + 0.12 * h2)) }
  },
  streak: (_stem, d) => {
    const row = field(d.g, d.l, d.T, d.N)
    return row === INDIGO ? ROWS.indigo[2]! : row === ROSE ? ROWS.rose[3]! : ROWS.light[4]!
  },
}
