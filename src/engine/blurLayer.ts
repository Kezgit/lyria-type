import * as THREE from 'three/webgpu'
import { float, max, mix, positionGeometry, smoothstep, texture, uniform, uv, vec2, vec4 } from 'three/tsl'
import { BarLayer } from './barLayer'
import { PREVIEW_PIXEL_RATIO } from './pixels'

// Content drawn offscreen and blurred as one image, so overlapping shapes
// bleed into each other instead of each blurring alone.
//
//   content -> half-res RT (premultiplied colour)
//   -> dual-filter blur (downsample chain, then upsample back)
//   -> full-screen quad in the main scene at `renderOrder`
//
// Dual filtering (Kawase down/up) keeps very large radii cheap: each level
// halves resolution, so the cost barely grows with the radius.
//
// Resolution: the preview reaches a radius in whole levels (each doubling it);
// that effective radius is kept in CSS px at any pixel ratio (an export), the
// levels there spread by a fraction so they land on it exactly.
//
// Stretch: the content is drawn squashed `stretch` times horizontally, blurred
// evenly, and stretched back on the composite, so the blur reaches `stretch`
// times further across than up and down.

const MAX_LEVELS = 11

function makeRT() {
  return new THREE.RenderTarget(1, 1, {
    type: THREE.HalfFloatType, depthBuffer: false, magFilter: THREE.LinearFilter, minFilter: THREE.LinearFilter,
  })
}

/** One down- or up-sample pass. `halfPixel` is half a source texel in uv. */
function blurPass(kind: 'down' | 'up') {
  const src: any = texture(new THREE.Texture())
  const halfPixel = uniform(new THREE.Vector2())
  // Transparent + NoBlending: three forces alpha to 1 on opaque materials, but
  // the blur has to carry alpha through untouched.
  const mat = new THREE.MeshBasicNodeMaterial({
    depthTest: false, depthWrite: false, transparent: true, blending: THREE.NoBlending,
  })
  const st = uv()
  const hp = halfPixel
  const at = (dx: number, dy: number) => src.sample(st.add(vec2(hp.x.mul(dx), hp.y.mul(dy))))
  mat.colorNode =
    kind === 'down'
      ? src.sample(st).mul(4).add(at(-1, -1)).add(at(1, 1)).add(at(1, -1)).add(at(-1, 1)).div(8)
      : at(-2, 0).add(at(-1, 1).mul(2)).add(at(0, 2)).add(at(1, 1).mul(2))
          .add(at(2, 0)).add(at(1, -1).mul(2)).add(at(0, -2)).add(at(-1, -1).mul(2)).div(12)
  return { quad: new THREE.QuadMesh(mat), src, halfPixel }
}

export abstract class BlurLayer {
  /** Full-screen composite, added to the main scene. */
  readonly composite: THREE.Mesh
  /** Blur radius in CSS px (up and down); set per frame. */
  radius = 0
  /** How many times further the blur reaches horizontally; set per frame. */
  stretch = 1
  /** Alpha gain on the composite: blurring spreads coverage thin. */
  readonly gain = uniform(1)
  /** Final opacity of the composite, applied after gain and edge (above 1 strengthens it; clamped). */
  readonly opacity = uniform(1)
  /** 0 = soft fog; toward 1 the blurred coverage is cut at half, so nearby shapes pool into clean-edged forms. */
  readonly edge = uniform(0)

  private scene = new THREE.Scene()
  private camera = new THREE.OrthographicCamera()
  private source = makeRT()
  private chain: THREE.RenderTarget[] = Array.from({ length: MAX_LEVELS }, makeRT)
  private down = blurPass('down')
  private up = blurPass('up')
  private result: any
  private squash = uniform(1)
  private size = new THREE.Vector2()

