import * as THREE from 'three/webgpu'
import { attribute, cos, exp, float, max, mix, positionGeometry, sin, smoothstep, texture, uniform, uv, varying, vec2, vec3, vec4 } from 'three/tsl'
import { edgePx } from './pixels'

// All glyphs of the scene drawn as one instanced quad mesh, sampling a shared
// single-channel SDF atlas. Modes write per-instance data; this class uploads it.
//
// Per-instance layout (each a vec4):
//   iPos   x, y, k, scale          k = screen px per atlas px (from the shaper)
//   iUv    u0, v0, u1, v1          atlas rect (v0 = top row)
//   iSize  w, h, rotation, blur    quad size in px, radians, blur in px
//   iColor r, g, b, a
//   iFx    bleed, glow, outward, -     bleed: grow the letter outward in px; glow: soft halo 0..1;
//                                      outward: 0 = blur both sides of the edge, 1 = solid inside, fade outward only

export interface SdfParams {
  /** SDF edge value in 0..1 (tiny-sdf: 1 - cutoff). */
  edge: number
  /** Atlas pixels spanned by the full 0..1 SDF range (tiny-sdf radius). */
  radius: number
}

/**
 * A wipe across the page, per pixel: a coarse grid of 0..1 values (0 = the type as drawn, 1 = gone), read
 * smoothly between cells. Where it rises the letters blur (`blur` px at 1) and fade (between `from` and `to`),
 * so a front passes through a letter instead of it switching as a whole.
 */
export class GlyphMask {
  /** 0 = off. */
  readonly on = uniform(0)
  /** Page rect the grid covers: left, bottom, width, height (px, y up). */
  readonly rect = uniform(new THREE.Vector4(0, 0, 1, 1))
  readonly blur = uniform(0)
  readonly from = uniform(0.15)
  readonly to = uniform(0.75)
  /** Grow the letter outward as it goes, px at 1. */
  readonly bleed = uniform(0)
  data = new Uint8Array(4)
  readonly texture = new THREE.DataTexture(this.data, 1, 1, THREE.RGBAFormat, THREE.UnsignedByteType)

  constructor() {
    this.texture.magFilter = this.texture.minFilter = THREE.LinearFilter
    this.texture.needsUpdate = true
  }

  /** Grid size (cells); row 0 is the bottom. Write values with `set`, then `commit`. */
  resize(cols: number, rows: number) {
    if (this.texture.image.width === cols && this.texture.image.height === rows) return
    this.data = new Uint8Array(cols * rows * 4)
    this.texture.image = { data: this.data, width: cols, height: rows }
    // The GPU texture keeps its first size: let it go so the next upload makes one this size.
    this.texture.dispose()
    this.texture.needsUpdate = true
  }

  set(i: number, v: number) {
    this.data[i * 4] = Math.round(Math.min(1, Math.max(0, v)) * 255)
  }

  commit() {
    this.texture.needsUpdate = true
  }
}

export class GlyphLayer {
  /** Per-pixel wipe (off unless a mode turns it on each frame). */
  readonly mask = new GlyphMask()
  readonly mesh: THREE.Mesh
  readonly pos: Float32Array
  readonly uv: Float32Array
  readonly size: Float32Array
  readonly color: Float32Array
  readonly fx: Float32Array
  /** Per glyph: the stem it belongs to (-1 none), set by modes that colour by sound. Not drawn. */
  readonly stems: Int8Array
  private attrs: THREE.InstancedBufferAttribute[]
  private geometry: THREE.InstancedBufferGeometry

  constructor(readonly capacity: number, atlas: THREE.Texture, sdf: SdfParams, renderOrder = 10) {
    this.pos = new Float32Array(capacity * 4)
    this.uv = new Float32Array(capacity * 4)
    this.size = new Float32Array(capacity * 4)
    this.color = new Float32Array(capacity * 4)
    this.fx = new Float32Array(capacity * 4)
    this.stems = new Int8Array(capacity).fill(-1)

    const plane = new THREE.PlaneGeometry(1, 1)
    const geo = (this.geometry = new THREE.InstancedBufferGeometry())
    geo.index = plane.index
    geo.setAttribute('position', plane.getAttribute('position'))
    geo.setAttribute('uv', plane.getAttribute('uv'))
    const named: [string, Float32Array][] = [
      ['iPos', this.pos],
      ['iUv', this.uv],
      ['iSize', this.size],
      ['iColor', this.color],
      ['iFx', this.fx],
    ]
    this.attrs = named.map(([name, arr]) => {
      const a = new THREE.InstancedBufferAttribute(arr, 4)
      a.setUsage(THREE.DynamicDrawUsage)
      geo.setAttribute(name, a)
      return a
    })
    geo.instanceCount = 0

    const iPos = attribute('iPos', 'vec4')
    const iUv = attribute('iUv', 'vec4')
    const iSize = attribute('iSize', 'vec4')
    const iColor = attribute('iColor', 'vec4')
    const iFx = attribute('iFx', 'vec4')

    const mat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, depthTest: false })

    // Vertex: scale + rotate unit quad, then translate.
    const local = positionGeometry.xy.mul(iSize.xy).mul(iPos.w)
    const r = iSize.z
    const rotated = vec2(
      local.x.mul(cos(r)).sub(local.y.mul(sin(r))),
      local.x.mul(sin(r)).add(local.y.mul(cos(r))),
    )
    mat.positionNode = vec3(rotated.add(iPos.xy), 0)
    const world = varying(rotated.add(iPos.xy))
    const mask = this.mask
    const maskUv = world.sub(mask.rect.xy).div(mask.rect.zw)
    const m = texture(mask.texture, maskUv).r.mul(mask.on)

    // Fragment: signed distance in screen px -> coverage, widened by blur.
    const atlasUv = vec2(mix(iUv.x, iUv.z, uv().x), mix(iUv.y, iUv.w, float(1).sub(uv().y)))
    const sdAtlasPx = texture(atlas, atlasUv).r.sub(sdf.edge).mul(sdf.radius)
    const sdScreenPx = sdAtlasPx.mul(iPos.z).mul(iPos.w)
    const blur = iSize.w.add(m.mul(mask.blur))
    const aa = edgePx(0.7).add(blur)
    // Symmetric blur straddles the edge; outward blur keeps the (offset)
    // letter solid and spends the whole blur width outside it.
    const lo = mix(aa.negate(), edgePx(0.7).negate().sub(blur.mul(2)), iFx.z)
    const hi = mix(aa, edgePx(0.7), iFx.z)
    const coverage = smoothstep(lo, hi, sdScreenPx.add(iFx.x).add(m.mul(mask.bleed)))
    // Halo reaches as far as the SDF spread allows (~buffer px in atlas space).
    const outside = max(sdScreenPx.negate(), 0)
    const halo = exp(outside.div(iPos.z.mul(iPos.w).mul(sdf.radius * 0.35)).pow(2).negate()).mul(iFx.y)
    mat.colorNode = vec4(iColor.rgb, 1)
    const gone = smoothstep(mask.from, mask.to, m)
    mat.opacityNode = max(coverage, halo).mul(iColor.a).mul(float(1).sub(gone))

    this.mesh = new THREE.Mesh(geo, mat)
    this.mesh.frustumCulled = false
    this.mesh.renderOrder = renderOrder
  }

  set count(n: number) {
    this.geometry.instanceCount = Math.min(n, this.capacity)
  }

  get count() {
    return this.geometry.instanceCount
  }

  upload() {
    for (const a of this.attrs) {
      a.clearUpdateRanges()
      a.addUpdateRange(0, this.count * 4)
      a.needsUpdate = true
    }
  }
}
