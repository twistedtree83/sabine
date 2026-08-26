import type { DecayFit, Reflection } from './acoustics'

export interface BandResult {
  centre: number
  rt60: number
  label: 'T30' | 'T20' | 'EDT' | null
  r2: number
  valid: boolean
  /** Signal-to-noise available for this band's decay, dB. */
  headroomDb: number
}

export interface AnalysisResult {
  sampleRate: number
  /** Impulse response from the direct sound onward, decimated for drawing. */
  irPreview: Float32Array
  irPreviewSeconds: number
  /** Schroeder curve in dB, decimated for drawing. */
  decayPreview: Float32Array
  decayPreviewSeconds: number
  /** The line the T20/T30 fit drew through the decay, for the overlay. */
  fitLine: { fromDb: number; toDb: number; fromSec: number; toSec: number } | null
  broadband: {
    rt60: number
    label: 'T30' | 'T20' | 'EDT' | null
    r2: number
    valid: boolean
    edt: DecayFit
    t20: DecayFit
    t30: DecayFit
  }
  bands: BandResult[]
  c50: number
  c80: number
  d50: number
  reflections: Reflection[]
  /** Peak of the direct sound over the pre-arrival noise, dB. */
  snrDb: number
  /** True when the direct sound was too weak to trust anything downstream. */
  tooQuiet: boolean
}

export interface AnalysisRequest {
  recording: Float32Array
  inverse: Float32Array
  sampleRate: number
}
