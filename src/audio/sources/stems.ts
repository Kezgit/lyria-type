import { STEMS, type KnownScore, type NoteEvent, type Stem } from '../features'
import { analyse, type FileScore } from '../analysis/offline'
import { onGrid, stemNotes } from '../analysis/stemNotes'
import { analyseStems, describe, wholeBars } from '../analysis/track'
import { loopingScore, mono, type AudioSource, type OfflineTrack, type Score } from './types'

// Several files played together as the stems of one track (e.g. a generator's
// stem export, or a split made with Demucs). Each file is assigned a stem by
// its name (vocals / drums / bass / anything else = instruments), decoded and
// started on the same audio-clock instant, so they stay sample-aligned and
// loop together. Each stem plays into its own bus, which the engine analyses
// separately.
// Once decoded, the set is analysed offline on one grid: tempo from the drums
// (or the mix if there are none), notes from each stem on its own (see
// stemNotes.ts), then the bar phase settled so kicks land on 1 and 3 and
// snares on 2 and 4. The score then knows every part ahead like the demo.
// Last, each stem's envelope, sections and repeats (analysis/track.ts) join
// the score as `analysis`.
// A full mix dropped along with its stems (a whole stem folder) is left out:
// it would double everything.

const NAMES: [Stem, RegExp][] = [
  // "other" first: e.g. other-gatebass is an instrument, not the bass.
  ['instruments', /other/i],
  ['vocals', /vocal|vox|voice|sing|lead.?vox/i],
  ['drums', /drum|perc|beat|kit/i],
  ['bass', /bass|sub/i],
  ['instruments', /other|inst|keys|piano|synth|guitar|music|melod|chord|pad|string/i],
]

/** A full mix rather than a stem, by its name (fullmix, mix, master, mixdown). */
const MIX = /(^|[^a-z])(full.?mix|mix|mixdown|master)([^a-z]|$)/i

export function isMix(name: string) {
  return MIX.test(name)
}

/** Which stem a file is, by its name; null if the name doesn't say. */
export function stemOf(name: string): Stem | null {
  for (const [stem, re] of NAMES) if (re.test(name)) return stem
  return null
}

export class StemSource implements AudioSource {
  readonly kind = 'stems'
  readonly audible = true
  readonly output: GainNode
  readonly stems: Partial<Record<Stem, GainNode>> = {}
  readonly score: Score
  /** Which file went to which stem, for the panel. */
  readonly assigned: { name: string; stem: Stem }[] = []
  private buffers: { stem: Stem; buffer: AudioBuffer }[] = []
  private ready: Promise<void>
  private playing: AudioBufferSourceNode[] = []
  private duration = 0
  /** Audio time at which track time 0 played (valid while running). */
  private startedAt = 0
  /** Track time to resume from. */
  private resume = 0
  private running = false
  private disposed = false
  private analysis: FileScore | null = null
  private known?: KnownScore
  private taken = -1

