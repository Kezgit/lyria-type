import * as THREE from 'three/webgpu'
import { Backdrop, Grain } from './backdrop'
import { BarLayer } from './barLayer'
import { BlobLayer } from './blobLayer'
import { GlyphLayer } from './glyphLayer'
import { GooLayer } from './gooLayer'
import { BlurredGlyphLayer } from './blurredGlyphLayer'
import { BlurredBarLayer } from './blurLayer'
import { FieldFx } from './fieldFx'
import { StretchFx } from './stretchFx'
import { StencilFx } from './stencilFx'
import { HALO_ATLAS, SdfAtlas } from '../text/atlas/sdfAtlas'
import { shapeText, type ShapedGlyph, type ShapedText } from '../text/shaping'
import { ensureFont, getFont } from '../text/fonts/registry'
import { getLayout } from '../layout'
import type { Placement } from '../layout/types'
import { getMode } from '../modes'
import type { ModeInstance } from '../modes/types'
import type { AudioEngine } from '../audio/audioEngine'
import type { AudioFeatures } from '../audio/features'
import { PREVIEW_PIXEL_RATIO, pixelScale, viewZoom } from './pixels'
import { emit, on, state } from '../app/state'
import { LAYERS } from '../audio/analysis/listener'
import { colourKey, rampFor } from '../modes/orchestra/layers'
import { PartsTracker } from '../modes/shared/parts'
import { dropFx } from './dropFx'
import { animate } from '../app/keyframes'

const MAX_GLYPHS = 4096
const MAX_BLOBS = 4096
/** The picture's frame: the preview fits it in the stage (letterboxed), exports render it at any size. */
export const FRAME_ASPECT = 16 / 9

