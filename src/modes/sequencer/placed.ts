import type { Stem } from '../../audio/features'

// Marks placed by hand in the Manual sub-mode: the elements Dots is made of
// (dots, soft dots, ghosts, streaks, field blobs), each wherever it was put,
// in its own part of the music. They're kept as text in the mode's settings
// (`manual_marks`), so they save with presets and scenes. Positions and sizes
// are in frame heights from the frame's centre (y up), so a composition keeps
// its shape at any size; rotation is in degrees, clockwise as seen.

export type PlacedKind = 'dot' | 'soft' | 'ghost' | 'streak' | 'blob'

export interface Placed {
  k: PlacedKind
  s: Stem
  x: number
  y: number
  /** Full width and height. */
  w: number
  h: number
  /** Degrees, clockwise on screen. */
  r: number
  /** Resting weight, 0..1: how loud it reads when the music is quiet. */
  lv: number
}

export const KINDS: { id: PlacedKind; label: string; hint: string }[] = [
  { id: 'dot', label: 'Dot', hint: 'A hit: a strong dot that pops with its part' },
  { id: 'soft', label: 'Soft dot', hint: 'A lane’s loudness: a lighter dot that swells with its part' },
  { id: 'ghost', label: 'Ghost', hint: 'A silent grid point: the faintest dot' },
  { id: 'streak', label: 'Streak', hint: 'A held note: a soft streak in its part’s pale colour' },
  { id: 'blob', label: 'Blob', hint: 'A field: a big soft blob of its part’s colour' },
]

/** Size of a new element, frame heights (width, height), before it's dragged out. */
export const DEFAULT_SIZE: Record<PlacedKind, [number, number]> = {
  dot: [0.03, 0.03], soft: [0.022, 0.022], ghost: [0.012, 0.012], streak: [0.02, 0.12], blob: [0.16, 0.2],
}

const STEM_CODES: Stem[] = ['vocals', 'instruments', 'drums', 'bass']
const KIND_CODES: PlacedKind[] = ['dot', 'soft', 'ghost', 'streak', 'blob']
const r4 = (v: number) => Math.round(v * 10000) / 10000

/** As text: compact arrays, [kind, stem, x, y, w, h, r, lv]. */
export function encodePlaced(marks: Placed[]): string {
  return JSON.stringify(marks.map((m) => [KIND_CODES.indexOf(m.k), STEM_CODES.indexOf(m.s), r4(m.x), r4(m.y), r4(m.w), r4(m.h), Math.round(m.r * 10) / 10, r4(m.lv)]))
}

let lastText = ''
let lastMarks: Placed[] = []
/** From text (cached: the same text gives the same array). Anything malformed is dropped. */
export function decodePlaced(text: unknown): Placed[] {
  if (typeof text !== 'string' || !text) return []
  if (text === lastText) return lastMarks
  let out: Placed[] = []
  try {
    const raw = JSON.parse(text)
    if (Array.isArray(raw)) {
      out = raw
        .filter((a) => Array.isArray(a) && a.length >= 8 && a.every((v: unknown) => typeof v === 'number' && Number.isFinite(v)))
        .map(([k, s, x, y, w, h, r, lv]) => ({
          k: KIND_CODES[k] ?? 'dot', s: STEM_CODES[s] ?? 'vocals', x, y, w: Math.max(0.001, w), h: Math.max(0.001, h), r, lv: Math.min(1, Math.max(0, lv)),
        }))
    }
  } catch {}
  lastText = text
  lastMarks = out
  return out
}
