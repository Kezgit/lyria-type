import { emit, state } from '../app/state'
import type { ParamDef } from '../app/params'
import { LAYERS } from '../audio/analysis/listener'
import { getMode } from '../modes'
import { rackFeed } from '../modes/orchestra/conductor'
import { LAYER_INFO, colourKey } from '../modes/orchestra/layers'
import { STAGES } from '../modes/orchestra/stage'

// The instruments rack, in its own card (every mode): one row per layer with
// its colour (the colour its letters take), an on / off light, sensitivity and
// gate dials and a 16-step strip that lights as the layer plays (dashed: hits
// the gate held back; click to place a note). In the Orchestra it also shows
// where the song is and the Orchestra's own dials. Dials turn by dragging
// left/right.

const FIELD_DIALS: { key: string; label: string; hint: string; pct?: boolean }[] = [
  { key: 'sensitivity', label: 'Sens', hint: 'How readily every layer is heard' },
  { key: 'speed', label: 'Speed', hint: 'How fast the walls pour out of the letters, px/s' },
  { key: 'trail', label: 'Decay', hint: 'How long trails last once poured, seconds' },
  { key: 'perspective', label: 'Depth', hint: 'How hard the wall rushes toward you, widening as it comes' },
  { key: 'glow', label: 'Bloom', hint: 'Light spilling off the bright parts (heavier hits burn brighter)' },
  { key: 'letterGlow', label: 'Lit', hint: 'Letters lit from within when they play (edge set in the panel)' },
  { key: 'gloss', label: 'Gloss', hint: 'Glossy bright cores along the strands', pct: true },
  { key: 'split', label: 'Split', hint: 'How much trails break into strands at the far end', pct: true },
  { key: 'push', label: 'Push', hint: 'How far a beat pushes its letters along their wall, px' },
  { key: 'peak', label: 'Peak', hint: 'How strongly a peak (many layers at once) takes over' },
  { key: 'peakAt', label: 'Peak at', hint: 'How many layers at once count as a peak (higher = rarer)' },
]

/** Which way the walls pour. */
const DIRECTIONS: [string, string][] = [['out', 'Out'], ['up', 'Up'], ['down', 'Down'], ['sides', 'Sides'], ['updown', 'Up+down']]

const values = () => state.modeParams.orchestra
const schema = () => getMode('orchestra').params as Record<string, Extract<ParamDef, { type: 'number' }>>

/** Panel controls follow the rack on the next frame (one refresh per frame however fast a dial turns). */
let pendingEmit = false
function changed() {
  if (pendingEmit) return
  pendingEmit = true
  requestAnimationFrame(() => {
    pendingEmit = false
    emit('params')
  })
}

interface Dial {
  el: HTMLElement
  sync(): void
}

