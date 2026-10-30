import type { FolderApi } from 'tweakpane'
import { state } from '../app/state'
import type { Engine } from '../engine/engine'
import { MASK_H, MASK_W, parseStops, stopsText } from '../modes/sequencer/finish'
import { PALETTES } from '../modes/sequencer/palettes'
import { MULTI, RAMPS } from '../modes/sequencer/barcode'

// The Sequencer's gradient map and mask, by hand:
//   editor   a gradient bar with stops: click the bar to add one, drag a stop
//            along to move it (down off the bar to remove it), click it to
//            pick its colour; or load a gradient from the palettes
//   place    handles on the stage: drag the start and end of the gradient
//            (a ring: its centre and edge)
//   mask     a round brush on the stage: paint to mask, hold alt (or pick
//            erase) to take it away; size and softness in the Mask settings
// Values live in the Sequencer's settings (stops and mask as text), so they
// save with presets and scenes.

const SVG_NS = 'http://www.w3.org/2000/svg'
type Values = Record<string, any>
type Tool = 'none' | 'place' | 'mask'

/** Gradients to start from: every palette's rows, the Google hues, the multi-hue. */
function libraryOf(): Record<string, string[]> {
  const lib: Record<string, string[]> = { 'Google · across hues': MULTI }
  for (const [h, hexes] of Object.entries(RAMPS)) lib[`Google · ${h}`] = [...hexes]
  for (const pl of PALETTES) pl.rows.forEach((hexes, i) => (lib[`${pl.label} · ${i + 1}`] = [...hexes]))
  return lib
}

const evenStops = (hexes: readonly string[]) => hexes.map((c, i) => ({ t: hexes.length > 1 ? i / (hexes.length - 1) : 0, c }))

