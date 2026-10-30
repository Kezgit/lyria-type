import { Pane, type FolderApi } from 'tweakpane'
import { defaults, type ParamSchema } from '../app/params'
import { emit, on, state } from '../app/state'
import type { AudioEngine } from '../audio/audioEngine'
import { layouts, getLayout } from '../layout'
import { modes, getMode } from '../modes'
import { addFontFile, addGoogleFont, addLocalFont, listFonts } from '../text/fonts/registry'
import { downloadScene, loadSceneFile } from '../app/scene'
import type { Engine } from '../engine/engine'
import { EXPORT_OPTIONS, runExport, type ExportKind } from '../export/export'
import { playhead, trackFor } from '../app/keyframes'
import { mountColourPlace, mountGradientTools } from './gradientTools'
import { attachView } from './view'
import { buildToolbar } from './toolbar'
import { clearSession, pauseAutosave } from '../app/session'
import { addDrop, clearDrops, imageColours } from '../app/drops'
import { applySaved, deletePreset, getSaved, savePreset, savedNames as savedNamesOf, setThumb, syncPresets } from '../app/userPresets'
import { buildPresetsCard, builtIns, captureThumb, thumbMaker, type PresetRef } from './presetsCard'
import { attachTips } from './tips'
import { buildStemMeters } from './stemColours'
import { buildRack } from './rack'
import type { ModeDefinition, ModePreset } from '../modes/types'

// The panel: cards floating over the stage, each a pill that opens into its
// own window. Text, Scene and Instruments on the left; Export, Mode, Presets
// and Audio stacked on the right, where an open card pushes the ones below it
// down. Mode opens on load; Esc closes them all.
// Each card holds Tweakpanes; mode and layout controls are generated from
// their param schemas.

