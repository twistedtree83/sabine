/**
 * Wallace Sabine's equation, calibrated against the measurement.
 *
 *     RT60 = 0.161 * V / A
 *
 * where A is the room's total absorption in metric sabins. Predicting A from
 * a materials list means guessing at surfaces nobody wrote down, and the
 * guess is usually wrong by more than the treatment you are considering. So
 * this works the other way round: the measured RT60 and the room's volume
 * give A directly, and a treatment is a *change* to it. Everything unknown
 * about the room cancels.
 *
 * Absorption coefficients are typical published values for the octave bands
 * 125 Hz to 4 kHz. They vary between products; treat the result as a design
 * estimate, which is all the Sabine equation has ever been.
 */

import { OCTAVE_CENTRES } from './dsp/bands'

export type BandValues = [number, number, number, number, number, number]

export const SABINE_CONSTANT = 0.161

export interface Surface {
  id: string
  name: string
  detail: string
  /** Absorption of the material being added. */
  alpha: BandValues
  /** Absorption of what it covers up, subtracted from the total. */
  replaces: BandValues | null
  /** How its area is derived from the room, or null when it is counted per unit. */
  area: (room: RoomDims) => number
  /** Sabins per unit, for people rather than surfaces. */
  perUnit?: { count: (room: RoomDims) => number; unit: string }
}

export interface RoomDims {
  length: number
  width: number
  height: number
}

export const HARD_FLOOR: BandValues = [0.02, 0.03, 0.03, 0.03, 0.03, 0.02]
export const HARD_CEILING: BandValues = [0.1, 0.08, 0.05, 0.03, 0.03, 0.03]
export const PAINTED_WALL: BandValues = [0.1, 0.05, 0.06, 0.07, 0.09, 0.08]

export const TREATMENTS: Surface[] = [
  {
    id: 'ceiling',
    name: 'Suspended acoustic ceiling',
    detail: 'Mineral-fibre tile across the whole ceiling',
    alpha: [0.35, 0.45, 0.65, 0.75, 0.8, 0.8],
    replaces: HARD_CEILING,
    area: (r) => r.length * r.width,
  },
  {
    id: 'panels',
    name: 'Wall panels, 50 mm',
    detail: 'Class A mineral wool over a fifth of the wall area',
    alpha: [0.2, 0.65, 0.95, 1.0, 1.0, 0.95],
    replaces: PAINTED_WALL,
    area: (r) => 2 * (r.length + r.width) * r.height * 0.2,
  },
  {
    id: 'carpet',
    name: 'Carpet on underlay',
    detail: 'Over four fifths of the floor',
    alpha: [0.08, 0.24, 0.57, 0.69, 0.71, 0.73],
    replaces: HARD_FLOOR,
    area: (r) => r.length * r.width * 0.8,
  },
  {
    id: 'curtains',
    name: 'Heavy curtains',
    detail: 'Gathered to half their flat width along one long wall',
    alpha: [0.07, 0.31, 0.49, 0.75, 0.7, 0.6],
    replaces: null,
    area: (r) => r.length * r.height * 0.5,
  },
  {
    id: 'display',
    name: 'Soft display boards',
    detail: 'Cork and fabric over a tenth of the wall area',
    alpha: [0.05, 0.1, 0.2, 0.25, 0.3, 0.3],
    replaces: PAINTED_WALL,
    area: (r) => 2 * (r.length + r.width) * r.height * 0.1,
  },
  {
    id: 'children',
    name: 'A class of thirty children',
    detail: 'Seated, in uniform. People are absorbers too',
    alpha: [0.2, 0.28, 0.32, 0.35, 0.37, 0.37],
    replaces: null,
    area: () => 0,
    perUnit: { count: () => 30, unit: 'children' },
  },
]

export function volume(r: RoomDims): number {
  return r.length * r.width * r.height
}

/** Total surface area of the box, for reference. */
export function surfaceArea(r: RoomDims): number {
  return 2 * (r.length * r.width + r.length * r.height + r.width * r.height)
}

/** Absorption implied by a measured reverberation time. */
export function absorptionFromRt(rt60: number, v: number): number {
  if (!Number.isFinite(rt60) || rt60 <= 0) return NaN
  return (SABINE_CONSTANT * v) / rt60
}

export function rtFromAbsorption(a: number, v: number): number {
  if (!Number.isFinite(a) || a <= 0) return NaN
  return (SABINE_CONSTANT * v) / a
}

/** Change in sabins from one treatment, per octave band. */
export function deltaSabins(s: Surface, room: RoomDims): BandValues {
  const out = [0, 0, 0, 0, 0, 0] as BandValues
  if (s.perUnit) {
    const n = s.perUnit.count(room)
    for (let i = 0; i < 6; i++) out[i] = n * s.alpha[i]
    return out
  }
  const area = s.area(room)
  for (let i = 0; i < 6; i++) {
    const replaced = s.replaces ? s.replaces[i] : 0
    out[i] = area * (s.alpha[i] - replaced)
  }
  return out
}

export interface Prediction {
  /** Per-band reverberation time after treatment, NaN where unmeasured. */
  bands: BandValues
  /** Mid-frequency average over 500 Hz, 1 kHz and 2 kHz: the number BB93 quotes. */
  midFrequency: number
  /** Mid-frequency average before treatment. */
  baseline: number
  /** Sabins added, mid-frequency. */
  addedSabins: number
  /** True when this came from a real measurement rather than a bare-box estimate. */
  calibrated: boolean
}

const MID_BANDS = [2, 3, 4] // 500 Hz, 1 kHz, 2 kHz

function average(values: number[]): number {
  const good = values.filter((v) => Number.isFinite(v) && v > 0)
  if (!good.length) return NaN
  return good.reduce((a, b) => a + b, 0) / good.length
}

/**
 * `measured` is per-band RT60 from the instrument. Bands it could not resolve
 * are filled from the mid-frequency average so a treatment still shows a
 * sensible curve, and the caller marks them as estimated.
 */
export function predict(
  room: RoomDims,
  measured: BandValues,
  chosen: Surface[],
): Prediction {
  const v = volume(room)
  const baselineMid = average(MID_BANDS.map((i) => measured[i]))

  const filled = measured.map((rt) => (Number.isFinite(rt) && rt > 0 ? rt : baselineMid)) as BandValues
  const delta = chosen.reduce(
    (acc, s) => {
      const d = deltaSabins(s, room)
      for (let i = 0; i < 6; i++) acc[i] += d[i]
      return acc
    },
    [0, 0, 0, 0, 0, 0] as BandValues,
  )

  const bands = filled.map((rt, i) => {
    const a = absorptionFromRt(rt, v)
    if (!Number.isFinite(a)) return NaN
    return rtFromAbsorption(a + delta[i], v)
  }) as BandValues

  return {
    bands,
    midFrequency: average(MID_BANDS.map((i) => bands[i])),
    baseline: baselineMid,
    addedSabins: average(MID_BANDS.map((i) => delta[i])),
    calibrated: Number.isFinite(baselineMid),
  }
}

/**
 * Building Bulletin 93 is the schools acoustic standard for England and Wales.
 * The limit is on the mid-frequency reverberation time of an unoccupied,
 * furnished room.
 */
export const BB93 = {
  general: 0.8,
  sen: 0.6,
} as const

export function verdict(rt: number, limit: number): 'good' | 'bad' | 'unknown' {
  if (!Number.isFinite(rt)) return 'unknown'
  return rt <= limit ? 'good' : 'bad'
}

export const BAND_LABELS = OCTAVE_CENTRES.map((c) => (c >= 1000 ? `${c / 1000} kHz` : `${c} Hz`))
