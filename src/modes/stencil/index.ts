import type { ParamSchema } from '../../app/params'
import { writeGlyph } from '../shared/glyphs'
import { sequencer } from '../sequencer'
import type { FrameContext, ModeDefinition, ModeInstance, ModePreset } from '../types'

// Stencil: the Sequencer's picture used as a stencil for the typed text.
// The sequencer plays as in its own tab (as set there, or any of its
// presets); fronts wipe across it in three steps:
//   pattern -> stencil   the picture is cut down to the letters (a faint
//                        ghost of it outside), still moving inside them
//   stencil -> text      the letters fill with ink
//   back                 on through to the full picture, or back the way it came
// Fronts are straight edges at any angle (or rings from the text), broken into
// lanes that arrive at staggered times like notes in a piano roll. The text
// and the picture under it can each be turned, scaled and moved.

/** Every look the Sequencer has (each sub-mode's presets), as `sub|preset`. */
const SUBS: [string, string][] = [['barcode', 'Barcode'], ['pulse', 'Pulse'], ['stretch', 'Stretch'], ['dots', 'Dots'], ['ledger', 'Ledger'], ['sq', 'SQ']]
export const LOOKS: Record<string, string> = { 'as in the Sequencer tab': 'tab' }
for (const [id, label] of SUBS) {
  for (const name of Object.keys(sequencer.presetsFor!({ style: id }))) LOOKS[`${label} · ${name}`] = `${id}|${name}`
}
const SEQ_DEFAULTS = Object.fromEntries(Object.entries(sequencer.params).map(([k, d]) => [k, d.value]))

/** The Sequencer's params for a look (its defaults under that preset). */
export function lookParams(look: string): Record<string, any> {
  const [id, name] = look.split('|')
  return { ...SEQ_DEFAULTS, ...(sequencer.presetsFor!({ style: id })[name]?.params ?? { style: id }) }
}

const params: ParamSchema = {
  look: { type: 'select', value: 'tab', label: 'pattern', options: LOOKS },
  scroll: { type: 'select', value: 'tab', label: 'pattern scroll', options: { 'as in the Sequencer tab': 'tab', Still: 'still', 'right → left': 'left', 'left → right': 'right', Up: 'up', Down: 'down' } },
  scrollSpeed: { type: 'number', value: 60, min: 0, max: 800, step: 1, label: 'scroll speed (px/s)' },
  patAngle: { type: 'number', value: 0, min: -180, max: 180, step: 1, label: 'turn pattern (°)' },
  patScale: { type: 'number', value: 1, min: 0.25, max: 4, step: 0.01, label: 'scale pattern' },
  patX: { type: 'number', value: 0, min: -1, max: 1, step: 0.005, label: 'move pattern x' },
  patY: { type: 'number', value: 0, min: -1, max: 1, step: 0.005, label: 'move pattern y' },

  textAngle: { type: 'number', value: 0, min: -180, max: 180, step: 1, label: 'turn text (°)' },
  textScale: { type: 'number', value: 1, min: 0.2, max: 4, step: 0.01, label: 'scale text' },
  textX: { type: 'number', value: 0, min: -1, max: 1, step: 0.005, label: 'move text x' },
  textY: { type: 'number', value: 0, min: -1, max: 1, step: 0.005, label: 'move text y' },
  weight: { type: 'number', value: 0, min: -4, max: 20, step: 0.1, label: 'letter weight (px)' },
  softness: { type: 'number', value: 0, min: 0, max: 30, step: 0.1, label: 'letter softness (px)' },

  drive: { type: 'select', value: 'bars', label: 'cycle by', options: { 'bars of the music': 'bars', seconds: 'time', 'hand (scrub)': 'manual' } },
  patternHold: { type: 'number', value: 2, min: 0, max: 16, step: 0.25, label: 'hold as pattern (bars / s)' },
  toStencil: { type: 'number', value: 1, min: 0.1, max: 16, step: 0.05, label: 'wipe to stencil (bars / s)' },
  stencilHold: { type: 'number', value: 2, min: 0, max: 16, step: 0.25, label: 'hold as stencil (bars / s)' },
  toText: { type: 'number', value: 1, min: 0.1, max: 16, step: 0.05, label: 'wipe to text (bars / s)' },
  textHold: { type: 'number', value: 2, min: 0, max: 16, step: 0.25, label: 'hold as text (bars / s)' },
  backTime: { type: 'number', value: 1, min: 0.1, max: 16, step: 0.05, label: 'wipe back (bars / s)' },
  back: { type: 'select', value: 'through', label: 'wipe back', options: { 'on through (same way)': 'through', 'reverse (retreat)': 'reverse' } },
  progress: { type: 'number', value: 0.5, min: 0, max: 2, step: 0.001, label: 'pattern → stencil → text', showIf: { key: 'drive', is: 'manual' } },

  direction: { type: 'select', value: 'line', label: 'front', options: { 'straight edge': 'line', 'rings from the text': 'radial' } },
  angle: { type: 'number', value: 180, min: -180, max: 180, step: 1, label: 'wipe angle (°, 0 = left → right)', showIf: { key: 'direction', is: 'line' } },
  soft: { type: 'number', value: 0.06, min: 0.005, max: 0.5, step: 0.005, label: 'front softness' },
  laneH: { type: 'number', value: 24, min: 0, max: 200, step: 1, label: 'lane height (px, 0 = one edge)' },
  stagger: { type: 'number', value: 0.3, min: 0, max: 0.9, step: 0.01, label: 'lanes arrive apart' },
  staggerLive: { type: 'number', value: 0.3, min: 0, max: 2, step: 0.01, label: 'lanes apart with loudness' },
  edge: { type: 'number', value: 0, min: 0, max: 1, step: 0.01, label: 'light on the front' },

  ghost: { type: 'number', value: 0.06, min: 0, max: 1, step: 0.01, label: 'pattern outside (stencil)' },
  ghostText: { type: 'number', value: 0, min: 0, max: 1, step: 0.01, label: 'pattern outside (text)' },
  fill: { type: 'number', value: 1, min: 0, max: 1, step: 0.01, label: 'letters fill with ink' },
}

