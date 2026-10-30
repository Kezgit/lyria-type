import { Color } from 'three/webgpu'
import type { ParamSchema } from '../../app/params'
import type { Placement } from '../../layout/types'
import { writeGlyph } from '../shared/glyphs'
import { noise } from '../shared/dotShape'
import { editMap, remap } from '../shared/remap'
import { gradientSamples } from '../sequencer/finish'
import { PALETTES } from '../sequencer/palettes'
import { MULTI } from '../sequencer/barcode'
import type { FrameContext, ModeDefinition, ModeInstance, ModePreset } from '../types'

// Type Bloom: typing in the Dots look. Nothing is laid over the words: the
// text stays crisp and calm, and the colour lives in the air around the cursor.
//   letters   tinted from the colours; they glide to where the layout puts
//             them (a new line lifts the block smoothly), and a newly typed
//             letter rises a touch out of a blur into place
//   cursor    a thin line right after the last letter, and off it a faint
//             wisp of coloured smoke: each frame the cursor breathes a little
//             colour into a flowing field (curl noise, a gentle wind, soft
//             diffusion, fast decay), under the text, so it trails off the
//             end of the line as you type and is gone a moment after you
//             stop; a small drop of brighter colour sits at the cursor
//   colours   the main gradient (the Sequencer's gradient map), or a palette;
//             which part of it lands where is a slow drifting noise

/** Colour sources besides the main gradient: each palette's rows end to end, and the Google hues. */
const SOURCES: Record<string, string[]> = { 'Google · across hues': MULTI }
for (const pl of PALETTES) SOURCES[`${pl.label}`] = pl.rows.flatMap((r) => [...r])

const params: ParamSchema = {
  colours: {
    type: 'select', value: 'main', label: 'colours',
    options: { 'the main gradient (Sequencer → Gradient map)': 'main', ...Object.fromEntries(Object.keys(SOURCES).map((k) => [k, k])) },
  },
  noiseScale: { type: 'number', value: 420, min: 40, max: 2000, step: 1, label: 'colour noise scale (px)' },
  noiseSpeed: { type: 'number', value: 0.12, min: 0, max: 1, step: 0.005, label: 'colour drift' },
  noiseSeed: { type: 'number', value: 3, min: 0, max: 100, step: 1, label: 'colour seed' },
  spread: { type: 'number', value: 1.4, min: 0.3, max: 3, step: 0.01, label: 'colour spread (contrast)' },

  letterTint: { type: 'number', value: 0.45, min: 0, max: 1, step: 0.01, label: 'letters take the colours' },
  reflow: { type: 'number', value: 0.45, min: 0, max: 2, step: 0.01, label: 'letters glide into place (s)' },
  rise: { type: 'number', value: 0.18, min: 0, max: 1, step: 0.01, label: 'new letters rise (× line height)' },
  blurIn: { type: 'number', value: 0.45, min: 0, max: 2, step: 0.01, label: 'new letters sharpen over (s)' },
  blurPx: { type: 'number', value: 9, min: 0, max: 40, step: 0.5, label: 'new letters start blurred (px)' },

  flow: { type: 'number', value: 0.55, min: 0, max: 1.5, step: 0.01, label: 'cursor smoke' },
  smokeSize: { type: 'number', value: 0.55, min: 0.1, max: 2, step: 0.01, label: 'smoke size (× line height)' },
  smokeLast: { type: 'number', value: 0.9, min: 0.1, max: 4, step: 0.05, label: 'smoke lasts (s)' },
  wind: { type: 'number', value: 0.8, min: -3, max: 3, step: 0.01, label: 'smoke drifts on (× line height / s)' },
  rising: { type: 'number', value: 0.08, min: -1, max: 1, step: 0.01, label: 'smoke rises (× line height / s)' },
  swirl: { type: 'number', value: 0.7, min: 0, max: 3, step: 0.01, label: 'smoky swirl' },
  swirlScale: { type: 'number', value: 1.4, min: 0.2, max: 6, step: 0.05, label: 'swirl size (× line height)' },
  smokeSoft: { type: 'number', value: 1.6, min: 0, max: 3, step: 0.05, label: 'smoke softens' },
  smokeOpacity: { type: 'number', value: 0.55, min: 0, max: 1, step: 0.01, label: 'smoke opacity' },
  flowDecay: { type: 'number', value: 0.7, min: 0.1, max: 4, step: 0.05, label: 'stops after typing (s)' },
  accent: { type: 'number', value: 0.75, min: 0, max: 1, step: 0.01, label: 'drop of colour at the cursor' },
  caretLine: { type: 'number', value: 0.85, min: 0, max: 1, step: 0.01, label: 'cursor line' },
}

