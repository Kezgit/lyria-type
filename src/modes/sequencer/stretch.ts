import type { ParamDef, ParamSchema } from '../../app/params'
import { MAX_LANES, MULTI_RAMPS } from '../../engine/stretchFx'
import { writeOutline } from '../shared/glyphs'
import { ramps, stretch as stretchMode } from '../stretch'
import { ORDER } from './barcode'
import type { Composition } from './composition'
import type { SubMode, SubInstance } from './index'

// Stretch: the whole track run through Stretch's feedback, one lane per
// letter, and held as one picture. A column of letters (a–z) stands at one
// side of the page; every note of the score belongs to a lane (by stem, then
// high to low pitch within it). The track is read once into a timeline (per
// lane, per column: how hard the letter is hit, and its emission), and
// StretchFx bakes it a column per pass: the history moves one column away
// from the letters and every lit letter stamps itself in, so the bars are
// the letters pulled out across the page with their hits, smears and trails
// accumulated exactly as Stretch makes them — only along the song instead of
// the clock. Time runs towards the letters. Once baked it holds; playback
// lights the letters sounding and the column under the playhead.

const LANES: Record<string, string> = {
  'a–z': 'abcdefghijklmnopqrstuvwxyz',
  'A–Z': 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
  'a–m': 'abcdefghijklm',
  '0–9': '0123456789',
}

/** Ramps in the order StretchFx's multi slots hold them. */
const MULTI_GOOGLE = [ramps['google-blue'], ramps['google-red'], ramps['google-yellow'], ramps['google-green']]
/** Multi slot per stem (ORDER): vocals blue, instruments yellow, drums red, bass green. */
const STEM_SLOT = [0, 2, 1, 3]

/** One of Stretch's controls, under its own default. */
const from = (k: string, value?: unknown, label?: string): ParamDef => {
  const def = stretchMode.params[k]
  return { ...def, ...(value !== undefined ? { value } : {}), label: label ?? def.label ?? k } as ParamDef
}

const params: ParamSchema = {
  lanes: { type: 'select', value: LANES['a–z'], options: LANES },
  side: {
    type: 'select', value: 'right',
    options: { 'Right (time → letters)': 'right', 'Left (letters ← time)': 'left', 'Centre (trails both ways, to both edges)': 'centre' },
  },
  offset: { type: 'number', value: 0, min: -0.5, max: 0.5, step: 0.005, label: 'move letters across (× width)' },
  stagger: { type: 'number', value: 0, min: 0, max: 1, step: 0.005, label: 'stagger letters (× width)' },
  staggerShape: {
    type: 'select', value: 'alternate', label: 'stagger pattern',
    options: { 'alternate (two columns)': 'alternate', 'steps (a staircase)': 'steps', 'wave': 'wave', random: 'random', 'by stem (one column each)': 'stem' },
  },
  size: { type: 'number', value: 0.85, min: 0.3, max: 3, step: 0.01, label: 'letter size (× lane)' },
  inset: { type: 'number', value: 0.04, min: 0, max: 0.3, step: 0.005, label: 'inset (× width)' },
  padding: { type: 'number', value: 0.05, min: 0, max: 0.3, step: 0.005, label: 'padding (× height)' },

  from: { type: 'number', value: 0, min: 0, max: 256, step: 1, label: 'from (bar)' },
  span: { type: 'number', value: 0, min: 0, max: 128, step: 1, label: 'span (bars, 0 = all)' },
  columns: { type: 'number', value: 480, min: 32, max: 2048, step: 16, label: 'columns (passes)' },

  ramp: from('ramp'),
  colourBy: {
    type: 'select', value: 'ramp', label: 'colour by',
    options: { 'Single ramp': 'ramp', Stems: 'stems', 'Cycle Google': 'cycle' },
  },

  trail: { type: 'number', value: 3, min: 0.1, max: 64, step: 0.1, label: 'trail (steps)' },
  age: { type: 'number', value: 0, min: 0, max: 1, step: 0.01, label: 'fade with age' },
  spread: from('spread', 0.04),
  smear: from('smear', 0.2),

  base: from('base', 0.12),
  hits: from('hits', 0.9),
  velocity: { type: 'number', value: 0.5, min: 0, max: 1, step: 0.01, label: 'velocity response' },
  release: { type: 'number', value: 2, min: 0.1, max: 32, step: 0.1, label: 'release (steps)' },
  sustain: { type: 'number', value: 0.35, min: 0, max: 1, step: 0.01, label: 'held note sustain' },
  gamma: from('gamma'),

  light: { type: 'number', value: 0.6, min: 0, max: 1, step: 0.01, label: 'playhead light' },
  lightWidth: { type: 'number', value: 1.5, min: 0.25, max: 16, step: 0.25, label: 'playhead width (columns)' },

  letters: from('letters', 'hit'),
  letterLift: { type: 'number', value: 0.25, min: -1, max: 1, step: 0.01, label: 'letter in trail: lighter (+) / darker (−)', showIf: { key: 'letters', is: 'trail' } },
  rebuild: {
    type: 'select', value: 'flow', label: 'on a change',
    options: { 'flow (the new picture pushes the old out)': 'flow', 'redraw from empty': 'restart' },
  },
  rebuildSpeed: { type: 'number', value: 16, min: 1, max: 96, step: 1, label: 'rebuild speed (columns / frame)' },
  letterColor: from('letterColor'),
  grain: from('grain'),
}

