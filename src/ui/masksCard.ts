import { Pane } from 'tweakpane'
import { state } from '../app/state'
import type { Engine } from '../engine/engine'
import { ANIMATED, SHAPES, decodeMasks, encodeMasks, encodeTimeline, liveMask, maskAt, newMask, setAt, timeline, type Animated, type Mask, type MaskShape } from '../modes/sequencer/masks'
import { buildMaskTimeline } from './maskTimeline'

// The Masks card: invisible shapes that push the Sequencer's marks aside
// (modes/sequencer/masks.ts), in any of its styles. "Mask layers" lists them
// (add a circle, square or rounded shape; show / hide, rename, delete); the
// picked layer's settings sit under the list. While the card is open, each
// mask shows on the stage as a dashed outline (its margin and reach fainter
// round it), to drag about; the picked one gets a box to scale and stretch by
// its handles (shift keeps the shape, alt from the centre) and turn from just
// outside a corner (shift: 15° steps). Clicks anywhere else go through to the
// stage as usual (Outlines: off hides the dashed shapes, leaving the picked
// one's box). ⌘Z / ⇧⌘Z undo and redo mask changes while the card is open.
// Timeline opens the masks' keyframe timeline (ui/maskTimeline.ts): once a
// mask has keys, every change to its place, size, turn, push or rings is
// made at the playhead, as a key there.

const KEY = 'masks'
const SVG_NS = 'http://www.w3.org/2000/svg'
const SHAPE_ICONS: Record<MaskShape, string> = {
  circle: '<circle cx="12" cy="12" r="7.5"/>',
  square: '<rect x="4.5" y="4.5" width="15" height="15"/>',
  rounded: '<rect x="4.5" y="4.5" width="15" height="15" rx="5"/>',
}
const EYE = '<path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6z"/><circle cx="12" cy="12" r="2.6"/>'
const EYE_OFF = '<path d="M4 4l16 16M9.9 6.3A9.7 9.7 0 0112 6c6 0 9.5 6 9.5 6a16 16 0 01-3 3.6M6.3 7.9C3.9 9.6 2.5 12 2.5 12s3.5 6 9.5 6c1.5 0 2.8-.4 4-.9"/>'
const ROTATE_CURSOR = `url("data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><path d="M6 15a7 7 0 0111.6-7.4M18 4v4.5h-4.5" fill="none" stroke="white" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"/><path d="M6 15a7 7 0 0111.6-7.4M18 4v4.5h-4.5" fill="none" stroke="black" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>')}") 12 12, crosshair`
type Handle = [number, number]
const HANDLES: Handle[] = [[-1, -1], [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0]]

