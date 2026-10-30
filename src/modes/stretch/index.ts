import type { ModeDefinition, ModeInstance } from '../types'
import { writeGlyph } from '../shared/glyphs'
import { partOfGlyphs } from '../shared/parts'
import { MULTI_RAMPS, PART_CODE, type StretchAxis } from '../../engine/stretchFx'
import { BAND_COUNT } from '../../audio/features'
import { stretchPresets } from './presets'

// Type stretched into bars whose colour is the music's recent past. Each
// glyph (or word / line) emits a 0..1 value every frame from its band, the
// overall level and onset hits; StretchFx moves that history outward along
// the axis, so beats travel down the bars as pulses of colour.

/**
 * Emission 0 -> 1 colour ramps (four evenly spaced stops). Google brand: each
 * ramp stays inside one hue (1200 -> 800 -> 500 -> 50), never mixing bases.
 */
export const ramps: Record<string, string[]> = {
  'google-blue': ['#0f173a', '#2051da', '#3186ff', '#bbe2ff'],
  'google-red': ['#3c0202', '#be1c1b', '#fc413d', '#ffdeec'],
  'google-yellow': ['#652000', '#e57e00', '#fec700', '#fdfd6d'],
  'google-green': ['#002220', '#008052', '#00af57', '#bff3b9'],
  'google-grey': ['#121317', '#2f3034', '#45474d', '#e6eaf0'],
  // For light pages: blue 20 -> 200 -> 500 -> 1000.
  'google-blue-light': ['#dcf1ff', '#76bbff', '#3186ff', '#192967'],
}

/** Ramps letters choose between when colouring by glyph / word / line. */
const MULTI_GOOGLE = [ramps['google-blue'], ramps['google-red'], ramps['google-yellow'], ramps['google-green']]

const params = {
  ramp: { type: 'select', value: 'google-blue', options: Object.fromEntries(Object.keys(ramps).map((k) => [k, k])) },
  axis: { type: 'select', value: 'horizontal', options: { Horizontal: 'horizontal', Vertical: 'vertical', Radial: 'radial' } },
  sided: { type: 'select', value: 'forward', options: { Forward: 'forward', Reverse: 'reverse', Both: 'both' } },
  grouping: { type: 'select', value: 'line', options: { Glyph: 'glyph', Word: 'word', Line: 'line' } },
  trigger: {
    type: 'select', value: 'hits',
    options: { 'Hit letters only': 'hits', 'Always (all letters)': 'always' },
  },
  colourBy: {
    type: 'select', value: 'ramp', label: 'colour by',
    options: { 'Single ramp': 'ramp', 'Cycle Google': 'cycle', 'Random Google': 'random' },
  },

  speed: { type: 'number', value: 900, min: 0, max: 4000, step: 10, label: 'speed (px/s)' },
  audioSpeed: { type: 'number', value: 600, min: 0, max: 4000, step: 10, label: 'audio speed' },
  trail: { type: 'number', value: 2.5, min: 0.05, max: 8, step: 0.05, label: 'trail (s)' },
  spread: { type: 'number', value: 0.4, min: 0, max: 4, step: 0.05, label: 'spread (px)' },
  smear: { type: 'number', value: 3, min: 0, max: 20, step: 0.1, label: 'smear (px)' },

  base: { type: 'number', value: 0.12, min: 0, max: 1, step: 0.01, label: 'base colour' },
  bands: { type: 'number', value: 0.6, min: 0, max: 1, step: 0.01, label: 'band response' },
  hits: { type: 'number', value: 0.9, min: 0, max: 1, step: 0.01, label: 'onset hits' },
  density: { type: 'number', value: 0.5, min: 0, max: 1, step: 0.01, label: 'onset density' },
  sustain: { type: 'number', value: 0.35, min: 0, max: 1, step: 0.01, label: 'band sustain' },
  release: { type: 'number', value: 0.35, min: 0.02, max: 3, step: 0.01 },
  gamma: { type: 'number', value: 1, min: 0.3, max: 3, step: 0.01 },

  letters: {
    type: 'select', value: 'hit',
    options: { 'Hit → ramp': 'hit', Solid: 'solid', 'Colour ramp': 'ramp', 'In the trail\'s colour': 'trail', Hidden: 'hidden' },
  },
  letterColor: { type: 'color', value: '#6d6d70', label: 'letter colour' },
  grain: { type: 'number', value: 0.06, min: 0, max: 0.3, step: 0.005 },
} as const

const groups = {
  Look: ['ramp', 'colourBy', 'axis', 'sided', 'grouping'],
  Motion: ['speed', 'audioSpeed', 'trail', 'spread', 'smear'],
  Trigger: ['trigger', 'density', 'sustain', 'release'],
  Colour: ['base', 'bands', 'hits', 'gamma'],
  Letters: ['letters', 'letterColor', 'grain'],
}

