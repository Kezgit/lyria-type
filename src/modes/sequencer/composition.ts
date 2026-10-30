import { STEM_OF, type AudioFeatures, type KnownScore, type NoteEvent, type Stem, type TrackAnalysis } from '../../audio/features'

// The whole track as notes, read once from the analysis (the demo's score, an
// analysed file, loaded stems) — sub-modes generate their picture from this,
// never from the live signal. While it plays, each note's `lit` goes to 1 when
// it sounds and falls back over `hold`; that's all that moves.
// Live input (the mic) has no score, so it has no composition.

export interface CompNote extends NoteEvent {
  stem: Stem
  /** Index in `notes`. */
  index: number
}

export class Composition {
  /** One pass of the music, step order: the loop, or the whole track. */
  notes: CompNote[] = []
  /** Steps after which the notes repeat, or null for a whole track. */
  loop: number | null = null
  /** Steps the composition spans (whole bars). */
  length = 0
  /** Bumps whenever the notes are rebuilt, so sub-modes regenerate. */
  version = 0
  /** Per note: 1 as it sounds, released over `hold`. */
  lit = new Float32Array(0)
  /** Per note: seconds since it last sounded. */
  since = new Float32Array(0)
  /** Where the music is, in composition steps (wrapped for a loop). */
  position = 0
  /** Envelopes, sections, repeats… from the audio; null until the analysis has run. */
  analysis: TrackAnalysis | null = null

  private source: KnownScore | null = null
  private byKey = new Map<string, number>()

  update(audio: AudioFeatures, dt: number, hold: number) {
    if (audio.score !== this.source) this.rebuild(audio.score)
    // The analysis lands after the notes: regenerate when it does.
    const a = audio.score?.analysis ?? null
    if (a !== this.analysis) {
      this.analysis = a
      this.version++
    }
    const L = this.loop
    this.position = L ? ((audio.beat.position % L) + L) % L : audio.beat.position

    const k = Math.exp(-dt / Math.max(0.01, hold))
    for (let i = 0; i < this.lit.length; i++) {
      this.lit[i] *= k
      this.since[i] += dt
    }
    for (const n of audio.notes) {
      const i = this.byKey.get(this.key(n.step, n.voice, n.pitch))
      if (i === undefined) continue
      this.lit[i] = 1
      this.since[i] = 0
    }
  }

  private key(step: number, voice: string, pitch: number) {
    const s = this.loop ? ((step % this.loop) + this.loop) % this.loop : step
    return `${s}:${voice}:${pitch}`
  }

  private rebuild(score: KnownScore | null) {
    this.source = score
    this.loop = score?.loop ?? null
    this.notes = (score?.notes ?? []).map((n, index) => ({ ...n, stem: STEM_OF[n.voice], index }))
    const end = this.notes.reduce((m, n) => Math.max(m, n.step + n.length), 0)
    this.length = this.loop ?? Math.ceil(end / 16) * 16
    this.byKey = new Map(this.notes.map((n) => [this.key(n.step, n.voice, n.pitch), n.index]))
    this.lit = new Float32Array(this.notes.length)
    this.since = new Float32Array(this.notes.length).fill(Infinity)
    this.version++
  }
}
