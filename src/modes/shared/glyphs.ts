import type { GlyphLayer } from '../../engine/glyphLayer'
import type { Placement } from '../../layout/types'
import type { ShapedGlyph } from '../../text/shaping'

export interface GlyphStyle {
  dx?: number
  dy?: number
  scale?: number
  rotation?: number
  blur?: number
  /** Grow the letter outward, px. */
  bleed?: number
  /** Soft halo around the letter, 0..1. */
  glow?: number
  /** 0 = blur both sides of the edge, 1 = keep the letter solid and blur outward only. */
  outward?: number
  r: number
  g: number
  b: number
  a: number
}

/** Write one glyph instance: its layout placement plus a mode's offsets/style. */
export function writeGlyph(layer: GlyphLayer, g: ShapedGlyph, p: Placement, s: GlyphStyle) {
  const o = g.index * 4
  layer.pos[o] = p.x + (s.dx ?? 0)
  layer.pos[o + 1] = p.y + (s.dy ?? 0)
  layer.pos[o + 2] = g.k
  layer.pos[o + 3] = p.scale * (s.scale ?? 1)
  layer.uv[o] = g.u0
  layer.uv[o + 1] = g.v0
  layer.uv[o + 2] = g.u1
  layer.uv[o + 3] = g.v1
  layer.size[o] = g.w
  layer.size[o + 1] = g.h
  layer.size[o + 2] = p.rotation + (s.rotation ?? 0)
  layer.size[o + 3] = s.blur ?? 0
  layer.color[o] = s.r
  layer.color[o + 1] = s.g
  layer.color[o + 2] = s.b
  layer.color[o + 3] = s.a
  layer.fx[o] = s.bleed ?? 0
  layer.fx[o + 1] = s.glow ?? 0
  layer.fx[o + 2] = s.outward ?? 0
}

/**
 * Append one halo instance: the glyph re-drawn from the wide-spread atlas,
 * where `bleed` offsets its outline outward and `blur` softens it, both in px.
 * Returns false when the layer is full.
 */
export function writeHalo(layer: GlyphLayer, g: ShapedGlyph, p: Placement, s: GlyphStyle): boolean {
  const i = layer.count
  if (i >= layer.capacity) return false
  const h = g.halo
  const o = i * 4
  const sc = p.scale * (s.scale ?? 1)
  const cos = Math.cos(p.rotation), sin = Math.sin(p.rotation)
  layer.pos[o] = p.x + (h.dx * cos - h.dy * sin) * sc + (s.dx ?? 0)
  layer.pos[o + 1] = p.y + (h.dx * sin + h.dy * cos) * sc + (s.dy ?? 0)
  layer.pos[o + 2] = h.k
  layer.pos[o + 3] = sc
  layer.uv[o] = h.u0
  layer.uv[o + 1] = h.v0
  layer.uv[o + 2] = h.u1
  layer.uv[o + 3] = h.v1
  layer.size[o] = h.w
  layer.size[o + 1] = h.h
  layer.size[o + 2] = p.rotation + (s.rotation ?? 0)
  layer.size[o + 3] = s.blur ?? 0
  layer.color[o] = s.r
  layer.color[o + 1] = s.g
  layer.color[o + 2] = s.b
  layer.color[o + 3] = s.a
  layer.fx[o] = s.bleed ?? 0
  layer.fx[o + 1] = s.glow ?? 0
  layer.fx[o + 2] = s.outward ?? 0
  layer.count = i + 1
  return true
}

/**
 * Append one glyph from the crisp atlas (its own sharp outline), with `bleed`
 * offsetting the outline and `blur` softening it. Reach is small (~0.25 em),
 * so this suits the sharp early stage of a shape. Returns false when full.
 */
export function writeOutline(layer: GlyphLayer, g: ShapedGlyph, p: Placement, s: GlyphStyle): boolean {
  const i = layer.count
  if (i >= layer.capacity) return false
  layer.count = i + 1
  writeGlyph(layer, { ...g, index: i }, p, s)
  return true
}