const groups = {
  Lanes: ['lanes', 'side', 'offset', 'stagger', 'staggerShape', 'size', 'inset', 'padding'],
  Window: ['from', 'span', 'columns'],
  Look: ['ramp', 'colourBy'],
  Motion: ['trail', 'age', 'spread', 'smear'],
  Colour: ['base', 'hits', 'velocity', 'release', 'sustain', 'gamma'],
  Playback: ['light', 'lightWidth'],
  Letters: ['letters', 'letterLift', 'letterColor', 'grain'],
  Rebuild: ['rebuild', 'rebuildSpeed'],
}

/** Params that change the baked picture (the rest only change how it is drawn). */
const BAKED = ['lanes', 'side', 'offset', 'stagger', 'staggerShape', 'size', 'inset', 'padding', 'from', 'span', 'columns', 'colourBy', 'trail', 'age', 'spread', 'smear', 'base', 'hits', 'velocity', 'release', 'sustain']

/** Every note's lane, and each lane's stem (ORDER index; -1 when it has no notes). */
function lanesOf(notes: Composition['notes'], count: number) {
  const keyOf = (n: (typeof notes)[number]) => `${n.stem}:${n.voice}:${n.pitch}`
  const distinct = new Map<string, (typeof notes)[number]>()
  for (const n of notes) if (!distinct.has(keyOf(n))) distinct.set(keyOf(n), n)
  // Stems top to bottom, high to low pitch within each.
  const ranked = [...distinct.values()].sort(
    (a, b) => ORDER.indexOf(a.stem) - ORDER.indexOf(b.stem) || b.pitch - a.pitch || a.voice.localeCompare(b.voice),
  )
  const D = ranked.length
  const laneOfKey = new Map<string, number>()
  ranked.forEach((n, r) => {
    // More pitches than lanes: share lanes evenly. Fewer: spread them over the column.
    const lane = D >= count ? Math.floor((r * count) / D) : D > 1 ? Math.round((r * (count - 1)) / (D - 1)) : 0
    laneOfKey.set(keyOf(n), lane)
  })
  const lane = new Int32Array(notes.length)
  const stem = new Int32Array(count).fill(-1)
  notes.forEach((n, i) => {
    lane[i] = laneOfKey.get(keyOf(n))!
    if (stem[lane[i]] < 0) stem[lane[i]] = ORDER.indexOf(n.stem)
  })
  return { lane, stem }
}

/**
 * The track as a timeline for StretchFx: columns x MAX_LANES RGBA, R = how
 * hard the lane's letter stamps (a hit, released over `release`; held notes
 * keep `sustain`), G = its emission (base + hits).
 */
function timelineOf(comp: Composition, lane: Int32Array, L: number, C: number, w0: number, w1: number, p: Record<string, any>) {
  const perCol = (w1 - w0) / C
  const hit = new Float32Array(L * C)
  const held = new Uint8Array(L * C)
  comp.notes.forEach((n, i) => {
    const a = n.step, b = n.step + Math.max(0.5, n.length)
    if (b <= w0 || a >= w1) return
    const l = lane[i]
    const c0 = Math.max(0, Math.floor((a - w0) / perCol))
    const c1 = Math.min(C, Math.max(c0 + 1, Math.ceil((b - w0) / perCol)))
    if (a >= w0) hit[l * C + c0] = Math.max(hit[l * C + c0], 1 - p.velocity + p.velocity * n.velocity)
    for (let c = c0; c < c1; c++) held[l * C + c] = 1
  })
  const data = new Float32Array(C * MAX_LANES * 4)
  const rel = Math.exp(-perCol / p.release)
  for (let l = 0; l < L; l++) {
    let env = 0
    for (let c = 0; c < C; c++) {
      env = Math.max(env * rel, hit[l * C + c])
      const o = (l * C + c) * 4
      data[o] = Math.min(1, 1.4 * Math.max(env, held[l * C + c] ? p.sustain : 0))
      data[o + 1] = Math.min(1, p.base + p.hits * env)
    }
  }
  return { data, perCol }
}

