/**
 * The octave filter's shape, asserted rather than printed.
 *
 * This is the test behind the README's claim that the band filter is a
 * frequency-domain Butterworth mask and not a cascade of biquads. Three
 * cascaded second-order sections put the octave edges in the right place and
 * then roll off so slowly that the neighbouring band is only ~10 dB down, where
 * IEC 61260 class 1 asks for about 61. A room ringing longer at the bottom then
 * leaks into every band above it, and mid-band errors reached 27% before the
 * filter was replaced.
 *
 * This file previously printed seven numbers for a human to read and always
 * exited 0, so none of that was enforced. The thresholds below are the shape
 * the rest of the octave analysis assumes it is being handed.
 */

import { octaveBand } from '../src/dsp/bands.ts'

const fs = 48000
const N = 1 << 16

/** Power gain, in dB, of the band centred on `centre` at a pure tone of `probe`. */
function toneResponse(centre: number, probe: number): number {
  const x = new Float32Array(N)
  for (let i = 0; i < N; i++) x[i] = Math.sin((2 * Math.PI * probe * i) / fs)
  const y = octaveBand(x, centre, fs)
  // Measure over the middle half only, so the mask's edge transients are not
  // counted as band response.
  let e = 0
  const from = N >> 2, to = N - (N >> 2)
  for (let i = from; i < to; i++) e += y[i] * y[i]
  return 10 * Math.log10(e / (to - from) / 0.5)
}

/**
 * Probes are placed by ratio to the centre, so one table covers every band: the
 * centre, the two -3 dB edges half an octave out, the neighbouring band centres
 * an octave out, and two octaves out where the mask should be gone entirely.
 */
const PROBES: { ratio: number; what: string; min: number; max: number }[] = [
  { ratio: 1 / 4,        what: 'two octaves below', min: -Infinity, max: -80 },
  { ratio: 1 / 2,        what: 'octave below',      min: -Infinity, max: -45 },
  { ratio: Math.SQRT1_2, what: 'lower edge',        min: -4,        max: -2 },
  { ratio: 1,            what: 'centre',            min: -0.5,      max: 0.5 },
  { ratio: Math.SQRT2,   what: 'upper edge',        min: -4,        max: -2 },
  { ratio: 2,            what: 'octave above',      min: -Infinity, max: -45 },
  { ratio: 4,            what: 'two octaves above', min: -Infinity, max: -80 },
]

let ok = true

// Bands with two clear octaves either side inside 45 Hz .. Nyquist.
for (const centre of [250, 500, 1000, 2000]) {
  console.log(`\noctave band centred on ${centre} Hz`)
  for (const p of PROBES) {
    const probe = centre * p.ratio
    const db = toneResponse(centre, probe)
    const pass = db >= p.min && db <= p.max
    if (!pass) ok = false
    const bound = p.min === -Infinity ? `<= ${p.max}` : `${p.min} to ${p.max}`
    console.log(
      `  ${pass ? 'PASS' : 'FAIL'}  ${String(Math.round(probe)).padStart(5)} Hz  ` +
        `${db.toFixed(1).padStart(7)} dB  (${p.what}, wants ${bound})`,
    )
  }
}

console.log(`\n${ok ? 'ALL PASS' : 'FAILURES ABOVE'}`)
process.exit(ok ? 0 : 1)
