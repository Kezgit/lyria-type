// Playing the text from the computer keyboard: pressing a key plays every
// letter on the stage that matches it, as its own layer would (a kick
// letter thumps, a hat letter flutters, a pad letter holds while the key is
// down), like a piano whose keys are the letters. Typing into the panel is
// left alone.

export const manualKeys = {
  /** Set each frame by the Orchestra mode (keyboard on, mode showing). */
  enabled: false,
  /** Keys pressed since the last frame, lower-case. */
  presses: [] as string[],
  /** Keys held down now. */
  held: new Set<string>(),
}

const typing = (t: EventTarget | null) =>
  t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))

let installed = false

export function listenForKeys() {
  if (installed || typeof window === 'undefined') return
  installed = true
  window.addEventListener('keydown', (e) => {
    if (!manualKeys.enabled || e.metaKey || e.ctrlKey || e.altKey || typing(e.target) || e.key.length !== 1) return
    const k = e.key.toLowerCase()
    // A held key repeats; only its first press plays.
    if (!e.repeat && !manualKeys.held.has(k)) manualKeys.presses.push(k)
    manualKeys.held.add(k)
    if (k === ' ') e.preventDefault()
  })
  window.addEventListener('keyup', (e) => manualKeys.held.delete(e.key.toLowerCase()))
  window.addEventListener('blur', () => manualKeys.held.clear())
}
