import { LAYERS, type Layer } from '../../audio/analysis/listener'
import type { ShapedGlyph, ShapedText } from '../../text/shaping'

// Which letters play which layer. Every letter belongs to exactly one layer,
// so its colour never changes mid-stream: assigned by hand (dragged over on
// the stage and given a layer) or by the default layout by line: hats on
// top, lead and pad below, kick (first half) and snare (second half) on the
// bottom line. Bass and fx play the field unless given letters.

export const LAYER_INFO: Record<Layer, { label: string; role: string }> = {
  kick: { label: 'Kick', role: 'its step on the line · a shockwave through the field' },
  snare: { label: 'Snare', role: 'its step on the line · a quick bright ring' },
  hat: { label: 'Hats', role: 'its step on the line · flutters along it' },
  bass: { label: 'Bass', role: 'a slow wave · held, it pulls you into the stream' },
  lead: { label: 'Lead', role: 'keys: each note its own letter, held while it sounds' },
  pad: { label: 'Pad', role: 'keys: chords hold, swell and fade' },
  fx: { label: 'FX', role: 'any other sound · streams in from where it sits' },
}

export const layerIndex = (l: Layer) => LAYERS.indexOf(l)

/** Layer colours, in LAYERS order: kick, snare, hats, bass, lead, pad, fx. */
export const PALETTES: Record<string, string[]> = {
  google: ['#fc413d', '#ff8a3d', '#fec700', '#8b5cff', '#3186ff', '#00af57', '#e6eaf0'],
  sunset: ['#ff3d6e', '#ff8a3d', '#ffd166', '#8f2d56', '#f72585', '#b5179e', '#ffe5ec'],
  ocean: ['#00b4d8', '#48cae4', '#caf0f8', '#3a0ca3', '#0077b6', '#2ec4b6', '#e0fbfc'],
  ember: ['#ff5400', '#ff8500', '#ffbd00', '#9d0208', '#ff006e', '#d00000', '#fff1e6'],
  mono: ['#ffffff', '#d4d4d4', '#f2f2f2', '#8c8c8c', '#e0e0e0', '#b3b3b3', '#ffffff'],
  // A spectrum like a sequencer's velocity colours: reds and oranges through yellow into greens, a magenta.
  spectrum: ['#f2372b', '#ff7b1c', '#ffc61f', '#c4407f', '#22b04b', '#8cc83c', '#f45d86'],
  // Spectrogram blues: indigo and violet with cyan highlights.
  candy: ['#4a2bff', '#7a4dff', '#5ed6ff', '#2b108f', '#3a8dff', '#9b7bff', '#c4f3ff'],
  // Soft pastels: lilac, sky, lemon and a deep green.
  pastel: ['#2f8f4e', '#5cc7ec', '#f6f07a', '#c9a3f2', '#8fdcf2', '#e0b8fa', '#f2f5b0'],
}

export const colourKey = (l: Layer) => `${l}Colour`

/**
 * Four-stop ramp around one colour, for the trails: quiet to loud. On a dark
 * page it climbs from dark to a near-white highlight; on a light page from a
 * pale tint to the colour at its deepest, so loud notes stay saturated on white.
 */
export function rampFor(hex: string, light = false): string[] {
  const n = parseInt(hex.slice(1), 16)
  const rgb = [(n >> 16) & 255, (n >> 8) & 255, n & 255]
  const out = (f: (c: number) => number) => '#' + rgb.map((c) => Math.round(Math.max(0, Math.min(255, f(c)))).toString(16).padStart(2, '0')).join('')
  if (light) return [out((c) => c + (255 - c) * 0.32), out((c) => c + (255 - c) * 0.06), out((c) => c), out((c) => c * 0.78)]
  return [out((c) => c * 0.16), out((c) => c * 0.6), out((c) => c), out((c) => c + (255 - c) * 0.72)]
}

/** Default layers per line, top to bottom. */
function byLine(lines: number): Layer[][] {
  if (lines <= 1) return [['hat', 'lead', 'pad', 'kick', 'snare']]
  if (lines === 2) return [['hat', 'lead'], ['pad', 'kick', 'snare']]
  if (lines === 3) return [['hat'], ['lead', 'pad'], ['kick', 'snare']]
  return Array.from({ length: lines }, (_, i) => (i === 0 ? ['hat'] : i === 1 ? ['lead'] : i === lines - 1 ? ['kick', 'snare'] : ['pad']))
}

