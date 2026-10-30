import { on, state } from '../app/state'
import type { AudioEngine } from '../audio/audioEngine'
import type { Engine } from '../engine/engine'
import { SHOWN, stemColours } from './stemColours'

// The notch: a small black island at the top of the stage, like a phone's
// now-playing activity. A disc in the stems' colours (turning while the music
// plays; click it for the colour settings), what's playing, and a live
// waveform of the whole mix in those colours (click for the Audio card).
// Beside it, a second pill for the volume.

const BARS = 26

/** Returns the volume pill, for the volume control to go in. */
export function buildNotch(stage: HTMLElement, audio: AudioEngine, engine: Engine, open: { audio(): void; colours(): void }) {
  const island = document.createElement('div')
  island.className = 'island'
  const notch = document.createElement('div')
  notch.className = 'notch'
  notch.title = 'Audio settings'
  notch.innerHTML = '<button class="notch-disc" title="Colour settings"></button><span class="notch-info"><b></b><small></small></span><canvas class="notch-wave"></canvas>'
  const volume = document.createElement('div')
  volume.className = 'notch volume-pill'
  volume.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z"/><path d="M15.5 9a4 4 0 010 6M18 6.5a7.5 7.5 0 010 11"/></svg>'
  island.append(notch, volume)
  stage.appendChild(island)
  notch.addEventListener('click', open.audio)
  const disc = notch.querySelector<HTMLElement>('.notch-disc')!
  disc.addEventListener('click', (e) => {
    e.stopPropagation()
    open.colours()
  })
  const title = notch.querySelector('b')!
  const sub = notch.querySelector('small')!
  const canvas = notch.querySelector('canvas')!
  const ctx = canvas.getContext('2d')!

  const show = () => {
    notch.classList.toggle('playing', state.audio.playing)
    sub.textContent = state.audio.playing ? 'Playing' : 'Paused · space to play'
  }
  on('audio', show)
  show()

  // Log-spaced bands of the analyser's spectrum, from the low end to the top.
  const node = audio.analyser.node
  const bins = new Uint8Array(node.frequencyBinCount)
  const hzPerBin = audio.ctx.sampleRate / node.fftSize
  const edges = Array.from({ length: BARS + 1 }, (_, i) => Math.max(1, Math.round((45 * (14000 / 45) ** (i / BARS)) / hzPerBin)))
  const level = new Float32Array(BARS)

  const draw = () => {
    requestAnimationFrame(draw)
    const dpr = Math.min(2, devicePixelRatio || 1)
    const w = canvas.clientWidth, h = canvas.clientHeight
    if (canvas.width !== Math.round(w * dpr)) canvas.width = Math.round(w * dpr)
    if (canvas.height !== Math.round(h * dpr)) canvas.height = Math.round(h * dpr)
    if (title.textContent !== audio.trackName) title.textContent = audio.trackName

    node.getByteFrequencyData(bins)
    const cols = stemColours(engine)
    const stops = SHOWN.map((s) => cols[s])
    disc.style.background = `conic-gradient(${[...stops, stops[0]].join(', ')})`

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, w, h)
    const grad = ctx.createLinearGradient(0, 0, w, 0)
    stops.forEach((c, i) => grad.addColorStop(i / (stops.length - 1), c))
    ctx.fillStyle = grad
    const gap = 2
    const bw = (w - gap * (BARS - 1)) / BARS
    for (let i = 0; i < BARS; i++) {
      let peak = 0
      for (let b = edges[i]; b < Math.max(edges[i] + 1, edges[i + 1]); b++) peak = Math.max(peak, bins[b] ?? 0)
      // Lift the quieter top end a little so the shape reads across.
      const target = state.audio.playing ? Math.min(1, (peak / 255) ** 1.6 * (1 + i / BARS)) : 0
      // Quick up, slower down, like a meter.
      level[i] += (target - level[i]) * (target > level[i] ? 0.5 : 0.12)
      const bh = Math.max(bw, level[i] * h)
      const x = i * (bw + gap)
      ctx.beginPath()
      ctx.roundRect(x, (h - bh) / 2, bw, bh, bw / 2)
      ctx.fill()
    }
  }
  draw()
  return volume
}
