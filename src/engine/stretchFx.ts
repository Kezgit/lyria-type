import * as THREE from 'three/webgpu'
import {
  Fn, If, atan, cos, dot, exp, float, fract, max, min, mix, mod, normalize, pow, screenCoordinate, select, sin, smoothstep, texture, time, uniform,
  uniformArray, uv, vec2, vec3, vec4,
} from 'three/tsl'
import type { GlyphLayer } from './glyphLayer'
import type { BarLayer } from './barLayer'

// Slit-scan delay line. The stretch is a timeline: every frame the history
// buffer moves outward along the axis and the letters stamp their current
// emission (an audio-driven 0..1 value) into it. A bar therefore has the
// silhouette of the letter it grew from, and its colour bands are the music's
// recent past travelling away from the type.
//
//   1. mask      glyphs only -> RT, premultiplied by coverage (A):
//                R = activity (how hard the letter is being hit, 0..1; only
//                active letters feed the trail), G = emission, B = hue
//                (which multi-ramp a letter uses, 0..1)
//   2. history   shift previous history outward by `step` px (+ slight
//                cross-axis spread), fade its presence, stamp the mask on top
//              (when a mode sets `clip`, history only survives inside its
//              bars: trails stay contained in the rects it draws)
//   3. composite presence blends the ramp-mapped emission over the
//                background; letters optionally drawn crisp on top
//
// Notes (`layering`): mask B can carry a note code of 1 or more instead of
// a 0..1 hue (B = note * 8 + layer + 0.5, so small errors at soft letter
// edges round back to the right note), and every note is its own piece. When a new
// note lands on one still showing, that one slips into a second history
// (`under`) and carries on beneath it, seen through the new one, and notes
// that touch are parted by a soft gap, like cells on a piano roll.

// Lanes (`setTimeline`): instead of running live, the history is baked from
// a whole timeline, one pass per column, a few passes per frame, then frozen.
// Each letter is a lane (mask G = lane id, R = full) and reads its activity
// and emission for the column from the timeline. Presence only fades inside
// the letters (the trail a hit leaves as it leaves its letter); once out,
// it keeps (`ageKeep`), so the start of the timeline is still there at the
// end. Letters and a playhead light live from `setLive` / `playhead*`.

export type StretchAxis = 'horizontal' | 'vertical' | 'radial'

/** Number of ramps available when letters pick their own hue. */
export const MULTI_RAMPS = 8
/** Dropped images the trails can show at once (as engine/dropFx keeps). */
const DROPS = 4
/** Instruments a letter can be given to (the Orchestra's layers), each with its own ramp. */
export const PART_RAMPS = 7
/**
 * A letter given to an instrument writes hue PART_CODE + instrument + 0.5: a note code (see Notes above)
 * on note 31, which the Orchestra never uses, so it reads as its instrument's ramp in any mode.
 */
export const PART_CODE = 248
/** Lanes a timeline can hold (mask G = (lane + 0.5) / MAX_LANES). */
export const MAX_LANES = 64
/** Shockwaves alive at once. */
export const WAVES = 6
/** Lines of text whose movement the trails follow (see `lineFlow`). */
export const FLOW_LINES = 12
/** Steps of recent melody kept for artifacts that follow the music (per layer). */
export const MELODY_STEPS = 64

export class StretchFx {
  enabled = false

  readonly axis = uniform(new THREE.Vector2(1, 0))
  readonly radial = uniform(0)
  /** 1 = grow both ways along the axis, 0 = one way only. */
  readonly sided = uniform(1)
  /** Distance the history moves this frame, px. */
  readonly step = uniform(10)
  /** Presence multiplier per frame (how long trails live). */
  readonly keep = uniform(0.97)
  /** Cross-axis spread per frame, px: softens trails as they age. */
  readonly spread = uniform(0)
  /** Along-axis smear per frame, px: melts letter-shaped colour edges into soft bands. */
  readonly smear = uniform(0)
  /** Curling drift per frame, px: a divergence-free flow that bends trails as they age. */
  readonly swirl = uniform(0)
  /** Size of the swirl's eddies, px. */
  readonly swirlSize = uniform(240)
  /** Where the swirl's flow is in its cycle, and which way its eddies face (radians). */
  readonly swirlPhase = uniform(0)
  readonly swirlAngle = uniform(0)
  /** Vanishing point, px from the centre (y up): `zoom` and `twist` recede and turn the field about it. */
  readonly vp = uniform(new THREE.Vector2(0, 0))
  /** Fraction the field recedes toward `vp` per frame (into the distance). */
  readonly zoom = uniform(0)
  /** Radians the field turns about `vp` per frame. */
  readonly twist = uniform(0)
  /** Speaker push about `pumpCentre` per frame (fraction, + = outward). */
  readonly pump = uniform(0)
  readonly pumpCentre = uniform(new THREE.Vector2(0, 0))
  /** Trails fade out within this many px of `vp` (0 = off): things vanish into the distance. */
  readonly depthFade = uniform(0)
  /** Shifts every trail along the multi ramps (fractional = a blend of neighbours). */
  readonly roll = uniform(0)
  /** Bloom, 0..2: the bright parts of the finished frame, blurred (mip levels) and added back, like light on a lens. */
  readonly glow = uniform(0)
  /** Letters lit from within, 0..2: 0 = their inner edge, 1 = a halo round the outside, 2 = both. */
  readonly letterGlow = uniform(0)
  readonly letterGlowMode = uniform(1)
  /** 1 = trails pass over the letters; 0 = letters sit on top. */
  readonly trailOver = uniform(0)
  /** Glossy bright cores running along the strands, 0..1. */
  readonly gloss = uniform(0)
  /** 1 = keep notes apart: a second layer beneath (`seeThrough`) and gaps between them (`noteGap`). */
  readonly layering = uniform(0)
  /** How much of a covered note shows through the one on top, 0..1. */
  readonly seeThrough = uniform(0.45)
  /** Where notes of one layer meet: how much the join breaks into striped, glitchy seams, 0..1. */
  readonly noteGap = uniform(0.5)
  /** Where different layers meet: how far (px) their colours mix like paint into a gradient (0 = a hard edge). */
  readonly colourBlend = uniform(40)
  /** Miscoded specks riding the trails (another layer's colour), 0..1, and their size (px). */
  readonly artifacts = uniform(0)
  readonly artifactSize = uniform(2)
  /** How far the trails have travelled (px), so specks ride along with them. */
  readonly travel = uniform(0)
  /**
   * How artifacts are arranged, like notes on a piano roll: 0 scatter, 1 staircases (runs stepping up
   * or down), 2 chords (stacked notes struck together), 3 runs (repeated notes on one row), 4 follow
   * the music (each layer's recent melody, from `melody`).
   */
  readonly artifactPattern = uniform(0)
  /** Space between artifact notes, and how much it varies, 0..1. */
  readonly artifactGaps = uniform(0.4)
  /** Artifact notes' length, in steps. */
  readonly artifactLength = uniform(1)
  /**
   * Recent melody per layer for `artifactPattern` 4: one entry per step of
   * travel (the step a trail pixel was laid down on), 0..1 low to high, -1 =
   * silent. Two vec4 per step: layers 0-3, then 4-7.
   */
  readonly melody = Array.from({ length: MELODY_STEPS * 2 }, () => new THREE.Vector4(-1, -1, -1, -1))
  private melodyArr = uniformArray(this.melody, 'vec4')
  /**
   * How long each layer's notes were really sounding (0.4..1 of a step: how much of its step an artifact
   * note fills) at each step of travel, laid down with the trail so it never changes once drawn.
   */
  readonly noteFill = Array.from({ length: MELODY_STEPS * 2 }, () => new THREE.Vector4(0.7, 0.7, 0.7, 0.7))
  private noteFillArr = uniformArray(this.noteFill, 'vec4')
  /**
   * Artifacts per instrument: each layer's note length (× `artifactLength`) and how often its notes
   * come (× density), two vec4 each, layers 0-3 then 4-7. Hats (layer 2) also land on every other step.
   */
  readonly layerLen = [new THREE.Vector4(1, 1, 1, 1), new THREE.Vector4(1, 1, 1, 1)]
  readonly layerDensity = [new THREE.Vector4(1, 1, 1, 1), new THREE.Vector4(1, 1, 1, 1)]
  private layerLenArr = uniformArray(this.layerLen, 'vec4')
  private layerDensityArr = uniformArray(this.layerDensity, 'vec4')
  /** 1 = artifacts take their instrument's length and rhythm (`layerLen`, `layerDensity`). */
  readonly artifactByInstrument = uniform(1)
  /** Artifact shape: 0 blocks, 1 pills (rounded), 2 droplets (pills that merge with the notes either side). */
  readonly artifactShape = uniform(0)
  /**
   * Fluid colour: a note laid over another takes on its colour as they flow on together, a little
   * more each frame (`fluidStep`), up to `fluid` (0 = off). The colour shifts as it travels.
   */
  readonly fluid = uniform(0)
  readonly fluidStep = uniform(0)
  /** Rounded trails, 0..1: the trails' ends and corners rounded, and notes that nearly touch merging like droplets. */
  readonly roundness = uniform(0)
  /**
   * Lines of text moving (as the text reflows while it is typed): each line's height (px, y up), how far
   * it moved this frame (x, y px) and 1 if in use. The trails at each height move with the nearest lines,
   * so bars glide with their lines into a new layout instead of being left behind. `lineSpread` (px):
   * how far a line's pull reaches either side of it.
   */
  readonly lineFlow = Array.from({ length: FLOW_LINES }, () => new THREE.Vector4())
  private lineFlowArr = uniformArray(this.lineFlow, 'vec4')
  readonly lineSpread = uniform(60)
  /**
   * Rows kept apart (horizontal walls): each line's trail fades out toward the edge of its own band,
   * `rowBand` px either side of the line, so neighbouring rows never smear together. 0..1.
   */
  readonly rowSeparate = uniform(0)
  readonly rowBand = uniform(40)
  /**
   * The typing cursor: a faint source laid into the trail just after the letter being typed, so a
   * quiet stream of notes (with the specks, sections, seams of any trail) flows off it. Its block
   * (left x, right x, centre y, half height, px y-up); `cursorLevel` how strong (0 = off; pulsing
   * with the beat parts it into notes); `cursorSoft` its edge blur (px); `cursorCode` its note code.
   */
  readonly cursorRect = uniform(new THREE.Vector4())
  readonly cursorLevel = uniform(0)
  readonly cursorSoft = uniform(1)
  readonly cursorCode = uniform(0.5)
  /**
   * The row being typed (centre y, half height, left x, 1 = on): there everything flows left to right
   * whatever the walls' direction, so what is typed streams across the page from the start of its line.
   */
  readonly typeRow = uniform(new THREE.Vector4())
  /** How far the typed row moves this frame (px): at least fast enough to stay ahead of typing. */
  readonly typeStep = uniform(0)
  /** Seams: how far apart their stripes are (× size), and how irregular, 0..1. */
  readonly seamSpacing = uniform(1)
  readonly seamJitter = uniform(0.3)
  /**
   * Colour by: 0 each layer its own colour; 1 sections by loudness (louder
   * steps further along the palette, like velocity colours); 2 sections along
   * the flow (bands of the palette riding with the trails); `sectionSize` px,
   * `sectionBlend` 0 hard .. 1 smooth gradient, `sectionSpread` palette steps walked.
   */
  readonly colourBy = uniform(0)
  readonly sectionSize = uniform(60)
  readonly sectionBlend = uniform(0.3)
  readonly sectionSpread = uniform(3)
  /** Grid as lines with dots where bars meet (0), or dots only, one a cell (1). */
  readonly gridDots = uniform(0)
  /** A faint grid behind the trails (0 = off), its cell (px), and how much it shows over the notes. */
  readonly grid = uniform(0)
  readonly gridSize = uniform(22)
  readonly gridOver = uniform(0.4)
  /** 0 = miscoded (another layer's colour), 1 = tonal (a shade of the colour beneath), 2 = mask (the background). */
  readonly artifactMode = uniform(0)
  /** Softens the specks' and seams' edges, 0..3 (the trails have their own, `spread`). */
  readonly softness = uniform(0)
  /**
   * Over everything: trails, letter glow and bloom are cut hard at this level, so
   * what shows is flat shapes with crisp edges, like vector artwork (0 = off).
   */
  readonly threshold = uniform(0)
  /**
   * Vibrance, 0..1: richer colour (more chroma, in Oklab). On a light page it also keeps fading
   * trails deep rather than letting them wash out toward white.
   */
  readonly vibrance = uniform(0)
  /** 1 when the page is light (set each frame from `background`): bloom becomes a coloured haze rather than light. */
  private lightPage = uniform(0)
  /** Bloom only picks up what is brighter than this (0..1 above the background). */
  readonly glowThreshold = uniform(0.04)
  /** Far along the flow, trails split into strands: how much (0..1), and from how far out (px). */
  readonly split = uniform(0)
  readonly splitAt = uniform(300)

