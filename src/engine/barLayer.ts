import * as THREE from 'three/webgpu'
import {
  abs, attribute, cos, dot, float, fract, length, max, min, mix, positionGeometry, screenCoordinate, select, sin, smoothstep,
  texture, time, uniform, varying, vec2, vec3, vec4,
} from 'three/tsl'
import { edgePx, previewCell } from './pixels'

// Flat gradient bars drawn as instanced rects: the colour strips that fill the
// gaps Gap mode opens between letters, and the bands, cells and stripes of the
// Sequencer modes. Each bar samples one row of a gradient atlas (row 0 unless
// it picks another) and the stretch of it it shows (t0 -> t1 across its
// width), mirrored past 0..1 so a scrolling phase never jumps. A bar can also
// carry a line pattern (rulings, grids, hatching, an X, a frame) drawn over
// its fill in a colour from the same row.
//
// Per-instance layout (each a vec4):
//   rPos   x, y, w, h                     centre + size in px
//   rGrad  t0, t1, alpha, grain           gradient span across the bar, fill opacity, grain amount
//   rStyle rotation, feather, row, radius  radians, edge softness in px, gradient row, corner radius px
//   rLine  pattern, spacing, width, phase  BAR_PATTERNS id, px between lines, line px, offset px
//   rLineC t, alpha, -, -                  line colour (position in the row), line opacity

const RAMP_SIZE = 256
/** Gradient rows available to bars. */
export const BAR_ROWS = 64

export const BAR_PATTERNS = {
  none: 0,
  vertical: 1,
  horizontal: 2,
  grid: 3,
  diagonal: 4,
  antidiagonal: 5,
  crosshatch: 6,
  /** Corner-to-corner X across the bar. */
  cross: 7,
  /** Outline along the bar's edge. */
  frame: 8,
} as const
export type BarPattern = keyof typeof BAR_PATTERNS

export type BarBlend = 'normal' | 'multiply'

export interface BarSpec {
  x: number; y: number; w: number; h: number
  t0: number; t1: number
  alpha?: number
  grain?: number
  rotation?: number
  feather?: number
  /** Corner radius, px (half the short side: a dot or a pill). */
  radius?: number
  /** Gradient row (see setGradient). */
  row?: number
  pattern?: BarPattern
  /** Px between pattern lines. */
  spacing?: number
  /** Pattern line width, px. */
  lineWidth?: number
  /** Shifts the pattern across the bar, px. */
  phase?: number
  /** Line colour: position in the bar's gradient row. */
  lineT?: number
  lineAlpha?: number
  /** The stem the mark belongs to (an index into the Sequencer's ORDER), for colouring by sound; CPU side only. */
  stem?: number
}

export class BarLayer {
  readonly mesh: THREE.Mesh
  readonly material: THREE.MeshBasicNodeMaterial
  readonly pos: Float32Array
  readonly grad: Float32Array
  readonly style: Float32Array
  readonly line: Float32Array
  readonly lineC: Float32Array
  /** Per bar: its stem (BarSpec.stem), -1 when it has none. Not drawn; for passes that colour by sound. */
  readonly stems: Int8Array
  private attrs: THREE.InstancedBufferAttribute[]
  private geometry: THREE.InstancedBufferGeometry
  private ramp: THREE.DataTexture
  private rampKeys: string[] = []
  private multiply = uniform(0)
  /**
   * Least feather, px. Drawn into a coarser target (a blur layer's half-res,
   * squashed one), small bars would be point-sampled; feathered to its pixel
   * they keep their area wherever they fall.
   */
  readonly minFeather = uniform(0)
  private blendMode: BarBlend = 'normal'

