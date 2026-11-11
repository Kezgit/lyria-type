import * as THREE from 'three/webgpu'
import { Fn, max, mix, pow, screenCoordinate, select, sqrt, step, texture, uniform, vec3, vec4 } from 'three/tsl'

// Stacked line's grain, for every mode: its 256 px tile of white noise (the same seeded values), one tile
// pixel per device pixel, laid over the finished frame in soft light at `amount` (as the canvas does it:
// globalAlpha = grain / 100 * 0.7, 'soft-light'). Soft light needs the frame under it, so when it's on the
// frame is drawn offscreen first and composited through it.

function mulberry32(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function rt() {
  return new THREE.RenderTarget(1, 1, {
    type: THREE.HalfFloatType, depthBuffer: false, magFilter: THREE.NearestFilter, minFilter: THREE.NearestFilter,
  })
}

export class GrainFx {
  /** 0..1: the soft-light layer's alpha. */
  readonly amount = uniform(0)
  private picture = rt()
  private size = new THREE.Vector2()
  private quad: THREE.QuadMesh

  constructor() {
    const data = new Uint8Array(256 * 256 * 4)
    const r = mulberry32(1234)
    for (let i = 0; i < data.length; i += 4) {
      // (As putImageData stores r() * 255.)
      const v = Math.floor(r() * 255)
      data[i] = data[i + 1] = data[i + 2] = v
      data[i + 3] = 255
    }
    const tile = new THREE.DataTexture(data, 256, 256)
    tile.wrapS = tile.wrapT = THREE.RepeatWrapping
    tile.magFilter = tile.minFilter = THREE.NearestFilter
    tile.generateMipmaps = false
    tile.needsUpdate = true

    const under: any = texture(this.picture.texture)
    const noise: any = texture(tile, screenCoordinate.xy.div(256))
    const mat = new THREE.NodeMaterial()
    mat.depthTest = false
    mat.depthWrite = false
    mat.fragmentNode = Fn(() => {
      // In sRGB (roughly), as the canvas blends.
      const b = pow(max(under.rgb, vec3(0)), vec3(1 / 2.2))
      // (The noise is grey: one value for all three channels.)
      const s = noise.r
      const one = vec3(1)
      const d = mix(b.mul(16).sub(12).mul(b).add(4).mul(b), sqrt(b), step(vec3(0.25), b))
      const soft = select(s.lessThanEqual(0.5), b.sub(one.sub(s.mul(2)).mul(b).mul(one.sub(b))), b.add(d.sub(b).mul(s.mul(2).sub(1))))
      const out = mix(b, soft, this.amount)
      return vec4(pow(max(out, vec3(0)), vec3(2.2)), 1)
    })()
    this.quad = new THREE.QuadMesh(mat)
  }

  /** 0..1 (Stacked line's grain / 100 * 0.7). */
  set value(v: number) {
    this.amount.value = v
  }

  get on() {
    return this.amount.value > 0.0005
  }

  /** Run `draw` (the whole frame) offscreen, then lay it down through the grain where the frame was going. */
  render(renderer: THREE.WebGPURenderer, draw: () => void) {
    renderer.getDrawingBufferSize(this.size)
    if (this.picture.width !== this.size.x || this.picture.height !== this.size.y) this.picture.setSize(this.size.x, this.size.y)
    const set = renderer.setRenderTarget.bind(renderer)
    const finalTarget = renderer.getRenderTarget()
    // Every pass that would draw to the screen draws to the picture instead.
    renderer.setRenderTarget = ((t: THREE.RenderTarget | null, ...rest: any[]) => set(t ?? this.picture, ...rest)) as any
    try {
      set(this.picture)
      draw()
    } finally {
      renderer.setRenderTarget = set as any
    }
    set(finalTarget)
    this.quad.render(renderer)
  }
}
