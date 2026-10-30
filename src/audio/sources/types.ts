// A music source feeds an AudioNode into the analysis graph. Sources that
// should be heard (files, generated music) also connect to the speakers.

import type { KnownScore, NoteEvent, Stem } from '../features'

/** What a source that generates its music knows about it: exact tempo and notes. */
export interface Score {
  bpm: number
  /** Sixteenth steps since the music started at audio time `now`, or null while stopped. */
  position(now: number): number | null
  /** Move notes that have started sounding by `now` into `out`. */
  takeNotes(now: number, out: NoteEvent[]): void
  /** Every note ahead of time, when known (steps match `position`). */
  readonly known?: KnownScore
}

export interface AudioSource {
  readonly kind: string
  readonly output: AudioNode
  /** Whether the engine should route this source to the speakers. */
  readonly audible: boolean
  /** Present when the source knows what it's playing; otherwise rhythm is estimated. */
  readonly score?: Score
  /** Separate outputs per stem, when the source has them (they also sum into `output`). */
  readonly stems?: Partial<Record<Stem, AudioNode>>
  start(): Promise<void> | void
  stop(): void
  /** Jump to a sixteenth step of the music, when the source can. */
  seek?(step: number): void
  dispose(): void
  /** The music decoded or rendered, for an export (absent: can't be exported, e.g. the mic). */
  renderOffline?(): Promise<OfflineTrack>
}

/**
 * A source's music in full, at the live context's sample rate, for rendering
 * frame by frame. Time 0 is where playback starts; past `duration` it wraps
 * (sources loop).
 */
export interface OfflineTrack {
  sampleRate: number
  /** One pass, s. */
  duration: number
  /** What's heard (one or two channels), with the source's own output gain. */
  channels: Float32Array[]
  /** What the mix analyser hears: the output downmixed to mono. */
  mono: Float32Array
  /** What each stem analyser hears (mono), when the source has stems. */
  stems?: Partial<Record<Stem, Float32Array>>
  /** As `score`, with `now` = export time (s); a fresh one per export. */
  score?: Score
}

/** Downmix channels to mono, as an AnalyserNode hears them (speakers: the mean). */
export function mono(channels: Float32Array[], gain = 1): Float32Array {
  const out = new Float32Array(channels[0]?.length ?? 0)
  for (const c of channels) for (let i = 0; i < out.length; i++) out[i] += c[i]
  const k = gain / Math.max(1, channels.length)
  for (let i = 0; i < out.length; i++) out[i] *= k
  return out
}

/**
 * A score over a looping, analysed track (files, stems): steps from the grid,
 * and the notes whose start the clock passed since the last call, wrapping at
 * `duration`. `now` is export time.
 */
export function loopingScore(a: { bpm: number; offset: number; sixteenth: number; duration: number; notes: NoteEvent[]; times: Float64Array }, known: KnownScore | undefined): Score {
  let last = -1
  const emit = (from: number, to: number, out: NoteEvent[]) => {
    for (let i = 0; i < a.times.length; i++) if (a.times[i] > from && a.times[i] <= to) out.push({ ...a.notes[i] })
  }
  const local = (now: number) => ((now % a.duration) + a.duration) % a.duration
  return {
    bpm: a.bpm,
    known,
    position: (now) => (local(now) - a.offset) / a.sixteenth,
    takeNotes: (now, out) => {
      const t = local(now)
      if (last < 0) emit(-Infinity, t, out)
      else if (t >= last) emit(last, t, out)
      else { emit(last, Infinity, out); emit(-Infinity, t, out) }
      last = t
    },
  }
}
