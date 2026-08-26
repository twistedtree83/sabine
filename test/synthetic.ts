/**
 * Feed the analyser a room whose reverberation time we already know.
 *
 * A synthetic impulse response is exponentially decaying noise: RT60 is the
 * time to fall 60 dB, so the amplitude envelope is exp(-t * ln(1000) / RT60).
 * Convolve the real sweep with it, add noise, and the pipeline should hand
 * back the number we started with.
 */

import { makeSweep } from '../src/dsp/sweep.ts'
import { convolve } from '../src/dsp/fft.ts'
import { analyse } from '../src/dsp/analyse.ts'
import { OCTAVE_CENTRES } from '../src/dsp/bands.ts'
import { makeRandom, assertNotPeriodic } from './prng.ts'

const fs = 48000
const SEED = 12345
// Tolerance is per-case rather than global: it is part of what each row
// promises, and a single loose number that lets the hardest case through is a
// single loose number that also lets a regression through on the easiest.
const BAND_TOLERANCE = 15

const rand = makeRandom(SEED)
const noise = () => rand() * 2 - 1

// The recording is 7 s; the generator has to outlast it comfortably.
assertNotPeriodic(SEED, 8 * fs, fs)

function syntheticRoom(rt60: number, lengthSec: number, directGain = 1): Float32Array {
  const n = Math.round(lengthSec * fs)
  const h = new Float32Array(n)
  const decay = Math.log(1000) / rt60
  for (let i = 1; i < n; i++) {
    h[i] = noise() * Math.exp((-i / fs) * decay) * 0.35
  }
  h[0] = directGain // the direct sound
  return h
}

// The geometry capture.ts actually records: a lead-in, the sweep, and a tail of
// fixed length however long the room rings. Letting the recording grow with
// RT60 instead — which is what this test used to do — hands the analyser more
// data than the instrument ever captures, and it is precisely that extra length
// that hides a window running off the end of its own signal.
const LEAD = 0.5, DURATION = 4, TAIL = 2.5

function run(label: string, rt60: number, snrDb: number, TOLERANCE: number) {
  const sweep = makeSweep({ f1: 45, f2: 20000, duration: DURATION, sampleRate: fs })
  const room = syntheticRoom(rt60, Math.max(1.5, rt60 * 2.2))
  const wet = convolve(sweep.signal, room)

  // Truncate to the real capture length rather than padding to fit: a room that
  // rings longer than the tail gets cut off here exactly as it would in the app.
  const lead = Math.round(LEAD * fs)
  const rec = new Float32Array(Math.round((LEAD + DURATION + TAIL) * fs))
  for (let i = 0; i < wet.length && lead + i < rec.length; i++) rec[lead + i] = wet[i]
  let peak = 0
  for (const v of rec) peak = Math.max(peak, Math.abs(v))
  const noiseAmp = peak * Math.pow(10, -snrDb / 20)
  for (let i = 0; i < rec.length; i++) rec[i] += noise() * noiseAmp

  const r = analyse({ recording: rec, inverse: sweep.inverse, sampleRate: fs })

  const mid = [2, 3, 4].map((i) => r.bands[i]).filter((b) => b.valid)
  const midRt = mid.length ? mid.reduce((a, b) => a + b.rt60, 0) / mid.length : NaN
  const err = ((midRt - rt60) / rt60) * 100

  console.log(`\n${label}  target RT60 = ${rt60.toFixed(2)} s, mic SNR ${snrDb} dB`)
  console.log(`  broadband  ${r.broadband.rt60.toFixed(3)} s  (${r.broadband.label}, r2 ${r.broadband.r2.toFixed(4)})`)
  console.log(`  mid-freq   ${midRt.toFixed(3)} s   error ${err >= 0 ? '+' : ''}${err.toFixed(1)}%`)
  console.log(`  C50 ${r.c50.toFixed(1)} dB   D50 ${r.d50.toFixed(0)}%   SNR ${r.snrDb.toFixed(0)} dB`)
  console.log(
    '  bands      ' +
      r.bands
        .map((b, i) => `${OCTAVE_CENTRES[i] >= 1000 ? OCTAVE_CENTRES[i] / 1000 + 'k' : OCTAVE_CENTRES[i]}:${b.valid ? b.rt60.toFixed(2) : ' -- '}`)
        .join('  '),
  )

  // The contract is not "every number is close". It is that a number the
  // pipeline marks valid can be trusted. A measurement allowed to say "I could
  // not resolve this" and then say it is fine to be wrong; a measurement that
  // reports 11.7 s for a 1.6 s room with r2 = 0.93 and valid = true is the
  // failure this test exists to catch, and asserting only on the mid-band
  // average — the one quantity that stays protected — will never catch it.
  const fails: string[] = []

  if (!Number.isFinite(midRt)) fails.push('mid-band did not resolve')
  else if (Math.abs(err) >= TOLERANCE) fails.push(`mid-band off by ${err.toFixed(1)}%`)

  if (r.broadband.valid) {
    const bbErr = ((r.broadband.rt60 - rt60) / rt60) * 100
    if (Math.abs(bbErr) >= TOLERANCE) {
      fails.push(`broadband claims valid but is off by ${bbErr.toFixed(1)}% (${r.broadband.label}, r2 ${r.broadband.r2.toFixed(3)})`)
    }
  }

  // Bands carry less signal than the mid average, so they get more room — but
  // a band that says valid still has to be in the right country.
  r.bands.forEach((b, i) => {
    if (!b.valid) return
    const be = ((b.rt60 - rt60) / rt60) * 100
    if (Math.abs(be) >= BAND_TOLERANCE) {
      fails.push(`${OCTAVE_CENTRES[i]} Hz claims valid but is off by ${be.toFixed(0)}%`)
    }
  })

  if (fails.length) for (const f of fails) console.log(`  FAIL  ${f}`)
  else console.log(`  PASS  (within ${TOLERANCE}%, bands ${BAND_TOLERANCE}%)`)
  return fails.length === 0
}

let ok = true

// The five rooms the README quotes, at the 3% it quotes.
ok = run('lively hall     ', 1.60, 60, 3) && ok
ok = run('bare classroom  ', 0.90, 55, 3) && ok
ok = run('treated room    ', 0.45, 50, 3) && ok
ok = run('small dry office', 0.28, 45, 3) && ok
ok = run('noisy capture   ', 0.90, 28, 3) && ok

// Two rooms harder than anything the README claims: a lively space at the kind
// of microphone SNR a laptop on a desk in an occupied classroom actually gets.
// Accuracy is allowed to degrade here. What is not allowed is the pipeline
// staying confident while it does — which is why the validity contract above
// matters more on these two rows than the percentage does.
ok = run('lively, noisy   ', 1.60, 28, 5) && ok
ok = run('lively, noisier ', 1.60, 24, 5) && ok

console.log(`\n${ok ? 'ALL PASS' : 'FAILURES ABOVE'}`)
process.exit(ok ? 0 : 1)
