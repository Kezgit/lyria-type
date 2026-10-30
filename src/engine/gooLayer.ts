import * as THREE from 'three/webgpu'
import { BarLayer } from './barLayer'
import { BlurLayer } from './blurLayer'
import { GlyphLayer, type SdfParams } from './glyphLayer'

/**
 * Glyphs and bars blurred together as one image, for metaball morphs: with a
 * small `radius` and a high `edge`, the blurred coverage is cut at half, so a
 * letter and the dots over it merge into one gooey form (and its colour blends
 * between theirs). Write glyphs with writeOutline and push bars; counts reset
 * each frame.
 */
export class GooLayer extends BlurLayer {
  readonly glyphs: GlyphLayer
  readonly bars: BarLayer

  constructor(glyphCapacity: number, barCapacity: number, atlas: THREE.Texture, sdf: SdfParams, renderOrder: number) {
    const glyphs = new GlyphLayer(glyphCapacity, atlas, sdf, 1)
    const bars = new BarLayer(barCapacity, 0)
    const group = new THREE.Group()
    group.add(bars.mesh, glyphs.mesh)
    super(group, renderOrder)
    this.glyphs = glyphs
    this.bars = bars
  }

  protected prepare() {
    if (this.glyphs.count === 0 && this.bars.count === 0) return false
    this.bars.minFeather.value = 0.5 * this.texel
    this.glyphs.upload()
    this.bars.upload()
    return true
  }
}
