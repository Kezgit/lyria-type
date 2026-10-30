import { ArrayBufferTarget, FileSystemWritableFileStreamTarget, Muxer } from 'mp4-muxer'
import type { AudioEngine } from '../audio/audioEngine'
import type { OfflineTrack } from '../audio/sources/types'
import type { Engine } from '../engine/engine'

// Exports render the preview's frame (same layout, same CSS px) at a higher
// pixel ratio, so they look as it does with more pixels (see engine/pixels.ts
// for the screen-space parts).
//   PNG   one frame: the one on screen, at 4K or 8K (zoom the view in for detail:
//         the view magnifies the picture, its edges stay crisp)
//   MP4   frame-exact: each frame gets the audio features of its own moment,
//         read from the decoded / rendered track (audio/analysis/frames.ts),
//         however long it takes to draw; H.264 via WebCodecs, the song as AAC
//         (Opus if the browser can't encode AAC), muxed by mp4-muxer and
//         streamed to the chosen file where the browser lets us pick one
// The file is picked first (it needs the click), then the work runs.

export type ExportKind = 'png-4k' | 'png-8k' | 'mp4-4k'

export const EXPORT_OPTIONS: Record<string, ExportKind> = {
  'PNG · 4K (3840 × 2160)': 'png-4k',
  'PNG · 8K (7680 × 4320)': 'png-8k',
  'MP4 · 4K (3840 × 2160)': 'mp4-4k',
}

const WIDTH: Record<ExportKind, number> = { 'png-4k': 3840, 'png-8k': 7680, 'mp4-4k': 3840 }

export interface ExportJob {
  kind: ExportKind
  name: string
  fps: number
  /** Track time to start at, s. */
  start: number
  /** Seconds to render; 0 = one pass of the track. */
  seconds: number
  onProgress?: (done: number, total: number, label: string) => void
  signal?: AbortSignal
}

export async function runExport(engine: Engine, audio: AudioEngine, job: ExportJob): Promise<'done' | 'cancelled'> {
  const video = job.kind === 'mp4-4k'
  const file = await pickFile(`${job.name}.${video ? 'mp4' : 'png'}`, video ? 'video/mp4' : 'image/png')
  if (file === 'cancelled') return 'cancelled'
  try {
    if (video) await exportMp4(engine, audio, job, file)
    else await exportPng(engine, audio, job, file)
    return 'done'
  } catch (e) {
    await file?.abort().catch(() => {})
    if ((e as Error).name === 'AbortError') return 'cancelled'
    throw e
  }
}

// --- PNG ---------------------------------------------------------------------

/** The frame on screen, at the chosen size: the live mode carries on one frame, as it would on screen. */
async function exportPng(engine: Engine, audio: AudioEngine, job: ExportJob, file: FileSystemWritableFileStream | null) {
  const width = WIDTH[job.kind]
  if (width > engine.maxTextureSize) throw new Error(`This GPU draws at most ${engine.maxTextureSize} px across; ${width} won't fit.`)
  job.onProgress?.(0, 1, 'Rendering…')
  let bitmap: ImageBitmap
  try {
    engine.beginExport(width, false)
    bitmap = await engine.renderExportFrame(1 / 60, engine.liveTime, audio.features, (c) => createImageBitmap(c))
  } finally {
    engine.endExport()
  }
  job.onProgress?.(0, 1, 'Encoding PNG…')
  const { width: w, height: h } = bitmap
  const canvas = new OffscreenCanvas(w, h)
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0)
  bitmap.close()
  const blob = await canvas.convertToBlob({ type: 'image/png' })
  await save(blob, file, `${job.name}.png`)
  job.onProgress?.(1, 1, `Saved ${w} × ${h} PNG`)
}

// --- MP4 ---------------------------------------------------------------------

