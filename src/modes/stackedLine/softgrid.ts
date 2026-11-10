// @ts-nocheck — ported as-is from the Soft Grid tool (plain JS); typed at its edges in index.ts.

// Soft Grid's composition engine: a grid (Single / Line / Grid) of cells, each a
// cluster of soft wobbly blobs (lanes, columns or free), with accent dots, depth
// blur, smear tails, merged colour layers, mesh and grain. `buildScene(S)` lays
// it out from the settings; `drawScene(ctx, scene, S, scale, anim)` paints it,
// moved by the music when `anim.on` (each colour follows a part of the song).

const TAU = Math.PI * 2

export const PARTS = ['Bass', 'Vocals', 'Drums', 'Other']

export const FEELS = {
  Classical: { attack: 0.10, release: 0.035 },
  Blues: { attack: 0.22, release: 0.07 },
  Pop: { attack: 0.5, release: 0.14 },
  Electronic: { attack: 0.85, release: 0.25 },
}

const ZERO_SPEC = { phases: [0, 0, 0, 0], amps: [0, 0, 0, 0], wobble: 0 }
const IDENT_MOTION = { sx: 1, sy: 1, a: 1, dx: 0, dy: 0, blurK: 1 }

export function mulberry32(seed) {
  let a = seed >>> 0
  return function () {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const fmt = (n) => (Math.round(n * 100) / 100).toString()
const clamp01 = (v) => Math.max(0, Math.min(1, v))

function createSpec(rng, wobble) {
  return {
    phases: [rng() * TAU, rng() * TAU, rng() * TAU, rng() * TAU],
    amps: [0.4 + rng() * 0.6, rng(), rng(), rng()],
    wobble: (wobble / 100) * 0.32,
  }
}

function blobPath(rx, ry, exp, spec, sx) {
  const N = 24
  const e = 2 / exp
  const pts = []
  for (let i = 0; i < N; i++) {
    const t = (i / N) * TAU
    const c = Math.cos(t)
    const s = Math.sin(t)
    const x = Math.sign(c) * Math.pow(Math.abs(c), e) * rx
    const y = Math.sign(s) * Math.pow(Math.abs(s), e) * ry
    const w = 1 + spec.wobble * (
      spec.amps[0] * Math.sin(2 * t + spec.phases[0]) * 0.45 +
      spec.amps[1] * Math.sin(3 * t + spec.phases[1]) * 0.3 +
      spec.amps[2] * Math.sin(4 * t + spec.phases[2]) * 0.15 +
      spec.amps[3] * Math.sin(6 * t + spec.phases[3]) * 0.1
    )
    pts.push([x * w * sx, y * w])
  }
  let d = 'M' + fmt(pts[0][0]) + ' ' + fmt(pts[0][1])
  for (let i = 0; i < N; i++) {
    const p0 = pts[(i - 1 + N) % N]
    const p1 = pts[i]
    const p2 = pts[(i + 1) % N]
    const p3 = pts[(i + 2) % N]
    d += 'C' + [
      p1[0] + (p2[0] - p0[0]) / 6,
      p1[1] + (p2[1] - p0[1]) / 6,
      p2[0] - (p3[0] - p1[0]) / 6,
      p2[1] - (p3[1] - p1[1]) / 6,
      p2[0],
      p2[1],
    ].map(fmt).join(' ')
  }
  return d + 'Z'
}

const pathCache = new Map()
function path2d(d) {
  let p = pathCache.get(d)
  if (!p) {
    p = new Path2D(d)
    pathCache.set(d, p)
    if (pathCache.size > 6000) pathCache.clear()
  }
  return p
}

function hexToRgb(h) {
  h = String(h).replace('#', '')
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]
}

function rgbToHex(c) {
  return '#' + c.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('')
}

function gradientAt(pal, t) {
  if (pal.length === 1) return pal[0]
  const x = Math.max(0, Math.min(1, t)) * (pal.length - 1)
  const i = Math.min(pal.length - 2, Math.floor(x))
  const f = x - i
  const a = hexToRgb(pal[i])
  const b = hexToRgb(pal[i + 1])
  return rgbToHex([a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f])
}

function colorLuminance(h) {
  const v = hexToRgb(h)
  return v[0] * 0.3 + v[1] * 0.59 + v[2] * 0.11
}

// ---------------------------------------------------------------------------
// Layout

export function buildScene(S) {
  const W = S.width
  const H = S.height
  const cols = S.layout === 'Single' ? 1 : S.cols
  const rows = S.layout === 'Grid' ? S.rows : 1
  const gxr = S.colGap / 100
  const gyr = S.rowGap / 100
  const aW = Math.max(1, W - S.padding * 2)
  const aH = Math.max(1, H - S.padding * 2)

  const srng = mulberry32(S.seed * 17 + 3)

  function track(count, gapRatio, sv) {
    const sizes = []
    const gaps = []
    for (let i = 0; i < count; i++) sizes.push(Math.exp((srng() - 0.5) * 2 * sv * 0.6))
    const lowest = gapRatio >= 0 ? 0 : -0.9
    const swing = sv * (Math.abs(gapRatio) + 0.35)
    for (let i = 0; i < count - 1; i++) gaps.push(Math.max(lowest, gapRatio + (srng() - 0.5) * 2 * swing))
    const sum = sizes.reduce((a, b) => a + b, 0)
    return {
      sizes,
      gaps,
      sum,
      total: sum + gaps.reduce((a, b) => a + b, 0),
      fit: sum + gaps.reduce((a, b) => a + Math.max(0, b), 0),
    }
  }

  function place(t, unit, start) {
    const pos = []
    const size = []
    let x = start
    for (let i = 0; i < t.sizes.length; i++) {
      pos.push(x)
      size.push(Math.max(1, t.sizes[i] * unit))
      x += t.sizes[i] * unit + (i < t.gaps.length ? t.gaps[i] * unit : 0)
    }
    return { pos, size }
  }

  const tX = track(cols, gxr, S.spaceVar / 100)
  const tY = track(rows, gyr, S.rowVar / 100)

  const unitX = Math.max(1, Math.min(aW / Math.max(0.1, tX.sum), Math.max(aW, W * 0.96) / Math.max(0.1, tX.fit)))
  const unitY = S.layout === 'Grid'
    ? Math.max(1, Math.min(aH / Math.max(0.1, tY.sum), Math.max(aH, H * 0.96) / Math.max(0.1, tY.fit)))
    : Math.max(1, Math.min(unitX / S.stretch, aH / Math.max(0.1, tY.fit)))

  const cW = tX.total * unitX
  const cH = tY.total * unitY
  const colP = place(tX, unitX, (W - cW) / 2)
  const rowP = place(tY, unitY, (H - cH) / 2)

  let rng = mulberry32(S.seed)
  let crng = mulberry32(S.seed * 7919 + 13)
  const colourOff = (((S.colourSeed || 0) * 0.6180339887) % 1 + 1) % 1
  let jrng = mulberry32(S.seed + 99)

  const pal = S.palette.length ? S.palette : ['#888888']
  const n = pal.length
  const wts = pal.map((_, i) => {
    const w = Array.isArray(S.weights) ? Number(S.weights[i]) : 50
    return Number.isFinite(w) ? Math.max(0, w) : 50
  })
  const wTotal = wts.reduce((a, b) => a + b, 0)

  function pickColour(rnd) {
    rnd = (rnd + colourOff) % 1
    if (wTotal <= 0) return pal[Math.floor(rnd * n)]
    let x = rnd * wTotal
    for (let i = 0; i < n; i++) {
      x -= wts[i]
      if (x < 0) return pal[i]
    }
    return pal[n - 1]
  }

  const seq = []
  if (wTotal > 0) {
    const slots = Math.max(n, 12)
    pal.forEach((h, i) => {
      const k = Math.round((wts[i] / wTotal) * slots)
      for (let j = 0; j < k; j++) seq.push(h)
    })
  }
  if (!seq.length) pal.forEach((h) => seq.push(h))
  const sn = seq.length

  const gpal0 = pal.filter((_, i) => wts[i] > 0).length ? pal.filter((_, i) => wts[i] > 0) : pal
  const gRot = Math.floor(colourOff * gpal0.length)
  const gpal = gpal0.slice(gRot).concat(gpal0.slice(0, gRot))

  const wander = S.wander / 100
  let drng = mulberry32(S.seed * 31 + 5)
  const dAmt = S.depth / 100
  const focusShare = S.focus / 100

  function pickDepth() {
    return drng() < focusShare ? drng() * 0.06 : 0.4 + drng() * 0.6
  }

  function depthFor(r, c, cellDepth) {
    if (S.depthBy === 'Cluster') return cellDepth < 0.1 ? cellDepth : clamp01(cellDepth + (drng() - 0.5) * 0.1)
    if (S.depthBy === 'Row') return clamp01((rows > 1 ? r / (rows - 1) : 0.5) + (drng() - 0.5) * 0.12)
    if (S.depthBy === 'Column') return clamp01((cols > 1 ? c / (cols - 1) : 0.5) + (drng() - 0.5) * 0.12)
    return pickDepth()
  }

  function applyDepth(b, d, ghost) {
    const keep = Math.max(0.07, 1 - dAmt * (1 - d))
    const extra = dAmt * Math.pow(d, 1.3) * (b.size || 0) * 1.3 * (ghost ? 1.4 : 1)
    b.blur = b.blur * keep + extra
    b.opacity *= 1 - dAmt * 0.18 * d
    if (ghost) b.opacity *= 1 - dAmt * (1 - Math.min(1, d * 1.6))
    b.depth = d
    return b
  }

  const cells = []
  const spec = (w) => createSpec(rng, w)

  function baseColour(r, c) {
    const so = Math.floor(colourOff * sn)
    if (S.flow === 'Columns') return seq[(c + so) % sn]
    if (S.flow === 'Rows') return seq[(r + so) % sn]
    if (S.flow === 'Diagonal') return seq[(r + c + so) % sn]
    if (S.flow === 'Gradient') return gradientAt(gpal, cols > 1 ? c / (cols - 1) : 0.5)
    return pickColour(crng())
  }

  function layerColour(base, r, c) {
    if (S.flow === 'Random') return pickColour(crng())
    if (S.flow === 'Gradient') return gradientAt(gpal, (cols > 1 ? c / (cols - 1) : 0.5) + (crng() - 0.5) * 0.35)
    return crng() < 0.4 ? base : pickColour(crng())
  }

  const repeating = S.repeat && S.repeat !== 'Off'
  const mixSeed = (a, b) => (Math.imul(a ^ 0x9e3779b9, 2654435761) ^ Math.imul(b + 0x7f4a7c15, 40503)) >>> 0
  const drift = repeating ? S.drift / 100 : 0

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const cellKey = c + r * 1000
      let motifKey = cellKey
      if (S.repeat === 'Rows') motifKey = c
      else if (S.repeat === 'Columns') motifKey = r * 1000
      else if (repeating) motifKey = (c % Math.max(1, S.repeatCols)) + (r % Math.max(1, S.repeatRows)) * 1000

      rng = mulberry32(mixSeed(S.seed, motifKey))
      drng = mulberry32(mixSeed(S.seed * 31 + 5, motifKey))
      crng = mulberry32(mixSeed(S.seed * 7919 + 13, repeating && S.repeatColour ? motifKey : cellKey))
      jrng = mulberry32(mixSeed(S.seed + 99, cellKey))

      const cw = colP.size[c]
      const ch = rowP.size[r]
      const x0 = colP.pos[c]
      const y0 = rowP.pos[r]
      const cx = x0 + cw / 2
      const cy = y0 + ch / 2

      const sameCol = repeating && S.repeatColour
      const mr = !sameCol ? r : S.repeat === 'Rows' ? 0 : S.repeat === 'Columns' ? r : r % Math.max(1, S.repeatRows)
      const mc = !sameCol ? c : S.repeat === 'Columns' ? 0 : S.repeat === 'Rows' ? c : c % Math.max(1, S.repeatCols)
      const base = baseColour(mr, mc)

      const blobs = []
      const cellDepth = pickDepth()
      const L = S.layers
      const overlap = 1 + (S.spread / 100) * 1.4
      const dotCol = S.accentPlace === 'Column' && S.accents > 0
      const shapesHere = []

      {
        const shapeCw = dotCol ? colP.size[c] * 0.72 : colP.size[c]
        const shapeCx = x0 + shapeCw / 2
        for (let l = 0; l < L; l++) {
          const aspect = Math.max(1.2, (1.2 + (S.elong / 100) * 5) * Math.exp((rng() - 0.5) * 2 * (S.widthVar / 100) * 1.1))
          const vary = 1 - (S.sizeJitter / 100) * 0.75 * rng()
          let bx = shapeCx
          let by = cy
          let rx
          let ry
          let rowY = cy
          const exp = 2

          if (S.arrange === 'Lanes') {
            const sc = Math.max(1, Math.min(L, S.subCols || 1))
            const laneRows = Math.ceil(L / sc)
            const lh = ch / laneRows
            const lw = shapeCw / sc
            bx = x0 + ((l % sc) + 0.5) * lw
            by = cy + (Math.floor(l / sc) - (laneRows - 1) / 2) * lh * (1 + (S.laneGap || 0) / 100)
            rowY = by
            ry = (lh / 2) * overlap * (0.85 + rng() * 0.2)
            rx = Math.min(ry * aspect, (lw / 2) * (1 + (S.spread / 100) * 0.7))
            rx *= vary
            ry *= vary
            bx += (rng() - 0.5) * wander * lw * 0.5
            by += (rng() - 0.5) * wander * lh * 0.8
          } else if (S.arrange === 'Columns') {
            const lw = shapeCw / L
            bx = x0 + (l + 0.5) * lw
            ry = Math.min((lw / 2) * overlap * (0.85 + rng() * 0.2), ch / 2)
            rx = ry * aspect
            rx *= vary
            ry *= vary
            bx += (rng() - 0.5) * wander * lw * 0.8
            by += (rng() - 0.5) * wander * ch * 0.5
          } else {
            const sc = l === 0 ? 1 - (S.sizeJitter / 100) * 0.2 * rng() : vary
            ry = (Math.min(ch, shapeCw / Math.max(1, aspect)) / 2) * sc * (0.92 + rng() * 0.16)
            rx = Math.min(ry * aspect, shapeCw * 1.2)
            const sp = (S.spread / 100) * (l === 0 ? 0.25 : 1) * 0.6 + wander * 0.6
            bx += (rng() - 0.5) * sp * shapeCw
            by += (rng() - 0.5) * sp * ch
          }

          if (S.heightVar > 0) {
            ry *= Math.exp((rng() - 0.5) * 2 * (S.heightVar / 100) * 1.1)
            if (rx < ry * 1.2) rx = ry * 1.2
          }

          if (S.contain) {
            rx = Math.min(rx, shapeCw * 0.5)
            bx = Math.max(x0 + rx * 0.9, Math.min(x0 + shapeCw - rx * 0.9, bx))
            if (S.layout === 'Grid') {
              ry = Math.min(ry, ch * 0.5)
              by = Math.max(y0 + ry * 0.9, Math.min(y0 + ch - ry * 0.9, by))
            }
          }

          if (drift > 0) {
            bx += (jrng() - 0.5) * drift * shapeCw * 0.3
            by += (jrng() - 0.5) * drift * ch * 0.3
            rx *= 1 + (jrng() - 0.5) * drift * 0.5
            ry *= 1 + (jrng() - 0.5) * drift * 0.4
          }

          if (rx < ry * 1.2) ry = rx / 1.2
          if (S.alignRows) by = rowY

          const colour = l === 0 ? base : layerColour(base, mr, mc)
          const opacity = 0.74 + rng() * 0.22
          const minR = Math.min(rx, ry)
          const blur = (S.blur / 100) * minR * 0.9
          const sp = spec(S.wobble)
          const dl = depthFor(r, c, cellDepth)

          if (S.smear > 0 && (S.smearStyle || 'Tails') === 'Tails') {
            const amt = S.smear / 100
            const sv = (S.smearVar || 0) / 100
            const tails = rng() < 0.35 + amt * 0.6 ? 1 + (rng() < amt * 0.5 ? 1 : 0) : 0
            for (let t = 0; t < tails; t++) {
              const dir = S.smearDir === 'Left' ? -1 : S.smearDir === 'Right' ? 1 : (rng() < 0.5 ? -1 : 1)
              const reach = rx * (0.6 + amt * 3 * (1 - sv + sv * Math.pow(rng(), 0.6) * 4))
              const th = ry * (0.18 + rng() * 0.32)
              const ty = by + (rng() - 0.5) * ry * 0.9 * (S.alignRows ? 0 : 1)
              const trx = reach / 2 + rx * 0.35
              const tcx = bx + dir * (trx - rx * 0.35)
              const tsp = spec(S.wobble * 0.3)
              blobs.push(applyDepth({
                ax: bx, ay: by, rw: trx, rh: th, x: tcx, y: ty,
                d: blobPath(trx, th, 4, tsp, 1),
                colour,
                opacity: opacity * (0.55 + rng() * 0.3),
                blur: Math.max(blur * 0.7, th * 0.45),
                size: th,
              }, dl))
            }
          }

          blobs.push(applyDepth({
            x: bx, y: by,
            d: blobPath(rx, ry, exp, sp, 1),
            colour, opacity, blur, size: minR, rw: rx, rh: ry,
          }, dl))

          shapesHere.push({ x: bx, y: by, rx, ry, colour, dl })
        }
      }

      // Inner dots
      for (let k = 0; k < (S.innerDots || 0) && shapesHere.length; k++) {
        const host = shapesHere[Math.floor(rng() * shapesHere.length)]
        const rr = Math.min(host.rx, host.ry) * (0.2 + rng() * 0.18) * (0.6 + S.accentSize / 60)
        const ix = host.x + (rng() - 0.5) * host.rx * 0.9
        const iy = host.y + (rng() - 0.5) * host.ry * 0.6
        const rgb = hexToRgb(host.colour)
        const deep = rgbToHex(rgb.map((v) => v * 0.62))
        const sp2 = spec(S.wobble * 0.5)
        blobs.push(applyDepth({
          ax: host.x, ay: host.y, pc: host.colour, rw: host.rx, rh: host.ry, x: ix, y: iy,
          d: blobPath(rr * 1.15, rr, 2, sp2, 1),
          colour: deep,
          opacity: 0.75 + rng() * 0.2,
          blur: (S.blur / 100) * rr * 0.9 + rr * 0.15,
          size: rr,
        }, Math.max(0, host.dl - 0.05)))
      }

      // Dot stem
      if (dotCol && S.stem) {
        const span = ch * (S.dotSpan / 100)
        const sx = x0 + cw * 0.86
        const sw = Math.max(2, (S.accentSize / 100) * Math.min(cw, ch) * 0.22)
        const scol = pal.slice().sort((a, b) => colorLuminance(b) - colorLuminance(a))[0]
        const sp3 = spec(S.wobble * 0.4)
        blobs.push({
          x: sx, y: cy + span * 0.15,
          d: blobPath(sw, span * 0.7, 2, sp3, 1),
          colour: scol, opacity: 0.85,
          blur: sw * 0.7 + (S.blur / 100) * sw * 0.8,
          depth: 2,
        })
      }

      // Accent dots
      const dotRowsY = []
      if (S.arrange === 'Lanes') {
        const scn = Math.max(1, Math.min(S.layers, S.subCols || 1))
        const lr = Math.ceil(S.layers / scn)
        const lh2 = ch / lr
        for (let i = 0; i < lr; i++) dotRowsY.push(cy + (i - (lr - 1) / 2) * lh2 * (1 + (S.laneGap || 0) / 100))
      } else {
        dotRowsY.push(cy)
      }

      const dotSpots = []
      if (S.accentPlace === 'Column') {
        const span = ch * (S.dotSpan / 100)
        const top = cy - span / 2
        for (let a = 0; a < S.accents; a++) dotSpots.push([x0 + cw * 0.86, top + span * (a + 0.5) / S.accents])
      } else if (S.accentPlace === 'Grid points') {
        dotRowsY.forEach((yy) => {
          for (let a = 0; a < S.accents; a++) dotSpots.push([x0 + cw * (a + 0.5) / S.accents, yy])
        })
      } else {
        dotRowsY.forEach((yy) => {
          for (let a = 0; a < S.accents; a++) dotSpots.push([cx + (rng() - 0.5) * cw * 0.85, yy])
        })
      }

      for (const [ax, ay] of dotSpots) {
        let d = (S.accentSize / 100) * Math.min(cw, ch) * (0.75 + rng() * 0.5)
        if (drift > 0) d *= 1 + (jrng() - 0.5) * drift * 0.5
        let col = pickColour(crng())
        if (n > 1 && col === base) col = pal[(pal.indexOf(col) + 1) % n]
        const sp = spec(0)
        blobs.push({
          x: ax, y: ay,
          d: blobPath(d / 2, d / 2, 2, sp, 1),
          colour: col,
          opacity: 0.9 + rng() * 0.1,
          blur: 0, size: d / 2, depth: -1, dot: true,
        })
      }

      blobs.sort((a, b) => b.depth - a.depth)
      cells.push({ r, c, x: x0, y: y0, w: cw, h: ch, blobs })
    }
  }

  if (S.centre !== false) {
    let x0 = Infinity
    let x1 = -Infinity
    let y0 = Infinity
    let y1 = -Infinity
    for (const cell of cells) {
      for (const b of cell.blobs) {
        const hw = b.rw || b.size || 0
        const hh = b.rh || b.size || 0
        x0 = Math.min(x0, b.x - hw)
        x1 = Math.max(x1, b.x + hw)
        y0 = Math.min(y0, b.y - hh)
        y1 = Math.max(y1, b.y + hh)
      }
    }
    if (x1 > x0) {
      const dx = W / 2 - (x0 + x1) / 2
      const dy = H / 2 - (y0 + y1) / 2
      for (const cell of cells) {
        cell.x += dx
        cell.y += dy
        for (const b of cell.blobs) {
          b.x += dx
          b.y += dy
          if (b.ax != null) b.ax += dx
          if (b.ay != null) b.ay += dy
        }
      }
    }
  }

  return { W, H, cells, count: cells.reduce((t, c) => t + c.blobs.length, 0) }
}

