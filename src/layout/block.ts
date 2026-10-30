import type { LayoutDefinition } from './types'

// Lines stacked vertically and centred on screen, like a set poem.
export const block: LayoutDefinition = {
  id: 'block',
  label: 'Block',
  params: {
    align: { type: 'select', value: 'left', options: { Left: 'left', Center: 'center', Right: 'right' } },
    leading: { type: 'number', value: 1.25, min: 0.8, max: 4, step: 0.05, label: 'leading (em)' },
    fit: { type: 'boolean', value: true, label: 'fit to view' },
  },
  apply(text, p, viewport, out) {
    const lineHeight = text.fontSize * p.leading
    const maxWidth = Math.max(0, ...text.lines.map((l) => l.width))
    const top = ((text.lines.length - 1) * lineHeight) / 2
    // Optical centre: baseline sits below the middle of the x-height-ish band.
    const baselineShift = (text.descent - text.ascent) / 2 + text.fontSize * 0.1
    // Shrink the whole block (never grow it) when it would overflow the view.
    const blockHeight = (text.lines.length - 1) * lineHeight + text.fontSize
    const s = p.fit ? Math.min(1, (viewport.width * 0.9) / Math.max(1, maxWidth), (viewport.height * 0.9) / blockHeight) : 1

    text.lines.forEach((line, i) => {
      const y = top - i * lineHeight + baselineShift
      const x0 =
        p.align === 'left' ? -maxWidth / 2 : p.align === 'right' ? maxWidth / 2 - line.width : -line.width / 2
      for (const g of line.glyphs) {
        const o = out[g.index]
        o.x = (x0 + g.pen + g.cx) * s
        o.y = (y + g.cy) * s
        o.rotation = 0
        o.scale = s
      }
    })
  },
}