  constructor(readonly capacity: number, renderOrder: number) {
    this.pos = new Float32Array(capacity * 4)
    this.grad = new Float32Array(capacity * 4)
    this.style = new Float32Array(capacity * 4)
    this.line = new Float32Array(capacity * 4)
    this.lineC = new Float32Array(capacity * 4)
    this.stems = new Int8Array(capacity)

    const plane = new THREE.PlaneGeometry(1, 1)
    const geo = (this.geometry = new THREE.InstancedBufferGeometry())
    geo.index = plane.index
    geo.setAttribute('position', plane.getAttribute('position'))
    geo.setAttribute('uv', plane.getAttribute('uv'))
    const named: [string, Float32Array][] = [
      ['rPos', this.pos],
      ['rGrad', this.grad],
      ['rStyle', this.style],
      ['rLine', this.line],
      ['rLineC', this.lineC],
    ]
    this.attrs = named.map(([name, arr]) => {
      const a = new THREE.InstancedBufferAttribute(arr, 4)
      a.setUsage(THREE.DynamicDrawUsage)
      geo.setAttribute(name, a)
      return a
    })
    geo.instanceCount = 0

    // sRGB stops, interpolated like a CSS gradient; decoded to linear on sample.
    this.ramp = new THREE.DataTexture(new Uint8Array(RAMP_SIZE * BAR_ROWS * 4), RAMP_SIZE, BAR_ROWS)
    this.ramp.colorSpace = THREE.SRGBColorSpace
    this.ramp.magFilter = THREE.LinearFilter
    this.ramp.minFilter = THREE.LinearFilter
    this.ramp.wrapS = THREE.ClampToEdgeWrapping
    this.ramp.wrapT = THREE.ClampToEdgeWrapping
    this.setGradient(['#000000', '#ffffff'])

    const rPos = attribute('rPos', 'vec4')
    const rGrad = attribute('rGrad', 'vec4')
    const rStyle = attribute('rStyle', 'vec4')
    const rLine = attribute('rLine', 'vec4')
    const rLineC = attribute('rLineC', 'vec4')

    const mat = (this.material = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, depthTest: false }))

    // Quad grows by the feather so soft edges aren't clipped.
    const feather = max(rStyle.y, this.minFeather)
    const size = rPos.zw.add(feather.mul(2))
    const local = positionGeometry.xy.mul(size)
    const r = rStyle.x
    const rotated = vec2(
      local.x.mul(cos(r)).sub(local.y.mul(sin(r))),
      local.x.mul(sin(r)).add(local.y.mul(cos(r))),
    )
    mat.positionNode = vec3(rotated.add(rPos.xy), 0)

    // Distance inside the nominal rect, px (negative outside).
    const q = varying(local)
    const inside = rPos.zw.mul(0.5).sub(abs(q))
    const f = max(feather, edgePx(0.5))
    const square = smoothstep(f.negate(), f, inside.x).mul(smoothstep(f.negate(), f, inside.y))
    // Rounded: signed distance to the rect with its corners rounded by the radius.
    const rad = min(rStyle.w, min(rPos.z, rPos.w).mul(0.5))
    const kx = abs(q.x).sub(rPos.z.mul(0.5).sub(rad))
    const ky = abs(q.y).sub(rPos.w.mul(0.5).sub(rad))
    const sd = length(vec2(max(kx, 0), max(ky, 0))).add(min(max(kx, ky), 0)).sub(rad)
    const coverage = select(rStyle.w.greaterThan(0), smoothstep(f.negate(), f, sd.negate()), square)

    // Along-bar position 0..1 (nominal rect), then mirrored so any span is smooth.
    const v = rStyle.z.add(0.5).div(BAR_ROWS)
    const u = q.x.div(max(rPos.z, 1e-3)).add(0.5).clamp(0, 1)
    const t = mix(rGrad.x, rGrad.y, u)
    const mirrored = float(1).sub(abs(fract(t.mul(0.5)).mul(2).sub(1)))
    const fill = texture(this.ramp, vec2(mirrored, v)).rgb
    const lineCol = texture(this.ramp, vec2(rLineC.x.clamp(0, 1), v)).rgb

    // Pattern lines: coverage of the nearest line, antialiased over ~1px.
    const spacing = max(rLine.y, 1)
    const half = rLine.z.mul(0.5)
    const ruled = (d: any) => {
      const dist = abs(fract(d.add(rLine.w).div(spacing).add(0.5)).sub(0.5)).mul(spacing)
      return float(1).sub(smoothstep(half.sub(edgePx(0.5)), half.add(edgePx(0.5)), dist))
    }
    const onLine = (dist: any) => float(1).sub(smoothstep(half.sub(edgePx(0.5)), half.add(edgePx(0.5)), dist))
    const vert = ruled(q.x)
    const horiz = ruled(q.y)
    const diag = ruled(q.x.add(q.y).mul(0.7071))
    const anti = ruled(q.x.sub(q.y).mul(0.7071))
    const wh = rPos.zw
    const diagLen = max(length(wh), 1e-3)
    const cross = max(
      onLine(abs(q.x.mul(wh.y).sub(q.y.mul(wh.x))).div(diagLen)),
      onLine(abs(q.x.mul(wh.y).add(q.y.mul(wh.x))).div(diagLen)),
    )
    const frame = onLine(min(inside.x, inside.y).sub(half))
    const pid = rLine.x
    const is = (n: number) => select(abs(pid.sub(n)).lessThan(0.5), float(1), float(0))
    const pattern = vert.mul(is(1))
      .add(horiz.mul(is(2)))
      .add(max(vert, horiz).mul(is(3)))
      .add(diag.mul(is(4)))
      .add(anti.mul(is(5)))
      .add(max(diag, anti).mul(is(6)))
      .add(cross.mul(is(7)))
      .add(frame.mul(is(8)))

    // Lines over fill.
    const fA = coverage.mul(rGrad.z)
    const lA = coverage.mul(pattern).mul(rLineC.y)
    const outA = lA.add(fA.mul(float(1).sub(lA)))
    const premul = lineCol.mul(lA).add(fill.mul(fA).mul(float(1).sub(lA)))
    const col = premul.div(max(outA, 1e-4))

    // Film-like grain inside the bar (the reference's dithered gradients).
    const n = fract(fract(dot(previewCell(screenCoordinate.xy).add(time.mul(61.3)), vec2(0.06711056, 0.00583715))).mul(52.9829189))
    const grained = col.add(n.sub(0.5).mul(rGrad.w)).max(0)
    // Multiply: ink over the page (blend = dst * src), so overlaps darken.
    const isMul = this.multiply.greaterThan(0.5)
    mat.colorNode = vec4(select(isMul, mix(vec3(1), grained, outA), grained), 1)
    mat.opacityNode = select(isMul, float(1), outA)

    this.mesh = new THREE.Mesh(geo, mat)
    this.mesh.frustumCulled = false
    this.mesh.renderOrder = renderOrder
  }

  /** Evenly spaced sRGB hex stops, left (t = 0) to right (t = 1), into a gradient row. */
  setGradient(hexes: readonly string[], row = 0) {
    const key = hexes.join()
    if (key === this.rampKeys[row]) return
    this.rampKeys[row] = key
    const c = new THREE.Color()
    const stops = hexes.map((h) => {
      c.setStyle(h, THREE.SRGBColorSpace)
      const s = c.clone().convertLinearToSRGB()
      return [s.r, s.g, s.b]
    })
    const data = this.ramp.image.data as Uint8Array
    const base = row * RAMP_SIZE * 4
    for (let i = 0; i < RAMP_SIZE; i++) {
      const x = (i / (RAMP_SIZE - 1)) * (stops.length - 1)
      const k = Math.min(stops.length - 2, Math.floor(x))
      const a = stops[k], b = stops[k + 1] ?? a
      const w = x - k
      for (let ch = 0; ch < 3; ch++) data[base + i * 4 + ch] = Math.round((a[ch] + (b[ch] - a[ch]) * w) * 255)
      data[base + i * 4 + 3] = 255
    }
    this.ramp.needsUpdate = true
  }

  /** Take every gradient row from another layer (so a haze of its marks paints in the same colours). */
  copyGradients(from: BarLayer) {
    ;(this.ramp.image.data as Uint8Array).set(from.ramp.image.data as Uint8Array)
    this.ramp.needsUpdate = true
  }

  /** The colour a gradient row gives at t (0..1), linear rgb, for drawing a mark some other way (as a character). */
  sampleRow(row: number, t: number, out: [number, number, number]) {
    const data = this.ramp.image.data as Uint8Array
    const r = Math.min(BAR_ROWS - 1, Math.max(0, Math.round(row)))
    const i = Math.round(Math.min(1, Math.max(0, t)) * (RAMP_SIZE - 1))
    const o = (r * RAMP_SIZE + i) * 4
    const lin = (c: number) => { const v = c / 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4 }
    out[0] = lin(data[o]); out[1] = lin(data[o + 1]); out[2] = lin(data[o + 2])
    return out
  }

  set blend(mode: BarBlend) {
    if (mode === this.blendMode) return
    this.blendMode = mode
    this.multiply.value = mode === 'multiply' ? 1 : 0
    this.material.blending = mode === 'multiply' ? THREE.MultiplyBlending : THREE.NormalBlending
    this.material.premultipliedAlpha = mode === 'multiply'
    this.material.needsUpdate = true
  }

  set count(n: number) {
    this.geometry.instanceCount = Math.min(n, this.capacity)
  }

  get count() {
    return this.geometry.instanceCount
  }

  /** Append one bar; returns false when full. */
  push(b: BarSpec): boolean {
    const i = this.geometry.instanceCount
    if (i >= this.capacity) return false
    const o = i * 4
    this.pos[o] = b.x; this.pos[o + 1] = b.y; this.pos[o + 2] = b.w; this.pos[o + 3] = b.h
    this.grad[o] = b.t0; this.grad[o + 1] = b.t1; this.grad[o + 2] = b.alpha ?? 1; this.grad[o + 3] = b.grain ?? 0
    this.style[o] = b.rotation ?? 0
    this.style[o + 1] = b.feather ?? 0.5
    this.style[o + 2] = b.row ?? 0
    this.style[o + 3] = b.radius ?? 0
    this.line[o] = BAR_PATTERNS[b.pattern ?? 'none']
    this.line[o + 1] = b.spacing ?? 8
    this.line[o + 2] = b.lineWidth ?? 1
    this.line[o + 3] = b.phase ?? 0
    this.lineC[o] = b.lineT ?? 1
    this.lineC[o + 1] = b.lineAlpha ?? 1
    this.stems[i] = b.stem ?? -1
    this.geometry.instanceCount = i + 1
    return true
  }

  /** Copy bar `i` as a new one moved by (dx, dy), px (e.g. its other half across a wrap); false when full. */
  duplicate(i: number, dx: number, dy: number): boolean {
    const n = this.geometry.instanceCount
    if (n >= this.capacity || i >= n) return false
    for (const arr of [this.pos, this.grad, this.style, this.line, this.lineC]) arr.copyWithin(n * 4, i * 4, i * 4 + 4)
    this.stems[n] = this.stems[i]
    this.pos[n * 4] += dx
    this.pos[n * 4 + 1] += dy
    this.geometry.instanceCount = n + 1
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
