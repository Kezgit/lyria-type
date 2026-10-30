import { BAND_COUNT, type AudioFeatures, type Stem } from '../../audio/features'
import type { ShapedText } from '../../text/shaping'

// The music lighting the letters: per glyph / word / line, an envelope 0..1.
//   hits      as Haze: each onset kicks a `density` share of units at random,
//             and each unit also answers one spectrum band above its own
//             threshold (`spectrum`); `attack` / `release` smooth it
//   karaoke   a playhead reads the text in order over `bars` bars: the unit
//             under it lights, and fades behind it over `release`
//   stems     each unit follows its part's live level (its stem's envelope)
//   level     everything follows the overall loudness
//   none      all lit (1)

const rand = (a: number, b: number) => a + Math.random() * (b - a)

export class Units {
  /** Unit per glyph index. */
  of = new Int32Array(0)
  count = 0
  env = new Float32Array(0)
  private kick = new Float32Array(0)
  private band = new Int32Array(0)
  private threshold = new Float32Array(0)
  private key = ''

  /** Re-cut the units when the text or the grouping changes. */
  sync(text: ShapedText, grouping: string) {
    const k = `${text.glyphs.length}:${text.wordCount}:${text.lines.length}:${grouping}`
    if (k === this.key) return
    this.key = k
    const n = grouping === 'word' ? text.wordCount : grouping === 'line' ? text.lines.length : text.glyphs.length
    this.count = Math.max(1, n)
    this.of = new Int32Array(text.glyphs.length)
    for (const g of text.glyphs) this.of[g.index] = grouping === 'word' ? g.word : grouping === 'line' ? g.line : g.index
    this.env = new Float32Array(this.count)
    this.kick = new Float32Array(this.count)
    this.band = Int32Array.from({ length: this.count }, (_, u) => Math.min(BAND_COUNT - 1, Math.floor((u / this.count) * BAND_COUNT)))
    this.threshold = Float32Array.from({ length: this.count }, () => rand(0.7, 0.98))
  }

  /** Advance the envelopes. `stemOf(u)`: the part a unit belongs to (stems mode). */
  update(audio: AudioFeatures, dt: number, p: Record<string, any>, stemOf: (u: number) => Stem) {
    const { env, kick, count } = this
    const attackK = 1 - Math.exp(-dt / Math.max(0.005, p.attack))
    const releaseK = Math.exp(-dt / Math.max(0.02, p.release))
    const fallK = 1 - Math.exp(-dt / 0.12)
    if (p.react === 'none') return env.fill(1)

    if (p.react === 'hits' && audio.onset) {
      const n = Math.ceil(count * p.density * (0.35 + 0.65 * audio.onsetStrength))
      for (let i = 0; i < n; i++) {
        const u = (Math.random() * count) | 0
        kick[u] = Math.max(kick[u], 0.6 + 0.4 * audio.onsetStrength)
      }
    }
    // Karaoke: the unit under the reading playhead.
    const len = Math.max(1, Math.round(p.bars)) * 16
    const at = ((((audio.beat.position % len) + len) % len) / len) * count
    for (let u = 0; u < count; u++) {
      kick[u] *= releaseK
      let target = 0
      if (p.react === 'hits') target = Math.max(kick[u], Math.max(0, (audio.bands[this.band[u]] - this.threshold[u]) / (1 - this.threshold[u])) * p.spectrum)
      else if (p.react === 'karaoke') {
        if (Math.floor(at) === u) kick[u] = 1
        target = kick[u]
      } else if (p.react === 'stems') target = Math.min(1, audio.stems[stemOf(u)].level * 1.6)
      else target = Math.min(1, audio.level * 1.6)
      // (hits and karaoke decay through `kick`, over `release`)
      env[u] += (Math.min(1, target) - env[u]) * (target > env[u] ? attackK : fallK)
    }
  }
}