const groups = {
  Colours: ['colours', 'noiseScale', 'noiseSpeed', 'noiseSeed', 'spread'],
  Letters: ['letterTint', 'reflow', 'rise', 'blurIn', 'blurPx'],
  'Cursor smoke': ['flow', 'smokeSize', 'smokeLast', 'wind', 'rising', 'swirl', 'swirlScale', 'smokeSoft', 'smokeOpacity', 'flowDecay', 'accent', 'caretLine'],
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v))
const smooth01 = (v: number) => { const t = clamp01(v); return t * t * (3 - 2 * t) }
/** Gradient rows: the colours, and the ink (the cursor line). */
const ROW = 0, INK_ROW = 1
/** A slow walk along the colours over time, so the smoke changes hue as you type. */
const stream0 = (t: number) => t * 40

function create(): ModeInstance {
  let chars: string | null = null
  /** Per letter: when it was typed (s; long ago for letters already there), where it is drawn now. */
  let born = new Float32Array(0)
  let ex = new Float32Array(0)
  let ey = new Float32Array(0)
  let clock = 0
  let caret = -1
  let typedAt = -1e9
  /** How much flow there is: fed by keystrokes, fading over `flowDecay`. */
  let energy = 0
  /** The cursor where it's drawn (it glides too). */
  const cur = { x: NaN, y: NaN }
  /** Where the cursor was last frame (the smoke is laid along the way). */
  const lastCur = { x: 0, y: 0 }
  let rampKey = ''
  let ramp: [number, number, number][] = []
  const c = new Color()

  return {
    update(frame: FrameContext) {
      const { layers, params: p, text, base, dt, ink } = frame
      clock += dt
      const { glyphs, barsFar, barsMid, bars } = layers

      // ---- Typing: which letters are new (they rise and sharpen in; the cursor follows the newest).
      const now = text.glyphs.map((g) => g.char).join('')
      if (now !== chars) {
        const from = editMap(chars ?? now, now)
        born = remap(born, from, chars === null ? -1e9 : clock)
        ex = remap(ex, from, NaN)
        ey = remap(ey, from, NaN)
        if (chars === null) born.fill(-1e9)
        else {
          let newest = -1
          from.forEach((f, i) => { if (f < 0) newest = Math.max(newest, i) })
          if (newest >= 0) {
            caret = newest
            typedAt = clock
            energy = Math.min(1.2, energy + 0.45)
          }
        }
        chars = now
      }
      if (caret >= text.glyphs.length) caret = text.glyphs.length - 1
      if (caret < 0 && text.glyphs.length) caret = text.glyphs.length - 1
      energy *= Math.exp(-dt / Math.max(0.05, p.flowDecay))

      // ---- Colours: the gradient as linear rgb, sampled by a drifting noise over the page.
      const stops = p.colours === 'main' ? String(frame.modeParams.sequencer?.gradStops ?? '') : SOURCES[p.colours]?.map((h, i, a) => `${i / Math.max(1, a.length - 1)}:${h}`).join(',') ?? ''
      if (stops !== rampKey) {
        rampKey = stops
        ramp = gradientSamples(stops).map((h) => { c.set(h); return [c.r, c.g, c.b] })
      }
      const hexes = gradientSamples(stops)
      const inkHex = `#${c.setRGB(ink[0], ink[1], ink[2]).getHexString()}`
      for (const l of [barsFar.bars, barsMid.bars, bars]) { l.setGradient(hexes, ROW); l.setGradient([inkHex, inkHex], INK_ROW) }
      const z = clock * p.noiseSpeed + p.noiseSeed * 13.7
      const tAt = (x: number, y: number) => clamp01(0.5 + 0.5 * p.spread * noise(x / p.noiseScale, y / p.noiseScale, z))
      const colourAt = (t: number) => ramp[Math.round(clamp01(t) * (ramp.length - 1))] ?? [0.5, 0.5, 0.5]

      // ---- Letters: they glide to where the layout puts them; a new one rises a touch out of a blur.
      const glide = p.reflow > 0.01 ? 1 - Math.exp(-dt / (p.reflow / 3)) : 1
      const lh = text.fontSize * (base[0]?.scale ?? 1)
      // How far the block is still gliding, so a letter starting a new line rides the same glide.
      let lagY = 0, lagN = 0
      for (const g of text.glyphs) {
        const b = base[g.index]
        if (b && !Number.isNaN(ey[g.index]) && born[g.index] < clock - 1e-6) { lagY += ey[g.index] - b.y; lagN++ }
      }
      lagY = lagN ? lagY / lagN : 0
      const placed: Placement[] = []
      for (const g of text.glyphs) {
        const i = g.index
        const b = base[i]
        if (!b) continue
        if (Number.isNaN(ex[i])) {
          ex[i] = b.x
          ey[i] = b.y + lagY - p.rise * lh
        }
        ex[i] += (b.x - ex[i]) * glide
        ey[i] += (b.y - ey[i]) * glide
        const at = { ...b, x: ex[i], y: ey[i] }
        placed[i] = at
        const age = clock - born[i]
        const sharp = p.blurIn > 0 ? smooth01(age / p.blurIn) : 1
        const col = colourAt(tAt(at.x, at.y))
        const k = clamp01(p.letterTint)
        writeGlyph(glyphs, g, at, {
          r: ink[0] + (col[0] * 0.7 - ink[0]) * k,
          g: ink[1] + (col[1] * 0.7 - ink[1]) * k,
          b: ink[2] + (col[2] * 0.7 - ink[2]) * k,
          a: sharp,
          blur: p.blurPx * (1 - sharp),
        })
      }

      // ---- The cursor: just after the newest letter, gliding with it.
      const g = caret >= 0 ? text.glyphs[caret] : undefined
      const at = g ? placed[g.index] : undefined
      if (!g || !at) return
      // Just past the letter's ink: its pen advance from where it's drawn (the quad has padding around the ink).
      const tx = at.x + (g.advance - g.cx) * at.scale + lh * 0.05, ty = at.y
      if (Number.isNaN(cur.x)) { cur.x = lastCur.x = tx; cur.y = lastCur.y = ty }
      const follow = 1 - Math.exp(-dt / 0.08)
      cur.x += (tx - cur.x) * follow
      cur.y += (ty - cur.y) * follow
      const since = clock - typedAt

      // The line: thin, ink, steady while typing, softly breathing when idle.
      if (p.caretLine > 0.01) {
        const idle = since > 0.6 ? 0.55 + 0.45 * Math.cos((since - 0.6) * Math.PI) ** 2 : 1
        bars.push({ x: cur.x, y: cur.y, w: Math.max(1.2, lh * 0.03), h: lh * 0.95, t0: 0.5, t1: 0.5, row: INK_ROW, alpha: p.caretLine * idle, feather: 0.6 })
      }

      // The smoke: the cursor breathes a little colour into a flowing field each frame (as the key art's
      // trail: stamped, carried on by a gentle wind and curl noise, softening and fading), under the text.
      const e = clamp01(energy) * p.flow
      const smoke = layers.field
      smoke.enabled = p.flow > 0.001
      if (smoke.enabled) {
        smoke.composite.renderOrder = 3
        smoke.flowSpeed.value = p.swirl * lh * 0.8
        smoke.flowScale.value = Math.max(8, p.swirlScale * lh)
        smoke.turbulence.value = 0.25
        smoke.diffusion.value = p.smokeSoft
        smoke.keep.value = Math.exp(-dt / Math.max(0.05, p.smokeLast))
        smoke.setDrift('none', 0)
        smoke.drift.value.set(p.wind * lh, p.rising * lh)
        smoke.gain.value = 1.4
        smoke.opacity.value = p.smokeOpacity
        smoke.grain.value = 0
        smoke.look = 'flat'
        const ib = smoke.injectBars
        ib.setGradient(hexes, ROW)
        // Each keystroke breathes out a short puff (a held cursor builds no disc); the puff is laid along the
        // cursor's path since last frame, so a moving cursor leaves a smooth wisp, not beads.
        const puff = p.flow * Math.exp(-(clock - typedAt) / 0.14) * Math.min(1, 0.4 + 0.6 * clamp01(energy))
        if (puff > 0.01) {
          const r = lh * p.smokeSize * 0.5
          const steps = Math.max(1, Math.min(12, Math.ceil(Math.hypot(cur.x - lastCur.x, cur.y - lastCur.y) / (r * 0.5))))
          for (let k = 1; k <= steps; k++) {
            const u = k / steps
            const x = lastCur.x + (cur.x - lastCur.x) * u, y = lastCur.y + (cur.y - lastCur.y) * u
            const t = tAt(x - stream0(clock), y)
            ib.push({ x: x + r * 0.3, y, w: r * 2.6, h: r * 1.6, radius: r * 0.8, t0: t, t1: t + 0.06, row: ROW, alpha: clamp01((puff * 0.22) / Math.sqrt(steps)), feather: r * 1.4 })
          }
        }
      }
      lastCur.x = cur.x
      lastCur.y = cur.y

      // The drop: a small bright bead of colour at the cursor, falling away as the flow does.
      if (p.accent > 0.01 && e > 0.02) {
        barsMid.radius = 4
        barsMid.stretch = 1
        barsMid.gain.value = 1.6
        barsMid.opacity.value = 1
        barsMid.edge.value = 0.2
        const t = tAt(cur.x + 50, cur.y - 80)
        const r = lh * 0.12 * (0.8 + 0.4 * clamp01(energy))
        barsMid.bars.push({ x: cur.x + lh * 0.18, y: cur.y, w: r * 2, h: r * 2, radius: r, t0: t, t1: t, row: ROW, alpha: clamp01(p.accent * e * 1.4), feather: r * 0.4 })
        // Its tail, a little below, fainter.
        barsMid.bars.push({ x: cur.x + lh * 0.18, y: cur.y - r * 1.6, w: r * 1.1, h: r * 2.6, radius: r * 0.55, t0: t, t1: t, row: ROW, alpha: clamp01(p.accent * e * 0.6), feather: r * 0.6 })
      }
    },
  }
}

const PAGE = { background: '#ffffff', ink: '#121317', fontId: 'google-sans-flex' }

const presets: Record<string, ModePreset> = {
  // The main gradient, a faint wisp of smoke off the cursor.
  Default: { params: {}, ...PAGE },
  // Barely there: a smaller, shorter wisp, ink letters.
  Whisper: { params: { flow: 0.35, smokeSize: 0.4, smokeLast: 0.6, letterTint: 0.2, accent: 0.4 }, ...PAGE },
  // A longer, swirlier trail that lingers.
  Ambient: { params: { flow: 0.75, smokeSize: 0.75, smokeLast: 1.8, swirl: 0.9, wind: 0.8, smokeOpacity: 0.65 }, ...PAGE },
  // Dusk.
  Dusk: { params: { colours: 'dusk' }, ...PAGE },
  // Primary colours (gold, green, red, blue).
  Primary: { params: { colours: 'primary (gold · green · red · blue)' }, ...PAGE },
  // The Google hues across.
  'Google hues': { params: { colours: 'Google · across hues' }, ...PAGE },
}

export const typeBloom: ModeDefinition = {
  id: 'typeBloom',
  label: 'Type Bloom',
  params,
  groups,
  presets,
  create,
}
