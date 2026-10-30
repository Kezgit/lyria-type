import type { ModePreset } from '../types'

// Each overrides the Pulse defaults; the first is the defaults themselves.
export const pulsePresets: Record<string, ModePreset> = {
  // Words swell into colour; beats ripple outward through them as lighter rings.
  Ripple: { params: {} },

  // Bands of the palette's colours travelling outward through every pulse.
  'Colour cycle': {
    params: { look: 'cycle', rippleSpeed: 90, wavelength: 60, rings: 0, lightness: 0.7, swell: 30, fade: 2.6 },
  },

  // Slow green colour bands over a darker, level-led ripple; no hit pulses.
  'Green cycle': {
    params: { look: 'cycle', ramp: 'google-green', rippleSpeed: 115, rippleBase: 0.52, rippleLevel: 0.36, rippleHits: 0, lightness: 0.46 },
  },

  // One gradient map for every hit, like Stretch's bars.
  'Gradient map': {
    params: { look: 'ramp', ramp: 'google-blue-light', rippleSpeed: 220, rippleBase: 0.15, rings: 0.1, swell: 35, fade: 2.4 },
  },

  // Plain merging colour, no ripples.
  Breathe: { params: { look: 'flat' } },

  // Single letters: small, quick pops that bead together.
  Pop: {
    params: {
      grouping: 'glyph', density: 0.3, swell: 25, pulse: 420, pulseDecay: 0.15,
      diffusion: 1, fade: 1.4, inkSize: 0.04, release: 0.2,
    },
  },

  // Slow, wide blooms that pool into one large wash.
  Bloom: {
    params: {
      palette: 'google-soft', swell: 80, pulse: 180, pulseDecay: 0.6, diffusion: 2.6,
      fade: 4.5, fieldStrength: 1.8, release: 0.8, textBlur: 8,
    },
  },

  // Whole lines thump outward on the beat.
  Thump: {
    params: {
      grouping: 'line', density: 0.4, swell: 15, pulse: 700, pulseDecay: 0.18, bassSwell: 3,
      diffusion: 1.2, fade: 1.6, inkStrength: 0.45,
    },
  },

  // Deep ink that holds its shape longer before it softens.
  Ink: {
    params: {
      palette: 'google-deep', swell: 30, pulse: 200, wobble: 25, diffusion: 0.7,
      fade: 3, inkStrength: 0.8, fieldStrength: 2.2, textFade: 1,
    },
  },
}
