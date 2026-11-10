import { Pane, type FolderApi } from 'tweakpane'
import { defaults, type ParamSchema } from '../app/params'
import { emit, on, state } from '../app/state'
import type { AudioEngine } from '../audio/audioEngine'
import { modes, getMode } from '../modes'
import { loadSceneFile } from '../app/scene'
import type { Engine } from '../engine/engine'
import { EXPORT_OPTIONS, runExport, type ExportKind } from '../export/export'
import { playhead, trackFor } from '../app/keyframes'
import { mountColourPlace, mountGradientTools } from './gradientTools'
import { attachView } from './view'
import { buildToolbar } from './toolbar'
import { addDrop, imageColours } from '../app/drops'
import { applySaved, deletePreset, getSaved, savePreset, savedNames as savedNamesOf, setThumb, syncPresets } from '../app/userPresets'
import { buildPresetsCard, builtIns, captureThumb, thumbMaker, type PresetRef } from './presetsCard'
import { attachTips } from './tips'
import { buildStemMeters } from './stemColours'
import { buildMasksCard } from './masksCard'
import type { ModeDefinition, ModePreset } from '../modes/types'

// The panel: a sidebar beside the stage, its sections as small tabs along
// the top (Mode, Presets, Masks, Audio, Export); one shows at a time. Each
// holds Tweakpanes; the mode's controls are generated from its param schema.

const TABS = ['Mode', 'Presets', 'Masks', 'Audio', 'Export'] as const
type Tab = (typeof TABS)[number]
const OPEN_KEY = 'lyria-type:tab'

export interface PanelApi {
  /** Open a card. */
  open(card: string): void
  /** Open the Mode card at the first group whose title starts with one of `prefixes`; false if none. */
  goTo(...prefixes: string[]): boolean
}