// ---------------------------------------------------------------------------
// Music motion

export function createAnim() {
  return { on: false, t: 0, energy: { Bass: 0, Vocals: 0, Drums: 0, Other: 0 }, partOf: new Map() }
}

function nearestPart(S, hex) {
  const c = hexToRgb(hex)
  let best = -1
  let bd = Infinity
  S.palette.forEach((h, i) => {
    const q = hexToRgb(h)
    const d = (q[0] - c[0]) ** 2 + (q[1] - c[1]) ** 2 + (q[2] - c[2]) ** 2
    if (d < bd) {
      bd = d
      best = i
    }
  })
  return best < 0 ? 'Still' : (S.parts[best] || 'Still')
}

function grow(b, e, I, across) {
  const rw = b.rw || b.size || 10
  const rh = b.rh || b.size || 10
  const dot = Math.min(rw, rh) * 0.5
  const f = Math.max(0, (1 - I) + I * Math.min(1.12, Math.pow(e, 1.3) * 1.12))
  const full = across ? rw : rh
  const v = dot + (full - dot) * f
  return Math.max(0.05, v / full)
}

function motionFor(b, S, ANIM) {
  if (!ANIM.on) return IDENT_MOTION
  const key = String(b.pc || b.colour).toLowerCase()
  let part = ANIM.partOf.get(key)
  if (part === undefined) {
    part = nearestPart(S, key)
    ANIM.partOf.set(key, part)
  }
  if (!part || part === 'Still') return IDENT_MOTION

  let e = Math.max(0, Math.min(1, ANIM.energy[part] || 0))
  const I = (S.musicIntensity || 0) / 100
  const sz = b.size || 10
  const fp = ANIM.feelP ?? 0.5
  const phase = b.x * 0.011 + b.y * 0.017
  const ind = (S.individual == null ? 60 : S.individual) / 100
  let dir = -1

  if (ind > 0) {
    if (!b._r) {
      const h = Math.imul(Math.round(b.x * 10) ^ 0x9e3779b9, 2654435761) ^ Math.imul(Math.round(b.y * 10) + Math.round((b.size || 0) * 7), 40503)
      const rr = mulberry32(h >>> 0)
      b._r = [rr(), rr(), rr(), rr()]
    }
    const r = b._r
    const lfo = 0.5 + 0.5 * Math.sin(ANIM.t * (0.08 + r[1] * 0.25) * Math.PI * 2 + r[0] * Math.PI * 2)
    e = Math.min(1, e * ((1 - ind) + ind * (0.4 + 1.2 * r[2]) * (0.7 + 0.3 * lfo)))
    if (r[3] < 0.35 * ind) dir = 1
  }

  return {
    sx: S.mvSize ? grow(b, e, I, true) : 1,
    sy: S.mvSize ? grow(b, e, I, false) : 1,
    a: S.mvGlow ? Math.max(0.12, 1 - I * 0.5 * (1 - Math.min(1, e * 1.4))) : 1,
    dx: S.mvSway ? Math.sin(ANIM.t * (0.3 + fp * 0.9) * Math.PI + phase) * e * I * sz * 0.35 : 0,
    dy: S.mvBounce ? dir * e * I * sz * 0.5 : 0,
    blurK: S.mvBlur ? Math.max(0.8, Math.min(1.35, 1 + (0.5 - e) * I * 0.5)) : 1,
  }
}

