import type { FrameContext, ModeDefinition, ModeInstance } from '../types'
import { writeGlyph, writeHalo } from '../shared/glyphs'
import { partOfGlyphs } from '../shared/parts'
import { paletteOptions, paletteRGB, type RGB } from '../shared/palettes'
import { BAND_COUNT } from '../../audio/features'
import { HALO_ATLAS, atlasReachEm } from '../../text/atlas/sdfAtlas'
import type { FieldLook } from '../../engine/fieldFx'
import { ramps } from '../stretch'
import { pulsePresets } from './presets'

// Haze on a field. Hits work like Haze: random glyphs / words / lines blur
// and bleed into colour. Each hit also stamps its shape into the FieldFx
// feedback buffer, which swells every shape outward from its own body (no
// direction, no screen centre), blurring as it grows and fading as it goes.
// Pulses that reach each other stall and mix, so neighbouring hits merge into
// one soft shape. Onsets surge the swell; bass keeps it breathing.
//
// Ripple looks recolour the field by how far it has swelled: the music's
// recent emission (level + hits, as in Stretch) travels outward through every
// shape, so beats leave lighter rings moving away from the letters.

const params = {
  palette: { type: 'select', value: 'google', options: paletteOptions },
  grouping: { type: 'select', value: 'word', options: { Glyph: 'glyph', Word: 'word', Line: 'line' } },
  saturation: { type: 'number', value: 1, min: 0, max: 3, step: 0.01 },

  look: {
    type: 'select', value: 'tone',
    options: { Flat: 'flat', 'Tone ripples': 'tone', 'Gradient map': 'ramp', 'Cycle colours': 'cycle' },
  },
  ramp: { type: 'select', value: 'google-blue-light', options: Object.fromEntries(Object.keys(ramps).map((k) => [k, k])) },
  rippleSpeed: { type: 'number', value: 140, min: 0, max: 1500, step: 5, label: 'ripple speed (px/s)' },
  rippleBase: { type: 'number', value: 0.35, min: 0, max: 1, step: 0.01, label: 'base' },
  rippleLevel: { type: 'number', value: 0.4, min: 0, max: 1, step: 0.01, label: 'level response' },
  rippleHits: { type: 'number', value: 0.8, min: 0, max: 1, step: 0.01, label: 'hit pulses' },
  rings: { type: 'number', value: 0.2, min: 0, max: 1, step: 0.01 },
  wavelength: { type: 'number', value: 70, min: 10, max: 400, step: 1, label: 'ring spacing (px)' },
  lightness: { type: 'number', value: 0.85, min: 0, max: 1, step: 0.01 },
  depth: { type: 'number', value: 0.35, min: 0, max: 1, step: 0.01 },

  density: { type: 'number', value: 0.15, min: 0, max: 1, step: 0.01, label: 'onset density' },
  spectrum: { type: 'number', value: 0.2, min: 0, max: 1, step: 0.01, label: 'band response' },
  attack: { type: 'number', value: 0.04, min: 0.01, max: 0.6, step: 0.01 },
  release: { type: 'number', value: 0.35, min: 0.05, max: 4, step: 0.05 },

  inkSize: { type: 'number', value: 0.06, min: 0, max: 0.8, step: 0.01, label: 'ink size (em)' },
  inkStrength: { type: 'number', value: 0.6, min: 0.02, max: 1, step: 0.01, label: 'ink strength' },

  swell: { type: 'number', value: 22, min: 0, max: 400, step: 1, label: 'swell (px/s)' },
  pulse: { type: 'number', value: 150, min: 0, max: 1500, step: 5, label: 'onset pulse (px/s)' },
  pulseDecay: { type: 'number', value: 0.25, min: 0.03, max: 2, step: 0.01, label: 'pulse decay (s)' },
  thin: { type: 'number', value: 0.5, min: 0, max: 1, step: 0.01, label: 'thin as it grows' },
  bassSwell: { type: 'number', value: 1, min: 0, max: 6, step: 0.05, label: 'bass → swell' },
  wobble: { type: 'number', value: 12, min: 0, max: 200, step: 1, label: 'wobble (px/s)' },

  diffusion: { type: 'number', value: 2.4, min: 0, max: 6, step: 0.05, label: 'blur (px/frame)' },
  fade: { type: 'number', value: 1.8, min: 0.2, max: 12, step: 0.1, label: 'fade (s)' },
  fieldStrength: { type: 'number', value: 1.5, min: 0.3, max: 6, step: 0.05, label: 'strength' },
  opacity: { type: 'number', value: 0.85, min: 0, max: 1, step: 0.01 },
  grain: { type: 'number', value: 0.02, min: 0, max: 0.2, step: 0.005 },

  textFade: { type: 'number', value: 0.9, min: 0, max: 1, step: 0.01, label: 'text fade' },
  textBlur: { type: 'number', value: 5, min: 0, max: 12, step: 0.1, label: 'text blur (px)' },
} as const

