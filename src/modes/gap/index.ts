import type { ModeDefinition, ModeInstance } from '../types'
import type { Placement } from '../../layout/types'
import { writeGlyph } from '../shared/glyphs'
import { partOfGlyphs } from '../shared/parts'
import { MULTI_RAMPS, PART_CODE } from '../../engine/stretchFx'
import { BAND_COUNT } from '../../audio/features'
import { ramps as stretchRamps } from '../stretch'
import { gapPresets } from './presets'

// Letter spacing as the instrument. A hit letter (or word) pushes its
// neighbours apart and the gap it opens is filled:
//   stream    with the letter's own Stretch trail, clipped to the gap, so the
//             feedback stream is contained and seen whole next to its letter
//   spectrum  with a grainy gradient bar (the CULTURA TV PORTO poster look)
//   track     with nothing: the spacing alone breathes
// Lines shift along x only, then are re-anchored; the block shrinks (or the
// gaps squeeze) to stay in view.

/** Bar gradients, sRGB stops left -> right. */
const gradients: Record<string, string[]> = {
  spectrum: ['#e3262b', '#f0592a', '#f7a531', '#fbe14a', '#5bbd4c', '#1aa7d6', '#2a5cc4', '#4a2f93'],
  'spectrum-soft': ['#ff8a8a', '#ffc27a', '#fff08a', '#9be39a', '#86d4f2', '#9aa8f2', '#c4a0e8'],
  ...stretchRamps,
}

/** Stream trail ramps (emission 0 -> 1); `spectrum` runs cool when quiet, hot on hits. */
const streamRamps: Record<string, string[]> = {
  spectrum: ['#4a2f93', '#1aa7d6', '#fbe14a', '#e3262b'],
  ...stretchRamps,
}
const MULTI_GOOGLE = [stretchRamps['google-blue'], stretchRamps['google-red'], stretchRamps['google-yellow'], stretchRamps['google-green']]

const keys = (o: object) => Object.fromEntries(Object.keys(o).map((k) => [k, k]))

const params = {
  variant: { type: 'select', value: 'stream', options: { 'Stream (feedback)': 'stream', 'Spectrum bars': 'spectrum', 'Track only': 'track' } },
  scope: { type: 'select', value: 'glyph', options: { 'Glyph: gap beside it': 'glyph', 'Word: letterspace it': 'word' } },
  side: { type: 'select', value: 'after', options: { After: 'after', 'Both sides': 'both' } },
  anchor: { type: 'select', value: 'center', options: { Left: 'left', Center: 'center', Right: 'right' } },

  gap: { type: 'number', value: 3, min: 0, max: 20, step: 0.05, label: 'gap (em)' },
  vary: { type: 'number', value: 0.5, min: 0, max: 1, step: 0.01, label: 'gap variety' },
  pump: { type: 'number', value: 0.4, min: 0, max: 2, step: 0.01, label: 'level → gap' },
  fit: { type: 'select', value: 'shrink', options: { 'Shrink type': 'shrink', 'Squeeze gaps': 'squeeze' } },
  maxWidth: { type: 'number', value: 0.95, min: 0.2, max: 1, step: 0.01, label: 'max width (view)' },
  inset: { type: 'number', value: 0.06, min: 0, max: 0.5, step: 0.005, label: 'inset (em)' },

  density: { type: 'number', value: 0.25, min: 0, max: 1, step: 0.01, label: 'onset density' },
  sustain: { type: 'number', value: 0.35, min: 0, max: 1, step: 0.01, label: 'band sustain' },
  hold: { type: 'number', value: 0.35, min: 0.02, max: 3, step: 0.01, label: 'hit release' },
  open: { type: 'number', value: 0.12, min: 0.01, max: 2, step: 0.01, label: 'open (s)' },
  close: { type: 'number', value: 0.6, min: 0.01, max: 4, step: 0.01, label: 'close (s)' },

  // Stream
  ramp: { type: 'select', value: 'spectrum', options: keys(streamRamps) },
  colourBy: { type: 'select', value: 'ramp', label: 'colour by', options: { 'Single ramp': 'ramp', 'Cycle Google': 'cycle', 'Random Google': 'random' } },
  speed: { type: 'number', value: 1400, min: 0, max: 5000, step: 10, label: 'speed (px/s)' },
  audioSpeed: { type: 'number', value: 600, min: 0, max: 4000, step: 10, label: 'audio speed' },
  trail: { type: 'number', value: 1.5, min: 0.05, max: 8, step: 0.05, label: 'trail (s)' },
  spread: { type: 'number', value: 0.3, min: 0, max: 4, step: 0.05, label: 'spread (px)' },
  smear: { type: 'number', value: 4, min: 0, max: 20, step: 0.1, label: 'smear (px)' },
  base: { type: 'number', value: 0.15, min: 0, max: 1, step: 0.01, label: 'base colour' },
  bands: { type: 'number', value: 0.6, min: 0, max: 1, step: 0.01, label: 'band response' },
  hits: { type: 'number', value: 0.8, min: 0, max: 1, step: 0.01, label: 'onset hits' },
  letters: { type: 'select', value: 'solid', options: { 'Hit → ramp': 'hit', Solid: 'solid', 'Colour ramp': 'ramp', Hidden: 'hidden' } },

  // Spectrum bars
  gradient: { type: 'select', value: 'spectrum', options: keys(gradients) },
  barTop: { type: 'number', value: 0.72, min: -0.5, max: 2, step: 0.01, label: 'bar top (em)' },
  barBottom: { type: 'number', value: 0, min: -1, max: 1, step: 0.01, label: 'bar bottom (em)' },
  span: { type: 'number', value: 6, min: 0.5, max: 40, step: 0.1, label: 'gradient length (em)' },
  scroll: { type: 'number', value: 0.15, min: 0, max: 3, step: 0.01, label: 'scroll' },
  flip: { type: 'number', value: 0.5, min: 0, max: 1, step: 0.01, label: 'reversed bars' },
  grain: { type: 'number', value: 0.08, min: 0, max: 0.3, step: 0.005 },
} as const

