import * as THREE from 'three/webgpu'
import { Fn, abs, float, max, min, mix, pow, select, sqrt, texture, uniform, vec3, vec4 } from 'three/tsl'

import { BarLayer, type BarSpec } from './barLayer'
import { BlobLayer, type BlobSpec } from './blobLayer'

// Blend modes for single marks (the Sequencer's Manual: each placed element
// can multiply, screen, overlay... the picture under it, as in Figma). A mode
// adds marks to a blend mode's group each frame; when any group has marks,
// the frame is drawn offscreen, then per group: its marks are drawn on their
// own (transparent) and composited onto the picture with that mode's formula,
// in sRGB as design tools do. Dots and streaks / blobs are drawn as on the
// stage (bars and blobs, the main bar layer's gradients).

/** In menu order; the index is what a mark stores. */
export const BLEND_MODES = [
  'Normal',
  'Darken', 'Multiply', 'Plus darker', 'Color burn',
  'Lighten', 'Screen', 'Plus lighter', 'Color dodge',
  'Overlay', 'Soft light', 'Hard light',
  'Difference', 'Exclusion',
  'Hue', 'Saturation', 'Color', 'Luminosity',
] as const
/** Where the menu draws a line before an entry. */
export const BLEND_BREAKS = new Set([1, 5, 9, 12, 14])

// (TSL's types don't allow per-channel select or plain nodes where vars are expected; the shader does.)
type V3 = any
const sel = select as (cond: any, a: any, b: any) => any

export class BlendFx {
  /** Marks per blend mode (index into BLEND_MODES, never 0), set by a mode each frame. */
  private groups = new Map<number, { bars: BarSpec[]; blobs: BlobSpec[] }>()
  readonly bars = new BarLayer(4096, 1)
  readonly blobs = new BlobLayer(2048, 0)
  private markScene = new THREE.Scene()
  private picture = [rt(), rt()]
  private marksRT = rt()
  private mode = uniform(0)
  private baseNode: any
  private quad: THREE.QuadMesh
  private size = new THREE.Vector2()

  constructor() {
    // Drawn on their own into a clear target: premultiplied, with true alpha.
    this.bars.material.premultipliedAlpha = true
    this.bars.material.needsUpdate = true
    this.markScene.add(this.blobs.mesh, this.bars.mesh)

    this.baseNode = texture(this.picture[0].texture)
    const marks: any = texture(this.marksRT.texture)
    const mode = this.mode
    const mat = new THREE.NodeMaterial()
    mat.depthTest = false
    mat.depthWrite = false
    mat.fragmentNode = Fn(() => {
      const under = this.baseNode
      const top = marks
      const a = top.a.clamp(0, 1)
      // To sRGB (roughly) for the formulas, as design tools blend.
      const toS = (c: any) => pow(max(c, vec3(0)), vec3(1 / 2.2))
      const b = toS(under.rgb)
      const s = toS(top.rgb.div(max(a, 1e-4)))
      const lum = (c: V3) => c.x.mul(0.3).add(c.y.mul(0.59)).add(c.z.mul(0.11))
      const clip = (c: V3) => {
        const l = lum(c)
        const n = min(min(c.x, c.y), c.z)
        const x = max(max(c.x, c.y), c.z)
        const low = sel(n.lessThan(0), vec3(l).add(c.sub(l).mul(l).div(max(l.sub(n), 1e-5))), c)
        return sel(x.greaterThan(1), vec3(l).add(low.sub(l).mul(float(1).sub(l)).div(max(x.sub(l), 1e-5))), low)
      }
      const setLum = (c: V3, l: any) => clip(c.add(l.sub(lum(c))))
      const sat = (c: V3) => max(max(c.x, c.y), c.z).sub(min(min(c.x, c.y), c.z))
      const setSat = (c: V3, sv: any) => {
        const n = min(min(c.x, c.y), c.z)
        const range = sat(c)
        return sel(range.greaterThan(1e-5), c.sub(n).mul(sv).div(max(range, 1e-5)), vec3(0))
      }
      const one = vec3(1)
      const burn = sel(s.lessThanEqual(vec3(0)), vec3(0), one.sub(min(one, one.sub(b).div(max(s, vec3(1e-5))))))
      const dodge = sel(s.greaterThanEqual(one), one, min(one, b.div(max(one.sub(s), vec3(1e-5)))))
      const overlayOf = (base: V3, blend: V3) =>
        sel(base.lessThan(vec3(0.5)), base.mul(blend).mul(2), one.sub(one.sub(base).mul(one.sub(blend)).mul(2)))
      const d = sel(b.lessThanEqual(vec3(0.25)), b.mul(16).sub(12).mul(b).add(4).mul(b), sqrt(b))
      const soft = sel(s.lessThanEqual(vec3(0.5)), b.sub(one.sub(s.mul(2)).mul(b).mul(one.sub(b))), b.add(s.mul(2).sub(1).mul(d.sub(b))))
      const modes: V3[] = [
        s,
        min(b, s), b.mul(s), max(b.add(s).sub(1), vec3(0)), burn,
        max(b, s), b.add(s).sub(b.mul(s)), min(b.add(s), one), dodge,
        overlayOf(b, s), soft, overlayOf(s, b),
        abs(b.sub(s)), b.add(s).sub(b.mul(s).mul(2)),
        setLum(setSat(s, sat(b)), lum(b)), setLum(setSat(b, sat(s)), lum(b)), setLum(s, lum(b)), setLum(b, lum(s)),
      ]
      let out: any = modes[0]
      modes.forEach((m, i) => {
        if (i) out = sel(mode.equal(float(i)), m, out)
      })
      const blended = pow(max(out, vec3(0)), vec3(2.2))
      return vec4(mix(under.rgb, blended, a), 1)
    })()
    this.quad = new THREE.QuadMesh(mat)
  }