export function buildMasksCard(page: HTMLElement, engine: Engine, isOpen: () => boolean) {
  const stage = engine.canvas.parentElement!
  const values = () => state.modeParams.sequencer
  const inSequencer = () => state.modeId === 'sequencer'

  // --- The masks: a working copy of the setting -----------------------------------------------
  let list: Mask[] = []
  let written = ''
  let picked = ''
  const sync = () => {
    const text = (values()[KEY] as string) ?? ''
    if (text === written) return false
    written = text
    list = decodeMasks(text).map((m) => structuredClone(m))
    if (!list.some((m) => m.id === picked)) picked = list[0]?.id ?? ''
    return true
  }
  const write = () => {
    written = encodeMasks(list)
    values()[KEY] = written
  }
  const undo: string[] = []
  const redo: string[] = []
  let before: string | null = null
  // One edit (a drag, a slider move) lands at one time: the playhead's when it began, to the frame. Keyed
  // masks pause the timeline while they're edited, so a drag doesn't leave a key at every step.
  let editT: number | null = null
  const begin = () => {
    if (before === null && timeline.playing && list.some((m) => m.keys.length)) {
      timeline.playing = false
      values().maskTimeline = encodeTimeline()
    }
    editT ??= Math.round(timeline.t * 30) / 30
    before ??= encodeMasks(list)
  }
  const commit = () => {
    if (before !== null && before !== encodeMasks(list)) {
      undo.push(before)
      if (undo.length > 200) undo.shift()
      redo.length = 0
    }
    before = null
    editT = null
    write()
  }
  const step = (from: string[], to: string[]) => {
    const text = from.pop()
    if (text === undefined) return
    to.push(encodeMasks(list))
    list = decodeMasks(text).map((m) => structuredClone(m))
    if (!list.some((m) => m.id === picked)) picked = list[0]?.id ?? ''
    write()
    renderList()
    renderSettings()
  }
  const current = () => list.find((m) => m.id === picked)
  /** A mask as it is at the playhead. */
  const now = (m: Mask) => maskAt(m, timeline.t)
  /** Change a mask: animated values at the playhead (a key, once it has keys), the rest on the mask. */
  const change = (m: Mask, values: Partial<Mask>) => {
    const keyed: Partial<Record<Animated, number>> = {}
    for (const [k, v] of Object.entries(values)) {
      if ((ANIMATED as readonly string[]).includes(k)) keyed[k as Animated] = v as number
      else (m as any)[k] = v
    }
    setAt(m, editT ?? Math.round(timeline.t * 30) / 30, keyed)
  }

  // --- The card ---------------------------------------------------------------------------------
  const away = document.createElement('p')
  away.className = 'hint'
  away.textContent = 'Masks push the Sequencer’s dots and marks aside, in any of its styles. Switch the mode to Sequencer to use them.'
  const body = document.createElement('div')
  body.className = 'masks-body'
  page.append(away, body)

  const intro = document.createElement('p')
  intro.className = 'hint'
  intro.textContent = 'Invisible shapes the marks flow around. Drag one on the stage to move it; handles scale and stretch it.'
  const head = document.createElement('div')
  head.className = 'masks-head'
  head.innerHTML = '<h5>Mask layers</h5>'
  // Outlines on the stage, and the timeline.
  const OUTLINES_KEY = 'lyria-type:mask-outlines'
  let showOutlines = true
  try {
    showOutlines = localStorage.getItem(OUTLINES_KEY) !== 'off'
  } catch {}
  const headButtons = document.createElement('span')
  headButtons.className = 'masks-head-buttons'
  const outlinesBtn = document.createElement('button')
  outlinesBtn.title = 'Show or hide the masks’ outlines on the stage'
  const showOutlinesBtn = () => {
    outlinesBtn.textContent = showOutlines ? 'Outlines: on' : 'Outlines: off'
    outlinesBtn.classList.toggle('on', showOutlines)
  }
  outlinesBtn.addEventListener('click', () => {
    showOutlines = !showOutlines
    showOutlinesBtn()
    try {
      localStorage.setItem(OUTLINES_KEY, showOutlines ? 'on' : 'off')
    } catch {}
  })
  showOutlinesBtn()
  const timelineBtn = document.createElement('button')
  timelineBtn.textContent = '◆ Timeline'
  timelineBtn.title = 'Keyframe the masks over time'
  headButtons.append(outlinesBtn, timelineBtn)
  head.appendChild(headButtons)
  const adds = document.createElement('div')
  adds.className = 'masks-add'
  for (const s of SHAPES) {
    const b = document.createElement('button')
    b.title = `Add a ${s.label.toLowerCase()} mask`
    b.innerHTML = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6">${SHAPE_ICONS[s.id]}</svg><span>＋ ${s.label}</span>`
    b.addEventListener('click', () => {
      begin()
      const m = newMask(s.id, list.length + 1)
      // The first in the middle; later ones a little off, so they don't stack exactly.
      m.x = list.length ? (((list.length - 1) % 4) - 1.5) * 0.12 : 0
      list.push(m)
      picked = m.id
      commit()
      renderList()
      renderSettings()
    })
    adds.appendChild(b)
  }
  const layers = document.createElement('div')
  layers.className = 'masks-layers'
  const tools = document.createElement('div')
  tools.className = 'compose-actions'
  const tool = (label: string, title: string, run: () => void) => {
    const b = document.createElement('button')
    b.textContent = label
    b.title = title
    b.addEventListener('click', run)
    tools.appendChild(b)
    return b
  }
  const undoBtn = tool('↶ Undo', 'Undo (⌘Z)', () => step(undo, redo))
  const redoBtn = tool('↷ Redo', 'Redo (⇧⌘Z)', () => step(redo, undo))
  const dupBtn = tool('Duplicate', 'Duplicate the picked mask', () => {
    const m = current()
    if (!m) return
    begin()
    const copy = { ...structuredClone(m), id: Math.random().toString(36).slice(2, 9), name: `${m.name} copy` }
    change(copy, { x: now(m).x + 0.05, y: now(m).y - 0.05 })
    list.push(copy)
    picked = copy.id
    commit()
    renderList()
    renderSettings()
  })
  const settingsHost = document.createElement('div')
  settingsHost.className = 'masks-settings'
  body.append(intro, head, adds, layers, tools, settingsHost)

  function renderList() {
    layers.replaceChildren()
    if (!list.length) {
      const empty = document.createElement('p')
      empty.className = 'hint'
      empty.textContent = 'No masks yet. Add a shape above.'
      layers.appendChild(empty)
    }
    // Top of the list = last added (drawn last, pushes last).
    for (const m of [...list].reverse()) {
      const row = document.createElement('div')
      row.className = 'masks-row'
      row.classList.toggle('on', m.id === picked)
      row.classList.toggle('hidden', !m.on)
      const eye = document.createElement('button')
      eye.className = 'masks-eye'
      eye.title = m.on ? 'Turn off' : 'Turn on'
      eye.innerHTML = `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round">${m.on ? EYE : EYE_OFF}</svg>`
      eye.addEventListener('click', (e) => {
        e.stopPropagation()
        begin()
        m.on = !m.on
        commit()
        renderList()
      })
      const name = document.createElement('span')
      name.className = 'masks-name'
      name.innerHTML = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6">${SHAPE_ICONS[m.shape]}</svg>`
      name.append(m.name)
      name.title = 'Double-click to rename'
      name.addEventListener('dblclick', () => {
        const n = prompt('Name this mask:', m.name)?.trim()
        if (!n) return
        begin()
        m.name = n
        commit()
        renderList()
      })
      const del = document.createElement('button')
      del.className = 'masks-del'
      del.title = 'Delete this mask'
      del.textContent = '×'
      del.addEventListener('click', (e) => {
        e.stopPropagation()
        begin()
        list = list.filter((x) => x !== m)
        if (picked === m.id) picked = list[list.length - 1]?.id ?? ''
        commit()
        renderList()
        renderSettings()
      })
      row.append(eye, name, del)
      row.addEventListener('click', () => {
        picked = m.id
        renderList()
        renderSettings()
      })
      layers.appendChild(row)
    }
    undoBtn.disabled = !undo.length
    redoBtn.disabled = !redo.length
    dupBtn.disabled = !current()
  }

  // The picked mask's settings: a Tweakpane on a copy (as it is at the playhead), written back as it changes.
  let pane: Pane | null = null
  let editing: Mask | null = null
  function renderSettings() {
    pane?.dispose()
    pane = null
    const m = current()
    editing = m ? { ...now(m) } : null
    if (!m || !editing) return
    pane = new Pane({ container: settingsHost })
    const e = editing
    const apply = (key: keyof Mask, last: boolean) => {
      const target = current()
      if (!target) return
      begin()
      const was = now(target)
      // Locked: width and height scale together.
      if (e.lock && (key === 'w' || key === 'h')) {
        const k = key === 'w' ? e.w / Math.max(1e-6, was.w) : e.h / Math.max(1e-6, was.h)
        if (key === 'w') e.h = was.h * k
        else e.w = was.w * k
        refreshing = true
        try {
          pane?.refresh()
        } finally {
          refreshing = false
        }
      }
      change(target, { [key]: e[key], ...(key === 'w' || key === 'h' ? { w: e.w, h: e.h } : {}) })
      if (last) commit()
      else write()
      renderList()
    }
    const add = (folder: any, key: keyof Mask, opts: Record<string, unknown>) =>
      folder.addBinding(e, key, opts).on('change', (ev: { last: boolean }) => {
        // (A refresh showing the mask as it moves isn't an edit.)
        if (refreshing) return
        apply(key, ev.last)
        if (key === 'shape' || key === 'stroke' || key === 'repeat') renderSettings()
      })
    const shape = pane.addFolder({ title: m.name })
    add(shape, 'shape', { label: 'shape', options: Object.fromEntries(SHAPES.map((s) => [s.label, s.id])) })
    if (e.shape === 'rounded') add(shape, 'round', { label: 'roundness', min: 0, max: 1, step: 0.01 })
    add(shape, 'lock', { label: 'keep proportions' })
    add(shape, 'w', { label: 'width', min: 0.01, max: 3, step: 0.001 })
    add(shape, 'h', { label: 'height', min: 0.01, max: 3, step: 0.001 })
    add(shape, 'r', { label: 'rotation (°)', min: -180, max: 180, step: 0.5 })
    add(shape, 'invert', { label: 'invert (show inside)' })
    const push = pane.addFolder({ title: 'Push' })
    add(push, 'strength', { label: 'strength', min: 0, max: 1, step: 0.01 })
    add(push, 'margin', { label: 'margin', min: 0, max: 0.5, step: 0.001 })
    add(push, 'soft', { label: 'soft edge (blur)', min: 0, max: 0.6, step: 0.001 })
    add(push, 'squash', { label: 'squash', min: 0, max: 1, step: 0.01 })
    const rings = pane.addFolder({ title: 'Rings', expanded: e.stroke > 0 || e.repeat > 1 })
    add(rings, 'stroke', { label: 'stroke (0 = filled)', min: 0, max: 0.4, step: 0.001 })
    add(rings, 'repeat', { label: 'repeater copies', min: 1, max: 12, step: 1 })
    if (e.repeat > 1) add(rings, 'spacing', { label: 'spacing (− = inward)', min: -0.5, max: 0.5, step: 0.001 })
    const life = pane.addFolder({ title: 'Life' })
    add(life, 'follow', { label: 'jelly (follows loosely)', min: 0, max: 1, step: 0.01 })
    add(life, 'wobble', { label: 'edge wobble', min: 0, max: 1, step: 0.01 })
    add(life, 'pulse', { label: 'swells with music', min: 0, max: 1, step: 0.01 })
    add(life, 'stem', { label: 'with', options: { 'all of it': 'all', vocals: 'vocals', instruments: 'instruments', drums: 'drums', bass: 'bass' } })
  }
  // Moved on the stage, or the playhead moved: the settings show it (without that counting as a change).
  let refreshing = false
  const refreshSettings = () => {
    const m = current()
    if (!m || !editing || !pane) return
    Object.assign(editing, now(m))
    refreshing = true
    try {
      pane.refresh()
    } finally {
      refreshing = false
    }
  }

  // --- The stage: outlines to drag, a box on the picked one ------------------------------------------
  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.classList.add('masks-overlay')
  stage.appendChild(svg)
  const g = document.createElementNS(SVG_NS, 'g')
  svg.appendChild(g)
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
      s: H * z * k,
      toStage: (X: number, Y: number) => ({ x: ox + (W / 2 + (X * H - panX * W) * z) * k, y: oy + (H / 2 - (Y * H - panY * H) * z) * k }),
      toUnits: (x: number, y: number) => ({ X: (((x - ox) / k - W / 2) / z + panX * W) / H, Y: ((H / 2 - (y - oy) / k) / z + panY * H) / H }),
    }
  }
  const rot = (x: number, y: number, deg: number) => {
    const t = (deg * Math.PI) / 180, c = Math.cos(t), s = Math.sin(t)
    return { x: x * c - y * s, y: x * s + y * c }
  }
  const el = (tag: string, attrs: Record<string, string | number>, parent: Element = g) => {
    const e = document.createElementNS(SVG_NS, tag)
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v))
    parent.appendChild(e)
    return e
  }
  /** A mask's outline (grown by `grow` px) as an SVG shape. */
  const outline = (m: Mask, b: { cx: number; cy: number; hw: number; hh: number; a: number }, grow: number, attrs: Record<string, string | number>) => {
    const t = `rotate(${b.a} ${b.cx} ${b.cy})`
    const hw = Math.max(1, b.hw + grow), hh = Math.max(1, b.hh + grow)
    if (m.shape === 'circle') return el('ellipse', { cx: b.cx, cy: b.cy, rx: Math.max(1, hw), ry: Math.max(1, hh), transform: t, ...attrs })
    const rr = m.shape === 'rounded' ? Math.min(b.hw, b.hh) * m.round + grow : grow
    return el('rect', { x: b.cx - hw, y: b.cy - hh, width: Math.max(1, 2 * hw), height: Math.max(1, 2 * hh), rx: Math.max(0, rr), transform: t, ...attrs })
  }
  const boxOf = (m: Mask, G = geom(), sprung = false) => {
    const v = sprung ? liveMask(m) : now(m)
    const c = G.toStage(v.x, v.y)
    return { cx: c.x, cy: c.y, hw: (v.w / 2) * G.s, hh: (v.h / 2) * G.s, a: v.r }
  }
  const corner = (b: ReturnType<typeof boxOf>, ux: number, uy: number) => {
    const p = rot(ux * b.hw, uy * b.hh, b.a)
    return { x: b.cx + p.x, y: b.cy + p.y }
  }

  function draw() {
    g.replaceChildren()
    const G = geom()
    for (const base of list) {
      if (!base.on) continue
      const m = now(base)
      const b = boxOf(base, G)
      const live = boxOf(base, G, true)
      const pickedOne = m.id === picked
      // Its outline (each ring: both edges of the stroke, every repeat), dashed, as it's moving now; its
      // margin and reach fainter. Hidden with Outlines off, leaving the picked one's box.
      if (showOutlines) {
        const copies = Math.max(1, Math.round(m.repeat))
        for (let i = 0; i < copies; i++) {
          const at = i * m.spacing * G.s
          const edges = m.stroke > 0 ? [at - (m.stroke / 2) * G.s, at + (m.stroke / 2) * G.s] : [at]
          const outer = Math.max(...edges)
          if (i === 0 || i === copies - 1) outline(m, live, outer + (m.margin + m.soft) * G.s, { class: 'masks-reach' })
          for (const e of edges) outline(m, live, e, { class: pickedOne ? 'masks-shape picked' : 'masks-shape' })
        }
        if (m.margin > 0) outline(m, live, m.margin * G.s, { class: 'masks-margin' })
      }
      const grab = outline(m, b, 0, { class: 'masks-grab' })
      grab.addEventListener('pointerdown', (e) => start(e as PointerEvent, base, 'move'))
      if (!pickedOne) continue
      el('rect', { x: b.cx - b.hw, y: b.cy - b.hh, width: 2 * b.hw, height: 2 * b.hh, transform: `rotate(${b.a} ${b.cx} ${b.cy})`, class: 'masks-box' })
      // Rotate zones just outside the corners, then the handles over them.
      for (const [ux, uy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
        const p = corner(b, ux * 1, uy * 1)
        const off = rot(ux * 12, uy * 12, b.a)
        const zone = el('circle', { cx: p.x + off.x, cy: p.y + off.y, r: 12, class: 'masks-rotate' })
        ;(zone as SVGElement).style.cursor = ROTATE_CURSOR
        zone.addEventListener('pointerdown', (e) => start(e as PointerEvent, base, 'rotate'))
      }
      for (const [ux, uy] of HANDLES) {
        if ((!ux && b.hw < 20) || (!uy && b.hh < 20)) continue
        const p = corner(b, ux, uy)
        const h = el('rect', { x: p.x - 4, y: p.y - 4, width: 8, height: 8, rx: 1.5, transform: `rotate(${b.a} ${p.x} ${p.y})`, class: 'masks-handle' })
        const dir = Math.round(((Math.atan2(uy, ux) * 180) / Math.PI + b.a + 360) / 45) % 4
        ;(h as SVGElement).style.cursor = ['ew-resize', 'nwse-resize', 'ns-resize', 'nesw-resize'][dir]
        h.addEventListener('pointerdown', (e) => start(e as PointerEvent, base, [ux, uy]))
      }
    }
  }

  // --- Dragging ------------------------------------------------------------------------------------
  let drag: { m: Mask; what: 'move' | 'rotate' | Handle; x0: number; y0: number; m0: Mask; b0: ReturnType<typeof boxOf> } | null = null
  const point = (e: PointerEvent) => {
    const r = stage.getBoundingClientRect()
    return { x: e.clientX - r.left, y: e.clientY - r.top }
  }
  function start(e: PointerEvent, m: Mask, what: 'move' | 'rotate' | Handle) {
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    const { x, y } = point(e)
    if (picked !== m.id) {
      picked = m.id
      renderList()
      renderSettings()
    }
    begin()
    drag = { m, what, x0: x, y0: y, m0: { ...now(m) }, b0: boxOf(m) }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', end, { once: true })
  }
  function move(e: PointerEvent) {
    if (!drag) return
    const { x, y } = point(e)
    const G = geom()
    const { m, m0, b0 } = drag
    if (drag.what === 'move') {
      change(m, { x: m0.x + (x - drag.x0) / G.s, y: m0.y - (y - drag.y0) / G.s })
    } else if (drag.what === 'rotate') {
      let d = ((Math.atan2(y - b0.cy, x - b0.cx) - Math.atan2(drag.y0 - b0.cy, drag.x0 - b0.cx)) * 180) / Math.PI
      if (e.shiftKey) d = Math.round((m0.r + d) / 15) * 15 - m0.r
      change(m, { r: ((((m0.r + d) % 360) + 540) % 360) - 180 })
    } else {
      const [ux, uy] = drag.what
      const p = rot(x - b0.cx, y - b0.cy, -b0.a)
      const fromCentre = e.altKey
      const ax = fromCentre ? 0 : -ux * b0.hw, ay = fromCentre ? 0 : -uy * b0.hh
      let hw = ux ? Math.abs(p.x - ax) / (fromCentre ? 1 : 2) : b0.hw
      let hh = uy ? Math.abs(p.y - ay) / (fromCentre ? 1 : 2) : b0.hh
      // Shift keeps the proportions; so do the corners of a mask set to keep them.
      if (e.shiftKey || (m.lock && ux && uy)) {
        const k = Math.max(ux ? hw / b0.hw : 0, uy ? hh / b0.hh : 0)
        hw = b0.hw * k
        hh = b0.hh * k
      }
      hw = Math.max(3, hw)
      hh = Math.max(3, hh)
      const lc = { x: fromCentre || !ux ? 0 : ax + Math.sign(p.x - ax || ux) * hw, y: fromCentre || !uy ? 0 : ay + Math.sign(p.y - ay || uy) * hh }
      const c = rot(lc.x, lc.y, b0.a)
      const u = G.toUnits(b0.cx + c.x, b0.cy + c.y)
      change(m, { x: u.X, y: u.Y, w: (2 * hw) / G.s, h: (2 * hh) / G.s })
    }
    write()
    refreshSettings()
  }
  function end() {
    window.removeEventListener('pointermove', move)
    drag = null
    commit()
    renderList()
  }
  // The trackpad still zooms and pans over a mask.
  svg.addEventListener('wheel', (e) => {
    e.preventDefault()
    engine.canvas.dispatchEvent(new WheelEvent('wheel', e))
  }, { passive: false })

  window.addEventListener('keydown', (e) => {
    if (!isOpen() || !inSequencer() || !(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== 'z') return
    if (/^(INPUT|TEXTAREA|SELECT)$/.test((e.target as HTMLElement)?.tagName ?? '')) return
    // (Compose has its own undo while it's open; the most recently opened card wins here only when Compose isn't editing.)
    if (document.querySelector('.card-compose.open') && state.modeParams.sequencer.style === 'manual') return
    step(e.shiftKey ? redo : undo, e.shiftKey ? undo : redo)
    e.preventDefault()
  })

  // --- The timeline ----------------------------------------------------------------------------------------
  const tl = buildMaskTimeline(stage, {
    list: () => list,
    picked: () => picked,
    pick: (id) => {
      picked = id
      renderList()
      renderSettings()
    },
    begin,
    commit,
    save: (text) => (values().maskTimeline = text),
    changed: () => refreshSettings(),
  })
  timelineBtn.addEventListener('click', () => {
    tl.toggle()
    timelineBtn.classList.toggle('on', tl.open)
  })

  // --- Each frame -------------------------------------------------------------------------------------
  let shown = ''
  const frame = () => {
    requestAnimationFrame(frame)
    const changed = sync()
    const on = isOpen() && inSequencer()
    const key = `${isOpen()}:${inSequencer()}`
    if (key !== shown || (changed && !drag)) {
      shown = key
      away.hidden = inSequencer()
      body.hidden = !inSequencer()
      renderList()
      renderSettings()
    }
    svg.style.display = on ? 'block' : 'none'
    tl.show(on)
    if (on) draw()
    // Playing keys: the settings follow the picked mask (a few times a second).
    if (on && timeline.playing && current()?.keys.length && ++ticks % 6 === 0) refreshSettings()
  }
  let ticks = 0
  frame()
}