  readonly ramp = [0, 1, 2, 3].map(() => uniform(new THREE.Color()))
  /** 1 = each letter's hue (mask B) picks one of the multi ramps; 0 = single `ramp`. */
  readonly multi = uniform(0)
  private multiStops = Array.from({ length: MULTI_RAMPS * 4 }, () => new THREE.Vector4())
  private multiArr = uniformArray(this.multiStops, 'vec4')
  /**
   * Instruments' ramps (4 stops each, LAYERS order), for letters given to an instrument on the stage:
   * their hue is written as PART_CODE + instrument + 0.5, so they never take a mode's own ramps.
   */
  private partStops = Array.from({ length: PART_RAMPS * 4 }, () => new THREE.Vector4(1, 1, 1, 1))
  private partArr = uniformArray(this.partStops, 'vec4')
  /**
   * Images dropped on the stage (engine/dropFx.ts): per drop, where it landed and how far its wipe has run
   * (x, y, px run, how much still shows), how far it must run and how strong its front is (reach, front, on,
   * unused), and its colours (4 stops). `dropColour` 1 = the trails take them; `dropWarp` pulls the trails in.
   */
  private dropPos = Array.from({ length: DROPS }, () => new THREE.Vector4())
  private dropInfo = Array.from({ length: DROPS }, () => new THREE.Vector4())
  private dropStops = Array.from({ length: DROPS * 4 }, () => new THREE.Vector4(1, 1, 1, 1))
  private dropPosArr = uniformArray(this.dropPos, 'vec4')
  /**
   * Lanes, both ways (`sided`): per lane, the x its trails flow away from (its letter), so staggered letters each
   * send trails out to both edges. Lane l is the band `lanePitch` px tall from `laneTop` (y up) down.
   */
  private laneVp = Array.from({ length: MAX_LANES }, () => new THREE.Vector4())
  private laneVpArr = uniformArray(this.laneVp, 'vec4')
  private laneVpOn = uniform(0)
  private laneTop = uniform(0)
  private lanePitch = uniform(1)
  private dropInfoArr = uniformArray(this.dropInfo, 'vec4')
  private dropStopsArr = uniformArray(this.dropStops, 'vec4')
  /** Scroll the picture by (x, y) px, wrapping round the frame (the Sequencer's motion; 0 = still). */
  readonly scroll = uniform(new THREE.Vector2(0, 0))
  private dropColour = uniform(0)
  private dropWarp = uniform(0)
  readonly gamma = uniform(1)
  readonly background = uniform(new THREE.Color(0, 0, 0))
  /** 0 = hidden, 1 = solid letter colour, 2 = ramp colour, 3 = solid until hit, then ramp, 4 = the trail's own colour there. */
  readonly letterMode = uniform(1)
  /** Letter mode 4: the trail's colour lifted toward white (0..1) or deepened toward black (-1..0), so the letter just reads. */
  readonly letterLift = uniform(0.25)
  readonly letterColor = uniform(new THREE.Color(1, 1, 1))
  readonly grain = uniform(0.04)
  /** Rects the trail may live in, set per frame (null = anywhere). Letters still stamp outside it. */
  clip: BarLayer | null = null

  /** Playhead in lanes mode: x in px (page centre origin), half-width px, how much it lights the history. */
  readonly playheadX = uniform(-1e6)
  readonly playheadW = uniform(6)
  readonly playheadGlow = uniform(0)
  /** Lanes mode: presence kept per pass outside the letters. */
  readonly ageKeep = uniform(1)
  /** Lanes mode this frame (set each frame, like `enabled`; needs a timeline). */
  lanesOn = false
  /** Passes baked per frame. */
  bakePerFrame = 16

  private clipOn = uniform(0)
  private lanes = uniform(0)
  private simCol = uniform(0)
  private timeline = laneTexture(1, MAX_LANES)
  private live = laneTexture(MAX_LANES, 1)
  private timelineNode: any
  private liveNode: any
  private bakeTotal = 0
  private bakeDone = 0
  private clipRT: THREE.RenderTarget

  private viewport = uniform(new THREE.Vector2(1, 1))
  /** One render-target pixel, in uv. */
  private texel = uniform(new THREE.Vector2(1, 1))
  private mask: THREE.RenderTarget
  private history: [THREE.RenderTarget, THREE.RenderTarget]
  /** The notes beneath: what the top history covered, carried along with it. */
  private under: [THREE.RenderTarget, THREE.RenderTarget]
  private write = 0
  private historyQuad: THREE.QuadMesh
  private underQuad: THREE.QuadMesh
  private prevUnderNode: any
  private underNode: any
  private compQuad: THREE.QuadMesh
  private bloomQuad: THREE.QuadMesh
  private comp: THREE.RenderTarget
  private compNode: any
  // TSL's typings lag the runtime API for sampled textures; keep these loose.
  private prevNode: any
  private histNode: any
  private size = new THREE.Vector2()
  private needsClear = true

