import { defaults } from './params'
import { mergeParams } from './scene'
import { state } from './state'
import type { ModeDefinition } from '../modes/types'
import { findFont } from '../text/fonts/registry'

// Presets the user saves from the panel, per mode. Stored in localStorage and,
// while the dev server runs, in presets/saved.json in the project (see
// vite.config.ts), so they outlive rebuilds and code changes. A hosted build
// bundles that file, so every visitor starts with the project's presets. Each one keeps
// every value it was saved with; loading goes through the schema, so settings
// added later take their defaults and removed ones are ignored.

export interface SavedPreset {
  params: Record<string, unknown>
  background: string
  ink: string
  fontId: string
  fontSize: number
  tracking: number
  /** The camera when it was saved (zoom, and the pan in frame widths / heights); older presets have none. */
  view?: { zoom: number; x: number; y: number }
  savedAt: string
}

/** modeId -> preset name -> preset */
type Store = Record<string, Record<string, SavedPreset>>

const KEY = 'lyria-type:presets'
const ENDPOINT = '/__presets'
let store: Store = read()

function read(): Store {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) ?? '{}')
    return s && typeof s === 'object' ? s : {}
  } catch {
    return {}
  }
}

function persist() {
  try {
    localStorage.setItem(KEY, JSON.stringify(store))
  } catch {}
  if (import.meta.env.DEV) fetch(ENDPOINT, { method: 'PUT', body: JSON.stringify(store, null, 2) }).catch(() => {})
}

/** The project's presets: presets/saved.json, live from the dev server, or as bundled into a hosted build. */
async function projectPresets(): Promise<Store | null> {
  try {
    if (!import.meta.env.DEV) return (await import('../../presets/saved.json')).default as Store
    const res = await fetch(ENDPOINT)
    if (!res.ok || !res.headers.get('content-type')?.includes('json')) return null
    return await res.json()
  } catch {
    return null
  }
}

/** Merge in the project file's presets (newest copy of each name wins). Resolves true if anything changed. */
export async function syncPresets(): Promise<boolean> {
  const file = await projectPresets()
  if (!file) return false
  let changed = false
  let fileBehind = false
  for (const [mode, byName] of Object.entries(file ?? {})) {
    for (const [name, p] of Object.entries(byName ?? {})) {
      const mine = store[mode]?.[name]
      if (!mine || (p.savedAt ?? '') > (mine.savedAt ?? '')) {
        ;(store[mode] ??= {})[name] = p
        changed = true
      }
    }
  }
  // Presets only this browser has go to the file too.
  for (const [mode, byName] of Object.entries(store)) {
    for (const name of Object.keys(byName)) if (!file?.[mode]?.[name]) fileBehind = true
  }
  // (A hosted build has no file to write back to, only this browser.)
  if (changed || (fileBehind && import.meta.env.DEV)) persist()
  return changed
}

export function savedNames(modeId: string): string[] {
  return Object.keys(store[modeId] ?? {})
}

export function getSaved(modeId: string, name: string): SavedPreset | undefined {
  return store[modeId]?.[name]
}

/** Save the current mode settings, colours and type under a name (overwrites). */
export function savePreset(modeId: string, name: string) {
  ;(store[modeId] ??= {})[name] = {
    params: structuredClone(state.modeParams[modeId]),
    background: state.background,
    ink: state.ink,
    fontId: state.fontId,
    fontSize: state.fontSize,
    tracking: state.tracking,
    view: { ...state.view },
    savedAt: new Date().toISOString(),
  }
  persist()
}

export function deletePreset(modeId: string, name: string) {
  if (!store[modeId]?.[name]) return
  delete store[modeId][name]
  persist()
}

/** Put a saved preset's values into the mode, through the schema. */
export function applySaved(def: ModeDefinition, p: SavedPreset) {
  const values = state.modeParams[def.id]
  Object.assign(values, defaults(def.params))
  mergeParams(values, p.params, def.params)
  if (/^#[0-9a-f]{6}$/i.test(p.background)) state.background = p.background
  if (/^#[0-9a-f]{6}$/i.test(p.ink)) state.ink = p.ink
  if (typeof p.fontId === 'string' && findFont(p.fontId)) state.fontId = p.fontId
  if (typeof p.fontSize === 'number') state.fontSize = p.fontSize
  if (typeof p.tracking === 'number') state.tracking = p.tracking
  // Back to where the camera was (a preset saved before cameras were kept leaves it where it is).
  const v = p.view
  if (v && [v.zoom, v.x, v.y].every((n) => typeof n === 'number' && Number.isFinite(n))) {
    Object.assign(state.view, { zoom: Math.min(64, Math.max(0.25, v.zoom)), x: v.x, y: v.y })
  }
}
