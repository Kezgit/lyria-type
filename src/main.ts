import './ui/styles.css'
import { AudioEngine } from './audio/audioEngine'
import { Engine } from './engine/engine'
import { applyScene } from './app/scene'
import { emit, on, state } from './app/state'
import defaultScene from './app/defaultScene.json'
import { buildPanel } from './ui/panel'
import { buildPicker } from './ui/picker'
import { setSeek } from './modes/orchestra/conductor'
import { autosave, restoreSession } from './app/session'
import { buildRecorder } from './ui/recorder'
import { buildNotch } from './ui/notch'
import { onSpaceTap } from './ui/view'

// Start from the saved default scene (Sequencer · Dots).
await applyScene(defaultScene)

const audio = new AudioEngine()
const engine = new Engine(document.getElementById('stage')!, audio)
const panel = buildPanel(document.getElementById('panel')!, audio, engine)
buildPicker(document.getElementById('stage')!, engine)
setSeek((step) => audio.seek(step))
// Pick up where things were left (over the default scene), then keep saving as they change.
await restoreSession()
// Letters given to layers used to be the Orchestra's own; carry them over to the shared assignment.
if (!state.letterParts && state.modeParams.orchestra?.assign) state.letterParts = state.modeParams.orchestra.assign
autosave()

await audio.useDemo()
await engine.start()

// A new song starts from what is heard: notes placed by hand on the rack were for the last one.
audio.onSourceChange(() => {
  for (const [key, v] of Object.entries(state.modeParams.orchestra)) {
    if (key.endsWith('Steps') && typeof v === 'string') state.modeParams.orchestra[key] = '0'.repeat(16)
  }
  emit('params')
})

// Loads paused; this button (a user gesture, which browsers need before
// audio can start) plays and pauses, in step with the panel's Play button.
const transport = document.createElement('button')
transport.className = 'transport'
document.getElementById('stage')!.appendChild(transport)

// Volume, above the play button; remembered between visits.
const VOLUME_KEY = 'lyria-type:volume'
const volume = document.createElement('input')
volume.type = 'range'
volume.className = 'volume'
volume.min = '0'
volume.max = '1'
volume.step = '0.01'
volume.title = 'Volume'
try {
  volume.value = localStorage.getItem(VOLUME_KEY) ?? '0.8'
} catch {
  volume.value = '0.8'
}
const showVolume = () => volume.style.setProperty('--fill', `${Number(volume.value) * 100}%`)
audio.setVolume(Number(volume.value))
showVolume()
volume.addEventListener('input', () => {
  audio.setVolume(Number(volume.value))
  showVolume()
  try {
    localStorage.setItem(VOLUME_KEY, volume.value)
  } catch {}
})
const showTransport = () => {
  transport.textContent = state.audio.playing ? '❚❚' : '▶'
  transport.title = state.audio.playing ? 'Pause' : 'Play'
}
async function togglePlay() {
  if (state.audio.playing) audio.pause()
  else await audio.play()
  state.audio.playing = !state.audio.playing
  emit('audio')
}
transport.addEventListener('click', togglePlay)
on('audio', showTransport)
showTransport()
// A tap of space plays and pauses too; the notch at the top shows what's playing, the volume beside it.
onSpaceTap(togglePlay)
buildNotch(document.getElementById('stage')!, audio, engine, {
  audio: () => panel.open('Audio'),
  colours: () => panel.goTo('Gradient map', 'Colour', 'Ink', 'Recolour', 'Look'),
}).appendChild(volume)

// Back to the start of the song, beside play.
const restart = document.createElement('button')
restart.className = 'restart'
restart.title = 'Back to the start'
restart.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 12a7.5 7.5 0 102.2-5.3"/><path d="M4.5 4.5v4.2h4.2"/></svg>'
restart.addEventListener('click', () => audio.seek(0))
document.getElementById('stage')!.appendChild(restart)

// Record a clip (picture and sound) next to the play button; recording starts the music.
buildRecorder(document.getElementById('stage')!, engine.canvas, audio, async () => {
  if (state.audio.playing) return
  await audio.play()
  state.audio.playing = true
  emit('audio')
})

// Handy for poking at the scene from devtools.
if (import.meta.env.DEV) Object.assign(window, { engine, audio, state })