  constructor(content: THREE.Object3D, renderOrder: number) {
    this.scene.add(content)

    // Premultiplied in the RT; un-premultiply here and let the material
    // premultiply again so blending onto the page stays correct.
    this.result = texture(this.source.texture)
    const mat = new THREE.MeshBasicNodeMaterial({
      transparent: true, depthWrite: false, depthTest: false, premultipliedAlpha: true,
    })
    // This plane's uv runs bottom-up while render targets read top-down;
    // without the flip every blob lands mirrored across the screen.
    const c = this.result.sample(vec2(uv().x.sub(0.5).div(this.squash).add(0.5), float(1).sub(uv().y)))
    const a0 = c.a.mul(this.gain).clamp(0, 1)
    const w = max(float(1).sub(this.edge).mul(0.5), float(0.01))
    // Opacity past 1 pushes the thin, blurred coverage toward solid.
    const a = mix(a0, smoothstep(float(0.5).sub(w), float(0.5).add(w), a0), this.edge).mul(this.opacity).clamp(0, 1)
    mat.colorNode = vec4(c.rgb.div(max(c.a, float(1e-4))), 1)
    mat.opacityNode = a
    mat.vertexNode = vec4(positionGeometry.xy.mul(2), 0, 1)
    this.composite = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat)
    this.composite.frustumCulled = false
    this.composite.renderOrder = renderOrder
    this.composite.visible = false
  }

  /** Size of one target pixel along x, px (half-res, times the stretch); set before `prepare`. */
  protected texel = 1

  /** Upload the content; false when there is nothing to draw. */
  protected abstract prepare(): boolean

  /** Render the content offscreen and blur it. Call before the main render. */
  render(renderer: THREE.WebGPURenderer, camera: THREE.OrthographicCamera) {
    // In picture px: the view's zoom shrinks a target pixel in the picture (and magnifies the blur below).
    this.texel = (2 * Math.max(1, this.stretch)) / renderer.getPixelRatio() / camera.zoom
    if (!this.prepare()) {
      this.composite.visible = false
      return
    }
    renderer.getDrawingBufferSize(this.size)
    const w = Math.max(1, Math.floor(this.size.x / 2))
    const h = Math.max(1, Math.floor(this.size.y / 2))
    if (this.source.width !== w || this.source.height !== h) {
      this.source.setSize(w, h)
      this.chain.forEach((rt, i) => rt.setSize(Math.max(1, w >> (i + 1)), Math.max(1, h >> (i + 1))))
    }

    // A wider view squashes the content; the composite stretches it back.
    const s = Math.max(1, this.stretch)
    this.squash.value = s
    this.camera.copy(camera)
    this.camera.left = camera.left * s
    this.camera.right = camera.right * s
    this.camera.updateProjectionMatrix()

    // Each level roughly doubles the radius (in half-res px): the preview's whole levels, as CSS px, at this ratio.
    const ref = Math.max(0, Math.min(MAX_LEVELS, Math.round(Math.log2(Math.max(1, (this.radius * PREVIEW_PIXEL_RATIO) / 2)))))
    const targetPx = ref ? Math.pow(2, ref) * (renderer.getPixelRatio() / PREVIEW_PIXEL_RATIO) * camera.zoom : 0
    const levels = targetPx > 0 ? Math.max(1, Math.min(MAX_LEVELS, Math.ceil(Math.log2(targetPx) - 1e-6))) : 0
    const spread = levels ? targetPx / Math.pow(2, levels) : 1

    const clear = renderer.getClearColor(new THREE.Color())
    const clearAlpha = renderer.getClearAlpha()
    renderer.setClearColor(0x000000, 0)

    renderer.setRenderTarget(this.source)
    renderer.render(this.scene, this.camera)

    let current: THREE.RenderTarget = this.source
    for (let i = 0; i < levels; i++) {
      this.down.src.value = current.texture
      this.down.halfPixel.value.set((0.5 * spread) / current.width, (0.5 * spread) / current.height)
      renderer.setRenderTarget(this.chain[i])
      this.down.quad.render(renderer)
      current = this.chain[i]
    }
    for (let i = levels - 2; i >= -1; i--) {
      const target = i >= 0 ? this.chain[i] : this.source
      this.up.src.value = current.texture
      this.up.halfPixel.value.set((0.5 * spread) / current.width, (0.5 * spread) / current.height)
      renderer.setRenderTarget(target)
      this.up.quad.render(renderer)
      current = target
    }

    renderer.setRenderTarget(null)
    renderer.setClearColor(clear, clearAlpha)
    this.result.value = current.texture
    this.composite.visible = true
  }
}

/** Bars blurred together as one image (set their gradients like any BarLayer). */
export class BlurredBarLayer extends BlurLayer {
  /** Push bars here; count is reset each frame. */
  readonly bars: BarLayer

  constructor(capacity: number, renderOrder: number) {
    const bars = new BarLayer(capacity, 0)
    super(bars.mesh, renderOrder)
    this.bars = bars
  }

  protected prepare() {
    if (this.bars.count === 0) return false
    this.bars.minFeather.value = 0.5 * this.texel
    this.bars.upload()
    return true
  }
}
