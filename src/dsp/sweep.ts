/**
 * Exponential sine sweep and its matched inverse filter (Farina, AES 108, 2000).
 *
 * Why a sweep and not a clap or a noise burst: convolving the recording with
 * the inverse filter collapses the sweep back to a single impulse, and the
 * harmonic distortion products of a cheap laptop speaker collapse *earlier*
 * in time than the linear impulse. They land before t=0 and get discarded,
 * so a laptop speaker measures a room almost as honestly as a good one.
 */

export interface SweepSpec {
  /** Start frequency, Hz. */
  f1: number
  /** End frequency, Hz. */
  f2: number
  /** Sweep duration, seconds. */
  duration: number
  sampleRate: number
}

export interface Sweep {
  spec: SweepSpec
  /** The signal to play. */
  signal: Float32Array
  /** Time-reversed, energy-compensated copy. Convolve the recording with this. */
  inverse: Float32Array
}

/** Raised-cosine fade, in samples, applied to both ends of the sweep. */
function applyFades(x: Float32Array, sampleRate: number, f1: number) {
  // Long enough at the bottom end to avoid a click at the lowest frequency,
  // short at the top so we do not eat sweep time.
  const fadeIn = Math.min(Math.round((sampleRate / f1) * 4), Math.floor(x.length / 8))
  const fadeOut = Math.min(Math.round(sampleRate * 0.02), Math.floor(x.length / 8))
  for (let i = 0; i < fadeIn; i++) {
    x[i] *= 0.5 - 0.5 * Math.cos((Math.PI * i) / fadeIn)
  }
  for (let i = 0; i < fadeOut; i++) {
    x[x.length - 1 - i] *= 0.5 - 0.5 * Math.cos((Math.PI * i) / fadeOut)
  }
}

export function makeSweep(spec: SweepSpec): Sweep {
  const { f1, f2, duration, sampleRate } = spec
  const N = Math.round(duration * sampleRate)
  const R = Math.log(f2 / f1)
  const K = (2 * Math.PI * f1 * duration) / R

  const signal = new Float32Array(N)
  for (let n = 0; n < N; n++) {
    const t = n / sampleRate
    signal[n] = Math.sin(K * (Math.exp((t * R) / duration) - 1))
  }
  applyFades(signal, sampleRate, f1)

  // The sweep's magnitude spectrum falls at 3 dB/octave (it spends less time
  // in each successive octave). The inverse filter is the reversed sweep with
  // a 6 dB/octave decaying envelope, which flattens the product to unity.
  //
  // At reversed index n the instantaneous frequency is f2 * exp(-n*R/N), so a
  // -6 dB/octave envelope is exactly exp(-n*R/N) in linear gain.
  const inverse = new Float32Array(N)
  for (let n = 0; n < N; n++) {
    inverse[n] = signal[N - 1 - n] * Math.exp((-n * R) / N)
  }

  // Normalise so the deconvolved impulse lands near unity regardless of length.
  let energy = 0
  for (let n = 0; n < N; n++) energy += inverse[n] * inverse[n]
  const scale = 1 / Math.sqrt(energy || 1)
  for (let n = 0; n < N; n++) inverse[n] *= scale

  return { spec, signal, inverse }
}

/** Instantaneous frequency of the sweep at time t, for drawing the sweep. */
export function sweepFrequencyAt(spec: SweepSpec, t: number): number {
  return spec.f1 * Math.exp((t / spec.duration) * Math.log(spec.f2 / spec.f1))
}
