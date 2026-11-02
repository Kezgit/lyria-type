import { encodeTimeline, maskAt, timeline, valuesOf, type Ease, type Mask } from '../modes/sequencer/masks'

// The masks' timeline: a small keyframe editor along the bottom of the stage,
// a row per mask (as After Effects lays out layers). Keys sit on their row as
// diamonds; the playhead runs across while it plays (looping over its
// length) and can be dragged to scrub.
//   ◆ Key      a key on the picked mask at the playhead, as it is now; once a
//              mask has keys, every change to it (on the stage or in the card)
//              lands as a key at the playhead
//   a key      click to go to it (and pick it); drag to retime, by frames
//              (shift: 0.1 s steps); its ease sets how it moves on to the next: ease (in and
//              out), linear, or hold; ⌫ deletes it
// Keys animate a mask's place, size, turn, push and rings (masks.ts ANIMATED).

export interface TimelineHost {
  list(): Mask[]
  picked(): string
  pick(id: string): void
  /** Wrap a change (for undo): begin before, commit after. */
  begin(): void
  commit(): void
  /** The timeline's settings (length, play) as saved. */
  save(text: string): void
  /** After the playhead or a key moved: the card shows the masks as they are there. */
  changed(): void
}

const EASES: { id: Ease; label: string }[] = [
  { id: 'ease', label: 'Ease in & out' },
  { id: 'linear', label: 'Linear' },
  { id: 'hold', label: 'Hold' },
]

