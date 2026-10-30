// Keyframes: a mode's settings captured at moments and played as motion. Each
// keyframe is the whole of the mode's settings; playing glides from one to the
// next over `seconds`, holds `hold`, and carries on (round in a loop, or back
// and forth). Numbers and colours blend; choices (selects, switches, text)
// change half way through a move. The panel keeps showing the settings as they
// were last set by hand: only the picture moves.

export interface KeyTrack {
  frames: Record<string, unknown>[]
  play: boolean
  /** Seconds each move takes, and each keyframe is held. */
  seconds: number
  hold: number
  order: 'loop' | 'bounce'
  ease: 'smooth' | 'linear'
}

export const newTrack = (): KeyTrack => ({ frames: [], play: false, seconds: 4, hold: 1, order: 'loop', ease: 'smooth' })

/** Every mode's keyframes, by mode id (saved with the scene). */
export const tracks: Record<string, KeyTrack> = {}

export const trackFor = (modeId: string) => (tracks[modeId] ??= newTrack())

/** Keyframes from a saved scene (anything malformed is dropped). */
export function loadTracks(saved: unknown) {
  for (const k of Object.keys(tracks)) delete tracks[k]
  if (!saved || typeof saved !== 'object') return
  for (const [id, t] of Object.entries(saved as Record<string, Partial<KeyTrack>>)) {
    if (!t || !Array.isArray(t.frames)) continue
    tracks[id] = {
      ...newTrack(),
      frames: t.frames.filter((f) => f && typeof f === 'object'),
      play: !!t.play,
      seconds: typeof t.seconds === 'number' ? t.seconds : 4,
      hold: typeof t.hold === 'number' ? t.hold : 1,
      order: t.order === 'bounce' ? 'bounce' : 'loop',
      ease: t.ease === 'linear' ? 'linear' : 'smooth',
    }
  }
}

let clock = 0
let playingFor = ''
/** Where the playing track is: keyframe index (fractional while moving), for the panel. */
export const playhead = { at: 0 }

const isHex = (v: unknown): v is string => typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v)
const mixHex = (a: string, b: string, t: number) => {
  const pa = parseInt(a.slice(1), 16), pb = parseInt(b.slice(1), 16)
  const ch = (s: number) => Math.round(((pa >> s) & 255) + (((pb >> s) & 255) - ((pa >> s) & 255)) * t)
  return `#${((ch(16) << 16) | (ch(8) << 8) | ch(0)).toString(16).padStart(6, '0')}`
}

/** The settings to draw this frame: `live` as set, or the keyframes' blend while they play. */
export function animate(modeId: string, live: Record<string, any>, dt: number): Record<string, any> {
  const tr = tracks[modeId]
  if (!tr?.play || tr.frames.length < 2) {
    playingFor = ''
    return live
  }
  if (playingFor !== modeId) { playingFor = modeId; clock = 0 }
  clock += dt
  const n = tr.frames.length
  const seg = Math.max(0.05, tr.seconds) + Math.max(0, tr.hold)
  // The sequence of keyframes visited: 0..n-1 then back to 0 (loop), or 0..n-1..1 (bounce).
  const path = tr.order === 'bounce' ? [...Array(n).keys(), ...Array.from({ length: n - 2 }, (_, i) => n - 2 - i)] : [...Array(n).keys()]
  const steps = path.length
  const u = (clock / seg) % steps
  const i = Math.floor(u)
  const into = (u - i) * seg - Math.max(0, tr.hold)
  let t = Math.min(1, Math.max(0, into / Math.max(0.05, tr.seconds)))
  if (tr.ease === 'smooth') t = t * t * (3 - 2 * t)
  const a = tr.frames[path[i]], b = tr.frames[path[(i + 1) % steps]]
  playhead.at = path[i] + (path[(i + 1) % steps] - path[i]) * t
  const out: Record<string, any> = { ...live }
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const va = a[k] ?? live[k], vb = b[k] ?? live[k]
    if (typeof va === 'number' && typeof vb === 'number') out[k] = va + (vb - va) * t
    else if (isHex(va) && isHex(vb)) out[k] = mixHex(va, vb, t)
    else out[k] = t < 0.5 ? va : vb
  }
  return out
}
