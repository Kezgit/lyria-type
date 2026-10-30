// A quick description when a section's title (or a card's pill) is hovered:
// one line on what that part of the panel does. Only the section titles, not
// every setting.

const TIPS: Record<string, string> = {
  // Cards
  Text: 'What the words say, their font, size and colour, and how they sit on the page.',
  Scene: 'Save or load the whole look as a file, start again, and what dropped images do.',
  Mode: 'Pick a visual style and fine-tune it. Each mode reacts to the music its own way.',
  Presets: 'Ready-made looks from every mode, plus the ones you save. Click one to use it.',
  Export: 'Save the frame as a picture, or a video with the music.',
  Audio: 'The music driving the picture: the demo, your own song, stems or the microphone.',

  // Text card
  Type: 'Font, size, letter spacing and where lines wrap.',
  'Add fonts': 'Use a font file, a Google Font, or one installed on this computer.',
  Layout: 'How the picture is arranged on the page.',

  // Shared across modes
  Timing: 'How long notes stay lit, and whether the picture scrolls.',
  Look: 'The overall style: shapes, colours and how strong the effect is.',
  Colour: 'The colours the marks are painted in.',
  Colours: 'Where the colours come from, and how they drift.',
  Ink: 'The colour and texture of the marks, like ink on paper.',
  Recolour: 'Repaint every mark with a palette, instead of the sub-mode’s own colours.',
  'Gradient map': 'Paint everything through one gradient you can edit, move and mask on the stage.',
  Mask: 'Paint areas on the stage to hide the marks (or just the gradient) there.',
  Window: 'Which part of the song is shown: where it starts and how many bars.',
  Grid: 'How many rows and columns of marks, and the space around them.',
  Page: 'How the song is laid out on the page: columns, rows and margins.',
  Weights: 'How loudness turns into the size and darkness of marks.',
  Lines: 'The thickness and style of the drawn lines.',
  Fields: 'Soft areas of colour that grow where the music is busy.',
  Haze: 'A soft glow blurred from the marks.',
  'Dot haze': 'A soft glow blurred from the dots.',
  'Dot grid': 'Redraw the picture as a grid of dots.',
  'Dot grid haze': 'The dot grid’s own glow, separate from the main haze.',
  Dots: 'The size and softness of each dot, and the quiet ones.',
  'Dot shape': 'Round, square or stretched marks, and how crisp their edges are.',
  'Mark shape': 'Round, square or stretched marks, and how crisp their edges are.',
  Motion: 'How the picture moves with the music.',
  Stems: 'Turn each part of the music (vocals, instruments, drums, bass) up, down or off.',
  Characters: 'Swap the marks for letters or symbols, or type your own.',
  Letters: 'How the typed letters show: hidden, coloured, lifted or moving.',
  Keyframes: 'Capture the settings at moments, then play them as a smooth animation.',
  Lanes: 'The rows the letters travel in, and how they’re staggered.',
  Playback: 'The playhead light that runs across as the song plays.',
  Rebuild: 'How the picture rebuilds when settings change.',
  Texture: 'The characters that make up the page’s texture.',
  Blocks: 'Solid blocks behind groups of notes.',
  Marks: 'The shape and rhythm of each mark.',
  Playing: 'How marks react as they play.',
  Swell: 'Marks swelling with the beat and the bass.',
  Ripple: 'Colour rippling out from each hit.',
  Field: 'A flowing colour field behind the text.',
  Flow: 'How the colour field flows and spreads.',
  Pulse: 'The beat pulse through the letters.',
  Rhythm: 'Which beats and hits drive the effect.',
  Response: 'How strongly and quickly it reacts to the music.',
  Trigger: 'What in the music sets the effect off.',
  Trails: 'Trails left behind moving letters.',
  Notes: 'How each note shows on the letters.',
  Artifacts: 'Glitches and texture on top.',
  'Colour sections': 'Colours that change with each section of the song.',
  'Letter moves': 'How the letters move when they play.',
  Bleed: 'Colour bleeding out of the letters.',
  Shape: 'The shape of the haze around the letters.',
  Spacing: 'Space between the letters, and how it opens up.',
  Stream: 'The stream of bars between the letters.',
  Bars: 'The bars drawn between the letters.',
  Morph: 'How the letters turn into dots and back.',
  Pattern: 'The pattern the letters are built from, and where it sits.',
  Cycle: 'How long each reveal takes and how often it repeats.',
  Wipe: 'The wipe that reveals the letters: direction and softness.',
  Smoke: 'Smoke drifting off the letters.',
  Gather: 'How the dots gather into the words.',
  Reveal: 'How the letters are revealed through the pattern.',
  'Cursor smoke': 'The faint colour trail off the typing cursor.',
  View: 'Zoom and pan the picture.',
  'Image drop': 'Drop an image on the stage to wash its colours through the picture.',
  MP4: 'Video settings: frame rate, start and length.',
}

export function attachTips(root: HTMLElement) {
  const tip = document.createElement('div')
  tip.className = 'tip'
  tip.hidden = true
  document.body.appendChild(tip)
  let timer = 0
  let over: HTMLElement | null = null

  const textOf = (el: HTMLElement) => (el.dataset.tip ? el.dataset.tip : el.textContent?.replace(/\s*\(\d+\)$/, '').trim() ?? '')
  root.addEventListener('pointerover', (e) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>('.tp-fldv_b, .pill')
    if (el === over) return
    over = el
    clearTimeout(timer)
    tip.hidden = true
    if (!el) return
    const title = el.querySelector<HTMLElement>('.tp-fldv_t, .pill-label') ?? el
    const text = TIPS[textOf(title)]
    if (!text) return
    timer = window.setTimeout(() => {
      tip.textContent = text
      tip.hidden = false
      const r = title.getBoundingClientRect()
      const w = tip.offsetWidth
      // Beside the card, on the stage's side.
      const right = r.left > innerWidth / 2
      const card = el.closest('.card')?.getBoundingClientRect() ?? r
      const x = right ? card.left - w - 10 : card.right + 10
      tip.style.left = `${Math.max(8, Math.min(innerWidth - w - 8, x))}px`
      tip.style.top = `${Math.max(8, r.top + r.height / 2 - tip.offsetHeight / 2)}px`
    }, 140)
  })
  // (The panel itself lets clicks through to the stage, so leaving is watched title by title.)
  root.addEventListener('pointerout', (e) => {
    const to = (e.relatedTarget as HTMLElement | null)?.closest('.tp-fldv_b, .pill')
    if (to === over) return
    over = null
    clearTimeout(timer)
    tip.hidden = true
  })
}