const groups = {
  Pattern: ['look', 'scroll', 'scrollSpeed', 'patAngle', 'patScale', 'patX', 'patY'],
  Text: ['textAngle', 'textScale', 'textX', 'textY', 'weight', 'softness'],
  Cycle: ['drive', 'patternHold', 'toStencil', 'stencilHold', 'toText', 'textHold', 'backTime', 'back', 'progress'],
  Wipe: ['direction', 'angle', 'soft', 'laneH', 'stagger', 'staggerLive', 'edge'],
  Reveal: ['ghost', 'ghostText', 'fill'],
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v))
const smooth01 = (v: number) => { const t = clamp01(v); return t * t * (3 - 2 * t) }
const DEG = Math.PI / 180

function create(): ModeInstance {
  const inner = sequencer.create()
  let steps = 0
  let lastPos = NaN
  let still = 0
  let loud = 0
  let seqLook = ''
  let seqBase: Record<string, any> | null = null

  return {
    update(frame: FrameContext) {
      const { layers, viewport, params: p, text, base, audio, dt, time, ink } = frame
      const W = viewport.width, H = viewport.height
      const fx = layers.stencil

      // ---- The picture: the Sequencer, as set in its tab (with this tab's overrides).
      if (p.look !== seqLook) {
        seqLook = p.look
        seqBase = p.look === 'tab' ? null : lookParams(p.look)
      }
      const seq = { ...(seqBase ?? frame.modeParams.sequencer ?? {}) }
      if (p.scroll !== 'tab') { seq.scroll = p.scroll; seq.scrollSpeed = p.scrollSpeed }
      inner.update({ ...frame, params: seq })

      // ---- The letters, placed by the layout, then turned / scaled / moved as one.
      const n = text.glyphs.length
      let cx = 0, cy = 0, k = 0
      for (const g of text.glyphs) { const b = base[g.index]; if (b) { cx += b.x; cy += b.y; k++ } }
      if (k) { cx /= k; cy /= k }
      const ta = p.textAngle * DEG, ts = p.textScale
      const c = Math.cos(ta), s = Math.sin(ta)
      const ox = p.textX * W / 2, oy = p.textY * H / 2
      for (const g of text.glyphs) {
        const b = base[g.index]
        if (!b) continue
        const dx = (b.x - cx) * ts, dy = (b.y - cy) * ts
        writeGlyph(fx.glyphs, g, { x: cx + ox + dx * c - dy * s, y: cy + oy + dx * s + dy * c, rotation: b.rotation + ta, scale: b.scale * ts }, {
          r: 1, g: 1, b: 1, a: 1, bleed: p.weight, blur: p.softness,
        })
      }
      fx.glyphs.count = n

      // ---- The cycle (its own step clock: follows the music's, free-runs at 120 bpm when nothing plays).
      const pos = audio.beat.position
      if (pos !== lastPos && Number.isFinite(lastPos)) { steps += pos - lastPos; still = 0 } else {
        still += dt
        if (still > 0.25) steps += dt * 8
      }
      lastPos = pos
      const L = (v: number, min = 0) => Math.max(min, v)
      const a0 = L(p.patternHold), w1 = L(p.toStencil, 0.05), h1 = L(p.stencilHold), w2 = L(p.toText, 0.05), h2 = L(p.textHold), wb = L(p.backTime, 0.05)
      const total = a0 + w1 + h1 + w2 + h2 + wb
      let f1 = 0, f2 = 0, f3 = 0, cycle = 0
      if (p.drive === 'manual') {
        f1 = smooth01(p.progress)
        f2 = smooth01(p.progress - 1)
      } else {
        const t = p.drive === 'time' ? time : steps / 16
        cycle = Math.floor(t / total)
        let u = t - cycle * total
        const seg = (len: number) => { const v = u / len; u -= len; return v }
        const phases = [a0, w1, h1, w2, h2]
        const at = [0, 0, 0, 0, 0].map((_, i) => seg(phases[i]))
        f1 = smooth01(at[1]) * (at[1] >= 0 ? 1 : 0)
        f2 = smooth01(at[3]) * (at[3] >= 0 ? 1 : 0)
        const back = u >= 0 ? smooth01(u / wb) : 0
        if (back > 0) {
          if (p.back === 'reverse') {
            // Back the way it came: the ink retreats, then the stencil.
            f2 = 1 - smooth01(back * 2)
            f1 = 1 - smooth01(back * 2 - 1)
          } else f3 = back
        }
      }
      fx.enabled = true
      fx.front1.value = f1
      fx.front2.value = f2
      fx.front3.value = f3
      fx.seed.value = cycle % 97

      // ---- The fronts.
      loud += (audio.level - loud) * (1 - Math.exp(-dt / 0.3))
      fx.soft.value = p.soft
      fx.radial.value = p.direction === 'radial' ? 1 : 0
      fx.angle.value = p.angle * DEG
      fx.centre.value.set(p.direction === 'radial' ? cx + ox : 0, p.direction === 'radial' ? cy + oy : 0)
      fx.laneH.value = p.laneH
      fx.stagger.value = Math.min(0.9, p.stagger * (1 + p.staggerLive * loud))
      fx.edge.value = p.edge

      // ---- The picture under the letters, and how much shows.
      fx.patAngle.value = p.patAngle * DEG
      fx.patScale.value = p.patScale
      fx.patOffset.value.set(p.patX * W / 2, p.patY * H / 2)
      fx.ghost.value = p.ghost
      fx.ghostText.value = p.ghostText
      fx.fill.value = p.fill
      fx.ink.value.setRGB(ink[0], ink[1], ink[2])
    },
  }
}