export function buildMaskTimeline(stage: HTMLElement, host: TimelineHost) {
  const root = document.createElement('div')
  root.className = 'mask-timeline'
  root.hidden = true
  stage.appendChild(root)

  // --- The bar along the top -------------------------------------------------------------------------
  const bar = document.createElement('div')
  bar.className = 'mtl-bar'
  const play = document.createElement('button')
  play.className = 'mtl-play'
  const clock = document.createElement('span')
  clock.className = 'mtl-clock'
  const lengthLabel = document.createElement('label')
  lengthLabel.className = 'mtl-length'
  lengthLabel.innerHTML = '<span>length</span><input type="number" min="0.5" max="120" step="0.5"><span>s</span>'
  const lengthInput = lengthLabel.querySelector('input')!
  const addKey = document.createElement('button')
  addKey.className = 'mtl-key'
  addKey.textContent = '◆ Key'
  addKey.title = 'Add a key to the picked mask at the playhead'
  const easeSelect = document.createElement('select')
  easeSelect.title = 'How the picked key moves on to the next'
  for (const e of EASES) easeSelect.appendChild(Object.assign(document.createElement('option'), { value: e.id, textContent: e.label }))
  const delKey = document.createElement('button')
  delKey.textContent = 'Delete key'
  const clearKeys = document.createElement('button')
  clearKeys.textContent = 'Clear keys'
  clearKeys.title = 'Remove every key on the picked mask (it stays as it is at the playhead)'
  const close = document.createElement('button')
  close.className = 'mtl-close'
  close.textContent = '×'
  close.title = 'Close the timeline'
  bar.append(play, clock, lengthLabel, addKey, easeSelect, delKey, clearKeys, close)

  const body = document.createElement('div')
  body.className = 'mtl-body'
  const ruler = document.createElement('div')
  ruler.className = 'mtl-ruler'
  const rows = document.createElement('div')
  rows.className = 'mtl-rows'
  const head = document.createElement('div')
  head.className = 'mtl-playhead'
  body.append(ruler, rows, head)
  root.append(bar, body)

  let open = false
  /** The key picked on the timeline: its mask and its time. */
  let sel: { id: string; t: number } | null = null
  const save = () => host.save(encodeTimeline())
  const selKey = () => {
    if (!sel) return null
    const m = host.list().find((x) => x.id === sel!.id)
    return m?.keys.find((k) => Math.abs(k.t - sel!.t) < 1e-6) ?? null
  }

  play.addEventListener('click', () => {
    timeline.playing = !timeline.playing
    save()
  })
  lengthInput.addEventListener('change', () => {
    timeline.dur = Math.min(120, Math.max(0.5, Number(lengthInput.value) || 4))
    timeline.t = Math.min(timeline.t, timeline.dur)
    save()
    render(true)
  })
  addKey.addEventListener('click', () => {
    const m = host.list().find((x) => x.id === host.picked())
    if (!m) return
    // (On the frame grid, as edits are: 30 a second.)
    const t = Math.round(timeline.t * 30) / 30
    const at = m.keys.find((k) => Math.abs(k.t - t) < 1 / 60)
    // A key holds the mask as it is at the playhead (already one there: just pick it).
    if (!at) {
      host.begin()
      m.keys.push({ t, ease: 'ease', v: valuesOf(maskAt(m, t)) })
      m.keys.sort((a, b) => a.t - b.t)
    }
    sel = { id: m.id, t: at ? at.t : t }
    host.commit()
    render(true)
  })
  easeSelect.addEventListener('change', () => {
    const k = selKey()
    if (!k) return
    host.begin()
    k.ease = easeSelect.value as Ease
    host.commit()
    render(true)
  })
  const removeKey = () => {
    const m = sel && host.list().find((x) => x.id === sel!.id)
    if (!m || !sel) return
    host.begin()
    // The mask keeps the values it had there, as its own.
    const k = selKey()
    if (k && m.keys.length === 1) Object.assign(m, k.v)
    m.keys = m.keys.filter((x) => x !== k)
    sel = null
    host.commit()
    host.changed()
    render(true)
  }
  delKey.addEventListener('click', removeKey)
  clearKeys.addEventListener('click', () => {
    const m = host.list().find((x) => x.id === host.picked())
    if (!m?.keys.length || !confirm(`Remove all ${m.keys.length} keys on “${m.name}”? It stays as it is at the playhead.`)) return
    host.begin()
    Object.assign(m, maskAt(m, timeline.t))
    m.keys = []
    sel = null
    host.commit()
    host.changed()
    render(true)
  })
  close.addEventListener('click', () => toggle(false))
  window.addEventListener('keydown', (e) => {
    if (!open || !sel || (e.key !== 'Backspace' && e.key !== 'Delete')) return
    if (/^(INPUT|TEXTAREA|SELECT)$/.test((e.target as HTMLElement)?.tagName ?? '')) return
    removeKey()
    e.preventDefault()
    e.stopImmediatePropagation()
  }, true)

  // --- Time <-> px across the tracks --------------------------------------------------------------------
  const NAME_W = 120
  const trackRect = () => {
    const r = ruler.getBoundingClientRect()
    return { left: r.left + NAME_W, width: Math.max(1, r.width - NAME_W - 10) }
  }
  const timeAt = (clientX: number) => {
    const r = trackRect()
    return Math.min(timeline.dur, Math.max(0, ((clientX - r.left) / r.width) * timeline.dur))
  }
  const xOf = (t: number) => NAME_W + (t / timeline.dur) * (ruler.clientWidth - NAME_W - 10)

  // Scrub: drag along the ruler (it pauses while held).
  ruler.addEventListener('pointerdown', (e) => {
    e.preventDefault()
    ruler.setPointerCapture(e.pointerId)
    const was = timeline.playing
    timeline.playing = false
    const go = (ev: PointerEvent) => {
      timeline.t = timeAt(ev.clientX)
      host.changed()
    }
    go(e)
    const up = () => {
      ruler.removeEventListener('pointermove', go)
      timeline.playing = was
    }
    ruler.addEventListener('pointermove', go)
    ruler.addEventListener('pointerup', up, { once: true })
  })

  // --- Rows and keys (redrawn when they change) ---------------------------------------------------------
  let drawn = ''
  function render(force = false) {
    const list = host.list()
    const sig = JSON.stringify([list.map((m) => [m.id, m.name, m.on, m.keys.map((k) => [k.t, k.ease])]), host.picked(), sel, timeline.dur, ruler.clientWidth])
    if (!force && sig === drawn) return
    drawn = sig
    lengthInput.value = String(timeline.dur)
    // Ruler: a tick every half second, labelled each second (every few, when long).
    ruler.replaceChildren()
    const every = timeline.dur > 30 ? 5 : timeline.dur > 12 ? 2 : 1
    for (let t = 0; t <= timeline.dur + 1e-6; t += 0.5) {
      const tick = document.createElement('i')
      tick.style.left = `${xOf(t)}px`
      const whole = Math.abs(t - Math.round(t)) < 1e-6
      if (whole) tick.className = 'major'
      ruler.appendChild(tick)
      if (whole && Math.round(t) % every === 0) {
        const label = document.createElement('span')
        label.textContent = `${Math.round(t)}s`
        label.style.left = `${xOf(t)}px`
        ruler.appendChild(label)
      }
    }
    rows.replaceChildren()
    if (!list.length) {
      const empty = document.createElement('p')
      empty.className = 'hint'
      empty.textContent = 'Add a mask in the Masks card, then ◆ Key to start animating it.'
      rows.appendChild(empty)
    }
    for (const m of [...list].reverse()) {
      const row = document.createElement('div')
      row.className = 'mtl-row'
      row.classList.toggle('on', m.id === host.picked())
      const name = document.createElement('span')
      name.className = 'mtl-name'
      name.textContent = m.name
      name.addEventListener('click', () => host.pick(m.id))
      const track = document.createElement('div')
      track.className = 'mtl-track'
      // A line between keys, as AE shows a keyframed property.
      if (m.keys.length > 1) {
        const span = document.createElement('b')
        span.style.left = `${xOf(m.keys[0].t) - NAME_W}px`
        span.style.width = `${xOf(m.keys[m.keys.length - 1].t) - xOf(m.keys[0].t)}px`
        track.appendChild(span)
      }
      for (const k of m.keys) {
        const d = document.createElement('button')
        d.className = `mtl-diamond ${k.ease}`
        d.classList.toggle('on', !!sel && sel.id === m.id && Math.abs(sel.t - k.t) < 1e-6)
        d.style.left = `${xOf(k.t) - NAME_W}px`
        d.title = `${k.t.toFixed(2)} s · ${EASES.find((e) => e.id === k.ease)!.label}`
        d.addEventListener('pointerdown', (e) => {
          e.preventDefault()
          e.stopPropagation()
          host.pick(m.id)
          sel = { id: m.id, t: k.t }
          timeline.t = k.t
          host.changed()
          d.setPointerCapture(e.pointerId)
          host.begin()
          const move = (ev: PointerEvent) => {
            let t = timeAt(ev.clientX)
            t = ev.shiftKey ? Math.round(t * 10) / 10 : Math.round(t * 30) / 30
            // Not onto another key.
            if (m.keys.some((o) => o !== k && Math.abs(o.t - t) < 0.01)) return
            k.t = t
            sel = { id: m.id, t: k.t }
            timeline.t = k.t
            m.keys.sort((a, b) => a.t - b.t)
            render(true)
            host.changed()
          }
          const up = () => {
            d.removeEventListener('pointermove', move)
            host.commit()
            render(true)
          }
          d.addEventListener('pointermove', move)
          d.addEventListener('pointerup', up, { once: true })
        })
        track.appendChild(d)
      }
      row.append(name, track)
      rows.appendChild(row)
    }
  }

  // --- Each frame: the clock, the playhead, the buttons ---------------------------------------------------
  const frame = () => {
    requestAnimationFrame(frame)
    if (!open) return
    render()
    play.textContent = timeline.playing ? '❚❚' : '▶'
    play.title = timeline.playing ? 'Pause the timeline' : 'Play the timeline (it loops)'
    clock.textContent = `${timeline.t.toFixed(2)} s`
    head.style.left = `${xOf(timeline.t)}px`
    const k = selKey()
    easeSelect.disabled = delKey.disabled = !k
    if (k && easeSelect.value !== k.ease) easeSelect.value = k.ease
    const pickedMask = host.list().find((m) => m.id === host.picked())
    addKey.disabled = !pickedMask
    clearKeys.disabled = !pickedMask?.keys.length
  }
  frame()

  function toggle(on = !open) {
    open = on
    root.hidden = !on
    if (on) render(true)
  }
  return {
    toggle,
    get open() {
      return open
    },
    /** Hide while the card is closed (or away from the Sequencer); back as it was after. */
    show(visible: boolean) {
      root.hidden = !(open && visible)
    },
  }
}
