import type { ParamSchema } from './params'
import { emit, state } from './state'
import { loadTracks, tracks, type KeyTrack } from './keyframes'
import { layouts } from '../layout'
import { modes } from '../modes'
import { addGoogleFont, addLocalFont, findFont, getFont, type FontEntry } from '../text/fonts/registry'

// Scenes: the whole look (text, type, colours, layout and every mode's
// settings) as a JSON file that can be exported and dragged back in.
// Loading is defensive: only known settings with the right type are taken,
// so older or hand-edited files can't put the app in a bad state.

export const SCENE_APP = 'lyria-type'
export const SCENE_VERSION = 1

export interface SceneFile {
  app: typeof SCENE_APP
  version: number
  savedAt: string
  text: string
  font: Pick<FontEntry, 'id' | 'label' | 'family' | 'style' | 'weight' | 'origin'>
  fontSize: number
  tracking: number
  wrap?: number
  background: string
  ink: string
  layoutId: string
  layoutParams: Record<string, Record<string, unknown>>
  modeId: string
  modeParams: Record<string, Record<string, unknown>>
  /** Letters given to instruments (shared by every mode). */
  letterParts?: string
  /** How dropped images show (engine/dropFx.ts). */
  drop?: Partial<typeof state.drop>
  /** Each mode's keyframes (app/keyframes.ts). */
  keyframes?: Record<string, KeyTrack>
}

export function exportScene(): SceneFile {
  const { id, label, family, style, weight, origin } = getFont(state.fontId)
  return {
    app: SCENE_APP,
    version: SCENE_VERSION,
    savedAt: new Date().toISOString(),
    text: state.text,
    font: { id, label, family, style, weight, origin },
    fontSize: state.fontSize,
    tracking: state.tracking,
    wrap: state.wrap,
    background: state.background,
    ink: state.ink,
    layoutId: state.layoutId,
    layoutParams: structuredClone(state.layoutParams),
    modeId: state.modeId,
    modeParams: structuredClone(state.modeParams),
    letterParts: state.letterParts,
    drop: { ...state.drop },
    keyframes: structuredClone(tracks),
  }
}

/** Save the current scene as a .json download. */
export function downloadScene() {
  const scene = exportScene()
  const blob = new Blob([JSON.stringify(scene, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  const stamp = scene.savedAt.slice(0, 16).replace(/[:T]/g, '-')
  a.href = url
  a.download = `lyria-type-${scene.modeId}-${stamp}.json`
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

const isColor = (v: unknown): v is string => typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v)
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/** Copy only the keys the schema knows, when the value has the right type / is allowed. */
export function mergeParams(target: Record<string, unknown>, incoming: unknown, schema: ParamSchema) {
  if (!incoming || typeof incoming !== 'object') return
  for (const [key, def] of Object.entries(schema)) {
    const v = (incoming as Record<string, unknown>)[key]
    if (v === undefined) continue
    if (def.type === 'number' && isNum(v)) target[key] = Math.min(def.max, Math.max(def.min, v))
    else if (def.type === 'boolean' && typeof v === 'boolean') target[key] = v
    else if (def.type === 'color' && isColor(v)) target[key] = v
    else if (def.type === 'select' && typeof v === 'string' && Object.values(def.options).includes(v)) target[key] = v
    else if (def.type === 'text' && typeof v === 'string') target[key] = v.slice(0, 20000)
  }
}

/** Make the scene's font available; returns its id, or null if it can't be restored. */
async function restoreFont(font: SceneFile['font'] | undefined): Promise<string | null> {
  if (!font || typeof font.id !== 'string') return null
  if (findFont(font.id)) return font.id
  try {
    if (font.origin === 'google') return (await addGoogleFont(font.family, font.weight, font.style === 'italic')).id
    if (font.origin === 'local') return (await addLocalFont(font.family)).id
  } catch {
    return null
  }
  return null
}

/** Apply a parsed scene. Returns human-readable warnings (empty when all went in). */
export async function applyScene(data: unknown): Promise<string[]> {
  const warnings: string[] = []
  if (!data || typeof data !== 'object' || (data as SceneFile).app !== SCENE_APP) {
    throw new Error('Not a Lyria Type scene file.')
  }
  const scene = data as Partial<SceneFile>
  if (isNum(scene.version) && scene.version > SCENE_VERSION) {
    warnings.push(`Saved by a newer version (${scene.version}); some settings may be ignored.`)
  }

  if (typeof scene.text === 'string') state.text = scene.text
  if (isNum(scene.fontSize)) state.fontSize = Math.min(300, Math.max(8, scene.fontSize))
  if (isNum(scene.tracking)) state.tracking = scene.tracking
  if (isNum(scene.wrap)) state.wrap = Math.min(1, Math.max(0, scene.wrap))
  if (isColor(scene.background)) state.background = scene.background
  if (isColor(scene.ink)) state.ink = scene.ink

  const fontId = await restoreFont(scene.font)
  if (fontId) state.fontId = fontId
  else if (scene.font) warnings.push(`Font "${scene.font.label ?? scene.font.family}" isn't available here; add it, then load again.`)

  for (const l of layouts) mergeParams(state.layoutParams[l.id], scene.layoutParams?.[l.id], l.params)
  if (typeof scene.layoutId === 'string' && layouts.some((l) => l.id === scene.layoutId)) state.layoutId = scene.layoutId

  for (const m of modes) mergeParams(state.modeParams[m.id], scene.modeParams?.[m.id], m.params)
  // Letters given to instruments; older scenes kept them in the Orchestra's settings.
  const legacy = (scene.modeParams?.orchestra as Record<string, unknown> | undefined)?.assign
  if (scene.drop && typeof scene.drop === 'object') {
    const d = scene.drop
    if (d.target === 'dots' || d.target === 'gradient' || d.target === 'both') state.drop.target = d.target
    if (d.style === 'ripple' || d.style === 'warp') state.drop.style = d.style
    for (const k of ['speed', 'hold', 'fade', 'warp'] as const) if (isNum(d[k])) state.drop[k] = d[k]!
  }
  loadTracks(scene.keyframes)
  if (typeof scene.letterParts === 'string') state.letterParts = scene.letterParts.slice(0, 20000)
  else if (typeof legacy === 'string') state.letterParts = legacy.slice(0, 20000)
  if (typeof scene.modeId === 'string') {
    if (modes.some((m) => m.id === scene.modeId)) state.modeId = scene.modeId
    else warnings.push(`Mode "${scene.modeId}" doesn't exist any more; kept the current one.`)
  }

  emit('fonts')
  emit('text')
  emit('scene')
  return warnings
}

/** Read a dropped / chosen .json file and apply it. */
export async function loadSceneFile(file: File): Promise<string[]> {
  let data: unknown
  try {
    data = JSON.parse(await file.text())
  } catch {
    throw new Error(`${file.name} isn't valid JSON.`)
  }
  return applyScene(data)
}
