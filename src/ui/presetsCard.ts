import { defaults } from '../app/params'
import { state } from '../app/state'
import type { AudioEngine } from '../audio/audioEngine'
import type { Engine } from '../engine/engine'
import { modes, getMode } from '../modes'
import type { ModeDefinition, ModePreset } from '../modes/types'
import { getSaved, savedNames, setThumb } from '../app/userPresets'

// The Presets card: every preset of every mode as a small picture, so a look
// can be picked by eye from anywhere. Built-in presets show pictures made
// ahead of time (public/thumbs, see makeThumbs); a saved preset keeps a picture
// of the frame it was saved from. Filter by all / yours / this mode. A
// built-in preset can be starred: it moves up into Yours (kept in this
// browser).

export interface PresetRef {
  /** Unique: also the picture's file name. */
  key: string
  mode: string
  /** The sub-mode (the mode's first rebuildOn picker), for modes whose presets depend on it. */
  sub?: string
  name: string
  saved: boolean
  /** The section it's listed under. */
  group: string
  /** A built-in preset starred (listed in Yours). */
  favourite?: boolean
}

const FAV_KEY = 'lyria-type:favourite-presets'
const favourites = new Set<string>()
try {
  for (const k of JSON.parse(localStorage.getItem(FAV_KEY) ?? '[]')) favourites.add(k)
} catch {}
function toggleFavourite(key: string) {
  if (!favourites.delete(key)) favourites.add(key)
  try {
    localStorage.setItem(FAV_KEY, JSON.stringify([...favourites]))
  } catch {}
}

const slug = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')

/** The sub-mode values a mode's presets depend on (none: one list). */
function subsOf(def: ModeDefinition): { picker?: string; subs: { id: string; label: string }[] } {
  const picker = def.presetsFor ? def.rebuildOn?.[0] : undefined
  const options = picker ? (def.params[picker] as { options?: Record<string, string> }).options : undefined
  if (!picker || !options) return { subs: [{ id: '', label: '' }] }
  return { picker, subs: Object.entries(options).map(([label, id]) => ({ id, label })) }
}

/** A mode's built-in presets for a sub-mode. */
export function builtIns(def: ModeDefinition, sub?: string): Record<string, ModePreset> {
  const { picker } = subsOf(def)
  if (!picker || !def.presetsFor) return def.presets ?? {}
  return def.presetsFor({ ...defaults(def.params), [picker]: sub })
}

/** Every preset: yours (saved, then starred) first, then each mode's (and sub-mode's) built-in ones. */
export function allPresets(): PresetRef[] {
  const yours: PresetRef[] = []
  const rest: PresetRef[] = []
  for (const def of modes) {
    for (const name of savedNames(def.id)) yours.push({ key: `saved-${def.id}-${slug(name)}`, mode: def.id, name, saved: true, group: 'Yours' })
  }
  const starred: PresetRef[] = []
  for (const def of modes) {
    const { subs } = subsOf(def)
    for (const sub of subs) {
      const group = sub.label ? `${def.label} · ${sub.label}` : def.label
      for (const name of Object.keys(builtIns(def, sub.id))) {
        const ref: PresetRef = { key: slug(`${def.id}-${sub.id}-${name}`), mode: def.id, sub: sub.id || undefined, name, saved: false, group }
        if (favourites.has(ref.key)) starred.push({ ...ref, group: 'Yours', favourite: true })
        else rest.push(ref)
      }
    }
  }
  return [...yours, ...starred, ...rest]
}

const thumbUrl = (ref: PresetRef) => (ref.saved ? getSaved(ref.mode, ref.name)?.thumb : `${import.meta.env.BASE_URL}thumbs/${ref.key}.webp`)

/** The frame as it is now, as a small picture (a data URL). */
export async function captureThumb(engine: Engine, audio: AudioEngine): Promise<string> {
  let bitmap: ImageBitmap
  try {
    engine.beginExport(768, false)
    bitmap = await engine.renderExportFrame(1 / 60, engine.liveTime, audio.features, (c) => createImageBitmap(c))
  } finally {
    engine.endExport()
  }
  const canvas = document.createElement('canvas')
  canvas.width = 384
  canvas.height = 216
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  bitmap.close()
  return canvas.toDataURL('image/webp', 0.82)
}

export interface PresetsCard {
  /** Redraw the list (after a save, a delete, or a preset or mode picked elsewhere). */
  refresh(): void
}

