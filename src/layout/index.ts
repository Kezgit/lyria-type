import { block } from './block'
import { circle } from './circle'
import { grid } from './grid'
import type { LayoutDefinition } from './types'

export const layouts: LayoutDefinition[] = [block, circle, grid]

export function getLayout(id: string): LayoutDefinition {
  return layouts.find((l) => l.id === id) ?? block
}
