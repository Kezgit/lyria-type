// Declarative parameter schemas. Modes and layouts describe their controls here;
// the UI panel is generated from them and presets serialize the resulting values.

export type ParamDef = (
  | { type: 'number'; value: number; min: number; max: number; step?: number; label?: string }
  | { type: 'boolean'; value: boolean; label?: string }
  | { type: 'color'; value: string; label?: string }
  | { type: 'select'; value: string; options: Record<string, string>; label?: string }
  /** Free text, kept with the mode's settings; shown in the panel as a text field only with `show` (else e.g. letter assignments). */
  | { type: 'text'; value: string; label?: string; show?: boolean }
) & {
  /**
   * Shown only while another control of the same schema has one of these
   * values (`key` as declared; the panel finds it under any prefix the mode
   * gave both, e.g. a sub-mode's).
   */
  showIf?: { key: string; is: string | string[] }
}

export type ParamSchema = Record<string, ParamDef>

export type ParamValues<S extends ParamSchema> = {
  [K in keyof S]: S[K]['value'] extends number
    ? number
    : S[K]['value'] extends boolean
      ? boolean
      : string
}

export function defaults<S extends ParamSchema>(schema: S): ParamValues<S> {
  const out: Record<string, unknown> = {}
  for (const [key, def] of Object.entries(schema)) out[key] = def.value
  return out as ParamValues<S>
}
