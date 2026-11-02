import type { SubMode } from './index'
import { dots } from './dots'

// Manual: compose by hand with what Dots is made of. A blank page (or the
// song's Dots picture underneath), and dots, soft dots, ghosts, streaks and
// blobs placed, moved, scaled and turned on the stage (ui/compose.ts). Each
// placed mark belongs to a part of the music and lives with it: it reads as
// loud as its part, pops on its hits and breathes with it, in the palette,
// haze and shape Dots would give it. Everything else is Dots' own settings.

const params = {
  canvas: { type: 'select', value: 'blank', label: 'canvas', options: { blank: 'blank', 'over the song': 'song' } },
  react: { type: 'number', value: 1, min: 0, max: 2, step: 0.01, label: 'follows its part' },
  pop: { type: 'number', value: 0.6, min: 0, max: 2, step: 0.01, label: 'pops on hits' },
  breathe: { type: 'number', value: 0.3, min: 0, max: 2, step: 0.01, label: 'breathes' },
  marks: { type: 'text', value: '', label: 'placed marks' },
} as const

const base = dots.presets.Default

export const manual: SubMode = {
  id: 'manual',
  label: 'Manual',
  params: { ...params, ...dots.params },
  groups: { Canvas: ['canvas', 'react', 'pop', 'breathe'], ...dots.groups },
  presets: {
    Blank: { ...base, params: { ...base.params, canvas: 'blank' } },
    'Over the song': { ...base, params: { ...base.params, canvas: 'song', ghost: 0.35 } },
  },
  create: dots.create,
}
