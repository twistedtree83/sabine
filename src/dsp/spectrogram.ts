/**
 * Short-time Fourier transform onto a log-frequency grid.
 *
 * Drawn from the same samples that go to the speaker, an exponential sweep
 * is a straight diagonal line here, because a log frequency axis is the axis
 * on which "equal time in every octave" is a constant slope. That is the
 * whole argument for the signal, made visible.
 */

import { fft, nextPow2 } from './fft'

export interface Spectrogram {
  /** Column-major dB values, normalised so the loudest cell is 0 dB. */
  data: Float32Array
  columns: number
  rows: number
  fMin: number
  fMax: number
  seconds: number
  /** Dynamic range below the peak that the grid spans. */
  floorDb: number
}

export interface SpectrogramOptions {
  columns?: number
  rows?: number
  fMin?: number
  fMax?: number
  fftSize?: number
  floorDb?: number
}

export function spectrogram(
  signal: Float32Array,
  sampleRate: number,
  opts: SpectrogramOptions = {},
): Spectrogram {
  const columns = opts.columns ?? 600
  const rows = opts.rows ?? 220
  const fMin = opts.fMin ?? 40
  const fMax = Math.min(opts.fMax ?? 20000, sampleRate / 2)
  const floorDb = opts.floorDb ?? 72
  const size = nextPow2(opts.fftSize ?? 2048)
  const half = size >> 1

  const window = new Float64Array(size)
  for (let i = 0; i < size; i++) window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / size)

  const hop = Math.max(1, Math.floor((signal.length - size) / Math.max(1, columns - 1)))
  const data = new Float32Array(columns * rows)

  // Which FFT bins fall in each log-spaced row.
  const rowFrom = new Int32Array(rows)
  const rowTo = new Int32Array(rows)
  const logMin = Math.log(fMin)
  const span = Math.log(fMax) - logMin
  for (let r = 0; r < rows; r++) {
    const lo = Math.exp(logMin + (span * r) / rows)
    const hi = Math.exp(logMin + (span * (r + 1)) / rows)
    rowFrom[r] = Math.max(1, Math.floor((lo / sampleRate) * size))
    rowTo[r] = Math.max(rowFrom[r] + 1, Math.min(half, Math.ceil((hi / sampleRate) * size)))
  }

  const re = new Float64Array(size)
  const im = new Float64Array(size)
  let peak = 1e-12

  for (let c = 0; c < columns; c++) {
    const offset = c * hop
    re.fill(0)
    im.fill(0)
    for (let i = 0; i < size; i++) {
      const s = signal[offset + i]
      re[i] = s === undefined ? 0 : s * window[i]
    }
    fft(re, im)

    for (let r = 0; r < rows; r++) {
      let best = 0
      for (let k = rowFrom[r]; k < rowTo[r]; k++) {
        const m = re[k] * re[k] + im[k] * im[k]
        if (m > best) best = m
      }
      if (best > peak) peak = best
      data[c * rows + r] = best
    }
  }

  for (let i = 0; i < data.length; i++) {
    data[i] = 10 * Math.log10(Math.max(data[i], 1e-20) / peak)
  }

  return { data, columns, rows, fMin, fMax, seconds: signal.length / sampleRate, floorDb }
}
