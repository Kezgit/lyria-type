import type { LetterParts } from './shared/parts'
import type { ParamSchema } from '../app/params'
import type { AudioFeatures } from '../audio/features'
import type { Backdrop, Grain } from '../engine/backdrop'
import type { BarLayer } from '../engine/barLayer'
import type { BlobLayer } from '../engine/blobLayer'
import type { GlyphLayer } from '../engine/glyphLayer'
import type { BlurredGlyphLayer } from '../engine/blurredGlyphLayer'
import type { BlurredBarLayer } from '../engine/blurLayer'
import type { GooLayer } from '../engine/gooLayer'
import type { FieldFx } from '../engine/fieldFx'
import type { StretchFx } from '../engine/stretchFx'
import type { StencilFx } from '../engine/stencilFx'
import type { Placement, Viewport } from '../layout/types'
import type { ShapedGlyph, ShapedText } from '../text/shaping'

export interface Layers {
  /** Full-screen gradient field, behind everything. Off unless a mode updates it. */
  backdrop: Backdrop
  /** Soft shapes behind the text. */
  back: BlobLayer
  /** Gradient rects between `back` and the text; starts empty. Also usable as `stretch.clip`. */
  bars: BarLayer
  /** Bars blurred together as one image, under `bars` (set `radius`, `stretch` each frame); start empty. */
  barsMid: BlurredBarLayer
  barsFar: BlurredBarLayer
  /** Glyphs (writeOutline) and bars blurred together and cut at half: gooey, metaball-like forms; start empty. */
  goo: GooLayer
  glyphs: GlyphLayer
  /** Glyphs re-drawn from the crisp atlas, over the text; starts empty (append with writeOutline). */
  outlines: GlyphLayer
  /** Halo glyphs blurred together as one image (set `radius` in px each frame); start empty. */
  halosMid: BlurredGlyphLayer
  halosFar: BlurredGlyphLayer
  /** Soft shapes over the text. */
  front: BlobLayer
  /** Film grain over everything. Off unless a mode sets it. */
  grain: Grain
  /** Extrusion/feedback post effect. When a mode sets `enabled`, it replaces the normal draw. */
  stretch: StretchFx
  /** Feedback colour field. Set `enabled` and write hit glyphs into `inject` (writeHalo). */
  field: FieldFx
  /** Show the frame through the typed text: set `enabled`, write the letters into `stencil.glyphs`. */
  stencil: StencilFx
}

export interface FrameContext {
  dt: number
  time: number
  audio: AudioFeatures
  text: ShapedText
  /** Resting placement per glyph from the active layout. */
  base: Placement[]
  params: Record<string, any>
  /** Every mode's current params, by mode id (to borrow another mode's settings). */
  modeParams: Record<string, Record<string, any>>
  /** Linear-space ink colour. */
  ink: [number, number, number]
  /** Page background, CSS colour. */
  background: string
  /** Repaint the page background (and the panel's colour control). */
  setBackground(hex: string): void
  viewport: Viewport
  /** Font the text (and glyphsFor) is shaped in. */
  fontId: string
  /** Glyphs for any characters (one per inked char, in order) in the text's font and size; cached. Append with writeOutline. */
  glyphsFor(chars: string): ShapedGlyph[]
  /** Blob layers arrive empty (count 0); the glyph layer is sized to the text. */
  layers: Layers
  /** Letters given to instruments on the stage (shared by every mode): see shared/parts.ts. */
  parts: LetterParts
}

export interface ModeInstance {
  update(frame: FrameContext): void
  dispose?(): void
}

export interface ModePreset {
  /** Overrides on top of the mode's defaults. */
  params: Record<string, unknown>
  background?: string
  ink?: string
  fontId?: string
  fontSize?: number
}

export interface ModeDefinition {
  id: string
  label: string
  params: ParamSchema
  /** Optional folders for the panel: group name -> param keys. */
  groups?: Record<string, string[]>
  /** Folders that depend on the current values (e.g. a sub-mode's own controls); overrides `groups`. */
  groupsFor?(values: Record<string, any>): Record<string, string[]>
  /** Param keys whose change re-renders the panel (e.g. a sub-mode picker). */
  rebuildOn?: string[]
  presets?: Record<string, ModePreset>
  /** Presets that depend on the current values (e.g. only the chosen sub-mode's); overrides `presets`. The panel shows the `rebuildOn` pickers first, then these. */
  presetsFor?(values: Record<string, any>): Record<string, ModePreset>
  create(): ModeInstance
}