const LEFT = ['Text', 'Scene', 'Instruments'] as const
const RIGHT = ['Export', 'Mode', 'Presets', 'Audio'] as const
const TABS = [...LEFT, ...RIGHT]
type Tab = (typeof TABS)[number]
const OPEN_KEY = 'lyria-type:open-cards'
const CHEVRON = '<svg viewBox="0 0 12 12" width="10" height="10" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 4.5l3 3 3-3"/></svg>'

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

  // --- Cards -----------------------------------------------------------------
  const pages = new Map<Tab, HTMLElement>()
  const cards = new Map<Tab, HTMLElement>()
  for (const [side, tabs] of [['left', LEFT], ['right', RIGHT]] as const) {
    const dock = document.createElement('div')
    dock.className = `dock dock-${side}`
    root.appendChild(dock)
    for (const tab of tabs) {
      const card = document.createElement('section')
      card.className = `card card-${tab.toLowerCase()}`
      const pill = document.createElement('button')
      pill.className = 'pill'
      pill.innerHTML = `<span class="pill-label">${tab}</span>${CHEVRON}`
      pill.addEventListener('click', () => setOpen(tab, !card.classList.contains('open')))
      const page = document.createElement('div')
      page.className = 'tab-page'
      page.hidden = true
      card.append(pill, page)
      dock.appendChild(card)
      pages.set(tab, page)
      cards.set(tab, card)
    }
  }
  function setOpen(tab: Tab, open: boolean) {
    cards.get(tab)!.classList.toggle('open', open)
    pages.get(tab)!.hidden = !open
    try {
      localStorage.setItem(OPEN_KEY, JSON.stringify(TABS.filter((t) => cards.get(t)!.classList.contains('open'))))
    } catch {}
  }
  attachTips(root)
  // Esc closes every open card (unless typing, or a pick menu is open).
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || /^(INPUT|TEXTAREA|SELECT)$/.test((e.target as HTMLElement)?.tagName ?? '')) return
    for (const t of TABS) if (cards.get(t)!.classList.contains('open')) setOpen(t, false)
  })
  /** The Mode card, at a group: opened (with any group it sits in), scrolled to and flashed. */
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

  // --- Text ------------------------------------------------------------------
  const textarea = document.createElement('textarea')
  textarea.className = 'copy'
  textarea.spellcheck = false
  textarea.value = state.text
  textarea.addEventListener('input', () => {
    state.text = textarea.value
    emit('text')
  })
  pages.get('Text')!.appendChild(textarea)

  // Type test: types prompts after the text, a letter at a time like a person (with the odd pause),
  // holds, deletes them, and moves on, so the typing look can be watched without typing. Stopping
  // puts the text back as it was; nothing is saved while it runs.
  const TEST_PROMPTS = [
    'a warm bossa groove with brushed drums',
    'deep round bass and soft rhodes chords drifting over a slow summer evening',
    'glitchy hats',
    'big cinematic strings rising into a bright choir',
    'lofi piano, vinyl crackle, rain on the window',
    'four on the floor kick with a rolling acid bassline that never stops moving',
  ]
  const testBtn = document.createElement('button')
  testBtn.className = 'type-test'
  testBtn.textContent = 'Type test'
  testBtn.title = 'Type prompts after the text, then delete them, over and over, to watch the typing look'
  pages.get('Text')!.appendChild(testBtn)
  let testRun = 0
  let testOriginal = ''
  const setText = (t: string) => {
    state.text = t
    textarea.value = t
    emit('text')
  }
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
  const stopTest = () => {
    testRun++
    testBtn.textContent = 'Type test'
    testBtn.classList.remove('on')
    setText(testOriginal)
    pauseAutosave(false)
  }
  testBtn.addEventListener('click', async () => {
    if (testBtn.classList.contains('on')) return stopTest()
    const run = ++testRun
    testOriginal = state.text
    pauseAutosave(true)
    testBtn.textContent = 'Stop type test'
    testBtn.classList.add('on')
    const alive = () => run === testRun
    for (let k = 0; alive(); k++) {
      const prompt = TEST_PROMPTS[k % TEST_PROMPTS.length]
      const start = testOriginal.replace(/\s+$/, '') + '\n'
      for (let i = 1; i <= prompt.length && alive(); i++) {
        setText(start + prompt.slice(0, i))
        const ch = prompt[i - 1]
        // Quick within words, a beat longer after a space or comma, now and then a hesitation.
        await wait(55 + Math.random() * 70 + (ch === ' ' ? 90 : ch === ',' ? 220 : 0) + (Math.random() < 0.06 ? 350 : 0))
      }
      await wait(1600)
      for (let i = prompt.length - 1; i >= 0 && alive(); i--) {
        setText(start + prompt.slice(0, i))
        await wait(22 + Math.random() * 18)
      }
      if (alive()) setText(testOriginal)
      await wait(700)
    }
  })

  const textPane = paneIn('Text')
  const fType = textPane.addFolder({ title: 'Type' })
  let fontBinding = addFontBinding()
  function addFontBinding() {
    const options = Object.fromEntries(listFonts().map((font) => [font.label, font.id]))
    return fType.addBinding(state, 'fontId', { label: 'font', options, index: 0 }).on('change', () => emit('text'))
  }
  on('fonts', () => {
    fontBinding.dispose()
    fontBinding = addFontBinding()
  })
  fType.addBinding(state, 'fontSize', { label: 'size', min: 8, max: 300, step: 1 }).on('change', () => emit('text'))
  fType.addBinding(state, 'tracking', { min: -0.2, max: 1, step: 0.005 }).on('change', () => emit('text'))
  fType.addBinding(state, 'wrap', { label: 'wrap width (0 = off)', min: 0, max: 1, step: 0.01 }).on('change', () => emit('text'))

  const fColour = textPane.addFolder({ title: 'Colour' })
  fColour.addBinding(state, 'ink')
  fColour.addBinding(state, 'background')

  const fFonts = textPane.addFolder({ title: 'Add fonts', expanded: false })
  const fontInput = hiddenInput('.ttf,.otf,.woff,.woff2', (file) => addFont(() => addFontFile(file)))
  fFonts.addButton({ title: 'Add font file…' }).on('click', () => fontInput.click())
  const fontQuery = { name: '' }
  fFonts.addBinding(fontQuery, 'name', { label: 'font name' })
  fFonts.addButton({ title: 'Add Google Font' }).on('click', () => addFont(() => addGoogleFont(fontQuery.name)))
  fFonts.addButton({ title: 'Add installed font' }).on('click', () => addFont(() => addLocalFont(fontQuery.name)))

  async function addFont(load: () => Promise<{ id: string }>) {
    try {
      const font = await load()
      state.fontId = font.id
      emit('fonts')
      emit('text')
    } catch (err) {
      alert((err as Error).message)
    }
  }

  // --- Layout (in the Text tab) -----------------------------------------------
  const layoutPane = textPane.addFolder({ title: 'Layout' })
  layoutPane
    .addBinding(state, 'layoutId', { label: 'layout', options: Object.fromEntries(layouts.map((l) => [l.label, l.id])) })
    .on('change', () => renderLayoutParams())
  let layoutParams: FolderApi | null = null
  function renderLayoutParams() {
    layoutParams?.dispose()
    const def = getLayout(state.layoutId)
    layoutParams = layoutPane.addFolder({ title: def.label })
    // (The Text tab shows the block's alignment too: keep it in step.)
    addSchema(layoutParams, def.params, state.layoutParams[def.id], () => refreshAll(), `layout:${def.id}`)
  }
  renderLayoutParams()

  // --- Mode ------------------------------------------------------------------
  const modePane = paneIn('Mode')
  modePane
    .addBinding(state, 'modeId', { label: 'mode', options: Object.fromEntries(modes.map((m) => [m.label, m.id])) })
    // A scene load or a preset updates the dropdown too; only a user's pick applies the first preset.
    .on('change', () => renderModeParams(!loadingScene && !applying))
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
    Object.assign(state.modeParams[def.id], defaults(def.params), preset.params)
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
    // Some keys (a sub-mode picker) change which controls exist: re-render on
    // change. A user's pick of a sub-mode starts from its first preset.
    const onChange = (key: string) => {
      if (!def.rebuildOn?.includes(key)) return
      const fresh = pickers.includes(key) && !applying && !loadingScene
      queueMicrotask(() => renderModeParams(fresh))
    }
    addSchema(folder, Object.fromEntries(pickers.map((k) => [k, def.params[k]])), values, onChange)
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
      for (const [title, keys] of Object.entries(groups)) {
        const sub = folder.addFolder({ title })
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
  // The instruments: their rack in its own card (every mode).
  buildRack(pages.get('Instruments')!, () => !pages.get('Instruments')!.hidden)

  // Images dropped on the stage (every mode): where their colours go and how they arrive (engine/dropFx.ts).
  const dropPane = paneIn('Scene')
  const dropFolder = dropPane.addFolder({ title: 'Image drop', expanded: false })
  dropFolder.addBinding(state.drop, 'target', { label: 'colours go to', options: { 'The moving gradient (haze, trails)': 'gradient', 'The dots': 'dots', Both: 'both' } })
  dropFolder.addBinding(state.drop, 'style', { label: 'arrives as', options: { Ripple: 'ripple', 'Warp (pulled in)': 'warp' } })
  dropFolder.addBinding(state.drop, 'warp', { label: 'warp strength', min: 0, max: 2, step: 0.01 })
  dropFolder.addBinding(state.drop, 'speed', { label: 'wipe speed (px/s)', min: 60, max: 3000, step: 10 })
  dropFolder.addBinding(state.drop, 'hold', { label: 'colours hold (s)', min: 0, max: 30, step: 0.1 })
  dropFolder.addBinding(state.drop, 'fade', { label: 'fade back (s)', min: 0.1, max: 20, step: 0.1 })
  dropFolder.addButton({ title: 'Clear dropped images' }).on('click', () => clearDrops())

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

  // --- Scene -------------------------------------------------------------------
  const scenePane = paneIn('Scene')
  const sceneInput = hiddenInput('.json,application/json', (file) => loadScene(file))
  scenePane.addButton({ title: 'Save scene (.json)' }).on('click', () => downloadScene())
  scenePane.addButton({ title: 'Load scene…' }).on('click', () => sceneInput.click())
  scenePane.addButton({ title: 'Start again from the defaults' }).on('click', () => {
    if (confirm('Start again from the default look? Your saved presets are kept.')) clearSession()
  })
  const hint = document.createElement('p')
  hint.className = 'hint'
  hint.textContent =
    'Your work saves as you go. Save scene keeps a copy as a file you can load later or share; drop one anywhere on the page to load it.'
  pages.get('Scene')!.appendChild(hint)
  // (The image drop settings sit after this.)
  pages.get('Scene')!.appendChild(dropPane.element)

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
    textarea.value = state.text
    renderLayoutParams()
    renderModeParams()
    refreshAll()
    loadingScene = false
  })

  // Drag & drop anywhere: fonts become fonts, audio becomes the source,
  // scene files load.
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
      else if (/\.(ttf|otf|woff2?)$/i.test(file.name)) await addFont(() => addFontFile(file))
      else if (file.type.startsWith('audio/') && audioFiles.length === 1) {
        await audio.useFile(file)
        state.audio.source = 'file'
        refreshAll()
      }
    }
  })

  // Cards open as last left, and Mode always.
  try {
    const open = JSON.parse(localStorage.getItem(OPEN_KEY) ?? '[]') as string[]
    for (const t of TABS) if (open.includes(t)) setOpen(t, true)
  } catch {}
  setOpen('Mode', true)
  return { open: (card) => setOpen(card as Tab, true), goTo }
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
