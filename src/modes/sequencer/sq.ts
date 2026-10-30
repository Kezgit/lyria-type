import type { BarSpec } from '../../engine/barLayer'
import type { CompNote, Composition } from './composition'
import type { SubMode, SubInstance } from './index'
import { ORDER } from './barcode'

// SQ: the music as a printed sequence of blue marks, after the SQ reference.
// Two systems on a pale page, six rows each; every note becomes marks in its
// part's row:
//   hats    clusters of thin ticks (a barcode), now and then a pale green one
//   snare   a pair of dark ticks
//   kick    a near-black block
//   bass    a deep blue block as long as the note
//   chords  pale blue blocks, one per chord note, overlapping
//   lead    a mid blue block placed by pitch across the top two rows
// Blocks carry fine vertical striations; everything is soft-edged with a
// faint blurred halo and printed in multiply, so overlaps darken.
// The page is generated once from the composition (same music, same page);
// playback only deepens and lifts the marks of the notes sounding.

/** Google ramps, light to dark: 50, 200, 500, 800, 1200 (grey: its own steps). */
const BLUE = ['#bbe2ff', '#76bbff', '#3186ff', '#2051da', '#0f173a']
const GREY = ['#e6eaf0', '#c4c7c5', '#45474d', '#2f3034', '#121317']
const GREEN = ['#bff3b9', '#60d673', '#00af57', '#008052', '#002220']
const ROW = { blue: 0, grey: 1, green: 2 }

/** Rows per system, top to bottom: lead (the top two, by pitch), hats, chords, snare and bass, kick. */
const ROWS = 6
const LEAD_PITCH: [number, number] = [58, 80]
const PAD_PITCH: [number, number] = [55, 80]

/** 0..1 hash so every choice repeats with the music. */
const hash = (a: number, b: number) => {
  const x = Math.sin(a * 127.1 + b * 311.7) * 43758.5453
  return x - Math.floor(x)
}
const norm = (v: number, [lo, hi]: [number, number]) => Math.min(1, Math.max(0, (v - lo) / (hi - lo)))

interface Mark {
  spec: BarSpec
  /** Note it belongs to, or -1 for page furniture. */
  note: number
}

const params = {
  systems: { type: 'number', value: 2, min: 1, max: 6, step: 1 },
  bars: { type: 'number', value: 4, min: 1, max: 16, step: 1, label: 'bars per system' },
  margin: { type: 'number', value: 0.07, min: 0, max: 0.3, step: 0.005 },
  gap: { type: 'number', value: 0.3, min: 0, max: 1.5, step: 0.01, label: 'system gap' },
  rowGap: { type: 'number', value: 0.18, min: 0, max: 0.8, step: 0.01, label: 'row gap' },

  tick: { type: 'number', value: 0.2, min: 0.05, max: 0.8, step: 0.01, label: 'tick width (steps)' },
  cluster: { type: 'number', value: 0.6, min: 0, max: 1, step: 0.01, label: 'hat clusters' },
  gate: { type: 'number', value: 0.9, min: 0.2, max: 1, step: 0.01, label: 'block length' },
  jitter: { type: 'number', value: 0.12, min: 0, max: 0.5, step: 0.01, label: 'row jitter' },
  accent: { type: 'number', value: 0.08, min: 0, max: 0.5, step: 0.01, label: 'green accents' },

  ink: { type: 'number', value: 0.88, min: 0.1, max: 1, step: 0.01, label: 'ink' },
  soft: { type: 'number', value: 1.6, min: 0, max: 12, step: 0.1, label: 'edge softness (px)' },
  halo: { type: 'number', value: 0.3, min: 0, max: 1, step: 0.01, label: 'blur halo' },
  striation: { type: 'number', value: 0.22, min: 0, max: 1, step: 0.01 },
  grain: { type: 'number', value: 0.05, min: 0, max: 0.3, step: 0.005 },
  rule: { type: 'number', value: 0.35, min: 0, max: 1, step: 0.01, label: 'system rule' },

  lift: { type: 'number', value: 0.35, min: 0, max: 1, step: 0.01, label: 'playing: deepen' },
  pop: { type: 'number', value: 0.2, min: 0, max: 1, step: 0.01, label: 'playing: grow' },
} as const

