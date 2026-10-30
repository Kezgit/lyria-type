import type { BarLayer } from '../../engine/barLayer'
import type { BlobLayer } from '../../engine/blobLayer'
import type { ParamSchema } from '../../app/params'
import type { FrameContext, ModeDefinition, ModeInstance, ModePreset } from '../types'
import { Composition } from './composition'
import { finish, finishGroups, finishParams, stretchByStem, typedChars } from './finish'
import { barcode } from './barcode'
import { dots } from './dots'
import { ledger } from './ledger'
import { pulse } from './pulse'
import { sq } from './sq'
import { stretch } from './stretch'

// Sequencer: the music as a generated graphic, no text. The whole track is
// read once into a Composition; the chosen sub-mode generates its picture from
// that, and playback only lights what is sounding. Sub-modes keep their own
// controls (prefixed `<id>_` in the shared params so they never clash) and
// presets, listed only while that sub-mode is chosen.

export interface SubMode {
  id: string
  label: string
  params: ParamSchema
  groups: Record<string, string[]>
  /** Groups that depend on the sub-mode's own values (unused for now: `groups` is what shows). */
  groupsFor?: (values: Record<string, any>) => Record<string, string[]>
  /** Settings that rebuild the picture when changed (unused for now). */
  rebuildOn?: string[]
  /** First one = the sub-mode's defaults. */
  presets: Record<string, ModePreset>
  create(): SubInstance
}

export interface SubInstance {
  /** `params` are the sub-mode's own, unprefixed. */
  update(frame: FrameContext, comp: Composition, params: Record<string, any>): void
}

const SUBS: SubMode[] = [barcode, pulse, stretch, dots, ledger, sq]

const key = (sub: SubMode, k: string) => `${sub.id}_${k}`

const params: ParamSchema = {
  style: { type: 'select', value: SUBS[0].id, label: 'style', options: Object.fromEntries(SUBS.map((s) => [s.label, s.id])) },
  hold: { type: 'number', value: 0.35, min: 0.02, max: 4, step: 0.01, label: 'notes fade after (s)' },
  scroll: { type: 'select', value: 'still', label: 'scroll', options: { Still: 'still', Left: 'left', Right: 'right', Up: 'up', Down: 'down' } },
  scrollSpeed: { type: 'number', value: 60, min: 0, max: 800, step: 1, label: 'scroll speed' },
}
for (const sub of SUBS) {
  for (const [k, def] of Object.entries(sub.params)) params[key(sub, k)] = { ...def, label: def.label ?? k }
}
// Colour, mark shape, haze and the stems' buckets, shared by every sub-mode (finish.ts).
Object.assign(params, finishParams)

/** Starting points for a genre's look, on any sub-mode: the stems weighted, coloured, shaped and hazed to suit. */
const GENRES: Record<string, ModePreset> = {
  // Hard: drums and bass up front, square blocks in their stems' hues, a tight, dense haze, a dark page.
  'Genre · rock': {
    params: { drums: 1.5, bass: 1.3, vocals: 0.8, colour: 'stems', colourDepth: 1, dotRound: 0, dotSize: 1.1, randSize: 0.25, noiseSpeed: 0.2, hazeBlur: 8, hazeGain: 4, hazeEdge: 0.6, hazeTint: 'stems', hazeTone: 0.5 },
    background: '#0b0b0d', ink: '#f4f5f7',
  },
  // Subtle: drums pulled back, voices and instruments forward, soft round marks, a long pale haze on paper.
  'Genre · jazz': {
    params: { drums: 0.45, bass: 0.9, vocals: 1.15, instruments: 1.25, colour: 'dusk', colourDepth: 0.4, dotSize: 0.9, hazeBlur: 40, hazeStretch: 4, hazeGain: 1.6, hazeOpacity: 0.7, hazeTone: 0.3, crisp: 0.75 },
    background: '#f6f5f1', ink: '#121317',
  },
  // Unpredictable: drums and bass loud, marks stretched and turned at random across the page, drifting, pooled colour.
  'Genre · hip hop': {
    params: { drums: 1.7, bass: 1.5, vocals: 1.2, instruments: 0.6, colour: 'across', colourOffset: 0.35, colourDepth: 0.8, dotLength: 2, randSize: 0.8, randLength: 0.7, randAngle: 0.6, noiseScale: 260, noiseSpeed: 1.2, hazeBlur: 20, hazeEdge: 0.8, hazeGain: 3 },
    background: '#ffffff', ink: '#121317',
  },
}

const presets = new Map<string, Record<string, ModePreset>>()
for (const sub of SUBS) {
  presets.set(
    sub.id,
    Object.fromEntries(
      [
        ...Object.entries(sub.presets).map(([name, preset]) => [
          name,
          { ...preset, params: { style: sub.id, ...Object.fromEntries(Object.entries(preset.params).map(([k, v]) => [key(sub, k), v])) } },
        ]),
        // Genre starting points: the sub-mode's defaults under the shared finish (finish.ts).
        ...Object.entries(GENRES).map(([name, preset]) => [name, { ...preset, params: { style: sub.id, ...preset.params } }]),
      ],
    ),
  )
}

const subOf = (values: Record<string, any>) => SUBS.find((s) => s.id === values.style) ?? SUBS[0]

