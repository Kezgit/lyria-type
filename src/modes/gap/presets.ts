import type { ModePreset } from '../types'

// Each overrides the Gap defaults; the first is the defaults themselves.
const poster = { background: '#ffffff', ink: '#1a1a1a', fontId: 'google-sans-flex' }

export const gapPresets: Record<string, ModePreset> = {
  // Hit letters push the line open and stream their trail into the gap.
  Stream: { params: {}, ...poster, fontSize: 90 },

  // Words letterspace out on the beat, every letter streaming into its gap.
  'Word stream': {
    params: { scope: 'word', gap: 1.2, vary: 0.2, density: 0.15, letters: 'hit', speed: 900, trail: 0.8 },
    ...poster,
    fontSize: 90,
  },

  // Both ways on black, Google hue per letter.
  'Google stream': {
    params: { side: 'both', colourBy: 'random', ramp: 'google-blue', letters: 'hit', gap: 2.5, smear: 2 },
    background: '#000000',
    ink: '#f8f9fc',
    fontId: 'google-sans-flex',
    fontSize: 100,
  },

  // The poster: grainy spectrum bars fill the gaps, left-set.
  Spectrum: {
    params: { variant: 'spectrum', anchor: 'left', gap: 2.5, density: 0.15 },
    ...poster,
    fontSize: 80,
  },

  // Bars the full line height, so stacked lines meet into blocks.
  'Spectrum blocks': {
    params: { variant: 'spectrum', anchor: 'left', gap: 3, barTop: 0.95, barBottom: -0.3, inset: 0, span: 10, vary: 0.8 },
    ...poster,
    fontSize: 80,
  },

  // Words letterspaced wide, spectrum between the letters.
  'Spectrum words': {
    params: { variant: 'spectrum', scope: 'word', gap: 1.4, vary: 0.1, density: 0.12, close: 1.2, span: 3 },
    ...poster,
    fontSize: 80,
  },

  // Spacing only: words breathe apart and back.
  Tracking: {
    params: { variant: 'track', scope: 'word', gap: 0.8, vary: 0.3, density: 0.2, open: 0.2, close: 0.9 },
    ...poster,
    fontSize: 80,
  },
}
