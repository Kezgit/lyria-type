import { Color } from 'three/webgpu'

// Named colour sets. The last entry of each is a dark (or bright) accent that
// Haze leaves out of its shapes.

export const palettes: Record<string, string[]> = {
  // Google brand primaries (blue, red, yellow, green 500 + purple gradient base), grey 1200 accent.
  google: ['#3186ff', '#fc413d', '#fec700', '#00af57', '#7372fe', '#121317'],
  // Same four hues at 200 (soft) and 800 (deep).
  'google-soft': ['#76bbff', '#ff7985', '#ffe921', '#60d673', '#121317'],
  'google-deep': ['#2051da', '#be1c1b', '#e57e00', '#008052', '#121317'],
  pastel: ['#eab3c6', '#c9b6ee', '#a7bccb', '#f1d2b4', '#84957f', '#9fb0a4', '#262626'],
  dusk: ['#f6b8a2', '#c9a7d9', '#8fa3c9', '#f2d49b', '#6d7f8c', '#e58f9e', '#1d1b2e'],
  sea: ['#bfe3e0', '#9cc7d6', '#d7ecd9', '#f1e7d0', '#5f8f8a', '#7fb7c9', '#13302f'],
  mono: ['#e6e6e6', '#d0d0d0', '#bdbdbd', '#a8a8a8', '#7a7a7a', '#929292', '#1a1a1a'],
  wash: ['#f7c6a3', '#f2a7b5', '#b9c6f0', '#a8d8c8', '#e9dca0', '#7d8fa6', '#3b3b4f'],
  opal: ['#ff9ec8', '#b49cff', '#7fd8f5', '#ffd88a', '#8ff0b8', '#7f94ff', '#2c2540'],
  ash: ['#d9d6d0', '#bfbab2', '#a19c96', '#8a8f94', '#c7c0b6', '#6b6763', '#1c1b1a'],
  ember: ['#ff9a62', '#ffcf6b', '#ff6f91', '#c77dff', '#6ec6ff', '#ffe8c2', '#ffffff'],
  ink: ['#2b3a67', '#8c3b2c', '#496a81', '#b08c5a', '#3f5e4d', '#6c4f77', '#0d0d12'],
}

// Optional gradient partner for each colour. The Google brand rules forbid
// pairing a gradient colour with a different base colour, so its two-tone
// gradients stay inside one hue's ramp (purple has no ramp: solid).
const gradientPartners: Record<string, string[]> = {
  google: ['#76bbff', '#ff7985', '#ffe921', '#60d673', '#7372fe', '#121317'], // 500 -> 200
  'google-soft': ['#bbe2ff', '#ffdeec', '#fdfd6d', '#bff3b9', '#121317'], // 200 -> 50
  'google-deep': ['#3186ff', '#fc413d', '#fec700', '#00af57', '#121317'], // 800 -> 500
}

export const paletteOptions = Object.fromEntries(Object.keys(palettes).map((k) => [k, k]))

export type RGB = [number, number, number]

const cache = new Map<string, RGB[]>()

function toRGB(key: string, hexes: string[]): RGB[] {
  let out = cache.get(key)
  if (!out) {
    const c = new Color()
    out = hexes.map((hex) => {
      c.set(hex)
      return [c.r, c.g, c.b] as RGB
    })
    cache.set(key, out)
  }
  return out
}

/** Palette as linear-space RGB triples. */
export function paletteRGB(name: string): RGB[] {
  return toRGB(name, palettes[name] ?? palettes.google)
}

/** Same-hue gradient partners for a palette, or null if any pairing is fine. */
export function gradientPartnersRGB(name: string): RGB[] | null {
  const hexes = gradientPartners[name]
  return hexes ? toRGB(`${name}:partners`, hexes) : null
}
