/**
 * C50, C80 and D50 split at a fixed time after the direct sound, so the only
 * thing that has to be right is where "after the direct sound" starts.
 *
 * A flat impulse response makes that exactly measurable. Give it 100 ms of
 * constant amplitude beginning at the direct arrival and the first 50 ms hold
 * exactly half the energy: C50 is 0.00 dB and D50 is 50%, by construction and
 * not by simulation. Move the split by two milliseconds and the answer moves by
 * a third of a decibel, which is the size of error this catches.
 *
 * It matters because analyse() does not hand these functions an impulse
 * response that starts at the direct sound. It starts two milliseconds earlier,
 * deliberately, so the impulse's own leading edge is not clipped off.
 */

import { clarity, definition } from '../src/dsp/acoustics.ts'

const fs = 48000

/** The lead analyse() keeps ahead of the peak, in samples. */
const LEAD = Math.round(0.002 * fs)

/** Flat for `ms` milliseconds starting at the direct arrival, silent before it. */
function flatIr(ms: number): Float32Array {
  const ir = new Float32Array(LEAD + Math.round((ms / 1000) * fs))
  for (let i = LEAD; i < ir.length; i++) ir[i] = 1
  return ir
}

let ok = true
const check = (name: string, got: number, want: number, tol: number, unit: string) => {
  const pass = Number.isFinite(got) && Math.abs(got - want) <= tol
  if (!pass) ok = false
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name.padEnd(34)} ${got.toFixed(2).padStart(7)} ${unit}  (wants ${want} ${String.fromCharCode(177)} ${tol})`)
  return pass
}

console.log('flat impulse response, energy split evenly either side of the mark')

// 100 ms flat: the first 50 ms after the direct sound hold half the energy.
const ir100 = flatIr(100)
check('C50 of a 100 ms flat response', clarity(ir100, fs, 50, LEAD), 0, 0.05, 'dB')
check('D50 of a 100 ms flat response', definition(ir100, fs, LEAD), 50, 0.5, '%')

// 160 ms flat: the first 80 ms hold half.
const ir160 = flatIr(160)
check('C80 of a 160 ms flat response', clarity(ir160, fs, 80, LEAD), 0, 0.05, 'dB')

// Three quarters early, one quarter late: 10*log10(3) = 4.77 dB.
const ir200of50 = flatIr(200 / 3)
check('C50 with three quarters early', clarity(ir200of50, fs, 50, LEAD), 4.77, 0.05, 'dB')

console.log(`\n${ok ? 'ALL PASS' : 'FAILURES ABOVE'}`)
process.exit(ok ? 0 : 1)
