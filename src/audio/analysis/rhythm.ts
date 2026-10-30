import type { AudioFeatures, Voice } from '../features'
import type { Score } from '../sources/types'

// Fills `features.beat` and `features.notes` each frame.
//   score      generated music reports its tempo and every note: exact
//   otherwise  tempo is estimated from the spacing of recent onsets, the
//              clock is nudged onto them, and each onset becomes a guessed
//              note (voice from where its energy sits, pitch from the
//              loudest bin in that voice's range)

const HISTORY = 10 // s of onsets kept for tempo estimation
const MIN_BPM = 70
const MAX_BPM = 180

/** Hz range searched for each guessed voice's pitch. */
const RANGE: Record<Voice, [number, number]> = {
  kick: [40, 120], bass: [40, 250], snare: [150, 400], pad: [200, 1000], lead: [400, 2000], hat: [6000, 12000],
}

const midi = (hz: number) => Math.round(69 + 12 * Math.log2(hz / 440))

export class RhythmTracker {
  private position = 0
  private bpm = 120
  private onsets: number[] = []
  private sinceEstimate = 0

  constructor(private hzPerBin: number) {}

  update(f: AudioFeatures, dt: number, now: number, score: Score | null, playing: boolean) {
    const beat = f.beat
    f.notes.length = 0
    f.score = score?.known ?? null
    const prev = this.position

    const exact = score ? score.position(now) : null
    if (score && exact !== null) {
      beat.exact = true
      this.bpm = score.bpm
      // A file looping back jumps the clock back too; modes watch for that.
      this.position = exact
      score.takeNotes(now, f.notes)
    } else {
      beat.exact = false
      if (playing) this.estimate(f, dt, now)
    }

    beat.bpm = this.bpm
    beat.position = this.position
    beat.ticks = Math.max(0, Math.floor(this.position) - Math.floor(prev))
    beat.bar = (this.position / 16) % 1
  }

  private estimate(f: AudioFeatures, dt: number, now: number) {
    this.position += (dt * this.bpm * 4) / 60
    if (!f.onset) return

    this.onsets.push(now)
    while (this.onsets.length && now - this.onsets[0] > HISTORY) this.onsets.shift()
    this.sinceEstimate += 1
    if (this.sinceEstimate >= 4 && this.onsets.length >= 8) {
      this.sinceEstimate = 0
      this.bpm += (this.tempo() - this.bpm) * 0.5
    }

    // Pull the clock toward the nearest beat (4 steps).
    const beats = this.position / 4
    const err = beats - Math.round(beats)
    if (Math.abs(err) < 0.3) this.position -= err * 4 * 0.25

    f.notes.push(this.guess(f, Math.round(this.position)))
  }

  /** Tempo whose beat best explains the gaps between recent onsets (mild pull toward ~120). */
  private tempo(): number {
    const t = this.onsets
    let best = this.bpm
    let bestScore = -1
    for (let bpm = MIN_BPM; bpm <= MAX_BPM; bpm++) {
      const period = 60 / bpm
      let score = 0
      for (let i = 0; i < t.length; i++) {
        for (let j = i + 1; j < t.length && t[j] - t[i] < 4; j++) {
          const r = (t[j] - t[i]) / period
          const d = r - Math.round(r)
          if (Math.round(r) > 0) score += Math.exp(-(d * d) / 0.01)
        }
      }
      score *= Math.exp(-Math.pow(Math.log2(bpm / 120), 2) * 2)
      if (score > bestScore) {
        bestScore = score
        best = bpm
      }
    }
    return best
  }

  private guess(f: AudioFeatures, step: number) {
    const low = Math.max(f.sub, f.low)
    const voice: Voice =
      f.high > low && f.high > f.mid ? 'hat'
        : low > f.mid ? (f.sub > f.low * 1.2 ? 'kick' : 'bass')
          : f.mid > 0.6 ? 'lead' : f.flux > 0.6 ? 'snare' : 'pad'
    const [lo, hi] = RANGE[voice]
    const a = Math.max(1, Math.round(lo / this.hzPerBin))
    const b = Math.min(f.spectrum.length - 1, Math.round(hi / this.hzPerBin))
    let peak = a
    for (let i = a; i <= b; i++) if (f.spectrum[i] > f.spectrum[peak]) peak = i
    const pitched = voice === 'bass' || voice === 'pad' || voice === 'lead'
    return {
      voice,
      pitch: midi(Math.max(20, peak * this.hzPerBin)),
      velocity: f.onsetStrength,
      length: pitched ? 2 : 1,
      step,
    }
  }
}
