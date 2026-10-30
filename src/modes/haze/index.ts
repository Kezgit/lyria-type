import type { FrameContext, ModeDefinition, ModeInstance } from '../types'
import { writeGlyph, writeHalo, writeOutline } from '../shared/glyphs'
import { partOfGlyphs } from '../shared/parts'
import { CRISP_ATLAS, HALO_ATLAS, atlasReachEm } from '../../text/atlas/sdfAtlas'
import { gradientPartnersRGB, paletteOptions, paletteRGB, type RGB } from '../shared/palettes'
import { BAND_COUNT } from '../../audio/features'
import { BLOB_FORMS, BLOB_GRADIENTS, type BlobBlend, type BlobForm, type BlobGradient } from '../../engine/blobLayer'
import { hazePresets } from './presets'

// Text dissolving into out-of-focus colour. On onsets, random glyphs / words /
// lines turn into soft shapes (blob, orb, bokeh, smear, watercolour, smoke) or
// bleed into coloured ink, then return to crisp type. Band energy keeps some
// alive between hits. The background is the plain page colour.

const formOptions = { Glyph: 'glyph', Blob: 'blob', Orb: 'orb', Bokeh: 'bokeh', Smear: 'smear', Watercolour: 'watercolour', Smoke: 'smoke', 'Ink bleed': 'bleed', Mixed: 'mixed' }
const gradientOptions = { Solid: 'solid', Radial: 'radial', Linear: 'linear', Conic: 'conic' }

const params = {
  form: { type: 'select', value: 'glyph', options: formOptions },
  gradient: { type: 'select', value: 'solid', options: gradientOptions },
  palette: { type: 'select', value: 'google', options: paletteOptions },
  blend: { type: 'select', value: 'normal', options: { Normal: 'normal', Multiply: 'multiply', Additive: 'additive' } },
  grouping: { type: 'select', value: 'glyph', options: { Glyph: 'glyph', Word: 'word', Line: 'line' } },

  density: { type: 'number', value: 0.12, min: 0, max: 1, step: 0.01, label: 'onset density' },
  spectrum: { type: 'number', value: 0.2, min: 0, max: 1, step: 0.01, label: 'band response' },
  attack: { type: 'number', value: 0.06, min: 0.01, max: 0.6, step: 0.01 },
  release: { type: 'number', value: 1.3, min: 0.1, max: 5, step: 0.05 },

  bleedTime: { type: 'number', value: 0.8, min: 0.05, max: 3, step: 0.05, label: 'bleed time (s)' },
  startSize: { type: 'number', value: 0.35, min: 0.05, max: 1, step: 0.01, label: 'start size' },
  growth: { type: 'number', value: 1.5, min: 1, max: 4, step: 0.05 },
  fieldBlur: { type: 'number', value: 0.8, min: 0.2, max: 4, step: 0.05, label: 'field blur (em)' },
  fieldStrength: { type: 'number', value: 4.5, min: 0.5, max: 8, step: 0.05, label: 'field strength' },

  blobSize: { type: 'number', value: 1.3, min: 0.3, max: 4, step: 0.05, label: 'size' },
  softness: { type: 'number', value: 0.75, min: 0, max: 1, step: 0.01 },
  wobble: { type: 'number', value: 0.12, min: 0, max: 0.5, step: 0.01 },
  blobOpacity: { type: 'number', value: 0.75, min: 0, max: 1, step: 0.01, label: 'opacity' },
  saturation: { type: 'number', value: 1, min: 0, max: 3, step: 0.01 },
  blobGrain: { type: 'number', value: 0, min: 0, max: 1, step: 0.01, label: 'shape grain' },

  textFade: { type: 'number', value: 1, min: 0, max: 1, step: 0.01, label: 'text fade' },
  textBlur: { type: 'number', value: 5, min: 0, max: 12, step: 0.1, label: 'text blur (px)' },
  bleed: { type: 'number', value: 0, min: 0, max: 1, step: 0.01, label: 'text bleed' },
  glow: { type: 'number', value: 0, min: 0, max: 1, step: 0.01, label: 'text glow' },

  filmGrain: { type: 'number', value: 0, min: 0, max: 0.3, step: 0.005, label: 'film grain' },
} as const