/** Codecs to try, best first: H.264 High at 5.2 (4K60), 5.1, then 4.0. */
const AVC = ['avc1.640034', 'avc1.640033', 'avc1.640028']
/** Seconds rendered (not kept) before the first frame, so envelopes and auto-gains are settled as they are live. */
const PREROLL = 1

async function exportMp4(engine: Engine, audio: AudioEngine, job: ExportJob, file: FileSystemWritableFileStream | null) {
  if (typeof VideoEncoder === 'undefined') throw new Error('MP4 export needs WebCodecs (Chrome or Edge).')
  const { signal, fps } = job
  job.onProgress?.(0, 1, 'Preparing the audio…')
  const { track, features } = await audio.offline()
  const seconds = job.seconds > 0 ? job.seconds : track.duration
  const frames = Math.max(1, Math.round(seconds * fps))
  const width = WIDTH[job.kind]
  const height = Math.round((width / engine.frameSize.width) * engine.frameSize.height)
  const w = width & ~1, h = height & ~1

  // Video: the first AVC level this browser encodes at this size.
  // Fine dots and grain need a lot of bits: constant rate (encoders undershoot a variable one on flat pages).
  const bitrate = Math.round(Math.min(80e6, Math.max(25e6, w * h * fps * 0.2)))
  let config: VideoEncoderConfig | null = null
  for (const codec of AVC) {
    const c: VideoEncoderConfig = { codec, width: w, height: h, bitrate, framerate: fps, bitrateMode: 'constant', hardwareAcceleration: 'prefer-hardware', latencyMode: 'quality', avc: { format: 'avc' } }
    const s = await VideoEncoder.isConfigSupported(c).catch(() => null)
    if (s?.supported) { config = s.config ?? c; break }
  }
  if (!config) throw new Error(`This browser can't encode H.264 at ${w} × ${h}.`)

  // Audio: AAC, else Opus.
  const channels = Math.min(2, track.channels.length)
  let audioCodec: 'aac' | 'opus' | null = null
  let audioConfig: AudioEncoderConfig | null = null
  for (const [codec, id] of [['aac', 'mp4a.40.2'], ['opus', 'opus']] as const) {
    if (typeof AudioEncoder === 'undefined') break
    const c: AudioEncoderConfig = { codec: id, sampleRate: track.sampleRate, numberOfChannels: channels, bitrate: 192_000 }
    const s = await AudioEncoder.isConfigSupported(c).catch(() => null)
    if (s?.supported) { audioCodec = codec; audioConfig = s.config ?? c; break }
  }
  if (!audioCodec) console.warn('[export] no audio encoder here; writing video only')

  const target = file ? new FileSystemWritableFileStreamTarget(file, { chunkSize: 2 ** 20 }) : new ArrayBufferTarget()
  const samples = Math.round(seconds * track.sampleRate)
  const muxer = new Muxer({
    target,
    video: { codec: 'avc', width: w, height: h, frameRate: fps },
    audio: audioCodec ? { codec: audioCodec, numberOfChannels: channels, sampleRate: track.sampleRate } : undefined,
    fastStart: file ? false : 'in-memory',
    firstTimestampBehavior: 'offset',
  })

  let failure: unknown = null
  const videoEncoder = new VideoEncoder({ output: (chunk, meta) => muxer.addVideoChunk(chunk, meta), error: (e) => (failure = e) })
  videoEncoder.configure(config)
  const audioEncoder = audioCodec
    ? new AudioEncoder({ output: (chunk, meta) => muxer.addAudioChunk(chunk, meta), error: (e) => (failure = e) })
    : null
  if (audioEncoder) audioEncoder.configure(audioConfig!)

  try {
    if (audioEncoder) encodeAudio(audioEncoder, track, job.start, samples, channels)
    const feats = features()
    const dt = 1 / fps
    engine.beginExport(width, true)
    // Pre-roll: settle the analysers and the mode without keeping the frames.
    const pre = Math.round(PREROLL * fps)
    for (let i = -pre; i < 0; i++) {
      const t = job.start + i * dt
      engine.renderExportFrame(dt, t, feats.at(t, dt), () => null)
      if (i % 10 === 0) await idle()
    }
    const keyEvery = Math.round(fps * 2)
    const duration = Math.round(1e6 / fps)
    for (let i = 0; i < frames; i++) {
      if (signal?.aborted) throw new DOMException('Export cancelled', 'AbortError')
      if (failure) throw failure
      const t = job.start + i * dt
      const frame = engine.renderExportFrame(dt, t, feats.at(t, dt), (c) => new VideoFrame(c, { timestamp: Math.round((i * 1e6) / fps), duration }))
      videoEncoder.encode(frame, { keyFrame: i % keyEvery === 0 })
      frame.close()
      // Backpressure: let the encoder catch up.
      while (videoEncoder.encodeQueueSize > 6) await new Promise((r) => videoEncoder.addEventListener('dequeue', r, { once: true }))
      job.onProgress?.(i + 1, frames, `Rendering frame ${i + 1} of ${frames}`)
      if (i % 4 === 0) await idle()
    }
    job.onProgress?.(frames, frames, 'Finishing…')
    await videoEncoder.flush()
    if (audioEncoder) await audioEncoder.flush()
    if (failure) throw failure
    muxer.finalize()
    if (target instanceof ArrayBufferTarget) await save(new Blob([target.buffer], { type: 'video/mp4' }), null, `${job.name}.mp4`)
    else await file!.close()
    job.onProgress?.(frames, frames, `Saved ${w} × ${h} MP4, ${frames} frames`)
  } finally {
    engine.endExport()
    if (videoEncoder.state !== 'closed') videoEncoder.close()
    if (audioEncoder && audioEncoder.state !== 'closed') audioEncoder.close()
  }
}

