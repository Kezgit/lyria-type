import { state } from '../app/state'
import type { Stem } from '../audio/features'
import type { Engine } from '../engine/engine'
import { DEFAULT_SIZE, KINDS, decodePlaced, encodePlaced, type Placed, type PlacedKind } from '../modes/sequencer/placed'
import { stemColours } from './stemColours'
import { panning } from './view'

// Compose: placing Dots' elements by hand (the Sequencer's Manual style). The
// card holds the tools (select, and each element), the part a new element
// plays, its weight, and undo / redo; while it's open in Manual, the stage is
// editable, Figma-style:
//   empty stage    with an element tool: click to place one, drag to size it;
//                  with select: drag a box to select
//   an element     click to select (shift: add / drop), drag to move (alt-drag
//                  copies); the box's corner / edge handles scale (shift keeps
//                  the shape, alt scales from the centre); just outside a
//                  corner rotates (shift: 15° steps)
//   keys           ⌫ delete · ⌘Z / ⇧⌘Z undo / redo · ⌘D duplicate · ⌘A all ·
//                  arrows nudge (shift: more) · Esc deselects, then back to select
// Marks live in the mode's `manual_marks` setting (modes/sequencer/placed.ts).

const KEY = 'manual_marks'
const STEMS: Stem[] = ['vocals', 'instruments', 'drums', 'bass']
const STEM_LABEL: Record<Stem, string> = { vocals: 'Vocals', instruments: 'Instruments', drums: 'Drums', bass: 'Bass' }
const SVG_NS = 'http://www.w3.org/2000/svg'
const ROUND = new Set<PlacedKind>(['dot', 'soft', 'ghost', 'blob'])
const ROTATE_CURSOR = `url("data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><path d="M6 15a7 7 0 0111.6-7.4M18 4v4.5h-4.5" fill="none" stroke="white" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"/><path d="M6 15a7 7 0 0111.6-7.4M18 4v4.5h-4.5" fill="none" stroke="black" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>')}") 12 12, crosshair`

const TOOL_ICONS: Record<'select' | PlacedKind, string> = {
  select: '<path d="M6 4l11 6.5-4.8 1.3L10.4 17z" fill="currentColor" stroke="none"/>',
  dot: '<circle cx="12" cy="12" r="5.5" fill="currentColor" stroke="none"/>',
  soft: '<circle cx="12" cy="12" r="4" fill="currentColor" stroke="none" opacity=".55"/>',
  ghost: '<circle cx="12" cy="12" r="2.2" fill="currentColor" stroke="none" opacity=".4"/>',
  streak: '<rect x="9.5" y="3.5" width="5" height="17" rx="2.5" fill="currentColor" stroke="none" opacity=".5"/>',
  blob: '<ellipse cx="12" cy="12" rx="7.5" ry="6" fill="currentColor" stroke="none" opacity=".35"/>',
}

type Handle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w'
const HANDLES: [Handle, number, number][] = [['nw', -1, -1], ['n', 0, -1], ['ne', 1, -1], ['e', 1, 0], ['se', 1, 1], ['s', 0, 1], ['sw', -1, 1], ['w', -1, 0]]
const CURSORS: Record<Handle, string> = { nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize', n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize' }

interface Box {
  /** Centre, half extents (px) and angle (deg, clockwise), on the stage. */
  cx: number; cy: number; hw: number; hh: number; a: number
}

export interface ComposeApi {
  /** Whether the Compose card is open. */
  open(): boolean
  /** Switch to the Sequencer's Manual style, keeping any placed marks. */
  startManual(): void
}

