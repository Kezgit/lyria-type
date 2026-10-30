import type { ParamDef, ParamSchema } from '../../app/params'
import type { FieldLook } from '../../engine/fieldFx'
import { pulse as pulseMode } from '../pulse'
import { paletteRGB, type RGB } from '../shared/palettes'
import { ramps } from '../stretch'
import { ORDER, SECTION_HUES, STEM_HUE, barcodeBuilder, barcodeGradients, barcodeGroups, barcodeParams, rowOf, type Marks } from './barcode'
import type { SubMode, SubInstance } from './index'

// Pulse: Barcode's picture played through Pulse's field. The score is drawn
// as a faint ghost (Barcode, any of its settings); as the music plays, marks
// are stamped into the FieldFx feedback buffer at full colour, where they
// swell outward, blur, ripple and fade exactly as Pulse's words do. Marks lit
// close together merge into one soft shape. Onsets surge the swell; bass
// keeps it breathing. Which marks light is the `motion`:
//   playhead   a playhead runs through the window; every mark it reaches
//   every bar  the beat's place in the bar, in every bar of the window at once
//   stems      a stem's whole band flares on that stem's onsets and fades
//   sections   the section playing now glows, all of it, pulsing on onsets
//   scatter    each stem's onsets light random bars of that stem, anywhere
//              in the window (`scatter` of them), which fade over `release`
//   follow   `loop window`: the song's position wrapped into the window, so
//            the window plays on every pass of it; `song`: only while the
//            song is inside the window (playhead, every bar, sections)
//   trigger  `held`: a mark inks for as long as the playhead is on it;
//            `onset`: only as the playhead reaches it (playhead, every bar)
//   colour   `field look`: the marks' own colours, recoloured by the look
//            (cycle and ramp give one mass of colour); `stems`: each band in
//            its Google hue (vocals blue, instruments yellow, drums red, bass
//            green); `sections`: each section in the next hue. Both keep
//            their hues: cycle and ramp looks fall back to tone ripples

const LUMA: RGB = [0.2126, 0.7152, 0.0722]
const saturate = (c: RGB, s: number): RGB => {
  const l = c[0] * LUMA[0] + c[1] * LUMA[1] + c[2] * LUMA[2]
  return [0, 1, 2].map((k) => Math.min(1, Math.max(0, l + (c[k] - l) * s))) as RGB
}

/** One of Pulse's controls, under its own default (and key, where Barcode already has the name). */
const from = (k: string, value?: unknown, label?: string): ParamDef => {
  const def = pulseMode.params[k]
  return { ...def, ...(value !== undefined ? { value } : {}), label: label ?? def.label ?? k } as ParamDef
}

/** Barcode's controls with the sparse fields look as their defaults. */
const sparse: Record<string, unknown> = {
  style: 'fields', palette: 'blue', blend: 'within', span: 8, columns: 256, systems: 2, rows: 12, gap: 1.5, bandGap: 0.5,
  texture: false, keep: 'medium', medium: 0.08, blur: 0.6, densGamma: 1.4, cutoff: 0.12, opaqueAt: 0.35, soft: 2.5,
  segment: 3, fieldGrain: 0.15, paper: 0.05,
}
const score: ParamSchema = Object.fromEntries(
  Object.entries(barcodeParams).map(([k, def]) => [k, (k in sparse ? { ...def, value: sparse[k] } : def) as ParamDef]),
)

