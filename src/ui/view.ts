import { state } from '../app/state'
import type { Engine } from '../engine/engine'

// Zoom and pan on the preview, as design apps do: a trackpad pinch (or
// ctrl / cmd + wheel) zooms about the pointer, a two-finger swipe (or the
// wheel) pans; the hand tool (H, or hold space) drags to pan; cmd / ctrl + and
// − zoom, cmd / ctrl 0 fits. Writes state.view (zoom, and the pan in frame
// widths / heights), which the preview and exports both show. Otherwise clicks
// and drags pick letters (picker.ts); an option-drag (or the middle button)
// pans too, and an option-double-click resets.

export const MIN_ZOOM = 0.25, MAX_ZOOM = 64
const MIN = MIN_ZOOM, MAX = MAX_ZOOM

/** The hand tool: on from the toolbar (or H), or while space is held. Dragging then pans, not picks. */
export const viewTool = { hand: false, space: false }
export const panning = () => viewTool.hand || viewTool.space

/** Zoom by `k` about a picture point (px from the frame's centre, y up; default the middle of the view). */
export function zoomBy(engine: Engine, k: number, at?: { sx: number; sy: number }) {
  const view = state.view
  const { width: w, height: h } = engine.frameSize
  const sx = at?.sx ?? 0, sy = at?.sy ?? 0
  const px = view.x * w + sx / view.zoom, py = view.y * h + sy / view.zoom
  view.zoom = Math.min(MAX, Math.max(MIN, view.zoom * k))
  view.x = (px - sx / view.zoom) / w
  view.y = (py - sy / view.zoom) / h
}

export function attachView(engine: Engine, changed: () => void) {
  const canvas = engine.canvas
  const view = state.view

  /** A pointer position as picture px from the frame's centre (y up), at the current view. */
  const picturePoint = (e: { clientX: number; clientY: number }) => {
    const r = canvas.getBoundingClientRect()
    const { width: w, height: h } = engine.frameSize
    const sx = ((e.clientX - r.left) / r.width - 0.5) * w
    const sy = (0.5 - (e.clientY - r.top) / r.height) * h
    return { sx, sy, px: view.x * w + sx / view.zoom, py: view.y * h + sy / view.zoom }
  }

  canvas.addEventListener('wheel', (e) => {
    e.preventDefault()
    if (e.ctrlKey || e.metaKey) {
      // Pinch (the browser sends it as ctrl + wheel), or cmd / ctrl + wheel: zoom about the pointer.
      const { sx, sy } = picturePoint(e)
      zoomBy(engine, Math.exp(-e.deltaY * 0.01), { sx, sy })
    } else {
      // Two-finger swipe, or the wheel: pan (shift + wheel pans sideways).
      const r = canvas.getBoundingClientRect()
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? r.height : 1
      const dx = (e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX) * unit, dy = (e.shiftKey && !e.deltaX ? 0 : e.deltaY) * unit
      view.x += dx / r.width / view.zoom
      view.y -= dy / r.height / view.zoom
    }
    changed()
  }, { passive: false })

  // Keys: space held = hand, H = hand tool, V = back to picking, cmd / ctrl + − 0 = zoom in, out, fit.
  const typing = (e: KeyboardEvent) => {
    const t = e.target as HTMLElement | null
    return !!t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))
  }
  window.addEventListener('keydown', (e) => {
    if (typing(e)) return
    if (e.code === 'Space' && !e.repeat) { viewTool.space = true; canvas.style.cursor = 'grab'; e.preventDefault(); changed() }
    else if ((e.metaKey || e.ctrlKey) && (e.key === '=' || e.key === '+')) { zoomBy(engine, 1.25); e.preventDefault(); changed() }
    else if ((e.metaKey || e.ctrlKey) && e.key === '-') { zoomBy(engine, 0.8); e.preventDefault(); changed() }
    else if ((e.metaKey || e.ctrlKey) && e.key === '0') { Object.assign(view, { zoom: 1, x: 0, y: 0 }); e.preventDefault(); changed() }
    else if (!e.metaKey && !e.ctrlKey && !e.altKey && (e.key === 'h' || e.key === 'H')) { viewTool.hand = true; changed() }
    else if (!e.metaKey && !e.ctrlKey && !e.altKey && (e.key === 'v' || e.key === 'V')) { viewTool.hand = false; changed() }
  })
  window.addEventListener('keyup', (e) => {
    if (e.code === 'Space') { viewTool.space = false; changed() }
  })

  /** Whether a press is the view's, not the letter picker's. */
  const forView = (e: MouseEvent) => e.altKey || e.button === 1 || panning()
  let drag: { x: number; y: number } | null = null
  canvas.addEventListener('pointerdown', (e) => {
    if (!forView(e)) return
    drag = { x: e.clientX, y: e.clientY }
    canvas.setPointerCapture(e.pointerId)
  })
  canvas.addEventListener('pointermove', (e) => {
    if (!drag) return
    const r = canvas.getBoundingClientRect()
    view.x -= (e.clientX - drag.x) / r.width / view.zoom
    view.y += (e.clientY - drag.y) / r.height / view.zoom
    drag = { x: e.clientX, y: e.clientY }
    changed()
  })
  const end = () => (drag = null)
  canvas.addEventListener('pointerup', end)
  canvas.addEventListener('pointercancel', end)
  canvas.addEventListener('dblclick', (e) => {
    if (!forView(e)) return
    Object.assign(view, { zoom: 1, x: 0, y: 0 })
    changed()
  })
  // A hand where dragging pans; an arrow where clicks pick letters.
  const cursor = (e: MouseEvent) => (canvas.style.cursor = forView(e) ? (drag ? 'grabbing' : 'grab') : 'default')
  canvas.addEventListener('pointermove', cursor)
  canvas.addEventListener('pointerenter', cursor)
  canvas.style.cursor = 'default'
}
