import type { AudioFeatures, KnownScore, Voice } from '../../audio/features'

// Where the song is: an intro, a build, the main body, a break, an outro.
// With a known score (the demo, analysed files) it reads ahead bar by bar, so
// the field can wind up before a bigger section arrives; live input falls back
// to loudness trends.

export type StageName = 'Intro' | 'Build' | 'Main' | 'Break' | 'Outro'
export const STAGES: StageName[] = ['Intro', 'Build', 'Main', 'Break', 'Outro']

/** How much each part counts toward a bar's intensity. */
const WEIGHT: Record<Voice, number> = { kick: 1, snare: 0.8, hat: 0.35, bass: 0.8, lead: 0.6, pad: 0.4 }
const LOUD = 0.55

/**
 * Where the song is: its energy now and whether a bigger part is coming.
 * With a known score (demo, analysed files) this reads ahead bar by bar; live
 * input falls back to loudness trends.
 */
export class Stage {
  energy = 0
  /** 0..1: a bigger section is approaching. */
  anticipation = 0
  /** A sudden jump in energy this frame (a drop). */
  drop = false
  name: StageName = 'Intro'
  next: StageName | null = null
  barsToNext = 0

  private known: KnownScore | null = null
  private bars = new Float32Array(0)
  private loopBars = 0
  private fast = 0
  private slow = 0
  private settle = 0
  /** The bar playing now (within the loop). */
  bar = 0

  /** Whether bar `b` begins a stretch called `name` (bars judged mid-bar, as the display does). */
  private starts(b: number, name: StageName) {
    const n = this.bars.length
    const prev = this.loopBars ? (b - 1 + n) % n : b - 1
    return this.classify(b + 0.5) === name && (prev < 0 || this.classify(prev + 0.5) !== name)
  }

  /** The first bar of the next stretch called `name` (after now, wrapping on a loop), or null. */
  findStart(name: StageName): number | null {
    const n = this.bars.length
    if (!n) return null
    const from = Math.floor(this.bar)
    for (let k = 1; k <= n; k++) {
      const b = this.loopBars ? (from + k) % n : from + k
      if (!this.loopBars && b >= n) break
      if (this.starts(b, name)) return b
    }
    // Not ahead (a file near its end): its first stretch from the top.
    for (let b = 0; b < n; b++) if (this.starts(b, name)) return b
    return null
  }

  private read(score: KnownScore | null) {
    this.known = score
    if (!score?.notes.length) {
      this.bars = new Float32Array(0)
      this.labels = []
      return
    }
    const last = score.loop ?? score.notes[score.notes.length - 1].step + 1
    const count = Math.max(1, Math.ceil(last / 16))
    const bars = new Float32Array(count)
    for (const n of score.notes) {
      const b = Math.floor(n.step / 16)
      if (b < count) bars[b] += WEIGHT[n.voice] * n.velocity
    }
    let peak = 0
    for (const v of bars) peak = Math.max(peak, v)
    for (let i = 0; i < count; i++) bars[i] /= peak || 1
    this.bars = bars
    this.loopBars = score.loop ? count : 0
    this.label()
  }

  private at(bar: number) {
    const n = this.bars.length
    if (this.loopBars) bar = ((bar % n) + n) % n
    else if (bar < 0 || bar >= n) return 0
    const i = Math.floor(bar)
    return this.bars[i] + (this.bars[(i + 1) % n] - this.bars[i]) * (bar - i) * (this.loopBars || i + 1 < n ? 1 : 0)
  }

  /** Each bar's stage, labelled once for the whole song (see `label`). */
  private labels: StageName[] = []

  private classify(bar: number): StageName {
    const n = this.labels.length
    if (!n) return 'Intro'
    const b = Math.floor(bar)
    return this.labels[this.loopBars ? ((b % n) + n) % n : Math.max(0, Math.min(n - 1, b))]
  }

  /**
   * Label the song bar by bar, looking at it whole:
   *   main   a sustained loud run (4+ bars), less any quieter bars at its
   *          start (those are still climbing)
   *   build  the rising bars just before a main run
   *   intro    quiet before the first main
   *   break    quieter but still playing, between or after mains
   *   outro    the thinned-out end after the last main
   */
  private label() {
    const d = this.bars
    const n = d.length
    const out: (StageName | null)[] = new Array(n).fill(null)
    const mains: [number, number][] = []
    for (let b = 0; b < n; ) {
      if (d[b] <= LOUD) {
        b++
        continue
      }
      let e = b
      while (e + 1 < n && d[e + 1] > LOUD) e++
      if (e - b + 1 >= 4) {
        const run = [...d.slice(b, e + 1)].sort((x, y) => x - y)
        const median = run[run.length >> 1]
        let s = b
        while (s < e && median - d[s] > 0.12) s++
        mains.push([s, e])
        for (let k = s; k <= e; k++) out[k] = 'Main'
      }
      b = e + 1
    }
    for (const [s] of mains) {
      // Back from a main run while the music is still there (not the near-silent intro).
      const floor = 0.25 * d[s]
      for (let k = s - 1, count = 0; k >= 0 && count < 8 && !out[k] && d[k] >= floor; k--, count++) out[k] = 'Build'
    }
    const first = mains.length ? mains[0][0] : n
    const last = mains.length ? mains[mains.length - 1][1] : -1
    // After the last main run: a break while the music is still really there, the outro once it thins right out.
    const thin = 0.2 * (last >= 0 ? d[last] : 1)
    this.labels = out.map((l, b) => l ?? (b < first ? 'Intro' : b > last && d[b] < thin ? 'Outro' : 'Break'))
  }

  update(audio: AudioFeatures, dt: number) {
    if (audio.score !== this.known) this.read(audio.score)
    let now: number
    let ahead: number
    if (this.bars.length) {
      let bar = audio.beat.position / 16
      if (this.loopBars) bar %= this.loopBars
      this.bar = bar
      now = this.at(bar)
      ahead = (this.at(bar + 1) + this.at(bar + 2) + this.at(bar + 3)) / 3
      this.name = this.classify(bar)
      // The next change of stage within 16 bars.
      this.next = null
      for (let k = 1; k <= 16; k++) {
        const s = this.classify(Math.floor(bar) + k)
        if (s !== this.name) {
          this.next = s
          this.barsToNext = k - (bar % 1)
          break
        }
      }
    } else {
      this.fast += (audio.level - this.fast) * (1 - Math.exp(-dt / 1))
      this.slow += (audio.level - this.slow) * (1 - Math.exp(-dt / 6))
      now = this.fast
      ahead = this.fast + Math.max(0, this.fast - this.slow) * 2
      this.name = ahead - now > 0.15 ? 'Build' : now > LOUD ? 'Main' : this.slow > 0.3 ? 'Break' : 'Intro'
      this.next = null
    }
    const prev = this.energy
    this.energy += (now - this.energy) * (1 - Math.exp(-dt * 1.5))
    this.anticipation += (Math.max(0, Math.min(1, (ahead - now) * 1.6)) - this.anticipation) * (1 - Math.exp(-dt * 2))
    this.settle = Math.max(0, this.settle - dt)
    this.drop = this.settle <= 0 && now - prev > 0.3
    if (this.drop) this.settle = 4
  }
}
