import * as THREE from 'three/webgpu'
import TinySDF from '@mapbox/tiny-sdf'
import type { FontEntry } from '../fonts/registry'

// A single-channel SDF texture shared by every font/glyph in use, filled on
// demand with a simple shelf packer. When it fills up it is cleared and the
// generation number bumps, so callers know to re-request their glyphs.
//
// Two configurations are used:
//   CRISP  high-res, narrow spread: the sharp text itself.
//   HALO   low-res, very wide outward spread (~1.1 em): the same letter
//          offset outward and blurred, for shapes grown from the glyph's
//          own outline. Low-res is fine, it is only ever seen soft.

export interface SdfAtlasConfig {
  /** Raster size in atlas px. */
  fontSize: number
  /** Padding around each glyph's ink box; must cover the outward spread. */
  buffer: number
  /** Atlas px spanned by the full 0..1 SDF range. */
  radius: number
  /** Share of the range used inside the edge (rest is outward reach). */
  cutoff: number
  /** Texture size. */
  size: number
}

export const CRISP_ATLAS: SdfAtlasConfig = { fontSize: 72, buffer: 24, radius: 24, cutoff: 0.25, size: 2048 }
export const HALO_ATLAS: SdfAtlasConfig = { fontSize: 32, buffer: 36, radius: 40, cutoff: 0.1, size: 2048 }

/** Outward reach of an atlas in em: how far its letters can grow or blur. */
export function atlasReachEm(c: SdfAtlasConfig) {
  return Math.min(c.buffer, c.radius * (1 - c.cutoff)) / c.fontSize
}

export interface AtlasGlyph {
  u0: number; v0: number; u1: number; v1: number
  /** Bitmap size in atlas px (includes buffer). */
  w: number; h: number
  /** Ink box offset from pen/baseline in atlas px (y down, canvas convention). */
  left: number; top: number
  advance: number
  /** False for whitespace / empty glyphs. */
  ink: boolean
}

// TinySDF prefers OffscreenCanvas, which can't always see document.fonts;
// force a DOM canvas so dropped / Google fonts rasterize correctly.
class DomTinySDF extends TinySDF {
  _createCanvas(size: number) {
    const c = document.createElement('canvas')
    c.width = c.height = size
    return c
  }
}

export class SdfAtlas {
  readonly texture: THREE.DataTexture
  /** Edge value and radius for the glyph shader. */
  readonly sdf: { edge: number; radius: number }
  generation = 0
  private data: Uint8Array
  private glyphs = new Map<string, AtlasGlyph>()
  private rasterizers = new Map<string, TinySDF>()
  private measurers = new Map<string, CanvasRenderingContext2D>()
  private kerning = new Map<string, number>()
  private shelfX = 0
  private shelfY = 0
  private shelfH = 0

  constructor(readonly config: SdfAtlasConfig = CRISP_ATLAS) {
    this.sdf = { edge: 1 - config.cutoff, radius: config.radius }
    this.data = new Uint8Array(config.size * config.size)
    this.texture = new THREE.DataTexture(this.data, config.size, config.size, THREE.RedFormat, THREE.UnsignedByteType)
    this.texture.minFilter = THREE.LinearFilter
    this.texture.magFilter = THREE.LinearFilter
    this.texture.generateMipmaps = false
    this.texture.needsUpdate = true
  }

  glyph(font: FontEntry, char: string): AtlasGlyph {
    const key = `${font.id}\u0000${char}`
    const hit = this.glyphs.get(key)
    if (hit) return hit

    const g = this.rasterizer(font).draw(char)
    const entry: AtlasGlyph = {
      u0: 0, v0: 0, u1: 0, v1: 0,
      w: g.width, h: g.height,
      left: g.glyphLeft - this.config.buffer, top: g.glyphTop + this.config.buffer,
      advance: g.glyphAdvance,
      ink: g.glyphWidth > 0 && g.glyphHeight > 0,
    }
    if (entry.ink) {
      const slot = this.allocate(g.width, g.height)
      if (!slot) {
        this.reset()
        return this.glyph(font, char)
      }
      const size = this.config.size
      for (let y = 0; y < g.height; y++) {
        this.data.set(g.data.subarray(y * g.width, (y + 1) * g.width), (slot.y + y) * size + slot.x)
      }
      entry.u0 = slot.x / size
      entry.v0 = slot.y / size
      entry.u1 = (slot.x + g.width) / size
      entry.v1 = (slot.y + g.height) / size
      this.texture.needsUpdate = true
    }
    this.glyphs.set(key, entry)
    return entry
  }

  /** Kerning adjustment in atlas px between two characters. */
  kern(font: FontEntry, a: string, b: string): number {
    const key = `${font.id}\u0000${a}${b}`
    let k = this.kerning.get(key)
    if (k === undefined) {
      const ctx = this.measurer(font)
      k = ctx.measureText(a + b).width - ctx.measureText(a).width - ctx.measureText(b).width
      this.kerning.set(key, k)
    }
    return k
  }

  /** Font-wide ascent/descent in atlas px. */
  metrics(font: FontEntry) {
    const m = this.measurer(font).measureText('Hxgy')
    return { ascent: m.fontBoundingBoxAscent, descent: m.fontBoundingBoxDescent }
  }

  private css(font: FontEntry) {
    return `${font.style} ${font.weight} ${this.config.fontSize}px "${font.family}"`
  }

  private rasterizer(font: FontEntry) {
    let r = this.rasterizers.get(font.id)
    if (!r) {
      const { fontSize, buffer, radius, cutoff } = this.config
      r = new DomTinySDF({
        fontSize, buffer, radius, cutoff,
        fontFamily: `"${font.family}"`, fontWeight: font.weight, fontStyle: font.style,
      })
      this.rasterizers.set(font.id, r)
    }
    return r
  }

  private measurer(font: FontEntry) {
    let ctx = this.measurers.get(font.id)
    if (!ctx) {
      ctx = document.createElement('canvas').getContext('2d')!
      ctx.font = this.css(font)
      this.measurers.set(font.id, ctx)
    }
    return ctx
  }

  private allocate(w: number, h: number) {
    const SIZE = this.config.size
    if (this.shelfX + w > SIZE) {
      this.shelfX = 0
      this.shelfY += this.shelfH + 1
      this.shelfH = 0
    }
    if (this.shelfY + h > SIZE) return null
    const slot = { x: this.shelfX, y: this.shelfY }
    this.shelfX += w + 1
    this.shelfH = Math.max(this.shelfH, h)
    return slot
  }

  private reset() {
    this.data.fill(0)
    this.glyphs.clear()
    this.shelfX = this.shelfY = this.shelfH = 0
    this.generation++
  }
}
