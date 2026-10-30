import * as THREE from 'three/webgpu'
import {
  Fn, If, atan, attribute, cos, dot, exp, float, fract, length, max, mix, mx_fractal_noise_float,
  positionGeometry, screenCoordinate, sin, smoothstep, time, uv, vec2, vec3, vec4,
} from 'three/tsl'
import { previewCell } from './pixels'

// Soft, organic colour shapes drawn as instanced quads: the "things text turns
// into". Each instance picks a form (silhouette + texture) and a gradient
// (how its two colours spread across it).
//
// Per-instance layout (each a vec4):
//   bPos    x, y, rx, ry                     centre + radii in px
//   bStyle  rotation, softness, seed, wobble  softness 0 = crisp, 1 = very diffuse
//   bColor  r, g, b, a                       colour A (centre / start)
//   bColor2 r, g, b, -                       colour B (edge / end)
//   bForm   form, gradient, gradAngle, grain

export const BLOB_FORMS = {
  blob: 0,
  orb: 1,
  bokeh: 2,
  smear: 3,
  watercolour: 4,
  smoke: 5,
} as const
export type BlobForm = keyof typeof BLOB_FORMS

export const BLOB_GRADIENTS = { solid: 0, radial: 1, linear: 2, conic: 3 } as const
export type BlobGradient = keyof typeof BLOB_GRADIENTS

export type BlobBlend = 'normal' | 'multiply' | 'additive'

export interface BlobSpec {
  x: number; y: number; rx: number; ry: number
  rotation?: number
  softness?: number
  seed?: number
  wobble?: number
  color: readonly [number, number, number]
  color2?: readonly [number, number, number]
  alpha: number
  form?: number
  gradient?: number
  gradAngle?: number
  grain?: number
}

export class BlobLayer {
  readonly mesh: THREE.Mesh
  readonly material: THREE.MeshBasicNodeMaterial
  readonly pos: Float32Array
  readonly style: Float32Array
  readonly color: Float32Array
  readonly color2: Float32Array
  readonly form: Float32Array
  private attrs: THREE.InstancedBufferAttribute[]
  private geometry: THREE.InstancedBufferGeometry
  private blendMode: BlobBlend = 'normal'

