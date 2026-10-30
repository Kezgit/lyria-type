import type { DropSettings } from '../engine/dropFx'
import { defaults } from './params'
import { layouts } from '../layout'
import { modes } from '../modes'

// Single source of truth for everything the user can change. Plain mutable
// object: the UI writes into it, the engine reads from it every frame. Anything
// that needs to react to a change (re-shaping text, swapping modes) subscribes.

export type AudioSourceKind = 'demo' | 'file' | 'stems' | 'mic'

export const state = {
  text: 'Lyria 4\nwalls of colour\nstay true',
  fontId: 'google-sans-flex',
  fontSize: 72,
  tracking: 0,
  /** Long lines wrap at a space past this share of the view's width (0 = only where the text breaks). */
  wrap: 0.8,
  background: '#ffffff',
  ink: '#f8f9fc',

  layoutId: 'block',
  layoutParams: Object.fromEntries(layouts.map((l) => [l.id, defaults(l.params)])) as Record<string, Record<string, any>>,

  modeId: 'orchestra',
  modeParams: Object.fromEntries(modes.map((m) => [m.id, defaults(m.params)])) as Record<string, Record<string, any>>,

  /**
   * Letters given to instruments on the stage ("kick:0-4;lead:9", by letter index), shared by every
   * mode: assigned letters play with their instrument and take its colour.
   */
  letterParts: '',

  /** Images dropped on the stage: where their colours go, how they arrive (engine/dropFx.ts). */
  drop: { target: 'gradient', style: 'ripple', speed: 520, hold: 3, fade: 2.5, warp: 1 } as DropSettings,

  /** The camera on the picture: zoom about the frame's centre, then pan (frame widths / heights). The preview and exports both show it. */
  view: { zoom: 1, x: 0, y: 0 },

  audio: {
    source: 'demo' as AudioSourceKind,
    sensitivity: 1,
    playing: false,
  },
}

export type AppState = typeof state

type Topic = 'text' | 'mode' | 'audio' | 'fonts' | 'scene' | 'params'
const listeners = new Map<Topic, Set<() => void>>()

export function on(topic: Topic, fn: () => void): () => void {
  if (!listeners.has(topic)) listeners.set(topic, new Set())
  listeners.get(topic)!.add(fn)
  return () => listeners.get(topic)!.delete(fn)
}

export function emit(topic: Topic) {
  listeners.get(topic)?.forEach((fn) => fn())
}