// ---------------------------------------------------------------------------
// Drawing

const BLEND_MAP = { Multiply: 'multiply', Darken: 'darken', Normal: 'source-over', Screen: 'screen' }

let noiseTile = null
function getNoise() {
  if (noiseTile) return noiseTile
  const c = document.createElement('canvas')
  c.width = c.height = 256
  const g = c.getContext('2d')
  const img = g.createImageData(256, 256)
  const r = mulberry32(1234)
  for (let i = 0; i < img.data.length; i += 4) {
    const v = r() * 255
    img.data[i] = img.data[i + 1] = img.data[i + 2] = v
    img.data[i + 3] = 255
  }
  g.putImageData(img, 0, 0)
  noiseTile = c
  return c
}

let meshTile = null
function getMesh() {
  if (meshTile) return meshTile
  const c = document.createElement('canvas')
  c.width = c.height = 14
  const g = c.getContext('2d')
  g.strokeStyle = 'rgba(255,255,255,0.9)'
  g.lineWidth = 1
  g.beginPath()
  g.moveTo(0, 14); g.lineTo(14, 0)
  g.moveTo(-7, 7); g.lineTo(7, -7)
  g.moveTo(7, 21); g.lineTo(21, 7)
  g.stroke()
  g.strokeStyle = 'rgba(255,255,255,0.55)'
  g.beginPath()
  g.moveTo(0, 2); g.lineTo(14, 12)
  g.stroke()
  meshTile = c
  return c
}