/** The colour groups, which sit right under the picture's layout. */
const COLOUR_GROUPS = ['Colour', 'Ink', 'Recolour', 'Gradient map', 'Mask']

function groupsFor(values: Record<string, any>) {
  const sub = subOf(values)
  const own = Object.entries(sub.groups).map(([title, keys]) => [title, keys.map((k) => key(sub, k))] as [string, string[]])
  const shared = Object.entries(finishGroups(sub.id, sub.groups))
  const colour = [...own, ...shared].filter(([t]) => COLOUR_GROUPS.includes(t))
  const rest = own.filter(([t]) => !COLOUR_GROUPS.includes(t))
  // After Layout (or the page, or the first group).
  const after = ['Layout', 'Page'].map((t) => rest.findIndex(([r]) => r === t)).find((i) => i >= 0) ?? 0
  rest.splice(after + 1, 0, ...colour)
  return {
    Timing: ['hold', 'scroll', 'scrollSpeed'],
    ...Object.fromEntries(rest),
    ...Object.fromEntries(shared.filter(([t]) => !COLOUR_GROUPS.includes(t))),
  }
}

/** Where everything a bar layer drew this frame goes when the picture scrolls by (dx, dy), wrapping round. */
function scrollBars(layer: BarLayer, dx: number, dy: number, W: number, H: number) {
  const n = layer.count
  const pos = layer.pos
  for (let i = 0; i < n; i++) {
    const o = i * 4
    // Bars that span the frame along the scroll stay put (they'd only jump).
    if ((dx && pos[o + 2] > W * 0.6) || (dy && pos[o + 3] > H * 0.6)) continue
    const wrap = (v: number, size: number) => ((((v + size / 2) % size) + size) % size) - size / 2
    if (dx) pos[o] = wrap(pos[o] + dx, W)
    if (dy) pos[o + 1] = wrap(pos[o + 1] + dy, H)
    // Crossing the edge: its other half shows on the far side.
    if (dx && Math.abs(pos[o]) + pos[o + 2] / 2 > W / 2) layer.duplicate(i, pos[o] > 0 ? -W : W, 0)
    if (dy && Math.abs(pos[o + 1]) + pos[o + 3] / 2 > H / 2) layer.duplicate(i, 0, pos[o + 1] > 0 ? -H : H)
  }
}

function scrollBlobs(layer: BlobLayer, dx: number, dy: number, W: number, H: number) {
  const pos = layer.pos
  const wrap = (v: number, size: number) => ((((v + size / 2) % size) + size) % size) - size / 2
  for (let i = 0; i < layer.count; i++) {
    if (dx) pos[i * 4] = wrap(pos[i * 4] + dx, W)
    if (dy) pos[i * 4 + 1] = wrap(pos[i * 4 + 1] + dy, H)
  }
}

function create(): ModeInstance {
  const comp = new Composition()
  const instances = new Map<string, SubInstance>()
  const own: Record<string, any> = {}
  // How far the picture has scrolled (px), wrapping round the frame.
  let scrolled = 0

  return {
    update(frame) {
      const p = frame.params
      frame.layers.glyphs.count = 0
      comp.update(frame.audio, frame.dt, p.hold)
      const sub = subOf(p)
      let inst = instances.get(sub.id)
      if (!inst) instances.set(sub.id, (inst = sub.create()))
      for (const k of Object.keys(sub.params)) own[k] = p[key(sub, k)]
      // Stretch colours its lanes by stem when the shared colour is on (one gradient per stem).
      if (sub.id === 'stretch' && stretchByStem(p)) own.colourBy = 'stems'
      // The sub-mode's own characters: removed, or swapped for the typed ones (Ledger's texture, Stretch's lanes).
      const typed = typedChars(p)
      if (sub.id === 'stretch' && p.chars === 'none') own.letters = 'hidden'
      if (sub.id === 'stretch' && p.chars === 'custom' && typed) own.lanes = typed
      if (sub.id === 'ledger' && p.chars === 'custom' && typed) { own.chars = 'custom'; own.customChars = typed }
      inst.update(frame, comp, own)
      finish(frame, p, sub.id)
      // The picture moves: everything drawn this frame shifts along (wrapping), the lanes' trails too.
      const dir = p.scroll as string
      const W = frame.viewport.width, H = frame.viewport.height
      if (dir === 'still' || !p.scrollSpeed) {
        scrolled = 0
        frame.layers.stretch.scroll.value.set(0, 0)
        return
      }
      const span = dir === 'left' || dir === 'right' ? W : H
      scrolled = (scrolled + p.scrollSpeed * frame.dt) % span
      const along = dir === 'left' || dir === 'down' ? -scrolled : scrolled
      const dx = dir === 'left' || dir === 'right' ? along : 0
      const dy = dir === 'up' || dir === 'down' ? along : 0
      const l = frame.layers
      for (const layer of [l.bars, l.barsMid.bars, l.barsFar.bars]) scrollBars(layer, dx, dy, W, H)
      for (const layer of [l.front, l.back]) scrollBlobs(layer, dx, dy, W, H)
      l.stretch.scroll.value.set(dx, dy)
    },
  }
}

export const sequencer: ModeDefinition = {
  id: 'sequencer',
  label: 'Sequencer',
  params,
  groupsFor,
  rebuildOn: ['style'],
  presetsFor: (values) => presets.get(subOf(values).id)!,
  create,
}
