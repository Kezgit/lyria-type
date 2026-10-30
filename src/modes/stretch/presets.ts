import type { ModePreset } from '../types'

// Each overrides the Stretch defaults; the first is the defaults themselves.
export const stretchPresets: Record<string, ModePreset> = {
  // Lines pulled out to the right into long bars; blue pulses travel along
  // them on the beat, letters stay grey.
  'Sound feel': { params: {}, background: '#000000', fontId: 'google-sans-flex', fontSize: 110 },

  // Sound feel, but each line pulls out in its own Google hue.
  'Google lines': {
    params: { colourBy: 'cycle', grouping: 'line', letterColor: '#f8f9fc' },
    background: '#000000',
    fontId: 'google-sans-flex',
    fontSize: 110,
  },

  // Every glyph in a random Google hue, extruding up and down.
  Confetti: {
    params: {
      colourBy: 'random', grouping: 'glyph', axis: 'vertical', sided: 'both',
      speed: 240, audioSpeed: 300, trail: 0.45, spread: 0.5, smear: 1.5, base: 0, letterColor: '#f8f9fc',
    },
    background: '#000000',
    fontId: 'google-sans-flex',
    fontSize: 110,
  },

  // Vertical, both ways: words glow pale blue on hits, deep blue when quiet.
  Amsterdam: {
    params: {
      ramp: 'google-blue', axis: 'vertical', sided: 'both', grouping: 'word',
      speed: 200, audioSpeed: 260, trail: 0.3, spread: 1, smear: 1.5,
      base: 0, bands: 0.55, hits: 1, release: 0.5, letters: 'ramp',
    },
    background: '#000000',
    fontId: 'google-sans-flex',
    fontSize: 120,
  },

  // Everything pours outward from the centre.
  Solar: {
    params: {
      ramp: 'google-yellow', axis: 'radial', sided: 'forward', grouping: 'word',
      speed: 260, audioSpeed: 320, trail: 0.45, spread: 0.6, smear: 1.5, base: 0,
      letterColor: '#fdfd6d',
    },
    background: '#000000',
    fontId: 'google-sans-flex',
    fontSize: 90,
  },

  // Letters drip downward; each glyph carries its own pulse.
  Drip: {
    params: {
      ramp: 'google-grey', axis: 'vertical', sided: 'reverse', grouping: 'glyph',
      speed: 220, audioSpeed: 260, trail: 2.5, spread: 0.2, density: 0.3, letterColor: '#ffffff',
    },
    background: '#000000',
    fontId: 'google-sans-flex',
    fontSize: 100,
  },

  // Fast, short, both ways.
  'Acid echo': {
    params: {
      ramp: 'google-green', axis: 'horizontal', sided: 'both', grouping: 'word',
      speed: 900, audioSpeed: 600, trail: 0.35, spread: 0.6, release: 0.2, base: 0, letterColor: '#bff3b9',
    },
    background: '#000000',
    fontId: 'google-sans-flex',
    fontSize: 110,
  },

  // Light version: dark blue type pulled out into pale blue on a light page.
  Paper: {
    params: {
      ramp: 'google-blue-light', axis: 'horizontal', sided: 'both', grouping: 'line',
      speed: 600, audioSpeed: 300, trail: 1.4, spread: 0.8, letterColor: '#121317', grain: 0.04,
    },
    background: '#f8f9fc',
  },

  Infrared: {
    params: {
      ramp: 'google-red', axis: 'vertical', sided: 'both', grouping: 'glyph',
      speed: 260, audioSpeed: 320, trail: 0.5, spread: 0.6, base: 0, letterColor: '#ffdeec',
    },
    background: '#000000',
    fontId: 'google-sans-flex',
    fontSize: 130,
  },
}
