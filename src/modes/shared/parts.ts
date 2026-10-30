import { Color } from 'three/webgpu'
import { LAYERS, listenerSens } from '../../audio/analysis/listener'
import { rackFeed } from '../orchestra/conductor'
import type { AudioFeatures } from '../../audio/features'
import type { ShapedText } from '../../text/shaping'
import { parseAssign } from '../orchestra/layers'

// Letters given to instruments (picked on the stage, shared by every mode):
// which instrument each letter plays, how strongly each instrument sounds
// right now (a pulse on each hit, held while it rings), and its colour. Modes
// let assigned letters (or the words / lines most of their letters are given
// to) follow their instrument and take its colour; the rest behave as before.
// The Instruments rack works in every mode: a layer switched off plays
// nothing, its sensitivity and gate shape how it's heard, and notes placed on
// its steps play as hits. Outside the Orchestra (whose conductor does it), this
// also feeds the rack's meters and step lights.

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
  private lastStep: number | null = null
  private parts: LetterParts = {
    key: '', of: new Int8Array(0), drive: new Float32Array(LAYERS.length), hit: new Float32Array(LAYERS.length),
    rgb: LAYERS.map(() => [1, 1, 1] as [number, number, number]), any: false,
  }

  /** `rack`: the Orchestra's settings (the rack's); `feedRack`: drive its meters (when the Orchestra isn't). */
  update(audio: AudioFeatures, text: ShapedText, assign: string, colours: readonly string[], dt: number, rack: Record<string, any> = {}, feedRack = false): LetterParts {
    const p = this.parts
    if (assign !== p.key || p.of.length !== text.glyphs.length) {
      p.key = assign
      p.of = parseAssign(assign, text.glyphs.length)
      p.any = p.of.some((l) => l >= 0)
    }
    const lf = audio.layers
    const on = (i: number) => rack[`${LAYERS[i]}On`] !== false
    const sens = (i: number) => (rack[`${LAYERS[i]}Sens`] ?? 1) * (rack.sensitivity ?? 1)
    const gate = (i: number) => rack[`${LAYERS[i]}Gate`] ?? 0
    const stepAt = (ago: number) => (((Math.round(audio.beat.position - ((ago + 0.03) * audio.beat.bpm) / 15) % 16) + 16) % 16)
    if (feedRack) {
      LAYERS.forEach((l, i) => (listenerSens[l] = sens(i)))
      const decay = Math.exp(-dt / 2)
      for (const l of LAYERS) for (let k = 0; k < 16; k++) (rackFeed.parts[l].passed[k] *= decay), (rackFeed.parts[l].blocked[k] *= decay)
    }
    p.hit.fill(0)
    for (const h of lf.hits) {
      const l = LAYERS.indexOf(h.layer)
      if (l < 0 || !on(l)) continue
      const s = Math.min(1, h.strength * sens(l))
      if (feedRack) rackFeed.parts[h.layer][s < gate(l) ? 'blocked' : 'passed'][stepAt(h.ago)] = 1
      if (s >= gate(l)) p.hit[l] = Math.max(p.hit[l], s)
    }
    // Notes placed on the rack's steps: a full hit as their step begins (a seek or loop plays nothing).
    const whole = Math.floor(audio.beat.position)
    if (this.lastStep !== null && whole - this.lastStep > 0 && whole - this.lastStep <= 16) {
      for (let at = this.lastStep + 1; at <= whole; at++) {
        const st = ((at % 16) + 16) % 16
        LAYERS.forEach((l, i) => {
          if (!on(i) || (rack[`${l}Steps`] as string | undefined)?.[st] !== '1') return
          p.hit[i] = 1
          if (feedRack) rackFeed.parts[l].passed[st] = 1
        })
      }
    }
    this.lastStep = whole
    const fall = Math.exp(-dt / 0.25)
    LAYERS.forEach((l, i) => {
      this.env[i] = Math.max(this.env[i] * fall, p.hit[i])
      // A hit pulses; a held note (bass, pad, lead) keeps it lit while it sounds.
      const v = Math.min(1, lf.level[l] * sens(i))
      const level = on(i) ? Math.max(0, (v - gate(i)) / Math.max(0.05, 1 - gate(i))) : 0
      p.drive[i] = Math.min(1, Math.max(this.env[i], level * 0.85))
      if (feedRack) rackFeed.parts[l].level = level
      if (colours[i]) p.rgb[i] = hexRGB(colours[i])
    })
    if (feedRack) rackFeed.step = stepAt(0)
    return p
  }
}
