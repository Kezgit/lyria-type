import { drops } from '../app/drops'
import type { BarLayer } from './barLayer'

// Images dropped on the stage, in every mode, applied after the mode has drawn
// its frame (so it works the same on dots, bars, haze and trails):
//   wipe    the image's colours sweep out from where it landed across the
//           whole frame (most prominent at the drop point, through the rest),
//           hold `hold` s, then fade back dot by dot over `fade` s to the
//           mode's own colours (the drop is then gone)
//   ripple  a band runs out with the wipe: dots and bars swell and light as
//           it passes (the image is taken in)
//   warp    instead, as the image lands everything near the front is pulled
//           in toward the drop point and drawn out into streaks along the
//           pull, as if its colours were being ripped into the music
//   target  dots (crisp marks), the moving gradient (haze, trails), or both

export interface DropSettings {
  target: 'dots' | 'gradient' | 'both'
  style: 'ripple' | 'warp'
  /** px/s the wipe travels. */
  speed: number
  /** s the colours hold once the wipe has crossed the frame. */
  hold: number
  /** s they take to fade back. */
  fade: number
  /** How hard the warp pulls, 0..2. */
  warp: number
}

/** Gradient rows the drops' colours take on the bar layers (one per drop). */
export const DROP_ROW = 60
const RING = 42
const WARP_BAND = 160

const clamp01 = (v: number) => Math.min(1, Math.max(0, v))
const smooth01 = (x: number) => { const t = clamp01(x); return t * t * (3 - 2 * t) }
/** A fixed 0..1 per spot, so the fade breaks up dot by dot the same way every frame. */
const shareAt = (x: number, y: number) => Math.abs((Math.sin(Math.round(x / 4) * 12.9898 + Math.round(y / 4) * 78.233) * 43758.5453) % 1)

export interface ActiveDrop {
  x: number
  y: number
  /** Index among the drops (its gradient row is DROP_ROW + slot). */
  slot: number
  colours: string[]
  /** How far the wipe has run, px; and how far it must run to cross the frame. */
  ran: number
  reach: number
  /** 0..1: how much of the frame still shows its colours (fading back). */
  amount: number
  /** 0..1: how strong the ripple / warp is now (gone once the wipe has crossed). */
  front: number
}

export class DropFx {
  active: ActiveDrop[] = []
  private settings: DropSettings | null = null

  /** This frame's drops (finished ones are let go). */
  frame(width: number, height: number, s: DropSettings) {
    this.settings = s
    const now = performance.now() / 1000
    const speed = Math.max(20, s.speed)
    // Drops that have faded right back are gone.
    for (let i = drops.length - 1; i >= 0; i--) {
      const d = drops[i]
      const reach = this.reachFrom(d.x, d.y, width, height)
      if (now - d.at > reach / speed + s.hold + s.fade + 0.1) drops.splice(i, 1)
    }
    this.active = drops.map((d, slot) => {
      const reach = this.reachFrom(d.x, d.y, width, height)
      const age = now - d.at
      const ran = age * speed
      const wiped = reach / speed
      return {
        x: d.x, y: d.y, slot, colours: d.colours, ran, reach,
        amount: 1 - smooth01((age - wiped - s.hold) / Math.max(0.05, s.fade)),
        front: Math.max(0, 1 - ran / (reach * 1.05)),
      }
    })
  }

  /** Far enough to cross the frame from the drop point (to its furthest corner). */
  private reachFrom(x: number, y: number, w: number, h: number) {
    return Math.max(...[[-w / 2, -h / 2], [w / 2, -h / 2], [-w / 2, h / 2], [w / 2, h / 2]].map(([cx, cy]) => Math.hypot(cx - x, cy - y)), 1)
  }

  get any() {
    return this.active.length > 0
  }

  /** Whether a layer of this kind ('dots' or 'gradient') takes the drops' colours. */
  colours(kind: 'dots' | 'gradient') {
    const t = this.settings?.target ?? 'gradient'
    return t === 'both' || t === kind
  }

  /** The drops' colours as gradient rows on a bar layer. */
  rows(layer: BarLayer) {
    for (const d of this.active) {
      const stops = d.colours.length > 1 ? d.colours : [d.colours[0] ?? '#888888', d.colours[0] ?? '#888888']
      layer.setGradient(stops, DROP_ROW + d.slot)
    }
  }

  /**
   * What the drops do to a bar layer's frame (every bar pushed this frame): its colours where the wipe has
   * passed (`colour`), and the ripple or warp as it goes.
   */
  applyBars(layer: BarLayer, colour: boolean) {
    const s = this.settings
    if (!s || !this.active.length || !layer.count) return
    if (colour) this.rows(layer)
    const { pos, grad, style } = layer
    for (let i = 0; i < layer.count; i++) {
      const o = i * 4
      for (const d of this.active) {
        let x = pos[o], y = pos[o + 1]
        const dx = x - d.x, dy = y - d.y
        const dist = Math.hypot(dx, dy) || 1e-3
        // The wipe: its colours where it has passed, fading back dot by dot.
        if (colour && dist < d.ran && shareAt(x, y) < d.amount) {
          style[o + 2] = DROP_ROW + d.slot
          grad[o] = grad[o + 1] = clamp01(dist / d.reach)
        }
        if (d.front <= 0) continue
        if (s.style === 'warp') {
          // Pulled in toward the drop point just ahead of the front, drawn out along the pull.
          const k = Math.exp(-(((dist - d.ran) / WARP_BAND) ** 2)) * d.front * s.warp
          if (k > 0.01) {
            const pull = Math.min(dist * 0.6, 90 * k)
            x -= (dx / dist) * pull
            y -= (dy / dist) * pull
            pos[o] = x; pos[o + 1] = y
            pos[o + 2] += pull * 1.6
            style[o] = Math.atan2(dy, dx)
            grad[o + 2] = Math.min(1, grad[o + 2] * (1 - 0.35 * k) + 0.2 * k)
          }
        } else {
          // The ripple: a band that swells and lights as it passes.
          const k = Math.exp(-(((dist - d.ran) / RING) ** 2)) * d.front
          if (k > 0.01) {
            pos[o + 2] *= 1 + 0.9 * k
            pos[o + 3] *= 1 + 0.9 * k
            style[o + 3] *= 1 + 0.9 * k
            grad[o + 2] = Math.max(grad[o + 2], k)
          }
        }
      }
    }
  }

  /** How much a hidden dot at (x, y) should show for the drops (the ripple passing, the colours held). */
  reveal(x: number, y: number) {
    let v = 0
    for (const d of this.active) {
      const dist = Math.hypot(x - d.x, y - d.y)
      v = Math.max(v, Math.exp(-(((dist - d.ran) / RING) ** 2)) * d.front)
      if (dist < d.ran && shareAt(x, y) < d.amount) v = Math.max(v, 0.3)
    }
    return v
  }
}

/** One for the page (the engine applies it; modes may ask what's showing). */
export const dropFx = new DropFx()
