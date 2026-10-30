import type * as THREE from 'three/webgpu'
import { BlurLayer } from './blurLayer'
import { GlyphLayer, type SdfParams } from './glyphLayer'

// A glyph layer that is drawn offscreen and blurred as one image, so
// overlapping shapes bleed into each other instead of each blurring alone
// (see BlurLayer).

export class BlurredGlyphLayer extends BlurLayer {
  /** Write instances here (e.g. with writeHalo); count is reset each frame. */
  readonly glyphs: GlyphLayer

  constructor(capacity: number, atlas: THREE.Texture, sdf: SdfParams, renderOrder: number) {
    const glyphs = new GlyphLayer(capacity, atlas, sdf)
    super(glyphs.mesh, renderOrder)
    this.glyphs = glyphs
  }

  protected prepare() {
    if (this.glyphs.count === 0) return false
    this.glyphs.upload()
    return true
  }
}