  constructor() {
    const rt = (mips = false) =>
      new THREE.RenderTarget(1, 1, {
        type: THREE.HalfFloatType, depthBuffer: false, magFilter: THREE.LinearFilter,
        // Mip levels are the blur for glows: each level is the image at half the size.
        minFilter: mips ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter, generateMipmaps: mips,
      })
    this.mask = rt(true)
    this.comp = rt(true)
    // Mipmapped: rounded trails read the walls smoothed from a mip level.
    this.history = [rt(true), rt(true)]
    this.under = [rt(true), rt(true)]
    this.clipRT = rt()
    const maskNode: any = texture(this.mask.texture)
    const clipNode: any = texture(this.clipRT.texture)
    this.timelineNode = texture(this.timeline)
    this.liveNode = texture(this.live)
    const laneMode = this.lanes.greaterThan(0.5)

    // Render-target uv runs top-down: px is y-up screen space, offsets flip back.
    const screen = () => {
      const st = uv().toVar()
      const px = st.sub(0.5).mul(this.viewport).mul(vec2(1, -1)).toVar()
      const pxToUv = vec2(1, -1).div(this.viewport).toVar()
      return { st, px, pxToUv }
    }

    /**
     * The layer index (B) at `at`, taken whole from whichever of the four
     * nearest pixels holds the most trail. Filtering would blend neighbouring
     * indices into a third layer's colour (hats beside lead read as bass), and
     * blend a wall's edge with the empty background's index.
     */
    const hueAt = (node: any, at: any) => {
      const base = at.div(this.texel).sub(0.5).floor().add(0.5).mul(this.texel).toVar()
      const best = vec4(node.sample(base).level(0)).toVar()
      for (const [x, y] of [[1, 0], [0, 1], [1, 1]] as const) {
        const t = vec4(node.sample(base.add(this.texel.mul(vec2(x, y)))).level(0))
        If(t.r.greaterThan(best.r), () => best.assign(t))
      }
      return best.b
    }

    // --- History pass ----------------------------------------------------
    this.prevNode = texture(this.history[0].texture)
    this.prevUnderNode = texture(this.under[0].texture)
    const historyNode = (slot: 'top' | 'under') => Fn(() => {
      const { st, px, pxToUv } = screen()
      const dir = mix(this.axis, normalize(px.sub(this.vp).add(vec2(1e-3, 0))), this.radial).toVar()
      const typed = this.typeRow.w.greaterThan(0.5).and(px.y.sub(this.typeRow.x).abs().lessThan(this.typeRow.y)).and(px.x.greaterThan(this.typeRow.z))
      If(typed, () => dir.assign(vec2(1, 0)))
      const perp = vec2(dir.y.negate(), dir.x).mul(this.spread).mul(pxToUv).toVar()
      const off = dir.mul(select(typed, max(this.step, this.typeStep), this.step)).mul(pxToUv).toVar()
      const along = dir.mul(this.smear).mul(pxToUv).toVar()
      // Each component varies only across itself, so the flow neither gathers
      // nor thins colour; worked in a turned frame so its direction can change.
      const ca = cos(this.swirlAngle)
      const sa = sin(this.swirlAngle)
      const raw = px.div(this.swirlSize).toVar()
      const eddy = vec2(raw.x.mul(ca).add(raw.y.mul(sa)), raw.y.mul(ca).sub(raw.x.mul(sa)))
      const flow = vec2(sin(eddy.y.add(this.swirlPhase.mul(0.6))), sin(eddy.x.mul(1.3).sub(this.swirlPhase.mul(0.45))))
      const curl = vec2(flow.x.mul(ca).sub(flow.y.mul(sa)), flow.x.mul(sa).add(flow.y.mul(ca)))
        .mul(this.swirl).mul(pxToUv).toVar()

      // Depth: this pixel shows what was a little further out (and turned) last
      // frame, so everything recedes into the vanishing point; the pump scales
      // about its own centre, out and back like a speaker cone.
      const d = px.sub(this.vp)
      const ct = cos(this.twist)
      const stw = sin(this.twist)
      const turned = vec2(d.x.mul(ct).add(d.y.mul(stw)), d.y.mul(ct).sub(d.x.mul(stw)))
      const deep = this.vp.add(turned.mul(float(1).add(this.zoom)))
      const pumped = this.pumpCentre.add(deep.sub(this.pumpCentre).mul(float(1).sub(this.pump)))
      // Reflow: what is at this height moves as the lines of text nearest it moved.
      const moved = vec2(0, 0).toVar()
      const reach = float(0).toVar()
      for (let i = 0; i < FLOW_LINES; i++) {
        const line: any = (this.lineFlowArr as any).element(i)
        const w = line.w.mul(exp(px.y.sub(line.x).div(this.lineSpread).pow(2).negate()))
        moved.addAssign(line.yz.mul(w))
        reach.addAssign(w)
      }
      const source = pumped.sub(moved.div(reach.add(1e-9)))
      const depth = source.sub(px).mul(pxToUv).toVar()

      // What was one step closer to the type last frame, diffused slightly
      // across (spread) and along (smear) the axis so trails soften with age.
      const pullFrom = (node: any) => (o: any) => {
        const across = node.sample(o).mul(2).add(node.sample(o.add(perp))).add(node.sample(o.sub(perp))).div(4)
        const lengthwise = node.sample(o.add(along)).add(node.sample(o.sub(along))).div(2)
        return mix(across, lengthwise, 0.5)
      }
      const pull = pullFrom(this.prevNode)
      const from = st.add(depth).sub(curl).toVar()
      const behind: any = pull(from.sub(off)).toVar()
      const ahead: any = pull(from.add(off)).toVar()
      // Both ways: each side of the centre line flows away from it, so streams
      // from different lines never cross and fight over the same pixels.
      const laneIdx = this.laneTop.sub(px.y).div(this.lanePitch).floor().clamp(0, MAX_LANES - 1).toInt()
      const vpHere = select(this.laneVpOn.greaterThan(0.5), vec2((this.laneVpArr as any).element(laneIdx).x, this.vp.y), this.vp)
      const useAhead = this.sided.greaterThan(0.5).and(dot(px.sub(vpHere), dir).lessThan(0)).and(typed.not())
      const prev: any = select(useAhead, ahead, behind)
      // Hue is an index, so it is carried whole, never averaged (averaging blue and yellow would land on red).
      const fromUv = select(useAhead, from.add(off), from.sub(off)).toVar()
      const prevHue = hueAt(this.prevNode, fromUv)

      const m = maskNode.sample(st)
      const cov = max(m.a, 1e-3)
      // R is already coverage * activity: how much this pixel feeds the trail.
      const rawStamp = m.r
      // Any real stamp takes its letter's colour; only untouched pixels carry the trail's. (A faint
      // stamp keeping the old hue made a held bass note pour in whatever colour passed there before.)
      // Note codes snap back to their exact value. Where two letters' soft edges or halos overlap their
      // codes blend into nonsense (another layer's colour), so a code is only taken from solid letter:
      // here, or the most solid pixel close by; failing that the trail keeps its own.
      const code = m.b.div(cov).toVar()
      If(code.greaterThanEqual(1), () => {
        const best = float(-1).toVar()
        const bestCov = float(0.35).toVar()
        for (const [x, y] of [[0, 0], [2, 0], [-2, 0], [0, 2], [0, -2]] as const) {
          const t: any = maskNode.sample(st.add(this.texel.mul(vec2(x, y)))).level(0)
          const c = t.b.div(max(t.a, 1e-3))
          const clean = c.sub(c.floor()).sub(0.5).abs().lessThan(0.15).and(t.a.greaterThan(bestCov))
          If(clean, () => {
            best.assign(c.floor().add(0.5))
            bestCov.assign(t.a)
          })
        }
        code.assign(select(best.greaterThan(0), best, prevHue))
      })
      // A soft edge with no note to give (only a halo, nothing beneath) leaves no trail rather than a wrong colour.
      const letterStamp = select(m.b.div(cov).lessThan(1).or(code.greaterThanEqual(1)), rawStamp, float(0))
      // The typing cursor's faint source: it never brightens the trail past its own level.
      const cr = this.cursorRect
      const cd = px.sub(vec2(cr.x.add(cr.y).mul(0.5), cr.z)).abs().sub(vec2(cr.y.sub(cr.x).abs().mul(0.5), cr.w))
      const cursorP = smoothstep(this.cursorSoft, this.cursorSoft.negate(), max(cd.x, cd.y)).mul(this.cursorLevel)
      const cursorWins = cursorP.greaterThan(letterStamp).and(cursorP.greaterThan(0.01))
      // Lanes: this column of the timeline, for the letter's lane.
      const tl = this.timelineNode.sample(vec2(this.simCol, m.g.div(cov)))
      const stamp = select(laneMode, m.a.mul(tl.r), select(cursorWins, float(0), letterStamp))
      const emission = select(laneMode, tl.g, m.g.div(cov))
      If(cursorWins, () => code.assign(this.cursorCode))
      const clip = mix(float(1), clipNode.sample(st).a, this.clipOn)
      const keep = select(laneMode, mix(this.ageKeep, this.keep, m.a), this.keep)
      const presence = max(mix(prev.r.mul(keep).mul(clip), float(1), stamp), select(cursorWins, cursorP, float(0)))
      const value = select(cursorWins, max(prev.g, 0.6), mix(prev.g, emission, stamp))
      const hue = select(stamp.greaterThan(0.02).or(cursorWins), code, prevHue)
      // Alpha carries how hard a shockwave is pushing here, so the composite can light the ring.
      if (slot === 'top') return vec4(presence, value, hue, 0)

      // Beneath: carried exactly as the top is. A new note landing on a different one still showing
      // takes its place on top; that one slips underneath and carries on (if it outshines what is there).
      const pullU = pullFrom(this.prevUnderNode)
      const prevU: any = select(useAhead, pullU(from.add(off)), pullU(from.sub(off)))
      const underKept = prevU.r.mul(this.keep).mul(clip)
      const topKept = prev.r.mul(this.keep).mul(clip)
      const covers = stamp.greaterThan(0.02).and(topKept.greaterThan(0.12)).and(code.sub(prevHue).abs().greaterThan(0.5))
        .and(topKept.greaterThan(underKept)).and(this.layering.greaterThan(0.5))
      // Alpha: how far the note on top has taken on this one's colour, growing while they flow on together.
      const together = underKept.greaterThan(0.08).and(topKept.greaterThan(0.08))
      const mixed = select(together, prevU.a.add(this.fluidStep).min(1), prevU.a.mul(0.9))
      return select(covers, vec4(topKept, prev.g, prevHue, 0), vec4(underKept, prevU.g, hueAt(this.prevUnderNode, fromUv), mixed))
    })()
    const histMat = new THREE.MeshBasicNodeMaterial()
    histMat.colorNode = historyNode('top')
    this.historyQuad = new THREE.QuadMesh(histMat)
    const underMat = new THREE.MeshBasicNodeMaterial()
    underMat.colorNode = historyNode('under')
    this.underQuad = new THREE.QuadMesh(underMat)

    // --- Composite pass --------------------------------------------------
    this.histNode = texture(this.history[1].texture)
    this.underNode = texture(this.under[1].texture)
    const single = this.ramp.map((c) => vec3(c as any))
    const multiArr: any = this.multiArr
    const rampAt = (v: any, hue: any, shift: any = float(0)) =>
      Fn(() => {
        // A note code (1 or more) holds the layer in its last three bits.
        const layer = select(hue.greaterThanEqual(1), mod(hue.floor(), 8).add(0.5).div(8), hue)
        const index = mod(layer.mul(MULTI_RAMPS).floor().clamp(0, MULTI_RAMPS - 1).add(shift), MULTI_RAMPS)
        const base = index.toInt().mul(4).toVar()
        // A letter given to an instrument (hue PART_CODE + instrument + 0.5) takes the instrument's ramp.
        const part = hue.greaterThanEqual(PART_CODE).and(hue.lessThan(PART_CODE + 8))
        const partBase = hue.floor().sub(PART_CODE).clamp(0, PART_RAMPS - 1).toInt().mul(4).toVar()
        const [c0, c1, c2, c3] = single.map((c, k) =>
          select(part, vec3((this.partArr as any).element(partBase.add(k)).xyz),
            select(this.multi.greaterThan(0.5), vec3(multiArr.element(base.add(k)).xyz), c)).toVar(),
        )
        const col = vec3(c0).toVar()
        If(v.lessThan(1 / 3), () => col.assign(mix(c0, c1, smoothstep(0, 1 / 3, v))))
          .ElseIf(v.lessThan(2 / 3), () => col.assign(mix(c1, c2, smoothstep(1 / 3, 2 / 3, v))))
          .Else(() => col.assign(mix(c2, c3, smoothstep(2 / 3, 1, v))))
        return col
      })()


    // Oklab: mixing here keeps the middle of a blend clean and bright (paint, not mud).
    const toLab = (c: any) => {
      const l = pow(max(dot(c, vec3(0.4122214708, 0.5363325363, 0.0514459929)), 0), 1 / 3)
      const m = pow(max(dot(c, vec3(0.2119034982, 0.6806995451, 0.1073969566)), 0), 1 / 3)
      const s = pow(max(dot(c, vec3(0.0883024619, 0.2817188376, 0.6299787005)), 0), 1 / 3)
      return vec3(dot(vec3(l, m, s), vec3(0.2104542553, 0.793617785, -0.0040720468)),
        dot(vec3(l, m, s), vec3(1.9779984951, -2.428592205, 0.4505937099)),
        dot(vec3(l, m, s), vec3(0.0259040371, 0.7827717662, -0.808675766)))
    }
    const fromLab = (c: any) => {
      const l = dot(c, vec3(1, 0.3963377774, 0.2158037573))
      const m = dot(c, vec3(1, -0.1055613458, -0.0638541728))
      const s = dot(c, vec3(1, -0.0894841775, -1.291485548))
      const l3 = l.mul(l).mul(l)
      const m3 = m.mul(m).mul(m)
      const s3 = s.mul(s).mul(s)
      return max(vec3(dot(vec3(l3, m3, s3), vec3(4.0767416621, -3.3077115913, 0.2309699292)),
        dot(vec3(l3, m3, s3), vec3(-1.2684380046, 2.6097574011, -0.3413193965)),
        dot(vec3(l3, m3, s3), vec3(-0.0041960863, -0.7034186147, 1.707614701))), vec3(0, 0, 0))
    }

    const compMat = new THREE.MeshBasicNodeMaterial()
    compMat.colorNode = Fn(() => {
      const st = uv().toVar()
      // The threshold: below it nothing, above it solid, with an edge just soft enough not to alias.
      const cut = (p: any) => select(this.threshold.greaterThan(0.001), smoothstep(this.threshold.sub(0.02), this.threshold.add(0.02), p), p)
      const src = st.sub(0.5).mul(this.viewport).mul(vec2(1, -1)).toVar()
      // Scrolling (the Sequencer's motion): read the picture shifted, wrapping round the frame.
      If(this.scroll.length().greaterThan(0.001), () => {
        const half = this.viewport.mul(0.5)
        src.assign(mod(src.sub(this.scroll).add(half), this.viewport).sub(half))
      })
      // A dropped image warping in: just ahead of its front the trails are drawn from further out (pulled in).
      If(this.dropWarp.greaterThan(0.001), () => {
        const shift = vec2(0, 0).toVar()
        for (let i = 0; i < DROPS; i++) {
          const d: any = (this.dropPosArr as any).element(i)
          const info: any = (this.dropInfoArr as any).element(i)
          const rel = src.sub(d.xy)
          const dist = rel.length().add(1e-3)
          const k = exp(dist.sub(d.z).div(160).pow(2).negate()).mul(info.y).mul(info.z).mul(this.dropWarp)
          shift.addAssign(rel.div(dist).mul(min(dist.mul(0.6), k.mul(90))))
        }
        src.addAssign(shift)
      })
      const shade = float(1)
      const srcUv = src.mul(vec2(1, -1)).div(this.viewport).add(0.5).toVar()
      const melt = float(0)
      const h = this.histNode.sample(srcUv).toVar()
      // The layer index is never averaged (it would pick the wrong colours): each sample takes its own, unblurred.
      h.z.assign(hueAt(this.histNode, srcUv))
      // Rounded trails: the trail drawn from its own blurred shape, cut at the halfway mark, so ends and
      // corners round over and notes that nearly touch run together like droplets. Where the shape grows
      // past the trail, it takes the nearest note's colour.
      const blob = float(-1).toVar()
      If(this.roundness.greaterThan(0.01), () => {
        // Grows in gently: a little blur and a soft edge at first, rounder and crisper as it goes up, and
        // only ever blended with the trail as it was, so faint tails fade rather than being cut off.
        const lvl = this.roundness.mul(3)
        const soft = this.histNode.sample(srcUv).level(lvl).r.clamp(0, 1)
        const w = mix(float(0.5), float(0.12), this.roundness).add(this.spread.mul(0.05))
        const rounded = smoothstep(float(0.4).sub(w), float(0.4).add(w), soft)
        blob.assign(mix(h.r.clamp(0, 1), max(rounded, h.r.clamp(0, 1).mul(0.6)), this.roundness.mul(1.5).clamp(0, 1)))
        If(h.r.lessThan(0.1).and(blob.greaterThan(0.01)), () => {
          const reach = pow(2, lvl).mul(this.texel)
          const best = vec4(h).toVar()
          for (const [x, y] of [[1, 0], [-1, 0], [0, 1], [0, -1], [0.7, 0.7], [-0.7, 0.7], [0.7, -0.7], [-0.7, -0.7]] as const) {
            const at = srcUv.add(reach.mul(vec2(x, y))).div(this.texel).sub(0.5).floor().add(0.5).mul(this.texel)
            const t = vec4(this.histNode.sample(at).level(0))
            If(t.r.greaterThan(best.r), () => best.assign(t))
          }
          h.assign(vec4(h.r, best.g, best.b, h.a))
        })
      })
      const value = pow(h.g.clamp(0, 1), this.gamma).toVar()
      // Lanes: the playhead lights what it is passing over.
      {
        const x = st.x.sub(0.5).mul(this.viewport.x)
        const near = x.sub(this.playheadX).div(this.playheadW)
        value.assign(mix(value, float(1), this.playheadGlow.mul(near.mul(near).negate().exp())))
      }
      // Rolled trails blend from one ramp into the next.
      const rolled = mix(rampAt(value, h.b, this.roll.floor()), rampAt(value, h.b, this.roll.floor().add(1)), fract(this.roll)).toVar()
      const px = src
      // Coordinates riding with the trail: along the flow (less how far it has travelled; both ways,
      // each side runs away from the middle) and across it.
      const rel = px.sub(this.vp)
      const radialFlow = this.radial.greaterThan(0.5)
      const flow = select(radialFlow, normalize(rel.add(vec2(1e-3, 0))), this.axis).toVar()
      const side = vec2(flow.y.negate(), flow.x).toVar()
      const alongT = select(radialFlow, rel.length(), select(this.sided.greaterThan(0.5), dot(rel, this.axis).abs(), dot(rel, this.axis))).sub(this.travel).toVar()
      const acrossT = select(radialFlow, atan(rel.y, rel.x).mul(rel.length().max(60)), dot(rel, side)).toVar()
      const hash = (c: any) => fract(sin(dot(c, vec2(12.9898, 78.233))).mul(43758.5453))
      const layerOf = (c: any) => select(c.greaterThanEqual(1), mod(c.floor(), 8), c.mul(MULTI_RAMPS).floor())

      // Sections: the walls break into blocks of the palette, by loudness or along the flow,
      // from hard-edged blocks to a smooth gradient, starting from each layer's own colour.
      If(this.colourBy.greaterThan(0.5), () => {
        const steps = max(this.sectionSpread, 1)
        const span = steps.mul(2)
        const along = alongT.div(max(this.sectionSize, 4))
        // Along the flow: there and back through the palette, so neighbouring blocks are neighbouring colours.
        const pingPong = min(mod(along, span), span.sub(mod(along, span)))
        const walk = select(this.colourBy.lessThan(1.5), value.mul(steps), pingPong)
        const f = layerOf(h.z).add(walk)
        const t = fract(f)
        const b = this.sectionBlend.clamp(0, 1).mul(0.5)
        const edge = smoothstep(float(0.5).sub(b), float(0.5).add(b).add(1e-3), t)
        const at = (k: any) => mod(k, 7).add(0.5).div(MULTI_RAMPS)
        rolled.assign(mix(rampAt(value, at(f.floor())), rampAt(value, at(f.floor().add(1))), edge))
      })
      const far = select(this.depthFade.greaterThan(0), smoothstep(0, this.depthFade, px.sub(this.vp).length()), float(1))
      const lit = rolled.mul(float(1).add(h.a.mul(0.25))).mul(shade).toVar()
      // Split: far along the flow the trail breaks into strands (rays when radial).
      const along = select(radialFlow, rel.length(), dot(rel, this.axis).abs())
      const across = select(radialFlow, atan(rel.y, rel.x).mul(40), dot(rel, vec2(this.axis.y.negate(), this.axis.x)).div(9))
      const strands = smoothstep(0.2, 0.8, sin(across).mul(0.5).add(0.5))
      const splitting = this.split.mul(smoothstep(this.splitAt, this.splitAt.mul(1.6).add(1), along))
      const body = h.r.clamp(0, 1)
      const presence = select(blob.greaterThanEqual(0), blob, body).mul(far).mul(mix(float(1), strands, splitting)).toVar()
      // Rows kept apart: horizontal walls fade out toward the edge of their own line's band.
      const rowMask = float(1).toVar()
      If(this.rowSeparate.greaterThan(0.001).and(this.radial.lessThan(0.5)).and(this.axis.x.abs().greaterThan(0.5)), () => {
        const inRow = float(0).toVar()
        const any = float(0).toVar()
        for (let i = 0; i < FLOW_LINES; i++) {
          const line: any = (this.lineFlowArr as any).element(i)
          const d = px.y.sub(line.x).abs()
          inRow.assign(max(inRow, line.w.mul(float(1).sub(smoothstep(this.rowBand.mul(0.7), this.rowBand, d)))))
          any.assign(max(any, line.w))
        }
        rowMask.assign(select(any.greaterThan(0.5), mix(float(1), inRow, this.rowSeparate), float(1)))
        presence.mulAssign(rowMask)
      })
      // Gloss: bright cores running along each strand, like light on glass bars.
      lit.addAssign(vec3(1, 1, 1).mul(pow(sin(across).mul(0.5).add(0.5), 6)).mul(this.gloss).mul(0.6).mul(value.add(0.3)))

      // Notes. Where two layers meet their colours mix like paint: an even blend right at the join,
      // turning back into each layer's own colour further from it. Where notes of one layer meet, the
      // join breaks into seams: the tail combs out into stripes and a few cells take the other note's
      // colour, like a sequencer's notes smearing into each other. Artifacts: miscoded specks riding
      // the trails in another layer's colour, mostly in the tails and at the joins.
      const ground = vec3(this.background as any).toVar()
      If(this.layering.greaterThan(0.5), () => {
        const toUv = (o: any) => o.mul(vec2(1, -1)).div(this.viewport)
        const snap = (at: any) => at.div(this.texel).sub(0.5).floor().add(0.5).mul(this.texel)
        const mine = layerOf(h.z).toVar()

        // Paint: where this trail runs straight into another layer's (no gap between), the two mix like
        // paint across the join: an even blend at the join, each layer's own colour further from it.
        // Each way is followed outward only while the trail is unbroken, so a note with nothing different
        // between it and the end of its trail keeps its colour, and rows never mix across empty space.
        If(this.colourBlend.greaterThan(0.5), () => {
          const sumLab = toLab(lit).mul(h.r.clamp(0, 1)).toVar()
          const weight = h.r.clamp(0, 1).toVar()
          const others = float(0).toVar()
          const count = float(0).toVar()
          // Across the flow, only about as far as a trail is tall.
          const sideReach = min(this.colourBlend, 48)
          for (const [dir, reach, ks] of [[flow, 1, [0.1, 0.22, 0.36, 0.52, 0.7, 0.9]], [side, 0, [0.25, 0.55, 0.9]]] as const) {
            for (const sign of [1, -1]) {
              const alive = float(1).toVar()
              for (const k of ks) {
                const dist = (reach ? this.colourBlend : sideReach).mul(k * sign)
                const at = snap(srcUv.add(toUv((dir as any).mul(dist))))
                const t: any = this.histNode.sample(at).level(0)
                const p = t.r.clamp(0, 1)
                alive.mulAssign(select(p.greaterThan(0.12), float(1), float(0)))
                const col = rampAt(pow(t.g.clamp(0, 1), this.gamma), t.b)
                sumLab.addAssign(toLab(col).mul(p).mul(alive))
                weight.addAssign(p.mul(alive))
                others.addAssign(select(layerOf(t.b).notEqual(mine), smoothstep(0.12, 0.4, p), float(0)).mul(alive))
                count.addAssign(1)
              }
            }
          }
          const lean = others.div(count).mul(2).clamp(0, 1)
          lit.assign(mix(lit, fromLab(sumLab.div(weight.add(1e-3))), lean.mul(select(h.r.greaterThan(0.05), float(1), float(0)))))
        })

        // Seams between notes of one layer: how close (along the flow) another note begins.
        const size = max(this.artifactSize, 1)
        const near = float(0).toVar()
        const nearCol = vec3(lit).toVar()
        for (const [k, w] of [[1.5, 1], [-1.5, 1], [4, 0.6], [-4, 0.6], [8, 0.3], [-8, 0.3]] as const) {
          const at = snap(srcUv.add(toUv(flow.mul(size.mul(this.seamSpacing).mul(k)))))
          const t: any = this.histNode.sample(at).level(0)
          const isJoin = t.r.greaterThan(0.12).and(t.b.sub(h.z).abs().greaterThan(0.5)).and(layerOf(t.b).equal(mine))
          If(isJoin.and(float(w).greaterThan(near)), () => {
            near.assign(w)
            nearCol.assign(rampAt(pow(t.g.clamp(0, 1), this.gamma), t.b))
          })
        }
        const seam = near.mul(this.noteGap).toVar()
        // Softness feathers the stripes and specks as it softens the trails.
        const feather = this.softness.div(3).clamp(0, 1).mul(0.45).add(0.04).toVar()
        const blockEdge = (x: any) => smoothstep(0, feather, x).mul(smoothstep(0, feather, float(1).sub(x)))
        // The seam's stripes: `seamSpacing` apart, each row shifted and each stripe a different width by `seamJitter`.
        const row = acrossT.div(size).floor()
        const jitter = this.seamJitter.clamp(0, 1)
        const stripeAt = alongT.div(size.mul(2).mul(this.seamSpacing)).add(hash(vec2(row, 4.2)).mul(jitter).mul(3))
        const duty = float(0.5).add(hash(vec2(stripeAt.floor(), row)).sub(0.5).mul(jitter).mul(0.8))
        const comb = smoothstep(duty.sub(feather), duty.add(feather), fract(stripeAt))
        presence.mulAssign(mix(float(1), comb.mul(0.65).add(0.35), seam))
        const cellAt = vec2(alongT.div(size.mul(3).mul(this.seamSpacing)), acrossT.div(size))
        const cell = cellAt.floor()
        const inCell = fract(cellAt)
        const block = blockEdge(inCell.x).mul(blockEdge(inCell.y)).toVar()
        const swapChance = seam.mul(0.45).mul(float(1).add(hash(vec2(row, 9.7)).sub(0.5).mul(jitter).mul(1.6)))
        lit.assign(mix(lit, nearCol, select(hash(cell).lessThan(swapChance), block, float(0))))

        // Artifacts: specks in a wrong colour, thickest in fading tails and at joins.
        If(this.artifacts.greaterThan(0.001), () => {
          // Artifacts are notes on a piano roll: steps along the flow (riding with it), rows across it.
          // By instrument, each layer has its own note length and rhythm.
          const pick = (arr: any, layer: any) => {
            const v: any = select(layer.lessThan(3.5), arr.element(0), arr.element(1))
            const k = mod(layer, 4)
            return select(k.lessThan(0.5), v.x, select(k.lessThan(1.5), v.y, select(k.lessThan(2.5), v.z, v.w)))
          }
          const byInst = this.artifactByInstrument.greaterThan(0.5)
          const lenSteps = max(this.artifactLength.mul(select(byInst, pick(this.layerLenArr, mine), float(1))), 0.25)
          const stepPx = size.mul(3).mul(lenSteps).toVar()
          const noteAt = vec2(alongT.div(stepPx), acrossT.div(size)).toVar()
          const stepN = noteAt.x.floor().toVar()
          const rowN = noteAt.y.floor().toVar()
          const localY = fract(noteAt.y)
          // How many notes: fixed for each part of the trail, so a note never pops in or out as the trail
          // travels or fades; it is there from the start and fades away with the trail.
          const d = this.artifacts.mul(select(byInst, pick(this.layerDensityArr, mine), float(1))).toVar()
          const same = (x: any, y: any) => x.sub(y).abs().lessThan(0.5)
          const r8 = mod(rowN, 8)
          const phraseY = rowN.div(8).floor()
          /** Whether there is a note at step `st` on this row (as a piano roll would have it). */
          const noteOn = (st: any) => {
            const phrase = vec2(st.div(8).floor(), phraseY)
            const hp = hash(phrase.add(0.37))
            const s8 = mod(st, 8)
            const chance = (k: number, c: any) => hash(vec2(st, rowN).add(k)).lessThan(c)
            const on = float(0).toVar()
            const pattern = this.artifactPattern
            If(pattern.lessThan(0.5), () => {
              on.assign(select(chance(31.7, d.mul(0.35)), float(1), float(0)))
            }).ElseIf(pattern.lessThan(1.5), () => {
              // Staircase: one note per step, climbing (or falling) a row each time.
              const target = mod(select(hp.lessThan(0.5), s8, float(7).sub(s8)).add(hp.mul(8).floor()), 8)
              const phraseOn = hash(phrase.add(1.1)).lessThan(d.mul(2.2))
              on.assign(select(phraseOn.and(same(r8, target)).and(chance(3.3, float(0.92))), float(1), float(0)))
            }).ElseIf(pattern.lessThan(2.5), () => {
              // Chords: three notes a third apart, struck together.
              const base = hp.mul(4).floor()
              const struck = hash(vec2(st, phraseY).add(7.7)).lessThan(d.mul(1.1))
              const tone = same(r8, base).or(same(r8, base.add(2))).or(same(r8, base.add(4)))
              on.assign(select(struck.and(tone), float(1), float(0)))
            }).ElseIf(pattern.lessThan(3.5), () => {
              // Runs: the same note repeated along one row, with gaps.
              const phraseOn = hash(phrase.add(2.2)).lessThan(d.mul(2.6))
              const hit = hash(vec2(st, phraseY).add(9.1)).lessThan(float(0.75))
              on.assign(select(phraseOn.and(same(r8, hp.mul(8).floor())).and(hit), float(1), float(0)))
            }).Else(() => {
              // Follow the music: the row is the pitch this layer was playing when the trail was laid down.
              // (The same step the app wrote it to as the trails moved: see writeMelody.)
              const shared = st.add(0.5).mul(stepPx).div(size.mul(3).mul(max(this.artifactLength, 0.25))).floor()
              const slot = mod(shared, MELODY_STEPS)
              const entry: any = select(mine.lessThan(3.5), this.melodyArr.element(slot.mul(2).toInt()), this.melodyArr.element(slot.mul(2).add(1).toInt()))
              const k = mod(mine, 4)
              const m = select(k.lessThan(0.5), entry.x, select(k.lessThan(1.5), entry.y, select(k.lessThan(2.5), entry.z, entry.w)))
              on.assign(select(m.greaterThanEqual(0).and(same(r8, m.mul(7.99).floor())).and(chance(5.5, d.mul(4).min(1))), float(1), float(0)))
            })
            // Hats keep to every other step, like hats on the twos.
            const offBeat = byInst.and(same(mine, 2)).and(mod(st, 2).greaterThan(0.5))
            return select(offBeat, float(0), on)
          }
          /** Distance (px) from this pixel to the note at step `st`: a block, or a pill. Far away when there is none. */
          const noteDist = (st: any) => {
            // How much of its step the note fills: as long as this instrument's notes were really sounding
            // when this part of the trail was laid down (by instrument), less a varying gap.
            const shared = st.add(0.5).mul(stepPx).div(size.mul(3).mul(max(this.artifactLength, 0.25))).floor()
            const slot = mod(shared, MELODY_STEPS)
            const played = pick({ element: (k: number) => this.noteFillArr.element(slot.mul(2).add(k).toInt()) }, mine)
            const fill = select(byInst, played, float(1)).mul(float(1).sub(this.artifactGaps.mul(hash(vec2(st, rowN).add(13.3)).mul(0.6).add(0.3))))
            const len = fill.mul(stepPx)
            const r = select(this.artifactShape.lessThan(0.5), float(0), size.mul(0.42))
            const halfH = select(this.artifactShape.lessThan(0.5), size.mul(0.5), r)
            const p = vec2(noteAt.x.sub(st).mul(stepPx).sub(len.mul(0.5)), localY.sub(0.5).mul(size))
            const q = p.abs().sub(vec2(len.mul(0.5), halfH).sub(r))
            const dist = max(q, vec2(0, 0)).length().add(min(max(q.x, q.y), 0)).sub(r)
            return select(noteOn(st).greaterThan(0.5), dist, float(1e4))
          }
          const n2Of = (st: any) => hash(vec2(st, rowN).add(vec2(3.1, 91.7)))
          const colourOf = (n2: any) => {
            const wrong = n2.mul(7).floor().add(0.5).div(MULTI_RAMPS)
            const miscoded = rampAt(value.mul(n2.mul(0.8).add(0.6)).clamp(0, 1), wrong)
            // Tonal: a darker shade of the colour it sits on (now and then a lighter one).
            const tonal = select(n2.greaterThan(0.8), mix(lit, vec3(1, 1, 1), 0.3), lit.mul(n2.mul(0.35).add(0.35)))
            return select(this.artifactMode.lessThan(0.5), miscoded, select(this.artifactMode.lessThan(1.5), tonal, vec3(this.background as any)))
          }
          const featherPx = feather.mul(size).toVar()
          const dHere = noteDist(stepN).toVar()
          const col = colourOf(n2Of(stepN)).toVar()
          const dist = dHere.toVar()
          // Droplets: pills that reach for the notes either side and run into them, colours flowing across.
          If(this.artifactShape.greaterThan(1.5), () => {
            const k = size.mul(0.9)
            const smin = (x: any, y: any) => {
              const hk = max(k.sub(x.sub(y).abs()), 0).div(k)
              return min(x, y).sub(hk.mul(hk).mul(k).mul(0.25))
            }
            const dPrev = noteDist(stepN.sub(1))
            const dNext = noteDist(stepN.add(1))
            dist.assign(smin(smin(dHere, dPrev), dNext))
            const w = (x: any) => exp(max(x, 0).div(size.mul(0.5)).negate())
            const w0 = w(dHere)
            const wp = w(dPrev)
            const wn = w(dNext)
            col.assign(col.mul(w0).add(colourOf(n2Of(stepN.sub(1))).mul(wp)).add(colourOf(n2Of(stepN.add(1))).mul(wn)).div(w0.add(wp).add(wn).add(1e-4)))
          })
          const amount = float(1).sub(smoothstep(featherPx.negate(), featherPx, dist)).mul(smoothstep(0.02, 0.3, h.r)).toVar()
          lit.assign(mix(lit, col, amount))
          // A miscoded or tonal speck shows even in a faint tail; a mask speck is a hole, so it leaves presence be.
          presence.assign(mix(presence, max(presence, h.r.clamp(0, 1).mul(0.6).add(0.4)), select(this.artifactMode.lessThan(1.5), amount, float(0))))
        })

        // The note beneath carries on in its own colour where nothing covers it, and shows through the
        // one on top as a shadow of its shape (the top keeps its own colour).
        const below: any = this.underNode.sample(srcUv).level(melt)
        const belowP = cut(below.r.clamp(0, 1).mul(far).mul(rowMask)).toVar()
        const belowRaw = rampAt(pow(below.g.clamp(0, 1), this.gamma), hueAt(this.underNode, srcUv)).mul(shade)
        const belowCol = belowRaw.mul(0.8)
        ground.assign(mix(ground, belowCol, belowP.mul(0.85)))
        // Fluid: the note on top shifts toward the colour flowing beneath it (Oklab, so the passage stays clean).
        const taken = below.a.clamp(0, 1).mul(this.fluid).mul(smoothstep(0.05, 0.3, belowP)).toVar()
        If(taken.greaterThan(0.001), () => lit.assign(fromLab(mix(toLab(lit), toLab(belowRaw), taken))))
        lit.mulAssign(float(1).sub(belowP.mul(this.seeThrough).mul(0.55).mul(float(1).sub(taken))))
      })
      // Dropped images: where a wipe has passed, the trails take its colours (most prominent at the drop point),
      // fading back spot by spot (a fixed share per 4 px, as the dot modes do).
      If(this.dropColour.greaterThan(0.5), () => {
        const share = fract(sin(dot(px.div(4).floor(), vec2(12.9898, 78.233))).mul(43758.5453)).abs()
        for (let i = 0; i < DROPS; i++) {
          const d: any = (this.dropPosArr as any).element(i)
          const info: any = (this.dropInfoArr as any).element(i)
          const dist = px.sub(d.xy).length()
          If(info.z.greaterThan(0.5).and(dist.lessThan(d.z)).and(share.lessThan(d.w)), () => {
            const t = dist.div(max(info.x, 1)).clamp(0, 1).mul(3)
            const k = t.floor().clamp(0, 2)
            const s0 = vec3((this.dropStopsArr as any).element(k.add(i * 4).toInt()).xyz)
            const s1 = vec3((this.dropStopsArr as any).element(k.add(i * 4 + 1).toInt()).xyz)
            lit.assign(mix(s0, s1, t.sub(k)).mul(value.mul(0.45).add(0.55)))
          })
        }
      })
      // Vibrance: more chroma; on a light page, fading trails stay deep in colour instead of going pale.
      If(this.vibrance.greaterThan(0.001), () => {
        const lab = toLab(max(lit, vec3(0, 0, 0))).toVar()
        const boost = float(1).add(this.vibrance.mul(mix(float(0.35), float(0.7), this.lightPage)))
        lit.assign(fromLab(vec3(lab.x, lab.y.mul(boost), lab.z.mul(boost))))
        presence.assign(pow(presence.clamp(0, 1), float(1).sub(this.vibrance.mul(this.lightPage).mul(0.45))))
      })
      presence.assign(cut(presence))
      const trail = mix(ground, lit, presence).toVar()

      // Grid: faint lines like a piano roll's, with dots where the bars meet. Lines are a touch darker
      // than a light page (lighter than a dark one), and show faintly lighter across the notes.
      If(this.grid.greaterThan(0.001), () => {
        const g = st.mul(this.viewport)
        const cellPx = max(this.gridSize, 4)
        const d = fract(g.div(cellPx).add(0.5)).sub(0.5).abs().mul(cellPx)
        const dots = this.gridDots.greaterThan(0.5)
        const line = select(dots, float(0), max(float(1).sub(smoothstep(0.2, 1.1, d.x)), float(1).sub(smoothstep(0.2, 1.1, d.y))))
        // Dots: one at every cell (dots style), or only where the bars meet (every fourth line).
        const major = fract(g.div(cellPx.mul(4)).add(0.5)).sub(0.5).abs().mul(cellPx.mul(4))
        const dotMark = select(dots, float(1).sub(smoothstep(1.1, 2, d.length())).mul(0.7), float(1).sub(smoothstep(1.6, 2.6, major.length())))
        const bg = vec3(this.background as any)
        const ink = select(dot(bg, vec3(0.2126, 0.7152, 0.0722)).greaterThan(0.5), vec3(0, 0, 0), vec3(1, 1, 1))
        const clear = float(1).sub(presence)
        trail.assign(mix(trail, ink, line.mul(this.grid).mul(0.35).mul(clear)))
        trail.assign(mix(trail, ink, dotMark.mul(this.grid).mul(0.9).mul(clear)))
        trail.assign(mix(trail, vec3(1, 1, 1), max(line, dotMark).mul(this.grid).mul(this.gridOver).mul(presence).mul(0.6)))
      })

      // Letters on top: solid colour, or the ramp at this frame's emission.
      const m = maskNode.sample(st)
      const cov = max(m.a, 1e-3)
      const lv = this.liveNode.sample(vec2(m.g.div(cov), 0.5))
      const letterValue = pow(select(laneMode, lv.g, m.g.div(cov)).clamp(0, 1), this.gamma)
      const letterHue = m.b.div(cov)
      const activity = select(laneMode, lv.r, m.r.div(cov)).clamp(0, 1)
      const solid = vec3(this.letterColor as any)
      const ramped = rampAt(letterValue, letterHue)
      // In the trail's colour: the bar's hue at the letter (whatever its strength), a touch lighter (or darker), so the
      // letter is the bar's head.
      // Its colour is read along its bar, either side (the strongest of a few spots, near to far), so the letter
      // takes the bar's real hue rather than the quiet colour that may sit right against it.
      const lift = this.letterLift
      const barDir = vec2(this.axis.x, this.axis.y.negate()).div(this.viewport)
      const best = vec4(0, 0, 0, 0).toVar()
      for (const d of [-260, -120, -40, 40, 120, 260]) {
        const t = vec4(this.histNode.sample(st.add(barDir.mul(d))).level(0))
        If(t.r.clamp(0, 1).mul(t.g).greaterThan(best.r.clamp(0, 1).mul(best.g)), () => best.assign(t))
      }
      const barColour = rampAt(pow(best.g.clamp(0, 1), this.gamma), letterHue)
      const inTrail = select(lift.greaterThan(0), mix(barColour, vec3(1, 1, 1), lift), barColour.mul(float(1).add(lift)))
      const letter = select(
        this.letterMode.greaterThan(3.5), inTrail,
        select(this.letterMode.greaterThan(2.5), mix(solid, ramped, activity),
          select(this.letterMode.greaterThan(1.5), ramped, solid)),
      )
      const showLetters = select(this.letterMode.greaterThan(0.5), m.a, float(0))
      // Letters under the trails, or on top of them.
      const over = mix(mix(ground, letter, showLetters), lit, presence)
      const out = select(this.trailOver.greaterThan(0.5), over, mix(trail, letter, showLetters)).toVar()

      // Letters lit from within: the mask blurred (a mip level) says how near
      // an edge we are. Inner: inside the letter, brightest at its edge;
      // outer: a halo outside it. Only lit letters glow, in their own colour.
      If(this.letterGlow.greaterThan(0.001).and(this.letterMode.greaterThan(0.5)), () => {
        const b: any = maskNode.sample(st).level(3)
        const bc = max(b.a, 1e-3)
        // Inside a letter its own layer; outside, the most lit letter close by (the blurred mask's index
        // would mix neighbouring letters' into another layer's colour).
        const nearHue = float(0).toVar()
        const nearLit = float(-1).toVar()
        for (const [x, y] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
          const t: any = maskNode.sample(st.add(this.texel.mul(vec2(x, y)).mul(6))).level(0)
          If(t.r.greaterThan(nearLit), () => {
            nearLit.assign(t.r)
            nearHue.assign(t.b.div(max(t.a, 1e-3)))
          })
        }
        const colour = rampAt(pow(b.g.div(bc).clamp(0, 1), this.gamma).add(0.15).clamp(0, 1), select(m.a.greaterThan(0.5), letterHue, nearHue))
        const lit = b.r.div(bc).clamp(0, 1)
        const inner = m.a.mul(float(1).sub(b.a).mul(2.5).clamp(0, 1)).mul(activity)
        const outer = b.a.mul(float(1).sub(m.a)).mul(lit).mul(1.4)
        const amount = select(this.letterGlowMode.lessThan(0.5), inner, select(this.letterGlowMode.lessThan(1.5), outer, inner.add(outer)))
        out.addAssign(colour.mul(cut(amount)).mul(this.letterGlow))
      })

      const n = fract(fract(dot(screenCoordinate.xy.add(time.mul(61.3)), vec2(0.06711056, 0.00583715))).mul(52.9829189))
      return vec4(out.add(n.sub(0.5).mul(this.grain)), 1)
    })()
    this.compQuad = new THREE.QuadMesh(compMat)

    // --- Bloom: the finished frame plus its own blurred highlights -----------
    this.compNode = texture(this.comp.texture)
    const bloomMat = new THREE.MeshBasicNodeMaterial()
    bloomMat.colorNode = Fn(() => {
      const st = uv().toVar()
      const base = this.compNode.sample(st).rgb.toVar()
      const sum = vec3(0, 0, 0).toVar()
      const light = this.lightPage.greaterThan(0.5)
      // Wider levels count a little less: a soft core with a long falloff.
      for (const [level, w] of [[2, 0.35], [3, 0.3], [4, 0.22], [5, 0.13]] as const) {
        const c: any = this.compNode.sample(st).level(level).rgb
        // Only the part brighter than the threshold blooms, in its own colour. On a light page nothing is
        // brighter than the page, so it is how much colour a part takes from the white that spreads (only
        // coloured parts: grey letters cast none), as a soft tinted haze round the trails.
        const away = select(light, vec3(this.background as any).sub(c), c.sub(vec3(this.background as any)))
        const excess = max(away, vec3(0, 0, 0))
        const lum = dot(excess, vec3(0.2126, 0.7152, 0.0722))
        const chroma = max(max(excess.x, excess.y), excess.z).sub(min(min(excess.x, excess.y), excess.z))
        const coloured = select(light, smoothstep(0.05, 0.3, chroma), float(1))
        sum.addAssign(excess.mul(max(lum.sub(max(this.glowThreshold, this.threshold)), 0).div(max(lum, 1e-3))).mul(coloured).mul(w))
      }
      // Dark page: light added. Light page: the page tinted by the colour round about (a multiply, kept gentle
      // so it never goes muddy or dark).
      const tint = max(vec3(1, 1, 1).sub(sum.mul(this.glow).mul(0.6)), vec3(0.55, 0.55, 0.55))
      return vec4(select(light, base.mul(tint), base.add(sum.mul(this.glow).mul(1.6))) as any, 1)
    })()
    this.bloomQuad = new THREE.QuadMesh(bloomMat)

  }

