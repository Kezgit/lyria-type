// What every mode gets from the audio each frame. All values are normalized to
// roughly 0..1 with auto-gain, so modes don't care how loud the source is.

import { silentLayers, type LayerFrame } from './analysis/listener'

export const BAND_COUNT = 8

/** Instrument parts, high to low like a score. Generated music reports its own; others are guessed. */
export const VOICES = ['lead', 'pad', 'hat', 'snare', 'bass', 'kick'] as const
export type Voice = (typeof VOICES)[number]

/**
 * Stems: the parts a generated track comes as. Sources that have them (the
 * demo, loaded stem files) analyse each one separately; for a plain mix they
 * are estimated from the spectrum.
 */
export const STEMS = ['vocals', 'drums', 'bass', 'instruments'] as const
export type Stem = (typeof STEMS)[number]

/** The stem each voice belongs to. */
export const STEM_OF: Record<Voice, Stem> = {
  lead: 'vocals', pad: 'instruments', hat: 'drums', snare: 'drums', bass: 'bass', kick: 'drums',
}

export interface StemFeatures {
  /** Fast loudness, auto-gained 0..1. */
  rms: number
  /** Slow, smoothed loudness. */
  level: number
  /** True on the frame this stem has an onset. */
  onset: boolean
  /** 0..1 strength of its last onset. */
  onsetStrength: number
  /** MIDI pitch of its main tone (fractional; holds its last value when unclear). */
  pitch: number
  /** 0..1 how clearly pitched it is right now (0 for noise or silence). */
  clarity: number
  /** 0..1 spectral centroid on a log scale: dark to bright. */
  brightness: number
}

/** One note that started sounding this frame. */
export interface NoteEvent {
  voice: Voice
  /** MIDI note number (drums: a nominal pitch). */
  pitch: number
  /** 0..1 */
  velocity: number
  /** Length in sixteenth steps. */
  length: number
  /** Sixteenth step it starts on (beat clock position, whole steps). */
  step: number
}

/** Every note of the music, known before it plays (generated music, analysed files). */
export interface KnownScore {
  /** Sorted by step. */
  notes: NoteEvent[]
  /** Steps after which the notes repeat (a loop), or null for a whole track. */
  loop: number | null
  /** What the whole-track analysis found beyond the notes; arrives later than the notes (null until then). */
  analysis?: TrackAnalysis | null
}

/** One part (a stem) over the whole track, on the step grid. */
export interface PartAnalysis {
  /** Loudness 0..1 (normalised to this part's own loud level), `resolution` frames per sixteenth, from step 0. */
  envelope: Float32Array
  /** 0..1: how much of the track this part carries (presence x loudness), relative to the most prominent part. */
  prominence: number
  /** 0..1 average spectral brightness while it plays. */
  brightness: number
  /** Lowest and highest MIDI pitch of its notes, or null for unpitched parts. */
  range: [number, number] | null
  /** Runs of steps where it plays: [start, end) pairs, in steps. */
  active: [number, number][]
}

/**
 * Everything a generator needs beyond the notes, computed once from the audio
 * of the whole track (or loop). All positions are in sixteenth steps on the
 * same grid as the notes.
 */
export interface TrackAnalysis {
  /** Envelope frames per sixteenth step. */
  resolution: number
  /** Steps covered (whole bars). */
  length: number
  /** Real stems when the source has them; estimated from the mix otherwise (`stemmed` says which). */
  stems: Record<Stem, PartAnalysis>
  stemmed: boolean
  /** Section starts, in steps (bar-aligned, ascending, first is 0): where density, loudness or the set of playing parts changes. */
  sections: number[]
  /** Per bar: the index of the earliest bar it repeats (its own index if it's new). */
  repeats: Int32Array
}

/** Where we are in the music, in sixteenth-note steps. */
export interface BeatClock {
  /** True when the source reports its own tempo; false = estimated from onsets. */
  exact: boolean
  bpm: number
  /** Steps since the clock started, fractional. Holds still while paused. */
  position: number
  /** Step boundaries crossed this frame (usually 0 or 1). */
  ticks: number
  /** 0..1 through the current bar of 16 steps. */
  bar: number
}

export interface AudioFeatures {
  /** Fast loudness. */
  rms: number
  /** Slow, smoothed loudness — good for "breathing" motion. */
  level: number
  /** Log-spaced bands, low -> high, with attack/release smoothing. */
  bands: Float32Array
  sub: number
  low: number
  mid: number
  high: number
  /** Positive spectral change this frame. */
  flux: number
  /** True on the frame an onset (transient) is detected. */
  onset: boolean
  /** 0..1 strength of the last onset. */
  onsetStrength: number
  /** Seconds since the last onset. */
  sinceOnset: number
  /** Raw normalized spectrum (linear magnitude, 0..1). */
  spectrum: Float32Array
  /** Notes that started this frame: exact from generated music, guessed from onsets otherwise. */
  notes: NoteEvent[]
  beat: BeatClock
  /** The whole score when the source knows it ahead; null for live input. */
  score: KnownScore | null
  /** Per-stem features. */
  stems: Record<Stem, StemFeatures>
  /** True when the stems are real (separate audio); false = estimated from the mix. */
  stemmed: boolean
  /** The mix heard as layers (kick, snare, hats, bass, lead, pad, fx), live for any source. */
  layers: LayerFrame
}

export function silentStem(): StemFeatures {
  return { rms: 0, level: 0, onset: false, onsetStrength: 0, pitch: 60, clarity: 0, brightness: 0 }
}

export function silentFeatures(): AudioFeatures {
  return {
    rms: 0, level: 0,
    bands: new Float32Array(BAND_COUNT),
    sub: 0, low: 0, mid: 0, high: 0,
    flux: 0, onset: false, onsetStrength: 0, sinceOnset: 999,
    spectrum: new Float32Array(1024),
    notes: [],
    beat: { exact: false, bpm: 120, position: 0, ticks: 0, bar: 0 },
    score: null,
    stems: Object.fromEntries(STEMS.map((s) => [s, silentStem()])) as Record<Stem, StemFeatures>,
    stemmed: false,
    layers: silentLayers(),
  }
}
