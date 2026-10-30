import type { AudioFeatures, Stem } from '../features'
import type { OfflineTrack } from '../sources/types'
import { FeatureAnalyser } from './analyser'
import { RhythmTracker } from './rhythm'
import { StemAnalyser, estimateStems } from './stem'
import { OfflineTap } from './tap'

// The audio features at any time of a decoded / rendered track, frame by
// frame, as the live AudioEngine gives them while it plays: the same mix and
// stem analysers reading OfflineTaps, the same rhythm tracker on the track's
// score (or estimating, without one), the stems estimated from the mix when
// there are none. For exports: every frame gets exactly the features of its
// moment, however long it takes to render.

export class FrameFeatures {
  private analyser: FeatureAnalyser
  private mixTap: OfflineTap
  private rhythm: RhythmTracker
  private stems: [Stem, StemAnalyser, OfflineTap][] = []

  constructor(private track: OfflineTrack, sensitivity = 1) {
    // A context only to build the analysers with (they read taps, not nodes).
    const ctx = new OfflineAudioContext(1, 1, track.sampleRate)
    this.analyser = new FeatureAnalyser(ctx)
    this.analyser.sensitivity = sensitivity
    this.mixTap = new OfflineTap(track.mono, track.sampleRate, this.analyser.node.fftSize, true)
    this.analyser.tap = this.mixTap
    this.rhythm = new RhythmTracker(track.sampleRate / this.analyser.node.fftSize)
    for (const [stem, data] of Object.entries(track.stems ?? {}) as [Stem, Float32Array][]) {
      const a = new StemAnalyser(ctx, stem)
      const tap = new OfflineTap(data, track.sampleRate, a.node.fftSize, true)
      a.tap = tap
      this.stems.push([stem, a, tap])
    }
  }

  /** Features at track time `t` (s), `dt` after the last call. */
  at(t: number, dt: number): AudioFeatures {
    this.mixTap.time = t
    const f = this.analyser.update(dt, t)
    this.rhythm.update(f, dt, t, this.track.score ?? null, true)
    f.stemmed = this.stems.length > 0
    if (f.stemmed) for (const [stem, a, tap] of this.stems) { tap.time = t; a.update(f.stems[stem], dt, t) }
    else estimateStems(f, dt)
    return f
  }
}
