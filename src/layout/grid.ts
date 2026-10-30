import type { LayoutDefinition } from './types'

// Every glyph in its own cell, ignoring line breaks, filling a centred grid.
export const grid: LayoutDefinition = {
  id: 'grid',
  label: 'Grid',
  params: {
    columns: { type: 'number', value: 12, min: 1, max: 60, step: 1 },
    cell: { type: 'number', value: 1.1, min: 0.4, max: 4, step: 0.05, label: 'cell (em)' },
  },
  apply(text, p, _viewport, out) {
    const cols = Math.max(1, Math.round(p.columns))
    const n = text.glyphs.length
    const rows = Math.ceil(n / cols)
    const cell = text.fontSize * p.cell
    const usedCols = Math.min(cols, n)
    for (const g of text.glyphs) {
      const c = g.index % cols
      const r = Math.floor(g.index / cols)
      const o = out[g.index]
      // Centre each glyph's advance box in its cell, keep its baseline offset.
      o.x = (c - (usedCols - 1) / 2) * cell + g.cx - g.advance / 2
      o.y = ((rows - 1) / 2 - r) * cell + g.cy - text.fontSize * 0.3
      o.rotation = 0
      o.scale = 1
    }
  },
}