export function buildPresetsCard(
  page: HTMLElement,
  use: (ref: PresetRef) => void,
  save: () => void,
  remove: (ref: PresetRef) => void,
  active: () => string,
): PresetsCard {
  const FILTER_KEY = 'lyria-type:preset-filter'
  let filter = 'all'
  try {
    filter = localStorage.getItem(FILTER_KEY) ?? 'all'
  } catch {}

  const head = document.createElement('div')
  head.className = 'presets-head'
  const chips = document.createElement('div')
  chips.className = 'presets-filter'
  for (const [id, label] of [['all', 'All'], ['mode', 'This mode'], ['yours', 'Yours']]) {
    const b = document.createElement('button')
    b.textContent = label
    b.dataset.filter = id
    b.addEventListener('click', () => {
      filter = id
      try {
        localStorage.setItem(FILTER_KEY, id)
      } catch {}
      render()
    })
    chips.appendChild(b)
  }
  const saveBtn = document.createElement('button')
  saveBtn.className = 'presets-save'
  saveBtn.textContent = '＋ Save current look'
  saveBtn.addEventListener('click', save)
  head.append(chips, saveBtn)
  const list = document.createElement('div')
  list.className = 'presets-list'
  page.append(head, list)

  /** `keep`: stay scrolled where the list is (a star); otherwise bring the picked preset into view. */
  function render(keep = false) {
    const top = page.scrollTop
    for (const b of chips.querySelectorAll<HTMLButtonElement>('button')) b.classList.toggle('on', b.dataset.filter === filter)
    const refs = allPresets().filter((r) => (filter === 'yours' ? r.group === 'Yours' : filter === 'mode' ? r.mode === state.modeId : true))
    list.replaceChildren()
    if (!refs.length) {
      const empty = document.createElement('p')
      empty.className = 'hint'
      empty.textContent = filter === 'yours' ? 'Nothing here yet. Star a preset, or set up a look and “Save current look”.' : 'No presets here.'
      list.appendChild(empty)
      return
    }
    let grid: HTMLElement | null = null
    let group = ''
    const now = active()
    for (const ref of refs) {
      if (ref.group !== group) {
        group = ref.group
        const h = document.createElement('h4')
        h.textContent = group === 'Yours' ? 'Yours' : group
        grid = document.createElement('div')
        grid.className = 'presets-grid'
        list.append(h, grid)
      }
      const tile = document.createElement('button')
      tile.className = 'preset-tile'
      tile.classList.toggle('on', ref.key === now)
      tile.title = ref.group === 'Yours' ? `${ref.name} (${getMode(ref.mode).label})` : ref.name
      const pic = document.createElement('span')
      pic.className = 'preset-pic'
      const url = thumbUrl(ref)
      if (url) {
        const img = document.createElement('img')
        img.loading = 'lazy'
        img.decoding = 'async'
        img.alt = ''
        img.src = url
        img.addEventListener('error', () => img.remove())
        pic.appendChild(img)
      }
      const name = document.createElement('span')
      name.className = 'preset-name'
      name.textContent = ref.name
      tile.append(pic, name)
      tile.addEventListener('click', () => use(ref))
      if (!ref.saved) {
        const star = document.createElement('span')
        star.className = 'preset-star'
        star.classList.toggle('on', !!ref.favourite)
        star.textContent = ref.favourite ? '★' : '☆'
        star.title = ref.favourite ? 'Remove from Yours' : 'Add to Yours'
        star.addEventListener('click', (e) => {
          e.stopPropagation()
          toggleFavourite(ref.key)
          render(true)
        })
        tile.appendChild(star)
      }
      if (ref.saved) {
        const x = document.createElement('span')
        x.className = 'preset-delete'
        x.textContent = '×'
        x.title = `Delete “${ref.name}”`
        x.addEventListener('click', (e) => {
          e.stopPropagation()
          remove(ref)
        })
        tile.appendChild(x)
      }
      grid!.appendChild(tile)
    }
    // Keep the picked one in view.
    if (keep) page.scrollTop = top
    else list.querySelector<HTMLElement>('.preset-tile.on')?.scrollIntoView({ block: 'nearest' })
  }
  render()
  return { refresh: () => render() }
}

/**
 * Development only: make the pictures for every built-in preset (written to
 * public/thumbs by the dev server) and any saved preset without one. Each
 * preset plays for a moment first, so the picture shows it as it looks moving.
 * Run from the console: `await __makeThumbs()`; the look is put back after.
 */
export function thumbMaker(engine: Engine, audio: AudioEngine, use: (ref: PresetRef) => void, settle = 1500) {
  return async (onlyMissing = true) => {
    const { exportScene, applyScene } = await import('../app/scene')
    const before = exportScene()
    let made = 0
    for (const ref of allPresets()) {
      if (ref.saved && onlyMissing && getSaved(ref.mode, ref.name)?.thumb) continue
      if (!ref.saved && onlyMissing && (await fetch(thumbUrl(ref)!, { method: 'HEAD' })).headers.get('content-type')?.includes('image')) continue
      use(ref)
      await new Promise((r) => setTimeout(r, settle))
      const url = await captureThumb(engine, audio)
      if (ref.saved) setThumb(ref.mode, ref.name, url)
      else await fetch(`/__thumb/${ref.key}.webp`, { method: 'PUT', body: await (await fetch(url)).blob() })
      made++
      console.log(`[thumbs] ${made} ${ref.key}`)
    }
    await applyScene(before)
    return made
  }
}
