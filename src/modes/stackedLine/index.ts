import type { ParamSchema } from '../../app/params'
import { PREVIEW_PIXEL_RATIO, pixelScale, viewZoom } from '../../engine/pixels'
import type { ModeDefinition, ModeInstance, ModePreset } from '../types'
import { buildScene, createAnim, drawScene, FEELS, PARTS } from './softgrid'

// Stacked line: Soft Grid's soft blob compositions as a mode. A line (or grid)
// of cells, each a stack of soft, wobbly shapes in lanes, with accent dots,
// depth blur and smear; every colour follows a part of the song (bass, vocals,
// drums, other) and swells, glows or sways with it. Drawn with the 2D canvas
// (softgrid.ts) and shown as the frame, so exports and recordings take it too.
// The page colour is the app's background.

/** The composition is laid out on this 16:9 page, then scaled to the frame. */
const DESIGN_W = 1280
const DESIGN_H = 720
const COLOURS = 6

const sel = (value: string, opts: string[], label: string) =>
  ({ type: 'select' as const, value, label, options: Object.fromEntries(opts.map((o) => [o, o])) })
const num = (value: number, min: number, max: number, step: number, label: string) =>
  ({ type: 'number' as const, value, min, max, step, label })
const bool = (value: boolean, label: string) => ({ type: 'boolean' as const, value, label })

const START_PALETTE = ['#7D6BFF', '#5A7CFF', '#E0335A', '#2FA6E8', '#B05CD9', '#F2A33A']