/** Groups for the panel: keeps the long list browsable. */
export const hazeGroups: Record<string, (keyof typeof params)[]> = {
  Look: ['form', 'gradient', 'palette', 'blend', 'grouping'],
  Rhythm: ['density', 'spectrum', 'attack', 'release'],
  Bleed: ['bleedTime', 'startSize', 'growth', 'fieldBlur', 'fieldStrength'],
  Shape: ['blobSize', 'softness', 'wobble', 'blobOpacity', 'saturation', 'blobGrain'],
  Text: ['textFade', 'textBlur', 'bleed', 'glow', 'filmGrain'],
}

const SHAPE_FORMS: BlobForm[] = ['blob', 'orb', 'bokeh', 'smear', 'watercolour', 'smoke']
/** How far (em) a halo glyph can be offset + blurred before hitting its atlas spread. */
const HALO_REACH_EM = atlasReachEm(HALO_ATLAS)
const CRISP_REACH_EM = atlasReachEm(CRISP_ATLAS)
const LUMA: RGB = [0.2126, 0.7152, 0.0722]

interface Unit {
  /** Onset-driven envelope target, decays over `release`. */
  kick: number
  /** Smoothed amount 0..1. */
  env: number
  /** Seconds since this unit was last (re)triggered: drives the ink -> colour bleed and growth. */
  age: number
  colorA: number
  colorB: number
  seed: number
  /** Form used when the mode's form is "mixed". */
  form: number
  /** Band this unit listens to, and how much energy it needs. */
  band: number
  threshold: number
  /** The instrument its letters are given to on the stage (LAYERS index), or -1: it plays with it, in its colour. */
  part: number
}

const rand = (a: number, b: number) => a + Math.random() * (b - a)
const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

/** Push a linear colour away from (or toward) its luminance. */
function saturate(c: RGB, s: number): RGB {
  const l = c[0] * LUMA[0] + c[1] * LUMA[1] + c[2] * LUMA[2]
  return [
    Math.min(1, Math.max(0, l + (c[0] - l) * s)),
    Math.min(1, Math.max(0, l + (c[1] - l) * s)),
    Math.min(1, Math.max(0, l + (c[2] - l) * s)),
  ]
}

