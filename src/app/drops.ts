// Images dropped on the stage. Nothing happens to the music: the dot modes
// take each one in as a ripple from where it landed that leaves the image's
// colours behind, spreading out as a gradient (see modes/typeDots). Kept for
// the page's life (the latest few); `clearDrops` lets them go.

export interface Drop {
  /** Where it landed: px from the frame's centre, y up (where the modes lay things out). */
  x: number
  y: number
  /** Its colours, most prominent first (sRGB hex): the gradient from the drop point outward. */
  colours: string[]
  /** When it landed (performance.now() / 1000). */
  at: number
}

/** The latest drops, oldest first. */
export const drops: Drop[] = []
/** How many drops are kept at once. */
export const MAX_DROPS = 4

export function addDrop(d: Drop) {
  drops.push(d)
  while (drops.length > MAX_DROPS) drops.shift()
}

export function clearDrops() {
  drops.length = 0
}

/** The image's main colours (k-means on a small copy), most prominent first. */
export async function imageColours(file: File, count = 5): Promise<string[]> {
  const bitmap = await createImageBitmap(file)
  const size = 48
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = size
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!
  ctx.drawImage(bitmap, 0, 0, size, size)
  bitmap.close()
  const data = ctx.getImageData(0, 0, size, size).data
  const px: [number, number, number][] = []
  for (let i = 0; i < data.length; i += 4) if (data[i + 3] > 128) px.push([data[i], data[i + 1], data[i + 2]])
  if (!px.length) return ['#888888']
  // Seeds spread through the pixels (deterministic), then a few rounds of k-means.
  let centres = Array.from({ length: Math.min(count, px.length) }, (_, k) => [...px[Math.floor(((k + 0.5) / count) * px.length)]])
  const owner = new Int32Array(px.length)
  for (let round = 0; round < 10; round++) {
    px.forEach((p, i) => {
      let best = 0, bd = Infinity
      centres.forEach((c, k) => {
        const d = (p[0] - c[0]) ** 2 + (p[1] - c[1]) ** 2 + (p[2] - c[2]) ** 2
        if (d < bd) { bd = d; best = k }
      })
      owner[i] = best
    })
    const sum = centres.map(() => [0, 0, 0, 0])
    px.forEach((p, i) => { const s = sum[owner[i]]; s[0] += p[0]; s[1] += p[1]; s[2] += p[2]; s[3]++ })
    centres = centres.map((c, k) => (sum[k][3] ? [sum[k][0] / sum[k][3], sum[k][1] / sum[k][3], sum[k][2] / sum[k][3]] : c))
  }
  const sizes = centres.map((_, k) => owner.reduce((n, o) => n + (o === k ? 1 : 0), 0))
  const hex = (c: number[]) => '#' + c.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')
  return centres
    .map((c, k) => ({ c, n: sizes[k] }))
    .filter((e) => e.n > 0)
    .sort((a, b) => b.n - a.n)
    .map((e) => hex(e.c))
}