const DARK = { background: '#000000', ink: '#f4f5f7' }
const LIGHT = { background: '#ffffff', ink: '#121317' }

const presets: Record<string, ModePreset> = {
  // The Sequencer as you left it; lanes of the picture wipe in right to left, cut down to the words, then ink.
  Default: { params: {} },
  // Stretch's lanes scrolling right to left; the words picked out of the bars lane by lane.
  'Piano roll · right to left': {
    params: { look: 'stretch|Default', scroll: 'left', scrollSpeed: 80, angle: 180, laneH: 22, stagger: 0.35, soft: 0.04, ghost: 0.05 },
    ...DARK, fontId: 'google-sans-flex',
  },
  // Barcode's colour fields playing inside the letters: one soft edge, no lanes.
  'Gradient fields': {
    params: { look: 'barcode|Fields', patScale: 2.4, angle: 0, laneH: 0, soft: 0.18, ghost: 0.1, stencilHold: 3, fill: 0.85 },
    ...LIGHT,
  },
  // The stencil stays: the music only ever plays inside the words.
  'Stencil only': {
    params: { look: 'barcode|Fields · soft', patScale: 2.4, fill: 0, angle: 0, laneH: 40, stagger: 0.2, ghost: 0.04, stencilHold: 4, textHold: 0 },
    ...LIGHT,
  },
  // Pulse's blooms (they open while the music plays), cut to the words from the top down, lanes of 32 px.
  'Pulse · top down': {
    params: { look: 'pulse|Default', patScale: 2.2, angle: -90, laneH: 32, stagger: 0.25, ghost: 0.08 },
    ...LIGHT,
  },
  // Dots, rings out from the words.
  'Dots · rings out': {
    params: { look: 'dots|Default', patScale: 2.2, direction: 'radial', laneH: 18, stagger: 0.2, soft: 0.1, ghost: 0.06, edge: 0.3 },
    ...LIGHT,
  },
  // SQ's printed marks, retreating the way they came.
  'SQ · retreat': {
    params: { look: 'sq|Default', angle: 0, laneH: 28, stagger: 0.4, back: 'reverse', ghost: 0.08 },
    ...LIGHT,
  },
  // The picture turned upright: lanes fall down through the words, the text on a slant.
  'Turned · falling lanes': {
    params: { look: 'stretch|Default', scroll: 'left', scrollSpeed: 70, patAngle: 90, patScale: 1.25, angle: -90, laneH: 16, stagger: 0.3, soft: 0.05, textAngle: -8, ghost: 0.05 },
    ...DARK, fontId: 'google-sans-flex',
  },
  // Quick: two wipes a bar each, the stencil barely held.
  Quick: {
    params: { patternHold: 1, toStencil: 0.5, stencilHold: 0.5, toText: 0.5, textHold: 2, backTime: 0.5 },
  },
}

export const stencil: ModeDefinition = {
  id: 'stencil',
  label: 'Sequencer Stencil',
  params,
  groups,
  presets,
  create,
}
