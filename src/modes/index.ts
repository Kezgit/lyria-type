import { field } from './field'
import { gap } from './gap'
import { haze } from './haze'
import { orchestra } from './orchestra'
import { pulse } from './pulse'
import { sequencer } from './sequencer'
import { stencil } from './stencil'
import { stretch } from './stretch'
import { typeDots, typeToDots } from './typeDots'
import { typeMorph } from './typeMorph'
import { typeBuild } from './typeBuild'
import { typeBloom } from './typeBloom'
import type { ModeDefinition } from './types'

export const modes: ModeDefinition[] = [orchestra, haze, field, pulse, stretch, gap, sequencer, typeDots, typeToDots, typeMorph, typeBuild, typeBloom, stencil]

export function getMode(id: string): ModeDefinition {
  return modes.find((m) => m.id === id) ?? orchestra
}
