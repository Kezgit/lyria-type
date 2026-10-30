import * as THREE from 'three/webgpu'
import {
  Fn, If, dot, exp, float, fract, mix, mx_fractal_noise_float, positionGeometry, screenCoordinate, smoothstep, time,
  uniform, uniformArray, uv, vec2, vec3, vec4,
} from 'three/tsl'
import { previewCell } from './pixels'

// Full-screen layers: a soft gradient field behind everything and a film-grain
// veil over everything. Both are a single quad drawn in clip space.

export const BACKDROP_STYLES = { none: 0, mesh: 1, aurora: 2 } as const
export type BackdropStyle = keyof typeof BACKDROP_STYLES

export const BACKDROP_POINTS = 6

export interface BackdropPoint {
  x: number
  y: number
  /** Influence radius in px. */
  r: number
  weight: number
  color: readonly [number, number, number]
}

function fullscreen(mat: THREE.MeshBasicNodeMaterial, renderOrder: number) {
  mat.vertexNode = vec4(positionGeometry.xy.mul(2), 0, 1)
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat)
  mesh.frustumCulled = false
  mesh.renderOrder = renderOrder
  return mesh
}

export class Backdrop {
  readonly mesh: THREE.Mesh
  private style = uniform(0)
  private opacity = uniform(0)
  private viewport = uniform(new THREE.Vector2(1, 1))
  private points = Array.from({ length: BACKDROP_POINTS }, () => new THREE.Vector4())
  private colors = Array.from({ length: BACKDROP_POINTS }, () => new THREE.Vector4())

  constructor() {
    const mat = new THREE.MeshBasicNodeMaterial({
      transparent: true, depthWrite: false, depthTest: false, premultipliedAlpha: true,
    })
    const ptsArr = uniformArray(this.points, 'vec4')
    const colsArr = uniformArray(this.colors, 'vec4')
    const pts = { element: (i: number) => ptsArr.element(i) as unknown as ReturnType<typeof vec4> }
    const cols = { element: (i: number) => colsArr.element(i) as unknown as ReturnType<typeof vec4> }
    const out = Fn(() => {
      // Materialize shared values before branching (see blobLayer.ts).
      const px = uv().sub(0.5).mul(this.viewport).toVar()
      const vy = uv().y.toVar()
      const rgb = vec3(0).toVar()
      const a = float(0).toVar()

      If(this.style.lessThan(1.5), () => {
        // Mesh gradient: normalized gaussian weights around moving control points.
        const sumW = float(0).toVar()
        const sumC = vec3(0).toVar()
        for (let i = 0; i < BACKDROP_POINTS; i++) {
          const pt = pts.element(i)
          const d = px.sub(pt.xy).div(pt.z)
          const w = exp(dot(d, d).negate()).mul(pt.w)
          sumW.addAssign(w)
          sumC.addAssign(cols.element(i).xyz.mul(w))
        }
        rgb.assign(sumC.div(sumW.add(1e-4)))
        a.assign(float(1).sub(exp(sumW.mul(1.6).negate())))
      }).Else(() => {
        // Aurora: noise curtains drifting sideways, coloured bottom -> top.
        const n = mx_fractal_noise_float(
          vec3(px.x.mul(0.0035).add(time.mul(0.03)), px.y.mul(0.0006), time.mul(0.06)), 4, 2, 0.5,
        )
        const curtains = smoothstep(-0.15, 0.55, n)
        const t = vy.add(n.mul(0.25)).clamp(0, 1)
        const c0 = cols.element(0).xyz
        const c1 = cols.element(1).xyz
        const c2 = cols.element(2).xyz
        rgb.assign(mix(mix(c0, c1, smoothstep(0, 0.55, t)), c2, smoothstep(0.45, 1, t)))
        const band = exp(px.y.div(this.viewport.y.mul(0.32)).pow(2).negate())
        a.assign(curtains.mul(band).mul(float(0.55).add(pts.element(0).w.mul(0.45))))
      })
      return vec4(rgb, a.mul(this.opacity))
    })()

    mat.colorNode = vec4(out.rgb, 1)
    mat.opacityNode = out.a
    this.mesh = fullscreen(mat, -10)
    this.mesh.visible = false
  }

  update(style: BackdropStyle, opacity: number, viewport: { width: number; height: number }, points: BackdropPoint[]) {
    const s = BACKDROP_STYLES[style] ?? 0
    this.mesh.visible = s > 0 && opacity > 0
    this.style.value = s
    this.opacity.value = opacity
    this.viewport.value.set(viewport.width, viewport.height)
    for (let i = 0; i < BACKDROP_POINTS; i++) {
      const p = points[i]
      if (!p) {
        this.points[i].set(0, 0, 1, 0)
        continue
      }
      this.points[i].set(p.x, p.y, Math.max(1, p.r), p.weight)
      this.colors[i].set(p.color[0], p.color[1], p.color[2], 1)
    }
  }
}

export class Grain {
  readonly mesh: THREE.Mesh
  readonly amount = uniform(0)

  constructor() {
    const mat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, depthTest: false })
    // Per-pixel, per-frame hash: light and dark specks at low opacity.
    const seed = previewCell(screenCoordinate.xy).add(vec2(fract(time.mul(13.1)).mul(431), fract(time.mul(7.7)).mul(277)))
    const h = fract(fract(dot(seed, vec2(0.06711056, 0.00583715))).mul(52.9829189))
    mat.colorNode = vec4(vec3(h.greaterThan(0.5).select(1, 0)), 1)
    mat.opacityNode = h.sub(0.5).abs().mul(2).mul(this.amount)
    this.mesh = fullscreen(mat, 50)
    this.mesh.visible = false
  }

  set value(v: number) {
    this.amount.value = v
    this.mesh.visible = v > 0
  }
}