const params: ParamSchema = {
  ...score,

  motion: {
    type: 'select', value: 'playhead',
    options: { playhead: 'playhead', 'every bar': 'bars', stems: 'stems', sections: 'sections', scatter: 'scatter' },
  },
  ghost: { type: 'number', value: 0.18, min: 0, max: 1, step: 0.01, label: 'score ghost' },
  follow: { type: 'select', value: 'loop', label: 'playhead', options: { 'loop window': 'loop', song: 'song' } },
  trigger: { type: 'select', value: 'held', options: { held: 'held', onset: 'onset' } },
  tail: { type: 'number', value: 0.5, min: 0, max: 16, step: 0.25, label: 'ink after (steps)' },
  inkStrength: from('inkStrength', 0.7),
  release: { type: 'number', value: 0.4, min: 0.05, max: 4, step: 0.05, label: 'release (s)' },
  scatter: { type: 'number', value: 0.15, min: 0.01, max: 1, step: 0.01, label: 'scatter (share of bars)' },

  colourBy: { type: 'select', value: 'field', label: 'colour by', options: { 'field look': 'field', stems: 'stems', sections: 'sections' } },
  shade: { type: 'number', value: 0.5, min: 0, max: 1, step: 0.01, label: 'hue shade (50 → 1200)' },
  ghostHue: { type: 'boolean', value: true, label: 'ghost in hue' },

  look: from('look', 'cycle'),
  ramp: from('ramp', 'google-green'),
  cycle: from('palette', 'google', 'cycle palette'),
  saturation: from('saturation'),
  rippleSpeed: from('rippleSpeed', 115),
  rippleBase: from('rippleBase', 0.52),
  rippleLevel: from('rippleLevel', 0.36),
  rippleHits: from('rippleHits', 0),
  rings: from('rings'),
  wavelength: from('wavelength'),
  lightness: from('lightness', 0.46),
  depth: from('depth'),

  swell: from('swell'),
  pulse: from('pulse'),
  pulseDecay: from('pulseDecay'),
  thin: from('thin'),
  bassSwell: from('bassSwell'),
  wobble: from('wobble'),

  diffusion: from('diffusion'),
  fade: from('fade'),
  fieldStrength: from('fieldStrength'),
  opacity: from('opacity'),
  motionGrain: from('grain', undefined, 'field grain'),
}

// Barcode's haze is drawn by Barcode only; Pulse has its own field.
const { Haze: _haze, ...scoreGroups } = barcodeGroups
const groups = {
  ...scoreGroups,
  Motion: ['motion', 'ghost', 'follow', 'trigger', 'tail', 'inkStrength', 'release', 'scatter'],
  Colour: ['colourBy', 'shade', 'ghostHue'],
  Ripple: ['look', 'ramp', 'cycle', 'saturation', 'rippleSpeed', 'rippleBase', 'rippleLevel', 'rippleHits', 'rings', 'wavelength', 'lightness', 'depth'],
  Swell: ['swell', 'pulse', 'pulseDecay', 'thin', 'bassSwell', 'wobble'],
  Field: ['diffusion', 'fade', 'fieldStrength', 'opacity', 'motionGrain'],
}

/** Per mark, for the current picture: its section, and its group (one stem's marks in one bar). */
interface Meta {
  section: Int32Array
  group: Int32Array
  /** Groups per stem (ORDER index). */
  groupsOf: number[][]
  groupCount: number
}

function metaOf(out: Marks): Meta {
  const n = out.marks.length
  const section = new Int32Array(n)
  const group = new Int32Array(n)
  const ids = new Map<number, number>()
  const groupsOf: number[][] = ORDER.map(() => [])
  for (let i = 0; i < n; i++) {
    const t = out.times[2 * i]
    let sec = 0
    while (sec + 1 < out.sections.length && out.sections[sec + 1] <= t) sec++
    section[i] = sec
    const k = out.stems[i] * 1e5 + Math.floor(t / 16)
    let g = ids.get(k)
    if (g === undefined) {
      ids.set(k, (g = ids.size))
      groupsOf[out.stems[i]].push(g)
    }
    group[i] = g
  }
  return { section, group, groupsOf, groupCount: ids.size }
}