// Owns the renderer and runs the per-frame pipeline:
//   shaped text -> layout placements -> mode writes layers -> GPU draw.
// Pixel-space orthographic camera: 1 unit = 1 CSS px, origin at centre, y up.
// The viewport is a fixed-aspect frame fitted in the stage; an export renders
// that same frame (same layout, same CSS px) at a higher pixel ratio.
export class Engine {
  readonly renderer: THREE.WebGPURenderer
  readonly scene = new THREE.Scene()
  readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -10, 10)
  readonly atlas = new SdfAtlas()
  readonly haloAtlas = new SdfAtlas(HALO_ATLAS)
  readonly glyphs: GlyphLayer
  /** Letters re-drawn from the crisp atlas (appended per frame): small offset + blur, sharp-looking. */
  readonly outlines: GlyphLayer
  /** Halo glyphs blurred together as one image: lightly (mid) and heavily (far). */
  readonly halosMid: BlurredGlyphLayer
  readonly halosFar: BlurredGlyphLayer
  /** Feedback colour field fed by hit glyphs; drawn when a mode enables it. */
  readonly field: FieldFx
  readonly back = new BlobLayer(MAX_BLOBS, 0)
  /** Gradient rects between the back shapes and the text. */
  readonly bars = new BarLayer(MAX_BLOBS, 5)
  /** Bars blurred together as one image, under the crisp ones: lightly (mid) and heavily (far). */
  readonly barsFar = new BlurredBarLayer(MAX_BLOBS, 3)
  readonly barsMid = new BlurredBarLayer(MAX_BLOBS, 4)
  /** Glyphs and bars merged into gooey forms (metaball morphs), just under the text. */
  readonly goo: GooLayer
  readonly front = new BlobLayer(MAX_BLOBS, 20)
  readonly backdrop = new Backdrop()
  readonly grain = new Grain()
  readonly stretch = new StretchFx()
  /** The frame shown through the typed text (Stencil mode); off unless a mode enables it. */
  readonly stencil: StencilFx

  private text: ShapedText | null = null
  private placements: Placement[] = []
  private mode: ModeInstance | null = null
  private modeId = ''
  private parts = new PartsTracker()
  private viewport = { width: 1, height: 1 }
  private ink = new THREE.Color()
  private clock = new THREE.Timer()
  private shapeToken = 0
  /** Font the current text was shaped in (loaded), and extra glyph sets shaped in it for modes. */
  private shapedFontId = ''
  private glyphSets = new Map<string, ShapedGlyph[]>()

  constructor(private container: HTMLElement, private audio: AudioEngine) {
    this.renderer = new THREE.WebGPURenderer({ antialias: true })
    this.renderer.setPixelRatio(PREVIEW_PIXEL_RATIO)
    container.appendChild(this.renderer.domElement)

    this.glyphs = new GlyphLayer(MAX_GLYPHS, this.atlas.texture, this.atlas.sdf)
    this.outlines = new GlyphLayer(MAX_GLYPHS * 4, this.atlas.texture, this.atlas.sdf, 15)
    this.goo = new GooLayer(MAX_GLYPHS, MAX_BLOBS, this.atlas.texture, this.atlas.sdf, 9)
    this.halosFar = new BlurredGlyphLayer(MAX_GLYPHS, this.haloAtlas.texture, this.haloAtlas.sdf, 12)
    this.halosMid = new BlurredGlyphLayer(MAX_GLYPHS, this.haloAtlas.texture, this.haloAtlas.sdf, 13)
    this.field = new FieldFx(MAX_GLYPHS, this.haloAtlas.texture, this.haloAtlas.sdf, 12)
    this.stencil = new StencilFx(this.atlas.texture, this.atlas.sdf)
    this.scene.add(
      this.backdrop.mesh, this.back.mesh, this.barsFar.composite, this.barsMid.composite, this.bars.mesh, this.goo.composite, this.glyphs.mesh,
      this.field.composite, this.halosFar.composite, this.halosMid.composite, this.outlines.mesh,
      this.front.mesh, this.grain.mesh,
    )

    new ResizeObserver(() => this.resize()).observe(container)
    on('text', () => this.reshape())
    on('fonts', () => this.reshape())
  }

  /** The largest texture side WebGPU guarantees (exports stay within it). */
  readonly maxTextureSize = 8192

  async start() {
    await this.renderer.init()
    this.resize()
    await this.reshape()
    this.renderer.setAnimationLoop((t) => this.frame(t))
  }

  get canvas() {
    return this.renderer.domElement
  }

  /** Where every letter sits right now (px from the stage centre, y up), for picking letters on the stage. */
  get letters() {
    return { text: this.text, placements: this.placements, viewport: this.viewport }
  }

  /** Re-shape after text, font, size or tracking changes. */
  async reshape() {
    const token = ++this.shapeToken
    await ensureFont(state.fontId)
    if (token !== this.shapeToken) return
    this.text = shapeText(state.text, getFont(state.fontId), this.atlas, this.haloAtlas, {
      fontSize: state.fontSize,
      tracking: state.tracking,
      wrapWidth: state.wrap > 0 ? this.viewport.width * state.wrap : 0,
    })
    this.shapedFontId = state.fontId
    const n = Math.min(this.text.glyphs.length, MAX_GLYPHS)
    this.text.glyphs.length = n
    while (this.placements.length < n) this.placements.push({ x: 0, y: 0, rotation: 0, scale: 1 })
    this.placements.length = n
  }

  /**
   * Glyphs for arbitrary characters (one per inked char, in order) in the
   * current text's font and size, for modes that set their own marks
   * (append them with writeOutline). Cached until the font, size or atlas changes.
   */
  private glyphsFor = (chars: string): ShapedGlyph[] => {
    const size = this.text?.fontSize ?? state.fontSize
    const key = `${this.shapedFontId}\u0000${size}\u0000${this.atlas.generation}:${this.haloAtlas.generation}\u0000${chars}`
    let hit = this.glyphSets.get(key)
    if (!hit) {
      if (this.glyphSets.size > 32) this.glyphSets.clear()
      hit = shapeText(chars, getFont(this.shapedFontId), this.atlas, this.haloAtlas, { fontSize: size, tracking: 0 }).glyphs
      this.glyphSets.set(key, hit)
    }
    return hit
  }

  /** The frame (FRAME_ASPECT) fitted in the stage, in whole CSS px (width a multiple of 16, so 16:9 is exact). */
  private resize() {
    if (this.exporting) return
    const { clientWidth: cw, clientHeight: ch } = this.container
    if (!cw || !ch) return
    const w = Math.max(16, Math.floor(Math.min(cw, ch * FRAME_ASPECT) / 16) * 16)
    const h = Math.round(w / FRAME_ASPECT)
    // Wrapped text follows the view's width.
    const rewrap = state.wrap > 0 && w !== this.viewport.width && this.viewport.width > 1
    this.viewport = { width: w, height: h }
    if (rewrap) this.reshape()
    this.renderer.setSize(w, h)
    Object.assign(this.camera, { left: -w / 2, right: w / 2, top: h / 2, bottom: -h / 2 })
    this.camera.updateProjectionMatrix()
  }

  /** Seconds the live loop has run (shader / mode time), for exporting the frame on screen. */
  get liveTime() {
    return this.clock.getElapsed()
  }

  /** The preview frame's size, CSS px. */
  get frameSize() {
    return { ...this.viewport }
  }

  private frame(t: number) {
    if (this.viewport.height <= 1) return this.resize()
    this.clock.update(t)
    const dt = Math.min(this.clock.getDelta(), 1 / 20)
    const time = this.clock.getElapsed()
    this.renderAt(dt, time, this.audio.update(dt))
  }

  // --- Export ------------------------------------------------------------------
  private exporting = false

  /**
   * Stop the live loop and render the same frame at `width` device px across
   * (the height follows the frame). `fresh` restarts the mode (an export from
   * its first frame). Undo with endExport.
   */
  beginExport(width: number, fresh: boolean) {
    this.exporting = true
    this.renderer.setAnimationLoop(null)
    const { width: w, height: h } = this.viewport
    const ratio = width / w
    this.renderer.setDrawingBufferSize(w, h, ratio)
    pixelScale.value = ratio / PREVIEW_PIXEL_RATIO
    if (fresh) this.modeId = ''
    return { width: Math.round(w * ratio), height: Math.round(h * ratio) }
  }

  endExport() {
    this.exporting = false
    pixelScale.value = 1
    this.renderer.setPixelRatio(PREVIEW_PIXEL_RATIO)
    this.resize()
    this.renderer.setAnimationLoop((t) => this.frame(t))
  }

  /**
   * One export frame. `grab` runs in the same task as the render: a WebGPU
   * canvas only holds the frame until it's presented, so take it (a
   * VideoFrame, or start createImageBitmap) right away.
   */
  renderExportFrame<T>(dt: number, time: number, audio: AudioFeatures, grab: (canvas: HTMLCanvasElement) => T): T {
    this.renderAt(dt, time, audio)
    return grab(this.renderer.domElement)
  }

  /** The frame at the current settings: everything a mode writes, then the GPU passes. */
  private renderAt(dt: number, time: number, audio: AudioFeatures) {
    // The view: zoom about the frame's centre, then pan; modes still lay out in the unzoomed frame.
    const { zoom, x, y } = state.view
    this.camera.zoom = Math.max(0.05, zoom)
    this.camera.position.set(x * this.viewport.width, y * this.viewport.height, 0)
    this.camera.updateProjectionMatrix()
    viewZoom.value = this.camera.zoom
    this.renderer.setClearColor(state.background)
    this.back.count = 0
    this.front.count = 0
    this.bars.count = 0
    this.barsFar.bars.count = 0
    this.barsMid.bars.count = 0
    this.goo.glyphs.count = 0
    this.glyphs.mask.on.value = 0
    this.stencil.enabled = false
    this.stencil.glyphs.count = 0
    this.goo.bars.count = 0
    this.barsFar.stretch = 1
    this.barsMid.stretch = 1
    // Under the text unless a mode lifts it over (Type Bloom's blooms).
    this.barsMid.composite.renderOrder = 4
    // Over the text unless a mode puts it under (Type Bloom's cursor smoke).
    this.field.composite.renderOrder = 12
    this.back.blend = 'normal'
    this.front.blend = 'normal'
    this.bars.blend = 'normal'
    this.backdrop.mesh.visible = false
    this.grain.value = 0
    const wasStretching = this.stretch.enabled
    this.stretch.enabled = false
    this.stretch.clip = null
    this.stretch.lanesOn = false
    const wasField = this.field.enabled
    this.field.enabled = false
    this.field.inject.count = 0
    this.field.injectBars.count = 0
    this.field.expand.value = 0
    this.field.expandKeep.value = 1
    this.field.look = 'flat'
    this.field.dt.value = dt
    const text = this.text
    if (text) {
      getLayout(state.layoutId).apply(text, state.layoutParams[state.layoutId], this.viewport, this.placements)

      if (state.modeId !== this.modeId) {
        this.mode?.dispose?.()
        // A mode switch starts the shared trail effect plain (the Orchestra layers a lot on top of it).
        this.stretch.neutral()
        this.mode = getMode(state.modeId).create()
        this.modeId = state.modeId
      }
      this.ink.set(state.ink)
      this.glyphs.count = text.glyphs.length
      this.outlines.count = 0
      this.halosMid.glyphs.count = 0
      this.halosFar.glyphs.count = 0
      // Letters given to instruments, shared by every mode; their colours from the Orchestra's (light pages deepen).
      const orch = state.modeParams.orchestra ?? {}
      const colours = LAYERS.map((l) => orch[colourKey(l)] as string)
      const parts = this.parts.update(audio, text, state.letterParts, colours, dt, orch, state.modeId !== 'orchestra')
      const light = (() => {
        const n = parseInt(state.background.slice(1), 16)
        return (0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255 > 0.6
      })()
      this.stretch.setPartRamps(colours.map((c) => rampFor(c ?? '#888888', light)))
      this.mode!.update({
        dt, time, audio, text,
        base: this.placements,
        // Keyframes, while they play, move the settings (app/keyframes.ts).
        params: animate(state.modeId, state.modeParams[state.modeId], dt),
        modeParams: state.modeParams,
        ink: [this.ink.r, this.ink.g, this.ink.b],
        background: state.background,
        setBackground: (hex: string) => {
          state.background = hex
          emit('params')
        },
        viewport: this.viewport,
        fontId: this.shapedFontId,
        glyphsFor: this.glyphsFor,
        parts,
        layers: {
          backdrop: this.backdrop, back: this.back, bars: this.bars, barsMid: this.barsMid, barsFar: this.barsFar, goo: this.goo, glyphs: this.glyphs,
          outlines: this.outlines, halosMid: this.halosMid, halosFar: this.halosFar,
          front: this.front, grain: this.grain, stretch: this.stretch, field: this.field, stencil: this.stencil,
        },
      })
    }
    // Images dropped on the stage: wipe their colours across what the mode drew, ripple or warp (dropFx.ts).
    dropFx.frame(this.viewport.width, this.viewport.height, state.drop)
    if (dropFx.any) {
      dropFx.applyBars(this.bars, dropFx.colours('dots'))
      dropFx.applyBars(this.goo.bars, dropFx.colours('dots'))
      dropFx.applyBars(this.barsMid.bars, dropFx.colours('gradient'))
      dropFx.applyBars(this.barsFar.bars, dropFx.colours('gradient'))
    }
    this.stretch.setDrops(dropFx.active, dropFx.colours('gradient'), state.drop.style === 'warp' ? state.drop.warp : 0)
    this.back.upload()
    this.bars.upload()
    this.glyphs.upload()
    this.outlines.upload()
    this.front.upload()
    const draw = () => {
      if (this.stretch.enabled) {
        if (!wasStretching) this.stretch.reset()
        this.goo.composite.visible = false
        this.stretch.render(this.renderer, this.scene, this.camera, this.glyphs, this.viewport)
      } else {
        if (this.field.enabled && !wasField) this.field.reset()
        this.field.render(this.renderer, this.camera, this.viewport)
        this.halosFar.render(this.renderer, this.camera)
        this.halosMid.render(this.renderer, this.camera)
        this.barsFar.render(this.renderer, this.camera)
        this.barsMid.render(this.renderer, this.camera)
        this.goo.render(this.renderer, this.camera)
        this.renderer.render(this.scene, this.camera)
      }
    }
    if (this.stencil.enabled) this.stencil.render(this.renderer, this.camera, this.viewport, state.background, draw)
    else draw()
  }
}