interface Layout {
  /** Per lane: letter placement. */
  letters: { x: number; y: number; scale: number }[]
  /** Where the song spans on the page: x of its start (far edge) and end (at the letters). */
  xStart: number
  xEnd: number
}

function create(): SubInstance {
  let key = ''
  let lane = new Int32Array(0)
  let stem = new Int32Array(0)
  let layout: Layout = { letters: [], xStart: 0, xEnd: 0 }
  let w0 = 0, w1 = 1, C = 1, perCol = 1, step = 1
  let laneCentres: number[] | null = null
  let laneTop = 0, lanePitch = 1
  const live = new Float32Array(MAX_LANES * 2)

  return {
    update(frame, comp, p) {
      const { layers, viewport, audio, background } = frame
      const W = viewport.width, H = viewport.height
      const glyphs = frame.glyphsFor(p.lanes).slice(0, MAX_LANES)
      const L = glyphs.length
      if (!L) return
      const fx = layers.stretch
      const centre = p.side === 'centre'
      const right = p.side === 'right'

      // --- Rebake when the track, the page or a baked setting changes ---------
      const k = `${comp.version}:${W}x${H}:${frame.fontId}:${frame.text.fontSize}:${BAKED.map((b) => p[b]).join()}`
      if (k !== key) {
        key = k
        ;({ lane, stem } = lanesOf(comp.notes, L))
        const pad = H * p.padding
        const pitch = (H - 2 * pad) / L
        const fontPx = pitch * p.size
        const scale = fontPx / (frame.text.fontSize || 1)
        const edge = W * p.inset
        const letterW = Math.max(...glyphs.map((g) => g.advance)) * scale
        const shift = p.offset * W
        const colX = (centre ? -letterW / 2 : right ? W / 2 - edge - letterW : -W / 2 + edge) + shift
        // Stagger: each lane's letter moved along the lane, so the letters stand in columns, steps or a wave.
        const amount = p.stagger * W
        const along = (l: number) => {
          switch (p.staggerShape) {
            case 'steps': return L > 1 ? l / (L - 1) - 0.5 : 0
            case 'wave': return 0.5 * Math.sin((2 * Math.PI * l) / Math.max(1, L))
            case 'random': { const h = Math.sin(l * 127.1 + 31.7) * 43758.5453; return h - Math.floor(h) - 0.5 }
            case 'stem': return Math.max(0, stem[l]) / 3 - 0.5
            default: return l % 2 ? 0.5 : -0.5
          }
        }
        const dxs = glyphs.map((_, l) => amount * along(l))
        layout = {
          letters: glyphs.map((g, l) => {
            // Centre the x-height in the lane (y-up, origin at the page centre).
            const baseline = H / 2 - pad - (l + 0.5) * pitch - 0.27 * fontPx
            const pen = colX + dxs[l] + (letterW - g.advance * scale) / 2
            return { x: pen + g.cx * scale, y: baseline + g.cy * scale, scale }
          }),
          xStart: 0,
          xEnd: right || centre ? colX : colX + letterW,
        }
        // Both ways: each lane's trails flow out from its own letter, to both edges.
        laneCentres = centre ? dxs.map((d) => colX + letterW / 2 + d) : null
        laneTop = H / 2 - pad
        lanePitch = pitch
        C = Math.max(1, Math.round(p.columns))
        // A whole number of device pixels per pass, so the history moves without
        // resampling (a fractional step would blur it a little every pass). Long enough for the trail that
        // has furthest to go (past any stagger) to reach its edge.
        const dpr = Math.min(window.devicePixelRatio, 2)
        const reach = centre
          ? W / 2 + Math.abs(shift) + amount / 2
          : Math.abs(layout.xEnd - (right ? -W / 2 + edge : W / 2 - edge)) + amount / 2
        // (Both ways: rounded up, so every trail reaches its edge, past it if need be.)
        step = Math.max(1, (centre ? Math.ceil : Math.floor)((reach * dpr) / C)) / dpr
        layout.xStart = layout.xEnd + (right || centre ? -1 : 1) * step * C

        const total = comp.length || 16
        w0 = Math.min(Math.max(0, p.from * 16), Math.max(0, total - 16))
        w1 = p.span > 0 ? Math.min(total, w0 + p.span * 16) : total
        const t = timelineOf(comp, lane, L, C, w0, w1, p)
        perCol = t.perCol
        fx.setTimeline(t.data, C, p.rebuild === 'flow')
      }
      fx.bakePerFrame = Math.max(1, Math.round(p.rebuildSpeed))
      // One column per pass, so the first column ends up at the far edge.
      fx.step.value = step
      // Trails last `trail` steps inside the letters; outside, `age` fades the oldest by up to 90%.
      fx.keep.value = Math.exp((-3 * perCol) / p.trail)
      fx.ageKeep.value = Math.pow(1 - 0.9 * p.age, 1 / C)
      fx.spread.value = p.spread
      fx.smear.value = p.smear
      fx.setAxis('horizontal')
      if (right) fx.axis.value.multiplyScalar(-1)
      fx.sided.value = centre ? 1 : 0
      fx.setLaneCentres(laneCentres, laneTop, lanePitch)

      // --- Letters: one per lane; G carries the lane, B the hue ----------------
      layers.glyphs.count = 0
      for (let l = 0; l < L; l++) {
        const hue = p.colourBy === 'stems' ? STEM_SLOT[Math.max(0, stem[l])] : p.colourBy === 'cycle' ? l % MULTI_RAMPS : 0
        const at = layout.letters[l]
        writeOutline(layers.glyphs, glyphs[l], { x: at.x, y: at.y, rotation: 0, scale: at.scale }, {
          r: 1, g: (l + 0.5) / MAX_LANES, b: (hue + 0.5) / MULTI_RAMPS, a: 1,
        })
      }

      // --- Playback: letters sounding, and the column under the playhead -------
      live.fill(0)
      for (let i = 0; i < comp.notes.length; i++) {
        const v = comp.lit[i]
        const l = lane[i]
        if (v > live[l * 2]) {
          live[l * 2] = v
          live[l * 2 + 1] = Math.min(1, p.base + p.hits * v)
        }
      }
      for (let l = 0; l < L; l++) live[l * 2 + 1] = Math.max(live[l * 2 + 1], p.base)
      fx.setLive(live)
      const ph = comp.position
      const inside = ph >= w0 && ph < w1 && fx.baked >= 1
      fx.playheadX.value = inside ? layout.xStart + ((ph - w0) / (w1 - w0)) * (layout.xEnd - layout.xStart) : -1e6
      fx.playheadW.value = Math.max(1, step * p.lightWidth)
      fx.playheadGlow.value = p.light * (0.6 + 0.4 * audio.level)

      fx.enabled = true
      fx.lanesOn = true
      fx.setRamp(ramps[p.ramp] ?? ramps['google-blue'])
      fx.multi.value = p.colourBy === 'ramp' ? 0 : 1
      fx.setMultiRamps(MULTI_GOOGLE)
      fx.gamma.value = p.gamma
      fx.background.value.set(background)
      fx.letterMode.value = { hidden: 0, solid: 1, ramp: 2, hit: 3, trail: 4 }[p.letters as string] ?? 3
      fx.letterLift.value = p.letterLift
      fx.letterColor.value.set(p.letterColor)
      fx.grain.value = p.grain
    },
  }
}

const BLACK = { background: '#000000', fontId: 'google-sans-flex' }

export const stretch: SubMode = {
  id: 'stretch',
  label: 'Stretch',
  params,
  groups,
  presets: {
    // a–z down the right; the whole song pulled out of them through Stretch.
    Default: { params: {}, ...BLACK },
    // Each lane in its stem's Google hue.
    Stems: { params: { colourBy: 'stems', letterColor: '#f8f9fc' }, ...BLACK },
    // Letters on the left, the song reading back from them.
    'From the left': { params: { side: 'left' }, ...BLACK },
    // Long, melting trails: hits bleed into soft bands.
    Melt: { params: { trail: 10, release: 6, smear: 2.5, spread: 0.6, gamma: 1.6 }, ...BLACK },
    // Eight bars close up: every hit's letter shape readable in the bars.
    'Close-up': { params: { from: 8, span: 8, columns: 640, trail: 2, smear: 0.4, spread: 0.05 }, ...BLACK },
    // Dark letters, pale blue bars on a light page.
    Paper: { params: { ramp: 'google-blue-light', letterColor: '#121317', grain: 0.04 }, background: '#f8f9fc', fontId: 'google-sans-flex' },
  },
  create,
}