function create(): SubInstance {
  const build = barcodeBuilder()
  let look = ''
  let prev = NaN
  let surge = 0
  let hitPulse = 0
  let meta: Meta | null = null
  let metaFor: Marks | null = null
  /** Envelopes: per stem (stems motion), per group (scatter). */
  const stemEnv = ORDER.map(() => 0)
  let groupEnv = new Float32Array(0)

  return {
    update({ layers, viewport, ink, audio, dt }, comp, p) {
      const bars = layers.bars
      const fx = layers.field
      bars.blend = 'normal'
      barcodeGradients(bars, ink)
      barcodeGradients(fx.injectBars, ink)
      layers.grain.value = p.paper
      const out = build(comp, p, viewport.width, viewport.height)

      // --- Motion -----------------------------------------------------------
      // Each mark's ink this frame (0..1), by the motion; inked marks stamp the field.
      if (out) {
        const { marks, times, window: [w0, w1] } = out
        if (out !== metaFor) {
          metaFor = out
          meta = metaOf(out)
          groupEnv = new Float32Array(meta.groupCount)
        }
        const { section, group, groupsOf } = meta!
        const len = w1 - w0
        const ph = p.follow === 'loop' ? w0 + ((((comp.position - w0) % len) + len) % len) : comp.position
        // How far it moved since last frame (a wrap restarts it), so short marks are never skipped.
        const moved = ph >= prev && ph - prev < len / 2 ? ph - prev : 0
        prev = ph
        const held = p.trigger === 'held'
        const fall = Math.exp(-dt / p.release)

        // Stems and scatter follow each stem's own onsets.
        for (let si = 0; si < ORDER.length; si++) {
          const st = audio.stems[ORDER[si]]
          stemEnv[si] *= fall
          if (!st.onset) continue
          stemEnv[si] = Math.max(stemEnv[si], 0.5 + 0.5 * st.onsetStrength)
          if (p.motion === 'scatter') {
            const gs = groupsOf[si]
            const k = Math.ceil(gs.length * p.scatter * (0.4 + 0.6 * st.onsetStrength))
            for (let j = 0; j < k && gs.length; j++) {
              const g = gs[(Math.random() * gs.length) | 0]
              groupEnv[g] = Math.max(groupEnv[g], 0.6 + 0.4 * st.onsetStrength)
            }
          }
        }
        for (let g = 0; g < groupEnv.length; g++) groupEnv[g] *= fall
        // Sections: the one under the (followed) position, breathing with the hits.
        let now = -1
        if (p.motion === 'sections' && ph >= w0 && ph < w1) {
          now = 0
          while (now + 1 < out.sections.length && out.sections[now + 1] <= ph) now++
        }
        const glow = 0.35 + 0.65 * Math.max(hitPulse, audio.level)
        // Every bar: the playhead's place in its bar, in every bar.
        const inBar = ((ph % 16) + 16) % 16

        const inkOf = (i: number) => {
          const a = times[2 * i], b = times[2 * i + 1]
          switch (p.motion) {
            case 'bars': {
              const a16 = a - 16 * Math.floor(a / 16), end = (held ? a16 + (b - a) : a16) + p.tail
              const on = (x: number) => x >= a16 && x - moved <= end
              return on(inBar) || on(inBar + 16) ? 1 : 0
            }
            case 'stems': return stemEnv[out.stems[i]]
            case 'sections': return section[i] === now ? glow : 0
            case 'scatter': return groupEnv[group[i]]
            default: return ph >= a && ph - moved <= (held ? b : a) + p.tail ? 1 : 0
          }
        }

        const by = p.colourBy
        for (let i = 0; i < marks.length; i++) {
          // In hue: the mark's shape, one flat shade of its stem's / section's ramp.
          const hue = by === 'stems' ? STEM_HUE[ORDER[out.stems[i]]] : by === 'sections' ? SECTION_HUES[section[i] % SECTION_HUES.length] : null
          const m = hue ? { ...marks[i], row: rowOf(hue), t0: p.shade, t1: p.shade } : marks[i]
          if (p.ghost > 0) bars.push({ ...(hue && !p.ghostHue ? marks[i] : m), alpha: (m.alpha ?? 1) * p.ghost })
          const w = inkOf(i)
          if (w > 0.02) fx.injectBars.push({ ...m, alpha: (m.alpha ?? 1) * p.inkStrength * Math.min(1, w), grain: 0 })
        }
      }

      // --- Field (as Pulse) -------------------------------------------------
      if (audio.onset) {
        surge = Math.max(surge, audio.onsetStrength)
        hitPulse = Math.max(hitPulse, 0.6 + 0.4 * audio.onsetStrength)
      }
      surge *= Math.exp(-dt / p.pulseDecay)
      hitPulse *= Math.exp(-dt / 0.15)

      const pal = paletteRGB(p.cycle)
      const colours = pal.slice(0, Math.max(1, pal.length - 1)).map((c) => saturate(c, p.saturation))
      const unitPx = Math.min(viewport.width, viewport.height) / 24

      fx.enabled = true
      const nextLook = `${p.cycle}:${p.style}:${p.palette}:${p.colourBy}`
      if (nextLook !== look) {
        look = nextLook
        fx.reset()
      }
      fx.flowSpeed.value = p.wobble
      fx.flowScale.value = Math.max(1, 2 * unitPx)
      fx.turbulence.value = 0.2
      fx.setDrift('none', 0)
      fx.expand.value = p.swell * (1 + p.bassSwell * (audio.sub + audio.low) * 0.5) + p.pulse * surge
      fx.expandReach.value = Math.max(3, unitPx * 0.12)
      fx.expandKeep.value = Math.exp(-p.thin * fx.expand.value * dt * 0.02)
      fx.diffusion.value = p.diffusion
      fx.keep.value = Math.exp((-3 * dt) / p.fade)
      fx.gain.value = p.fieldStrength
      fx.opacity.value = p.opacity
      fx.grain.value = p.motionGrain

      // Hues by stem or section survive only looks that keep the field's own colour.
      fx.look = (p.colourBy !== 'field' && (p.look === 'cycle' || p.look === 'ramp') ? 'tone' : p.look) as FieldLook
      fx.rippleSpeed = p.rippleSpeed
      fx.emit(p.rippleBase + p.rippleLevel * audio.level * audio.level + p.rippleHits * hitPulse, dt)
      fx.rings.value = p.rings
      fx.wavelength.value = p.wavelength
      fx.lightness.value = p.lightness
      fx.depth.value = p.depth
      const stops = ramps[p.ramp] ?? ramps['google-blue-light']
      fx.ramp.forEach((u, i) => u.value.set(stops[i]))
      fx.cycle.forEach((u, i) => u.value.setRGB(...colours[i % colours.length]))
    },
  }
}