  /** Add marks to a blend mode's group for this frame. */
  add(mode: number, bar?: BarSpec, blob?: BlobSpec) {
    if (!(mode > 0 && mode < BLEND_MODES.length)) return
    let g = this.groups.get(mode)
    if (!g) this.groups.set(mode, (g = { bars: [], blobs: [] }))
    if (bar) g.bars.push(bar)
    if (blob) g.blobs.push(blob)
  }

  /** Forget this frame's marks (the engine calls it before each frame). */
  clear() {
    for (const g of this.groups.values()) {
      g.bars.length = 0
      g.blobs.length = 0
    }
  }

  get active() {
    for (const g of this.groups.values()) if (g.bars.length || g.blobs.length) return true
    return false
  }

  /**
   * Run `draw` (the frame's passes) into the offscreen picture, then composite each blend mode's marks onto
   * it, the last straight to wherever the frame was going. `gradients`: the bar layer whose rows the marks use.
   */
  render(renderer: THREE.WebGPURenderer, camera: THREE.Camera, gradients: BarLayer, draw: () => void) {
    renderer.getDrawingBufferSize(this.size)
    for (const t of [...this.picture, this.marksRT]) if (t.width !== this.size.x || t.height !== this.size.y) t.setSize(this.size.x, this.size.y)
    const set = renderer.setRenderTarget.bind(renderer)
    // (Where "the screen" is now: the canvas, or another effect's picture.)
    const finalTarget = renderer.getRenderTarget()
    renderer.setRenderTarget = ((t: THREE.RenderTarget | null, ...rest: any[]) => set(t ?? this.picture[0], ...rest)) as any
    try {
      set(this.picture[0])
      draw()
    } finally {
      renderer.setRenderTarget = set as any
    }
    this.bars.copyGradients(gradients)
    const groups = [...this.groups.entries()].filter(([, g]) => g.bars.length || g.blobs.length)
    const clear = renderer.getClearColor(new THREE.Color())
    const clearAlpha = renderer.getClearAlpha()
    let from = 0
    groups.forEach(([mode, g], k) => {
      this.bars.count = 0
      this.blobs.count = 0
      for (const b of g.bars) this.bars.push(b)
      for (const b of g.blobs) this.blobs.push(b)
      this.bars.upload()
      this.blobs.upload()
      renderer.setClearColor(0x000000, 0)
      set(this.marksRT)
      renderer.render(this.markScene, camera)
      renderer.setClearColor(clear, clearAlpha)
      this.mode.value = mode
      this.baseNode.value = this.picture[from].texture
      const last = k === groups.length - 1
      set(last ? finalTarget : this.picture[1 - from])
      this.quad.render(renderer)
      from = 1 - from
    })
  }
}

function rt() {
  return new THREE.RenderTarget(1, 1, {
    type: THREE.HalfFloatType, depthBuffer: false, magFilter: THREE.LinearFilter, minFilter: THREE.LinearFilter,
  })
}
