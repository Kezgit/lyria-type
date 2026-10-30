import { state } from '../app/state'
import type { Engine } from '../engine/engine'
import { viewTool, zoomBy } from './view'

// A toolbar along the bottom of the stage, for what's used most:
//   pick / hand     click letters, or drag to pan (H / V; hold space for the hand)
//   zoom            out, the zoom (click: back to 100%), in, fit
//   gradient        the Sequencer's gradient map: jump to its settings, place it
//                   on the stage, paint its mask
//   keyframes       jump to the mode's keyframes
//   PNG             save the frame as a hi-res PNG
// It drives the panel's own controls (found by their titles), so everything
// stays in one place.

const ICONS: Record<string, string> = {
  pick: '<path d="M5 3l6.5 15 2-6.5L20 9.5z"/>',
  hand: '<path d="M8 12V5.5a1.5 1.5 0 013 0V11m0-6.5a1.5 1.5 0 013 0V11m0-4.5a1.5 1.5 0 013 0V14a6 6 0 01-6 6h-1.2a6 6 0 01-4.5-2L4 15.3a1.5 1.5 0 012.2-2L8 15"/>',
  zoomOut: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="M7.5 10.5h6M15.5 15.5L20 20"/>',
  zoomIn: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="M7.5 10.5h6M10.5 7.5v6M15.5 15.5L20 20"/>',
  fit: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
  gradient: '<rect x="3.5" y="5" width="17" height="14" rx="3"/><path d="M8 5v14M12 5v14M16 5v14" opacity=".45"/>',
  place: '<circle cx="6" cy="18" r="2.5"/><circle cx="18" cy="6" r="2.5"/><path d="M8 16l8-8" stroke-dasharray="2.5 2.5"/>',
  fitGradient: '<path d="M4 9V4h5M20 15v5h-5"/><path d="M7 17L17 7" stroke-dasharray="2.5 2.5"/><circle cx="7" cy="17" r="1.6"/><circle cx="17" cy="7" r="1.6"/>',
  colours: '<rect x="5" y="5" width="14" height="14" rx="2" transform="rotate(12 12 12)"/><circle cx="9.5" cy="10" r="1.6" fill="currentColor"/><circle cx="14.5" cy="14" r="1.6"/>',
  mask: '<circle cx="12" cy="12" r="7.5" stroke-dasharray="3 2.5"/><circle cx="12" cy="12" r="3" fill="currentColor"/>',
  keyframes: '<path d="M12 4l5 8-5 8-5-8z"/><path d="M3 12h2M19 12h2"/>',
  png: '<rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><circle cx="9" cy="10" r="1.8"/><path d="M4 17l5-4.5 4 3.5 3-2.5 4 3.5"/>',
}

export function buildToolbar(engine: Engine, viewChanged: () => void, panel: { open(card: string): void; goTo(...prefixes: string[]): boolean; png(): void }) {
  const stage = engine.canvas.parentElement!
  const bar = document.createElement('div')
  bar.className = 'toolbar'
  stage.appendChild(bar)

  const button = (icon: string, title: string, click: () => void) => {
    const b = document.createElement('button')
    b.title = title
    b.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${ICONS[icon]}</svg>`
    b.addEventListener('click', click)
    bar.appendChild(b)
    return b
  }
  const gap = () => bar.appendChild(Object.assign(document.createElement('span'), { className: 'toolbar-gap' }))

  // --- Panel helpers: a Mode group by its title, a button by its text.
  const goTo = (prefix: string) => panel.goTo(prefix)
  const panelButton = (text: string) => [...document.querySelectorAll<HTMLButtonElement>('#panel button')].find((b) => b.textContent === text)

  // --- View --------------------------------------------------------------------
  const pick = button('pick', 'Pick letters (V)', () => { viewTool.hand = false; viewChanged() })
  const hand = button('hand', 'Hand: drag to pan (H, or hold space)', () => { viewTool.hand = !viewTool.hand; viewChanged() })
  gap()
  button('zoomOut', 'Zoom out (⌘ −, or pinch)', () => { zoomBy(engine, 0.8); viewChanged() })
  const zoomText = document.createElement('button')
  zoomText.className = 'toolbar-zoom'
  zoomText.title = 'Back to 100%'
  zoomText.addEventListener('click', () => { Object.assign(state.view, { zoom: 1, x: 0, y: 0 }); viewChanged() })
  bar.appendChild(zoomText)
  button('zoomIn', 'Zoom in (⌘ +, or pinch)', () => { zoomBy(engine, 1.25); viewChanged() })
  button('fit', 'Fit the frame (⌘ 0)', () => { Object.assign(state.view, { zoom: 1, x: 0, y: 0 }); viewChanged() })
  gap()

  // --- Gradient (the Sequencer's) ------------------------------------------------
  const gradient = button('gradient', 'Gradient map settings', () => goTo('Gradient map'))
  const place = button('place', 'Place the gradient on the stage', () => { panelButton('Place on the stage')?.click() })
  const fitGradient = button('fitGradient', 'Fit the gradient to the view', () => { panelButton('Fit to the view')?.click() })
  const colours = button('colours', 'Place the Dots colours on the stage', () => {
    if (!panelButton('Place colours on the stage')) goTo('Colour')
    setTimeout(() => panelButton('Place colours on the stage')?.click(), 120)
  })
  const mask = button('mask', 'Paint the mask (alt to erase)', () => { panelButton('Paint the mask')?.click() })
  gap()
  button('keyframes', 'Keyframes', () => goTo('Keyframes'))
  button('png', 'Save a hi-res PNG (size in Export)', () => panel.png())

  // Keep the buttons showing what's on.
  const sync = () => {
    pick.classList.toggle('on', !viewTool.hand && !viewTool.space)
    hand.classList.toggle('on', viewTool.hand || viewTool.space)
    zoomText.textContent = `${Math.round(state.view.zoom * 100)}%`
    const seq = state.modeId === 'sequencer'
    fitGradient.disabled = !seq
    colours.disabled = !seq || state.modeParams.sequencer?.style !== 'dots'
    colours.classList.toggle('on', !!panelButton('Place colours on the stage')?.classList.contains('on'))
    for (const b of [gradient, place, mask]) {
      b.disabled = !seq
      if (!seq) b.title = 'Gradient map: in the Sequencer mode'
    }
    if (seq) {
      gradient.title = 'Gradient map settings'
      place.title = 'Place the gradient on the stage'
      mask.title = 'Paint the mask (alt to erase)'
    }
    place.classList.toggle('on', !!panelButton('Place on the stage')?.classList.contains('on'))
    mask.classList.toggle('on', !!panelButton('Paint the mask')?.classList.contains('on'))
  }
  setInterval(sync, 150)
  sync()
}