  constructor(private ctx: AudioContext, files: File[]) {
    this.output = ctx.createGain()
    this.output.gain.value = 0.8

    // Full mixes out (unless that's all there is).
    const stemsOnly = files.filter((f) => !isMix(f.name))
    if (stemsOnly.length && stemsOnly.length < files.length) {
      for (const f of files) if (isMix(f.name)) console.log(`[stems] skipped ${f.name} (a full mix)`)
      files = stemsOnly
    }

    // Names first; files whose names don't say fill the stems still missing.
    const free = [...STEMS]
    const named = files.map((f) => stemOf(f.name))
    for (const s of named) {
      const i = s ? free.indexOf(s) : -1
      if (i >= 0) free.splice(i, 1)
    }
    files.forEach((f, i) => {
      const stem = named[i] ?? free.shift() ?? 'instruments'
      this.assigned.push({ name: f.name, stem })
      if (!this.stems[stem]) {
        const g = ctx.createGain()
        g.connect(this.output)
        this.stems[stem] = g
      }
    })

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
        if (!a || !this.running) return null
        return (this.time(now) - a.offset) / a.sixteenth
      },
      takeNotes: (now, out) => this.take(this.time(now), out),
    }

    this.ready = this.load(files)
  }

  private async load(files: File[]) {
    const decoded = await Promise.all(files.map(async (f) => this.ctx.decodeAudioData(await f.arrayBuffer())))
    // Pad shorter files with silence so every stem loops on the same length.
    const length = Math.max(...decoded.map((b) => b.length))
    this.buffers = decoded.map((b, i) => {
      let buffer = b
      if (b.length < length) {
        buffer = this.ctx.createBuffer(b.numberOfChannels, length, b.sampleRate)
        for (let c = 0; c < b.numberOfChannels; c++) buffer.copyToChannel(b.getChannelData(c), c)
      }
      return { stem: this.assigned[i].stem, buffer }
    })
    this.duration = length / decoded[0].sampleRate
    console.log(`[stems] ${this.assigned.map((a) => `${a.name} → ${a.stem}`).join(', ')}`)
    // Analysis runs in the background; playback doesn't wait for it.
    this.analyseAll().catch((e) => console.warn('[stems] analysis failed; estimating rhythm live', e))
  }

  /** The stems as they sum on each bus, and the mix out of the output; the score once analysed. */
  async renderOffline(): Promise<OfflineTrack> {
    await this.ready
    const length = Math.max(0, ...this.buffers.map((b) => b.buffer.length))
    const rate = this.buffers[0]?.buffer.sampleRate ?? this.ctx.sampleRate
    const wide = this.buffers.some((b) => b.buffer.numberOfChannels > 1) ? 2 : 1
    const out = Array.from({ length: wide }, () => new Float32Array(length))
    const buses: Partial<Record<Stem, Float32Array[]>> = {}
    for (const { stem, buffer } of this.buffers) {
      const bus = (buses[stem] ??= Array.from({ length: wide }, () => new Float32Array(length)))
      for (let c = 0; c < wide; c++) {
        const src = buffer.getChannelData(Math.min(c, buffer.numberOfChannels - 1))
        for (let i = 0; i < src.length; i++) bus[c][i] += src[i]
      }
    }
    const stems: Partial<Record<Stem, Float32Array>> = {}
    for (const [stem, bus] of Object.entries(buses) as [Stem, Float32Array[]][]) {
      stems[stem] = mono(bus)
      for (let c = 0; c < wide; c++) for (let i = 0; i < length; i++) out[c][i] += bus[c][i] * this.output.gain.value
    }
    const a = this.analysis
    return {
      sampleRate: rate, duration: this.duration, channels: out, mono: mono(out), stems,
      score: a ? loopingScore({ ...a, duration: this.duration }, this.known) : undefined,
    }
  }

  async start() {
    await this.ready
    if (this.running || this.disposed) return
    const t0 = this.ctx.currentTime + 0.05
    this.startedAt = t0 - this.resume
    for (const { stem, buffer } of this.buffers) {
      const src = this.ctx.createBufferSource()
      src.buffer = buffer
      src.loop = true
      src.connect(this.stems[stem]!)
      src.start(t0, this.resume % buffer.duration)
      this.playing.push(src)
    }
    this.running = true
    this.taken = -1
  }

  stop() {
    if (this.running) this.resume = this.time(this.ctx.currentTime)
    for (const s of this.playing) s.stop()
    this.playing = []
    this.running = false
  }

  dispose() {
    this.disposed = true
    this.stop()
    this.output.disconnect()
  }

  /** Track time now, wrapped to the loop. */
  private time(now: number) {
    if (!this.running || !this.duration) return this.resume
    const t = (now - this.startedAt) % this.duration
    return t < 0 ? t + this.duration : t
  }

  private async analyseAll() {
    const t0 = performance.now()
    const mono = (b: AudioBuffer) => {
      const out = new Float32Array(Math.round(this.duration * b.sampleRate))
      for (let c = 0; c < b.numberOfChannels; c++) {
        const d = b.getChannelData(c)
        for (let i = 0; i < d.length; i++) out[i] += d[i] / b.numberOfChannels
      }
      return out
    }
    const byStem = new Map<Stem, Float32Array>()
    let rate = this.ctx.sampleRate
    for (const { stem, buffer } of this.buffers) {
      const m = mono(buffer)
      rate = buffer.sampleRate
      const sum = byStem.get(stem)
      if (sum) for (let i = 0; i < Math.min(sum.length, m.length); i++) sum[i] += m[i]
      else byStem.set(stem, m)
    }

    // The grid: from the drums if there are any, otherwise from everything.
    let grid: FileScore
    const drums = byStem.get('drums')
    if (drums) grid = await analyse(drums, rate)
    else {
      const mix = new Float32Array(Math.round(this.duration * rate))
      for (const m of byStem.values()) for (let i = 0; i < Math.min(mix.length, m.length); i++) mix[i] += m[i]
      grid = await analyse(mix, rate)
    }
    if (this.disposed) return

    // Each stem's own notes, onto the shared grid.
    let notes: { note: NoteEvent; time: number }[] = []
    for (const [stem, samples] of byStem) {
      const own = await stemNotes(samples, rate, stem, grid.sixteenth * 4)
      if (this.disposed) return
      notes.push(...onGrid(own, grid.offset, grid.sixteenth))
    }

    // Bar phase: the beat shift that puts most kicks on 1/3 and snares on 2/4.
    let best = 0
    let bestScore = -1
    for (const shift of [0, 4, 8, 12]) {
      let score = 0
      for (const { note } of notes) {
        const s16 = (((note.step - shift) % 16) + 16) % 16
        if (note.voice === 'kick' && (s16 === 0 || s16 === 8)) score += s16 === 0 ? 2 : 1
        if (note.voice === 'snare' && (s16 === 4 || s16 === 12)) score += 1
      }
      if (score > bestScore) {
        bestScore = score
        best = shift
      }
    }
    if (best) {
      // Move bar 1 back to the bar start before the old one, so steps stay >= 0.
      const back = 16 - best
      grid = { ...grid, offset: grid.offset - back * grid.sixteenth }
      notes = notes.map(({ note, time }) => ({ note: { ...note, step: note.step + back }, time }))
    }
    notes.sort((a, b) => a.note.step - b.note.step)
    this.analysis = { ...grid, notes: notes.map((n) => n.note), times: Float64Array.from(notes.map((n) => n.time)) }
    const known: KnownScore = { notes: this.analysis.notes, loop: null, analysis: null }
    this.known = known
    this.taken = -1
    console.log(`[stems] ${grid.bpm.toFixed(1)} bpm, ${notes.length} notes, ${Math.round(performance.now() - t0)} ms`)

    // Envelopes, sections and repeats, on the same grid; joins the score when done.
    const t1 = performance.now()
    const steps = wholeBars(this.duration, grid.offset, grid.sixteenth)
    const analysis = await analyseStems(Object.fromEntries(byStem), rate, { offset: grid.offset, sixteenth: grid.sixteenth, steps }, known.notes)
    if (this.disposed) return
    known.analysis = analysis
    console.log(`[stems] analysis: ${describe(analysis)}, ${Math.round(performance.now() - t1)} ms`)
  }

  /** Notes whose start passed since the last call; wraps when the track loops. */
  private take(t: number, out: NoteEvent[]) {
    const a = this.analysis
    if (!a || !this.running) return
    const last = this.taken
    this.taken = t
    if (last < 0) return
    if (t >= last) {
      if (t - last < 1) this.emit(last, t, out)
    } else {
      this.emit(last, Infinity, out)
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