/** A knob: drag left/right (shift = fine), scroll, or double-click to reset. */
function dial(key: string, label: string, hint: string, format: (v: number) => string, tint = '#e6eaf0'): Dial {
  const def = schema()[key]
  const el = document.createElement('div')
  el.className = 'dial'
  el.title = `${hint}\nDrag left/right · shift = fine · double-click resets`
  el.innerHTML = `
    <svg viewBox="0 0 40 40" width="30" height="30">
      <circle cx="20" cy="20" r="15" class="dial-body"/>
      <path class="dial-track" d=""/>
      <path class="dial-value" d=""/>
      <line class="dial-tick" x1="20" y1="20" x2="20" y2="8"/>
    </svg>
    <span class="dial-label">${label}</span>
    <span class="dial-read"></span>`
  const track = el.querySelector<SVGPathElement>('.dial-track')!
  const arc = el.querySelector<SVGPathElement>('.dial-value')!
  const tick = el.querySelector<SVGLineElement>('.dial-tick')!
  const read = el.querySelector<HTMLElement>('.dial-read')!
  const A0 = -135
  const A1 = 135
  const polar = (deg: number, r: number) => {
    const a = ((deg - 90) * Math.PI) / 180
    return `${20 + r * Math.cos(a)} ${20 + r * Math.sin(a)}`
  }
  const arcPath = (from: number, to: number) => `M ${polar(from, 18)} A 18 18 0 ${to - from > 180 ? 1 : 0} 1 ${polar(to, 18)}`
  track.setAttribute('d', arcPath(A0, A1))
  arc.style.stroke = tint

  let shown = NaN
  const sync = () => {
    const v = values()[key]
    if (v === shown) return
    shown = v
    const t = (v - def.min) / (def.max - def.min)
    const deg = A0 + (A1 - A0) * Math.max(0, Math.min(1, t))
    arc.setAttribute('d', deg - A0 < 0.5 ? '' : arcPath(A0, deg))
    tick.setAttribute('transform', `rotate(${deg} 20 20)`)
    read.textContent = format(v)
  }
  const set = (v: number) => {
    const step = def.step ?? 0.01
    values()[key] = Number(Math.max(def.min, Math.min(def.max, Math.round(v / step) * step)).toFixed(4))
    sync()
    changed()
  }

  el.addEventListener('pointerdown', (e) => {
    e.preventDefault()
    e.stopPropagation()
    el.setPointerCapture(e.pointerId)
    el.classList.add('turning')
    let last = e.clientX
    const move = (m: PointerEvent) => {
      const dx = m.clientX - last
      last = m.clientX
      set(values()[key] + ((dx / 160) * (def.max - def.min)) / (m.shiftKey ? 5 : 1))
    }
    const up = () => {
      el.classList.remove('turning')
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
      el.removeEventListener('pointercancel', up)
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
    el.addEventListener('pointercancel', up)
  })
  el.addEventListener('wheel', (e) => {
    e.preventDefault()
    set(values()[key] - (Math.sign(e.deltaY) * (def.max - def.min)) / (e.shiftKey ? 200 : 50))
  }, { passive: false })
  el.addEventListener('dblclick', () => set(def.value))
  sync()
  return { el, sync }
}

const pct = (v: number) => `${Math.round(v * 100)}%`
const num = (v: number) => (Math.abs(v) >= 10 ? v.toFixed(0) : v.toFixed(2))

export function buildRack(page: HTMLElement, visible: () => boolean) {
  const root = document.createElement('div')
  root.className = 'rack'
  page.appendChild(root)

  // Where the song is (the Orchestra's sections and energy): only in the Orchestra.
  const head = document.createElement('header')
  head.innerHTML = `
    <span class="rack-stages">${STAGES.map((s) => `<button data-stage="${s}" title="Skip to the next ${s}">${s}</button>`).join('')}</span>
    <span class="rack-next"></span>
    <span class="rack-meter" title="Energy of the song now"><i class="energy"></i></span>
    <span class="rack-meter wind" title="Wind-up: a bigger section is coming"><i class="anticipation"></i></span>
    <span class="rack-meter unison" title="Unison: the whole piece playing together (a peak)"><i class="unison"></i></span>`
  root.appendChild(head)
  const body = document.createElement('div')
  body.className = 'rack-body'
  root.appendChild(body)

  // --- Layer rows -----------------------------------------------------------------
  const dials: Dial[] = []
  const rows = LAYERS.map((l) => {
    const info = LAYER_INFO[l]
    const row = document.createElement('div')
    row.className = 'rack-row'
    // The light switches the layer on and off; the chip on its name sets its colour.
    const swatch = document.createElement('button')
    swatch.className = 'rack-swatch'
    swatch.title = `${info.label}: on / off`
    swatch.addEventListener('click', () => {
      values()[`${l}On`] = values()[`${l}On`] === false
      changed()
    })
    const chip = document.createElement('label')
    chip.className = 'rack-chip'
    chip.title = `${info.label} colour`
    const picker = document.createElement('input')
    picker.type = 'color'
    picker.addEventListener('input', () => {
      values()[colourKey(l)] = picker.value
      changed()
    })
    chip.appendChild(picker)
    const sens = dial(`${l}Sens`, 'Sens', `${info.label}: sensitivity (how loud its sounds count)`, pct)
    const gate = dial(`${l}Gate`, 'Gate', `${info.label}: gate (sounds quieter than this are ignored)`, pct)
    dials.push(sens, gate)
    const name = document.createElement('div')
    name.className = 'rack-name'
    name.innerHTML = `<b>${info.label}</b><small>${info.role}</small>`
    name.appendChild(chip)
    const meter = document.createElement('span')
    meter.className = 'rack-level'
    meter.innerHTML = '<i></i>'
    const steps = document.createElement('div')
    steps.className = 'rack-steps'
    // Click a step to place a note there (played every bar, alongside what is heard); click again to clear.
    const pads = Array.from({ length: 16 }, (_, i) => {
      const pad = document.createElement('span')
      pad.className = i % 8 < 4 ? 'pad' : 'pad alt'
      pad.title = `${info.label}: click to place a note on step ${i + 1}`
      pad.addEventListener('pointerdown', (e) => e.stopPropagation())
      pad.addEventListener('click', () => {
        const key = `${l}Steps`
        const now = ((values()[key] as string) ?? '').padEnd(16, '0').split('')
        now[i] = now[i] === '1' ? '0' : '1'
        values()[key] = now.join('')
        changed()
      })
      steps.appendChild(pad)
      return pad
    })
    row.append(swatch, name, meter, sens.el, gate.el, steps)
    body.appendChild(row)
    return { l, row, swatch, picker, sens, gate, meter: meter.firstElementChild as HTMLElement, pads }
  })

  // --- The whole piece --------------------------------------------------------------
  const field = document.createElement('div')
  field.className = 'rack-field'
  field.innerHTML = '<h5>Orchestra</h5>'
  for (const d of FIELD_DIALS) {
    const k = dial(d.key, d.label, d.hint, d.pct ? pct : num)
    dials.push(k)
    field.appendChild(k.el)
  }
  const shapes = document.createElement('div')
  shapes.className = 'rack-shapes'
  const choice = (key: string, options: [string, string][], group: HTMLElement) =>
    options.map(([id, label]) => {
      const b = document.createElement('button')
      b.textContent = label
      b.addEventListener('click', () => {
        values()[key] = id
        changed()
      })
      group.appendChild(b)
      return { key, id, b }
    })
  const wayGroup = document.createElement('span')
  wayGroup.className = 'rack-group'
  const shapeButtons = [
    ...choice('direction', DIRECTIONS, wayGroup),
  ]
  shapes.append(wayGroup)
  const toggle = (key: string, on: string, off: string, hint: string) => {
    const b = document.createElement('button')
    b.className = 'rack-letters'
    b.title = hint
    b.addEventListener('click', () => {
      values()[key] = !values()[key]
      changed()
    })
    return { key, on, off, b }
  }
  const toggles = [
    toggle('trailOver', 'Trails over', 'Trails under', 'Trails pass over the letters, or the letters sit on top'),
    toggle('displace', 'Push on', 'Push off', 'Beats push their letters along the wall'),
    toggle('wholeBlock', 'Whole block', 'By letters', 'Every instrument plays the whole block: kick lights it all, hats sweep every letter top to bottom, snares crack out from the middle'),
    toggle('keyboard', 'Keyboard on', 'Keyboard off', 'Press a key to play every matching letter on the stage, like a piano'),
  ]
  const lettersBtn = document.createElement('button')
  lettersBtn.className = 'rack-letters'
  lettersBtn.title = 'Show the letters, or only the streams they send'
  lettersBtn.addEventListener('click', () => {
    values().letters = !values().letters
    changed()
  })
  shapes.append(lettersBtn, ...toggles.map((t) => t.b))
  field.appendChild(shapes)
  body.appendChild(field)
  const hint = document.createElement('p')
  hint.className = 'hint rack-hint'
  hint.textContent = 'Click a step to add a note (played every bar). Click a dot to mute an instrument, its square to change its colour. While paused, click letters on the stage to give them to an instrument.'
  body.appendChild(hint)

  const stageChips = [...head.querySelectorAll<HTMLElement>('[data-stage]')]
  for (const c of stageChips) {
    c.addEventListener('pointerdown', (e) => e.stopPropagation())
    c.addEventListener('click', () => rackFeed.jump(c.dataset.stage as (typeof STAGES)[number]))
  }
  const next = head.querySelector<HTMLElement>('.rack-next')!
  const energy = head.querySelector<HTMLElement>('.energy')!
  const wind = head.querySelector<HTMLElement>('.anticipation')!
  const unison = head.querySelector<HTMLElement>('i.unison')!

  const frame = () => {
    requestAnimationFrame(frame)
    if (!visible()) return
    const orchestra = state.modeId === 'orchestra'
    head.hidden = !orchestra
    field.hidden = !orchestra
    const v = values()
    for (const c of stageChips) c.classList.toggle('on', c.dataset.stage === rackFeed.stage)
    next.textContent = rackFeed.next ? `→ ${rackFeed.next} in ${Math.max(1, Math.ceil(rackFeed.barsToNext))} bar${Math.ceil(rackFeed.barsToNext) > 1 ? 's' : ''}` : ''
    energy.style.width = pct(Math.min(1, rackFeed.energy))
    wind.style.width = pct(Math.min(1, rackFeed.anticipation))
    unison.style.width = pct(Math.min(1, rackFeed.unison))
    for (const d of dials) d.sync()
    for (const { key, id, b } of shapeButtons) b.classList.toggle('on', v[key] === id)
    for (const t of toggles) {
      t.b.textContent = v[t.key] ? t.on : t.off
      t.b.classList.toggle('on', !!v[t.key])
    }
    lettersBtn.textContent = v.letters ? 'Letters on' : 'Streams only'
    lettersBtn.classList.toggle('on', !!v.letters)
    for (const r of rows) {
      const colour = v[colourKey(r.l)]
      if (r.picker.value !== colour) r.picker.value = colour
      r.row.style.setProperty('--c', colour)
      r.row.classList.toggle('off', v[`${r.l}On`] === false)
      const part = rackFeed.parts[r.l]
      r.meter.style.height = pct(part.level)
      const placed = (v[`${r.l}Steps`] as string) ?? ''
      for (let i = 0; i < 16; i++) {
        const pad = r.pads[i]
        pad.classList.toggle('set', placed[i] === '1')
        pad.style.setProperty('--on', part.passed[i].toFixed(3))
        pad.classList.toggle('held', part.blocked[i] > 0.1 && part.passed[i] < 0.1)
        pad.classList.toggle('now', i === rackFeed.step)
      }
    }
  }
  requestAnimationFrame(frame)
}
