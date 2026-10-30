import { applyScene, exportScene } from './scene'

// The working session: everything as last left (text, type, colours, layout,
// every mode's settings), saved as you go and put back on load, so a reload,
// a rebuild or a code change never starts the look from scratch. Kept in
// localStorage and, while the dev server runs, presets/session.json.

const KEY = 'lyria-type:session'
const ENDPOINT = '/__session'

type Saved = ReturnType<typeof exportScene>

/** Put back the newest saved session (browser or project file). Resolves true if one was applied. */
export async function restoreSession(): Promise<boolean> {
  let local: Saved | null = null
  try {
    local = JSON.parse(localStorage.getItem(KEY) ?? 'null')
  } catch {}
  let file: Saved | null = null
  try {
    const res = await fetch(ENDPOINT)
    if (res.ok && res.headers.get('content-type')?.includes('json')) {
      const data = await res.json()
      if (data?.savedAt) file = data
    }
  } catch {}
  const best = [local, file].filter(Boolean).sort((a, b) => (b!.savedAt > a!.savedAt ? 1 : -1))[0]
  if (!best) return false
  try {
    const warnings = await applyScene(best)
    if (warnings.length) console.warn('Session:', warnings.join(' '))
    return true
  } catch {
    return false
  }
}

let timer = 0
/** While true (e.g. a typing test is running), nothing is saved. */
let paused = false

export function pauseAutosave(on: boolean) {
  paused = on
}

/** Save whenever anything changes (checked once a second). */
export function autosave() {
  let last = ''
  clearInterval(timer)
  timer = window.setInterval(() => {
    if (paused) return
    const scene = exportScene()
    const { savedAt: _, ...look } = scene
    const key = JSON.stringify(look)
    if (key === last) return
    last = key
    const body = JSON.stringify(scene, null, 2)
    try {
      localStorage.setItem(KEY, body)
    } catch {}
    fetch(ENDPOINT, { method: 'PUT', body }).catch(() => {})
  }, 1000)
}

/** Forget the session and start again from the defaults. */
export async function clearSession() {
  clearInterval(timer)
  try {
    localStorage.removeItem(KEY)
  } catch {}
  await fetch(ENDPOINT, { method: 'PUT', body: '{}' }).catch(() => {})
  location.reload()
}