const groups = {
  Look: ['variant', 'scope', 'side', 'anchor'],
  Spacing: ['gap', 'vary', 'pump', 'fit', 'maxWidth', 'inset'],
  Trigger: ['density', 'sustain', 'hold', 'open', 'close'],
  Stream: ['ramp', 'colourBy', 'speed', 'audioSpeed', 'trail', 'spread', 'smear', 'base', 'bands', 'hits', 'letters'],
  Bars: ['gradient', 'barTop', 'barBottom', 'span', 'scroll', 'flip', 'grain'],
}

interface Unit {
  /** Onset envelope. */
  hit: number
  band: number
  /** Gap width multiplier picked on each hit. */
  size: number
  /** Google ramp when colouring the stream by unit. */
  hue: number
  /** The instrument its letters are given to on the stage (LAYERS index), or -1: it plays with it, in its colour. */
  part: number
}

/** One side of one glyph's gap: how open it is and how its bar is coloured. */
interface Side {
  open: number
  phase: number
  dir: number
}

const newSide = (): Side => ({ open: 0, phase: Math.random() * 2, dir: 1 })

function create(): ModeInstance {
  let units: Unit[] = []
  let unitOf = new Int32Array(0)
  let after: Side[] = []
  let before: Side[] = []
  let shift = new Float32Array(0)
  let placed: Placement[] = []
  /** Whole-block scale that makes room for the gaps (fit: shrink). */
  let zoom = 1
  let key = ''
  let look = ''

  return {
    update({ audio, text, base, params: p, layers, dt, ink, background, viewport, parts }) {
      const n = text.glyphs.length
      const k = `${n}:${text.wordCount}:${p.scope}:${parts.key}`
      if (k !== key) {
        key = k
        const count = p.scope === 'word' ? text.wordCount : n
        units = Array.from({ length: count }, (_, i) => ({ hit: 0, band: (i * 3 + 1) % BAND_COUNT, size: 1, hue: i % MULTI_RAMPS, part: -1 }))
        unitOf = new Int32Array(n)
        for (const g of text.glyphs) unitOf[g.index] = p.scope === 'word' ? g.word : g.index
        const members: number[][] = units.map(() => [])
        for (const g of text.glyphs) members[unitOf[g.index]]?.push(g.index)
        units.forEach((u, i) => (u.part = partOfGlyphs(parts, members[i])))
        after = Array.from({ length: n }, newSide)
        before = Array.from({ length: n }, newSide)
        shift = new Float32Array(n)
        placed = Array.from({ length: n }, () => ({ x: 0, y: 0, rotation: 0, scale: 1 }))
      }
      // Layout placements scaled by last frame's zoom about the anchor: the
      // block's left / right edge or the centre.
      if (p.fit !== 'shrink') zoom = 1
      let ax = 0
      if (p.anchor !== 'center') {
        const left = p.anchor === 'left'
        ax = left ? Infinity : -Infinity
        for (const line of text.lines) {
          const g = left ? line.glyphs[0] : line.glyphs[line.glyphs.length - 1]
          if (!g) continue
          const b = base[g.index]
          const edge = b.x - g.cx * b.scale + (left ? 0 : g.advance * b.scale)
          ax = left ? Math.min(ax, edge) : Math.max(ax, edge)
        }
        if (!Number.isFinite(ax)) ax = 0
      }
      for (let i = 0; i < n; i++) {
        const b = base[i], o = placed[i]
        o.x = ax + (b.x - ax) * zoom; o.y = b.y * zoom; o.rotation = b.rotation; o.scale = b.scale * zoom
      }

      // --- Trigger ---------------------------------------------------------
      if (audio.onset && units.length) {
        const hits = Math.ceil(units.length * p.density * (0.4 + 0.6 * audio.onsetStrength))
        for (let i = 0; i < hits; i++) {
          const u = units[(Math.random() * units.length) | 0]
          // Units given to an instrument open with it instead (below).
          if (u.part >= 0) continue
          if (u.hit < 0.2) {
            u.size = 1 + p.vary * (Math.random() * 2 - 1)
            if (p.colourBy === 'random') u.hue = (Math.random() * MULTI_RAMPS) | 0
          }
          u.hit = Math.max(u.hit, 0.6 + 0.4 * audio.onsetStrength)
        }
      }
      const rel = Math.exp(-dt / p.hold)
      for (const u of units) {
        u.hit *= rel
        if (u.part >= 0 && parts.hit[u.part] > 0) {
          if (u.hit < 0.2) u.size = 1 + p.vary * (Math.random() * 2 - 1)
          u.hit = Math.max(u.hit, 0.6 + 0.4 * parts.hit[u.part])
        }
      }
      // Given to an instrument: it sustains while the instrument sounds, in place of its band.
      const bandOf = (u: Unit) => (u.part >= 0 ? parts.drive[u.part] : audio.bands[u.band])
      const activity = (u: Unit) => {
        const band = bandOf(u)
        return Math.min(1, u.hit * 1.4 + p.sustain * Math.max(0, (band - 0.65) / 0.35) * 2)
      }

      // --- Gaps --------------------------------------------------------------
      const both = p.side === 'both'
      const kOpen = 1 - Math.exp(-dt / p.open)
      const kClose = 1 - Math.exp(-dt / p.close)
      const ease = (s: Side, target: number) => {
        // A gap starting from shut picks a fresh stretch of the gradient.
        if (s.open < 0.02 && target > 0.05) {
          s.phase = Math.random() * 2
          s.dir = Math.random() < p.flip ? -1 : 1
        }
        s.open += (target - s.open) * (target > s.open ? kOpen : kClose)
        s.phase += s.dir * p.scroll * dt * (0.3 + audio.level)
      }
      for (const line of text.lines) {
        const gs = line.glyphs
        gs.forEach((g, i) => {
          const u = units[unitOf[g.index]]
          const a = activity(u) * u.size
          let ta = 0, tb = 0
          if (p.scope === 'word') {
            const next = gs[i + 1], prev = gs[i - 1]
            const lastInWord = !next || next.word !== g.word
            const firstInWord = !prev || prev.word !== g.word
            ta = !lastInWord || both ? a : 0
            tb = firstInWord && both ? a : 0
          } else {
            ta = a
            tb = both ? a : 0
          }
          ease(after[g.index], ta)
          ease(before[g.index], tb)
        })
      }

      // --- Fx setup ----------------------------------------------------------
      const stream = p.variant === 'stream'
      const fx = layers.stretch
      const bars = layers.bars
      if (stream) {
        fx.enabled = true
        fx.clip = bars
        const nextLook = `${p.ramp}:${p.side}:${k}`
        if (nextLook !== look) {
          look = nextLook
          fx.reset()
        }
        fx.setAxis('horizontal')
        fx.sided.value = both ? 1 : 0
        fx.step.value = (p.speed + p.audioSpeed * audio.level) * dt
        fx.keep.value = Math.exp((-3 * dt) / p.trail)
        fx.spread.value = p.spread
        fx.smear.value = p.smear
        fx.setRamp(streamRamps[p.ramp] ?? streamRamps.spectrum)
        fx.multi.value = p.colourBy === 'ramp' ? 0 : 1
        fx.setMultiRamps(MULTI_GOOGLE)
        fx.gamma.value = 1
        fx.background.value.set(background)
        fx.letterMode.value = { hidden: 0, solid: 1, ramp: 2, hit: 3 }[p.letters as string] ?? 1
        fx.letterColor.value.setRGB(ink[0], ink[1], ink[2])
        fx.grain.value = p.grain * 0.5
      } else {
        look = ''
        bars.setGradient(gradients[p.gradient] ?? gradients.spectrum)
      }

      // --- Layout: shift each line, re-anchor, fit ----------------------------
      const half = (viewport.width * p.maxWidth) / 2
      let fits = Infinity
      for (const line of text.lines) {
        const gs = line.glyphs
        if (!gs.length) continue
        const s0 = placed[gs[0].index].scale
        const em = text.fontSize * s0
        const unit = p.gap * em * (1 + p.pump * audio.level)
        const penStart = (i: number) => placed[gs[i].index].x - gs[i].cx * placed[gs[i].index].scale
        const penEnd = (i: number) => penStart(i) + gs[i].advance * placed[gs[i].index].scale

        // Gap before glyph i (leading gap for i = 0), and trailing gap after the last.
        const gapAt = (i: number) => {
          const b = before[gs[i].index].open
          const a = i > 0 ? after[gs[i - 1].index].open : 0
          return (a + b) * unit
        }
        let total = 0
        for (let i = 0; i < gs.length; i++) total += gapAt(i)
        const trailing = after[gs[gs.length - 1].index].open * unit
        total += trailing

        const L = penStart(0), R = penEnd(gs.length - 1)
        // Zoom at which this line, gaps fully open, would just fit.
        const reach = p.anchor === 'left' ? R + total - ax : p.anchor === 'right' ? ax - L + total : Math.max(R, -L) + total / 2
        const limit = p.anchor === 'left' ? half - ax : p.anchor === 'right' ? half + ax : half
        if (reach > 0) fits = Math.min(fits, (zoom * Math.max(0, limit)) / reach)
        const room =
          p.anchor === 'left' ? half - R : p.anchor === 'right' ? half + L : 2 * Math.min(half - R, half + L)
        const fit = total > Math.max(0, room) ? Math.max(0, room) / total : 1
        const anchorShift = p.anchor === 'left' ? 0 : p.anchor === 'right' ? -total * fit : (-total * fit) / 2

        let run = anchorShift
        for (let i = 0; i < gs.length; i++) {
          run += gapAt(i) * fit
          shift[gs[i].index] = run
        }

        // Fill: one rect per open gap (leading, between, trailing).
        if (p.variant === 'track') continue
        const baseline = placed[gs[0].index].y - gs[0].cy * s0
        const y0 = stream ? baseline - text.descent * s0 : baseline + p.barBottom * em
        const y1 = stream ? baseline + text.ascent * s0 : baseline + p.barTop * em
        const inset = stream ? 0 : p.inset * em
        const spanPx = Math.max(1, p.span * em)
        const pushBar = (x0: number, x1: number, side: Side) => {
          const w = x1 - x0 - 2 * inset
          if (w < 0.5) return
          const t1 = side.phase + side.dir * (w / spanPx)
          bars.push({ x: (x0 + x1) / 2, y: (y0 + y1) / 2, w, h: y1 - y0, t0: side.phase, t1, grain: p.grain, feather: 0.5 })
        }
        // A side's bar takes the colour of whichever letter opened it most.
        const owner = (a: Side | null, b: Side) => (a && a.open > b.open ? a : b)
        for (let i = 0; i < gs.length; i++) {
          const g = gs[i]
          const start = penStart(i) + shift[g.index]
          const gw = gapAt(i) * fit
          if (gw > 0.5) pushBar(start - gw, start, owner(i > 0 ? after[gs[i - 1].index] : null, before[g.index]))
          // Stream: active letters' own cells join the clip so their stamp feeds the gap.
          if (stream && activity(units[unitOf[g.index]]) > 0.01) {
            const w = penEnd(i) - penStart(i)
            bars.push({ x: start + w / 2, y: (y0 + y1) / 2, w, h: y1 - y0, t0: 0, t1: 0 })
          }
        }
        const last = gs.length - 1
        const end = penEnd(last) + shift[gs[last].index]
        if (trailing * fit > 0.5) pushBar(end, end + trailing * fit, after[gs[last].index])
      }

      // Shrink quickly as gaps open, grow back slowly as they close.
      const target = Math.min(1, fits)
      zoom += (target - zoom) * (target < zoom ? kOpen : kClose * 0.5)

      // --- Letters ----------------------------------------------------------------
      for (const g of text.glyphs) {
        const pl = placed[g.index]
        const dx = shift[g.index]
        if (stream) {
          const u = units[unitOf[g.index]]
          const band = bandOf(u)
          const emission = Math.min(1, p.base + p.bands * band * band + p.hits * u.hit)
          const ui = unitOf[g.index]
          const hue = p.colourBy === 'cycle' ? ui % MULTI_RAMPS : u.hue
          // (An instrument's letters take its ramp: see PART_CODE.)
          writeGlyph(layers.glyphs, g, pl, { dx, r: activity(u), g: emission, b: u.part >= 0 ? PART_CODE + u.part + 0.5 : (hue + 0.5) / MULTI_RAMPS, a: 1 })
        } else {
          writeGlyph(layers.glyphs, g, pl, { dx, r: ink[0], g: ink[1], b: ink[2], a: 1 })
        }
      }
    },
  }
}

export const gap: ModeDefinition = { id: 'gap', label: 'Gap', params, groups, presets: gapPresets, create }
