import { convolve } from './fft'
import { octaveBand, OCTAVE_CENTRES } from './bands'
import {
  schroeder, bestFit, clarity, definition, earlyReflections, findDirectSound,
} from './acoustics'
import type { AnalysisRequest, AnalysisResult, BandResult } from './types'

/** Reduce a long array to `points` peak-preserving values for drawing. */
function decimatePeak(x: Float32Array, points: number): Float32Array {
  if (x.length <= points) return x.slice()
  const out = new Float32Array(points)
  const step = x.length / points
  for (let i = 0; i < points; i++) {
    const from = Math.floor(i * step)
    const to = Math.min(x.length, Math.floor((i + 1) * step))
    let peak = 0
    for (let k = from; k < to; k++) {
      const a = Math.abs(x[k])
      if (a > peak) peak = a
    }
    out[i] = peak
  }
  return out
}

/** Reduce a monotone dB curve by sampling, which keeps its shape. */
function decimateSample(x: Float32Array, points: number): Float32Array {
  if (x.length <= points) return x.slice()
  const out = new Float32Array(points)
  const step = (x.length - 1) / (points - 1)
  for (let i = 0; i < points; i++) out[i] = x[Math.round(i * step)]
  return out
}

export function analyse(req: AnalysisRequest): AnalysisResult {
  const { recording, inverse, sampleRate } = req

  // Deconvolution. The sweep collapses to an impulse; the speaker's harmonic
  // distortion collapses to a set of impulses *before* it, which the slice
  // below discards.
  const full = convolve(recording, inverse)

  const direct = findDirectSound(full)

  // Noise measured well before the direct sound, for an honest SNR figure.
  const preEnd = Math.max(0, direct - Math.round(sampleRate * 0.05))
  let preNoise = 0
  if (preEnd > sampleRate * 0.05) {
    for (let i = 0; i < preEnd; i++) preNoise += full[i] * full[i]
    preNoise = Math.sqrt(preNoise / preEnd)
  }
  const peak = Math.abs(full[direct])
  const snrDb = preNoise > 0 ? 20 * Math.log10(peak / preNoise) : Infinity

  // Keep a couple of milliseconds ahead of the peak so the impulse's own
  // leading edge is not clipped off.
  const start = Math.max(0, direct - Math.round(sampleRate * 0.002))

  // The impulse response can only be as long as the silence recorded after the
  // sweep. `full` runs on well past that, but every sample beyond it comes from
  // a filter that only partly overlaps real signal, so it ramps down whatever
  // the room did — highest frequencies first, since those sit at the head of
  // the inverse filter. Lundeby seeds its noise floor from the last tenth of
  // whatever it is handed; pointed at that region it measures the filter
  // running out rather than the room, comes back tens of dB too low, never
  // truncates, and reports the resulting nonsense as a valid fit. A 1.6 s room
  // at 24 dB SNR read 11.45 s this way, labelled T20 with r2 = 0.91.
  //
  // So the window ends where the recording does, and a room that rings longer
  // than the tail is honestly out of range rather than quietly wrong.
  const maxWindow = Math.round(sampleRate * 4)
  const end = Math.max(start + 1, Math.min(recording.length - 1, start + maxWindow))
  const ir = full.slice(start, Math.min(end, full.length))

  const decay = schroeder(ir, sampleRate)
  const best = bestFit(decay)

  const bands: BandResult[] = OCTAVE_CENTRES.map((centre) => {
    const filtered = octaveBand(ir, centre, sampleRate)
    const d = schroeder(filtered, sampleRate)
    const b = bestFit(d)
    return {
      centre,
      rt60: b ? b.fit.rt60 : NaN,
      label: b ? b.label : null,
      r2: b ? b.fit.r2 : 0,
      valid: !!b,
      headroomDb: -d.noiseFloorDb,
    }
  })

  const irSeconds = Math.min(0.35, ir.length / sampleRate)
  const irSlice = ir.slice(0, Math.round(irSeconds * sampleRate))

  const decaySeconds = decay.curve.length / sampleRate
  const fitLine = best
    ? (() => {
        const topDb = best.label === 'EDT' ? 0 : -5
        const bottomDb = best.label === 'T30' ? -35 : best.label === 'T20' ? -25 : -10
        const slope = best.fit.slope
        return {
          fromDb: topDb,
          toDb: bottomDb,
          fromSec: firstCrossing(decay.curve, sampleRate, topDb),
          toSec: firstCrossing(decay.curve, sampleRate, bottomDb),
          slope,
        }
      })()
    : null

  return {
    sampleRate,
    irPreview: decimatePeak(irSlice, 1400),
    irPreviewSeconds: irSeconds,
    decayPreview: decimateSample(decay.curve, 900),
    decayPreviewSeconds: decaySeconds,
    fitLine,
    broadband: {
      rt60: best ? best.fit.rt60 : NaN,
      label: best ? best.label : null,
      r2: best ? best.fit.r2 : 0,
      valid: !!best,
      edt: decay.edt,
      t20: decay.t20,
      t30: decay.t30,
    },
    bands,
    c50: clarity(ir, sampleRate, 50),
    c80: clarity(ir, sampleRate, 80),
    d50: definition(ir, sampleRate),
    reflections: earlyReflections(ir.slice(Math.round(sampleRate * 0.002)), sampleRate),
    snrDb,
    tooQuiet: snrDb < 20,
  }
}

function firstCrossing(curve: Float32Array, sampleRate: number, db: number): number {
  for (let i = 0; i < curve.length; i++) {
    if (curve[i] <= db) return i / sampleRate
  }
  return curve.length / sampleRate
}
