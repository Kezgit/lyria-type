import type { FontEntry } from './fonts/registry'
import type { AtlasGlyph, SdfAtlas } from './atlas/sdfAtlas'

// String -> positioned glyph runs, one per line. Positions are in display px
// relative to each line's pen origin (x right) and baseline (y up). Layouts
// decide where lines and glyphs actually go.

export interface ShapedGlyph {
  char: string
  /** Index among drawn (inked) glyphs. */
  index: number
  line: number
  word: number
  /** Index of this glyph within its word. */
  inWord: number
  /** Pen x at the glyph's origin, line-local. */
  pen: number
  advance: number
  /** Quad centre relative to pen/baseline, and quad size. */
  cx: number; cy: number; w: number; h: number
  /** Screen px per atlas px. */
  k: number
  u0: number; v0: number; u1: number; v1: number
  /** The same letter in the wide-spread halo atlas, for offset + blur shapes. */
  halo: HaloQuad
}

/** A glyph's quad in the halo atlas. dx/dy: its centre relative to the crisp quad centre. */
export interface HaloQuad {
  dx: number; dy: number; w: number; h: number
  k: number
  u0: number; v0: number; u1: number; v1: number
}

export interface ShapedLine {
  glyphs: ShapedGlyph[]
  width: number
}

export interface ShapedText {
  lines: ShapedLine[]
  /** All inked glyphs in reading order. */
  glyphs: ShapedGlyph[]
  wordCount: number
  fontSize: number
  ascent: number
  descent: number
}

export interface ShapeOptions {
  fontSize: number
  /** Extra spacing in em. */
  tracking: number
  /** Wrap lines longer than this (px, at this font size) at a space; 0 = only at line breaks. */
  wrapWidth?: number
}

/** The text's lines: its own line breaks, and long lines wrapped at spaces to fit `wrapWidth`. */
function wrapLines(text: string, font: FontEntry, atlas: SdfAtlas, k: number, step: number, wrapWidth: number): string[] {
  const out: string[] = []
  const width = (s: string) => {
    const chars = [...s]
    let w = 0
    chars.forEach((c, i) => {
      const next = chars[i + 1]
      w += (atlas.glyph(font, c).advance + (next ? atlas.kern(font, c, next) : 0)) * k + (next ? step : 0)
    })
    return w
  }
  for (const para of text.split('\n')) {
    if (wrapWidth <= 0) {
      out.push(para)
      continue
    }
    let line = ''
    for (const word of para.split(' ')) {
      const next = line ? `${line} ${word}` : word
      if (line && width(next) > wrapWidth) {
        out.push(line)
        line = word
      } else line = next
    }
    out.push(line)
  }
  return out
}

export function shapeText(text: string, font: FontEntry, atlas: SdfAtlas, halo: SdfAtlas, opts: ShapeOptions): ShapedText {
  const generation = atlas.generation + halo.generation * 1e6
  const shaped = shape(text, font, atlas, halo, opts)
  // An atlas was cleared mid-shape, so earlier UVs are stale: shape again.
  return atlas.generation + halo.generation * 1e6 === generation ? shaped : shape(text, font, atlas, halo, opts)
}

function haloQuad(h: AtlasGlyph, hk: number, cx: number, cy: number): HaloQuad {
  return {
    dx: (h.left + h.w / 2) * hk - cx,
    dy: (h.top - h.h / 2) * hk - cy,
    w: h.w * hk, h: h.h * hk, k: hk,
    u0: h.u0, v0: h.v0, u1: h.u1, v1: h.v1,
  }
}

function shape(text: string, font: FontEntry, atlas: SdfAtlas, halo: SdfAtlas, { fontSize, tracking, wrapWidth = 0 }: ShapeOptions): ShapedText {
  const k = fontSize / atlas.config.fontSize
  const hk = fontSize / halo.config.fontSize
  const lines: ShapedLine[] = []
  const glyphs: ShapedGlyph[] = []
  let word = 0

  for (const [lineIndex, lineText] of wrapLines(text, font, atlas, k, tracking * fontSize, wrapWidth).entries()) {
    const chars = [...lineText]
    const line: ShapedLine = { glyphs: [], width: 0 }
    let pen = 0
    let inWord = 0
    let inWordRun = false

    chars.forEach((char, i) => {
      const g = atlas.glyph(font, char)
      const isSpace = /\s/.test(char)
      if (isSpace) {
        if (inWordRun) word++
        inWordRun = false
        inWord = 0
      } else {
        inWordRun = true
      }
      if (g.ink) {
        const cx = (g.left + g.w / 2) * k
        const cy = (g.top - g.h / 2) * k
        const sg: ShapedGlyph = {
          char,
          index: glyphs.length,
          line: lineIndex,
          word,
          inWord: inWord++,
          pen,
          advance: g.advance * k,
          cx,
          cy,
          w: g.w * k,
          h: g.h * k,
          k,
          u0: g.u0, v0: g.v0, u1: g.u1, v1: g.v1,
          halo: haloQuad(halo.glyph(font, char), hk, cx, cy),
        }
        line.glyphs.push(sg)
        glyphs.push(sg)
      }
      const next = chars[i + 1]
      const kern = next ? atlas.kern(font, char, next) : 0
      pen += (g.advance + kern) * k + (next ? tracking * fontSize : 0)
    })
    if (inWordRun) word++
    line.width = pen
    lines.push(line)
  }

  const m = atlas.metrics(font)
  return { lines, glyphs, wordCount: word, fontSize, ascent: m.ascent * k, descent: m.descent * k }
}
