import type { ParamDef } from '../../app/params'
import { LAYERS } from '../../audio/analysis/listener'
import type { StretchAxis } from '../../engine/stretchFx'
import type { ModeDefinition, ModeInstance, ModePreset } from '../types'
import { writeGlyph } from '../shared/glyphs'
import { Conductor, rackFeed } from './conductor'
import { PALETTES, colourKey, parseAssign, rampFor, regions } from './layers'
import { listenForKeys, manualKeys } from './keys'
import house from './house.json'
import { editMap, remap } from '../shared/remap'
import { FLOW_LINES } from '../../engine/stretchFx'
import type { Placement } from '../../layout/types'

// The page as an orchestra, for any song. The listener hears the mix as
// layers (kick, snare, hats, bass, lead, pad, fx); each layer plays its own
// letters in its own way (conductor.ts), drawn as Stretch trails: the letters
// are the source; while a layer plays its letters, a wall of colour pours out
// of them and keeps pouring until the note stops, like a held piano key; then
// it travels on and fades. With depth it rushes toward you, widening as it
// comes (light bars off the back of a bike, the Netflix ribbons).
// Every letter belongs to one layer and keeps its colour. Lit letters can be
// pushed by their hit (displacement).
// Per-layer sensitivity and gates live on the rack; letters are given to
// layers by dragging over them on the stage.

/** How strongly a lit letter of each layer (LAYERS order) pours into its wall: hats flicker lightly, heavy parts pour. */
const LAYER_POUR = [1, 1, 0.35, 0.9, 0.85, 0.7, 0.75]
/** How hard each layer pushes its letters when it plays: heavy hits shove, hats barely nudge (they flutter instead). */
const LAYER_PUSH = [1, 0.8, 0.25, 0.9, 0.5, 0.4, 0.5]
/**
 * Artifact notes per instrument (LAYERS order): how long (steps) and how often, as on a piano roll.
 * Bass and pads hold long, hats are short and busy, snares come less often. `NOTE_TYPICAL` is each
 * one's usual note (s): notes really played longer or shorter than that stretch or shrink them.
 */
const NOTE_LEN = [0.75, 1, 0.5, 2.5, 1.3, 3.5, 1.2]
const NOTE_DENSITY = [0.8, 0.45, 1.3, 0.7, 1, 0.5, 0.7]
const NOTE_TYPICAL = [0.15, 0.2, 0.08, 0.5, 0.3, 1, 0.4]
/** Drums have no pitch: on the piano roll the kick sits low, the snare in the middle, hats high. */
const DRUM_ROW = [0.06, 0.45, 0.85]

