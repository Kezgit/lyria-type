import googleSansFlex from '@fontsource/google-sans-flex/files/google-sans-flex-latin-500-normal.woff2?url'
import ebGaramond from '@fontsource/eb-garamond/files/eb-garamond-latin-400-normal.woff2?url'
import ebGaramondItalic from '@fontsource/eb-garamond/files/eb-garamond-latin-400-italic.woff2?url'
import inter from '@fontsource/inter/files/inter-latin-400-normal.woff2?url'
import interBlack from '@fontsource/inter/files/inter-latin-900-normal.woff2?url'
import playfair from '@fontsource/playfair-display/files/playfair-display-latin-400-normal.woff2?url'

// Every font, whatever its origin, ends up as a CSS family registered with
// document.fonts. The SDF atlas rasterizes through Canvas2D, so anything the
// browser can draw is usable: bundled files, dropped files, Google Fonts,
// or fonts installed on the machine.

export type FontOrigin = 'bundled' | 'file' | 'google' | 'local'

export interface FontEntry {
  id: string
  label: string
  /** CSS family name, quoted when used. */
  family: string
  style: 'normal' | 'italic'
  weight: string
  origin: FontOrigin
}

const fonts = new Map<string, FontEntry>()
const loaded = new Map<string, Promise<void>>()

const bundled: [FontEntry, string][] = [
  [{ id: 'google-sans-flex', label: 'Google Sans Flex Medium', family: 'Google Sans Flex', style: 'normal', weight: '500', origin: 'bundled' }, googleSansFlex],
  [{ id: 'eb-garamond', label: 'EB Garamond', family: 'EB Garamond', style: 'normal', weight: '400', origin: 'bundled' }, ebGaramond],
  [{ id: 'eb-garamond-italic', label: 'EB Garamond Italic', family: 'EB Garamond', style: 'italic', weight: '400', origin: 'bundled' }, ebGaramondItalic],
  [{ id: 'playfair', label: 'Playfair Display', family: 'Playfair Display', style: 'normal', weight: '400', origin: 'bundled' }, playfair],
  [{ id: 'inter', label: 'Inter', family: 'Inter', style: 'normal', weight: '400', origin: 'bundled' }, inter],
  [{ id: 'inter-black', label: 'Inter Black', family: 'Inter', style: 'normal', weight: '900', origin: 'bundled' }, interBlack],
]

for (const [entry, url] of bundled) {
  fonts.set(entry.id, entry)
  loaded.set(entry.id, addFace(entry, `url(${url})`))
}

async function addFace(entry: FontEntry, source: string | ArrayBuffer) {
  const face = new FontFace(entry.family, source, { style: entry.style, weight: entry.weight })
  await face.load()
  document.fonts.add(face)
}

export function listFonts(): FontEntry[] {
  return [...fonts.values()]
}

/** The registered font with this id, if any (no fallback). */
export function findFont(id: string): FontEntry | undefined {
  return fonts.get(id)
}

export function getFont(id: string): FontEntry {
  return fonts.get(id) ?? fonts.get('google-sans-flex')!
}

/** Resolves once the font is ready to rasterize. */
export function ensureFont(id: string): Promise<void> {
  return loaded.get(id) ?? Promise.resolve()
}

/** Register a dropped/uploaded .ttf/.otf/.woff/.woff2 file. */
export async function addFontFile(file: File): Promise<FontEntry> {
  const label = file.name.replace(/\.(ttf|otf|woff2?)$/i, '')
  const entry: FontEntry = {
    id: `file:${label}:${Date.now()}`,
    label,
    family: `upload-${label}-${fonts.size}`,
    style: 'normal',
    weight: '400',
    origin: 'file',
  }
  const p = addFace(entry, await file.arrayBuffer())
  loaded.set(entry.id, p)
  await p
  fonts.set(entry.id, entry)
  return entry
}

/** Add a Google Font by family name, e.g. "Cormorant Garamond". */
export async function addGoogleFont(name: string, weight = '400', italic = false): Promise<FontEntry> {
  const family = name.trim()
  const axis = italic ? `ital,wght@1,${weight}` : `wght@${weight}`
  const href = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(family).replace(/%20/g, '+')}:${axis}&display=block`
  const link = document.createElement('link')
  link.rel = 'stylesheet'
  link.href = href
  await new Promise<void>((resolve, reject) => {
    link.onload = () => resolve()
    link.onerror = () => reject(new Error(`Google Fonts has no family "${family}"`))
    document.head.appendChild(link)
  })
  const style = italic ? 'italic' : 'normal'
  await document.fonts.load(`${style} ${weight} 32px "${family}"`, 'abcABC')
  const entry: FontEntry = {
    id: `google:${family}:${weight}:${style}`,
    label: `${family}${italic ? ' Italic' : ''}`,
    family,
    style,
    weight,
    origin: 'google',
  }
  fonts.set(entry.id, entry)
  loaded.set(entry.id, Promise.resolve())
  return entry
}

/** Use a font installed on this machine by family name. */
export async function addLocalFont(family: string): Promise<FontEntry> {
  const entry: FontEntry = { id: `local:${family}`, label: family, family, style: 'normal', weight: '400', origin: 'local' }
  fonts.set(entry.id, entry)
  loaded.set(entry.id, Promise.resolve())
  return entry
}