export function buildCompose(page: HTMLElement, engine: Engine, api: ComposeApi) {
  const stage = engine.canvas.parentElement!
  const values = () => state.modeParams.sequencer
  const inManual = () => state.modeId === 'sequencer' && values().style === 'manual'

  // --- The marks: a working copy of the setting, written back as they change ----------
  let list: Placed[] = []
  let written = ''
  const sync = () => {
    const text = (values()[KEY] as string) ?? ''
    if (text === written) return
    written = text
    list = decodePlaced(text).map((m) => ({ ...m }))
    selected.clear()
  }
  const write = () => {
    written = encodePlaced(list)
    values()[KEY] = written
  }

  // --- Undo / redo: the marks as text before each change ------------------------------
  const undo: string[] = []
  const redo: string[] = []
  let before: string | null = null
  const begin = () => (before = encodePlaced(list))
  const commit = () => {
    if (before === null) return
    const now = encodePlaced(list)
    if (now !== before) {
      undo.push(before)
      if (undo.length > 200) undo.shift()
      redo.length = 0
      write()
    }
    before = null
    renderCard()
  }
  const step = (from: string[], to: string[]) => {
    const text = from.pop()
    if (text === undefined) return
    to.push(encodePlaced(list))
    list = decodePlaced(text).map((m) => ({ ...m }))
    selected.clear()
    write()
    renderCard()
  }

  // --- The card -------------------------------------------------------------------------
  let tool: 'select' | PlacedKind = 'select'
  let stem: Stem = 'vocals'
  let weight = 0.5
  const selected = new Set<number>()

  const intro = document.createElement('div')
  intro.className = 'compose-intro'
  intro.innerHTML = '<p class="hint">Place dots, streaks and blobs by hand, and move, scale and turn them on the stage. They play with the music like the Sequencer’s Dots.</p>'
  const startBtn = document.createElement('button')
  startBtn.className = 'compose-wide'
  startBtn.textContent = 'Start composing'
  startBtn.addEventListener('click', () => api.startManual())
  intro.appendChild(startBtn)

  const tools = document.createElement('div')
  tools.className = 'compose-tools'
  const toolButtons = new Map<string, HTMLButtonElement>()
  for (const id of ['select', ...KINDS.map((k) => k.id)] as ('select' | PlacedKind)[]) {
    const b = document.createElement('button')
    const label = id === 'select' ? 'Select' : KINDS.find((k) => k.id === id)!.label
    b.title = id === 'select' ? 'Select and move (V)' : `${label}: ${KINDS.find((k) => k.id === id)!.hint}`
    b.innerHTML = `<svg viewBox="0 0 24 24" width="20" height="20">${TOOL_ICONS[id]}</svg><span>${label}</span>`
    b.addEventListener('click', () => {
      tool = id
      renderCard()
    })
    toolButtons.set(id, b)
    tools.appendChild(b)
  }

  const parts = document.createElement('div')
  parts.className = 'compose-parts'
  const partButtons = new Map<Stem, HTMLButtonElement>()
  for (const s of STEMS) {
    const b = document.createElement('button')
    b.innerHTML = `<i></i>${STEM_LABEL[s]}`
    b.title = `Plays with the ${STEM_LABEL[s].toLowerCase()}`
    b.addEventListener('click', () => {
      stem = s
      if (selected.size) {
        begin()
        for (const i of selected) list[i].s = s
        commit()
      }
      renderCard()
    })
    partButtons.set(s, b)
    parts.appendChild(b)
  }

  const weightRow = document.createElement('label')
  weightRow.className = 'compose-weight'
  weightRow.innerHTML = '<span>weight</span><input type="range" min="0" max="1" step="0.01"><b></b>'
  const weightInput = weightRow.querySelector('input')!
  const weightRead = weightRow.querySelector('b')!
  weightInput.addEventListener('pointerdown', () => selected.size && begin())
  weightInput.addEventListener('input', () => {
    weight = Number(weightInput.value)
    weightRead.textContent = weight.toFixed(2)
    for (const i of selected) list[i].lv = weight
    if (selected.size) write()
  })
  weightInput.addEventListener('change', () => commit())

  const actions = document.createElement('div')
  actions.className = 'compose-actions'
  const action = (label: string, title: string, run: () => void) => {
    const b = document.createElement('button')
    b.textContent = label
    b.title = title
    b.addEventListener('click', run)
    actions.appendChild(b)
    return b
  }
  const undoBtn = action('↶ Undo', 'Undo (⌘Z)', () => step(undo, redo))
  const redoBtn = action('↷ Redo', 'Redo (⇧⌘Z)', () => step(redo, undo))
  const dupBtn = action('Duplicate', 'Duplicate the selection (⌘D, or alt-drag)', () => duplicate(0.02))
  const delBtn = action('Delete', 'Delete the selection (⌫)', () => remove())
  const clearBtn = action('Clear all', 'Remove every placed element', () => {
    if (!list.length || !confirm(`Remove all ${list.length} placed elements?`)) return
    begin()
    list = []
    selected.clear()
    commit()
  })
  const status = document.createElement('p')
  status.className = 'hint compose-status'

  const editor = document.createElement('div')
  editor.className = 'compose-editor'
  const section = (title: string, ...els: HTMLElement[]) => {
    const h = document.createElement('h5')
    h.textContent = title
    editor.append(h, ...els)
  }
  section('Tool', tools)
  section('Plays with', parts)
  editor.appendChild(weightRow)
  section('Edit', actions)
  editor.appendChild(status)
  page.append(intro, editor)

  function renderCard() {
    const manual = inManual()
    intro.hidden = manual
    editor.hidden = !manual
    for (const [id, b] of toolButtons) b.classList.toggle('on', id === tool)
    // The part and weight show the selection's when one is picked.
    const picked = [...selected].map((i) => list[i]).filter(Boolean)
    if (picked.length) {
      stem = picked.every((m) => m.s === picked[0].s) ? picked[0].s : stem
      weight = picked[0].lv
    }
    const cols = stemColours(engine)
    for (const [s, b] of partButtons) {
      b.classList.toggle('on', s === stem)
      b.style.setProperty('--c', cols[s])
    }
    weightInput.value = String(weight)
    weightRead.textContent = weight.toFixed(2)
    undoBtn.disabled = !undo.length
    redoBtn.disabled = !redo.length
    dupBtn.disabled = delBtn.disabled = !selected.size
    clearBtn.disabled = !list.length
    status.textContent = selected.size
      ? `${selected.size} selected. Drag to move, handles to scale, just outside a corner to rotate.`
      : tool === 'select'
        ? `${list.length} placed. Click one to select it, or drag a box around several.`
        : `Click the stage to place a ${KINDS.find((k) => k.id === tool)!.label.toLowerCase()}, or drag to size it. Click an element to move it.`
  }

  // --- Editing helpers --------------------------------------------------------------------
  function remove() {
    if (!selected.size) return
    begin()
    list = list.filter((_, i) => !selected.has(i))
    selected.clear()
    commit()
  }
  function duplicate(offset: number) {
    if (!selected.size) return
    begin()
    const copies = [...selected].map((i) => ({ ...list[i], x: list[i].x + offset, y: list[i].y - offset }))
    selected.clear()
    for (const c of copies) selected.add(list.push(c) - 1)
    commit()
  }

  // --- The stage overlay ------------------------------------------------------------------
  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.classList.add('compose-overlay')
  stage.appendChild(svg)
  const g = document.createElementNS(SVG_NS, 'g')
  svg.appendChild(g)

  /** Frame geometry: mark units (frame heights, y up) <-> stage px. */
  const geom = () => {
    const { viewport } = engine.letters
    const sr = stage.getBoundingClientRect()
    const cr = engine.canvas.getBoundingClientRect()
    const W = Math.max(1, viewport.width), H = Math.max(1, viewport.height)
    const k = cr.width / W
    const { zoom, x: panX, y: panY } = state.view
    const z = Math.max(0.05, zoom)
    const ox = cr.left - sr.left, oy = cr.top - sr.top
    return {
      /** Px per mark unit. */
      s: H * z * k,
      toStage: (X: number, Y: number) => ({ x: ox + (W / 2 + (X * H - panX * W) * z) * k, y: oy + (H / 2 - (Y * H - panY * H) * z) * k }),
      toUnits: (x: number, y: number) => ({ X: (((x - ox) / k - W / 2) / z + panX * W) / H, Y: ((H / 2 - (y - oy) / k) / z + panY * H) / H }),
    }
  }
  const boxOf = (m: Placed, G = geom()): Box => {
    const c = G.toStage(m.x, m.y)
    return { cx: c.x, cy: c.y, hw: (m.w / 2) * G.s, hh: (m.h / 2) * G.s, a: m.r }
  }
  const rotate = (x: number, y: number, deg: number) => {
    const t = (deg * Math.PI) / 180, c = Math.cos(t), s = Math.sin(t)
    return { x: x * c - y * s, y: x * s + y * c }
  }
  /** A point in a box's own frame (unrotated, from its centre). */
  const local = (b: Box, x: number, y: number) => rotate(x - b.cx, y - b.cy, -b.a)
  const corner = (b: Box, ux: number, uy: number) => {
    const p = rotate(ux * b.hw, uy * b.hh, b.a)
    return { x: b.cx + p.x, y: b.cy + p.y }
  }
  const hit = (m: Placed, x: number, y: number, G = geom()) => {
    const b = boxOf(m, G)
    const p = local(b, x, y)
    const pad = 4
    if (ROUND.has(m.k)) return (p.x / (b.hw + pad)) ** 2 + (p.y / (b.hh + pad)) ** 2 <= 1
    return Math.abs(p.x) <= b.hw + pad && Math.abs(p.y) <= b.hh + pad
  }
  const topAt = (x: number, y: number) => {
    const G = geom()
    for (let i = list.length - 1; i >= 0; i--) if (hit(list[i], x, y, G)) return i
    return -1
  }
  /** The transform box: one mark's own (rotated), or several marks' bounds (upright). */
  const selectionBox = (): Box | null => {
    const picked = [...selected].map((i) => list[i]).filter(Boolean)
    if (!picked.length) return null
    const G = geom()
    if (picked.length === 1) return boxOf(picked[0], G)
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
    for (const m of picked) {
      const b = boxOf(m, G)
      for (const [ux, uy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
        const p = corner(b, ux, uy)
        x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y)
      }
    }
    return { cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, hw: (x1 - x0) / 2, hh: (y1 - y0) / 2, a: 0 }
  }
  /** Handle size for a box: smaller on small elements; edge handles only when there's room. */
  const handleSize = (b: Box) => (Math.min(b.hw, b.hh) < 10 ? 6 : 8)
  const handlesOf = (b: Box) => HANDLES.filter(([, ux, uy]) => (ux && uy) || (ux ? b.hh > 18 : b.hw > 18))
  const handleAt = (b: Box, x: number, y: number): Handle | null => {
    const r = handleSize(b) / 2 + 3
    for (const [h, ux, uy] of handlesOf(b)) {
      const p = corner(b, ux, uy)
      if (Math.abs(p.x - x) <= r && Math.abs(p.y - y) <= r) return h
    }
    return null
  }
  /** Just outside a corner: rotate. */
  const rotateZone = (b: Box, x: number, y: number) => {
    const r = handleSize(b) / 2
    for (const [ux, uy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      const p = corner(b, ux, uy)
      const d = Math.hypot(p.x - x, p.y - y)
      if (d > r + 2 && d < r + 18) {
        // Outside the box itself.
        const q = local(b, x, y)
        if (Math.abs(q.x) > b.hw || Math.abs(q.y) > b.hh) return true
      }
    }
    return false
  }

  // --- Drawing the overlay -------------------------------------------------------------------
  let hover = -1
  let marquee: { x0: number; y0: number; x1: number; y1: number } | null = null
  const el = (tag: string, attrs: Record<string, string | number>) => {
    const e = document.createElementNS(SVG_NS, tag)
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v))
    g.appendChild(e)
    return e
  }
  const outline = (m: Placed, cls: string, G = geom()) => {
    const b = boxOf(m, G)
    const t = `rotate(${b.a} ${b.cx} ${b.cy})`
    if (ROUND.has(m.k)) el('ellipse', { cx: b.cx, cy: b.cy, rx: Math.max(1, b.hw), ry: Math.max(1, b.hh), transform: t, class: cls })
    else el('rect', { x: b.cx - b.hw, y: b.cy - b.hh, width: Math.max(1, 2 * b.hw), height: Math.max(1, 2 * b.hh), rx: Math.min(b.hw, b.hh), transform: t, class: cls })
  }
  function draw() {
    g.replaceChildren()
    const G = geom()
    if (hover >= 0 && !selected.has(hover) && list[hover]) outline(list[hover], 'compose-hover', G)
    for (const i of selected) if (list[i] && selected.size > 1) outline(list[i], 'compose-picked', G)
    const b = selectionBox()
    if (b) {
      const t = `rotate(${b.a} ${b.cx} ${b.cy})`
      el('rect', { x: b.cx - b.hw, y: b.cy - b.hh, width: 2 * b.hw, height: 2 * b.hh, transform: t, class: 'compose-box' })
      const hs = handleSize(b)
      for (const [, ux, uy] of handlesOf(b)) {
        const p = corner(b, ux, uy)
        el('rect', { x: p.x - hs / 2, y: p.y - hs / 2, width: hs, height: hs, rx: 1.5, transform: `rotate(${b.a} ${p.x} ${p.y})`, class: 'compose-handle' })
      }
      // The size, under the box, as Figma shows it.
      if (selected.size === 1) {
        const m = list[[...selected][0]]
        const bottom = Math.max(...[[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([ux, uy]) => corner(b, ux, uy).y))
        const label = el('text', { x: b.cx, y: bottom + 20, class: 'compose-size' })
        label.textContent = `${Math.round(m.w * 1000) / 10} × ${Math.round(m.h * 1000) / 10}${m.r ? ` · ${Math.round(m.r)}°` : ''}`
      }
    }
    if (marquee) {
      const x = Math.min(marquee.x0, marquee.x1), y = Math.min(marquee.y0, marquee.y1)
      el('rect', { x, y, width: Math.abs(marquee.x1 - marquee.x0), height: Math.abs(marquee.y1 - marquee.y0), class: 'compose-marquee' })
    }
  }

  // --- Pointer -----------------------------------------------------------------------------
  type Drag =
    | { kind: 'move'; x0: number; y0: number; start: Placed[]; idx: number[] }
    | { kind: 'scale'; handle: Handle; box: Box; start: Placed[]; idx: number[] }
    | { kind: 'rotate'; box: Box; a0: number; start: Placed[]; idx: number[] }
    | { kind: 'place'; i: number; x0: number; y0: number }
    | { kind: 'marquee'; keep: Set<number> }
  let drag: Drag | null = null
  const point = (e: PointerEvent) => {
    const r = stage.getBoundingClientRect()
    return { x: e.clientX - r.left, y: e.clientY - r.top }
  }
  const snapshot = () => {
    const idx = [...selected]
    return { idx, start: idx.map((i) => ({ ...list[i] })) }
  }

  svg.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return
    e.preventDefault()
    svg.setPointerCapture(e.pointerId)
    const { x, y } = point(e)
    const box = selectionBox()
    // Handles first, then rotating, then an element, then the empty stage.
    const h = box && handleAt(box, x, y)
    if (box && h) {
      begin()
      drag = { kind: 'scale', handle: h, box, ...snapshot() }
      return
    }
    if (box && rotateZone(box, x, y)) {
      begin()
      drag = { kind: 'rotate', box, a0: Math.atan2(y - box.cy, x - box.cx), ...snapshot() }
      return
    }
    const i = topAt(x, y)
    if (i >= 0) {
      if (e.shiftKey) {
        if (selected.has(i)) selected.delete(i)
        else selected.add(i)
        renderCard()
        if (!selected.has(i)) return
      } else if (!selected.has(i)) {
        selected.clear()
        selected.add(i)
        renderCard()
      }
      begin()
      // Alt-drag: drag copies, leaving the originals.
      if (e.altKey) {
        const copies = [...selected].map((k) => ({ ...list[k] }))
        selected.clear()
        for (const c of copies) selected.add(list.push(c) - 1)
      }
      drag = { kind: 'move', x0: x, y0: y, ...snapshot() }
      return
    }
    if (tool === 'select') {
      if (!e.shiftKey) selected.clear()
      drag = { kind: 'marquee', keep: new Set(selected) }
      marquee = { x0: x, y0: y, x1: x, y1: y }
      renderCard()
      return
    }
    // Place a new element here (drag to size it).
    begin()
    const { X, Y } = geom().toUnits(x, y)
    const [w, hgt] = DEFAULT_SIZE[tool]
    const m: Placed = { k: tool, s: stem, x: X, y: Y, w, h: hgt, r: 0, lv: weight }
    selected.clear()
    selected.add(list.push(m) - 1)
    drag = { kind: 'place', i: list.length - 1, x0: x, y0: y }
    write()
    renderCard()
  })

  svg.addEventListener('pointermove', (e) => {
    const { x, y } = point(e)
    if (!drag) {
      // Cursor and hover outline.
      const box = selectionBox()
      const h = box && handleAt(box, x, y)
      if (box && h) {
        // The handle's direction, turned with the box.
        const turned = HANDLES.findIndex(([n]) => n === h) + Math.round((((box.a % 360) + 360) % 360) / 45)
        svg.style.cursor = CURSORS[HANDLES[turned % 8][0]]
      } else if (box && rotateZone(box, x, y)) svg.style.cursor = ROTATE_CURSOR
      else {
        hover = topAt(x, y)
        svg.style.cursor = hover >= 0 ? 'move' : tool === 'select' ? 'default' : 'crosshair'
      }
      return
    }
    const G = geom()
    if (drag.kind === 'move') {
      const d = drag
      const dX = (x - d.x0) / G.s, dY = -(y - d.y0) / G.s
      d.idx.forEach((i, k) => {
        list[i].x = d.start[k].x + dX
        list[i].y = d.start[k].y + dY
      })
    } else if (drag.kind === 'place') {
      // Drag out the size: dots from their centre, streaks and blobs corner to corner.
      const m = list[drag.i]
      const d = Math.hypot(x - drag.x0, y - drag.y0)
      if (d > 3) {
        if (m.k === 'streak' || m.k === 'blob') {
          const a = G.toUnits(drag.x0, drag.y0), b = G.toUnits(x, y)
          m.x = (a.X + b.X) / 2
          m.y = (a.Y + b.Y) / 2
          m.w = Math.max(0.004, Math.abs(b.X - a.X))
          m.h = Math.max(0.004, Math.abs(b.Y - a.Y))
          if (e.shiftKey) m.w = m.h = Math.max(m.w, m.h)
        } else m.w = m.h = Math.max(0.004, (2 * d) / G.s)
      }
    } else if (drag.kind === 'scale') scaleTo(drag, x, y, e.shiftKey, e.altKey, G)
    else if (drag.kind === 'rotate') {
      let delta = ((Math.atan2(y - drag.box.cy, x - drag.box.cx) - drag.a0) * 180) / Math.PI
      if (e.shiftKey) {
        const base = drag.start.length === 1 ? drag.start[0].r : 0
        delta = Math.round((base + delta) / 15) * 15 - base
      }
      const c = G.toUnits(drag.box.cx, drag.box.cy)
      const start = drag.start
      drag.idx.forEach((i, k) => {
        const s0 = start[k]
        // Turn its place about the box's centre (clockwise on screen = negative in y-up units).
        const p = rotate(s0.x - c.X, -(s0.y - c.Y), delta)
        list[i].x = c.X + p.x
        list[i].y = c.Y - p.y
        list[i].r = s0.r + delta
      })
    } else if (drag.kind === 'marquee' && marquee) {
      marquee.x1 = x
      marquee.y1 = y
      const x0 = Math.min(marquee.x0, x), x1 = Math.max(marquee.x0, x), y0 = Math.min(marquee.y0, y), y1 = Math.max(marquee.y0, y)
      selected.clear()
      for (const k of drag.keep) selected.add(k)
      list.forEach((m, i) => {
        const p = G.toStage(m.x, m.y)
        if (p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1) selected.add(i)
      })
    }
    if (drag.kind !== 'marquee') write()
  })

  const end = () => {
    if (!drag) return
    const kind = drag.kind
    drag = null
    marquee = null
    if (kind === 'marquee') renderCard()
    else commit()
  }
  svg.addEventListener('pointerup', end)
  svg.addEventListener('pointercancel', end)
  svg.addEventListener('pointerleave', () => (hover = -1))
  // The trackpad still zooms and pans the view while editing.
  svg.addEventListener('wheel', (e) => {
    e.preventDefault()
    engine.canvas.dispatchEvent(new WheelEvent('wheel', e))
  }, { passive: false })

  /** Scale by a handle: one element in its own frame; several by their bounds. */
  function scaleTo(d: Extract<Drag, { kind: 'scale' }>, x: number, y: number, keepShape: boolean, fromCentre: boolean, G: ReturnType<typeof geom>) {
    const b = d.box
    const [, ux, uy] = HANDLES.find(([n]) => n === d.handle)!
    const p = local(b, x, y)
    // The opposite side stays put (or the centre, with alt).
    const ax = fromCentre ? 0 : -ux * b.hw, ay = fromCentre ? 0 : -uy * b.hh
    let nw = ux ? Math.abs(p.x - ax) / (fromCentre ? 1 : 2) : b.hw
    let nh = uy ? Math.abs(p.y - ay) / (fromCentre ? 1 : 2) : b.hh
    if (keepShape) {
      const k = Math.max(ux ? nw / Math.max(1e-6, b.hw) : 0, uy ? nh / Math.max(1e-6, b.hh) : 0)
      nw = b.hw * k
      nh = b.hh * k
    }
    nw = Math.max(1, nw)
    nh = Math.max(1, nh)
    // The new centre, in the box's frame, then on the stage.
    const lc = { x: fromCentre || !ux ? 0 : ax + Math.sign(p.x - ax || ux) * nw, y: fromCentre || !uy ? 0 : ay + Math.sign(p.y - ay || uy) * nh }
    const fx = nw / Math.max(1e-6, b.hw), fy = nh / Math.max(1e-6, b.hh)
    d.idx.forEach((i, k) => {
      const s0 = d.start[k]
      const sb = boxOf(s0, G)
      // Its place, relative to the box's centre, in the box's frame: scaled, then moved with the centre.
      const rel = local(b, sb.cx, sb.cy)
      const q = rotate(lc.x + rel.x * fx, lc.y + rel.y * fy, b.a)
      const u = G.toUnits(b.cx + q.x, b.cy + q.y)
      list[i].x = u.X
      list[i].y = u.Y
      if (d.start.length === 1) {
        list[i].w = Math.max(0.002, s0.w * fx)
        list[i].h = Math.max(0.002, s0.h * fy)
      } else {
        // Several: each keeps its own turn; upright ones stretch with the box, turned ones grow evenly.
        const upright = Math.abs(((s0.r % 90) + 90) % 90) < 1
        const even = Math.sqrt(fx * fy)
        list[i].w = Math.max(0.002, s0.w * (upright ? (Math.abs(((s0.r % 180) + 180) % 180) < 1 ? fx : fy) : even))
        list[i].h = Math.max(0.002, s0.h * (upright ? (Math.abs(((s0.r % 180) + 180) % 180) < 1 ? fy : fx) : even))
      }
    })
  }

  // --- Keys ---------------------------------------------------------------------------------
  const typing = (e: KeyboardEvent) => {
    const t = e.target as HTMLElement | null
    return !!t && (t.isContentEditable || /^(TEXTAREA|SELECT)$/.test(t.tagName) || (t.tagName === 'INPUT' && !/^(range|checkbox|button)$/.test((t as HTMLInputElement).type)))
  }
  // (Capture: Esc deselects before it closes the cards.)
  window.addEventListener('keydown', (e) => {
    if (!editing() || typing(e)) return
    const mod = e.metaKey || e.ctrlKey
    if (e.key === 'Escape' && (selected.size || tool !== 'select')) {
      if (selected.size) selected.clear()
      else tool = 'select'
      renderCard()
      e.stopImmediatePropagation()
    } else if ((e.key === 'Backspace' || e.key === 'Delete') && selected.size) {
      remove()
      e.preventDefault()
    } else if (mod && e.key.toLowerCase() === 'z') {
      step(e.shiftKey ? redo : undo, e.shiftKey ? undo : redo)
      e.preventDefault()
    } else if (mod && e.key.toLowerCase() === 'd') {
      duplicate(0.02)
      e.preventDefault()
    } else if (mod && e.key.toLowerCase() === 'a') {
      list.forEach((_, i) => selected.add(i))
      renderCard()
      e.preventDefault()
    } else if (e.key.startsWith('Arrow') && selected.size) {
      const px = (e.shiftKey ? 10 : 1) / geom().s
      begin()
      for (const i of selected) {
        if (e.key === 'ArrowLeft') list[i].x -= px
        if (e.key === 'ArrowRight') list[i].x += px
        if (e.key === 'ArrowUp') list[i].y += px
        if (e.key === 'ArrowDown') list[i].y -= px
      }
      commit()
      e.preventDefault()
    } else if (!mod && (e.key === 'v' || e.key === 'V')) {
      tool = 'select'
      renderCard()
    }
  }, true)

  // --- Each frame: editing on while the card is open in Manual -------------------------------------
  const editing = () => api.open() && inManual()
  let wasEditing = false
  let shownFor = ''
  const frame = () => {
    requestAnimationFrame(frame)
    sync()
    const on = editing()
    svg.style.display = on ? 'block' : 'none'
    svg.style.pointerEvents = on && !panning() ? 'auto' : 'none'
    const key = `${api.open()}:${inManual()}`
    if (key !== shownFor) {
      shownFor = key
      renderCard()
    }
    if (on) draw()
    else if (wasEditing) {
      selected.clear()
      g.replaceChildren()
    }
    wasEditing = on
  }
  renderCard()
  frame()
}
