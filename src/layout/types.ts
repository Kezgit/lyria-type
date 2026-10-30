import type { ParamSchema } from '../app/params'
import type { ShapedText } from '../text/shaping'

/** Resting transform for one glyph: quad centre in px (origin = screen centre, y up). */
export interface Placement {
  x: number
  y: number
  rotation: number
  scale: number
}

export interface Viewport {
  width: number
  height: number
}

export interface LayoutDefinition {
  id: string
  label: string
  params: ParamSchema
  /** Write one placement per shaped glyph into `out` (already sized). */
  apply(text: ShapedText, params: Record<string, any>, viewport: Viewport, out: Placement[]): void
}