const params: ParamSchema = {
  // Grid
  layout: sel('Line', ['Single', 'Line', 'Grid'], 'layout'),
  stretch: num(2.2, 0.5, 4, 0.05, 'cell ratio'),
  padding: num(120, -200, 400, 1, 'margin (px)'),
  wander: num(12, 0, 100, 1, 'wander'),
  contain: bool(true, 'keep shapes inside their cell'),
  centre: bool(true, 'centre in frame'),
  alignRows: bool(true, 'keep shapes on the row line'),
  // Columns
  cols: num(7, 1, 24, 1, 'columns'),
  colGap: num(-8, -90, 150, 1, 'spacing (%)'),
  spaceVar: num(20, 0, 100, 1, 'variation'),
  // Rows (grid)
  rows: { ...num(4, 1, 16, 1, 'rows'), showIf: { key: 'layout', is: 'Grid' } },
  rowGap: { ...num(0, -90, 150, 1, 'row spacing (%)'), showIf: { key: 'layout', is: 'Grid' } },
  rowVar: { ...num(20, 0, 100, 1, 'row variation'), showIf: { key: 'layout', is: 'Grid' } },
  // Repeat
  repeat: sel('Off', ['Off', 'Tile', 'Rows', 'Columns'], 'repeat'),
  repeatCols: { ...num(1, 1, 8, 1, 'every … columns'), showIf: { key: 'repeat', is: 'Tile' } },
  repeatRows: { ...num(1, 1, 8, 1, 'every … rows'), showIf: { key: 'repeat', is: 'Tile' } },
  drift: { ...num(20, 0, 100, 1, 'variation'), showIf: { key: 'repeat', is: ['Tile', 'Rows', 'Columns'] } },
  repeatColour: { ...bool(false, 'repeat colours too'), showIf: { key: 'repeat', is: ['Tile', 'Rows', 'Columns'] } },
  // Clusters
  arrange: sel('Lanes', ['Lanes', 'Columns', 'Free'], 'arrange'),
  elong: num(85, 0, 100, 1, 'width'),
  widthVar: num(25, 0, 100, 1, 'width variation'),
  layers: num(4, 1, 12, 1, 'layers'),
  subCols: { ...num(1, 1, 4, 1, 'sub-columns'), showIf: { key: 'arrange', is: 'Lanes' } },
  laneGap: { ...num(0, -100, 100, 1, 'lane spacing (%)'), showIf: { key: 'arrange', is: 'Lanes' } },
  spread: num(40, 0, 100, 1, 'overlap'),
  sizeJitter: num(25, 0, 100, 1, 'size variation'),
  heightVar: num(30, 0, 100, 1, 'height variation'),
  wobble: num(35, 0, 100, 1, 'wobble'),
  accents: num(2, 0, 9, 1, 'accent dots'),
  accentSize: num(18, 2, 60, 1, 'dot size'),
  accentPlace: sel('Grid points', ['Grid points', 'Column', 'Free'], 'dots sit on'),
  dotSpan: { ...num(90, 20, 160, 1, 'dot spread (%)'), showIf: { key: 'accentPlace', is: 'Column' } },
  stem: { ...bool(false, 'dot stem'), showIf: { key: 'accentPlace', is: 'Column' } },
  innerDots: num(0, 0, 6, 1, 'inner dots'),
  // Softness
  blur: num(35, 0, 100, 1, 'blur'),
  depth: num(70, 0, 100, 1, 'depth blur'),
  focus: num(30, 0, 100, 1, 'in focus (%)'),
  depthBy: sel('Shape', ['Shape', 'Cluster', 'Row', 'Column'], 'depth by'),
  smear: num(30, 0, 100, 1, 'smear'),
  smearStyle: sel('Tails', ['Tails', 'Smudge'], 'smear style'),
  smearDir: sel('Both', ['Both', 'Left', 'Right'], 'smear to'),
  smearVar: num(45, 0, 100, 1, 'length variation'),
  mesh: num(0, 0, 100, 1, 'mesh texture'),
  grain: num(25, 0, 100, 1, 'grain'),
  merge: bool(true, 'merge same colours'),
  blend: sel('Multiply', ['Multiply', 'Darken', 'Normal', 'Screen'], 'blend'),
  // Colour
  colourCount: num(5, 1, COLOURS, 1, 'colours'),
  flow: sel('Random', ['Random', 'Columns', 'Rows', 'Diagonal', 'Gradient'], 'colour flow'),
  // Music
  musicIntensity: num(80, 0, 200, 1, 'intensity'),
  individual: num(60, 0, 100, 1, 'individual movement'),
  feel: sel('Blues', Object.keys(FEELS), 'feel'),
  mvSize: bool(true, 'pulse size'),
  mvGlow: bool(true, 'glow with the music'),
  mvBounce: bool(false, 'bounce'),
  mvSway: bool(false, 'sway'),
  mvBlur: bool(false, 'sharpen on loud moments'),
  // Shuffle
  seed: num(1234, 0, 9999, 1, 'shapes'),
  colourSeed: num(7, 0, 9999, 1, 'colours'),
}
// Each colour: its hex, how much of it, and which part of the song moves it.
for (let i = 0; i < COLOURS; i++) {
  params[`c${i + 1}`] = { type: 'color', value: START_PALETTE[i], label: `colour ${i + 1}` }
  params[`w${i + 1}`] = num(i < 5 ? 50 : 0, 0, 100, 1, `amount ${i + 1}`)
  params[`part${i + 1}`] = sel(PARTS[i % PARTS.length], [...PARTS, 'Still'], `moves with ${i + 1}`)
}

const colourKeys = Array.from({ length: COLOURS }, (_, i) => [`c${i + 1}`, `w${i + 1}`]).flat()
const partKeys = Array.from({ length: COLOURS }, (_, i) => `part${i + 1}`)

const groups: Record<string, string[]> = {
  Layout: ['layout', 'stretch', 'padding', 'wander', 'contain', 'centre', 'alignRows'],
  Columns: ['cols', 'colGap', 'spaceVar', 'rows', 'rowGap', 'rowVar'],
  Clusters: ['arrange', 'elong', 'widthVar', 'layers', 'subCols', 'laneGap', 'spread', 'sizeJitter', 'heightVar', 'wobble'],
  'Accent dots': ['accents', 'accentSize', 'accentPlace', 'dotSpan', 'stem', 'innerDots'],
  Softness: ['blur', 'depth', 'focus', 'depthBy', 'smear', 'smearStyle', 'smearDir', 'smearVar', 'mesh', 'grain', 'merge', 'blend'],
  Colour: ['colourCount', 'flow', ...colourKeys],
  Repeat: ['repeat', 'repeatCols', 'repeatRows', 'drift', 'repeatColour'],
  Music: ['musicIntensity', 'individual', 'feel', 'mvSize', 'mvGlow', 'mvBounce', 'mvSway', 'mvBlur', ...partKeys],
  Shuffle: ['seed', 'colourSeed'],
}

