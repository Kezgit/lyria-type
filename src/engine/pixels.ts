import { floor, uniform } from 'three/tsl'

// Rendering at another resolution than the preview (an export) must look the
// same, only with more pixels. Sizes are in CSS px, so they scale already;
// what's tied to device pixels is the antialiased edge width and the per-pixel
// grain / dither hashes. `pixelScale` is the device pixels per preview device
// pixel (1 in the preview): edges keep their width in device px (crisp at any
// size) and grain is hashed on preview-sized cells (the same speckle). The
// view's zoom magnifies the picture (its px, its blurs) but not its edges:
// they stay as wide on screen, so a zoomed-in export stays crisp.

/** Pixel ratio the preview renders at; a higher one is an export. */
export const PREVIEW_PIXEL_RATIO = Math.min(window.devicePixelRatio, 2)

/** Device px per preview device px. */
export const pixelScale = uniform(1)
/** The view's zoom: picture px per CSS px on screen (edges stay as wide on screen as unzoomed). */
export const viewZoom = uniform(1)

/** A screen coordinate on preview-sized cells, for hashes (grain, dither). */
export const previewCell = (screen: any): any => floor(screen.div(pixelScale))

/** A width given in preview device px, as a width in CSS px at this pixel ratio's scale (for antialiasing). */
export const edgePx = (cssAtPreview: number): any => pixelScale.mul(viewZoom).reciprocal().mul(cssAtPreview)