let mergeCanvas = null

const supportsFilter = (() => {
  try {
    const c = document.createElement('canvas').getContext('2d')
    c.filter = 'blur(2px)'
    return c.filter === 'blur(2px)'
  } catch (_e) {
    return false
  }
})()

function paintBlob(c2, b, scale, mode, alpha, skipGlow, S, ANIM) {
  const p = path2d(b.d)
  const m = motionFor(b, S, ANIM)
  const blur = b.blur * m.blurK * (m.sx + m.sy) / 2
  const ax0 = b.ax == null ? b.x : b.ax
  const ay0 = b.ay == null ? b.y : b.ay
  const px = ax0 + (b.x - ax0) * m.sx + m.dx
  const py = ay0 + (b.y - ay0) * m.sy + m.dy

  c2.save()
  c2.globalCompositeOperation = mode
  c2.globalAlpha = Math.min(1, alpha * (skipGlow ? 1 : m.a))
  c2.fillStyle = b.colour
  if (blur > 0.2 && supportsFilter) {
    c2.filter = 'blur(' + (blur * scale).toFixed(2) + 'px)'
    c2.translate(px, py)
  } else if (blur > 0.2) {
    // No canvas filter (Safari): the blur as a shadow cast from far off the canvas.
    const off = 20000
    c2.shadowColor = b.colour
    c2.shadowBlur = blur * 2 * scale
    c2.shadowOffsetX = off * scale
    c2.translate(px - off, py)
  } else {
    c2.translate(px, py)
  }
  c2.scale(m.sx, m.sy)
  c2.fill(p)
  c2.restore()
}

