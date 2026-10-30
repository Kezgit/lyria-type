import { FeatureAnalyser } from './analysis/analyser'
import { FrameFeatures } from './analysis/frames'
import { RhythmTracker } from './analysis/rhythm'
import { StemAnalyser, estimateStems } from './analysis/stem'
import { LayerListener } from './analysis/listener'
import { DemoSource } from './sources/demo'
import { FileSource } from './sources/file'
import { MicSource } from './sources/mic'
import { StemSource } from './sources/stems'
import type { AudioSource } from './sources/types'
import type { AudioFeatures, Stem } from './features'

// Owns the AudioContext, the active source and the analyser.
//   source.output -> analyser
//   source.output -> volume -> speakers (if audible)
// Volume sits after the analysers, so turning it down never changes the visuals.
// After analysis, the rhythm tracker adds the beat clock and note events.
// Sources with separate stems get one small analyser per stem; for a plain
// mix the stems are estimated from it.
export class AudioEngine {
  readonly ctx = new AudioContext({ latencyHint: 'interactive' })
  readonly analyser = new FeatureAnalyser(this.ctx)
  private rhythm = new RhythmTracker(this.ctx.sampleRate / this.analyser.node.fftSize)
  readonly listener = new LayerListener(this.ctx)
  private volume = this.ctx.createGain()
  /** The music as heard, before the volume control: what recordings take. */
  private recordBus = this.ctx.createGain()
  private source: AudioSource | null = null
  private stemAnalysers: [Stem, StemAnalyser][] = []
  private playing = false

  constructor() {
    this.volume.connect(this.ctx.destination)
  }

  /** A live stream of the music (at full level, whatever the speaker volume), for recording. */
  recordStream(): MediaStream {
    const out = this.ctx.createMediaStreamDestination()
    this.recordBus.connect(out)
    return out.stream
  }

  /** Speaker volume, 0..1. */
  setVolume(v: number) {
    this.volume.gain.setTargetAtTime(Math.max(0, Math.min(1, v)), this.ctx.currentTime, 0.02)
  }

  get features(): AudioFeatures {
    return this.analyser.features
  }

  get current() {
    return this.source
  }

  async useDemo() {
    await this.setSource(new DemoSource(this.ctx))
  }

  async useFile(file: File) {
    await this.setSource(new FileSource(this.ctx, file))
  }

  /** Several files played together, sample-aligned: one per stem. */
  async useStems(files: File[]) {
    await this.setSource(new StemSource(this.ctx, files))
  }

  async useMic() {
    await this.setSource(new MicSource(this.ctx))
  }

  async play() {
    await this.ctx.resume()
    if (this.source && !this.playing) await this.source.start()
    this.playing = true
  }

  /** Whether the current source can be rendered offline (not the mic). */
  get canExport() {
    return !!this.source?.renderOffline
  }

  /** The current source's music in full, and its features at any frame's time (for exports). */
  async offline() {
    const track = await this.source?.renderOffline?.()
    if (!track) throw new Error('This audio source can’t be exported (use the demo, a file or stems).')
    return { track, features: () => new FrameFeatures(track, this.analyser.sensitivity) }
  }

  /** Jump to a sixteenth step of the music (demo and files; live input can't). */
  seek(step: number) {
    this.source?.seek?.(step)
  }

  pause() {
    this.source?.stop()
    this.playing = false
  }

  update(dt: number) {
    const now = this.ctx.currentTime
    const f = this.analyser.update(dt, now)
    this.rhythm.update(f, dt, now, this.source?.score ?? null, this.playing)
    f.stemmed = this.stemAnalysers.length > 0
    if (f.stemmed) for (const [stem, a] of this.stemAnalysers) a.update(f.stems[stem], dt, now)
    else estimateStems(f, dt)
    // The mix heard as layers (kick, snare, hats, bass, lead, pad, fx), for Orchestra.
    f.layers = this.listener.update(dt, now)
    return f
  }

  private sourceListeners = new Set<() => void>()

  /** Call `fn` whenever a new source (song, demo, microphone) is loaded. */
  onSourceChange(fn: () => void) {
    this.sourceListeners.add(fn)
  }

  private async setSource(next: AudioSource) {
    const wasPlaying = this.playing
    this.source?.dispose()
    for (const [, a] of this.stemAnalysers) a.node.disconnect()
    this.playing = false
    this.source = next
    next.output.connect(this.analyser.node)
    this.stemAnalysers = Object.entries(next.stems ?? {}).map(([stem, node]) => {
      const a = new StemAnalyser(this.ctx, stem as Stem)
      node!.connect(a.node)
      return [stem as Stem, a]
    })
    this.listener.connect(next.output)
    if (next.audible) {
      next.output.connect(this.volume)
      next.output.connect(this.recordBus)
    }
    if (wasPlaying || next.kind === 'mic') await this.play()
    this.sourceListeners.forEach((fn) => fn())
  }
}
