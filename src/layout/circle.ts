import type { LayoutDefinition } from './types'

// All lines run end to end around a circle, glyphs rotated to the tangent.
export const circle: LayoutDefinition = {
  id: 'circle',
  label: 'Circle',
  params: {
    radius: { type: 'number', value: 0.32, min: 0.05, max: 0.6, step: 0.01, label: 'radius (of view)' },
    gap: { type: 'number', value: 1, min: 0, max: 4, step: 0.1, label: 'line gap (em)' },
    startAngle: { type: 'number', value: 90, min: -180, max: 180, step: 1, label: 'start (deg)' },
  },
  apply(text, p, viewport, out) {
    const gap = text.fontSize * p.gap
    // Grow past the requested radius rather than letting text overlap itself.
    const total = text.lines.reduce((sum, l) => sum + l.width + gap, 0)
    const R = Math.max(Math.min(viewport.width, viewport.height) * p.radius, total / (Math.PI * 2))
    let arc = 0
    for (const line of text.lines) {
      for (const g of line.glyphs) {
        // Glyph centre along the arc; clockwise from startAngle.
        const s = arc + g.pen + g.cx
        const a = (p.startAngle * Math.PI) / 180 - s / R
        const r = R + g.cy
        const o = out[g.index]
        o.x = Math.cos(a) * r
        o.y = Math.sin(a) * r
        o.rotation = a - Math.PI / 2
        o.scale = 1
      }
      arc += line.width + gap
    }
  },
}
