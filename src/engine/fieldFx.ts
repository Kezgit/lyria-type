import * as THREE from 'three/webgpu'
import {
  Fn, dot, float, floor, fract, length, max, mix, mx_noise_float, normalize, positionGeometry, screenCoordinate, select,
  sin, smoothstep, texture, time, uniform, uv, vec2, vec3, vec4,
} from 'three/tsl'
import { previewCell } from './pixels'
import { BarLayer } from './barLayer'
import { GlyphLayer, type SdfParams } from './glyphLayer'

// A living colour field fed by the text. Each frame:
//
//   1. inject    hit glyphs (drawn with writeHalo into `inject`) and bars
//                (pushed into `injectBars`) -> RT
//   2. feedback  previous field advected along a curl-noise flow (+ drift,
//                an outward kick, and an optional swell that pushes every
//                shape outward from its own body), diffused by a small blur, decayed,
//                then the injection composited over it
//   3. distance  (ripple looks only) the same transform applied to how far
//                each pixel's colour has swelled from where it was injected
//   4. composite the field over the page between the text and the shapes;
//                ripple looks recolour it by that distance, mapping the
//                recent emission history outward like Stretch's trails
//
// Colour is stored premultiplied so diffusion and decay stay clean; distance
// is premultiplied by the same alpha so it blurs only with real colour. Runs
// at half resolution; it is only ever seen soft.

export type FieldDrift = 'none' | 'up' | 'down' | 'left' | 'right' | 'outward'

/** How the composite colours the field. */
export const FIELD_LOOKS = { flat: 0, tone: 1, ramp: 2, cycle: 3 } as const
export type FieldLook = keyof typeof FIELD_LOOKS

/** Emission history: samples, and px of ripple travel per sample. */
const HISTORY_SAMPLES = 512
const HISTORY_PX_PER_SAMPLE = 4
const HISTORY_PX = HISTORY_SAMPLES * HISTORY_PX_PER_SAMPLE

function makeRT() {
  return new THREE.RenderTarget(1, 1, {
    type: THREE.HalfFloatType, depthBuffer: false, magFilter: THREE.LinearFilter, minFilter: THREE.LinearFilter,
  })
}

export class FieldFx {
  enabled = false
  /** Write injected glyphs here (writeHalo); count is reset each frame. */
  readonly inject: GlyphLayer
  /** Bars to inject (set their gradients like any BarLayer); count is reset each frame. */
  readonly injectBars: BarLayer
  /** Full-screen composite, added to the main scene. */
  readonly composite: THREE.Mesh

  /** Curl-noise flow speed, px/s. */
  readonly flowSpeed = uniform(60)
  /** Size of flow eddies, px. */
  readonly flowScale = uniform(160)
  /** How fast the flow pattern itself evolves. */
  readonly turbulence = uniform(0.15)
  /** Constant drift, px/s (y up). */
  readonly drift = uniform(new THREE.Vector2(0, 0))
  /** Outward push from the centre, px/s. */
  readonly outward = uniform(0)
  /**
   * Swell, px/s: every shape pushes outward down its own density gradient, so
   * each hit grows from where it is (not from the screen centre) and fronts
   * that meet stall and mix instead of passing through each other.
   */
  readonly expand = uniform(0)
  /** Distance the swell looks to find a shape's edge, px. */
  readonly expandReach = uniform(6)
  /** Multiplier per frame on swelling edges: < 1 thins pulses as they travel. */
  readonly expandKeep = uniform(1)
  /** Blur per frame, px: how fast colours bleed into each other. */
  readonly diffusion = uniform(1)
  /** Field multiplier per frame (decay). */
  readonly keep = uniform(0.98)
  /** Seconds this frame. */
  readonly dt = uniform(1 / 60)
  readonly gain = uniform(1)
  readonly opacity = uniform(1)
  readonly grain = uniform(0)

  // --- Ripple looks (set `look` each frame; flat skips all of this) ---------
  look: FieldLook = 'flat'
  /** Ripple travel speed, px/s: how fast emission history moves outward. */
  rippleSpeed = 120
  /** Steady rings on top of the history, 0..1, and their spacing in px. */
  readonly rings = uniform(0)
  readonly wavelength = uniform(80)
  /** How far high emission lifts colour toward white, and low pulls it deeper. */
  readonly lightness = uniform(0.8)
  readonly depth = uniform(0.4)
  /** Gradient-map stops for the ramp look, low -> high emission. */
  readonly ramp = [0, 1, 2, 3].map(() => uniform(new THREE.Color()))
  /** Colours the cycle look travels through, outward. */
  readonly cycle = [0, 1, 2, 3].map(() => uniform(new THREE.Color()))

