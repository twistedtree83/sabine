import { hilbertEnvelope } from './fft'

/**
 * Room acoustic parameters from an impulse response, following ISO 3382-1:
 * Schroeder backward integration, Lundeby truncation, T20 / T30 / EDT by
 * least-squares fit, and the early-to-late energy ratios C50 / C80 / D50.
 */

export const SPEED_OF_SOUND = 343 // m/s at 20 degrees C

export interface DecayFit {
  /** Reverberation time extrapolated to a full 60 dB decay, seconds. */
  rt60: number
  /** Slope of the fitted line, dB per second (negative). */
  slope: number
  /** Pearson r^2 of the fit. ISO 3382 wants this above 0.99. */
  r2: number
  /** True when the fit range sits at least 10 dB clear of the noise floor. */
  valid: boolean
}

export interface Decay {
  /** Schroeder curve in dB, one value per sample, 0 dB at t = 0. */
  curve: Float32Array
  sampleRate: number
  /** Sample index where the decay meets the noise floor. */
  crossPoint: number
  /** Noise floor relative to the curve's 0 dB start. */
  noiseFloorDb: number
  edt: DecayFit
  t20: DecayFit
  t30: DecayFit
}

export interface Reflection {
  /** Seconds after the direct sound. */
  time: number
  /** Path length difference, metres: the reflecting surface is half this away. */
  distance: number
  /** Level relative to the direct sound, dB. */
  levelDb: number
}

/** Sum of squares over [from, to). */
function energy(x: Float32Array, from: number, to: number): number {
  let e = 0
  for (let i = from; i < to; i++) e += x[i] * x[i]
  return e
}

/** Index of the largest absolute sample: the arrival of the direct sound. */
export function findDirectSound(ir: Float32Array): number {
  let best = 0
  let peak = 0
  for (let i = 0; i < ir.length; i++) {
    const a = Math.abs(ir[i])
    if (a > peak) { peak = a; best = i }
  }
  return best
}

/**
 * Lundeby's method: find where the decay disappears into the noise, so the
 * Schroeder integral is not dominated by a flat tail of microphone hiss.
 * Without this step every room measures as more reverberant than it is.
 */
function lundebyCrossPoint(ir: Float32Array, sampleRate: number): { crossPoint: number; noise: number } {
  const n = ir.length
  const blockLen = Math.max(1, Math.round(sampleRate * 0.02)) // 20 ms blocks
  const blocks = Math.floor(n / blockLen)
  if (blocks < 8) return { crossPoint: n, noise: 0 }

  const smooth = new Float64Array(blocks)
  for (let b = 0; b < blocks; b++) {
    smooth[b] = energy(ir, b * blockLen, (b + 1) * blockLen) / blockLen
  }
  const peak = Math.max(...smooth)
  if (peak <= 0) return { crossPoint: n, noise: 0 }
  const db = Array.from(smooth, (v) => 10 * Math.log10(Math.max(v, 1e-30) / peak))

  // 1. Noise from the last 10% of the response.
  let noise = mean(db.slice(Math.floor(blocks * 0.9)))
  let cross = blocks - 1

  for (let iter = 0; iter < 5; iter++) {
    // 2. Fit the decay from the peak down to 10 dB above the noise.
    const top = db.findIndex((v) => v <= -5)
    const bottomTarget = noise + 10
    let bottom = top
    while (bottom < blocks - 1 && db[bottom] > bottomTarget) bottom++
    if (top < 0 || bottom - top < 3) break

    const fit = leastSquares(db, top, bottom, blockLen / sampleRate)
    if (fit.slope >= 0) break

    // 3. Where the fitted line meets the noise floor.
    const crossTime = (noise - fit.intercept) / fit.slope
    const nextCross = Math.round((crossTime * sampleRate) / blockLen)
    if (!Number.isFinite(nextCross) || nextCross <= top) break
    cross = Math.min(blocks - 1, nextCross)

    // 4. Re-estimate the noise from everything after the crossing, plus a
    //    margin of 5 dB worth of decay so the estimate is not contaminated.
    const noiseStart = Math.min(blocks - 1, cross + Math.round((-5 / fit.slope * sampleRate) / blockLen))
    if (noiseStart >= blocks - 2) break
    const nextNoise = mean(db.slice(noiseStart))
    if (Math.abs(nextNoise - noise) < 0.1) { noise = nextNoise; break }
    noise = nextNoise
  }

  return { crossPoint: Math.min(n, (cross + 1) * blockLen), noise }
}