/** The track's audio from `start` for `samples` frames (wrapping, as it loops), in 1024-frame chunks. */
function encodeAudio(encoder: AudioEncoder, track: OfflineTrack, start: number, samples: number, channels: number) {
  const len = track.channels[0].length
  const first = Math.round(start * track.sampleRate)
  const CHUNK = 1024
  for (let at = 0; at < samples; at += CHUNK) {
    const n = Math.min(CHUNK, samples - at)
    const planar = new Float32Array(n * channels)
    for (let c = 0; c < channels; c++) {
      const src = track.channels[Math.min(c, track.channels.length - 1)]
      for (let i = 0; i < n; i++) planar[c * n + i] = src[(((first + at + i) % len) + len) % len]
    }
    const data = new AudioData({
      format: 'f32-planar', sampleRate: track.sampleRate, numberOfFrames: n, numberOfChannels: channels,
      timestamp: Math.round((at / track.sampleRate) * 1e6), data: planar,
    })
    encoder.encode(data)
    data.close()
  }
}

// --- Files -------------------------------------------------------------------

const idle = () => new Promise((r) => setTimeout(r, 0))

/** A file to write to, picked now (needs the click); null where the browser can't (a download instead). */
async function pickFile(suggestedName: string, type: string): Promise<FileSystemWritableFileStream | null | 'cancelled'> {
  const picker = (window as any).showSaveFilePicker
  if (!picker) return null
  try {
    const ext = suggestedName.slice(suggestedName.lastIndexOf('.'))
    const handle = await picker({ suggestedName, types: [{ description: type, accept: { [type]: [ext] } }] })
    return await handle.createWritable()
  } catch (e) {
    if ((e as Error).name === 'AbortError') return 'cancelled'
    throw e
  }
}

async function save(blob: Blob, file: FileSystemWritableFileStream | null, name: string) {
  if (file) {
    await file.write(blob)
    await file.close()
    return
  }
  const url = URL.createObjectURL(blob)
  const a = Object.assign(document.createElement('a'), { href: url, download: name })
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}
