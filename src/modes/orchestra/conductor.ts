import { LAYERS, listenerSens, type Layer, type LayerFrame } from '../../audio/analysis/listener'
import type { AudioFeatures } from '../../audio/features'
import type { Placement } from '../../layout/types'
import type { ShapedGlyph, ShapedText } from '../../text/shaping'
import { layerIndex } from './layers'
import { Stage, type StageName } from './stage'
import { manualKeys } from './keys'
import { remap } from '../shared/remap'

// Turns the layers the listener hears into the orchestra's behaviour, the
// same way every time so it can be followed:
//
//   hats    each hit (on the song's own pattern) lights its step of the bar
//           and flutters quickly over the next few letters
//   kick    its step on its letters, and a ripple round the middle
//   snare   its step, and a quick, thin ripple
//   bass    a slow wide ripple on each note; held, the field rushes (zooming
//           into the stream)
//   lead    keys: each pitch always the same letter, lit while it sounds
//   pad     keys: chord notes hold, swell in and fade out
//   fx      streams arriving from the side the sound sits on (high = top,
//           low = bottom; sweeping up comes from the left, down from the right)
//
// Long synths and build-ups bring streams in from all round the frame, all
// into the same point. When most layers play at once (a peak) the piece
// turns `unison`: streams pour in from everywhere, every note orbits the
// point together, trails last longer and fill the frame.

/** What the rack shows each frame. */
export const rackFeed = {
  active: false,
  /** 0..15 step of the bar now playing. */
  step: 0,
  parts: Object.fromEntries(
    LAYERS.map((l) => [l, { level: 0, passed: new Float32Array(16), blocked: new Float32Array(16) }]),
  ) as Record<Layer, { level: number; passed: Float32Array; blocked: Float32Array }>,
  stage: 'Intro' as StageName,
  /** Skip the music to the start of a stage (set by the conductor; no-op until the music is known). */
  jump: (_name: StageName) => {},
  next: null as StageName | null,
  barsToNext: 0,
  energy: 0,
  anticipation: 0,
  unison: 0,
}


/** MIDI range spread across a keyed layer's letters (fixed, so a note is always the same letter). */
const KEYS: Partial<Record<Layer, [number, number]>> = { bass: [28, 52], lead: [60, 96], pad: [48, 84] }
/** How fast a lit letter fades, s. */
const FADE: Record<Layer, number> = { kick: 0.28, snare: 0.22, hat: 0.12, bass: 0.4, lead: 0.2, pad: 0.6, fx: 0.5 }

function keyIndex(count: number, midi: number, [lo, hi]: [number, number]) {
  while (midi < lo) midi += 12
  while (midi > hi) midi -= 12
  return Math.max(0, Math.min(count - 1, Math.round(((midi - lo) / (hi - lo)) * (count - 1))))
}

/** How the conductor moves the music (set once by the app: the audio engine's seek). */
let seekMusic: (step: number) => void = () => {}
export function setSeek(fn: (step: number) => void) {
  seekMusic = fn
}

export class Conductor {
  readonly stage = new Stage()
  /** Per glyph: how lit (0..1) and which layer lit it (index into LAYERS). */
  light = new Float32Array(0)
  layer = new Float32Array(0)
  unison = 0
  /** 0..1 held low end after its gate: drives the rush into the point. */
  rush = 0
  ambience = 0
  swirlPhase = 0
  swirlAngle = 0

  private strike = new Float32Array(0)
  private strikeLayer = new Int8Array(0)
  private key = new Float32Array(0)
  private keyLayer = new Int8Array(0)
  /** Seconds each letter's key has been held (a long note swells). */
  private hold = new Float32Array(0)
  /** Hits waiting their turn (a flutter, a sweep across the block); hats unless another layer is given. */
  private pending: { glyphs: ShapedGlyph[]; at: number; strength: number; layer?: Layer }[] = []
  /** Per glyph: a quick flutter (hats), 0..1, decaying fast. */
  jolt = new Float32Array(0)
  private time = 0
  /** The step of the bar last frame (whole steps), so notes placed on the rack play as each step begins. */
  private lastStep: number | null = null

  /** Carry every letter's state across an edit of the text (see remap). */
  remapLetters(from: Int32Array) {
    this.light = remap(this.light, from)
    this.layer = remap(this.layer, from)
    this.strike = remap(this.strike, from)
    this.strikeLayer = remap(this.strikeLayer, from)
    this.key = remap(this.key, from)
    this.keyLayer = remap(this.keyLayer, from)
    this.jolt = remap(this.jolt, from)
    this.hold = remap(this.hold, from)
  }

