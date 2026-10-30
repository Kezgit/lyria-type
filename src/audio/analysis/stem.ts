import type { AudioFeatures, Stem, StemFeatures } from '../features'
import type { Tap } from './tap'

// Features for one separate stem: loudness, onsets, brightness and, for the
// melodic stems, the pitch of its main tone (YIN on the decimated waveform;
// bass gets a longer window so its lowest notes fit).
// For a plain mix there are no stems to listen to, so `estimateStems` fills
// them in from the mix's bands and notes.

const MIN_DB = -100
const MAX_DB = -20

/** Hz range searched for each stem's pitch; null = unpitched. */
const PITCH_RANGE: Record<Stem, [number, number] | null> = {
  vocals: [80, 1000], bass: [35, 300], instruments: [100, 1200], drums: null,
}

const midi = (hz: number) => 69 + 12 * Math.log2(hz / 440)

export class StemAnalyser {
  readonly node: AnalyserNode
  /** What it reads: the node, or an OfflineTap on decoded audio (an export). */
  tap: Tap
  private freqDb: Float32Array<ArrayBuffer>
  private time: Float32Array<ArrayBuffer>
  private prev: Float32Array
  private half: Float32Array
  private diff: Float32Array
  private hzPerBin: number
  private rate: number
  private decim: number
  private range: [number, number] | null
  private rmsPeak = 0.02
  private fluxMean = 0
  private fluxPeak = 0.01
  private lastOnset = -1

  constructor(ctx: BaseAudioContext, stem: Stem) {
    this.node = this.tap = ctx.createAnalyser()
    this.node.fftSize = stem === 'bass' ? 4096 : 2048
    this.node.smoothingTimeConstant = 0
    this.decim = stem === 'bass' ? 4 : 2
    const bins = this.node.frequencyBinCount
    this.freqDb = new Float32Array(bins)
    this.time = new Float32Array(this.node.fftSize)
    this.prev = new Float32Array(bins)
    this.half = new Float32Array(this.node.fftSize / this.decim)
    this.diff = new Float32Array(this.half.length)
    this.hzPerBin = ctx.sampleRate / this.node.fftSize
    this.rate = ctx.sampleRate / this.decim
    this.range = PITCH_RANGE[stem]
  }

  update(f: StemFeatures, dt: number, now: number) {
    const { tap, freqDb, time, prev } = this
    tap.getFloatFrequencyData(freqDb)
    tap.getFloatTimeDomainData(time)

    // Flux and centroid from the spectrum.
    let flux = 0, sum = 0, weighted = 0
    for (let i = 1; i < freqDb.length; i++) {
      const v = Math.min(1, Math.max(0, (freqDb[i] - MIN_DB) / (MAX_DB - MIN_DB)))
      const d = v - prev[i]
      if (d > 0) flux += d
      prev[i] = v
      sum += v
      weighted += v * Math.log2((i * this.hzPerBin) / 100)
    }
    flux /= freqDb.length
    // Centroid between 100 Hz and ~8 kHz (log2(80) ≈ 6.3 octaves).
    const centroid = sum > 1e-3 ? weighted / sum / 6.3 : 0
    f.brightness += (Math.min(1, Math.max(0, centroid)) - f.brightness) * (1 - Math.exp(-dt * 8))

    // Loudness with slow auto-gain; a silent stem stays at 0.
    let e = 0
    for (let i = 0; i < time.length; i++) e += time[i] * time[i]
    const rms = Math.sqrt(e / time.length)
    this.rmsPeak = Math.max(rms, this.rmsPeak * Math.pow(0.5, dt / 8), 0.02)
    f.rms = rms < 1e-4 ? 0 : Math.min(1, rms / this.rmsPeak)
    f.level += (f.rms - f.level) * (1 - Math.exp(-dt * 3))

    // Onsets: flux well above its running mean, with a refractory period.
    this.fluxPeak = Math.max(flux, this.fluxPeak * Math.pow(0.5, dt / 4), 0.002)
    const threshold = this.fluxMean * 1.6 + this.fluxPeak * 0.15
    f.onset = flux > threshold && now - this.lastOnset > 0.08 && f.rms > 0.05
    if (f.onset) {
      f.onsetStrength = Math.min(1, (flux - this.fluxMean) / this.fluxPeak)
      this.lastOnset = now
    }
    this.fluxMean += (flux - this.fluxMean) * (1 - Math.exp(-dt * 4))

    if (this.range && f.rms > 0.05) this.pitch(f, dt)
    else f.clarity += (0 - f.clarity) * (1 - Math.exp(-dt * 10))
  }

  /** YIN: the lag where the waveform best repeats itself. */
  private pitch(f: StemFeatures, dt: number) {
    const { time, half, diff, rate, decim } = this
    for (let i = 0; i < half.length; i++) {
      let v = 0
      for (let k = 0; k < decim; k++) v += time[decim * i + k]
      half[i] = v / decim
    }
    const [lo, hi] = this.range!
    const tMin = Math.max(2, Math.floor(rate / hi))
    const tMax = Math.min(half.length >> 1, Math.ceil(rate / lo))
    const W = half.length - tMax
    let running = 0
    let best = -1
    for (let tau = 1; tau <= tMax; tau++) {
      let d = 0
      for (let j = 0; j < W; j++) {
        const x = half[j] - half[j + tau]
        d += x * x
      }
      running += d
      diff[tau] = running > 0 ? (d * tau) / running : 1
      if (best < 0 && tau > tMin && diff[tau - 1] < 0.2 && diff[tau - 1] <= diff[tau] && diff[tau - 1] <= diff[tau - 2]) best = tau - 1
    }
    const clarity = best > 0 ? Math.max(0, 1 - diff[best]) : 0
    f.clarity += (clarity - f.clarity) * (1 - Math.exp(-dt * 12))
    if (best <= 0) return
    // Parabolic refinement around the dip.
    const a = diff[best - 1], b = diff[best], c = diff[best + 1]
    const shift = (a - c) / (2 * (a - 2 * b + c) || 1)
    const hz = rate / (best + Math.max(-0.5, Math.min(0.5, shift)))
    const m = midi(hz)
    // Glide over small changes, jump on new notes.
    f.pitch = Math.abs(m - f.pitch) > 1.5 ? m : f.pitch + (m - f.pitch) * (1 - Math.exp(-dt * 20))
  }
}

/** For a plain mix: stems from where the energy sits, pitch from the notes heard. */
export function estimateStems(f: AudioFeatures, dt: number) {
  const s = f.stems
  const b = f.bands
  const set = (st: StemFeatures, rms: number) => {
    st.rms = Math.min(1, rms)
    st.level += (st.rms - st.level) * (1 - Math.exp(-dt * 3))
  }
  set(s.drums, Math.max(f.flux, f.high * 0.8))
  set(s.bass, (f.sub + f.low) / 2)
  set(s.vocals, (b[4] + b[5]) / 2)
  set(s.instruments, (b[3] + b[6]) / 2)
  for (const st of Object.values(s)) {
    st.onset = false
    st.clarity = 0
  }
  s.drums.onset = f.onset
  s.drums.onsetStrength = f.onsetStrength
  for (const n of f.notes) {
    const st = n.voice === 'lead' ? s.vocals : n.voice === 'bass' ? s.bass : n.voice === 'pad' ? s.instruments : null
    if (!st) continue
    st.pitch = n.pitch
    st.onset = true
    st.onsetStrength = n.velocity
  }
}
