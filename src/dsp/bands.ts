/**
 * Octave-band filtering of the impulse response.
 *
 * A cascade of identical second-order sections gets the -3 dB points right
 * and then rolls off far too slowly: only about 10 dB down at the centre of
 * the neighbouring band, where IEC 61260 class 1 asks for roughly 61 dB. A
 * room that rings longer at the bottom then leaks into every band above it,
 * and every band reads high.
 *
 * So the filtering happens in the frequency domain instead, against the
 * Butterworth bandpass magnitude response
 *
 *     |H(f)|^2 = 1 / (1 + ((f/fc - fc/f) / (fh/fc - fc/fh))^(2N))
 *
 * which is exactly the shape the standard describes, at whatever order we
 * ask for, with no pole placement and no phase distortion at all. The cost
 * is a symmetric impulse response: a steep filter rings for about 1 over its
 * bandwidth on each side, which is 11 ms in the 125 Hz band and well under a
 * millisecond at 4 kHz. Both are short against any decay worth measuring.
 */

import { fft, ifft, nextPow2 } from './fft'

export const OCTAVE_CENTRES = [125, 250, 500, 1000, 2000, 4000] as const
export type OctaveCentre = (typeof OCTAVE_CENTRES)[number]

/** Half the equivalent filter order. 8 puts the neighbouring band 52 dB down. */
const N = 8

/** Butterworth bandpass magnitude at `f`, for one octave centred on `fc`. */
export function bandMagnitude(f: number, fc: number): number {
  if (f <= 0) return 0
  // One octave: edges at fc/sqrt(2) and fc*sqrt(2).
  const width = Math.SQRT2 - 1 / Math.SQRT2
  const detune = (f / fc - fc / f) / width
  return 1 / Math.sqrt(1 + Math.pow(detune, 2 * N))
}

export function octaveBand(ir: Float32Array, centre: number, sampleRate: number): Float32Array {
  const nyquist = sampleRate / 2
  if (centre * Math.SQRT2 >= nyquist) return new Float32Array(ir.length)

  // Headroom for the filter's symmetric ringing at both ends.
  const size = nextPow2(ir.length + Math.round(sampleRate * 0.05))
  const re = new Float64Array(size)
  const im = new Float64Array(size)
  re.set(ir)

  fft(re, im)

  const half = size >> 1
  for (let k = 0; k <= half; k++) {
    const f = (k * sampleRate) / size
    const g = bandMagnitude(f, centre)
    re[k] *= g
    im[k] *= g
    // Mirror onto the negative frequencies so the result stays real.
    if (k > 0 && k < half) {
      const j = size - k
      re[j] *= g
      im[j] *= g
    }
  }

  ifft(re, im)

  const out = new Float32Array(ir.length)
  for (let i = 0; i < ir.length; i++) out[i] = re[i]
  return out
}
