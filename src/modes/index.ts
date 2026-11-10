import { sequencer } from './sequencer'
import { stackedLine } from './stackedLine'
import type { ModeDefinition } from './types'

// The modes on offer: the Sequencer (Dots) and Stacked line (Soft Grid's soft blob lines). The other modes (Orchestra, Haze,
// Field, Pulse, Stretch, Gap, the type modes, Stencil) are on the full-app branch.
export const modes: ModeDefinition[] = [sequencer, stackedLine]

export function getMode(id: string): ModeDefinition {
  return modes.find((m) => m.id === id) ?? sequencer
}