const groups = {
  Page: ['systems', 'bars', 'margin', 'gap', 'rowGap'],
  Marks: ['tick', 'cluster', 'gate', 'jitter', 'accent'],
  Ink: ['ink', 'soft', 'halo', 'striation', 'grain', 'rule'],
  Playing: ['lift', 'pop'],
}

/** Every mark on one page: steps [from, from + span) of the composition. */
function generate(comp: Composition, from: number, span: number, p: Record<string, any>, W: number, H: number): Mark[] {
  const marks: Mark[] = []
  const systems = Math.max(1, Math.round(p.systems))
  const perSystem = Math.max(1, Math.round(p.bars)) * 16
  const m = p.margin * Math.min(W, H)
  const left = -W / 2 + m, top = H / 2 - m
  const aw = W - 2 * m, ah = H - 2 * m
  const sysH = ah / (systems + (systems - 1) * p.gap)
  const sysPitch = sysH * (1 + p.gap)
  const stepW = aw / perSystem
  const rowPitch = sysH / ROWS
  const rowH = rowPitch * (1 - p.rowGap)

  // System rules: a dotted line in each gap, like the reference's line of tiny type.
  if (p.rule > 0) {
    for (let s = 0; s < systems - 1; s++) {
      const y = top - s * sysPitch - sysH - (sysPitch - sysH) / 2
      for (let x = left; x < left + aw; x += 7) {
        marks.push({ note: -1, spec: { x, y, w: 3 + 2 * hash(x, s), h: 1.2, t0: 0.3, t1: 0.3, row: ROW.grey, alpha: p.rule, feather: 0.5 } })
      }
    }
  }

  const block = (n: CompNote, x0: number, w: number, y: number, h: number, row: number, t: number, alpha: number, striated: boolean) => {
    marks.push({
      note: n.index,
      spec: {
        x: x0 + w / 2, y, w, h, t0: t, t1: t, row, alpha, feather: p.soft, grain: p.grain, stem: ORDER.indexOf(n.stem),
        ...(striated && p.striation > 0
          ? { pattern: 'vertical' as const, spacing: 3 + 2 * hash(n.index, 7), lineWidth: 0.8, lineT: Math.min(1, t + 0.2), lineAlpha: p.striation }
          : {}),
      },
    })
  }

  const L = comp.loop
  const place = (n: CompNote, step: number) => {
    const rel = step - from
    if (rel < 0 || rel >= span) return
    const sys = Math.floor(rel / perSystem)
    if (sys >= systems) return
    const x0 = left + (rel - sys * perSystem) * stepW
    const sysTop = top - sys * sysPitch
    const rowY = (r: number) => sysTop - (r + 0.5) * rowPitch
    const h1 = hash(n.index, 1), h2 = hash(n.index, 2), h3 = hash(n.index, 3)
    const jitter = (h1 - 0.5) * p.jitter * rowH
    const end = left + aw
    const len = (steps: number) => Math.max(1, Math.min(steps * stepW * p.gate, end - x0))
    const v = n.velocity

    switch (n.voice) {
      case 'hat': {
        // A cluster of thin ticks; louder hats get more of them.
        const count = 1 + Math.floor(h2 * p.cluster * (1 + 3 * v))
        const green = h3 < p.accent
        for (let i = 0; i < count; i++) {
          const x = x0 + i * stepW * 0.32
          if (x > end) break
          const h = rowH * (0.55 + 0.45 * hash(n.index, 10 + i))
          block(n, x, stepW * p.tick, rowY(2) + jitter * 0.5, h, green ? ROW.green : ROW.blue, green ? 0.25 : 0.3 + 0.25 * v, p.ink, false)
        }
        break
      }
      case 'snare':
        for (let i = 0; i < 2; i++) {
          block(n, x0 + i * stepW * 0.4, stepW * p.tick * 1.3, rowY(4) + jitter, rowH * 0.95, ROW.blue, 0.85 + 0.15 * v, p.ink, false)
        }
        break
      case 'kick':
        block(n, x0, len(Math.min(2, n.length)), rowY(5) + jitter, rowH * (0.7 + 0.2 * v), ROW.grey, 0.9 + 0.1 * h2, p.ink, true)
        break
      case 'bass':
        block(n, x0 + stepW * 0.15, len(n.length), rowY(4) + jitter, rowH * 0.7, ROW.blue, 0.72 + 0.08 * h2, p.ink, true)
        break
      case 'pad': {
        // Chord notes: pale, overlapping, nudged up or down by pitch within the row.
        const u = norm(n.pitch, PAD_PITCH) - 0.5
        block(n, x0, len(n.length), rowY(3) + u * rowH * 0.6, rowH * 0.9, ROW.blue, 0.05 + 0.2 * h2, p.ink * 0.75, true)
        break
      }
      case 'lead': {
        // Across the top two rows by pitch: high notes ride higher.
        const u = norm(n.pitch, LEAD_PITCH)
        const y = sysTop - rowPitch * 0.5 - (1 - u) * rowPitch
        block(n, x0, len(n.length), y + jitter * 0.4, rowH * (0.55 + 0.25 * v), ROW.blue, 0.5 + 0.2 * h2, p.ink, true)
        break
      }
    }
  }

  for (const n of comp.notes) {
    if (L) {
      // A loop repeats to fill the page.
      for (let k = Math.floor((from - n.step) / L); n.step + k * L < from + span; k++) place(n, n.step + k * L)
    } else place(n, n.step)
  }
  return marks
}