  setAxis(axis: StretchAxis) {
    this.radial.value = axis === 'radial' ? 1 : 0
    this.axis.value.set(axis === 'vertical' ? 0 : 1, axis === 'vertical' ? 1 : 0)
  }

  setRamp(hexes: readonly string[]) {
    hexes.forEach((h, i) => this.ramp[i]?.value.set(h))
  }

  /** Ramps letters can pick from by hue (4 stops each); up to MULTI_RAMPS. */
  /** Images dropped on the stage this frame (engine/dropFx.ts): `colour` = the trails take their colours. */
  setDrops(active: readonly { x: number; y: number; ran: number; reach: number; amount: number; front: number; colours: string[] }[], colour: boolean, warp: number) {
    const c = new THREE.Color()
    for (let i = 0; i < DROPS; i++) {
      const d = active[i]
      if (!d) {
        this.dropInfo[i].z = 0
        continue
      }
      this.dropPos[i].set(d.x, d.y, d.ran, d.amount)
      this.dropInfo[i].set(d.reach, d.front, 1, 0)
      for (let k = 0; k < 4; k++) {
        c.set(d.colours[Math.min(d.colours.length - 1, Math.round((k / 3) * (d.colours.length - 1)))] ?? '#888888')
        this.dropStops[i * 4 + k].set(c.r, c.g, c.b, 1)
      }
    }
    this.dropColour.value = colour && active.length ? 1 : 0
    this.dropWarp.value = active.length ? warp : 0
  }

