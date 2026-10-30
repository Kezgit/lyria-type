import type { Stem } from '../../../audio/features'

// Dot palettes: explorations of how Dots applies the Google palette. Each one
// lives in its own file, declares up to `MAX_ROWS` gradients (bar-layer rows,
// light -> dark) and paints every dot from where and what it is.

/** The brand palette, step -> hex (10 lightest .. 1200 darkest). */
export const BRAND = {
  blue: { 10: '#f4faff', 20: '#dcf1ff', 50: '#bbe2ff', 100: '#9dd2ff', 200: '#76bbff', 300: '#4fa0ff', 400: '#3c90ff', 500: '#3186ff', 600: '#3279f9', 700: '#336ef3', 800: '#2051da', 900: '#1f3b9b', 1000: '#192967', 1100: '#14204f', 1200: '#0f173a' },
  red: { 10: '#fff7f9', 20: '#ffeef7', 50: '#ffdeec', 100: '#ffacc2', 200: '#ff7985', 300: '#ff5a59', 400: '#ff4c45', 500: '#fc413d', 600: '#ed3733', 700: '#de2d29', 800: '#be1c1b', 900: '#990d0e', 1000: '#7d0304', 1100: '#5f0404', 1200: '#3c0202' },
  yellow: { 10: '#fefee1', 20: '#fcffad', 50: '#fdfd6d', 100: '#fff350', 200: '#ffe921', 300: '#ffdb0f', 400: '#ffcf03', 500: '#fec700', 600: '#ffbe00', 700: '#f6a100', 800: '#e57e00', 900: '#d05600', 1000: '#9e3d02', 1100: '#7a2b00', 1200: '#652000' },
  green: { 10: '#f6fff0', 20: '#daf9d4', 50: '#bff3b9', 100: '#9be69a', 200: '#60d673', 300: '#42c868', 400: '#0ebc5f', 500: '#00af57', 600: '#00a356', 700: '#009954', 800: '#008052', 900: '#00694e', 1000: '#005143', 1100: '#003936', 1200: '#002220' },
  grey: { 10: '#f8f9fc', 20: '#eff2f7', 50: '#e6eaf0', 800: '#45474d', 900: '#2f3034', 1000: '#212226', 1100: '#18191d', 1200: '#121317' },
} as const
export type BrandHue = keyof typeof BRAND

export const MAX_ROWS = 4

export interface DotInfo {
  /** ghost = silent grid point, base = the lane's loudness, event = an onset / hit. */
  kind: 'ghost' | 'base' | 'event'
  /** 0..1 within its kind. */
  lv: number
  stem: Stem
  /** Section index at this slot. */
  sec: number
  /** One of the strongest `accent` share of events. */
  red: boolean
  /** Slot (time, 0..T-1 down the systems) and lane (0..N-1 across). */
  g: number
  l: number
  T: number
  N: number
  /** Position on the page, -0.5..0.5 each (y up). */
  u: number
  v: number
  /** Lane position within its part, 0 (low) .. 1 (high). */
  within: number
  /** The mode's `offset` slider, 0..1 (free for a palette to reuse). */
  offset: number
}

export interface DotPaint {
  /** Index into the palette's own `rows`. */
  row: number
  /** Position along that gradient, 0..1. */
  t: number
  /** Multiplies the dot's alpha. */
  alpha?: number
  /** Multiplies the dot's radius. */
  size?: number
}

export interface DotPalette {
  id: string
  label: string
  /** Gradients, each 2+ hexes light -> dark; at most MAX_ROWS. */
  rows: string[][]
  paint(d: DotInfo): DotPaint
  /** Streak colour (hex) for a held note in `stem`'s lane at slot g; omit for the part's 200. */
  streak?(stem: Stem, d: { g: number; l: number; T: number; N: number; sec: number }): string
}

/** Small deterministic hash, 0..1. */
export const hash = (a: number, b: number, c = 0) => {
  const s = Math.sin(a * 127.1 + b * 311.7 + c * 74.7) * 43758.5453
  return s - Math.floor(s)
}
/** Smooth value noise, 0..1. */
export function noise(x: number, y: number, seed = 0) {
  const xi = Math.floor(x), yi = Math.floor(y)
  const xf = x - xi, yf = y - yi
  const sx = xf * xf * (3 - 2 * xf), sy = yf * yf * (3 - 2 * yf)
  const a = hash(xi, yi, seed), b = hash(xi + 1, yi, seed), c = hash(xi, yi + 1, seed), d = hash(xi + 1, yi + 1, seed)
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy
}