/** 0..1 lightness of a #rrggbb colour. */
function luminance(hex: string) {
  const n = parseInt(hex.slice(1), 16)
  return (0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255
}

/** How brightly each layer's letters burn (more light = more bloom): heavy hits glow, small ones flash. */
const LAYER_LIGHT = [1, 0.95, 0.6, 0.85, 0.75, 0.7, 0.75]

/**
 * How a layer's letters move when it plays. Default is the usual mix (a push
 * along the wall, hats shivering); the rest are one behaviour each:
 *   push    shoved along their wall, springing back
 *   bounce  hop up and settle
 *   roll    a wave runs across the layer's letters, one after another
 *   swell   grow, then ease back
 *   tilt    rock, alternate letters opposite ways
 *   still   don't move
 */
const LETTER_MOVES = { Default: 'default', Push: 'push', Bounce: 'bounce', 'Roll across': 'roll', Swell: 'swell', Tilt: 'tilt', Still: 'still' }
const LAYER_LABEL: Record<string, string> = { kick: 'kick', snare: 'snare', hat: 'hats', bass: 'bass', lead: 'lead', pad: 'pad', fx: 'fx' }

const layerParams = Object.fromEntries(
  LAYERS.flatMap((l, i) => [
    [`${l}Sens`, { type: 'number', value: 1, min: 0, max: 2, step: 0.01 }],
    [`${l}Gate`, { type: 'number', value: 0.15, min: 0, max: 1, step: 0.01 }],
    [colourKey(l), { type: 'color', value: PALETTES.google[i] }],
    [`${l}On`, { type: 'boolean', value: true }],
    [`${l}Move`, { type: 'select', value: 'default', label: `${LAYER_LABEL[l]} moves letters`, options: LETTER_MOVES }],
    [`${l}MoveAmt`, { type: 'number', value: 1, min: 0, max: 3, step: 0.01, label: `${LAYER_LABEL[l]} move amount` }],
    // Notes placed by hand on the rack's 16 steps ('1' = a note), played every bar alongside what is heard.
    [`${l}Steps`, { type: 'text', value: '0'.repeat(16) }],
  ]),
) as Record<string, ParamDef>

const params = {
  palette: {
    type: 'select', value: 'google',
    options: { Google: 'google', Sunset: 'sunset', Ocean: 'ocean', Ember: 'ember', Mono: 'mono', Spectrum: 'spectrum', 'Wave candy': 'candy', Pastel: 'pastel' },
  },
  light: { type: 'boolean', value: false, label: 'light background' },
  vibrance: { type: 'number', value: 0.5, min: 0, max: 1, step: 0.01, label: 'vibrance' },
  threshold: { type: 'number', value: 0, min: 0, max: 0.95, step: 0.01, label: 'threshold (hard edges, 0 = off)' },
  letters: { type: 'boolean', value: true, label: 'show letters' },
  letterColor: { type: 'color', value: '#5f6368', label: 'resting letters' },
  trailOver: { type: 'boolean', value: false, label: 'trails over letters' },
  glow: { type: 'number', value: 0.8, min: 0, max: 2, step: 0.01, label: 'bloom' },
  glowThreshold: { type: 'number', value: 0.04, min: 0, max: 1, step: 0.01, label: 'bloom threshold' },
  letterGlow: { type: 'number', value: 0.8, min: 0, max: 2, step: 0.01, label: 'letter glow' },
  glowEdge: { type: 'select', value: 'inner', label: 'letter glow edge', options: { Inner: 'inner', Outer: 'outer', Both: 'both' } },

  direction: {
    type: 'select', value: 'out', label: 'wall direction',
    options: { 'Outward': 'out', Up: 'up', Down: 'down', 'Both sides': 'sides', 'Up and down': 'updown' },
  },
  speed: { type: 'number', value: 420, min: 40, max: 1500, step: 1, label: 'speed (px/s)' },
  trail: { type: 'number', value: 1.8, min: 0.2, max: 8, step: 0.05, label: 'decay (s)' },
  perspective: { type: 'number', value: 0.5, min: 0, max: 2, step: 0.01, label: 'depth (toward you)' },
  split: { type: 'number', value: 0.35, min: 0, max: 1, step: 0.01, label: 'split at the end' },
  splitAt: { type: 'number', value: 0.45, min: 0.05, max: 1.2, step: 0.01, label: 'split from (× view)' },
  gloss: { type: 'number', value: 0.5, min: 0, max: 1, step: 0.01 },
  softness: { type: 'number', value: 0.4, min: 0, max: 3, step: 0.01, label: 'trail softness' },
  noteGap: { type: 'number', value: 0.5, min: 0, max: 1, step: 0.01, label: 'seams between notes' },
  colourBlend: { type: 'number', value: 40, min: 0, max: 200, step: 1, label: 'colours mix where layers meet (px)' },
  artifacts: { type: 'number', value: 0, min: 0, max: 1, step: 0.01, label: 'artifacts (miscoded specks)' },
  artifactSize: { type: 'number', value: 2, min: 1, max: 16, step: 0.5, label: 'artifact size (px)' },
  artifactSoftness: { type: 'number', value: 0, min: 0, max: 3, step: 0.01, label: 'artifact softness' },
  artifactPattern: {
    type: 'select', value: 'scatter', label: 'artifact pattern',
    options: { Scatter: 'scatter', 'Staircases': 'staircase', Chords: 'chords', 'Repeated runs': 'runs', 'Follow the music': 'follow' },
  },
  artifactLength: { type: 'number', value: 1, min: 0.25, max: 6, step: 0.05, label: 'artifact note length (steps)' },
  artifactByInstrument: { type: 'boolean', value: true, label: 'artifacts sized by instrument' },
  artifactShape: { type: 'select', value: 'blocks', label: 'artifact shape', options: { Blocks: 'blocks', Pills: 'pills', 'Droplets (merge)': 'droplets' } },
  roundness: { type: 'number', value: 0, min: 0, max: 1, step: 0.01, label: 'rounded trails (droplets)' },
  fluid: { type: 'number', value: 0, min: 0, max: 1, step: 0.01, label: 'fluid colour (notes take on what they flow into)' },
  fluidSpeed: { type: 'number', value: 1, min: 0.1, max: 5, step: 0.05, label: 'fluid colour speed' },
  artifactGaps: { type: 'number', value: 0.4, min: 0, max: 1, step: 0.01, label: 'artifact gaps' },
  seamSpacing: { type: 'number', value: 1, min: 0.25, max: 4, step: 0.05, label: 'seam spacing' },
  seamJitter: { type: 'number', value: 0.3, min: 0, max: 1, step: 0.01, label: 'seam randomness' },

  colourBy: {
    type: 'select', value: 'layer', label: 'colour by',
    options: { 'Each layer its own colour': 'layer', 'Sections by loudness': 'velocity', 'Sections along the flow': 'flow' },
  },
  sectionSize: { type: 'number', value: 60, min: 8, max: 400, step: 1, label: 'section length (px)' },
  sectionBlend: { type: 'number', value: 0.3, min: 0, max: 1, step: 0.01, label: 'section blend (hard → gradient)' },
  sectionSpread: { type: 'number', value: 3, min: 1, max: 7, step: 1, label: 'colours per section run' },

  grid: { type: 'number', value: 0, min: 0, max: 1, step: 0.01, label: 'grid (0 = off)' },
  gridStyle: { type: 'select', value: 'lines', label: 'grid style', options: { 'Lines and dots': 'lines', 'Dots only': 'dots' } },
  gridSize: { type: 'number', value: 22, min: 8, max: 80, step: 1, label: 'grid cell (px)' },
  gridOver: { type: 'number', value: 0.4, min: 0, max: 1, step: 0.01, label: 'grid over notes' },
  artifactColour: {
    type: 'select', value: 'miscoded', label: 'artifact colour',
    options: { 'Miscoded (another layer)': 'miscoded', 'Tonal (a shade of what it sits on)': 'tonal', 'Mask (background)': 'mask' },
  },
  seeThrough: { type: 'number', value: 0.45, min: 0, max: 1, step: 0.01, label: 'see notes underneath' },



  wholeBlock: { type: 'boolean', value: false, label: 'whole block is the instrument' },
  typingPlays: { type: 'boolean', value: false, label: 'typing plays the letters' },
  reflow: { type: 'number', value: 0.35, min: 0, max: 1.5, step: 0.01, label: 'reflow glide (s)' },
  reveal: { type: 'number', value: 0.3, min: 0, max: 1.5, step: 0.01, label: 'new letters blur in (s)' },
  typingNote: { type: 'boolean', value: true, label: 'cursor plays notes as you type' },
  cursorLevel: { type: 'number', value: 0.8, min: 0.05, max: 1, step: 0.01, label: 'cursor notes strength' },
  cursorRate: { type: 'number', value: 0.5, min: 0.1, max: 4, step: 0.05, label: 'cursor notes per beat step' },
  cursorSweep: { type: 'number', value: 0.3, min: 0, max: 1.5, step: 0.01, label: 'new line sweep (s, 0 = off)' },
  rowSeparate: { type: 'number', value: 0.8, min: 0, max: 1, step: 0.01, label: 'keep rows apart' },
  displace: { type: 'boolean', value: true, label: 'beats push letters' },
  push: { type: 'number', value: 14, min: 0, max: 80, step: 0.5, label: 'push (px)' },


  keyboard: { type: 'boolean', value: true, label: 'play with keyboard' },
  sensitivity: { type: 'number', value: 1, min: 0.2, max: 3, step: 0.01 },
  peak: { type: 'number', value: 0.6, min: 0, max: 2, step: 0.01, label: 'peak strength' },
  peakAt: { type: 'number', value: 4.5, min: 2, max: 7, step: 0.1, label: 'peak at (layers)' },

  // Letters given to layers used to live here; they're shared by every mode now (state.letterParts),
  // and this only carries an older setup over on load.
  assign: { type: 'text', value: '' },
  ...layerParams,
} as const

/**
 * The house look, tuned in the app and saved from it (house.json: every
 * setting as it was). These are the defaults, so a fresh page starts here.
 * Settings added since keep their own defaults.
 */
const HOUSE: Record<string, unknown> = house
for (const [k, v] of Object.entries(HOUSE)) {
  const def = (params as Record<string, { value: unknown } | undefined>)[k]
  if (def) def.value = v
}

const groups = {
  Look: ['threshold', 'light', 'vibrance', 'palette', 'letters', 'letterColor', 'trailOver', 'glow', 'glowThreshold', 'letterGlow', 'glowEdge'],
  Trails: ['direction', 'speed', 'trail', 'perspective', 'split', 'splitAt', 'gloss', 'softness'],
  Notes: ['noteGap', 'seamSpacing', 'seamJitter', 'seeThrough', 'colourBlend', 'fluid', 'fluidSpeed', 'roundness'],
  Artifacts: ['artifacts', 'artifactPattern', 'artifactShape', 'artifactColour', 'artifactSize', 'artifactLength', 'artifactByInstrument', 'artifactGaps', 'artifactSoftness'],
  'Colour sections': ['colourBy', 'sectionSize', 'sectionBlend', 'sectionSpread'],
  Grid: ['grid', 'gridStyle', 'gridSize', 'gridOver'],
  Letters: ['wholeBlock', 'typingPlays', 'typingNote', 'cursorLevel', 'cursorRate', 'cursorSweep', 'reveal', 'reflow', 'rowSeparate', 'displace', 'push', 'keyboard'],
  'Letter moves': LAYERS.flatMap((l) => [`${l}Move`, `${l}MoveAmt`]),
  Response: ['sensitivity', 'peak', 'peakAt'],
}

const dark = { background: '#000000', fontId: 'google-sans-flex', fontSize: 72 }
const presets: Record<string, ModePreset> = {
  // The house look (the defaults) on its white page.
  'House look': { params: {}, background: '#ffffff', fontId: 'google-sans-flex', fontSize: 72 },
  // Walls of colour pour out of the letters while their parts play, rushing toward you.
  'Wall of sound': { params: {}, ...dark },
  // Light bars: big, glossy, deep, long, coming straight at you.
  'Light ribbons': {
    params: { perspective: 1.4, speed: 520, trail: 3, gloss: 0.9, split: 0.6, splitAt: 0.25, softness: 0.25, glow: 1.3, letterGlow: 1 },
    ...dark,
  },
  // The walls rise off the text.
  'Wall rising': { params: { direction: 'up', speed: 360, trail: 2.2, split: 0.5, splitAt: 0.35, perspective: 0 }, ...dark },
  // Held notes stream out to both sides, like a held chord.
  'Wall to the sides': { params: { direction: 'sides', speed: 300, trail: 2.6, split: 0.25, perspective: 0 }, ...dark },
  // No letters: only the walls they pour.
  'Streams only': { params: { letters: false, trail: 2.6, glow: 1.2 }, ...dark },
}

/** Wall direction -> Stretch axis, flipped, both ways. */
const WALL: Record<string, [StretchAxis, boolean, boolean]> = {
  out: ['radial', false, false],
  up: ['vertical', false, false],
  down: ['vertical', true, false],
  sides: ['horizontal', false, true],
  updown: ['vertical', false, true],
}

function create(): ModeInstance {
  listenForKeys()
  const conductor = new Conductor()
  let key = ''
  let map = regions({ glyphs: [], lines: [] } as any, new Int8Array(0))
  let palette = ''
  /** The light-background toggle last frame (null until the first), so only a change repaints the page. */
  let wasLight: boolean | null = null
  let look = ''
  let clock = 0
  let shove = new Float32Array(0)
  // Each note a letter plays gets its own number (1..30, reused), so the trail keeps notes apart.
  let noteOf = new Uint8Array(0)
  let litBefore = new Float32Array(0)
  let notes = 0
  /** Each letter's place among its layer's letters (reading order); when each layer last struck a note, and how hard. */
  let order = new Int16Array(0)
  const layerHit = new Float32Array(LAYERS.length).fill(-1e3)
  const layerHitAmt = new Float32Array(LAYERS.length)
  let spin = new Float32Array(0)
  /** When each letter's note began; each layer's notes' recent length (s), as played. */
  let noteStart = new Float32Array(0)
  // Typing: the text as it was (its letters), where each letter is drawn now (gliding to where the layout
  // puts it), and how much a just-typed letter is still sounding.
  let chars: string | null = null
  let assigned = ''
  let ex = new Float32Array(0)
  let ey = new Float32Array(0)
  let typed = new Float32Array(0)
  /** Each letter's line last frame; how far into its reveal (blur to clear) it is, 0..1 (below 0: waiting). */
  let lineOf = new Int16Array(0)
  let shown = new Float32Array(0)
  /** The letter last typed (the cursor's), when, and the cursor note's pulse count. */
  let caret = -1
  let typedAt = -1e3
  let pulses = 0
  /** Letters typed in the current burst: they haven't joined the music yet, so they lay no trail. */
  let fresh = new Uint8Array(0)
  // The cursor note: where its bar is (eased toward where it should be), and the notes flying off it.
  const bar = { x0: 0, x1: 0, y: 0, hh: 0, alpha: 0, blur: 0, code: 0.5 }
  let caretLine = -1
  /** What the letter being typed plays this frame: how strongly it pours, and its note (a new one each pulse). */
  let caretPour = 0
  let caretNote = 1
  let introAt = -1e3
  let introLeft = 0
  let introRight = 0
  let beatBefore = 0
  const layerDur = Float32Array.from(NOTE_TYPICAL)

  return {
    update({ audio, text, base, params: p, layers, dt, viewport, background, setBackground, parts: given }) {
      // Letters given to layers on the stage (shared by every mode).
      const assign = given.key
      clock += dt
      // Letters per layer: re-read when the text or the assignments change.
      const k = `${text.glyphs.length}:${text.lines.length}:${assign}`
      if (k !== key) {
        key = k
        map = regions(text, parseAssign(assign, text.glyphs.length))
        // An edit of the text carries every letter's state over (letters after the edit keep theirs, just
        // typed ones start fresh), so typing never wipes the orchestra; new assignments start it afresh.
        const now = text.glyphs.map((g) => g.char).join('')
        const from = editMap(chars ?? now, now)
        if (chars === null || assign !== assigned) {
          conductor.reset()
        }
        conductor.remapLetters(from)
        shove = remap(shove, from)
        noteOf = remap(noteOf, from)
        litBefore = remap(litBefore, from)
        spin = remap(spin, from)
        noteStart = remap(noteStart, from)
        typed = remap(typed, from)
        ex = remap(ex, from, NaN)
        ey = remap(ey, from, NaN)
        lineOf = remap(lineOf, from, -1)
        fresh = remap(fresh, from, 1)
        shown = remap(shown, from, 1)
        if (chars !== null) {
          // Just typed: it blurs into view (and, with typing plays on, sounds), and waits to join the music.
          let newest = -1
          from.forEach((f, i) => {
            if (f >= 0) return
            if (p.typingPlays) typed[i] = 1
            shown[i] = -0.25
            newest = Math.max(newest, i)
          })
          if (newest >= 0) {
            caret = newest
            typedAt = clock
          }
        } else fresh.fill(0)
        chars = now
        assigned = assign
        order = new Int16Array(text.glyphs.length)
        for (const l of LAYERS) map.parts[l].forEach((g, k) => (order[g.index] = k))
      }
      // Letters glide to where the layout puts them (a reflow moves them smoothly into new lines);
      // each line's move this frame goes to the trails, so the bars glide with their lines.
      const glide = p.reflow > 0.01 ? 1 - Math.exp(-dt / (p.reflow / 3)) : 1
      const lineY = new Float32Array(FLOW_LINES)
      const lineDx = new Float32Array(FLOW_LINES)
      const lineDy = new Float32Array(FLOW_LINES)
      const lineCount = new Float32Array(FLOW_LINES)
      const reveal = Math.max(0.01, p.reveal)
      // How far the block is still gliding (where its settled letters are drawn against where they're going),
      // so letters joining a new line ride the same glide instead of landing on the line above.
      let lagY = 0
      let lagN = 0
      for (const g of text.glyphs) {
        const i = g.index
        if (lineOf[i] === g.line && !Number.isNaN(ey[i])) {
          lagY += ey[i] - base[i].y
          lagN++
        }
      }
      lagY = lagN ? lagY / lagN : 0
      const placed: Placement[] = text.glyphs.map((g) => {
        const i = g.index
        const b = base[i]
        // A letter that moved to another line doesn't glide across the rows (that smears trails through
        // them): it appears in its new line, blurring in, its notes first; a brand-new line waits a beat more.
        if (lineOf[i] >= 0 && lineOf[i] !== g.line) {
          ex[i] = NaN
          // (A new line's letters wait for the cursor note to sweep across it and settle.)
          shown[i] = g.line >= text.lines.length - 1 ? -0.32 / reveal : -0.25
          if (p.typingPlays) typed[i] = Math.max(typed[i], 0.8)
        }
        lineOf[i] = g.line
        shown[i] = Math.min(1, shown[i] + dt / reveal)
        if (Number.isNaN(ex[i])) {
          ex[i] = b.x
          ey[i] = b.y + lagY
        }
        const dx = (b.x - ex[i]) * glide
        const dy = (b.y - ey[i]) * glide
        ex[i] += dx
        ey[i] += dy
        const line = Math.min(FLOW_LINES - 1, g.line)
        lineY[line] += ey[i]
        lineDx[line] += dx
        lineDy[line] += dy
        lineCount[line]++
        typed[i] *= Math.exp(-dt / 0.35)
        return { x: ex[i], y: ey[i], rotation: b.rotation, scale: b.scale }
      })
      base = placed
      const parts = map.parts
      // Picking a palette recolours every layer (colours can still be changed one by one after).
      if (palette && p.palette !== palette) PALETTES[p.palette]?.forEach((c, i) => (p[colourKey(LAYERS[i])] = c))
      palette = p.palette
      // Light / dark page: flipping the toggle repaints the background (it can still be set by hand after).
      if (wasLight !== null && wasLight !== !!p.light) setBackground(p.light ? '#ffffff' : '#000000')
      wasLight = !!p.light

      manualKeys.enabled = !!p.keyboard
      // The walls pour out of the letters, away from the middle of the page.
      const wall = true
      const point: [number, number] = [0, 0]
      conductor.update(audio, text, base, p, dt, parts)
      const u = conductor.unison * p.peak

      // At a peak, every letter whose layer is sounding glows together.
      const together = new Float32Array(text.glyphs.length)
      if (u > 0.01) {
        for (const l of LAYERS) {
          const v = u * 0.4 * rackFeed.parts[l].level
          if (v > 0.01) for (const g of parts[l]) together[g.index] = Math.max(together[g.index], v)
        }
      }

      const [axis, flip, both] = WALL[p.direction] ?? WALL.out
      /** Which way a letter is pushed: the way its wall pours (outward from the centre for radial / both-way walls). */
      const pushDir = (x: number, y: number): [number, number] => {
        if (!wall || axis === 'radial') {
          const d = Math.hypot(x - point[0], y - point[1]) || 1
          return [(x - point[0]) / d, (y - point[1]) / d]
        }
        if (axis === 'vertical') return [0, both ? Math.sign(y - point[1]) || 1 : flip ? -1 : 1]
        return [both ? Math.sign(x - point[0]) || 1 : 1, 0]
      }

      // Letters: resting until their layer plays them; always their own layer's colour.
      for (const g of text.glyphs) {
        const i = g.index
        // Whole block: a letter is the colour of whichever layer lit it last; otherwise its own layer's.
        const li = p.wholeBlock ? Math.round(conductor.layer[i]) || 0 : map.owner[i] >= 0 ? map.owner[i] : 0
        // A letter just typed sounds briefly, like a note.
        // The letter being typed is the cursor: it plays (quietly, a new note each pulse) while typing goes on.
        const isCaret = i === caret && caretPour > 0
        if (isCaret) noteOf[i] = caretNote
        const lit = Math.max(conductor.light[i], together[i], typed[i] * 0.85, isCaret ? caretPour : 0)
        // A new note: the letter lights from rest, or is struck again while still ringing.
        if (lit > 0.05 && (litBefore[i] <= 0.05 || lit - litBefore[i] > 0.2)) {
          // The note before it (if still ringing) ends here.
          if (litBefore[i] > 0.05) layerDur[li] += (clock - noteStart[i] - layerDur[li]) * 0.2
          noteOf[i] = notes = (notes % 30) + 1
          noteStart[i] = clock
          layerHit[li] = clock
          layerHitAmt[li] = lit
        } else if (lit <= 0.05 && litBefore[i] > 0.05) {
          layerDur[li] += (clock - noteStart[i] - layerDur[li]) * 0.2
        }
        litBefore[i] = lit
        // Letters still being typed lay no trail until typing pauses (then they join the music).
        const pour = isCaret ? Math.max(caretPour, fresh[i] ? 0 : Math.min(1, lit * LAYER_POUR[li])) : fresh[i] ? 0 : wall ? Math.min(1, lit * LAYER_POUR[li] * (1 + 0.3 * u)) : lit * 0.7
        const at = base[i]
        // Push: a hit shoves its letters along their wall, springing back as it fades.
        const target = p.displace ? p.push * Math.pow(lit, 0.8) * LAYER_PUSH[li] : 0
        shove[i] += (target - shove[i]) * (1 - Math.exp(-dt / (target > shove[i] ? 0.03 : 0.16)))
        const [ux, uy] = pushDir(at.x, at.y)
        // Hats flutter: a quick shiver up and down as they pass.
        const jolt = conductor.jolt[i]
        const flutter = jolt > 0.01 ? jolt * 3 * Math.sin(clock * 55 + i * 1.7) * at.scale : 0
        // How this layer moves its letters (see LETTER_MOVES).
        const move = (p[`${LAYERS[li]}Move`] as string) ?? 'default'
        const amt = (p[`${LAYERS[li]}MoveAmt`] as number) ?? 1
        let mx = 0
        let my = 0
        let grow = 1
        if (move === 'default') {
          mx = ux * shove[i] * amt
          my = (uy * shove[i] + flutter) * amt
        } else if (move === 'push') {
          mx = ux * shove[i] * amt
          my = uy * shove[i] * amt
        } else if (move === 'bounce') {
          my = shove[i] * amt
        } else if (move === 'roll') {
          // A wave running across the layer's letters from its last hit, each a beat after the one before.
          const t = clock - layerHit[li] - order[i] * 0.045
          if (t > 0 && t < 1.5) my = p.push * 0.6 * amt * layerHitAmt[li] * Math.exp(-t * 5) * Math.sin(t * 22)
        } else if (move === 'swell') {
          grow = 1 + 0.18 * amt * Math.pow(lit, 0.8)
        }
        // Tilt eases toward its lean and back, alternate letters opposite ways.
        const lean = move === 'tilt' ? 0.14 * amt * lit * (order[i] % 2 ? 1 : -1) : 0
        spin[i] += (lean - spin[i]) * (1 - Math.exp(-dt / 0.06))
        // Blur to clear: transparent and soft at first, sharpening into place.
        const clear = Math.max(0, shown[i])
        const eased = clear * clear * (3 - 2 * clear)
        writeGlyph(layers.glyphs, g, at, {
          dx: mx, dy: my, scale: grow, rotation: spin[i], blur: (1 - eased) * 7,
          r: pour, g: Math.min(1, (0.25 + 0.6 * lit) * LAYER_LIGHT[li] + 0.15 * lit), b: noteOf[i] * 8 + li + 0.5, a: 0.12 + 0.88 * eased,
        })
      }

      const fx = layers.stretch
      fx.enabled = true
      const nextLook = `wall:${p.direction}`
      if (nextLook !== look) {
        look = nextLook
        fx.reset()
      }
      const view = Math.min(viewport.width, viewport.height) / 2
      fx.vp.value.set(point[0], point[1])
      fx.pump.value = 0
      fx.pumpCentre.value.set(point[0], point[1])
      fx.roll.value = 0
      fx.spread.value = p.softness
      {
        // The wall pours out of the letters at `speed`, a little faster at a
        // peak or under held bass. Depth makes it rush toward you: everything
        // expands from the centre, faster and wider the further out it is.
        fx.setAxis(axis)
        if (flip) fx.axis.value.multiplyScalar(-1)
        fx.sided.value = both ? 1 : 0
        // Step and depth speed up together, so a wall's path stays a straight line.
        const pace = 1 + 0.5 * u + 0.6 * conductor.rush
        fx.step.value = p.speed * dt * pace
        fx.zoom.value = -0.9 * p.perspective * dt * pace
        fx.twist.value = 0
        fx.depthFade.value = 0
        fx.keep.value = Math.exp((-3 * dt) / (p.trail * (1 + 0.8 * u)))
        fx.smear.value = 1 + 3 * conductor.rush
        fx.swirl.value = 0
      }
      fx.swirlPhase.value = conductor.swirlPhase
      fx.swirlAngle.value = conductor.swirlAngle
      fx.glow.value = p.glow * (1 + 0.5 * Math.min(1, u))
      fx.letterGlow.value = p.letterGlow
      fx.letterGlowMode.value = { inner: 0, outer: 1, both: 2 }[p.glowEdge as string] ?? 0
      fx.trailOver.value = p.trailOver ? 1 : 0
      fx.gloss.value = p.gloss
      fx.layering.value = wall ? 1 : 0
      fx.noteGap.value = p.noteGap
      fx.seeThrough.value = p.seeThrough
      fx.colourBlend.value = p.colourBlend
      // Artifacts thicken a little as the music gets louder.
      fx.artifacts.value = p.artifacts * (0.7 + 0.6 * Math.min(1, audio.level))
      fx.artifactSize.value = p.artifactSize
      fx.glowThreshold.value = p.glowThreshold
      fx.vibrance.value = p.vibrance
      fx.artifactPattern.value = { scatter: 0, staircase: 1, chords: 2, runs: 3, follow: 4 }[p.artifactPattern as string] ?? 0
      fx.artifactLength.value = p.artifactLength
      fx.artifactByInstrument.value = p.artifactByInstrument ? 1 : 0
      fx.artifactShape.value = { blocks: 0, pills: 1, droplets: 2 }[p.artifactShape as string] ?? 0
      // Each instrument's own note length (fixed, so drawn notes never jump); how long its notes are really
      // sounding goes into the trail as it is laid down (writeMelody), as how much of each step they fill.
      fx.layerLen[0].set(NOTE_LEN[0], NOTE_LEN[1], NOTE_LEN[2], NOTE_LEN[3])
      fx.layerLen[1].set(NOTE_LEN[4], NOTE_LEN[5], NOTE_LEN[6], 1)
      fx.layerDensity[0].set(NOTE_DENSITY[0], NOTE_DENSITY[1], NOTE_DENSITY[2], NOTE_DENSITY[3])
      fx.layerDensity[1].set(NOTE_DENSITY[4], NOTE_DENSITY[5], NOTE_DENSITY[6], 1)
      fx.fluid.value = p.fluid
      fx.fluidStep.value = p.fluidSpeed * dt * 1.2
      fx.roundness.value = p.roundness
      fx.artifactGaps.value = p.artifactGaps
      fx.seamSpacing.value = p.seamSpacing
      fx.seamJitter.value = p.seamJitter
      fx.colourBy.value = { layer: 0, velocity: 1, flow: 2 }[p.colourBy as string] ?? 0
      fx.sectionSize.value = p.sectionSize
      fx.sectionBlend.value = p.sectionBlend
      fx.sectionSpread.value = p.sectionSpread
      fx.grid.value = p.grid
      fx.gridDots.value = p.gridStyle === 'dots' ? 1 : 0
      fx.gridSize.value = p.gridSize
      fx.gridOver.value = p.gridOver
      // What each layer is playing now, 0..1 low to high (-1 silent), so artifacts can follow the music,
      // and how long its notes are sounding, laid into the trail as it goes.
      {
        const melody = LAYERS.map((l, li) => {
          const held = (audio.layers.keys as Record<string, number[]>)[l]
          if (held?.length) return Math.max(0, Math.min(1, (Math.max(...held) - 36) / 48))
          // Otherwise from its letters: pitched notes light letters by pitch, so a letter's place is its note.
          let sum = 0
          let weight = 0
          const own = parts[l]
          for (const g of own) {
            const v = Math.max(conductor.light[g.index], together[g.index])
            if (v > 0.15) {
              sum += v * (own.length > 1 ? order[g.index] / (own.length - 1) : 0.5)
              weight += v
            }
          }
          if (weight > 0) return li <= 2 ? DRUM_ROW[li] : sum / weight
          return rackFeed.parts[l].level > 0.25 ? (li <= 2 ? DRUM_ROW[li] : l === 'fx' ? audio.layers.fx.place : 0.5) : -1
        })
        const fills = LAYERS.map((_, li) => Math.min(1, Math.max(0.4, 0.45 + 0.25 * Math.pow(layerDur[li] / NOTE_TYPICAL[li], 0.7))))
        fx.writeMelody(melody, fills, p.artifactSize * 3 * Math.max(0.25, p.artifactLength))
      }
      fx.threshold.value = p.threshold
      fx.artifactMode.value = { miscoded: 0, tonal: 1, mask: 2 }[p.artifactColour as string] ?? 0
      fx.softness.value = p.artifactSoftness
      // The cursor. While typing, the letter just typed plays: its own shape pours into the trail like any
      // played letter (so its notes carry the specks, sections and colours of the rest), quieter, and a new
      // note starts each pulse (seams part them; nothing blinks). The row being typed flows left to right
      // whatever the walls do, so it streams across the page from the start of its line. When typing starts
      // a new line, a faint line blurs in across the row from the left, then settles at the letter being
      // typed. A pause keeps it playing; it fades once the music plays and typing has stopped (the line has
      // joined the music). Everything eases toward where it should be now, so fast typing re-aims the
      // motion instead of restarting it.
      const sinceTyping = clock - typedAt
      if (sinceTyping > 1.2) fresh.fill(0)
      const g = caret >= 0 && caret < text.glyphs.length ? text.glyphs[caret] : null
      const musicPlaying = audio.beat.position !== beatBefore
      const typing = !!(p.typingNote && wall && g && typedAt > -1e2 && (sinceTyping < 1.6 || !musicPlaying))
      const ease = (tau: number) => 1 - Math.exp(-dt / tau)
      const sweepFor = p.cursorSweep
      let sweeping = false
      if (g) {
        const at = placed[caret]
        const sc = at.scale
        const li = map.owner[caret] >= 0 ? map.owner[caret] : 0
        const hh = Math.max(3, g.h * sc * 0.3)
        const right = at.x + g.w * 0.5 * sc
        if (bar.alpha < 0.03) {
          bar.x0 = right
          bar.x1 = right
          bar.y = at.y
          bar.hh = hh
        }
        if (g.line !== caretLine) {
          const firstOnLine = text.lines[g.line]?.glyphs[0] === g
          if (typing && sweepFor > 0 && (g.line > caretLine || firstOnLine)) {
            introAt = clock
            let lo = Infinity
            let hi = -Infinity
            for (const q of placed) {
              lo = Math.min(lo, q.x)
              hi = Math.max(hi, q.x)
            }
            introLeft = Number.isFinite(lo) ? lo - text.fontSize * 0.3 * sc : right
            introRight = Number.isFinite(hi) ? hi + text.fontSize * 0.3 * sc : right
            bar.x0 = introLeft
            bar.x1 = introLeft
            bar.y = at.y
            bar.blur = 10
          }
          caretLine = g.line
        }
        sweeping = clock - introAt < sweepFor
        bar.x0 += ((sweeping ? introLeft : right) - bar.x0) * ease(0.05)
        bar.x1 += ((sweeping ? introRight : right) - bar.x1) * ease(sweeping ? sweepFor * 0.3 : 0.06)
        bar.y += (at.y - bar.y) * ease(0.05)
        bar.hh += (hh - bar.hh) * ease(0.06)
        // A new note every `cursorRate` steps of the beat while the music plays; at a steady pace otherwise.
        const steps = audio.beat.bpm > 0 && audio.beat.position !== beatBefore ? audio.beat.bpm / 15 : 6
        const rate = steps * p.cursorRate
        if ((clock * rate) % 1 < dt * rate) pulses = (pulses % 30) + 1
        caretNote = ((pulses + 15) % 30) + 1
        bar.code = caretNote * 8 + li + 0.5
      }
      bar.alpha += ((typing ? 1 : 0) - bar.alpha) * ease(typing ? 0.06 : 0.25)
      bar.blur += (1 - bar.blur) * ease(0.07)
      // The letter being typed pours (eased in and out with typing); the sweep is laid separately, fainter.
      caretPour = p.cursorLevel * bar.alpha
      if (g && bar.alpha > 0.03) {
        let lineLeft = Infinity
        for (const q of text.lines[g.line]?.glyphs ?? []) lineLeft = Math.min(lineLeft, placed[q.index].x)
        const sc = placed[caret].scale
        fx.typeRow.value.set(bar.y, fx.rowBand.value, (Number.isFinite(lineLeft) ? lineLeft : bar.x0) - text.fontSize * 0.6 * sc, 1)
        // Fast enough that the notes stream ahead of the typing rather than trailing under the letters.
        fx.typeStep.value = Math.max(p.speed, 320) * dt
      } else fx.typeRow.value.w = 0
      fx.cursorRect.value.set(bar.x0, bar.x1, bar.y, bar.hh)
      fx.cursorLevel.value = sweeping ? p.cursorLevel * 0.55 * bar.alpha : 0
      fx.cursorSoft.value = bar.blur
      fx.cursorCode.value = bar.code
      beatBefore = audio.beat.position
      fx.rowSeparate.value = p.rowSeparate
      fx.lineFlow.forEach((v, li) => {
        const c = lineCount[li]
        if (c > 0) v.set(lineY[li] / c, lineDx[li] / c, lineDy[li] / c, 1)
        else v.set(0, 0, 0, 0)
      })
      const rows = text.lines.length
      // Each row's own band: half the gap between lines (or the type's height for one line).
      const spacing = rows > 1 ? Math.abs(lineY[0] / Math.max(1, lineCount[0]) - lineY[1] / Math.max(1, lineCount[1])) : text.fontSize * 1.25
      fx.rowBand.value = Math.max(12, spacing * 0.5)
      fx.lineSpread.value = rows > 1 ? Math.max(20, (Math.abs(lineY[0] / Math.max(1, lineCount[0]) - lineY[1] / Math.max(1, lineCount[1])) * 0.55)) : 60
      fx.split.value = p.split
      fx.splitAt.value = p.splitAt * view
      // Ramps suit the page: on a light one they deepen rather than whiten as notes get louder.
      const lightPage = luminance(background) > 0.6
      fx.setMultiRamps(LAYERS.map((l) => rampFor(p[colourKey(l)], lightPage)))
      fx.multi.value = 1
      fx.gamma.value = 1
      fx.background.value.set(background)
      fx.letterMode.value = p.letters ? 3 : 0
      fx.letterColor.value.set(p.letterColor)
      fx.grain.value = 0.04
    },
    dispose() {
      rackFeed.active = false
      manualKeys.enabled = false
    },
  }
}

export const orchestra: ModeDefinition = { id: 'orchestra', label: 'Orchestra', params, groups, presets, create }