function mean(xs: number[]): number {
  if (!xs.length) return 0
  let s = 0
  for (const x of xs) s += x
  return s / xs.length
}

function leastSquares(db: number[], from: number, to: number, dt: number) {
  let sx = 0, sy = 0, sxx = 0, sxy = 0, syy = 0
  const n = to - from
  for (let i = from; i < to; i++) {
    const x = i * dt
    const y = db[i]
    sx += x; sy += y; sxx += x * x; sxy += x * y; syy += y * y
  }
  const denom = n * sxx - sx * sx
  const slope = denom === 0 ? 0 : (n * sxy - sx * sy) / denom
  const intercept = (sy - slope * sx) / n
  const rNum = n * sxy - sx * sy
  const rDen = Math.sqrt((n * sxx - sx * sx) * (n * syy - sy * sy))
  const r = rDen === 0 ? 0 : rNum / rDen
  return { slope, intercept, r2: r * r }
}

function fitRange(curve: Float32Array, sampleRate: number, topDb: number, bottomDb: number, noiseFloorDb: number): DecayFit {
  const dt = 1 / sampleRate
  let from = 0
  while (from < curve.length && curve[from] > topDb) from++
  let to = from
  while (to < curve.length && curve[to] > bottomDb) to++

  // ISO 3382 asks for 10 dB of headroom between the bottom of the fit and the noise.
  const valid = to < curve.length && from < to && noiseFloorDb <= bottomDb - 10 && to - from > sampleRate * 0.02

  if (from >= to || to > curve.length) {
    return { rt60: NaN, slope: 0, r2: 0, valid: false }
  }

  const asArray: number[] = []
  for (let i = from; i < to; i++) asArray.push(curve[i])
  const fit = leastSquares(asArray, 0, asArray.length, dt)
  const rt60 = fit.slope < 0 ? -60 / fit.slope : NaN
  return { rt60, slope: fit.slope, r2: fit.r2, valid: valid && fit.r2 > 0.9 }
}

/** Schroeder backward integration plus the three decay fits. */
export function schroeder(ir: Float32Array, sampleRate: number): Decay {
  const { crossPoint, noise } = lundebyCrossPoint(ir, sampleRate)
  const end = Math.max(1, Math.min(ir.length, crossPoint))

  const curve = new Float32Array(end)
  let running = 0
  for (let i = end - 1; i >= 0; i--) {
    running += ir[i] * ir[i]
    curve[i] = running
  }
  const total = curve[0] || 1
  for (let i = 0; i < end; i++) {
    curve[i] = 10 * Math.log10(Math.max(curve[i] / total, 1e-12))
  }

  return {
    curve,
    sampleRate,
    crossPoint: end,
    noiseFloorDb: noise,
    edt: fitRange(curve, sampleRate, 0, -10, noise),
    t20: fitRange(curve, sampleRate, -5, -25, noise),
    t30: fitRange(curve, sampleRate, -5, -35, noise),
  }
}

/** Whichever fit ISO 3382 would let you quote, most reliable first. */
export function bestFit(d: Decay): { fit: DecayFit; label: 'T30' | 'T20' | 'EDT' } | null {
  if (d.t30.valid) return { fit: d.t30, label: 'T30' }
  if (d.t20.valid) return { fit: d.t20, label: 'T20' }
  if (d.edt.valid) return { fit: d.edt, label: 'EDT' }
  return null
}

/** Early-to-late energy ratio in dB. C50 is speech, C80 is music. */
export function clarity(ir: Float32Array, sampleRate: number, splitMs: number): number {
  const split = Math.round((splitMs / 1000) * sampleRate)
  const early = energy(ir, 0, Math.min(split, ir.length))
  const late = energy(ir, Math.min(split, ir.length), ir.length)
  if (late <= 0 || early <= 0) return NaN
  return 10 * Math.log10(early / late)
}

/** Deutlichkeit: the share of energy arriving in the first 50 ms, as a percentage. */
export function definition(ir: Float32Array, sampleRate: number): number {
  const split = Math.round(0.05 * sampleRate)
  const early = energy(ir, 0, Math.min(split, ir.length))
  const all = energy(ir, 0, ir.length)
  if (all <= 0) return NaN
  return (early / all) * 100
}