function create(): SubInstance {
  let marks: Mark[] = []
  let key = ''

  return {
    update({ layers, viewport }, comp, p) {
      const W = viewport.width, H = viewport.height
      const span = Math.max(1, Math.round(p.systems)) * Math.max(1, Math.round(p.bars)) * 16
      const page = Math.floor(comp.position / span)
      const k = `${comp.version}:${page}:${W}x${H}:${JSON.stringify(p)}`
      if (k !== key) {
        key = k
        marks = generate(comp, page * span, span, p, W, H)
      }

      const bars = layers.bars
      bars.blend = 'multiply'
      bars.setGradient(BLUE, ROW.blue)
      bars.setGradient(GREY, ROW.grey)
      bars.setGradient(GREEN, ROW.green)

      // Blurred halo under everything (the reference's out-of-focus print), then the marks.
      for (const pass of p.halo > 0 ? [true, false] : [false]) {
        for (const { spec, note } of marks) {
          const lit = note >= 0 ? comp.lit[note] : 0
          const t = Math.min(1, spec.t0 + p.lift * 0.35 * lit)
          const h = spec.h * (1 + p.pop * lit)
          const alpha = Math.min(1, (spec.alpha ?? 1) + 0.3 * lit)
          if (pass) {
            const grow = 2 + h * 0.15
            bars.push({ ...spec, t0: t, t1: t, w: spec.w + grow * 2, h: h + grow * 2, alpha: alpha * p.halo * 0.3, feather: (spec.feather ?? 1) + grow, pattern: 'none' })
          } else {
            bars.push({ ...spec, t0: t, t1: t, h, alpha })
          }
        }
      }
    },
  }
}

export const sq: SubMode = {
  id: 'sq',
  label: 'SQ',
  params,
  groups,
  presets: {
    // Two systems of four bars: the demo's whole loop on one page.
    Default: { params: {}, background: '#f4f5f7', ink: '#121317' },
    // Crisper print, no halo.
    Sharp: { params: { soft: 0.6, halo: 0, striation: 0.3 }, background: '#f4f5f7', ink: '#121317' },
    // A denser page: three systems, tighter rows, bigger clusters.
    Dense: { params: { systems: 3, rowGap: 0.1, cluster: 0.9, gap: 0.2 }, background: '#f4f5f7', ink: '#121317' },
  },
  create,
}
