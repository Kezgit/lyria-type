import type { ModePreset } from '../types'

// Starting points spanning the range of the mode. Each overrides the defaults.
export const hazePresets: Record<string, ModePreset> = {
  Reference: { params: {} },

  Watercolour: {
    params: {
      form: 'watercolour', gradient: 'radial', palette: 'google-soft', blend: 'multiply', grouping: 'word',
      blobSize: 1.5, softness: 0.35, blobGrain: 0.5,
      textBlur: 2.5, bleed: 0.2, release: 2.2, filmGrain: 0.05,
    },
  },

  'Bokeh night': {
    params: {
      form: 'bokeh', gradient: 'radial', palette: 'google', blend: 'additive',
      blobSize: 1.4, softness: 0.4, blobOpacity: 0.75,
      textBlur: 6, glow: 0.5, release: 1.6, filmGrain: 0.04,
    },
    // Additive light needs a dark page to read.
    background: '#121317',
    ink: '#f8f9fc',
  },

  Smoke: {
    params: {
      form: 'smoke', gradient: 'linear', palette: 'google-deep', grouping: 'word',
      blobSize: 2, softness: 0.3,
      textBlur: 8, attack: 0.12, release: 2.6, filmGrain: 0.07,
    },
  },

  Opal: {
    params: {
      form: 'orb', gradient: 'conic', palette: 'google-soft', grouping: 'word',
      blobSize: 1.7, softness: 0.6,
      textBlur: 4, glow: 0.3, filmGrain: 0.03,
    },
  },

  'Ink bleed': {
    params: {
      form: 'bleed', palette: 'google-deep', grouping: 'glyph', density: 0.3,
      textFade: 0.1, textBlur: 2.5, bleed: 0.8, glow: 0.8,
      release: 2, filmGrain: 0.06,
    },
  },

  Comet: {
    params: {
      form: 'smear', gradient: 'linear', palette: 'google', grouping: 'word',
      blobSize: 1.6, softness: 0.5,
      textBlur: 6, attack: 0.03, release: 0.9,
    },
  },

  Garden: {
    params: {
      form: 'mixed', gradient: 'radial', palette: 'google', grouping: 'glyph', density: 0.3,
      blobSize: 1.6, softness: 0.5, wobble: 0.25, filmGrain: 0.03,
    },
  },
}