function smudge(ctx, S) {
  const w = ctx.canvas.width
  const h = ctx.canvas.height
  if (!w || !h) return
  let img
  try {
    img = ctx.getImageData(0, 0, w, h)
  } catch (_e) {
    return
  }
  const src = img.data
  const out = new Uint8ClampedArray(src)
  const base = Math.max(1, (S.smear / 100) * w * 0.25)
  const rv = (S.smearVar || 0) / 100
  const r = mulberry32(S.seed * 13 + 7)
  const ph = [r() * TAU, r() * TAU, r() * TAU]
  const fq = [1 + r() * 2, 3 + r() * 4, 7 + r() * 7]
  const dark = S.blend !== 'Screen'
  const dirMode = S.smearDir || 'Both'
  const dirs = dirMode === 'Left' ? [-1] : dirMode === 'Right' ? [1] : [1, -1]

  for (let y = 0; y < h; y++) {
    const t = y / h
    const nz = 0.55 * Math.sin(t * TAU * fq[0] + ph[0]) + 0.3 * Math.sin(t * TAU * fq[1] + ph[1]) + 0.15 * Math.sin(t * TAU * fq[2] + ph[2])
    const len = base * Math.max(0.05, 1 + rv * nz * 1.4)
    const keep = Math.exp(-1 / len)
    const fresh = 1 - keep
    const row = y * w * 4

    for (const dir of dirs) {
      let i = row + (dir > 0 ? 0 : (w - 1) * 4)
      let cr = src[i]
      let cg = src[i + 1]
      let cb = src[i + 2]
      let ca = src[i + 3]
      const step = dir * 4
      for (let n = 0; n < w; n++, i += step) {
        cr = cr * keep + src[i] * fresh
        cg = cg * keep + src[i + 1] * fresh
        cb = cb * keep + src[i + 2] * fresh
        ca = ca * keep + src[i + 3] * fresh
        if (ca > out[i + 3]) out[i + 3] = ca
        if (dark) {
          if (cr < out[i]) out[i] = cr
          if (cg < out[i + 1]) out[i + 1] = cg
          if (cb < out[i + 2]) out[i + 2] = cb
        } else {
          if (cr > out[i]) out[i] = cr
          if (cg > out[i + 1]) out[i + 1] = cg
          if (cb > out[i + 2]) out[i + 2] = cb
        }
        if (dark) {
          if (src[i] < cr) cr = cr * 0.6 + src[i] * 0.4
          if (src[i + 1] < cg) cg = cg * 0.6 + src[i + 1] * 0.4
          if (src[i + 2] < cb) cb = cb * 0.6 + src[i + 2] * 0.4
        }
      }
    }
  }
  img.data.set(out)
  ctx.putImageData(img, 0, 0)
}

