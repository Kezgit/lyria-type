import { Color } from 'three/webgpu'
import { LAYERS } from '../../audio/analysis/listener'
import type { AudioFeatures } from '../../audio/features'
import type { ShapedText } from '../../text/shaping'
import { parseAssign } from '../orchestra/layers'

// Letters given to instruments (picked on the stage, shared by every mode):
// which instrument each letter plays, how strongly each instrument sounds
// right now (a pulse on each hit, held while it rings), and its colour. Modes
// let assigned letters (or the words / lines most of their letters are given
// to) follow their instrument and take its colour; the rest behave as before.

export interface LetterParts {
  /** The assignment as text ("kick:0-4;lead:9"), e.g. for a mode's rebuild key. */
  key: string
  /** Per glyph: its instrument (LAYERS index), or -1. */
  of: Int8Array
  /** Per instrument: how strongly it is playing now, 0..1. */
  drive: Float32Array
  /** Per instrument: struck this frame, and how hard (0 = no). */
  hit: Float32Array
  /** Per instrument colour, linear 0..1 (as the modes' palettes). */
  rgb: [number, number, number][]
  /** Any letter assigned. */
  any: boolean
}

/** The instrument most of these letters are given to, or -1 when none is. */
export function partOfGlyphs(parts: LetterParts, glyphs: Iterable<number>): number {
  const count = new Float32Array(LAYERS.length)
  let best = -1
  for (const i of glyphs) {
    const l = parts.of[i] ?? -1
    if (l < 0) continue
    count[l]++
    if (best < 0 || count[l] > count[best]) best = l
  }
  return best
}

// Linear, like the modes' palette colours (three.js converts on set).
const scratch = new Color()
const hexRGB = (hex: string): [number, number, number] => {
  scratch.set(hex)
  return [scratch.r, scratch.g, scratch.b]
}

export class PartsTracker {
  private env = new Float32Array(LAYERS.length)
  private parts: LetterParts = {
    key: '', of: new Int8Array(0), drive: new Float32Array(LAYERS.length), hit: new Float32Array(LAYERS.length),
    rgb: LAYERS.map(() => [1, 1, 1] as [number, number, number]), any: false,
  }

  update(audio: AudioFeatures, text: ShapedText, assign: string, colours: readonly string[], dt: number): LetterParts {
    const p = this.parts
    if (assign !== p.key || p.of.length !== text.glyphs.length) {
      p.key = assign
      p.of = parseAssign(assign, text.glyphs.length)
      p.any = p.of.some((l) => l >= 0)
    }
    const lf = audio.layers
    p.hit.fill(0)
    for (const h of lf.hits) {
      const l = LAYERS.indexOf(h.layer)
      if (l >= 0) p.hit[l] = Math.max(p.hit[l], Math.min(1, h.strength))
    }
    const fall = Math.exp(-dt / 0.25)
    LAYERS.forEach((l, i) => {
      this.env[i] = Math.max(this.env[i] * fall, p.hit[i])
      // A hit pulses; a held note (bass, pad, lead) keeps it lit while it sounds.
      p.drive[i] = Math.min(1, Math.max(this.env[i], lf.level[l] * 0.85))
      if (colours[i]) p.rgb[i] = hexRGB(colours[i])
    })
    return p
  }
}