export function buildPanel(root: HTMLElement, audio: AudioEngine, engine: Engine): PanelApi {
  const panes: Pane[] = []
  const refreshAll = () => {
    panes.forEach((p) => p.refresh())
    // Changes made elsewhere (the rack, a preset) are where undo starts from.
    resyncUndo()
  }
  // Params changed outside the panel (the rack's dials).
  on('params', refreshAll)

  // --- Tabs ------------------------------------------------------------------
  const pages = new Map<Tab, HTMLElement>()
  const tabButtons = new Map<Tab, HTMLButtonElement>()
  const tabBar = document.createElement('nav')
  tabBar.className = 'side-tabs'
  tabBar.setAttribute('role', 'tablist')
  const body = document.createElement('div')
  body.className = 'side-body'
  root.append(tabBar, body)
  for (const tab of TABS) {
    const b = document.createElement('button')
    b.type = 'button'
    b.textContent = tab
    b.setAttribute('role', 'tab')
    b.addEventListener('click', () => setOpen(tab, true))
    tabBar.appendChild(b)
    tabButtons.set(tab, b)
    const page = document.createElement('div')
    page.className = 'tab-page'
    page.hidden = true
    body.appendChild(page)
    pages.set(tab, page)
  }
  function setOpen(tab: Tab, open: boolean) {
    if (!open) return
    for (const t of TABS) {
      pages.get(t)!.hidden = t !== tab
      tabButtons.get(t)!.setAttribute('aria-selected', String(t === tab))
    }
    try {
      localStorage.setItem(OPEN_KEY, tab)
    } catch {}
  }
  attachTips(root)
  /** The Mode tab, at a group: opened (with any group it sits in), scrolled to and flashed. */
  function goTo(...prefixes: string[]) {
    setOpen('Mode', true)
    const titles = [...pages.get('Mode')!.querySelectorAll<HTMLElement>('.tp-fldv_t')]
    const title = prefixes.map((p) => titles.find((t) => t.textContent?.trim().startsWith(p))).find(Boolean)
    if (!title) return false
    const folder = title.closest('.tp-fldv')
    for (let f = folder; f; f = f.parentElement?.closest('.tp-fldv') ?? null) {
      if (!f.classList.contains('tp-fldv-expanded')) f.querySelector<HTMLElement>(':scope > .tp-fldv_b')?.click()
    }
    requestAnimationFrame(() => title.scrollIntoView({ behavior: 'smooth', block: 'start' }))
    folder?.classList.add('toolbar-flash')
    setTimeout(() => folder?.classList.remove('toolbar-flash'), 1200)
    return true
  }
  let loadingScene = false
  function paneIn(tab: Tab) {
    const pane = new Pane({ container: pages.get(tab)! })
    panes.push(pane)
    return pane
  }

  // --- Mode ------------------------------------------------------------------
  const modePane = paneIn('Mode')
  modePane
    .addBinding(state, 'modeId', { label: 'mode', options: Object.fromEntries(modes.map((m) => [m.label, m.id])) })
    // A scene load or a preset updates the dropdown too; only a user's pick applies the first preset.
    .on('change', () => renderModeParams(!loadingScene && !applying))
  // The page: its colour, and the ink some looks draw in.
  const fPage = modePane.addFolder({ title: 'Page', expanded: false })
  fPage.addBinding(state, 'background', { label: 'background' })
  fPage.addBinding(state, 'ink', { label: 'ink' })
  // The mode's own settings: their own pane, redrawn when the mode or sub-mode changes.
  const modeHost = document.createElement('div')
  pages.get('Mode')!.appendChild(modeHost)
  // Set when a preset changed the page colours, so the next preset without its
  // own colours can put them back rather than leaving e.g. a dark page behind.
  let presetColours = false
  // The preset last picked (its PresetRef key), shown picked on the Presets card.
  let activePreset = ''
  // Set while a preset is applied, so the pickers it moves don't apply another.
  let applying = false
  let modeParams: Pane | null = null

  /** A built-in preset over the mode's defaults, with its page colours and type. */
  function applyBuiltIn(def: ModeDefinition, preset: ModePreset) {
    const values = state.modeParams[def.id]
    // Marks placed by hand (Manual) and masks are the work itself, not a look: a preset keeps them.
    const kept = Object.fromEntries(['manual_marks', 'masks', 'maskTimeline'].filter((k) => values[k] && !(k in preset.params)).map((k) => [k, values[k]]))
    Object.assign(values, defaults(def.params), preset.params, kept)
    if (preset.background || preset.ink) {
      state.background = preset.background ?? state.background
      state.ink = preset.ink ?? state.ink
      presetColours = true
    } else if (presetColours) {
      state.background = '#ffffff'
      state.ink = '#111111'
      presetColours = false
    }
    if (preset.fontId) state.fontId = preset.fontId
    if (preset.fontSize) state.fontSize = preset.fontSize
    if (preset.fontId || preset.fontSize) emit('text')
  }
  /** Any preset, from any mode: switches to its mode (and sub-mode) first. */
  function usePreset(ref: PresetRef) {
    const def = getMode(ref.mode)
    if (ref.saved) {
      const p = getSaved(def.id, ref.name)
      if (!p) return
      applySaved(def, p)
      presetColours = true
      emit('text')
    } else {
      const preset = builtIns(def, ref.sub)[ref.name]
      if (!preset) return
      applyBuiltIn(def, preset)
    }
    activePreset = ref.key
    applying = true
    state.modeId = def.id
    refreshAll()
    updateConditional()
    applying = false
    renderModeParams()
  }

  function renderModeParams(applyFirstPreset = false) {
    if (modeParams) {
      panes.splice(panes.indexOf(modeParams), 1)
      modeParams.dispose()
    }
    // The old controls' visibility rules go with them.
    for (const c of conditional) if (Object.values(state.modeParams).includes(c.values)) conditional.delete(c)
    const def = getMode(state.modeId)
    const folder = (modeParams = new Pane({ container: modeHost }))
    panes.push(folder)
    const values = state.modeParams[def.id]
    // Sub-mode pickers sit first when the presets depend on them.
    const pickers = def.presetsFor ? (def.rebuildOn ?? []) : []
    // A picker with one choice (the Sequencer's style, now only Dots) isn't shown.
    const shownPickers = pickers.filter((k) => Object.keys((def.params[k] as { options?: object }).options ?? { a: 1, b: 2 }).length > 1)
    // Some keys (a sub-mode picker) change which controls exist: re-render on
    // change. A user's pick of a sub-mode starts from its first preset.
    const onChange = (key: string) => {
      if (!def.rebuildOn?.includes(key)) return
      const fresh = pickers.includes(key) && !applying && !loadingScene
      queueMicrotask(() => renderModeParams(fresh))
    }
    addSchema(folder, Object.fromEntries(shownPickers.map((k) => [k, def.params[k]])), values, onChange)
    // Switching mode (or sub-mode) starts from its first preset, colours and font included.
    if (applyFirstPreset) {
      const presets = def.presetsFor?.(values) ?? def.presets ?? {}
      const first = Object.keys(presets)[0]
      if (first) {
        applyBuiltIn(def, presets[first])
        activePreset = ''
        applying = true
        refreshAll()
        updateConditional()
        applying = false
        if (def.rebuildOn) queueMicrotask(() => renderModeParams())
      }
    }
    const groups = def.groupsFor?.(values) ?? def.groups
    if (groups) {
      // Folded as last left; on a fresh load only the mode's main sections are open.
      const folds = foldState()
      for (const [title, keys] of Object.entries(groups)) {
        const fk = `${def.id}:${title}`
        const sub = folder.addFolder({ title, expanded: folds[fk] ?? (!def.openGroups || def.openGroups.includes(title)) })
        sub.on('fold', (ev) => {
          const f = foldState()
          f[fk] = ev.expanded
          try {
            localStorage.setItem(FOLD_KEY, JSON.stringify(f))
          } catch {}
        })
        addSchema(sub, Object.fromEntries(keys.filter((k) => !pickers.includes(k)).map((k) => [k, def.params[k]])), values, onChange, `${def.id}:${title}`)
        // The Sequencer's gradient: a stops editor, and handles / a mask brush on the stage.
        if (title === 'Gradient map' && 'gradStops' in def.params) mountGradientTools(sub, values, engine, () => refreshAll())
        // Dots' colours, placed on the stage the same way.
        if (title === 'Colour' && 'dots_colX0' in def.params && values.style === 'dots') mountColourPlace(sub, values, engine, () => refreshAll())
      }
    } else {
      addSchema(folder, Object.fromEntries(Object.entries(def.params).filter(([k]) => !pickers.includes(k))), values, onChange, def.id)
    }

    // Keyframes: these settings captured as moments, played as motion (app/keyframes.ts).
    const track = trackFor(def.id)
    const kf = folder.addFolder({ title: `Keyframes (${track.frames.length})`, expanded: track.frames.length > 0 })
    kf.addBinding(track, 'play', { label: 'play' })
    kf.addBinding(track, 'seconds', { label: 'each move takes (s)', min: 0.1, max: 60, step: 0.1 })
    kf.addBinding(track, 'hold', { label: 'hold each (s)', min: 0, max: 60, step: 0.1 })
    kf.addBinding(track, 'order', { label: 'order', options: { 'in a loop (last → first)': 'loop', 'back and forth': 'bounce' } })
    kf.addBinding(track, 'ease', { label: 'easing', options: { smooth: 'smooth', linear: 'linear' } })
    kf.addButton({ title: '＋ Add keyframe' }).on('click', () => {
      track.frames.push(structuredClone(values))
      renderModeParams()
    })
    if (track.frames.length) {
      const pickKf = { n: Math.min(track.frames.length, Math.max(1, Math.round(playhead.at) + 1)) }
      kf.addBinding(pickKf, 'n', { label: 'keyframe', min: 1, max: track.frames.length, step: 1 })
      kf.addButton({ title: 'Load it' }).on('click', () => {
        Object.assign(values, structuredClone(track.frames[pickKf.n - 1]))
        refreshAll()
        updateConditional()
        if (def.rebuildOn) queueMicrotask(() => renderModeParams())
      })
      kf.addButton({ title: 'Update it' }).on('click', () => {
        track.frames[pickKf.n - 1] = structuredClone(values)
      })
      kf.addButton({ title: 'Delete it' }).on('click', () => {
        track.frames.splice(pickKf.n - 1, 1)
        renderModeParams()
      })
      kf.addButton({ title: 'Clear all keyframes' }).on('click', () => {
        if (!confirm(`Clear all ${track.frames.length} keyframes?`)) return
        track.frames.length = 0
        track.play = false
        renderModeParams()
      })
    }
    const hint = document.createElement('p')
    hint.className = 'hint'
    hint.textContent = 'Set the sliders and add a keyframe; change them and add another. Play glides between them.'
    // Inside the folder's body, so it folds away with it.
    ;(kf.element.querySelector('.tp-fldv_c') ?? kf.element).appendChild(hint)
    presetsCard?.refresh()
  }

  // --- Presets -------------------------------------------------------------------
  let presetsCard: ReturnType<typeof buildPresetsCard> | null = null
  presetsCard = buildPresetsCard(
    pages.get('Presets')!,
    usePreset,
    async () => {
      const def = getMode(state.modeId)
      const current = activePreset.startsWith(`saved-${def.id}-`) ? activePreset : ''
      const currentName = current ? (getSavedName(def.id, current) ?? '') : ''
      const name = prompt(`Save this ${def.label} look as a preset named:`, currentName)?.trim()
      if (!name) return
      if (name !== currentName && getSaved(def.id, name) && !confirm(`Replace the saved preset “${name}”?`)) return
      savePreset(def.id, name)
      try {
        setThumb(def.id, name, await captureThumb(engine, audio))
      } catch (err) {
        console.warn('No picture for the preset', err)
      }
      activePreset = `saved-${def.id}-${keySlug(name)}`
      presetsCard?.refresh()
    },
    (ref) => {
      if (!confirm(`Delete the saved preset “${ref.name}”?`)) return
      deletePreset(ref.mode, ref.name)
      if (activePreset === ref.key) activePreset = ''
      presetsCard?.refresh()
    },
    () => activePreset,
  )
  renderModeParams()
  // Pull in presets saved to the project file (other browsers / ports).
  syncPresets().then((changed) => changed && renderModeParams())
  if (import.meta.env.DEV) Object.assign(window, { __makeThumbs: thumbMaker(engine, audio, usePreset) })

  // Zoom and pan live in the toolbar (and the trackpad); nothing in the panel shows them.
  attachView(engine, () => {})
  // The toolbar along the bottom of the stage (view, gradient, keyframes, PNG).
  buildToolbar(engine, () => {}, { open: (tab) => setOpen(tab as Tab, true), goTo, png: () => quickPng() })
  // Masks: invisible shapes pushing the Sequencer's marks aside (any style), edited on the stage while open.
  buildMasksCard(pages.get('Masks')!, engine, () => !pages.get('Masks')!.hidden)

  // --- Audio -----------------------------------------------------------------
  const audioPane = paneIn('Audio')
  const fileInput = hiddenInput('audio/*', async (file) => {
    await audio.useFile(file)
    state.audio.source = 'file'
    refreshAll()
  })
  // Stems: several files at once (vocals / drums / bass / other), played together.
  const stemsInput = hiddenInput('audio/*', () => {}, async (files) => {
    await audio.useStems(files)
    state.audio.source = 'stems'
    refreshAll()
  })
  audioPane
    .addBinding(state.audio, 'source', { label: 'music', options: { 'Demo beat': 'demo', 'A song file': 'file', Stems: 'stems', Microphone: 'mic' } })
    .on('change', async ({ value }) => {
      if (value === 'demo') await audio.useDemo()
      if (value === 'mic') await audio.useMic()
      if (value === 'file') fileInput.click()
      if (value === 'stems') stemsInput.click()
    })
  audioPane.addButton({ title: 'Load a song…' }).on('click', () => fileInput.click())
  audioPane.addButton({ title: 'Load stems (pick all the files)…' }).on('click', () => stemsInput.click())
  audioPane
    .addBinding(state.audio, 'sensitivity', { min: 0.2, max: 3, step: 0.05 })
    .on('change', ({ value }) => (audio.analyser.sensitivity = value))
  // The level, and each stem in the colour it's drawn in on the stage.
  buildStemMeters(pages.get('Audio')!, audio, engine, () => !pages.get('Audio')!.hidden)

  async function loadScene(file: File) {
    try {
      const warnings = await loadSceneFile(file)
      if (warnings.length) alert(warnings.join('\n'))
    } catch (err) {
      alert((err as Error).message)
    }
  }

  // --- Export ------------------------------------------------------------------
  // PNG: the frame on screen, at the preview's size, 4K or 12K. MP4: 4K, frame
  // by frame from the start time, with the song; the file is picked first.
  const exportPane = paneIn('Export')
  const job = { kind: 'png-8k' as ExportKind, fps: 30, start: 0, seconds: 0 }
  const kindBinding = exportPane.addBinding(job, 'kind', { label: 'save as', options: EXPORT_OPTIONS })
  const videoFolder = exportPane.addFolder({ title: 'MP4' })
  videoFolder.addBinding(job, 'fps', { label: 'frame rate', options: { '30': 30, '60': 60 } })
  videoFolder.addBinding(job, 'start', { label: 'start at (s)', min: 0, max: 600, step: 0.1 })
  videoFolder.addBinding(job, 'seconds', { label: 'length (s, 0 = whole song)', min: 0, max: 600, step: 0.5 })
  const run = exportPane.addButton({ title: 'Save' })
  const cancel = exportPane.addButton({ title: 'Cancel', hidden: true })
  const showKind = () => {
    videoFolder.hidden = job.kind !== 'mp4-4k'
    run.title = job.kind === 'mp4-4k' ? 'Save MP4' : 'Save hi-res PNG'
  }
  kindBinding.on('change', showKind)
  showKind()
  const status = document.createElement('p')
  status.className = 'hint'
  status.textContent = 'Saves the frame as you see it. Zoom in first for a close-up; the edges stay crisp. Video renders frame by frame (slower than real time) with the music.'
  pages.get('Export')!.appendChild(status)
  let controller: AbortController | null = null
  cancel.on('click', () => controller?.abort())
  run.on('click', () => exportNow(job.kind))
  /** The toolbar's PNG button: a picture at the chosen PNG size (8K when a video is chosen). */
  const quickPng = () => exportNow(job.kind === 'mp4-4k' ? 'png-8k' : job.kind)
  async function exportNow(kind: ExportKind) {
    if (controller) return
    controller = new AbortController()
    run.disabled = true
    cancel.hidden = false
    const stamp = new Date().toISOString().slice(0, 16).replace(/[T:]/g, '-')
    try {
      const result = await runExport(engine, audio, {
        ...job, kind, name: `lyria-type-${state.modeId}-${stamp}`, signal: controller.signal,
        onProgress: (done, total, label) => (status.textContent = total > 1 ? `${label} (${Math.round((100 * done) / total)}%)` : label),
      })
      if (result === 'cancelled') status.textContent = 'Export cancelled.'
    } catch (err) {
      status.textContent = `Export failed: ${(err as Error).message}`
      console.error(err)
    } finally {
      controller = null
      run.disabled = false
      cancel.hidden = true
    }
  }

  // After a scene loads, every control needs to show the new values.
  on('scene', () => {
    loadingScene = true
    renderModeParams()
    refreshAll()
    loadingScene = false
  })

  // Drag & drop anywhere: audio becomes the source, scene files load, images ripple their colours in.
  window.addEventListener('dragover', (e) => e.preventDefault())
  // An image dropped on the stage: its colours ripple out from where it landed in the dot modes.
  async function dropImage(file: File, e: DragEvent) {
    try {
      const colours = await imageColours(file)
      const { viewport } = engine.letters
      const cr = engine.canvas.getBoundingClientRect()
      const k = cr.width / Math.max(1, viewport.width)
      const { zoom, x: panX, y: panY } = state.view
      const z = Math.max(0.05, zoom)
      // Client px -> px from the frame's centre, y up, through the view (as the modes lay out).
      const x = ((e.clientX - cr.left) / k - viewport.width / 2) / z + panX * viewport.width
      const y = -((e.clientY - cr.top) / k - viewport.height / 2) / z + panY * viewport.height
      addDrop({ x, y, colours, at: performance.now() / 1000 })
    } catch (err) {
      console.warn('Could not read the dropped image', err)
    }
  }
  window.addEventListener('drop', async (e) => {
    e.preventDefault()
    const files = [...(e.dataTransfer?.files ?? [])]
    // Several audio files dropped together are the stems of one track.
    const audioFiles = files.filter((f) => f.type.startsWith('audio/'))
    if (audioFiles.length > 1) {
      await audio.useStems(audioFiles)
      state.audio.source = 'stems'
      refreshAll()
    }
    for (const file of files) {
      if (file.type.startsWith('image/')) await dropImage(file, e)
      else if (/\.json$/i.test(file.name)) await loadScene(file)
      else if (file.type.startsWith('audio/') && audioFiles.length === 1) {
        await audio.useFile(file)
        state.audio.source = 'file'
        refreshAll()
      }
    }
  })

  // The tab last open (Mode the first time).
  let first: Tab = 'Mode'
  try {
    const t = localStorage.getItem(OPEN_KEY) as Tab | null
    if (t && TABS.includes(t)) first = t
  } catch {}
  setOpen(first, true)
  return { open: (card) => setOpen(card as Tab, true), goTo }
}

