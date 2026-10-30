// What the analysers read from an AnalyserNode, so they can read the same from
// decoded audio at any time instead (an export renders frame by frame, not in
// real time). OfflineTap reproduces the Web Audio spec's analyser with
// smoothingTimeConstant 0, as the analysers use it: the last fftSize samples
// before `time`, and their spectrum through a Blackman window, magnitude / N,
// in dB.

export interface Tap {
  readonly fftSize: number
  readonly frequencyBinCount: number
  getFloatFrequencyData(out: Float32Array): void
  getFloatTimeDomainData(out: Float32Array): void
}

export class OfflineTap implements Tap {
  readonly frequencyBinCount: number
  /** Seconds into `data` the analyser is listening at (wraps when `loops`). */
  time = 0
  private window: Float32Array
  private re: Float32Array
  private im: Float32Array
  private rev: Uint32Array
  private cos: Float32Array
  private sin: Float32Array

  constructor(private data: Float32Array, private sampleRate: number, readonly fftSize: number, private loops: boolean) {
    const N = fftSize
    this.frequencyBinCount = N / 2
    this.window = Float32Array.from({ length: N }, (_, n) => 0.42 - 0.5 * Math.cos((2 * Math.PI * n) / N) + 0.08 * Math.cos((4 * Math.PI * n) / N))
    this.re = new Float32Array(N)
    this.im = new Float32Array(N)
    const bits = Math.log2(N)
    this.rev = Uint32Array.from({ length: N }, (_, i) => {
      let r = 0
      for (let b = 0; b < bits; b++) r = (r << 1) | ((i >> b) & 1)
      return r
    })
    this.cos = Float32Array.from({ length: N / 2 }, (_, k) => Math.cos((2 * Math.PI * k) / N))
    this.sin = Float32Array.from({ length: N / 2 }, (_, k) => -Math.sin((2 * Math.PI * k) / N))
  }

  /** Sample `i` of the source: wrapped when looping, silence outside otherwise. */
  private at(i: number) {
    const n = this.data.length
    if (this.loops) return this.data[((i % n) + n) % n]
    return i >= 0 && i < n ? this.data[i] : 0
  }

  getFloatTimeDomainData(out: Float32Array) {
    const end = Math.round(this.time * this.sampleRate)
    for (let i = 0; i < out.length; i++) out[i] = this.at(end - out.length + i)
  }

  getFloatFrequencyData(out: Float32Array) {
    const { fftSize: N, re, im, rev, window } = this
    const end = Math.round(this.time * this.sampleRate)
    for (let i = 0; i < N; i++) {
      re[rev[i]] = this.at(end - N + i) * window[i]
      im[rev[i]] = 0
    }
    // Iterative radix-2 FFT.
    for (let size = 2; size <= N; size <<= 1) {
      const half = size >> 1, step = N / size
      for (let start = 0; start < N; start += size) {
        for (let k = 0; k < half; k++) {
          const c = this.cos[k * step], s = this.sin[k * step]
          const a = start + k, b = a + half
          const tr = re[b] * c - im[b] * s, ti = re[b] * s + im[b] * c
          re[b] = re[a] - tr; im[b] = im[a] - ti
          re[a] += tr; im[a] += ti
        }
      }
    }
    const n = Math.min(out.length, this.frequencyBinCount)
    for (let k = 0; k < n; k++) out[k] = 20 * Math.log10(Math.hypot(re[k], im[k]) / N)
  }
}