function create(): ModeInstance {
  let units: Unit[] = []
  let unitOf = new Int32Array(0)
  let unitGlyphs: number[][] = []
  let key = ''
  let paletteName = ''
  // Per-unit bounds, recomputed each frame (word/line shapes span their glyphs).
  let minX = new Float32Array(0), maxX = new Float32Array(0)
  let minY = new Float32Array(0), maxY = new Float32Array(0)

  function rebuild(f: FrameContext) {
    const { glyphs } = f.text
    const g = f.params.grouping
    const count = g === 'word' ? f.text.wordCount : g === 'line' ? f.text.lines.length : glyphs.length
    unitOf = new Int32Array(glyphs.length)
    for (const gl of glyphs) unitOf[gl.index] = g === 'word' ? gl.word : g === 'line' ? gl.line : gl.index
    unitGlyphs = Array.from({ length: count }, () => [])
    for (const gl of glyphs) unitGlyphs[unitOf[gl.index]]?.push(gl.index)
    units = Array.from({ length: count }, (_, u) => ({
      kick: 0, env: 0, age: 99,
      colorA: 0, colorB: 1, seed: Math.random(), form: 0,
      band: Math.min(BAND_COUNT - 1, Math.floor((u / Math.max(1, count)) * BAND_COUNT)),
      threshold: rand(0.7, 0.98),
      part: partOfGlyphs(f.parts, unitGlyphs[u]),
    }))
    minX = new Float32Array(count); maxX = new Float32Array(count)
    minY = new Float32Array(count); maxY = new Float32Array(count)
  }

  // Shapes use every palette colour except the last (each palette's dark accent).
  function recolor(u: Unit, count: number) {
    u.colorA = (Math.random() * count) | 0
    u.colorB = (u.colorA + 1 + ((Math.random() * Math.max(1, count - 1)) | 0)) % count
    u.seed = Math.random()
    u.age = 0
    u.form = BLOB_FORMS[SHAPE_FORMS[(Math.random() * SHAPE_FORMS.length) | 0]]
  }

  // Dev-only: trigger units by hand from the console (window.__haze.hit([3, 7])).
  if (import.meta.env.DEV) {
    Object.assign(window, {
      __haze: {
        units: () => units,
        hit(indices: number[], strength = 1) {
          for (const i of indices) {
            const u = units[i]
            if (!u) continue
            recolor(u, 5)
            u.kick = strength
          }
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
      const usable = pal.length - 1
      // Palettes differ in length: give every unit valid colours for this one.
      if (p.palette !== paletteName) {
        paletteName = p.palette
        for (const u of units) {
          u.colorA = u.colorA % usable
          u.colorB = u.colorB % usable
        }
      }
      const colours = pal.map((c) => saturate(c, p.saturation))
      // A unit given to an instrument takes its colour (both ends of a gradient).
      const colourOf = (u: Unit) => (u.part >= 0 ? saturate(f.parts.rgb[u.part], p.saturation) : colours[u.colorA % colours.length])
      const partners = gradientPartnersRGB(p.palette)?.map((c) => saturate(c, p.saturation)) ?? null
      const em = text.fontSize
      const blend = p.blend as BlobBlend
      layers.front.blend = blend
      layers.back.blend = blend === 'multiply' ? 'normal' : blend
      layers.grain.value = p.filmGrain

      // --- Envelopes ------------------------------------------------------
      if (audio.onset && units.length) {
        const n = Math.ceil(units.length * p.density * (0.35 + 0.65 * audio.onsetStrength))
        for (let i = 0; i < n; i++) {
          const u = units[(Math.random() * units.length) | 0]
          // Units given to an instrument play with it instead (below).
          if (u.part >= 0) continue
          if (u.env < 0.3) recolor(u, usable)
          u.kick = Math.max(u.kick, 0.6 + 0.4 * audio.onsetStrength)
        }
      }

      const releaseK = Math.exp(-dt / p.release)
      const attackK = 1 - Math.exp(-dt / p.attack)
      const fallK = 1 - Math.exp(-dt / 0.12)
      for (const u of units) {
        u.age += dt
        u.kick *= releaseK
        // Given to an instrument: struck with it (restarting its bleed from rest), held while it sounds.
        if (u.part >= 0 && f.parts.hit[u.part] > 0) {
          if (u.env < 0.3) u.age = 0
          u.kick = Math.max(u.kick, 0.6 + 0.4 * f.parts.hit[u.part])
        }
        const spectral = u.part >= 0 ? f.parts.drive[u.part] * 0.8 : Math.max(0, (audio.bands[u.band] - u.threshold) / (1 - u.threshold)) * p.spectrum
        const target = Math.min(1, Math.max(u.kick, spectral))
        if (u.part < 0 && spectral > 0.2 && u.env < 0.05) recolor(u, usable)
        u.env += (target - u.env) * (target > u.env ? attackK : fallK)
      }

      // --- Bleed ----------------------------------------------------------
      // A hit starts as a small, fairly tight blob in the ink colour sitting
      // on the letter; over `bleedTime` it lerps to its palette colour and
      // softens, and it keeps growing for the rest of its life, so older hits
      // become the large pale field newer ones sit on.
      const [ir, ig, ib] = f.ink
      const ink: RGB = [ir, ig, ib]
      const lerp = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]
      const bleedOf = (u: Unit) => smooth(0, p.bleedTime, u.age)
      const growthOf = (u: Unit) => {
        const t = Math.min(1, u.age / (p.bleedTime + p.release))
        return p.startSize + (p.growth - p.startSize) * (1 - (1 - t) * (1 - t))
      }

      const glyphForm = p.form === 'glyph'

      // --- Glyphs ---------------------------------------------------------
      // The letter bleeds with its blob: it blurs and takes on the blob's
      // colour as it fades, rather than simply disappearing under it.
      minX.fill(Infinity); minY.fill(Infinity); maxX.fill(-Infinity); maxY.fill(-Infinity)
      for (const g of text.glyphs) {
        const ui = unitOf[g.index]
        const u = units[ui]
        const shown = smooth(0.1, 0.4, u.env)
        const bleed = bleedOf(u)
        const pl = base[g.index]
        const c = lerp(ink, colourOf(u), bleed * shown)
        // In glyph form the halo starts as an exact copy of the letter, so the
        // crisp text can hand over immediately; other forms wait for the bleed.
        const fade = glyphForm ? shown : shown * smooth(0, 0.7, bleed)
        writeGlyph(layers.glyphs, g, pl, {
          blur: shown * (0.3 + 0.7 * bleed) * p.textBlur,
          bleed: shown * p.bleed * em * 0.1 * pl.scale,
          glow: shown * p.glow,
          r: c[0], g: c[1], b: c[2],
          a: 1 - fade * p.textFade,
        })
        const hw = ((g.advance || g.w) / 2) * pl.scale
        const hh = em * 0.25 * pl.scale
        minX[ui] = Math.min(minX[ui], pl.x - hw)
        maxX[ui] = Math.max(maxX[ui], pl.x + hw)
        minY[ui] = Math.min(minY[ui], pl.y - hh)
        maxY[ui] = Math.max(maxY[ui], pl.y + hh)
      }

      // --- Shapes over the text -------------------------------------------
      // Screen-space blur radii for the blurred halo layers.
      const unitScale = text.fontSize * (base.length ? base[0].scale : 1)
      layers.halosMid.radius = unitScale * p.fieldBlur * 0.3
      layers.halosFar.radius = unitScale * p.fieldBlur
      layers.halosMid.gain.value = 1 + (p.fieldStrength - 1) * 0.4
      layers.halosFar.gain.value = p.fieldStrength
      layers.halosMid.opacity.value = p.blobOpacity
      layers.halosFar.opacity.value = p.blobOpacity

      const shapeForm =
        p.form === 'mixed' ? -1 : p.form === 'bleed' ? -2 : glyphForm ? -3 : BLOB_FORMS[p.form as BlobForm] ?? 0
      const gradient = BLOB_GRADIENTS[p.gradient as BlobGradient] ?? 0
      const scale = base.length ? base[0].scale : 1

      // Oldest (largest, palest) first so fresh ink-dark hits sit on top.
      // Glyph hits live for their whole lifecycle (bleed + release) so they
      // reach the blurred field at full strength, not as the envelope dies.
      const lifeOf = (u: Unit) => Math.min(1, u.age / (p.bleedTime + p.release))
      const active = units
        .map((_, i) => i)
        .filter((i) => minX[i] !== Infinity && (units[i].env >= 0.1 || (glyphForm && lifeOf(units[i]) < 1)))
        .sort((a, b) => units[b].age - units[a].age)

      for (const i of active) {
        const u = units[i]
        const shown = glyphForm
          ? Math.max(smooth(0.1, 0.45, u.env), 1 - smooth(0.55, 1, lifeOf(u)))
          : smooth(0.1, 0.45, u.env)
        const bleed = bleedOf(u)
        const form = shapeForm === -1 ? u.form : shapeForm
        const cx = (minX[i] + maxX[i]) / 2
        const cy = (minY[i] + maxY[i]) / 2
        const grow = growthOf(u)
        // Size pads the glyph/word box rather than multiplying it, so long
        // words become wide soft pills instead of huge ellipses.
        const pad = em * scale * 0.35 * p.blobSize
        let rx = ((maxX[i] - minX[i]) / 2 + pad) * grow
        let ry = ((maxY[i] - minY[i]) / 2 + pad) * grow
        const target = colourOf(u)
        const colorA = lerp(ink, target, bleed)
        const softness = 0.15 + (p.softness - 0.15) * bleed

        if (form === -3) {
          // Glyph: each letter's own outline, offset outward and blurred. It
          // starts as the letter in ink and ends as a soft shape in its colour.
          //   near  crisp atlas (sharp, small reach): the first moments only
          //   mid   halo atlas, blurred lightly as one image
          //   far   halo atlas, blurred heavily as one image: the merged field
          // The halo atlas is low-res, so it is only ever seen through blur;
          // the handover is early so blur leads and the offset follows.
          const unitPx = em * scale
          const crispReach = CRISP_REACH_EM * unitPx * 0.85
          const haloReach = HALO_REACH_EM * unitPx * 0.85
          const offset = Math.min(crispReach * 0.45, unitPx * 0.06 * p.blobSize * grow)
          // Outward blur spans 2x `blur` beyond the offset outline.
          const blur = Math.min((crispReach - offset) / 2, unitPx * (0.01 + 0.2 * p.softness * bleed))
          const alpha = shown * (1 + (p.blobOpacity - 1) * bleed)
          const life = lifeOf(u)
          const near = 1 - smooth(0, 0.18, life)
          const far = smooth(0.15, 0.7, life)
          const mid = Math.max(0, 1 - near - far)
          // Blurred layers get a fatter shape (mass to spread) and leave the
          // softening to the screen-space blur; their opacity is applied once
          // on the composite so overlaps don't double-dim.
          const fat = Math.min(haloReach * 0.7, unitPx * 0.3 * p.blobSize * grow)
          for (const gi of unitGlyphs[i] ?? []) {
            const g = text.glyphs[gi]
            const colour = { r: colorA[0], g: colorA[1], b: colorA[2] }
            if (near > 0.01) writeOutline(layers.outlines, g, base[gi], { ...colour, bleed: offset, blur, outward: 1, a: alpha * near })
            if (mid > 0.01) writeHalo(layers.halosMid.glyphs, g, base[gi], { ...colour, bleed: fat * 0.5, a: shown * mid })
            if (far > 0.01) writeHalo(layers.halosFar.glyphs, g, base[gi], { ...colour, bleed: fat, a: shown * far })
          }
          continue
        }
        if (form === -2) {
          // Ink bleed: the letters carry it; add only a faint wash behind.
          layers.back.push({
            x: cx, y: cy, rx: rx * 0.9, ry: ry * 0.9,
            softness: 1, seed: u.seed, form: BLOB_FORMS.orb,
            color: target, alpha: shown * bleed * p.blobOpacity * 0.18,
          })
          continue
        }
        if (form === BLOB_FORMS.bokeh) rx = ry = Math.max(rx, ry) * 0.8
        if (form === BLOB_FORMS.smear) { rx *= 1.6; ry *= 0.75 }
        const partner = gradient === 0 || u.part >= 0 ? target : partners ? partners[u.colorA % partners.length] : colours[u.colorB % colours.length]
        layers.front.push({
          x: cx, y: cy, rx, ry,
          rotation: form === BLOB_FORMS.smear ? Math.sin(u.seed * 40) * 0.35 + (u.seed > 0.5 ? Math.PI : 0) : (u.seed - 0.5) * 0.4,
          softness,
          seed: u.seed,
          wobble: p.wobble,
          color: colorA,
          color2: lerp(ink, partner, bleed),
          alpha: shown * p.blobOpacity,
          form,
          gradient,
          gradAngle: u.seed * 6.28,
          grain: p.blobGrain,
        })
      }
    },
  }
}

export const haze: ModeDefinition = { id: 'haze', label: 'Haze', params, groups: hazeGroups, presets: hazePresets, create }
