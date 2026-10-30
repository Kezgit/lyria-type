import type { ModePreset } from '../types'

// Each overrides the Field defaults; the first is the defaults themselves.
export const fieldPresets: Record<string, ModePreset> = {
  // Colour rising off the letters like warm air.
  Rising: { params: {} },

  // Slow, thick ink that pools and mixes in place.
  Ink: {
    params: {
      palette: 'google-deep', flow: 25, eddy: 5, turbulence: 0.05, drift: 'none',
      diffusion: 2.5, fade: 9, inkStrength: 0.25, fieldStrength: 1.2, release: 1.2,
    },
  },

  // Fast, tight eddies that tear colour into ribbons.
  Storm: {
    params: {
      flow: 260, eddy: 1.6, turbulence: 0.6, drift: 'none', bassFlow: 3,
      diffusion: 0.6, fade: 1.8, kick: 300, density: 0.25,
    },
  },

  // Every hit pushes the field outward from the centre.
  Bloom: {
    params: {
      palette: 'google-soft', flow: 40, eddy: 4, drift: 'outward', driftSpeed: 30, kick: 700,
      diffusion: 1.6, fade: 2.5, fieldStrength: 1.8,
    },
  },

  // Colour runs down from the letters.
  Rain: {
    params: {
      flow: 30, eddy: 2, turbulence: 0.1, drift: 'down', driftSpeed: 120,
      diffusion: 0.5, fade: 2.2, inkSize: 0.08, inkStrength: 0.5,
    },
  },

  // On black, colours read as light.
  Night: {
    params: { flow: 90, eddy: 3, drift: 'up', driftSpeed: 35, fieldStrength: 1.8, fade: 4 },
    background: '#121317',
    ink: '#f8f9fc',
  },
}