/** "kick:0-4,9;lead:12-20" <-> per glyph layer index (-1 = default). */
export function parseAssign(s: string, n: number): Int8Array {
  const out = new Int8Array(n).fill(-1)
  for (const part of s.split(';')) {
    const [name, ranges] = part.split(':')
    const li = LAYERS.indexOf(name as Layer)
    if (li < 0 || !ranges) continue
    for (const r of ranges.split(',')) {
      const [a, b] = r.split('-').map(Number)
      for (let i = a; i <= (Number.isFinite(b) ? b : a); i++) if (i >= 0 && i < n) out[i] = li
    }
  }
  return out
}

export function encodeAssign(a: Int8Array): string {
  const parts: string[] = []
  LAYERS.forEach((name, li) => {
    const ranges: string[] = []
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== li) continue
      let j = i
      while (j + 1 < a.length && a[j + 1] === li) j++
      ranges.push(i === j ? `${i}` : `${i}-${j}`)
      i = j
    }
    if (ranges.length) parts.push(`${name}:${ranges.join(',')}`)
  })
  return parts.join(';')
}

/**
 * New lines take the next instrument in this cycle after the line above (fx is left out: on a light page
 * its near-white disappears), so every line added brings in another colour and all of them get heard.
 */
const LINE_CYCLE: Layer[] = ['kick', 'bass', 'pad', 'lead', 'hat', 'snare']

/** The letters each layer plays, in reading order; `owner` is each letter's one layer (LAYERS index). */
export function regions(text: ShapedText, assign: Int8Array): { parts: Record<Layer, ShapedGlyph[]>; owner: Int8Array } {
  const parts = Object.fromEntries(LAYERS.map((l) => [l, [] as ShapedGlyph[]])) as Record<Layer, ShapedGlyph[]>
  const owner = new Int8Array(text.glyphs.length).fill(-1)
  // The first three lines keep the default layout by line; past those (or once letters are given out),
  // a line with nothing given out plays the next instrument in the cycle after the line above.
  const anyGiven = text.glyphs.some((g) => (assign[g.index] ?? -1) >= 0)
  const lines = byLine(Math.min(3, text.lines.length))
  const lineLayer: (Layer | null)[] = text.lines.map(() => null)
  // Each line's place in the cycle (after the line above), for the letters on it nobody gave out.
  const cycled: (Layer | null)[] = text.lines.map(() => null)
  text.lines.forEach((line, li) => {
    if (li >= 3 || anyGiven) {
      const before = li > 0 ? lineLayer[li - 1] ?? lines[Math.min(li - 1, lines.length - 1)]?.slice(-1)[0] : null
      const at = before ? LINE_CYCLE.indexOf(before) : -1
      cycled[li] = LINE_CYCLE[(at + 1) % LINE_CYCLE.length]
    }
    const given = line.glyphs.map((g) => assign[g.index] ?? -1).filter((a) => a >= 0)
    if (given.length) {
      // The line's own (most of its letters'), so the next line carries on from it.
      const count = new Map<number, number>()
      for (const a of given) count.set(a, (count.get(a) ?? 0) + 1)
      lineLayer[li] = LAYERS[[...count.entries()].sort((x, y) => y[1] - x[1])[0][0]]
    } else lineLayer[li] = cycled[li]
  })
  for (const g of text.glyphs) {
    const a = assign[g.index] ?? -1
    let l: Layer | undefined
    if (a >= 0) l = LAYERS[a]
    else if (cycled[g.line]) l = cycled[g.line]!
    else {
      // A line shared by several layers is split between them, left to right.
      const shared = lines[g.line] ?? []
      const row = text.lines[g.line].glyphs
      const at = row.indexOf(g)
      l = shared[Math.min(shared.length - 1, Math.floor((at / Math.max(1, row.length)) * shared.length))]
    }
    if (!l) continue
    parts[l].push(g)
    owner[g.index] = LAYERS.indexOf(l)
  }
  return { parts, owner }
}