const FOLD_KEY = 'lyria-type:folds'
/** Which mode sections were left open or folded (by `mode:title`). */
function foldState(): Record<string, boolean> {
  try {
    return JSON.parse(localStorage.getItem(FOLD_KEY) ?? '{}')
  } catch {
    return {}
  }
}

const keySlug = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
/** The saved preset whose key is `key`, by name. */
function getSavedName(modeId: string, key: string) {
  return savedNamesOf(modeId).find((n) => `saved-${modeId}-${keySlug(n)}` === key)
}

/** Controls shown only while another has a given value (ParamDef.showIf), re-checked on every change. */
const conditional = new Set<{ binding: { hidden: boolean }; values: Record<string, any>; key: string; is: string[] }>()
function updateConditional() {
  for (const c of conditional) c.binding.hidden = !c.is.includes(String(c.values[c.key]))
}

/** `key` as the param `own` declared it: the values key ending in it that shares the most of own's prefix. */
function resolveKey(values: Record<string, any>, own: string, key: string) {
  let best = key, score = -1
  for (const k of Object.keys(values)) {
    if (k !== key && !k.endsWith(`_${key}`)) continue
    let n = 0
    while (n < k.length && k[n] === own[n]) n++
    if (n > score) { score = n; best = k }
  }
  return best
}