const groups = {
  Look: ['palette', 'grouping', 'saturation'],
  Ripple: ['look', 'ramp', 'rippleSpeed', 'rippleBase', 'rippleLevel', 'rippleHits', 'rings', 'wavelength', 'lightness', 'depth'],
  Rhythm: ['density', 'spectrum', 'attack', 'release'],
  Pulse: ['swell', 'pulse', 'pulseDecay', 'thin', 'bassSwell', 'wobble'],
  Field: ['inkSize', 'inkStrength', 'diffusion', 'fade', 'fieldStrength', 'opacity', 'grain'],
  Text: ['textFade', 'textBlur'],
}

const LUMA: RGB = [0.2126, 0.7152, 0.0722]
const HALO_REACH_EM = atlasReachEm(HALO_ATLAS)

const rand = (a: number, b: number) => a + Math.random() * (b - a)
const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}
function saturate(c: RGB, s: number): RGB {
  const l = c[0] * LUMA[0] + c[1] * LUMA[1] + c[2] * LUMA[2]
  return [0, 1, 2].map((k) => Math.min(1, Math.max(0, l + (c[k] - l) * s))) as RGB
}

interface Unit {
  kick: number
  env: number
  color: number
  band: number
  threshold: number
  /** The instrument its letters are given to on the stage (LAYERS index), or -1: it plays with it, in its colour. */
  part: number
}

