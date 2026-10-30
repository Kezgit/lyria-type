import { BAND_COUNT, silentFeatures, type AudioFeatures } from '../features'
import type { Tap } from './tap'

// Turns an AnalyserNode into AudioFeatures once per animation frame.
// Onsets come from spectral flux against an adaptive threshold.

const MIN_DB = -100
const MAX_DB = -20

export class FeatureAnalyser {
  readonly node: AnalyserNode
  /** What it reads: the node, or an OfflineTap on decoded audio (an export). */
  tap: Tap
  readonly features: AudioFeatures = silentFeatures()
  sensitivity = 1

  private freqDb: Float32Array<ArrayBuffer>
  private time: Float32Array<ArrayBuffer>
  private prev: Float32Array
  private bandEdges: number[]
  private bandPeak = new Float32Array(BAND_COUNT).fill(0.05)
  private rmsPeak = 0.05
  private fluxMean = 0
  private fluxPeak = 0.01
  private lastOnset = -1

  constructor(ctx: BaseAudioContext) {
    this.node = this.tap = ctx.createAnalyser()
    this.node.fftSize = 2048
    this.node.smoothingTimeConstant = 0
    const bins = this.node.frequencyBinCount
    this.freqDb = new Float32Array(bins)
    this.time = new Float32Array(this.node.fftSize)
    this.prev = new Float32Array(bins)
    this.features.spectrum = new Float32Array(bins)

    // Log-spaced band edges between 30 Hz and 16 kHz, as bin indices.
    const hzPerBin = ctx.sampleRate / this.node.fftSize
    this.bandEdges = Array.from({ length: BAND_COUNT + 1 }, (_, i) => {
      const hz = 30 * Math.pow(16000 / 30, i / BAND_COUNT)
      return Math.min(bins - 1, Math.max(1, Math.round(hz / hzPerBin)))
    })
  }

  update(dt: number, now: number): AudioFeatures {
    const f = this.features
    const { tap, freqDb, time, prev, bandEdges } = this
    tap.getFloatFrequencyData(freqDb)
    tap.getFloatTimeDomainData(time)

    // Spectrum (0..1) + positive flux.
    let flux = 0
    for (let i = 0; i < freqDb.length; i++) {
      const v = Math.min(1, Math.max(0, (freqDb[i] - MIN_DB) / (MAX_DB - MIN_DB)))
      f.spectrum[i] = v
      const d = v - prev[i]
      if (d > 0) flux += d
      prev[i] = v
    }
    flux /= freqDb.length

    // RMS with slow auto-gain.
    let sum = 0
    for (let i = 0; i < time.length; i++) sum += time[i] * time[i]
    const rms = Math.sqrt(sum / time.length)
    this.rmsPeak = Math.max(rms, this.rmsPeak * Math.pow(0.5, dt / 8), 0.01)
    f.rms = Math.min(1, (rms / this.rmsPeak) * this.sensitivity)
    f.level += (f.rms - f.level) * (1 - Math.exp(-dt * 3))

    // Bands: mean energy, auto-gained per band, fast attack / slower release.
    for (let b = 0; b < BAND_COUNT; b++) {
      let e = 0
      const lo = bandEdges[b]
      const hi = Math.max(lo + 1, bandEdges[b + 1])
      for (let i = lo; i < hi; i++) e += f.spectrum[i]
      e /= hi - lo
      this.bandPeak[b] = Math.max(e, this.bandPeak[b] * Math.pow(0.5, dt / 6), 0.05)
      const target = Math.min(1, Math.pow(e / this.bandPeak[b], 2) * this.sensitivity)
      const rate = target > f.bands[b] ? 30 : 6
      f.bands[b] += (target - f.bands[b]) * (1 - Math.exp(-dt * rate))
    }
    f.sub = f.bands[0]
    f.low = (f.bands[1] + f.bands[2]) / 2
    f.mid = (f.bands[3] + f.bands[4] + f.bands[5]) / 3
    f.high = (f.bands[6] + f.bands[7]) / 2

    // Onsets: flux well above its running mean, with a refractory period.
    this.fluxPeak = Math.max(flux, this.fluxPeak * Math.pow(0.5, dt / 4), 0.002)
    const threshold = this.fluxMean * 1.6 + this.fluxPeak * 0.12 / this.sensitivity
    f.flux = Math.min(1, flux / this.fluxPeak)
    f.onset = flux > threshold && now - this.lastOnset > 0.09
    if (f.onset) {
      f.onsetStrength = Math.min(1, (flux - this.fluxMean) / this.fluxPeak)
      this.lastOnset = now
    }
    f.sinceOnset = this.lastOnset < 0 ? 999 : now - this.lastOnset
    this.fluxMean += (flux - this.fluxMean) * (1 - Math.exp(-dt * 4))
    return f
  }
}