// Undo, per group of settings: each group keeps the values its settings had before each change (a
// slider drag counts once, when let go), kept across re-renders. Its title bar's ↶ steps back.
const undoHistory = new Map<string, { values: Record<string, any>; key: string; before: unknown }[]>()
/** What each setting was last set to (by the panel or elsewhere): where its next change starts from. */
const committed = new Map<Record<string, any>, Map<string, { value: unknown }>>()
const committedFor = (values: Record<string, any>, key: string) => {
  const byKey = committed.get(values) ?? committed.set(values, new Map()).get(values)!
  return byKey.get(key) ?? byKey.set(key, { value: values[key] }).get(key)!
}
function resyncUndo() {
  for (const [values, byKey] of committed) for (const [key, c] of byKey) c.value = values[key]
}

function addSchema(folder: FolderApi | Pane, schema: ParamSchema, values: Record<string, any>, onChange?: (key: string) => void, undoKey?: string) {
  const bindings = new Map<string, { refresh(): void }>()
  const history = undoKey ? (undoHistory.get(undoKey) ?? undoHistory.set(undoKey, []).get(undoKey)!) : null
  let undoBtn: HTMLButtonElement | null = null
  const showUndo = () => {
    if (!undoBtn || !history) return
    undoBtn.disabled = !history.length
    undoBtn.title = history.length ? `Undo the last change in ${'title' in folder ? folder.title : 'here'} (${history.length})` : 'Nothing to undo here'
  }
  for (const [key, def] of Object.entries(schema)) {
    if (!def || (def.type === 'text' && !def.show)) continue
    const opts: Record<string, unknown> = { label: def.label ?? key }
    if (def.type === 'number') Object.assign(opts, { min: def.min, max: def.max, step: def.step })
    if (def.type === 'select') opts.options = def.options
    const binding = folder.addBinding(values, key, opts)
    bindings.set(key, binding)
    const last = committedFor(values, key)
    last.value = values[key]
    binding.on('change', (ev) => {
      updateConditional()
      onChange?.(key)
      // Once the change is finished, remember where it came from.
      if (history && ev.last && values[key] !== last.value) {
        history.push({ values, key, before: last.value })
        if (history.length > 100) history.shift()
        last.value = values[key]
        showUndo()
      }
    })
    if (def.showIf) conditional.add({ binding, values, key: resolveKey(values, key, def.showIf.key), is: ([] as string[]).concat(def.showIf.is) })
  }
  if (history && bindings.size) {
    // ↶ in the group's title bar (clicking it doesn't fold the group).
    const title = folder.element.querySelector<HTMLElement>('.tp-fldv_b')
    undoBtn = document.createElement('button')
    undoBtn.className = 'undo-group'
    undoBtn.textContent = '↶'
    for (const ev of ['pointerdown', 'mousedown'] as const) undoBtn.addEventListener(ev, (e) => e.stopPropagation())
    undoBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      e.preventDefault()
      const step = history.pop()
      if (step) {
        step.values[step.key] = step.before
        committedFor(step.values, step.key).value = step.before
        bindings.get(step.key)?.refresh()
        updateConditional()
        onChange?.(step.key)
      }
      showUndo()
    })
    title?.appendChild(undoBtn)
    showUndo()
  }
  updateConditional()
}

function hiddenInput(accept: string, onFile: (f: File) => void, onFiles?: (f: File[]) => void) {
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = accept
  input.multiple = !!onFiles
  input.addEventListener('change', () => {
    const files = [...(input.files ?? [])]
    if (onFiles && files.length) onFiles(files)
    else if (files[0]) onFile(files[0])
    input.value = ''
  })
  return input
}