function create(): ModeInstance {
  let units: Unit[] = []
  let unitOf = new Int32Array(0)
  let key = ''
  let look = ''
  let surge = 0
  let hitPulse = 0

  function rebuild(f: FrameContext) {
    const g = f.params.grouping
    const count = g === 'word' ? f.text.wordCount : g === 'line' ? f.text.lines.length : f.text.glyphs.length
    unitOf = new Int32Array(f.text.glyphs.length)
    for (const gl of f.text.glyphs) unitOf[gl.index] = g === 'word' ? gl.word : g === 'line' ? gl.line : gl.index
    units = Array.from({ length: count }, (_, u) => ({
      kick: 0, env: 0, color: 0,
      band: Math.min(BAND_COUNT - 1, Math.floor((u / Math.max(1, count)) * BAND_COUNT)),
      threshold: rand(0.7, 0.98),
      part: -1,
    }))
    const members: number[][] = Array.from({ length: count }, () => [])
    for (const gl of f.text.glyphs) members[unitOf[gl.index]]?.push(gl.index)
    units.forEach((u, i) => (u.part = partOfGlyphs(f.parts, members[i])))
  }

  // Onsets hit random units, which blur into colour and ink the field in
  // their own shape.
  function hazeFrame(f: FrameContext, colours: RGB[], usable: number, unitPx: number) {
    const p = f.params
    const { audio, base, dt, layers, text } = f
    const fx = layers.field

    // --- Envelopes ------------------------------------------------------
    if (audio.onset && units.length) {
      const n = Math.ceil(units.length * p.density * (0.35 + 0.65 * audio.onsetStrength))
      for (let i = 0; i < n; i++) {
        const u = units[(Math.random() * units.length) | 0]
        // Units given to an instrument play with it instead (below).
        if (u.part >= 0) continue
        if (u.env < 0.3) u.color = (Math.random() * usable) | 0
        u.kick = Math.max(u.kick, 0.6 + 0.4 * audio.onsetStrength)
      }
      surge = Math.max(surge, audio.onsetStrength)
      hitPulse = Math.max(hitPulse, 0.6 + 0.4 * audio.onsetStrength)
    }
    const releaseK = Math.exp(-dt / p.release)
    const attackK = 1 - Math.exp(-dt / p.attack)
    const fallK = 1 - Math.exp(-dt / 0.12)
    for (const u of units) {
      u.kick *= releaseK
      // Given to an instrument: struck with it, held while it sounds.
      if (u.part >= 0 && f.parts.hit[u.part] > 0) u.kick = Math.max(u.kick, 0.6 + 0.4 * f.parts.hit[u.part])
      const spectral = u.part >= 0 ? f.parts.drive[u.part] * 0.8 : Math.max(0, (audio.bands[u.band] - u.threshold) / (1 - u.threshold)) * p.spectrum
      const target = Math.min(1, Math.max(u.kick, spectral))
      if (u.part < 0 && spectral > 0.2 && u.env < 0.05) u.color = (Math.random() * usable) | 0
      u.env += (target - u.env) * (target > u.env ? attackK : fallK)
    }

    // --- Text + ink -----------------------------------------------------
    // Hit letters blur and take on their colour while stamping the same
    // colour, in their own shape, into the field; the field does the rest.
    const [ir, ig, ib] = f.ink
    const offset = Math.min(HALO_REACH_EM * unitPx * 0.8, p.inkSize * unitPx)
    for (const g of text.glyphs) {
      const u = units[unitOf[g.index]]
      const e = smooth(0.05, 0.5, u.env)
      const c = u.part >= 0 ? saturate(f.parts.rgb[u.part], p.saturation) : colours[u.color % colours.length]
      writeGlyph(layers.glyphs, g, base[g.index], {
        blur: e * p.textBlur,
        r: ir + (c[0] - ir) * e, g: ig + (c[1] - ig) * e, b: ib + (c[2] - ib) * e,
        a: 1 - e * p.textFade,
      })
      if (e > 0.01) {
        writeHalo(fx.inject, g, base[g.index], {
          bleed: offset, blur: unitPx * 0.03, outward: 1,
          r: c[0], g: c[1], b: c[2], a: e * p.inkStrength,
        })
      }
    }
  }

  // Dev-only: trigger units by hand from the console (window.__pulse.hit([3, 7])).
  if (import.meta.env.DEV) {
    Object.assign(window, {
      __pulse: {
        hit(indices: number[], strength = 1) {
          for (const i of indices) {
            const u = units[i]
            if (!u) continue
            u.color = (Math.random() * 4) | 0
            u.kick = strength
          }
          surge = Math.max(surge, strength)
        },
      },
    })
  }

  return {
    update(f) {
      const p = f.params
      const { audio, text, base, dt, layers } = f
      const k = `${text.glyphs.length}:${text.wordCount}:${text.lines.length}:${p.grouping}:${f.parts.key}`
      if (k !== key) {
        key = k
        rebuild(f)
      }
      const pal = paletteRGB(p.palette)
      const usable = Math.max(1, pal.length - 1)
      const colours = pal.slice(0, usable).map((c) => saturate(c, p.saturation))

      const fx = layers.field
      const unitPx = text.fontSize * (base.length ? base[0].scale : 1)
      hazeFrame(f, colours, usable, unitPx)
      surge *= Math.exp(-dt / p.pulseDecay)
      hitPulse *= Math.exp(-dt / 0.15)

      // --- Field ------------------------------------------------------------
      fx.enabled = true
      const nextLook = `${k}:${p.palette}`
      if (nextLook !== look) {
        look = nextLook
        fx.reset()
      }
      // No flow direction: only a slight curl wobble so edges aren't perfect.
      fx.flowSpeed.value = p.wobble
      fx.flowScale.value = Math.max(1, 2 * unitPx)
      fx.turbulence.value = 0.2
      fx.setDrift('none', 0)
      fx.expand.value = p.swell * (1 + p.bassSwell * (audio.sub + audio.low) * 0.5) + p.pulse * surge
      fx.expandReach.value = Math.max(3, unitPx * 0.12)
      // Thinning scales with how far edges move this frame, so faster pulses fade more.
      fx.expandKeep.value = Math.exp(-p.thin * fx.expand.value * dt * 0.02)
      fx.diffusion.value = p.diffusion
      // `fade`: seconds to fall to ~5% (three time constants).
      fx.keep.value = Math.exp((-3 * dt) / p.fade)
      fx.gain.value = p.fieldStrength
      fx.opacity.value = p.opacity
      fx.grain.value = p.grain

      // --- Ripples ----------------------------------------------------------
      fx.look = p.look as FieldLook
      fx.rippleSpeed = p.rippleSpeed
      fx.emit(p.rippleBase + p.rippleLevel * audio.level * audio.level + p.rippleHits * hitPulse, dt)
      fx.rings.value = p.rings
      fx.wavelength.value = p.wavelength
      fx.lightness.value = p.lightness
      fx.depth.value = p.depth
      const stops = ramps[p.ramp] ?? ramps['google-blue-light']
      fx.ramp.forEach((u, i) => u.value.set(stops[i]))
      // Cycle through the palette's first four colours (linear, saturated).
      fx.cycle.forEach((u, i) => u.value.setRGB(...colours[i % colours.length]))
    },
  }
}

export const pulse: ModeDefinition = { id: 'pulse', label: 'Pulse', params, groups, presets: pulsePresets, create }