interface Unit {
  /** Onset envelope. */
  hit: number
  /** Which Google ramp this unit uses when colouring by unit (0..MULTI_RAMPS-1). */
  hue: number
  band: number
  /** The instrument its letters are given to on the stage (LAYERS index), or -1: it plays with it, in its colour. */
  part: number
}

function create(): ModeInstance {
  let units: Unit[] = []
  let unitOf = new Int32Array(0)
  let key = ''
  let look = ''

  return {
    update({ audio, text, base, params: p, layers, dt, background, parts }) {
      const k = `${text.glyphs.length}:${text.wordCount}:${text.lines.length}:${p.grouping}:${parts.key}`
      if (k !== key) {
        key = k
        const count = p.grouping === 'word' ? text.wordCount : p.grouping === 'line' ? text.lines.length : text.glyphs.length
        // Spread bands across units so neighbouring rows pulse differently.
        units = Array.from({ length: count }, (_, i) => ({ hit: 0, band: (i * 3 + 1) % BAND_COUNT, hue: 0, part: -1 }))
        unitOf = new Int32Array(text.glyphs.length)
        for (const g of text.glyphs) unitOf[g.index] = p.grouping === 'word' ? g.word : p.grouping === 'line' ? g.line : g.index
        const members: number[][] = units.map(() => [])
        for (const g of text.glyphs) members[unitOf[g.index]]?.push(g.index)
        units.forEach((u, i) => (u.part = partOfGlyphs(parts, members[i])))
      }

      if (audio.onset && units.length) {
        const n = Math.ceil(units.length * p.density * (0.4 + 0.6 * audio.onsetStrength))
        for (let i = 0; i < n; i++) {
          const u = units[(Math.random() * units.length) | 0]
          // Units given to an instrument play with it instead (below).
          if (u.part >= 0) continue
          if (p.colourBy === 'random' && u.hit < 0.2) u.hue = (Math.random() * MULTI_RAMPS) | 0
          u.hit = Math.max(u.hit, 0.6 + 0.4 * audio.onsetStrength)
        }
      }
      const rel = Math.exp(-dt / p.release)
      for (const u of units) {
        u.hit *= rel
        if (u.part >= 0 && parts.hit[u.part] > 0) u.hit = Math.max(u.hit, 0.6 + 0.4 * parts.hit[u.part])
      }

      // Emission rides in the green channel of the glyph mask.
      for (const g of text.glyphs) {
        const u = units[unitOf[g.index]]
        // Given to an instrument: it sustains while the instrument sounds, in place of its band.
        const band = u.part >= 0 ? parts.drive[u.part] : audio.bands[u.band]
        const emission = Math.min(1, p.base + p.bands * band * band + p.hits * u.hit)
        // Only letters being hit feed the trail (Haze-style); band energy
        // above a threshold sustains them between beats.
        const activity =
          p.trigger === 'always' ? 1 : Math.min(1, u.hit * 1.4 + p.sustain * Math.max(0, (band - 0.65) / 0.35) * 2)
        // Blue channel carries the unit's hue (centre of its slot) for multi-ramp colouring.
        const ui = unitOf[g.index]
        const hue = p.colourBy === 'cycle' ? ui % MULTI_RAMPS : u.hue
        // (An instrument's letters take its ramp: see PART_CODE.)
        writeGlyph(layers.glyphs, g, base[g.index], { r: activity, g: emission, b: u.part >= 0 ? PART_CODE + u.part + 0.5 : (hue + 0.5) / MULTI_RAMPS, a: 1 })
      }

      const fx = layers.stretch
      fx.enabled = true
      // The Orchestra shares this effect; keep what it layers on top out of Stretch.
      fx.neutral()
      // A different look or different text: start the timeline clean.
      const nextLook = `${p.ramp}:${p.axis}:${p.sided}:${k}`
      if (nextLook !== look) {
        look = nextLook
        fx.reset()
      }
      fx.setAxis(p.axis as StretchAxis)
      if (p.sided === 'reverse') fx.axis.value.multiplyScalar(-1)
      fx.sided.value = p.sided === 'both' ? 1 : 0
      fx.step.value = (p.speed + p.audioSpeed * audio.level) * dt
      // `trail` is the time for a trail to fade to ~5% (three time constants).
      fx.keep.value = Math.exp((-3 * dt) / p.trail)
      fx.spread.value = p.spread
      fx.smear.value = p.smear
      fx.setRamp(ramps[p.ramp] ?? ramps['google-blue'])
      fx.multi.value = p.colourBy === 'ramp' ? 0 : 1
      fx.setMultiRamps(MULTI_GOOGLE)
      fx.gamma.value = p.gamma
      fx.background.value.set(background)
      fx.letterMode.value = { hidden: 0, solid: 1, ramp: 2, hit: 3, trail: 4 }[p.letters as string] ?? 3
      fx.letterColor.value.set(p.letterColor)
      fx.grain.value = p.grain
    },
  }
}

export const stretch: ModeDefinition = { id: 'stretch', label: 'Stretch', params, groups, presets: stretchPresets, create }
