import type { AudioEngine } from '../audio/audioEngine'

// Record a short clip of the stage with its music (up to MAX_SECONDS) and
// save it as a video file: MP4 where the browser can make one, else WebM.
// Starts the music if it was paused; click again to stop early.

const MAX_SECONDS = 10

/** Best container the browser can record to, MP4 first. */
function pickFormat(): { mimeType: string; ext: string } | null {
  const candidates = [
    'video/mp4;codecs=avc1.640033,mp4a.40.2',
    'video/mp4;codecs=avc1.4d0033,mp4a.40.2',
    'video/mp4;codecs=avc1,mp4a.40.2',
    'video/mp4',
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm',
  ]
  const mimeType = candidates.find((t) => MediaRecorder.isTypeSupported(t))
  return mimeType ? { mimeType, ext: mimeType.startsWith('video/mp4') ? 'mp4' : 'webm' } : null
}

export function buildRecorder(stage: HTMLElement, canvas: HTMLCanvasElement, audio: AudioEngine, play: () => Promise<void>) {
  const button = document.createElement('button')
  button.className = 'record'
  stage.appendChild(button)

  let recorder: MediaRecorder | null = null
  let timer = 0
  let started = 0
  // One audio tap for the page's life (each call adds a connection).
  let music: MediaStream | null = null

  const show = () => {
    const left = recorder ? Math.max(0, Math.ceil(MAX_SECONDS - (performance.now() - started) / 1000)) : 0
    button.classList.toggle('on', !!recorder)
    button.textContent = recorder ? String(left) : ''
    button.title = recorder ? 'Stop recording (saves the clip)' : `Record a clip with sound (up to ${MAX_SECONDS} s)`
  }

  const stop = () => recorder?.state === 'recording' && recorder.stop()

  const start = async () => {
    const format = pickFormat()
    if (!format) return alert("This browser can't record video.")
    await play()
    music ??= audio.recordStream()
    const stream = new MediaStream([...canvas.captureStream(60).getVideoTracks(), ...music.getAudioTracks()])
    const chunks: Blob[] = []
    const rec = new MediaRecorder(stream, { mimeType: format.mimeType, videoBitsPerSecond: 16_000_000, audioBitsPerSecond: 256_000 })
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data)
    rec.onstop = () => {
      stream.getVideoTracks().forEach((t) => t.stop())
      clearInterval(timer)
      recorder = null
      show()
      const blob = new Blob(chunks, { type: format.mimeType.split(';')[0] })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `lyria-type-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.${format.ext}`
      a.click()
      setTimeout(() => URL.revokeObjectURL(url), 5000)
    }
    rec.start(250)
    recorder = rec
    started = performance.now()
    timer = window.setInterval(() => {
      show()
      if (performance.now() - started >= MAX_SECONDS * 1000) stop()
    }, 200)
    show()
  }

  button.addEventListener('click', () => (recorder ? stop() : start()))
  show()
}