/**
 * Distinct early arrivals, in the first 32 milliseconds.
 *
 * Peak-picking the envelope directly does not work, because the reverberant
 * tail is itself noisy and its loudest wiggles near the direct sound beat
 * any fixed threshold. What separates a reflection from the tail is that it
 * stands *above the decay it sits on*: the tail falls in a straight line in
 * decibels, so fit that line and keep only the peaks well clear of it.
 *
 * The laptop's speaker and microphone are a few centimetres apart, so source
 * and receiver are effectively co-located: an arrival t seconds after the
 * direct sound has travelled c*t further, and a surface that sent it back in
 * one bounce is half of that away. Only the first few arrivals are single
 * bounces, which is why the window is short: past about 30 ms the arrivals
 * are double bounces and diffuse field, and no single surface owns them.
 */
export function earlyReflections(
  ir: Float32Array,
  sampleRate: number,
  windowMs = 32,
  max = 4,
): Reflection[] {
  const end = Math.min(ir.length, Math.round((windowMs / 1000) * sampleRate))
  if (end < sampleRate * 0.02) return []

  const env = hilbertEnvelope(ir.subarray(0, end))
  // A light smooth over a third of a millisecond: enough to stop the carrier
  // showing through, short enough to leave an arrival as an arrival.
  // Centred, not forward-looking: a one-sided window reports every arrival
  // half a window early, which is a few centimetres of distance error.
  const smooth = Math.max(1, Math.round(sampleRate * 0.00033))
  const half = smooth >> 1
  const level = new Float32Array(end)
  for (let i = 0; i < end; i++) {
    let peak = 0
    for (let k = -half; k <= half; k++) {
      const j = i + k
      if (j >= 0 && j < end && env[j] > peak) peak = env[j]
    }
    level[i] = peak
  }

  const direct = level[0]
  if (!(direct > 0)) return []
  const db = (i: number) => 20 * Math.log10(Math.max(level[i], 1e-12) / direct)

  // Ignore the direct sound and its immediate ringing: 3 ms is half a metre,
  // and nothing closer than that is a room surface.
  // 5 ms is 0.86 m: nothing closer is a room surface, and the direct sound's
  // own ringing is still coming down before then.
  const from = Math.round(sampleRate * 0.005)
  if (from >= end - 2) return []

  // Straight-line fit of the decay these peaks stand on.
  let sx = 0, sy = 0, sxx = 0, sxy = 0
  const n = end - from
  for (let i = from; i < end; i++) {
    const y = db(i)
    sx += i; sy += y; sxx += i * i; sxy += i * y
  }
  const denom = n * sxx - sx * sx
  const slope = denom === 0 ? 0 : (n * sxy - sx * sy) / denom
  const intercept = (sy - slope * sx) / n
  const trend = (i: number) => intercept + slope * i

  const PROMINENCE_DB = 8
  const minGap = Math.round(sampleRate * 0.002)

  interface Candidate { index: number; prominence: number }
  const peaks: Candidate[] = []
  for (let i = from + 1; i < end - 1; i++) {
    if (level[i] < level[i - 1] || level[i] < level[i + 1]) continue
    const prominence = db(i) - trend(i)
    if (prominence < PROMINENCE_DB) continue
    // An arrival 42 dB under the direct sound is not telling you about a wall.
    if (db(i) < -42) continue
    const last = peaks[peaks.length - 1]
    if (last && i - last.index < minGap) {
      if (prominence > last.prominence) peaks[peaks.length - 1] = { index: i, prominence }
      continue
    }
    peaks.push({ index: i, prominence })
  }

  // Earliest first, not loudest first. The first arrivals after the direct
  // sound are the single-bounce ones, and those are the only arrivals for
  // which "the surface is half of that away" is true at all. Sorting by
  // prominence promotes late diffuse peaks over real early walls.
  return peaks
    .sort((a, b) => a.index - b.index)
    .slice(0, max)
    .map(({ index }) => {
      const time = index / sampleRate
      return { time, distance: (SPEED_OF_SOUND * time) / 2, levelDb: db(index) }
    })
}
