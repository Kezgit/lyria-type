import type { AudioEngine } from '../audio/audioEngine'
import type { Stem } from '../audio/features'
import type { Engine } from '../engine/engine'

// Each stem's colour as it's drawn on the stage, for the Audio card's meters
// and the notch: the marks the Sequencer tags with their stem, averaged by how
// much of the picture they cover. Modes that don't tag marks fall back to the
// four hues the stems usually take.

/** The Sequencer's stem order (index = BarSpec.stem). */
const ORDER: Stem[] = ['vocals', 'instruments', 'drums', 'bass']
export const SHOWN: Stem[] = ['vocals', 'instruments', 'drums', 'bass']
const FALLBACK: Record<Stem, string> = { vocals: '#3186ff', instruments: '#fc413d', drums: '#fec700', bass: '#00af57' }
const LABEL: Record<Stem, string> = { vocals: 'Vocals', instruments: 'Instruments', drums: 'Drums', bass: 'Bass' }

const toSrgb = (v: number) => Math.round(255 * Math.min(1, Math.max(0, v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055)))
const hex = (r: number, g: number, b: number) => `#${((toSrgb(r) << 16) | (toSrgb(g) << 8) | toSrgb(b)).toString(16).padStart(6, '0')}`

const colours: Record<Stem, string> = { ...FALLBACK }
let lastRead = 0

/** Each stem's colour on the stage now (re-read at most 5 times a second). */
export function stemColours(engine: Engine): Record<Stem, string> {
  const now = performance.now()
  if (now - lastRead < 200) return colours
  lastRead = now
  const bars = engine.bars
  const sum = ORDER.map(() => [0, 0, 0, 0])
  const c: [number, number, number] = [0, 0, 0]
  const n = bars.count
  // A sample of the marks is plenty.
  const step = Math.max(1, Math.floor(n / 1500))
  for (let i = 0; i < n; i += step) {
    const s = bars.stems[i]
    if (s < 0 || s >= ORDER.length) continue
    const o = i * 4
    const w = bars.pos[o + 2] * bars.pos[o + 3] * bars.grad[o + 2]
    if (!(w > 0)) continue
    // The colour across the middle of the mark.
    bars.sampleRow(bars.style[o + 2], (bars.grad[o] + bars.grad[o + 1]) / 2, c)
    const acc = sum[s]
    acc[0] += c[0] * w; acc[1] += c[1] * w; acc[2] += c[2] * w; acc[3] += w
  }
  ORDER.forEach((stem, k) => {
    const [r, g, b, w] = sum[k]
    colours[stem] = w > 0 ? hex(r / w, g / w, b / w) : FALLBACK[stem]
  })
  return colours
}

/** The level and each stem's meter, in its colour on the stage. */
export function buildStemMeters(page: HTMLElement, audio: AudioEngine, engine: Engine, visible: () => boolean) {
  const box = document.createElement('div')
  box.className = 'stem-meters'
  const rows = new Map<Stem | 'level', { row: HTMLElement; bar: HTMLElement }>()
  const add = (id: Stem | 'level', label: string) => {
    const row = document.createElement('div')
    row.className = 'stem-row'
    row.innerHTML = `<i class="stem-dot"></i><span>${label}</span><b class="stem-track"><b class="stem-bar"></b></b>`
    box.appendChild(row)
    rows.set(id, { row, bar: row.querySelector('.stem-bar')! })
  }
  add('level', 'Whole mix')
  for (const stem of SHOWN) add(stem, LABEL[stem])
  const note = document.createElement('p')
  note.className = 'hint'
  page.append(box, note)

  const tick = () => {
    requestAnimationFrame(tick)
    if (!visible()) return
    const f = audio.features
    const cols = stemColours(engine)
    rows.get('level')!.bar.style.width = `${Math.round(Math.min(1, f.level) * 100)}%`
    for (const stem of SHOWN) {
      const { row, bar } = rows.get(stem)!
      row.style.setProperty('--c', cols[stem])
      bar.style.width = `${Math.round(Math.min(1, f.stems[stem].level) * 100)}%`
    }
    note.textContent = f.stemmed ? 'Each part played from its own file.' : 'Parts are estimated from the mix. Load stems to drive each one exactly.'
  }
  tick()
}