export function mountGradientTools(folder: FolderApi, values: Values, engine: Engine, changed: () => void) {
  const body = folder.element.querySelector<HTMLElement>('.tp-fldv_c') ?? folder.element
  const root = document.createElement('div')
  root.className = 'grad-tools'
  body.prepend(root)

  // --- The stops editor ------------------------------------------------------
  const bar = document.createElement('div')
  bar.className = 'grad-bar'
  const track = document.createElement('div')
  track.className = 'grad-track'
  const row = document.createElement('div')
  row.className = 'grad-row'
  const colour = document.createElement('input')
  colour.type = 'color'
  const where = document.createElement('span')
  where.className = 'grad-where'
  const remove = document.createElement('button')
  remove.textContent = 'Remove stop'
  const reverse = document.createElement('button')
  reverse.textContent = 'Reverse'
  const load = document.createElement('select')
  load.innerHTML = `<option value="">Load a gradient…</option>` + Object.keys(libraryOf()).map((n) => `<option>${n}</option>`).join('')
  row.append(colour, where, remove, reverse)
  root.append(bar, track, row, load)

  let stops = parseStops(values.gradStops)
  let picked = 0
  let shown = values.gradStops
  /** The stops as the settings hold them now (a preset, keyframe or undo may have changed them). */
  const fresh = () => {
    if (values.gradStops === shown) return
    shown = values.gradStops
    stops = parseStops(values.gradStops)
    picked = Math.min(picked, stops.length - 1)
    draw()
  }
  const commit = () => {
    values.gradStops = shown = stopsText(stops)
    draw()
    changed()
  }
  root.addEventListener('pointerenter', fresh)
  root.addEventListener('pointerdown', fresh, true)
  const watch = setInterval(() => (root.isConnected ? fresh() : clearInterval(watch)), 400)
  const draw = () => {
    bar.style.background = `linear-gradient(to right, ${stops.map((s) => `${s.c} ${(s.t * 100).toFixed(2)}%`).join(', ')})`
    track.replaceChildren(...stops.map((s, i) => {
      const h = document.createElement('div')
      h.className = 'grad-stop' + (i === picked ? ' picked' : '')
      h.style.left = `${s.t * 100}%`
      h.style.background = s.c
      h.addEventListener('pointerdown', (e) => dragStop(e, i))
      return h
    }))
    const s = stops[picked]
    colour.value = s?.c ?? '#000000'
    where.textContent = s ? `${Math.round(s.t * 100)}%` : ''
    remove.disabled = stops.length <= 2
  }
  /** The colour the gradient has at t (to give a new stop). */
  const colourAt = (t: number) => {
    let k = 0
    while (k < stops.length - 2 && stops[k + 1].t < t) k++
    const a = stops[k], b = stops[k + 1]
    const u = Math.min(1, Math.max(0, (t - a.t) / Math.max(1e-6, b.t - a.t)))
    const pa = parseInt(a.c.slice(1), 16), pb = parseInt(b.c.slice(1), 16)
    const ch = (sh: number) => Math.round(((pa >> sh) & 255) + (((pb >> sh) & 255) - ((pa >> sh) & 255)) * u)
    return `#${((ch(16) << 16) | (ch(8) << 8) | ch(0)).toString(16).padStart(6, '0')}`
  }
  const tOf = (clientX: number) => {
    const r = bar.getBoundingClientRect()
    return Math.min(1, Math.max(0, (clientX - r.left) / Math.max(1, r.width)))
  }
  bar.addEventListener('pointerdown', (e) => {
    const t = tOf(e.clientX)
    stops.push({ t, c: colourAt(t) })
    stops.sort((a, b) => a.t - b.t)
    picked = stops.findIndex((s) => s.t === t)
    commit()
  })
  const dragStop = (e: PointerEvent, i: number) => {
    e.preventDefault()
    e.stopPropagation()
    picked = i
    const s = stops[i]
    const y0 = e.clientY
    let gone = false
    const move = (ev: PointerEvent) => {
      // Dragged well below the bar: it goes (if two would remain).
      gone = stops.length > 2 && ev.clientY - y0 > 40
      s.t = tOf(ev.clientX)
      track.children[i]?.classList.toggle('leaving', gone)
      ;(track.children[i] as HTMLElement | undefined)?.style.setProperty('left', `${s.t * 100}%`)
      bar.style.background = `linear-gradient(to right, ${[...stops].sort((a, b) => a.t - b.t).map((q) => `${q.c} ${(q.t * 100).toFixed(2)}%`).join(', ')})`
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      if (gone) stops.splice(stops.indexOf(s), 1)
      stops.sort((a, b) => a.t - b.t)
      picked = Math.max(0, stops.indexOf(s))
      commit()
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    draw()
  }
  colour.addEventListener('input', () => {
    fresh()
    if (!stops[picked]) return
    stops[picked].c = colour.value
    commit()
  })
  remove.addEventListener('click', () => {
    if (stops.length <= 2) return
    stops.splice(picked, 1)
    picked = Math.max(0, picked - 1)
    commit()
  })
  reverse.addEventListener('click', () => {
    stops = stops.map((s) => ({ t: 1 - s.t, c: s.c })).sort((a, b) => a.t - b.t)
    commit()
  })
  load.addEventListener('change', () => {
    const hexes = libraryOf()[load.value]
    load.value = ''
    if (!hexes) return
    stops = evenStops(hexes)
    picked = 0
    if (!values.gradOn) values.gradOn = true
    commit()
  })
  draw()

  // --- Stage tools -----------------------------------------------------------
  const tools = document.createElement('div')
  tools.className = 'grad-row'
  const placeBtn = document.createElement('button')
  placeBtn.textContent = 'Place on the stage'
  const maskBtn = document.createElement('button')
  maskBtn.textContent = 'Paint the mask'
  const eraseBtn = document.createElement('button')
  eraseBtn.textContent = 'Erase'
  const clearBtn = document.createElement('button')
  clearBtn.textContent = 'Clear mask'
  const fitBtn = document.createElement('button')
  fitBtn.textContent = 'Fit to the view'
  fitBtn.title = 'Lay the gradient across what the camera shows now'
  tools.append(placeBtn, fitBtn, maskBtn, eraseBtn, clearBtn)
  root.append(tools)
  const hint = document.createElement('p')
  hint.className = 'hint'
  root.append(hint)

  const overlay = stageOverlay(engine, values, changed)
  const sync = () => {
    if (!root.isConnected) return listeners.delete(sync)
    placeBtn.classList.toggle('on', overlay.tool === 'place' && overlay.target === GRADIENT_TARGET)
    maskBtn.classList.toggle('on', overlay.tool === 'mask')
    eraseBtn.classList.toggle('on', overlay.erase)
    eraseBtn.disabled = overlay.tool !== 'mask'
    hint.textContent = overlay.tool === 'place' && overlay.target === GRADIENT_TARGET
      ? 'Drag the two handles on the stage: the gradient runs from the first to the second (a ring: centre and edge). Esc to finish.'
      : overlay.tool === 'mask'
        ? 'Paint on the stage to mask; hold alt (or Erase) to take it away. Brush size and softness are in Mask. Esc to finish.'
        : 'Click the bar to add a stop, drag one to move it (down off the bar to remove it), click it to pick its colour.'
  }
  placeBtn.addEventListener('click', () => {
    const on = overlay.tool === 'place' && overlay.target === GRADIENT_TARGET
    overlay.use(on ? 'none' : 'place', GRADIENT_TARGET)
    sync()
  })
  maskBtn.addEventListener('click', () => { overlay.use(overlay.tool === 'mask' ? 'none' : 'mask'); sync() })
  eraseBtn.addEventListener('click', () => { overlay.erase = !overlay.erase; sync() })
  clearBtn.addEventListener('click', () => {
    values.maskData = ''
    changed()
  })
  fitBtn.addEventListener('click', () => overlay.fitToView(GRADIENT_TARGET))
  listeners.add(sync)
  sync()
}

// --- The overlay on the stage (one for the page) -----------------------------

/**
 * Something placed on the stage with two handles: its settings keys (start x, y, end x, y, in half frame
 * widths / heights from the centre), whether it is drawn as a ring, and how Fit lays it over the view:
 * `line` edge to edge, `frame` as the whole picture (start = its centre, end = its right edge's middle).
 */
export interface PlaceTarget {
  keys: [string, string, string, string]
  ring(values: Values): boolean
  fit: 'line' | 'frame'
  /** After a handle moves (e.g. turn the gradient on). */
  touched?(values: Values): void
}
export const GRADIENT_TARGET: PlaceTarget = {
  keys: ['gradX0', 'gradY0', 'gradX1', 'gradY1'],
  ring: (v) => v.gradShape === 'radial',
  fit: 'line',
  touched: (v) => { if (!v.gradOn) v.gradOn = true },
}

/** Panel controls showing the overlay's state, told when the tool changes. */
const listeners = new Set<() => void>()

interface Overlay {
  fitToView(target?: PlaceTarget): void
  tool: Tool
  target: PlaceTarget
  erase: boolean
  use(tool: Tool, target?: PlaceTarget): void
  onTool: () => void
}
let current: (Overlay & { values: Values; changed: () => void }) | null = null

function stageOverlay(engine: Engine, values: Values, changed: () => void): Overlay {
  if (current) {
    // The panel was redrawn: the overlay carries on with the new settings object.
    current.values = values
    current.changed = changed
    return current
  }
  const stage = engine.canvas.parentElement!
  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.classList.add('grad-overlay')
  stage.appendChild(svg)
  const line = document.createElementNS(SVG_NS, 'line')
  const ring = document.createElementNS(SVG_NS, 'circle')
  ring.setAttribute('fill', 'none')
  const handleA = document.createElementNS(SVG_NS, 'circle')
  const handleB = document.createElementNS(SVG_NS, 'circle')
  const brush = document.createElementNS(SVG_NS, 'circle')
  for (const h of [handleA, handleB]) { h.setAttribute('r', '9'); h.classList.add('grad-handle') }
  line.classList.add('grad-line')
  ring.classList.add('grad-line')
  brush.classList.add('grad-brush')
  const box = document.createElementNS(SVG_NS, 'polygon')
  box.classList.add('grad-line')
  box.setAttribute('fill', 'none')
  svg.append(box, ring, line, handleA, handleB, brush)

  const o: Overlay & { values: Values; changed: () => void } = {
    /** Lay the target across what the camera shows now (its direction kept). */
    fitToView(target: PlaceTarget = o.target) {
      const { width: w, height: h } = engine.frameSize
      const v = state.view, p = o.values
      const [kx0, ky0, kx1, ky1] = target.keys
      const cx = v.x * w, cy = v.y * h, hw = w / 2 / v.zoom, hh = h / 2 / v.zoom
      let dx = (p[kx1] - p[kx0]) * w / 2, dy = (p[ky1] - p[ky0]) * h / 2
      const len = Math.hypot(dx, dy) || 1
      dx /= len; dy /= len
      if (!Number.isFinite(dx) || (dx === 0 && dy === 0)) { dx = 1; dy = 0 }
      const ring = target.ring(p)
      // Line: edge to edge of the view along it; ring: from the middle to the nearer edge; frame: the whole
      // picture fitted to the view (centred on it, half the view wide).
      const reach = target.fit === 'frame' ? hw : ring ? Math.min(hw, hh) : Math.abs(dx) * hw + Math.abs(dy) * hh
      const fromCentre = ring || target.fit === 'frame'
      const ax = fromCentre ? cx : cx - dx * reach, ay = fromCentre ? cy : cy - dy * reach
      const clamp = (u: number) => Math.max(-4, Math.min(4, u))
      p[kx0] = clamp(ax / (w / 2)); p[ky0] = clamp(ay / (h / 2))
      p[kx1] = clamp((cx + dx * reach) / (w / 2)); p[ky1] = clamp((cy + dy * reach) / (h / 2))
      target.touched?.(p)
      o.changed()
    },
    target: GRADIENT_TARGET,
    tool: 'none' as Tool,
    erase: false,
    values,
    changed,
    onTool: () => listeners.forEach((f) => f()),
    use(tool: Tool, target?: PlaceTarget) {
      o.tool = tool
      if (target) o.target = target
      queueMicrotask(() => o.onTool())
      svg.style.display = tool === 'none' ? 'none' : 'block'
      if (tool !== 'none') frame()
    },
  }
  current = o

  /** Frame px (from the centre, y up) <-> client px, through the view. */
  const toClient = (x: number, y: number) => {
    const r = engine.canvas.getBoundingClientRect()
    const { width: w, height: h } = engine.frameSize
    const v = state.view
    return { x: r.left + ((x - v.x * w) * v.zoom / w + 0.5) * r.width, y: r.top + (0.5 - (y - v.y * h) * v.zoom / h) * r.height }
  }
  const toFrame = (cx: number, cy: number) => {
    const r = engine.canvas.getBoundingClientRect()
    const { width: w, height: h } = engine.frameSize
    const v = state.view
    return { x: v.x * w + ((cx - r.left) / r.width - 0.5) * w / v.zoom, y: v.y * h + (0.5 - (cy - r.top) / r.height) * h / v.zoom }
  }
  /** Lay the overlay over the canvas and draw the handles; every frame while a tool is on. */
  const frame = () => {
    if (o.tool === 'none') return
    const sr = stage.getBoundingClientRect(), r = engine.canvas.getBoundingClientRect()
    Object.assign(svg.style, { left: `${r.left - sr.left}px`, top: `${r.top - sr.top}px`, width: `${r.width}px`, height: `${r.height}px` })
    const { width: w, height: h } = engine.frameSize
    const p = o.values
    const at = (x: number, y: number) => { const c = toClient(x, y); return { x: c.x - r.left, y: c.y - r.top } }
    const [kx0, ky0, kx1, ky1] = o.target.keys
    const a = at(p[kx0] * w / 2, p[ky0] * h / 2), b = at(p[kx1] * w / 2, p[ky1] * h / 2)
    const place = o.tool === 'place'
    for (const el of [line, handleA, handleB]) el.style.display = place ? '' : 'none'
    ring.style.display = place && o.target.ring(p) ? '' : 'none'
    // A whole picture placed (the colours): its frame, moved, turned and scaled with the handles.
    box.style.display = place && o.target.fit === 'frame' ? '' : 'none'
    if (place && o.target.fit === 'frame') {
      const ux = b.x - a.x, uy = b.y - a.y
      // The handle reaches half the frame's width; its height follows the frame's shape.
      const k = h / w
      const corner = (sx: number, sy: number) => `${a.x + ux * sx - uy * k * sy},${a.y + uy * sx + ux * k * sy}`
      box.setAttribute('points', [corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)].join(' '))
    }
    line.setAttribute('x1', `${a.x}`); line.setAttribute('y1', `${a.y}`); line.setAttribute('x2', `${b.x}`); line.setAttribute('y2', `${b.y}`)
    // A handle past the edge of the view (zoomed in) waits at the edge, hollow, still to be dragged.
    const pin = (q: { x: number; y: number }, el: SVGCircleElement) => {
      const m = 14
      const x = Math.min(r.width - m, Math.max(m, q.x)), y = Math.min(r.height - m, Math.max(m, q.y))
      el.setAttribute('cx', `${x}`); el.setAttribute('cy', `${y}`)
      el.classList.toggle('offscreen', x !== q.x || y !== q.y)
    }
    pin(a, handleA)
    pin(b, handleB)
    ring.setAttribute('cx', `${a.x}`); ring.setAttribute('cy', `${a.y}`); ring.setAttribute('r', `${Math.hypot(b.x - a.x, b.y - a.y)}`)
    brush.style.display = o.tool === 'mask' ? '' : 'none'
    brush.setAttribute('r', `${(p.brushSize / 2) * (r.width / w) * state.view.zoom}`)
    requestAnimationFrame(frame)
  }

  // Placing: drag a handle.
  const dragHandle = (which: 0 | 1) => (e: PointerEvent) => {
    e.preventDefault()
    e.stopPropagation()
    const move = (ev: PointerEvent) => {
      const { width: w, height: h } = engine.frameSize
      const f = toFrame(ev.clientX, ev.clientY)
      const [kx0, ky0, kx1, ky1] = o.target.keys
      const kx = which ? kx1 : kx0, ky = which ? ky1 : ky0
      // The first handle moves the whole thing (the second keeps its place relative to it).
      if (!which) {
        const dx = f.x / (w / 2) - o.values[kx0], dy = f.y / (h / 2) - o.values[ky0]
        o.values[kx1] = Math.max(-4, Math.min(4, o.values[kx1] + dx))
        o.values[ky1] = Math.max(-4, Math.min(4, o.values[ky1] + dy))
      }
      o.values[kx] = Math.max(-4, Math.min(4, f.x / (w / 2)))
      o.values[ky] = Math.max(-4, Math.min(4, f.y / (h / 2)))
      o.target.touched?.(o.values)
      o.changed()
    }
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up) }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }
  handleA.addEventListener('pointerdown', dragHandle(0))
  handleB.addEventListener('pointerdown', dragHandle(1))

  // Masking: paint with a round brush into the mask grid.
  let grid = new Uint8Array(MASK_W * MASK_H)
  const read = () => {
    grid = new Uint8Array(MASK_W * MASK_H)
    try {
      const bin = atob(o.values.maskData || '')
      for (let i = 0; i < Math.min(bin.length, grid.length); i++) grid[i] = bin.charCodeAt(i)
    } catch { /* start clean */ }
  }
  const write = () => {
    let bin = ''
    for (let i = 0; i < grid.length; i++) bin += String.fromCharCode(grid[i])
    o.values.maskData = btoa(bin)
    if (!o.values.maskOn) o.values.maskOn = true
    o.changed()
  }
  const dab = (cx: number, cy: number, erase: boolean) => {
    const { width: w, height: h } = engine.frameSize
    const f = toFrame(cx, cy)
    const gx = (f.x / w + 0.5) * MASK_W, gy = (0.5 - f.y / h) * MASK_H
    const rad = (o.values.brushSize / 2) / w * MASK_W
    const soft = Math.min(1, Math.max(0, o.values.brushSoft))
    for (let y = Math.floor(gy - rad - 1); y <= Math.ceil(gy + rad + 1); y++) {
      if (y < 0 || y >= MASK_H) continue
      for (let x = Math.floor(gx - rad - 1); x <= Math.ceil(gx + rad + 1); x++) {
        if (x < 0 || x >= MASK_W) continue
        const d = Math.hypot(x + 0.5 - gx, y + 0.5 - gy) / Math.max(0.5, rad)
        if (d > 1) continue
        // Solid to (1 - softness) of the radius, then falling to nothing at the edge.
        const inner = 1 - soft
        const v = d <= inner ? 1 : 1 - (d - inner) / Math.max(1e-3, soft)
        const k = y * MASK_W + x
        grid[k] = erase ? Math.min(grid[k], Math.round(255 * (1 - v))) : Math.max(grid[k], Math.round(255 * v))
      }
    }
  }
  svg.addEventListener('pointerdown', (e) => {
    if (o.tool !== 'mask') return
    e.preventDefault()
    read()
    const erase = o.erase || e.altKey
    dab(e.clientX, e.clientY, erase)
    write()
    let last = 0
    const move = (ev: PointerEvent) => {
      dab(ev.clientX, ev.clientY, erase)
      // A few writes a second while painting (the picture follows), and one at the end.
      const now = performance.now()
      if (now - last > 50) { last = now; write() }
    }
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); write() }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  })
  svg.addEventListener('pointermove', (e) => {
    const r = engine.canvas.getBoundingClientRect()
    brush.setAttribute('cx', `${e.clientX - r.left}`)
    brush.setAttribute('cy', `${e.clientY - r.top}`)
  })
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && o.tool !== 'none') { o.use('none'); o.onTool() }
  })
  o.use('none')
  return o
}

