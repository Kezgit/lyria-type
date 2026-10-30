import type { ParamSchema } from '../../../app/params'
import { breathe } from './breathe'
import { drift } from './drift'
import { live } from './live'
import { ripple } from './ripple'
import type { DotMotion } from './types'

/** Dot motion explorations, by id. */
export const MOTIONS: DotMotion[] = [live, breathe, ripple, drift]
export const motionOf = (id: string) => MOTIONS.find((m) => m.id === id)

// Each motion's own controls, prefixed `<id>_` in a mode's params, listed
// under its `motion` picker and shown only while that motion is picked.
const key = (m: DotMotion, k: string) => `${m.id}_${k}`
export const motionParams: ParamSchema = Object.fromEntries(
  MOTIONS.flatMap((m) =>
    Object.entries(m.params ?? {}).map(([k, def]) => [key(m, k), { ...def, label: def.label ?? k, showIf: { key: 'motion', is: m.id } }]),
  ),
)
export const motionKeys = Object.keys(motionParams)
/** The chosen motion's own values, unprefixed. */
export function motionValues(m: DotMotion, p: Record<string, any>, out: Record<string, any> = {}) {
  for (const k of Object.keys(m.params ?? {})) out[k] = p[key(m, k)]
  return out
}
