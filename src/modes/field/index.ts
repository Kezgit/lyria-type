import type { FrameContext, ModeDefinition, ModeInstance } from '../types'
import { writeGlyph, writeHalo } from '../shared/glyphs'
import { partOfGlyphs } from '../shared/parts'
import { paletteOptions, paletteRGB, type RGB } from '../shared/palettes'
import { BAND_COUNT } from '../../audio/features'
import { HALO_ATLAS, atlasReachEm } from '../../text/atlas/sdfAtlas'
import type { FieldDrift } from '../../engine/fieldFx'
import { fieldPresets } from './presets'

// Haze meets Stretch: hit letters bleed their colour into a living field that
// keeps moving after them. The field (FieldFx) is a feedback buffer: every
// frame it is carried along a swirling flow, blurred so colours mix, and
// faded; letters keep injecting their shape in colour while they are hit.
// Bass speeds the flow up and onsets push a kick outward through it.

const params = {
  palette: { type: 'select', value: 'google', options: paletteOptions },
  grouping: { type: 'select', value: 'glyph', options: { Glyph: 'glyph', Word: 'word', Line: 'line' } },

  density: { type: 'number', value: 0.15, min: 0, max: 1, step: 0.01, label: 'onset density' },
  spectrum: { type: 'number', value: 0.25, min: 0, max: 1, step: 0.01, label: 'band response' },
  attack: { type: 'number', value: 0.05, min: 0.01, max: 0.6, step: 0.01 },
  release: { type: 'number', value: 0.6, min: 0.05, max: 4, step: 0.05 },

  inkSize: { type: 'number', value: 0.15, min: 0, max: 0.8, step: 0.01, label: 'ink size (em)' },
  inkStrength: { type: 'number', value: 0.35, min: 0.02, max: 1, step: 0.01, label: 'ink strength' },
  saturation: { type: 'number', value: 1, min: 0, max: 3, step: 0.01 },

  flow: { type: 'number', value: 70, min: 0, max: 600, step: 1, label: 'flow (px/s)' },
  eddy: { type: 'number', value: 3, min: 0.3, max: 20, step: 0.1, label: 'eddy size (em)' },
  turbulence: { type: 'number', value: 0.15, min: 0, max: 2, step: 0.01 },
  drift: { type: 'select', value: 'up', options: { None: 'none', Up: 'up', Down: 'down', Left: 'left', Right: 'right', Outward: 'outward' } },
  driftSpeed: { type: 'number', value: 25, min: 0, max: 600, step: 1, label: 'drift (px/s)' },
  bassFlow: { type: 'number', value: 1.5, min: 0, max: 6, step: 0.05, label: 'bass → flow' },
  kick: { type: 'number', value: 120, min: 0, max: 1500, step: 5, label: 'onset kick (px/s)' },

  diffusion: { type: 'number', value: 1.2, min: 0, max: 6, step: 0.05, label: 'diffusion (px)' },
  fade: { type: 'number', value: 3, min: 0.2, max: 20, step: 0.1, label: 'fade (s)' },
  fieldStrength: { type: 'number', value: 1.4, min: 0.3, max: 6, step: 0.05, label: 'strength' },
  opacity: { type: 'number', value: 0.85, min: 0, max: 1, step: 0.01 },
  grain: { type: 'number', value: 0.02, min: 0, max: 0.2, step: 0.005 },

  textFade: { type: 'number', value: 0.85, min: 0, max: 1, step: 0.01, label: 'text fade' },
  textBlur: { type: 'number', value: 3, min: 0, max: 12, step: 0.1, label: 'text blur (px)' },
} as const

const groups = {
  Look: ['palette', 'grouping', 'saturation'],
  Rhythm: ['density', 'spectrum', 'attack', 'release'],
  Ink: ['inkSize', 'inkStrength', 'textFade', 'textBlur'],
  Flow: ['flow', 'eddy', 'turbulence', 'drift', 'driftSpeed', 'bassFlow', 'kick'],
  Field: ['diffusion', 'fade', 'fieldStrength', 'opacity', 'grain'],
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
  let kick = 0

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
        kick = Math.max(kick, audio.onsetStrength)
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
      kick *= Math.exp(-dt / 0.3)

      // --- Text + ink -----------------------------------------------------
      // Hit letters fade into their colour while pouring the same colour,
      // in their own shape, into the field.
      const fx = layers.field
      const [ir, ig, ib] = f.ink
      const unitPx = text.fontSize * (base.length ? base[0].scale : 1)
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
            bleed: offset, blur: unitPx * 0.05, outward: 1,
            r: c[0], g: c[1], b: c[2], a: e * p.inkStrength,
          })
        }
      }

      // --- Field ------------------------------------------------------------
      fx.enabled = true
      const nextLook = `${k}:${p.palette}`
      if (nextLook !== look) {
        look = nextLook
        fx.reset()
      }
      fx.flowSpeed.value = p.flow * (1 + p.bassFlow * (audio.sub + audio.low) * 0.5)
      fx.flowScale.value = Math.max(1, p.eddy * unitPx)
      fx.turbulence.value = p.turbulence
      fx.setDrift(p.drift as FieldDrift, p.driftSpeed)
      fx.outward.value += p.kick * kick
      fx.diffusion.value = p.diffusion
      // `fade`: seconds to fall to ~5% (three time constants).
      fx.keep.value = Math.exp((-3 * dt) / p.fade)
      fx.gain.value = p.fieldStrength
      fx.opacity.value = p.opacity
      fx.grain.value = p.grain
    },
  }
}

export const field: ModeDefinition = { id: 'field', label: 'Field', params, groups, presets: fieldPresets, create }
