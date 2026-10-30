import './ui/styles.css'
import { AudioEngine } from './audio/audioEngine'
import { Engine } from './engine/engine'
import { applyScene } from './app/scene'
import { emit, on, state } from './app/state'
import defaultScene from './app/defaultScene.json'
import { buildPanel } from './ui/panel'
import { buildRack } from './ui/rack'
import { buildPicker } from './ui/picker'
import { setSeek } from './modes/orchestra/conductor'
import { autosave, restoreSession } from './app/session'
import { buildRecorder } from './ui/recorder'

// Start from the saved default scene (Sequencer · Dots).
await applyScene(defaultScene)

const audio = new AudioEngine()
const engine = new Engine(document.getElementById('stage')!, audio)
buildPanel(document.getElementById('panel')!, audio, engine)
buildRack(document.getElementById('stage')!)
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
document.getElementById('stage')!.appendChild(volume)
const showTransport = () => {
  transport.textContent = state.audio.playing ? '❚❚' : '▶'
  transport.title = state.audio.playing ? 'Pause' : 'Play'
}
transport.addEventListener('click', async () => {
  if (state.audio.playing) audio.pause()
  else await audio.play()
  state.audio.playing = !state.audio.playing
  emit('audio')
})
on('audio', showTransport)
showTransport()

// Record a clip (picture and sound) next to the play button; recording starts the music.
buildRecorder(document.getElementById('stage')!, engine.canvas, audio, async () => {
  if (state.audio.playing) return
  await audio.play()
  state.audio.playing = true
  emit('audio')
})

// Handy for poking at the scene from devtools.
if (import.meta.env.DEV) Object.assign(window, { engine, audio, state })