  reset() {
    this.strike.fill(0)
    this.key.fill(0)
    this.pending.length = 0
  }

  update(
    audio: AudioFeatures, text: ShapedText, base: Placement[], p: Record<string, any>, dt: number,
    parts: Record<Layer, ShapedGlyph[]>,
  ) {
    this.time += dt
    const n = text.glyphs.length
    if (this.light.length !== n) {
      this.light = new Float32Array(n)
      this.layer = new Float32Array(n)
      this.strike = new Float32Array(n)
      this.strikeLayer = new Int8Array(n)
      this.key = new Float32Array(n)
      this.keyLayer = new Int8Array(n)
      this.jolt = new Float32Array(n)
      this.hold = new Float32Array(n)
    }
    const lf: LayerFrame = audio.layers
    this.stage.update(audio, dt)
    // The step of the bar a sound landed on: when it really started (the
    // listener confirms some hits a little later), less ~30 ms of analysis.
    const stepAt = (ago: number) => (((Math.round(audio.beat.position - ((ago + 0.03) * audio.beat.bpm) / 15) % 16) + 16) % 16)
    const step = stepAt(0)
    // Sensitivity moves the listener's own thresholds; here it only scales how loud a layer reads.
    // Layers switched off on the rack play nothing.
    const on = (l: Layer) => p[`${l}On`] !== false
    const sens = (l: Layer) => p[`${l}Sens`] * p.sensitivity
    for (const l of LAYERS) listenerSens[l] = sens(l)
    const gate = (l: Layer) => p[`${l}Gate`]
    const level = (l: Layer) => {
      const v = Math.min(1, lf.level[l] * sens(l))
      return Math.max(0, (v - gate(l)) / Math.max(0.05, 1 - gate(l)))
    }
    const light = (glyphs: ShapedGlyph[], l: Layer, s: number) => {
      for (const g of glyphs) {
        if (s >= this.strike[g.index]) this.strikeLayer[g.index] = layerIndex(l)
        this.strike[g.index] = Math.max(this.strike[g.index], s)
      }
    }
    /** The letters a step of the bar covers on a layer's line (every letter belongs to some step). */
    const segment = (glyphs: ShapedGlyph[], s: number) => {
      const a = Math.floor((s / 16) * glyphs.length)
      const b = Math.max(a + 1, Math.floor(((s + 1) / 16) * glyphs.length))
      return glyphs.slice(a, b)
    }

    const decayRack = Math.exp(-dt / 2)
    for (const l of LAYERS) {
      const r = rackFeed.parts[l]
      for (let i = 0; i < 16; i++) {
        r.passed[i] *= decayRack
        r.blocked[i] *= decayRack
      }
    }

    // Whole block: the text as one instrument for every layer. Kick lights it all at once; a snare
    // cracks out from the middle; hats sweep every letter top to bottom; bass swells it all; a lead or
    // pad note picks its letter across the whole block by pitch; fx scatters.
    const block = !!p.wholeBlock
    const all = text.glyphs
    const blockHit = (l: Layer, s: number, pitch: number | null) => {
      if (!all.length) return
      const later = (g: ShapedGlyph, delay: number, strength: number) =>
        this.pending.push({ glyphs: [g], at: this.time + delay, strength, layer: l })
      switch (l) {
        case 'kick':
          light(all, l, s)
          break
        case 'snare': {
          let cx = 0
          let cy = 0
          for (const g of all) {
            cx += base[g.index].x
            cy += base[g.index].y
          }
          cx /= all.length
          cy /= all.length
          const far = Math.max(1, ...all.map((g) => Math.hypot(base[g.index].x - cx, base[g.index].y - cy)))
          for (const g of all) later(g, (Math.hypot(base[g.index].x - cx, base[g.index].y - cy) / far) * 0.09, s * 0.9)
          break
        }
        case 'hat':
          all.forEach((g, k) => later(g, (k / all.length) * 0.32, s * 0.75))
          break
        case 'bass':
          light(all, l, s * 0.65)
          break
        case 'lead':
        case 'pad': {
          const k = pitch !== null ? keyIndex(all.length, pitch, KEYS[l]!) : Math.floor(Math.random() * all.length)
          light([all[k]], l, s)
          if (l === 'pad') for (const j of [k - 1, k + 1]) if (all[j]) light([all[j]], l, s * 0.6)
          break
        }
        case 'fx':
          for (const g of all) if (Math.random() < 0.25) light([g], l, s * 0.6)
          break
      }
    }
    for (const h of lf.hits) {
      const l = h.layer
      if (!on(l)) continue
      const s = Math.min(1, h.strength)
      const step = stepAt(h.ago)
      if (s < gate(l)) {
        rackFeed.parts[l].blocked[step] = 1
        continue
      }
      rackFeed.parts[l].passed[step] = 1
      if (block) {
        blockHit(l, s, h.pitch)
        continue
      }
      const glyphs = parts[l]
      switch (l) {
        case 'hat': {
          // Its own step, then a quick flutter over the next few letters.
          const first = segment(glyphs, step)
          light(first, l, s)
          for (const g of first) this.jolt[g.index] = Math.max(this.jolt[g.index], s)
          const from = glyphs.indexOf(first[first.length - 1])
          for (let k = 1; k <= 3; k++) {
            const g = glyphs[from + k]
            if (g) this.pending.push({ glyphs: [g], at: this.time + k * 0.025, strength: s * (1 - k * 0.22) })
          }
          break
        }
        case 'kick':
        case 'snare':
          light(segment(glyphs, step), l, s)
          break
        // Bass, lead and pad light their keys' letters while they're held, and fx its own (below).
      }
    }
    // Notes placed by hand on the rack: each plays as its step begins, as a heard hit on that step would
    // (unless one was heard there just now). A slow frame catches up on up to a bar of steps; a jump
    // further (a seek, a loop back to the start) plays nothing.
    const whole = Math.floor(audio.beat.position)
    if (this.lastStep !== null && whole - this.lastStep > 0 && whole - this.lastStep <= 16) {
      for (let at = this.lastStep + 1; at <= whole; at++) {
        const st = ((at % 16) + 16) % 16
        for (const l of LAYERS) {
          if (!on(l) || (p[`${l}Steps`] as string | undefined)?.[st] !== '1') continue
          const r = rackFeed.parts[l]
          if (r.passed[st] > 0.95) continue
          r.passed[st] = 1
          if (block) {
            blockHit(l, 1, null)
            continue
          }
          const seg = segment(parts[l], st)
          light(seg, l, 1)
          if (l === 'hat' && seg.length) {
            for (const g of seg) this.jolt[g.index] = 1
            const from = parts.hat.indexOf(seg[seg.length - 1])
            for (let k = 1; k <= 3; k++) {
              const g = parts.hat[from + k]
              if (g) this.pending.push({ glyphs: [g], at: this.time + k * 0.025, strength: 1 - k * 0.22 })
            }
          }
        }
      }
    }
    this.lastStep = whole

    // Keyboard: each key pressed plays every matching letter as its own layer would.
    const owner = new Int8Array(n).fill(-1)
    for (const l of LAYERS) for (const g of parts[l]) owner[g.index] = layerIndex(l)
    const matching = (k: string) => text.glyphs.filter((g) => g.char.toLowerCase() === k && owner[g.index] >= 0)
    if (manualKeys.enabled) {
      for (const k of manualKeys.presses) {
        for (const g of matching(k)) {
          const l = LAYERS[owner[g.index]]
          if (!on(l)) continue
          rackFeed.parts[l].passed[step] = 1
          light([g], l, 1)
          if (l === 'hat') {
            this.jolt[g.index] = 1
            const row = parts.hat
            const at = row.indexOf(g)
            for (let k = 1; k <= 3; k++) if (row[at + k]) this.pending.push({ glyphs: [row[at + k]], at: this.time + k * 0.025, strength: 1 - k * 0.22 })
          }
        }
      }
    }
    manualKeys.presses.length = 0
    for (let i = this.pending.length - 1; i >= 0; i--) {
      const h = this.pending[i]
      if (h.at > this.time) continue
      light(h.glyphs, h.layer ?? 'hat', h.strength)
      if ((h.layer ?? 'hat') === 'hat') for (const g of h.glyphs) this.jolt[g.index] = Math.max(this.jolt[g.index], h.strength)
      this.pending.splice(i, 1)
    }

    // Keys: every held pitch lights its own letter; released keys fade.
    const held = new Float32Array(n)
    const heldLayer = new Int8Array(n)
    for (const l of ['pad', 'bass', 'lead'] as const) {
      const glyphs = block ? all : parts[l]
      // A key the listener says is held stays lit for as long as it sounds,
      // however quiet (a long bass note fading under the mix is still held).
      if (!glyphs.length || !on(l) || !lf.keys[l].length) continue
      const v = Math.max(level(l), 0.3)
      for (const midi of lf.keys[l]) {
        const g = glyphs[keyIndex(glyphs.length, midi, KEYS[l]!)]
        if (0.35 + 0.65 * v >= held[g.index]) {
          held[g.index] = 0.35 + 0.65 * v
          heldLayer[g.index] = layerIndex(l)
        }
      }
    }
    // Keys held on the keyboard hold their letters lit, like a held piano key.
    if (manualKeys.enabled) {
      for (const k of manualKeys.held) {
        for (const g of matching(k)) {
          if (!on(LAYERS[owner[g.index]])) continue
          held[g.index] = Math.max(held[g.index], 0.95)
          heldLayer[g.index] = owner[g.index]
        }
      }
    }
    // FX lights its own letters (if it has any) around where the sound sits.
    const fxGlyphs = block ? all : parts.fx
    const fxLevel = level('fx')
    if (fxGlyphs.length && fxLevel > 0 && on('fx')) {
      const c = lf.fx.place * (fxGlyphs.length - 1)
      fxGlyphs.forEach((g, i) => {
        const v = fxLevel * Math.exp(-((i - c) ** 2) / 8)
        if (v > held[g.index]) {
          held[g.index] = v
          heldLayer[g.index] = layerIndex('fx')
        }
      })
    }

    for (const g of text.glyphs) {
      const i = g.index
      this.strike[i] *= Math.exp(-dt / FADE[LAYERS[this.strikeLayer[i]] ?? 'kick'])
      this.jolt[i] *= Math.exp(-dt / 0.08)
      // A long note swells: held keys grow brighter (and pour harder) over ~1.5 s.
      this.hold[i] = held[i] > 0 ? this.hold[i] + dt : 0
      const target = held[i] > 0 ? Math.min(1, held[i] * (0.7 + 0.45 * Math.min(1, this.hold[i] / 1.5))) : 0
      if (target > this.key[i]) {
        this.key[i] += (target - this.key[i]) * (1 - Math.exp(-dt / 0.03))
        this.keyLayer[i] = heldLayer[i]
      } else this.key[i] *= Math.exp(-dt / FADE[LAYERS[this.keyLayer[i]] ?? 'pad'])
      const fromKey = this.key[i] > this.strike[i]
      this.light[i] = Math.max(this.key[i], this.strike[i])
      this.layer[i] = fromKey ? this.keyLayer[i] : this.strikeLayer[i]
    }

    // The whole piece. Unison: most layers at once, with the song's energy up.
    // `peakAt`: how many layers at once count as a peak.
    const together = Math.max(0, Math.min(1, (lf.density * LAYERS.length - (p.peakAt - 1.5)) / 2.5)) * Math.min(1, 0.4 + this.stage.energy)
    this.unison += (together - this.unison) * (1 - Math.exp(-dt / (together > this.unison ? 1.5 : 2.5)))
    const bass = level('bass')
    this.rush += (bass - this.rush) * (1 - Math.exp(-dt / 0.3))
    const synth = Math.max(level('pad'), bass)
    this.ambience += (Math.min(1, synth * 0.8 + level('fx') * 0.6) - this.ambience) * (1 - Math.exp(-dt / 2))

    const a = this.stage.anticipation

    this.swirlPhase += dt * (0.25 + 0.8 * this.ambience + 1.5 * a + 0.8 * this.unison)
    this.swirlAngle += dt * (0.1 * this.ambience + 0.6 * a + 0.3 * this.unison)


    rackFeed.active = true
    rackFeed.jump = (name) => {
      const bar = this.stage.findStart(name)
      if (bar === null) return
      // On a loop, land in the same pass the clock is in (it never wraps back).
      const loopSteps = audio.score?.loop ?? 0
      const pass = loopSteps ? Math.floor(audio.beat.position / loopSteps) : 0
      let target = pass * loopSteps + bar * 16
      if (loopSteps && target < audio.beat.position) target += loopSteps
      seekMusic(target)
      this.reset()
    }
    rackFeed.step = step
    for (const l of LAYERS) rackFeed.parts[l].level = level(l)
    rackFeed.stage = this.stage.name
    rackFeed.next = this.stage.next
    rackFeed.barsToNext = this.stage.barsToNext
    rackFeed.energy = this.stage.energy
    rackFeed.anticipation = a
    rackFeed.unison = this.unison
  }

}