  /** The instruments' ramps (LAYERS order), for letters given to them on the stage. */
  setPartRamps(ramps: readonly (readonly string[])[]) {
    const c = new THREE.Color()
    for (let r = 0; r < PART_RAMPS; r++) {
      for (let k = 0; k < 4; k++) {
        c.set(ramps[r]?.[k] ?? '#ffffff')
        this.partStops[r * 4 + k].set(c.r, c.g, c.b, 1)
      }
    }
  }

  setMultiRamps(ramps: readonly (readonly string[])[]) {
    const c = new THREE.Color()
    for (let r = 0; r < MULTI_RAMPS; r++) {
      const ramp = ramps[r % ramps.length]
      for (let k = 0; k < 4; k++) {
        c.set(ramp[k])
        this.multiStops[r * 4 + k].set(c.r, c.g, c.b, 1)
      }
    }
  }

  private melodySlot: number | null = null

  /**
   * Write each layer's melody now (0..1 low to high, -1 silent; up to 8) into
   * the steps the trails have moved through since last time, for artifacts
   * that follow the music. `stepPx` must match the shader's artifact step.
   */
  writeMelody(values: readonly number[], fills: readonly number[], stepPx: number) {
    const now = Math.floor(-this.travel.value / Math.max(1, stepPx))
    const from = this.melodySlot === null || Math.abs(now - this.melodySlot) > MELODY_STEPS ? now : this.melodySlot
    const dir = now >= from ? 1 : -1
    for (let k = from; ; k += dir) {
      const slot = ((k % MELODY_STEPS) + MELODY_STEPS) % MELODY_STEPS
      this.melody[slot * 2].set(values[0] ?? -1, values[1] ?? -1, values[2] ?? -1, values[3] ?? -1)
      this.melody[slot * 2 + 1].set(values[4] ?? -1, values[5] ?? -1, values[6] ?? -1, values[7] ?? -1)
      this.noteFill[slot * 2].set(fills[0] ?? 0.7, fills[1] ?? 0.7, fills[2] ?? 0.7, fills[3] ?? 0.7)
      this.noteFill[slot * 2 + 1].set(fills[4] ?? 0.7, fills[5] ?? 0.7, fills[6] ?? 0.7, fills[7] ?? 0.7)
      if (k === now) break
    }
    this.melodySlot = now
  }

