import * as THREE from 'three/webgpu'
import { Fn, abs, cos, exp, float, floor, fract, length, max, mix, select, sin, smoothstep, texture, uniform, uv, vec2, vec4 } from 'three/tsl'

import { GlyphLayer, type SdfParams } from './glyphLayer'

// Stencil: the frame a mode draws (the sequencer's picture) is rendered
// offscreen and shown through the typed text, with wipes between three looks:
//   pattern   the whole picture, as the mode drew it
//   stencil   the picture only inside the letters (a faint `ghost` outside)
//   text      the letters in ink (or left as the stencil)
// Front 1 sweeps pattern -> stencil, front 2 stencil -> text, front 3 (an
// "on through" return) text -> pattern. Each front is a straight edge at
// `angle` (or a ring from the centre), broken into lanes that arrive at
// staggered times, like notes in a piano roll. The picture can be turned,
// scaled and moved under the letters.

export class StencilFx {
  /** Set by a mode every frame; off otherwise (the frame draws as normal). */
  enabled = false
  /** The letters of the stencil: write them with writeGlyph (white), set `count`. */
  readonly glyphs: GlyphLayer

  /** Fronts, 0..1 across the frame (front 3 returns to pattern). */
  readonly front1 = uniform(0)
  readonly front2 = uniform(0)
  readonly front3 = uniform(0)
  /** Front softness, share of the frame. */
  readonly soft = uniform(0.08)
  /** Direction the fronts travel, radians (0 = left -> right); `radial` 1 = rings out from `centre`. */
  readonly angle = uniform(0)
  readonly radial = uniform(0)
  readonly centre = uniform(new THREE.Vector2())
  /** Lanes across the front: height px (0 = one straight edge), how far apart they arrive (share), seed. */
  readonly laneH = uniform(0)
  readonly stagger = uniform(0)
  readonly seed = uniform(0)
  /** Picture outside the letters while it's a stencil / once it's text, 0..1. */
  readonly ghost = uniform(0.08)
  readonly ghostText = uniform(0)
  /** How much the letters fill with ink at the end (0 = stay a stencil). */
  readonly fill = uniform(1)
  /** A thin light at each front, 0..1. */
  readonly edge = uniform(0)
  /** The picture under the letters: turned (radians), scaled, moved (px). */
  readonly patAngle = uniform(0)
  readonly patScale = uniform(1)
  readonly patOffset = uniform(new THREE.Vector2())
  readonly ink = uniform(new THREE.Color())
  readonly background = uniform(new THREE.Color())
  readonly viewport = uniform(new THREE.Vector2(1, 1))

  private sceneRT = rt()
  private maskRT = rt()
  private maskScene = new THREE.Scene()
  private quad: THREE.QuadMesh
  private size = new THREE.Vector2()

