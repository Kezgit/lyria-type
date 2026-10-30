// When the text is edited, letters shift along (typing in the middle moves
// every later letter up one). These carry per-letter state across the edit,
// so each letter keeps its own: `from[i]` is the old index of new letter i,
// or -1 for a letter just typed.

type PerLetter = Float32Array | Uint8Array | Int8Array | Int16Array

/** Old index of each new letter, matching the unchanged start and end of the text. */
export function editMap(before: string, after: string): Int32Array {
  let head = 0
  while (head < before.length && head < after.length && before[head] === after[head]) head++
  let tail = 0
  while (tail < before.length - head && tail < after.length - head && before[before.length - 1 - tail] === after[after.length - 1 - tail]) tail++
  const from = new Int32Array(after.length).fill(-1)
  for (let i = 0; i < head; i++) from[i] = i
  for (let k = 1; k <= tail; k++) from[after.length - k] = before.length - k
  return from
}

/** `a` rearranged for the new letters (new ones get `fill`). */
export function remap<T extends PerLetter>(a: T, from: Int32Array, fill = 0): T {
  const out = new (a.constructor as new (n: number) => T)(from.length)
  for (let i = 0; i < from.length; i++) out[i] = from[i] >= 0 && from[i] < a.length ? a[from[i]] : fill
  return out
}