  /**
   * Back to the plain effect: everything the Orchestra layers on top (depth, notes, specks, sections,
   * grid, glow, threshold, typing...) off, so another mode sharing this effect starts clean.
   */
  neutral() {
    for (const u of [this.zoom, this.twist, this.pump, this.swirl, this.roll, this.depthFade, this.layering, this.threshold,
      this.roundness, this.fluid, this.vibrance, this.glow, this.split, this.letterGlow, this.trailOver, this.gloss,
      this.artifacts, this.colourBy, this.grid, this.rowSeparate, this.cursorLevel, this.fluidStep, this.typeStep]) u.value = 0
    this.glowThreshold.value = 0.04
    this.vp.value.set(0, 0)
    this.laneVpOn.value = 0
    this.typeRow.value.w = 0
    this.scroll.value.set(0, 0)
    for (const v of this.lineFlow) v.w = 0
  }

  /** Start from an empty history (e.g. after switching look or text). */
  reset() {
    this.needsClear = true
    this.bakeDone = 0
  }

  /**
   * Lanes mode from a timeline: `data` is columns x MAX_LANES RGBA (row per
   * lane; R = activity, G = emission), baked from the first column, one pass
   * each, then held (`flow`: over the picture already there). Pass null to run live again.
   */
  setTimeline(data: Float32Array | null, columns = 1, flow = false) {
    // Flow: keep the picture; the new one bakes in from the letters, pushing the old out (an unfinished bake
    // carries on with the new data, a finished one starts over), instead of clearing and starting from empty.
    const same = this.bakeTotal === (data ? columns : 0)
    this.bakeTotal = data ? columns : 0
    if (!flow || !data) this.reset()
    else if (!same || this.bakeDone >= this.bakeTotal) this.bakeDone = 0
    if (!data) return
    if (this.timeline.image.width !== columns) {
      this.timeline.dispose()
      this.timeline = laneTexture(columns, MAX_LANES)
      this.timelineNode.value = this.timeline
    }
    ;(this.timeline.image.data as Float32Array).set(data)
    this.timeline.needsUpdate = true
  }

