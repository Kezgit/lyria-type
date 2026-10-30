# Lyria Type

GPU motion-graphics tool: typed text reacting to music. three.js `WebGPURenderer` + TSL, Vite, TypeScript.

```
npm install
npm run dev
```

## Pipeline

```
text ─► shaping ─► layout ─► mode ─► layers ─► GPU
                              ▲
audio source ─► analyser ─► AudioFeatures
```

- **Layouts** only decide each glyph's resting `Placement` (x, y, rotation, scale).
- **Modes** read the placements + audio features each frame and write the render layers.
  Any layout works with any mode.

## Where things live

| Path | What |
| --- | --- |
| `src/app/state.ts` | All user-editable state + tiny pub/sub |
| `src/app/params.ts` | Param schema type; panel controls are generated from it |
| `src/engine/engine.ts` | Renderer, pixel-space ortho camera, per-frame pipeline |
| `src/engine/glyphLayer.ts` | Instanced SDF text quads (TSL material) |
| `src/engine/barLayer.ts` | Instanced gradient rects (also a clip for StretchFx) |
| `src/engine/blobLayer.ts` | Instanced soft colour shapes (TSL material) |
| `src/text/fonts/registry.ts` | Bundled, dropped, Google and installed fonts |
| `src/text/atlas/sdfAtlas.ts` | Runtime SDF glyph atlas (tiny-sdf), kerning |
| `src/text/shaping.ts` | String → positioned glyph runs |
| `src/layout/*` | `block`, `circle`, `grid` |
| `src/audio/sources/*` | `demo` (synth loop, played as four stems with a sung line), `file`, `stems` (several files played together, one per stem), `mic` |
| `src/audio/analysis/analyser.ts` | RMS, level, 8 bands, flux, onsets (auto-gained) |
| `src/audio/analysis/rhythm.ts` | Beat clock (16th steps) and note events: exact from the demo's score, estimated from onsets for mic |
| `src/audio/analysis/stem.ts` | Live per-stem features (level, onsets, pitch, brightness) for sources with stems; estimated from the mix otherwise |
| `src/audio/analysis/track.ts` | Whole-track analysis per stem: loudness envelope on the step grid, prominence, brightness, range, active runs; sections and repeated bars |
| `src/audio/analysis/stemNotes.ts` | Notes from one isolated stem (drums split by band; pitch and chords for vocals / bass / instruments) |
| `src/audio/analysis/offline.ts` | Whole-file analysis on load (tempo, bar phase, notes per voice), so files report a score ahead like the demo |
| `src/modes/*` | `haze` (text dissolving into blurred colour), `field` (hits feeding a moving colour field), `pulse` (hits swelling outward and merging in a field), `stretch` (slit-scan colour trails), `gap` (hit letters push their neighbours apart; the gap fills with a contained Stretch trail or a gradient bar), `sequencer` (a static picture generated from the whole analysed track; sub-modes Barcode (lines / gradient fields, rows / radial), Dots (a dot matrix, or soft blobs), Ledger (glyph texture), each with a song window, and SQ (paged blue marks)) |
| `src/ui/panel.ts` | Text box + Tweakpane |

## Adding a mode

1. Create `src/modes/<name>/index.ts` exporting a `ModeDefinition` (`id`, `label`, `params`, `create()`).
2. Register it in `src/modes/index.ts`.

`update(frame)` gets `audio`, `text`, `base` placements, your `params` and `layers`
(`back` blobs, `glyphs`, `front` blobs). Use `writeGlyph()` for glyphs and `layer.push()` for blobs.

## Adding a layout

Export a `LayoutDefinition` from `src/layout/<name>.ts` and register it in `src/layout/index.ts`.

Drop font files (`.ttf/.otf/.woff/.woff2`) or audio files anywhere on the page to load them.
