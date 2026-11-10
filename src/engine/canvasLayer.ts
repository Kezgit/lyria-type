import * as THREE from 'three/webgpu'

// A picture drawn with the 2D canvas, shown as the frame: for modes that draw
// on the CPU (Stacked line). It fills the frame like the other layers, so the
// view's zoom, exports and recordings all take it as they are.

export class CanvasLayer {
  readonly mesh: THREE.Mesh
  readonly canvas = document.createElement('canvas')
  /** Set by a mode each frame it wants the canvas shown (the engine clears it first). */
  enabled = false
  private tex: THREE.CanvasTexture
  private mat: THREE.MeshBasicMaterial

  constructor(renderOrder = 1) {
    this.canvas.width = this.canvas.height = 2
    this.tex = this.makeTexture()
    this.mat = new THREE.MeshBasicMaterial({ map: this.tex, toneMapped: false, depthTest: false, depthWrite: false })
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.mat)
    this.mesh.frustumCulled = false
    this.mesh.renderOrder = renderOrder
    this.mesh.visible = false
  }

  private makeTexture() {
    const t = new THREE.CanvasTexture(this.canvas)
    t.colorSpace = THREE.SRGBColorSpace
    t.generateMipmaps = false
    t.minFilter = THREE.LinearFilter
    t.magFilter = THREE.LinearFilter
    return t
  }

  /** The 2D context at w x h device px (a new size makes a new texture). */
  context(w: number, h: number): CanvasRenderingContext2D {
    w = Math.max(2, Math.round(w))
    h = Math.max(2, Math.round(h))
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w
      this.canvas.height = h
      this.tex.dispose()
      this.tex = this.makeTexture()
      this.mat.map = this.tex
      this.mat.needsUpdate = true
    }
    return this.canvas.getContext('2d')!
  }

  /** The canvas was drawn: upload it. */
  changed() {
    this.tex.needsUpdate = true
  }

  /** Each frame, after the mode: shown or not, sized to the frame (CSS px, centred). */
  sync(viewport: { width: number; height: number }) {
    this.mesh.visible = this.enabled
    this.mesh.scale.set(viewport.width, viewport.height, 1)
  }
}