const WHITE = { background: '#ffffff', ink: '#121317' }

export const pulse: SubMode = {
  id: 'pulse',
  label: 'Pulse',
  params,
  groups,
  presets: {
    // The sparse score as a faint ghost; played marks bloom into slow green colour bands.
    Default: { params: {}, ...WHITE },
    // No ghost: only what plays appears, then fades.
    'Played only': { params: { ghost: 0, fade: 2.6, swell: 30 }, ...WHITE },
    // Short blooms on each mark's start, like hits.
    Hits: { params: { trigger: 'onset', tail: 1, pulse: 300, pulseDecay: 0.2, fade: 1.4, rippleHits: 0.8 }, ...WHITE },
    // Plain merging colour in the score's own hues, no ripples.
    Flat: { params: { look: 'flat', fade: 2.4, ghost: 0.12 }, ...WHITE },
    // Each stem in its own Google hue, rippling lighter on the beat.
    Stems: { params: { colourBy: 'stems', lightness: 0.7, rippleBase: 0.35, rippleLevel: 0.4, rippleHits: 0.6 }, ...WHITE },
    // Stems as plain merging colour, no ripples.
    'Stems · flat': { params: { colourBy: 'stems', look: 'flat', fade: 2.4 }, ...WHITE },
    // Each section in the next hue, so the song's form reads as it plays.
    Sections: { params: { colourBy: 'sections', lightness: 0.7, rippleBase: 0.35, rippleLevel: 0.4, rippleHits: 0.6, span: 0, columns: 512 }, ...WHITE },
    // Spatial: random bars of each stem bloom on its hits, anywhere on the page, each in its hue.
    Scatter: { params: { motion: 'scatter', colourBy: 'stems', scatter: 0.12, release: 0.6, look: 'tone', lightness: 0.7, ghost: 0.12 }, ...WHITE },
    // Whole stems flare on their own hits.
    'Stem flares': { params: { motion: 'stems', colourBy: 'stems', release: 0.35, inkStrength: 0.45, look: 'tone', lightness: 0.7, fade: 1.4 }, ...WHITE },
    // The section playing glows, the whole song in view.
    'Section glow': { params: { motion: 'sections', colourBy: 'sections', span: 0, columns: 512, inkStrength: 0.4, look: 'tone', lightness: 0.7, fade: 2.4 }, ...WHITE },
    // The beat in every bar at once: columns of colour stepping across the page.
    'Every bar': { params: { motion: 'bars', trigger: 'onset', tail: 1, colourBy: 'stems', look: 'tone', lightness: 0.7, fade: 1.2 }, ...WHITE },
    // A tone ripple over the blue score.
    Tone: { params: { look: 'tone', lightness: 0.85, rippleBase: 0.35, rippleLevel: 0.4, rippleHits: 0.8 }, ...WHITE },
  },
  create,
}