  private lookId = uniform(0)
  private phase = uniform(0)
  private emission = new Uint8Array(HISTORY_SAMPLES * 4)
  private emissionTex = new THREE.DataTexture(this.emission, HISTORY_SAMPLES, 1, THREE.RGBAFormat, THREE.UnsignedByteType)
  private carry = 0

  private viewport = uniform(new THREE.Vector2(1, 1))
  private scene = new THREE.Scene()
  private injectRT = makeRT()
  private history: [THREE.RenderTarget, THREE.RenderTarget] = [makeRT(), makeRT()]
  private distance: [THREE.RenderTarget, THREE.RenderTarget] = [makeRT(), makeRT()]
  private write = 0
  private feedback: THREE.QuadMesh
  private distFeedback: THREE.QuadMesh
  private prevNode: any
  private prevDistNode: any
  private result: any
  private distResult: any
  private size = new THREE.Vector2()
  private needsClear = true
  private distStale = true

  constructor(capacity: number, atlas: THREE.Texture, sdf: SdfParams, renderOrder: number) {
    this.inject = new GlyphLayer(capacity, atlas, sdf)
    this.scene.add(this.inject.mesh)
    this.injectBars = new BarLayer(capacity, 0)
    this.scene.add(this.injectBars.mesh)
    this.emissionTex.magFilter = this.emissionTex.minFilter = THREE.LinearFilter
    this.emissionTex.needsUpdate = true

    const injNode: any = texture(this.injectRT.texture)
    this.prevNode = texture(this.history[0].texture)
    this.prevDistNode = texture(this.distance[0].texture)

    // Where this pixel's value came from and how hard its edge is swelling.
    // Render-target uv runs top-down: px is y-up screen space, offsets flip back.
    const advect = () => {
      const st = uv().toVar()
      const px = st.sub(0.5).mul(this.viewport).mul(vec2(1, -1)).toVar()
      const pxToUv = vec2(1, -1).div(this.viewport).toVar()

      // Curl of a scalar noise field: divergence-free, so colour swirls
      // instead of collecting or thinning out.
      const t = time.mul(this.turbulence)
      const p: any = px.div(this.flowScale).toVar()
      const e = float(0.35)
      const n = (o: any) => mx_noise_float(vec3(p.add(o), t) as any)
      const curl = vec2(n(vec2(0, e)).sub(n(vec2(0, e.negate()))), n(vec2(e.negate(), 0)).sub(n(vec2(e, 0)))).div(e.mul(2))
      // Swell: away from denser field. Flat areas (inside a shape, or empty
      // page) have no gradient and stay put; only edges travel.
      const r = vec2(this.expandReach, this.expandReach).mul(pxToUv).toVar()
      const a = (o: any) => this.prevNode.sample(st.add(o)).a
      const grad = vec2(a(vec2(r.x, 0)).sub(a(vec2(r.x.negate(), 0))), a(vec2(0, r.y)).sub(a(vec2(0, r.y.negate())))).toVar()
      const slope = length(grad)
      const edge = smoothstep(0.002, 0.04, slope).toVar()
      const swell = grad.div(max(slope, 1e-4)).mul(edge).mul(this.expand.negate())
      const vel = curl.mul(this.flowSpeed)
        .add(this.drift)
        .add(normalize(px.add(vec2(1e-3, 0))).mul(this.outward))
        .add(swell)

      // Semi-Lagrangian advection: fetch where this pixel's colour came from,
      // diffused by a small blur and decayed (more on thinning edges).
      const src = st.sub(vel.mul(this.dt).mul(pxToUv)).toVar()
      const d = vec2(this.diffusion, this.diffusion).mul(pxToUv).toVar()
      const fetch = (node: any) => {
        const s = (o: any) => node.sample(src.add(o))
        return s(vec2(0, 0)).mul(4)
          .add(s(vec2(d.x, 0))).add(s(vec2(d.x.negate(), 0)))
          .add(s(vec2(0, d.y))).add(s(vec2(0, d.y.negate())))
          .div(8)
          .mul(this.keep)
          .mul(mix(float(1), this.expandKeep, edge))
      }
      return { st, edge, fetch, inj: injNode.sample(st) }
    }

    // --- Feedback pass ----------------------------------------------------
    const fbMat = new THREE.MeshBasicNodeMaterial({ transparent: true, blending: THREE.NoBlending, depthTest: false, depthWrite: false })
    fbMat.colorNode = Fn(() => {
      const { fetch, inj } = advect()
      return inj.add(fetch(this.prevNode).mul(float(1).sub(inj.a)))
    })()
    this.feedback = new THREE.QuadMesh(fbMat)

    // --- Distance pass ------------------------------------------------------
    // Same transform as the colour, plus the distance each edge swelled this
    // frame; fresh ink starts at 0. Semi-Lagrangian keeps it a true distance:
    // d(x) = d(x - step) + step along a steadily moving front.
    const distMat = new THREE.MeshBasicNodeMaterial({ transparent: true, blending: THREE.NoBlending, depthTest: false, depthWrite: false })
    distMat.colorNode = Fn(() => {
      const { edge, fetch, inj } = advect()
      const alpha = fetch(this.prevNode).a
      const dist = fetch(this.prevDistNode).r.add(alpha.mul(edge).mul(this.expand).mul(this.dt))
      return vec4(dist.mul(float(1).sub(inj.a)), 0, 0, 1)
    })()
    this.distFeedback = new THREE.QuadMesh(distMat)

    // --- Composite ----------------------------------------------------------
    this.result = texture(this.history[0].texture)
    this.distResult = texture(this.distance[0].texture)
    const histNode: any = texture(this.emissionTex)
    const mat = new THREE.MeshBasicNodeMaterial({
      transparent: true, depthWrite: false, depthTest: false, premultipliedAlpha: true,
    })
    mat.colorNode = Fn(() => {
      // This plane's uv runs bottom-up while render targets read top-down.
      const st = vec2(uv().x, float(1).sub(uv().y)).toVar()
      const c = this.result.sample(st).toVar()
      const a = max(c.a, float(1e-4))
      const flat = c.rgb.div(a).toVar()

      // Ripple value: the emission from `dist` px of travel ago, plus rings.
      const dist = this.distResult.sample(st).r.div(a).toVar()
      const wave = dist.sub(this.phase).div(this.wavelength).toVar()
      const past = histNode.sample(vec2(dist.div(HISTORY_PX).clamp(0, 1), 0.5)).r
      const v = past.add(sin(wave.mul(Math.PI * 2)).mul(this.rings).mul(0.5)).clamp(0, 1).toVar()

      // Low emission deepens a colour, high lifts it toward white.
      const tone = (col: any) => {
        const deep = col.mul(float(1).sub(this.depth))
        const light = mix(col, vec3(1, 1, 1), this.lightness)
        return select(v.lessThan(0.5), mix(deep, col, v.mul(2)), mix(col, light, v.mul(2).sub(1)))
      }
      const stops = this.ramp.map((u) => vec3(u as any))
      const seg = v.mul(3).toVar()
      const ramped = select(seg.lessThan(1), mix(stops[0], stops[1], smoothstep(0, 1, seg)),
        select(seg.lessThan(2), mix(stops[1], stops[2], smoothstep(1, 2, seg)), mix(stops[2], stops[3], smoothstep(2, 3, seg))))
      // Cycle: one colour per wavelength, travelling outward, blended at the seams.
      const cyc = this.cycle.map((u) => vec3(u as any))
      const k = fract(wave.div(4)).mul(4).toVar()
      const at = (i: any) => select(i.lessThan(0.5), cyc[0], select(i.lessThan(1.5), cyc[1], select(i.lessThan(2.5), cyc[2], cyc[3])))
      const i0 = floor(k)
      const cycled = mix(at(i0), at(fract(i0.add(1).div(4)).mul(4)), smoothstep(0.6, 1, fract(k)))

      const id = this.lookId
      const col: any = select(id.lessThan(0.5), flat,
        select(id.lessThan(1.5), tone(flat), select(id.lessThan(2.5), ramped, tone(cycled))))
      const ign = fract(fract(dot(previewCell(screenCoordinate.xy).add(time.mul(61.3)), vec2(0.06711056, 0.00583715))).mul(52.9829189))
      return vec4(col.add(ign.sub(0.5).mul(this.grain)), 1)
    })()
    mat.opacityNode = Fn(() => {
      const c = this.result.sample(vec2(uv().x, float(1).sub(uv().y)))
      return mix(float(0), c.a.mul(this.gain).clamp(0, 1), this.opacity)
    })()
    mat.vertexNode = vec4(positionGeometry.xy.mul(2), 0, 1)
    this.composite = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat)
    this.composite.frustumCulled = false
    this.composite.renderOrder = renderOrder
    this.composite.visible = false
  }

  setDrift(kind: FieldDrift, speed: number) {
    const v = this.drift.value
    v.set(0, 0)
    this.outward.value = 0
    if (kind === 'up') v.set(0, speed)
    else if (kind === 'down') v.set(0, -speed)
    else if (kind === 'left') v.set(-speed, 0)
    else if (kind === 'right') v.set(speed, 0)
    else if (kind === 'outward') this.outward.value = speed
  }

  /**
   * Record this frame's emission (0..1) for ripple looks. The history moves
   * outward at `rippleSpeed`, so a hit now appears `rippleSpeed * t` px out
   * from its ink t seconds later.
   */
  emit(value: number, dt: number) {
    const h = this.emission
    const v = Math.round(Math.min(1, Math.max(0, value)) * 255)
    this.carry += (this.rippleSpeed * dt) / HISTORY_PX_PER_SAMPLE
    const shift = Math.min(HISTORY_SAMPLES, Math.floor(this.carry))
    this.carry -= shift
    if (shift > 0) h.copyWithin(shift * 4, 0, (HISTORY_SAMPLES - shift) * 4)
    for (let i = 0; i < Math.max(1, shift); i++) h[i * 4] = v
    this.emissionTex.needsUpdate = true
    this.phase.value += this.rippleSpeed * dt
  }

  /** Start from an empty field (after switching look or text). */
  reset() {
    this.needsClear = true
  }

  /** Advance the field one frame. Call before the main render. */
  render(renderer: THREE.WebGPURenderer, camera: THREE.Camera, viewport: { width: number; height: number }) {
    if (!this.enabled) {
      this.composite.visible = false
      this.inject.count = 0
      this.injectBars.count = 0
      return
    }
    this.inject.upload()
    this.injectBars.upload()
    renderer.getDrawingBufferSize(this.size)
    const w = Math.max(1, Math.floor(this.size.x / 2))
    const h = Math.max(1, Math.floor(this.size.y / 2))
    if (this.injectRT.width !== w || this.injectRT.height !== h) {
      this.injectRT.setSize(w, h)
      this.history.forEach((rt) => rt.setSize(w, h))
      this.distance.forEach((rt) => rt.setSize(w, h))
      this.needsClear = true
    }
    this.viewport.value.set(viewport.width, viewport.height)
    this.lookId.value = FIELD_LOOKS[this.look]
    const ripple = this.look !== 'flat'

    const clear = renderer.getClearColor(new THREE.Color())
    const clearAlpha = renderer.getClearAlpha()
    renderer.setClearColor(0x000000, 0)

    // Distance only exists while a ripple look runs; start it clean each time.
    if (this.needsClear || (ripple && this.distStale)) {
      for (const rt of this.needsClear ? [...this.history, ...this.distance] : this.distance) {
        renderer.setRenderTarget(rt)
        renderer.clear()
      }
      this.needsClear = false
    }
    this.distStale = !ripple

    renderer.setRenderTarget(this.injectRT)
    renderer.render(this.scene, camera)

    // Distance reads the colour field before this frame's colour pass.
    const read = 1 - this.write
    this.prevNode.value = this.history[read].texture
    if (ripple) {
      this.prevDistNode.value = this.distance[read].texture
      renderer.setRenderTarget(this.distance[this.write])
      this.distFeedback.render(renderer)
      this.distResult.value = this.distance[this.write].texture
    }
    renderer.setRenderTarget(this.history[this.write])
    this.feedback.render(renderer)

    renderer.setRenderTarget(null)
    renderer.setClearColor(clear, clearAlpha)
    this.result.value = this.history[this.write].texture
    this.composite.visible = true
    this.write = read
  }
}