const presets: Record<string, ModePreset> = {
  'Stacked line': {
    params: {
      layout: 'Line', cols: 7, colGap: -8, padding: 120, stretch: 2.2, arrange: 'Lanes', elong: 85, widthVar: 25, layers: 4, spread: 40,
      wander: 12, sizeJitter: 25, wobble: 35, accents: 2, accentSize: 18, accentPlace: 'Grid points', blur: 35, smear: 30,
      blend: 'Multiply', grain: 25, flow: 'Random',
    },
    background: '#f1f1f3',
  },
}

/** The settings as Soft Grid names them. */
function settingsOf(p: Record<string, any>, bg: string): Record<string, any> {
  const n = Math.max(1, Math.min(COLOURS, Math.round(p.colourCount)))
  const palette: string[] = [], weights: number[] = [], parts: string[] = []
  for (let i = 1; i <= n; i++) {
    palette.push(p[`c${i}`])
    weights.push(p[`w${i}`])
    parts.push(p[`part${i}`])
  }
  return { ...p, palette, weights, parts, width: DESIGN_W, height: DESIGN_H, bg }
}

function create(): ModeInstance {
  const anim: any = createAnim()
  let sceneKey = ''
  let scene: any = null
  let drawnKey = ''

  return {
    update({ layers, viewport, dt, time, audio, params: values, background }) {
      const p = settingsOf(values, background)
      // The layout only changes with the settings.
      const key = JSON.stringify(p)
      if (key !== sceneKey) {
        scene = buildScene(p)
        sceneKey = key
        anim.partOf = new Map(p.palette.map((h: string, i: number) => [h.toLowerCase(), p.parts[i]]))
      }
      // The music: each part's level, eased in and out by the feel.
      // (Silence, paused or not, lets everything settle.)
      const playing = audio.level > 0.002
      const feel = (FEELS as Record<string, { attack: number; release: number }>)[p.feel] ?? FEELS.Blues
      const s = audio.stems
      const level: Record<string, number> = {
        Bass: s.bass.rms,
        Vocals: s.vocals.rms,
        Drums: Math.max(s.drums.rms, s.drums.onsetStrength * (s.drums.onset ? 1 : 0.6)),
        Other: s.instruments.rms,
      }
      for (const part of PARTS) {
        const target = playing ? Math.min(1, level[part] ?? 0) : 0
        const cur = anim.energy[part] ?? 0
        // Eased per frame at 60 fps, whatever the frame rate.
        const k = 1 - Math.pow(1 - (target > cur ? feel.attack : feel.release), dt * 60)
        anim.energy[part] = cur + (target - cur) * k
      }
      const moving = playing || PARTS.some((q) => anim.energy[q] > 0.002)
      anim.on = moving
      anim.t = time
      anim.feelP = (Object.keys(FEELS).indexOf(p.feel) + 0.5) / 4

      // Drawn at the frame's device size (more for an export or a close zoom).
      const zoom = Math.min(3, Math.max(1, viewZoom.value))
      const scaleUp = PREVIEW_PIXEL_RATIO * pixelScale.value * zoom
      const cw = Math.min(8192, viewport.width * scaleUp)
      const ch = Math.min(8192, viewport.height * scaleUp)
      const layer = layers.canvas
      layer.enabled = true
      const ctx = layer.context(cw, ch)
      const now = `${sceneKey}|${ctx.canvas.width}x${ctx.canvas.height}`
      if (moving || now !== drawnKey) {
        drawScene(ctx, scene, p, ctx.canvas.width / DESIGN_W, anim)
        layer.changed()
        drawnKey = moving ? '' : now
      }
    },
  }
}

export const stackedLine: ModeDefinition = {
  id: 'stackedLine',
  label: 'Stacked line',
  params,
  groups,
  openGroups: ['Layout', 'Colour', 'Softness'],
  presets,
  create,
}