  /** Lanes, both ways: each lane's centre x (null: one centre, `vp`, for all), the lanes' top (y up) and pitch, px. */
  setLaneCentres(xs: readonly number[] | null, top = 0, pitch = 1) {
    this.laneVpOn.value = xs ? 1 : 0
    if (!xs) return
    this.laneTop.value = top
    this.lanePitch.value = Math.max(1, pitch)
    for (let l = 0; l < MAX_LANES; l++) this.laneVp[l].x = xs[Math.min(l, xs.length - 1)] ?? 0
  }

  /** Lanes mode: each letter's live activity and emission (2 per lane). */
  setLive(values: Float32Array) {
    const d = this.live.image.data as Float32Array
    for (let l = 0; l < MAX_LANES; l++) {
      d[l * 4] = values[l * 2] ?? 0
      d[l * 4 + 1] = values[l * 2 + 1] ?? 0
    }
    this.live.needsUpdate = true
  }

  /** Lanes mode: 0..1 of the timeline baked so far. */
  get baked() {
    return this.bakeTotal ? this.bakeDone / this.bakeTotal : 1
  }

  render(
    renderer: THREE.WebGPURenderer,
    scene: THREE.Scene,
    camera: THREE.Camera,
    glyphs: GlyphLayer,
    viewport: { width: number; height: number },
  ) {
    renderer.getDrawingBufferSize(this.size)
    if (this.mask.width !== this.size.x || this.mask.height !== this.size.y) {
      this.mask.setSize(this.size.x, this.size.y)
      this.history[0].setSize(this.size.x, this.size.y)
      this.history[1].setSize(this.size.x, this.size.y)
      this.under[0].setSize(this.size.x, this.size.y)
      this.under[1].setSize(this.size.x, this.size.y)
      this.bakeDone = 0
      this.clipRT.setSize(this.size.x, this.size.y)
      this.comp.setSize(this.size.x, this.size.y)
      this.needsClear = true
    }
    this.viewport.value.set(viewport.width, viewport.height)
    this.lanes.value = this.lanesOn && this.bakeTotal ? 1 : 0
    this.travel.value += this.step.value
    this.texel.value.set(1 / this.size.x, 1 / this.size.y)
    const bg = this.background.value
    this.lightPage.value = 0.2126 * bg.r + 0.7152 * bg.g + 0.0722 * bg.b > 0.6 ? 1 : 0

    const clear = renderer.getClearColor(new THREE.Color())
    const clearAlpha = renderer.getClearAlpha()
    renderer.setClearColor(0x000000, 0)

    if (this.needsClear) {
      for (const t of [...this.history, ...this.under]) {
        renderer.setRenderTarget(t)
        renderer.clear()
      }
      this.needsClear = false
    }

    // 1. Mask: glyph mesh alone (and the clip rects alone, when set).
    const renderOnly = (mesh: THREE.Object3D, target: THREE.RenderTarget) => {
      const hidden = scene.children.filter((o) => o !== mesh && o.visible)
      hidden.forEach((o) => (o.visible = false))
      const wasVisible = mesh.visible
      mesh.visible = true
      renderer.setRenderTarget(target)
      renderer.render(scene, camera)
      mesh.visible = wasVisible
      hidden.forEach((o) => (o.visible = true))
    }
    renderOnly(glyphs.mesh, this.mask)
    this.clipOn.value = this.clip ? 1 : 0
    if (this.clip) renderOnly(this.clip.mesh, this.clipRT)

    // 2. History: read previous, write next (lanes: the next few columns, then hold).
    const pass = () => {
      const read = 1 - this.write
      this.prevNode.value = this.history[read].texture
      this.prevUnderNode.value = this.under[read].texture
      renderer.setRenderTarget(this.history[this.write])
      this.historyQuad.render(renderer)
      renderer.setRenderTarget(this.under[this.write])
      this.underQuad.render(renderer)
      this.write = read
    }
    if (this.lanes.value) {
      for (let k = 0; k < this.bakePerFrame && this.bakeDone < this.bakeTotal; k++, this.bakeDone++) {
        this.simCol.value = (this.bakeDone + 0.5) / this.bakeTotal
        pass()
      }
    } else pass()
    const shown = 1 - this.write

    // 3. Composite, then (optionally) bloom, to the screen.
    this.histNode.value = this.history[shown].texture
    this.underNode.value = this.under[shown].texture
    const bloom = this.glow.value > 0.001
    renderer.setRenderTarget(bloom ? this.comp : null)
    this.compQuad.render(renderer)
    if (bloom) {
      this.compNode.value = this.comp.texture
      renderer.setRenderTarget(null)
      this.bloomQuad.render(renderer)
    }
    renderer.setClearColor(clear, clearAlpha)
  }
}

function laneTexture(width: number, height: number) {
  const t = new THREE.DataTexture(new Float32Array(width * height * 4), width, height, THREE.RGBAFormat, THREE.FloatType)
  t.magFilter = THREE.NearestFilter
  t.minFilter = THREE.NearestFilter
  t.needsUpdate = true
  return t
}