/** Paint `scene` into `ctx` (whose canvas is the frame) at `scale` device px per scene px. */
export function drawScene(ctx, scene, S, scale, ANIM) {
  const { W, H } = scene
  ctx.save()
  ctx.setTransform(scale, 0, 0, scale, 0, 0)
  ctx.globalCompositeOperation = 'source-over'
  ctx.globalAlpha = 1
  ctx.filter = 'none'
  ctx.clearRect(0, 0, W, H)
  ctx.fillStyle = S.bg
  ctx.fillRect(0, 0, W, H)
  ctx.beginPath()
  ctx.rect(0, 0, W, H)
  ctx.clip()

  const mode = BLEND_MAP[S.blend] || 'multiply'

  if (S.merge !== false) {
    const groups = new Map()
    for (const cell of scene.cells) {
      for (const b of cell.blobs) {
        if (b.dot) continue
        let g = groups.get(b.colour)
        if (!g) {
          g = { list: [], op: 0, depth: 0 }
          groups.set(b.colour, g)
        }
        g.list.push(b)
        g.op += Math.min(1, b.opacity)
        g.depth += b.depth || 0
      }
    }
    const order = S.palette.map((h) => h.toLowerCase())
    groups.forEach((g, hex) => {
      const i = order.indexOf(String(hex).toLowerCase())
      g.idx = i < 0 ? 999 : i
    })
    const ordered = Array.from(groups.values()).sort((a, b) => a.idx - b.idx)

    if (!mergeCanvas) mergeCanvas = document.createElement('canvas')
    if (mergeCanvas.width !== ctx.canvas.width) mergeCanvas.width = ctx.canvas.width
    if (mergeCanvas.height !== ctx.canvas.height) mergeCanvas.height = ctx.canvas.height
    const lc = mergeCanvas.getContext('2d')

    for (const g of ordered) {
      lc.setTransform(1, 0, 0, 1, 0, 0)
      lc.clearRect(0, 0, mergeCanvas.width, mergeCanvas.height)
      lc.setTransform(scale, 0, 0, scale, 0, 0)
      for (const b of g.list) paintBlob(lc, b, scale, 'source-over', 1, true, S, ANIM)
      ctx.save()
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      ctx.globalCompositeOperation = mode
      ctx.globalAlpha = Math.min(1, (g.op / g.list.length) * 1.05 * motionFor(g.list[0], S, ANIM).a)
      ctx.drawImage(mergeCanvas, 0, 0)
      ctx.restore()
    }
  } else {
    for (const cell of scene.cells) {
      for (const b of cell.blobs) {
        if (b.dot) continue
        paintBlob(ctx, b, scale, mode, Math.min(1, b.opacity), false, S, ANIM)
      }
    }
  }

  if (S.smear > 0 && S.smearStyle === 'Smudge') smudge(ctx, S)

  // Accent dots
  for (const cell of scene.cells) {
    for (const b of cell.blobs) {
      if (!b.dot) continue
      ctx.save()
      ctx.globalCompositeOperation = mode
      const m = motionFor(b, S, ANIM)
      ctx.globalAlpha = Math.min(1, b.opacity * m.a)
      ctx.fillStyle = b.colour
      ctx.translate(b.x + m.dx, b.y + m.dy)
      ctx.scale(m.sx, m.sy)
      ctx.fill(path2d(b.d))
      ctx.restore()
    }
  }

  // Mesh overlay
  if (S.mesh > 0) {
    ctx.save()
    ctx.globalCompositeOperation = 'soft-light'
    ctx.globalAlpha = (S.mesh / 100) * 0.9
    ctx.setTransform(Math.max(1, scale * 1.2), 0, 0, Math.max(1, scale * 1.2), 0, 0)
    ctx.fillStyle = ctx.createPattern(getMesh(), 'repeat')
    ctx.fillRect(0, 0, W * scale, H * scale)
    ctx.restore()
  }

  // Grain overlay
  if (S.grain > 0) {
    ctx.save()
    ctx.globalCompositeOperation = 'soft-light'
    ctx.globalAlpha = (S.grain / 100) * 0.7
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.fillStyle = ctx.createPattern(getNoise(), 'repeat')
    ctx.fillRect(0, 0, W * scale, H * scale)
    ctx.restore()
  }

  ctx.restore()
}