  constructor(readonly capacity: number, renderOrder: number) {
    this.pos = new Float32Array(capacity * 4)
    this.style = new Float32Array(capacity * 4)
    this.color = new Float32Array(capacity * 4)
    this.color2 = new Float32Array(capacity * 4)
    this.form = new Float32Array(capacity * 4)

    const plane = new THREE.PlaneGeometry(1, 1)
    const geo = (this.geometry = new THREE.InstancedBufferGeometry())
    geo.index = plane.index
    geo.setAttribute('position', plane.getAttribute('position'))
    geo.setAttribute('uv', plane.getAttribute('uv'))
    const named: [string, Float32Array][] = [
      ['bPos', this.pos],
      ['bStyle', this.style],
      ['bColor', this.color],
      ['bColor2', this.color2],
      ['bForm', this.form],
    ]
    this.attrs = named.map(([name, arr]) => {
      const a = new THREE.InstancedBufferAttribute(arr, 4)
      a.setUsage(THREE.DynamicDrawUsage)
      geo.setAttribute(name, a)
      return a
    })
    geo.instanceCount = 0

    const bPos = attribute('bPos', 'vec4')
    const bStyle = attribute('bStyle', 'vec4')
    const bColor = attribute('bColor', 'vec4')
    const bColor2 = attribute('bColor2', 'vec4')
    const bForm = attribute('bForm', 'vec4')

    const mat = (this.material = new THREE.MeshBasicNodeMaterial({
      transparent: true, depthWrite: false, depthTest: false, premultipliedAlpha: true,
    }))

    // Quad extends past the radius to leave room for soft falloff and noisy edges.
    const extent = float(1.25).add(bStyle.y)
    const local = positionGeometry.xy.mul(bPos.zw).mul(extent).mul(2)
    const rot = bStyle.x
    const rotated = vec2(
      local.x.mul(cos(rot)).sub(local.y.mul(sin(rot))),
      local.x.mul(sin(rot)).add(local.y.mul(cos(rot))),
    )
    mat.positionNode = vec3(rotated.add(bPos.xy), 0)

    // Everything shared between branches is materialized with toVar() up
    // front: TSL otherwise hoists a shared subexpression into the first branch
    // that uses it, leaving it unset in the others.
    const form = bForm.x
    const grad = bForm.y
    const gAng = bForm.z
    const shaded = Fn(() => {
      // p: shape space in radius units (|p| = 1 at the nominal edge).
      const p = uv().sub(0.5).mul(2).mul(extent).toVar()
      const r = length(p).toVar()
      const ang = atan(p.y, p.x).toVar()
      const seed = bStyle.z.toVar()
      const s6 = seed.mul(6.2831).toVar()
      const soft = bStyle.y.max(0.02).toVar()
      const a = float(0).toVar()
      const disc = (d: any, sft: any) => float(1).sub(smoothstep(float(1).sub(sft), float(1).add(sft), d))

      If(form.lessThan(0.5), () => {
        // blob: soft disc with an organic edge
        const wob = sin(ang.mul(2).add(s6)).mul(0.6).add(sin(ang.mul(3).sub(s6.mul(1.7))).mul(0.4))
        a.assign(disc(r.div(float(1).add(wob.mul(bStyle.w))), soft))
      })
        .ElseIf(form.lessThan(1.5), () => {
          // orb: pure gaussian light, no plateau
          a.assign(exp(r.mul(r).mul(float(2.6).sub(soft.mul(1.6))).negate()))
        })
        .ElseIf(form.lessThan(2.5), () => {
          // bokeh: hex-ish aperture, faint body with a brighter rim
          const k = float(Math.PI / 3)
          const th = ang.add(s6)
          const seg = th.sub(k.mul(th.div(k).floor())).sub(k.mul(0.5))
          const d = mix(r, r.mul(cos(k.mul(0.5))).div(cos(seg)), 0.55)
          const body = disc(d, soft.mul(0.35))
          const rim = exp(d.sub(0.86).div(soft.mul(0.25).add(0.06)).pow(2).negate())
          a.assign(body.mul(0.38).add(rim.mul(body.max(0.15)).mul(0.62)))
        })
        .ElseIf(form.lessThan(3.5), () => {
          // smear: streak with a bright head, tail fading along -x
          // Stretch stays inside the quad (extent = 1.25 + soft) so edges never clip.
          const streak = disc(length(vec2(p.x.mul(0.85).add(0.15), p.y.mul(1.1))), soft)
          a.assign(streak.mul(smoothstep(-1.7, 0.7, p.x)))
        })
        .ElseIf(form.lessThan(4.5), () => {
          // watercolour: noise-warped edge, pigment pooling at the rim, granulation
          const n = mx_fractal_noise_float(vec3(p.mul(1.3), seed.mul(17).add(time.mul(0.05))), 3, 2, 0.5)
          const d = r.add(n.mul(0.35))
          const fill = disc(d, soft.mul(0.5).add(0.05))
          const edge = exp(d.sub(0.92).div(0.12).pow(2).negate())
          const gran = mx_fractal_noise_float(vec3(p.mul(9), seed.mul(5)), 2, 2, 0.5)
          a.assign(fill.mul(0.82).add(edge.mul(fill.max(0.2)).mul(0.35)).mul(gran.mul(0.3).add(1)))
        })
        .Else(() => {
          // smoke: drifting fbm density inside a soft envelope
          const flow = vec3(p.mul(1.1).add(vec2(0, time.mul(-0.25))), seed.mul(9).add(time.mul(0.12)))
          const n = mx_fractal_noise_float(flow, 4, 2, 0.55).mul(0.5).add(0.5)
          a.assign(smoothstep(soft.mul(0.25).add(0.3), 0.85, n).mul(exp(r.mul(r).mul(1.3).negate())).mul(1.6))
        })

      // Two-tone gradient across the shape.
      const t = float(0).toVar()
      If(grad.greaterThan(0.5).and(grad.lessThan(1.5)), () => t.assign(smoothstep(0, 1.15, r)))
        .ElseIf(grad.lessThan(2.5).and(grad.greaterThan(0.5)), () => t.assign(dot(p, vec2(cos(gAng), sin(gAng))).mul(0.5).add(0.5).clamp(0, 1)))
        .ElseIf(grad.greaterThan(2.5), () => t.assign(sin(ang.mul(2).add(time.mul(0.6)).add(s6)).mul(0.5).add(0.5)))
      return vec4(mix(bColor.rgb, bColor2.rgb, t), a.clamp(0, 1))
    })()
    const shape = shaded.a
    const rgb = shaded.rgb

    // Paper-like grain + interleaved gradient noise against banding.
    const ign = fract(fract(dot(previewCell(screenCoordinate.xy), vec2(0.06711056, 0.00583715))).mul(52.9829189))
    const grain = ign.sub(0.5).mul(bForm.w)
    const alpha = shape.mul(bColor.a).add(ign.sub(0.5).div(255)).add(grain.mul(shape))
    mat.colorNode = vec4(rgb, 1)
    mat.opacityNode = max(alpha, 0).min(1)

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

  set blend(mode: BlobBlend) {
    if (mode === this.blendMode) return
    this.blendMode = mode
    this.material.blending =
      mode === 'multiply' ? THREE.MultiplyBlending : mode === 'additive' ? THREE.AdditiveBlending : THREE.NormalBlending
    this.material.needsUpdate = true
  }

  /** Append one blob; returns false when full. */
  push(b: BlobSpec): boolean {
    const i = this.geometry.instanceCount
    if (i >= this.capacity) return false
    const o = i * 4
    const c2 = b.color2 ?? b.color
    this.pos[o] = b.x; this.pos[o + 1] = b.y; this.pos[o + 2] = b.rx; this.pos[o + 3] = b.ry
    this.style[o] = b.rotation ?? 0
    this.style[o + 1] = b.softness ?? 0.5
    this.style[o + 2] = b.seed ?? 0
    this.style[o + 3] = b.wobble ?? 0.12
    this.color[o] = b.color[0]; this.color[o + 1] = b.color[1]; this.color[o + 2] = b.color[2]; this.color[o + 3] = b.alpha
    this.color2[o] = c2[0]; this.color2[o + 1] = c2[1]; this.color2[o + 2] = c2[2]; this.color2[o + 3] = 0
    this.form[o] = b.form ?? 0
    this.form[o + 1] = b.gradient ?? 0
    this.form[o + 2] = b.gradAngle ?? 0
    this.form[o + 3] = b.grain ?? 0
    this.geometry.instanceCount = i + 1
    return true
  }

  upload() {
    for (const a of this.attrs) {
      a.clearUpdateRanges()
      a.addUpdateRange(0, this.count * 4)
      a.needsUpdate = true
    }
  }
}
