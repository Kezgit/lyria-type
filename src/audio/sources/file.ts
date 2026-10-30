import type { KnownScore, NoteEvent } from '../features'
import { analyseFile, type FileScore } from '../analysis/offline'
import { analyseMix, describe, wholeBars } from '../analysis/track'
import { loopingScore, mono, type AudioSource, type OfflineTrack, type Score } from './types'

// Plays a dropped / chosen audio file on loop through an <audio> element.
// The whole file is analysed once it's loaded (see analysis/offline.ts); from
// then on it reports a score like generated music: tempo, every note ahead,
// and the notes it passes as it plays. Until then rhythm is estimated live.
// Then the four stems are estimated from the mix's spectrum for the
// whole-track analysis (analysis/track.ts), which joins the score last.

export class FileSource implements AudioSource {
  readonly kind = 'file'
  readonly audible = true
  readonly output: MediaElementAudioSourceNode
  readonly element: HTMLAudioElement
  readonly score: Score
  private url: string
  private analysis: FileScore | null = null
  private known?: KnownScore
  private disposed = false
  /** Last `currentTime` reading and the audio time it was read at (media -1: re-read). */
  private anchor = { media: -1, audio: 0 }
  private last = -1
  /** Track time notes were last taken up to (-1: not yet). */
  private taken = -1

  constructor(private ctx: AudioContext, readonly file: File) {
    this.url = URL.createObjectURL(file)
    this.element = new Audio(this.url)
    this.element.loop = true
    this.output = ctx.createMediaElementSource(this.element)

    const self = this
    this.score = {
      get bpm() {
        return self.analysis?.bpm ?? 120
      },
      get known() {
        return self.known
      },
      position: (now) => {
        const a = this.analysis
        if (!a || this.element.paused) {
          this.anchor.media = -1
          return null
        }
        return (this.time(now) - a.offset) / a.sixteenth
      },
      takeNotes: (now, out) => this.take(this.time(now), out),
    }

    const t0 = performance.now()
    analyseFile(ctx, file)
      .then(async (a) => {
        if (this.disposed) return
        this.analysis = a
        const known: KnownScore = { notes: a.notes, loop: null, analysis: null }
        this.known = known
        const ms = Math.round(performance.now() - t0)
        console.log(`[file] ${file.name}: ${a.bpm.toFixed(1)} bpm, ${a.notes.length} notes, ${ms} ms`)

        const t1 = performance.now()
        const steps = wholeBars(a.duration, a.offset, a.sixteenth)
        const analysis = await analyseMix(a.mix, { offset: a.offset, sixteenth: a.sixteenth, steps }, a.notes)
        if (this.disposed) return
        known.analysis = analysis
        console.log(`[file] analysis: ${describe(analysis)}, ${Math.round(performance.now() - t1)} ms`)
      })
      .catch((e) => console.warn(`[file] couldn't analyse ${file.name}; estimating rhythm live`, e))
  }

  async start() {
    await this.element.play()
  }

  stop() {
    this.element.pause()
  }

  seek(step: number) {
    const a = this.analysis
    if (!a) return
    this.element.currentTime = Math.max(0, Math.min(this.element.duration || Infinity, a.offset + step * a.sixteenth))
    this.anchor.media = -1
    this.taken = -1
  }

  dispose() {
    this.disposed = true
    this.stop()
    this.output.disconnect()
    URL.revokeObjectURL(this.url)
  }

  /** The file decoded at the live rate; its score once the analysis has landed (until then rhythm is estimated). */
  async renderOffline(): Promise<OfflineTrack> {
    const buffer = await this.ctx.decodeAudioData(await this.file.arrayBuffer())
    const channels = Array.from({ length: Math.min(2, buffer.numberOfChannels) }, (_, c) => buffer.getChannelData(c))
    const a = this.analysis
    return {
      sampleRate: buffer.sampleRate, duration: buffer.duration, channels, mono: mono(channels),
      score: a ? loopingScore({ ...a, duration: buffer.duration }, this.known) : undefined,
    }
  }

  /** Smooth track time: some browsers update `currentTime` only every few frames. */
  private time(now: number) {
    const el = this.element
    const a = this.anchor
    if (a.media < 0) this.last = -1
    if (a.media < 0 || el.currentTime !== a.media) {
      a.media = el.currentTime
      a.audio = now
    }
    let t = Math.min(a.media + (now - a.audio) * el.playbackRate, el.duration || Infinity)
    // Hold still through small corrections back; a real jump back is a loop or seek.
    if (t < this.last && this.last - t < 0.25) t = this.last
    this.last = t
    return t
  }

  /** Notes whose start passed since the last call; wraps when the file loops. */
  private take(t: number, out: NoteEvent[]) {
    const a = this.analysis
    if (!a) return
    const last = this.taken
    this.taken = t
    // First call: from the top, or (analysis landed mid-play) from here on.
    if (last < 0) return t < 0.25 ? this.emit(-Infinity, t, out) : undefined
    if (t >= last) {
      // A big jump forward is a seek (or a stalled tab): don't flood.
      if (t - last < 1) this.emit(last, t, out)
    } else if (last - t > 0.5) {
      // Looped (or seeked back): finish the end if we were near it, then start over.
      if (a.duration - last < 1) this.emit(last, Infinity, out)
      this.emit(-Infinity, t, out)
    }
  }

  /** Push notes starting in (from, to]. */
  private emit(from: number, to: number, out: NoteEvent[]) {
    const { notes, times } = this.analysis!
    let lo = 0
    let hi = times.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (times[mid] <= from) lo = mid + 1
      else hi = mid
    }
    for (let i = lo; i < times.length && times[i] <= to; i++) out.push({ ...notes[i] })
  }
}
