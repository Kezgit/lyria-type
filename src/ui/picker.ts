import { panning } from './view'
import { emit, state } from '../app/state'
import { LAYERS, type Layer } from '../audio/analysis/listener'
import type { Engine } from '../engine/engine'
import { LAYER_INFO, colourKey, encodeAssign, parseAssign } from '../modes/orchestra/layers'

// Giving letters to instruments, on the stage itself (in every mode: the
// assignment is shared, see modes/shared/parts.ts): click a
// letter (shift / cmd-click to add or drop more), double-click for its whole
// line, or drag a box over some letters, then pick the layer they play (and
// its colour). "Default" hands them back to the layout by line.

const values = () => state.modeParams.orchestra

export function buildPicker(stage: HTMLElement, engine: Engine) {
  const box = document.createElement('div')
  box.className = 'pick-box'
  box.hidden = true
  const marks = document.createElement('div')
  marks.className = 'pick-marks'
  const menu = document.createElement('div')
  menu.className = 'pick-menu'
  menu.hidden = true
  stage.append(marks, box, menu)

  let selected: number[] = []

  /**
   * Each letter's box on the stage, in CSS px from the stage's top-left: where the canvas (the frame,
   * centred in the stage) shows it, through the view's zoom and pan, as the engine draws it.
   */
  const letterBoxes = () => {
    const { text, placements, viewport } = engine.letters
    if (!text) return []
    const sr = stage.getBoundingClientRect()
    const cr = engine.canvas.getBoundingClientRect()
    // CSS px per frame px (1 unless the canvas is scaled), and the view.
    const k = cr.width / Math.max(1, viewport.width)
    const { zoom, x: panX, y: panY } = state.view
    const z = Math.max(0.05, zoom)
    return text.glyphs.map((g) => {
      const p = placements[g.index]
      const w = g.w * p.scale * 0.36 * z * k
      const h = g.h * p.scale * 0.36 * z * k
      const x = cr.left - sr.left + (viewport.width / 2 + (p.x - panX * viewport.width) * z) * k
      const y = cr.top - sr.top + (viewport.height / 2 - (p.y - panY * viewport.height) * z) * k
      return { g, x, y, left: x - w, right: x + w, top: y - h, bottom: y + h }
    })
  }

  const close = () => {
    menu.hidden = true
    marks.replaceChildren()
    selected = []
  }

  const open = (indices: number[], at: { x: number; y: number }) => {
    if (!indices.length) return close()
    selected = indices
    // Outline the chosen letters.
    const boxes = letterBoxes()
    marks.replaceChildren(
      ...indices.map((i) => {
        const b = boxes[i]
        const m = document.createElement('span')
        Object.assign(m.style, { left: `${b.left}px`, top: `${b.top}px`, width: `${b.right - b.left}px`, height: `${b.bottom - b.top}px` })
        return m
      }),
    )
    const current = parseAssign(state.letterParts, boxes.length)
    const mine = new Set(indices.map((i) => current[i]))
    menu.innerHTML = `<header>${indices.length} letter${indices.length > 1 ? 's' : ''} play…</header>`
    for (const l of LAYERS) {
      const row = document.createElement('div')
      row.className = 'pick-row'
      const btn = document.createElement('button')
      btn.innerHTML = `<i style="background:${values()[colourKey(l)]}"></i><b>${LAYER_INFO[l].label}</b>`
      btn.classList.toggle('on', mine.size === 1 && mine.has(LAYERS.indexOf(l)))
      btn.addEventListener('click', () => assign(l))
      const colour = document.createElement('input')
      colour.type = 'color'
      colour.value = values()[colourKey(l)]
      colour.title = `${LAYER_INFO[l].label} colour`
      colour.addEventListener('input', () => {
        values()[colourKey(l)] = colour.value
        btn.querySelector('i')!.setAttribute('style', `background:${colour.value}`)
        emit('params')
      })
      row.append(btn, colour)
      menu.appendChild(row)
    }
    const reset = document.createElement('button')
    reset.className = 'pick-default'
    reset.textContent = 'Default (by line)'
    reset.addEventListener('click', () => assign(null))
    menu.appendChild(reset)
    menu.hidden = false
    const x = Math.min(at.x + 12, stage.clientWidth - menu.offsetWidth - 8)
    const y = Math.min(at.y + 12, stage.clientHeight - menu.offsetHeight - 8)
    Object.assign(menu.style, { left: `${Math.max(8, x)}px`, top: `${Math.max(8, y)}px` })
  }

  const assign = (l: Layer | null) => {
    const n = letterBoxes().length
    const a = parseAssign(state.letterParts, n)
    for (const i of selected) a[i] = l ? LAYERS.indexOf(l) : -1
    state.letterParts = encodeAssign(a)
    emit('params')
    close()
  }

  const canvas = engine.canvas
  canvas.addEventListener('pointerdown', (e) => {
    // (Option-drag pans the view instead; see view.ts.)
    if (e.button !== 0 || e.altKey || panning()) return
    // Shift / cmd adds to (or drops from) the letters already chosen.
    const adding = e.shiftKey || e.metaKey || e.ctrlKey
    const kept = adding ? selected : []
    close()
    const r = stage.getBoundingClientRect()
    const start = { x: e.clientX - r.left, y: e.clientY - r.top }
    canvas.setPointerCapture(e.pointerId)
    let dragged = false
    const move = (m: PointerEvent) => {
      const x = m.clientX - r.left
      const y = m.clientY - r.top
      if (!dragged && Math.hypot(x - start.x, y - start.y) < 5) return
      dragged = true
      box.hidden = false
      Object.assign(box.style, {
        left: `${Math.min(x, start.x)}px`, top: `${Math.min(y, start.y)}px`,
        width: `${Math.abs(x - start.x)}px`, height: `${Math.abs(y - start.y)}px`,
      })
    }
    const up = (u: PointerEvent) => {
      canvas.removeEventListener('pointermove', move)
      canvas.removeEventListener('pointerup', up)
      box.hidden = true
      const x = u.clientX - r.left
      const y = u.clientY - r.top
      const boxes = letterBoxes()
      if (dragged) {
        // Every letter the box touches.
        const [x0, x1] = [Math.min(x, start.x), Math.max(x, start.x)]
        const [y0, y1] = [Math.min(y, start.y), Math.max(y, start.y)]
        const inBox = boxes.filter((b) => b.right > x0 && b.left < x1 && b.bottom > y0 && b.top < y1).map((b) => b.g.index)
        open([...new Set([...kept, ...inBox])], { x, y })
      } else {
        // A click: the letter under (or nearest) the pointer.
        const best = nearest(boxes, x, y)
        if (!best) return open(kept, { x, y })
        const i = best.g.index
        open(adding ? (kept.includes(i) ? kept.filter((k) => k !== i) : [...kept, i]) : [i], { x, y })
      }
    }
    canvas.addEventListener('pointermove', move)
    canvas.addEventListener('pointerup', up)
  })
  // Double-click: the whole line of the letter under the pointer.
  canvas.addEventListener('dblclick', (e) => {
    if (e.altKey) return
    const r = stage.getBoundingClientRect()
    const x = e.clientX - r.left
    const y = e.clientY - r.top
    const boxes = letterBoxes()
    const best = nearest(boxes, x, y)
    if (best) open(boxes.filter((b) => b.g.line === best.g.line).map((b) => b.g.index), { x, y })
  })
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') close()
  })
  window.addEventListener('pointerdown', (e) => {
    if (!menu.hidden && !menu.contains(e.target as Node) && e.target !== canvas) close()
  })
}

/** The letter under (or within 40px of) a point. */
function nearest<B extends { x: number; y: number; left: number; right: number; top: number; bottom: number }>(boxes: B[], x: number, y: number): B | null {
  let best: B | null = null
  let bestD = 40
  let bestCentre = Infinity
  for (const b of boxes) {
    const d = Math.hypot(Math.max(b.left - x, 0, x - b.right), Math.max(b.top - y, 0, y - b.bottom))
    // Neighbouring boxes overlap (a narrow letter beside a wide one): inside several, the closest centre wins.
    const centre = Math.hypot(b.x - x, b.y - y)
    if (d < bestD || (d === bestD && centre < bestCentre)) {
      best = b
      bestD = d
      bestCentre = centre
    }
  }
  return best
}
