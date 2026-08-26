/**
 * A room that rings longer at the bottom than the top, which is what a real
 * hard-surfaced room does. If the octave filters work, the measured curve
 * should follow the target curve down.
 */

import { makeSweep } from '../src/dsp/sweep.ts'
import { convolve } from '../src/dsp/fft.ts'
import { OCTAVE_CENTRES } from '../src/dsp/bands.ts'
import { makeRandom } from './prng.ts'
import { analyse } from '../src/dsp/analyse.ts'

const fs = 48000
const seed = 987654
const rand = makeRandom(seed)
const noise = () => rand() * 2 - 1

// Bass-heavy: 1.5 s at 125 Hz falling to 0.5 s at 4 kHz.
const TARGET = [1.5, 1.3, 1.05, 0.85, 0.65, 0.5]

/**
 * Band-limited noise as a sum of random-phase sinusoids drawn from inside the
 * octave, built from the ISO centre frequency and nothing else.
 *
 * This used to call octaveBand() - the function the test then asks to measure
 * the result - so band centres and widths agreed by construction: a filter
 * centred on the wrong frequency would have built its room at the wrong
 * frequency too, and passed. Sinusoids share no code with the filter, so if the
 * two disagree about where a band is, the test now says so.
 */
const PARTIALS = 256

function bandNoise(n: number, centre: number): Float32Array {
  const lo = centre / Math.SQRT2
  const hi = centre * Math.SQRT2
  const out = new Float32Array(n)
  for (let p = 0; p < PARTIALS; p++) {
    const w = (2 * Math.PI * (lo + (hi - lo) * rand())) / fs
    const phase = rand() * 2 * Math.PI
    for (let i = 0; i < n; i++) out[i] += Math.sin(w * i + phase)
  }
  const scale = 1 / Math.sqrt(PARTIALS)
  for (let i = 0; i < n; i++) out[i] *= scale
  return out
}

function bandedRoom(lengthSec: number): Float32Array {
  const n = Math.round(lengthSec * fs)
  const h = new Float32Array(n)
  OCTAVE_CENTRES.forEach((centre, b) => {
    const excitation = bandNoise(n, centre)
    const decay = Math.log(1000) / TARGET[b]
    for (let i = 0; i < n; i++) h[i] += excitation[i] * Math.exp((-i / fs) * decay) * 1.2
  })
  h[0] += 1
  return h
}

const sweep = makeSweep({ f1: 45, f2: 20000, duration: 4, sampleRate: fs })
const wet = convolve(sweep.signal, bandedRoom(4))
const lead = Math.round(0.5 * fs)
const rec = new Float32Array(lead + wet.length + Math.round(0.5 * fs))
rec.set(wet, lead)
let peak = 0
for (const v of rec) peak = Math.max(peak, Math.abs(v))
for (let i = 0; i < rec.length; i++) rec[i] += noise() * peak * Math.pow(10, -55 / 20)

const r = analyse({ recording: rec, inverse: sweep.inverse, sampleRate: fs })

// 8%. Not 3%: with the room built independently of the filter rather than by
// it, the residual is real band overlap, and it does not shrink when the
// excitation is made denser. The 3% the README used to quote came from a test
// that filtered its own room with the function it was measuring.
const TOLERANCE = 8

console.log('\nband     target   measured   error')
let ok = true
r.bands.forEach((b, i) => {
  const err = ((b.rt60 - TARGET[i]) / TARGET[i]) * 100
  const good = b.valid && Math.abs(err) < TOLERANCE
  ok = ok && good
  const hz = OCTAVE_CENTRES[i] >= 1000 ? `${OCTAVE_CENTRES[i] / 1000} kHz` : `${OCTAVE_CENTRES[i]} Hz`
  console.log(
    `${hz.padEnd(8)} ${TARGET[i].toFixed(2)} s   ${b.valid ? b.rt60.toFixed(2) + ' s' : ' --  '}   ` +
    `${b.valid ? (err >= 0 ? '+' : '') + err.toFixed(1) + '%' : ''}  ${good ? '' : '  <-- off'}`,
  )
})
console.log(`\n${ok ? 'PASS' : 'FAIL'}  every band within ${TOLERANCE}% of target`)

// The point of this room is that it rings longer at the bottom than the top, so
// the thing to assert is that the instrument reproduces the *shape* and not
// only each number in isolation. A filter that smeared every band into its
// neighbours could still land each one inside the tolerance while flattening
// the curve that tells you the ceiling is bare and the floor is not.
const measured = r.bands.map((b) => b.rt60)
let monotone = true
for (let i = 1; i < measured.length; i++) {
  if (!(measured[i] < measured[i - 1])) monotone = false
}
const spread = measured[0] / measured[measured.length - 1]
const targetSpread = TARGET[0] / TARGET[TARGET.length - 1]
const spreadOk = spread > targetSpread * 0.8
if (!monotone) console.log('FAIL  the measured curve does not fall from 125 Hz to 4 kHz')
if (!spreadOk) console.log(`FAIL  bottom-to-top spread ${spread.toFixed(2)}x, target ${targetSpread.toFixed(2)}x - the bands are smeared together`)
if (monotone && spreadOk) console.log(`PASS  the curve falls monotonically, ${spread.toFixed(2)}x from 125 Hz to 4 kHz (target ${targetSpread.toFixed(2)}x)`)
ok = ok && monotone && spreadOk

process.exit(ok ? 0 : 1)
