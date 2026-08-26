/**
 * The Sabine calculator, against arithmetic done by hand.
 *
 * This is the feature the project is named after and it had no test at all: a
 * sign flip on `replaces`, a swap of volume for surface area, or a wrong Sabine
 * constant would have changed every predicted RT60 and every BB93 verdict on
 * the page while `npm test` still printed ALL PASS - and since the suite gates
 * the deploy, it would have shipped.
 *
 * Every expected value below is written out as the arithmetic that produces it,
 * with 0.161 as a literal rather than SABINE_CONSTANT. A test that computes its
 * expectation by calling the code under test agrees with that code by
 * construction and proves nothing about whether either is right.
 */

import {
  absorptionFromRt, rtFromAbsorption, deltaSabins, predict, verdict, volume, surfaceArea,
  TREATMENTS, HARD_FLOOR, PAINTED_WALL, BB93, type BandValues, type RoomDims,
} from '../src/sabine.ts'

const ROOM: RoomDims = { length: 9, width: 7, height: 2.9 }
const V = 9 * 7 * 2.9          // 182.7 m3
const KHZ = 3                  // index of the 1 kHz band
const RT = 0.95                // a plausible bare classroom
const A = (0.161 * V) / RT     // 30.9628 sabins

const T = (id: string) => TREATMENTS.find((s) => s.id === id)!

let ok = true
const near = (name: string, got: number, want: number, tol = 1e-9) => {
  const pass = Number.isFinite(got) && Math.abs(got - want) <= tol
  if (!pass) ok = false
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name.padEnd(48)} ${got.toFixed(4).padStart(10)}  (wants ${want.toFixed(4)})`)
}
const is = (name: string, got: unknown, want: unknown) => {
  const pass = got === want
  if (!pass) ok = false
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name.padEnd(48)} ${String(got).padStart(10)}  (wants ${String(want)})`)
}

console.log('\nthe equation')
near('volume of a 9 x 7 x 2.9 m room', volume(ROOM), 182.7, 1e-9)
near('surface area of the same box', surfaceArea(ROOM), 2 * (63 + 26.1 + 20.3), 1e-9)
near('absorption implied by a 0.95 s room', absorptionFromRt(RT, V), A, 1e-9)
near('and back again', rtFromAbsorption(A, V), RT, 1e-9)
is('a non-positive RT60 has no absorption', Number.isNaN(absorptionFromRt(0, V)), true)
is('nor does an unresolved one', Number.isNaN(absorptionFromRt(NaN, V)), true)

console.log('\nsabins added by each treatment at 1 kHz')
// Carpet: four fifths of the floor, replacing hard floor underneath it.
near('carpet on underlay', deltaSabins(T('carpet'), ROOM)[KHZ], 9 * 7 * 0.8 * (0.69 - HARD_FLOOR[KHZ]))
// Wall panels: a fifth of the wall area, replacing painted wall.
near('wall panels, 50 mm', deltaSabins(T('panels'), ROOM)[KHZ], 2 * (9 + 7) * 2.9 * 0.2 * (1.0 - PAINTED_WALL[KHZ]))
// Curtains hang in front of the wall rather than replacing it, so nothing is subtracted.
near('heavy curtains', deltaSabins(T('curtains'), ROOM)[KHZ], 9 * 2.9 * 0.5 * 0.75)
// People are counted per head, not per square metre, and do not scale with the room.
near('thirty children', deltaSabins(T('children'), ROOM)[KHZ], 30 * 0.35)
near('thirty children in a hall twice the size',
  deltaSabins(T('children'), { length: 18, width: 14, height: 2.9 })[KHZ], 30 * 0.35)

console.log('\nwhat a surface covers is subtracted, not ignored')
// The sign of `replaces` is the easiest thing here to get backwards, and it is
// invisible in the result unless something checks the size of the difference.
for (const id of ['carpet', 'panels', 'ceiling', 'display']) {
  const s = T(id)
  const withReplace = deltaSabins(s, ROOM)[KHZ]
  const without = deltaSabins({ ...s, replaces: null }, ROOM)[KHZ]
  near(`${s.id}: covering the old surface costs sabins`,
    without - withReplace, s.area(ROOM) * (s.replaces as BandValues)[KHZ])
  is(`${s.id}: and so adds less than it would bare`, withReplace < without, true)
}

console.log('\nprediction')
const flat = [RT, RT, RT, RT, RT, RT] as BandValues
const carpeted = predict(ROOM, flat, [T('carpet')])
near('1 kHz after carpet', carpeted.bands[KHZ],
  (0.161 * V) / (A + 9 * 7 * 0.8 * (0.69 - HARD_FLOOR[KHZ])), 1e-9)
is('a measured room is calibrated', carpeted.calibrated, true)
near('untreated baseline is the measurement', carpeted.baseline, RT, 1e-9)
is('treatment lowers the mid-frequency time', carpeted.midFrequency < RT, true)

// Bands the instrument could not resolve are filled from the mid average, so a
// treatment still draws a sensible curve across all six.
const gappy = [NaN, NaN, RT, RT, RT, NaN] as BandValues
const filled = predict(ROOM, gappy, [T('carpet')])
is('unresolved bands still predict a number', filled.bands.every((b) => Number.isFinite(b)), true)
near('mid-frequency ignores the unresolved bands', filled.baseline, RT, 1e-9)

// Nothing measured at all: there is no absorption to calibrate against.
const nothing = predict(ROOM, [NaN, NaN, NaN, NaN, NaN, NaN] as BandValues, [T('carpet')])
is('an unmeasured room is not calibrated', nothing.calibrated, false)

console.log('\nBB93')
is('at the limit exactly is within it', verdict(0.8, BB93.general), 'good')
is('a hair over is not', verdict(0.81, BB93.general), 'bad')
is('the SEN limit is stricter', verdict(0.7, BB93.sen), 'bad')
is('an unresolved room gets no verdict', verdict(NaN, BB93.general), 'unknown')

console.log(`\n${ok ? 'ALL PASS' : 'FAILURES ABOVE'}`)
process.exit(ok ? 0 : 1)