  constructor(atlas: THREE.Texture, sdf: SdfParams) {
    this.glyphs = new GlyphLayer(4096, atlas, sdf)
    this.maskScene.add(this.glyphs.mesh)
    const sceneTex: any = texture(this.sceneRT.texture)
    const maskTex: any = texture(this.maskRT.texture)
    const mat = new THREE.MeshBasicNodeMaterial({ depthTest: false, depthWrite: false })
    mat.colorNode = Fn(() => {
      const st = uv().toVar()
      const px = st.sub(0.5).mul(this.viewport).mul(vec2(1, -1)).toVar()
      const rot = (v: any, a: any) => vec2(v.x.mul(cos(a)).sub(v.y.mul(sin(a))), v.x.mul(sin(a)).add(v.y.mul(cos(a))))

      // The picture, turned / scaled / moved; mirrored on past its edges so it always fills the frame.
      const q = rot(px.sub(this.patOffset), this.patAngle.negate()).div(this.patScale)
      const raw = q.mul(vec2(1, -1)).div(this.viewport).add(0.5)
      const pst = float(1).sub(abs(fract(raw.mul(0.5)).mul(2).sub(1))).toVar()
      const bg = vec4(this.background, 1)
      const pat = sceneTex.sample(pst).toVar()
      const m = maskTex.sample(st).r.clamp(0, 1).toVar()

      // Where this pixel is along the fronts, 0..1, lanes staggered.
      const d = rot(px.sub(this.centre), this.angle.negate()).toVar()
      const half = abs(cos(this.angle)).mul(this.viewport.x).add(abs(sin(this.angle)).mul(this.viewport.y)).mul(0.5)
      const lin = d.x.div(half.mul(2)).add(0.5)
      const rad = length(px.sub(this.centre)).div(length(this.viewport).mul(0.5).add(length(this.centre)))
      const lane = select(this.radial.greaterThan(0.5), floor(rad.mul(length(this.viewport)).div(max(this.laneH, 1))), floor(d.y.div(max(this.laneH, 1))))
      const h = fract(sin(lane.mul(12.9898).add(this.seed.mul(78.233))).mul(43758.5453))
      const off = select(this.laneH.greaterThan(0.5), h.mul(this.stagger), float(0))
      const u = mix(lin, rad, this.radial).mul(float(1).sub(this.stagger)).add(off).toVar()
      // A front f (0..1) has passed u: its soft edge runs fully on and off the frame.
      const passed = (f: any) => smoothstep(0, 1, f.mul(float(1).add(this.soft.mul(2))).sub(this.soft).sub(u).div(this.soft).add(0.5).clamp(0, 1))
      const k3 = passed(this.front3).toVar()
      const k1 = passed(this.front1).mul(float(1).sub(k3)).toVar()
      const k2 = passed(this.front2).mul(float(1).sub(k3)).toVar()

      const outside = mix(mix(float(1), this.ghost, k1), this.ghostText, k2)
      const shown = mix(outside, float(1), m)
      const col = mix(bg.rgb, pat.rgb, shown).toVar()
      const inked = mix(col, this.ink, m.mul(k2).mul(this.fill))
      // A thin light riding each front.
      const ring = (f: any) => exp(f.mul(float(1).add(this.soft.mul(2))).sub(this.soft).sub(u).div(this.soft.mul(0.35)).pow(2).negate())
      const glow = max(ring(this.front1).mul(select(this.front1.lessThan(0.999), 1, 0)), ring(this.front2).mul(select(this.front2.lessThan(0.999), 1, 0)))
        .mul(this.edge).mul(select(this.front1.greaterThan(0.001), 1, 0))
      return vec4(mix(inked, pat.rgb.add(0.35), glow.mul(m.max(0.25)).clamp(0, 1)), 1)
    })()
    this.quad = new THREE.QuadMesh(mat)
  }

  /**
   * Run `draw` (the frame's normal passes) into the offscreen picture, render
   * the letters, then composite the stencil to the screen.
   */
  render(renderer: THREE.WebGPURenderer, camera: THREE.Camera, viewport: { width: number; height: number }, background: string, draw: () => void) {
    renderer.getDrawingBufferSize(this.size)
    if (this.sceneRT.width !== this.size.x || this.sceneRT.height !== this.size.y) {
      this.sceneRT.setSize(this.size.x, this.size.y)
      this.maskRT.setSize(this.size.x, this.size.y)
    }
    this.viewport.value.set(viewport.width, viewport.height)
    this.background.value.set(background)

    // Everything that would go to the screen goes to the picture instead.
    const set = renderer.setRenderTarget.bind(renderer)
    renderer.setRenderTarget = ((t: THREE.RenderTarget | null, ...rest: any[]) => set(t ?? this.sceneRT, ...rest)) as any
    try {
      set(this.sceneRT)
      draw()
    } finally {
      renderer.setRenderTarget = set as any
    }

    const clear = renderer.getClearColor(new THREE.Color())
    const clearAlpha = renderer.getClearAlpha()
    renderer.setClearColor(0x000000, 0)
    this.glyphs.upload()
    set(this.maskRT)
    renderer.render(this.maskScene, camera)
    renderer.setClearColor(clear, clearAlpha)

    set(null)
    this.quad.render(renderer)
  }
}

function rt() {
  return new THREE.RenderTarget(1, 1, {
    type: THREE.HalfFloatType, depthBuffer: false, magFilter: THREE.LinearFilter, minFilter: THREE.LinearFilter,
  })
}