/** The Dots colours (its dot colour, wherever the palette paints by place or part), placed on the stage. */
export const COLOUR_TARGET: PlaceTarget = {
  keys: ['dots_colX0', 'dots_colY0', 'dots_colX1', 'dots_colY1'],
  ring: () => false,
  fit: 'frame',
}

/** Buttons to move, turn and scale the Dots colours on the stage (its Colour group). */
export function mountColourPlace(folder: FolderApi, values: Values, engine: Engine, changed: () => void) {
  const body = folder.element.querySelector<HTMLElement>('.tp-fldv_c') ?? folder.element
  const root = document.createElement('div')
  root.className = 'grad-tools'
  body.append(root)
  const row = document.createElement('div')
  row.className = 'grad-row'
  const place = document.createElement('button')
  place.textContent = 'Place colours on the stage'
  const fit = document.createElement('button')
  fit.textContent = 'Fit colours to the view'
  const reset = document.createElement('button')
  reset.textContent = 'Reset'
  row.append(place, fit, reset)
  const hint = document.createElement('p')
  hint.className = 'hint'
  root.append(row, hint)
  const overlay = stageOverlay(engine, values, changed)
  const on = () => overlay.tool === 'place' && overlay.target === COLOUR_TARGET
  const sync = () => {
    if (!root.isConnected) return listeners.delete(sync)
    place.classList.toggle('on', on())
    hint.textContent = on()
      ? 'Drag the first handle to move the colours, the second to turn and scale them (the box is where the whole picture\'s colours now sit). Esc to finish.'
      : 'Move, turn and scale where the colours fall: the dots keep their places and sizes, only their colours come from somewhere else.'
  }
  place.addEventListener('click', () => { overlay.use(on() ? 'none' : 'place', COLOUR_TARGET); sync() })
  fit.addEventListener('click', () => overlay.fitToView(COLOUR_TARGET))
  reset.addEventListener('click', () => {
    Object.assign(values, { dots_colX0: 0, dots_colY0: 0, dots_colX1: 1, dots_colY1: 0 })
    changed()
  })
  listeners.add(sync)
  sync()
}
