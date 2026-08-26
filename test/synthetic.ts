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

const fs = 48000

// A deterministic PRNG so a failure is reproducible.
let seed = 12345
const rand = () => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff
  return seed / 0x7fffffff
}
const noise = () => rand() * 2 - 1

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

function run(label: string, rt60: number, snrDb: number) {
  const sweep = makeSweep({ f1: 45, f2: 20000, duration: 4, sampleRate: fs })
  const room = syntheticRoom(rt60, Math.max(1.5, rt60 * 2.2))
  const wet = convolve(sweep.signal, room)

  // Pad with the lead-in silence a real capture has, then add microphone noise.
  const lead = Math.round(0.5 * fs)
  const rec = new Float32Array(lead + wet.length + Math.round(0.5 * fs))
  rec.set(wet, lead)
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

  const pass = Number.isFinite(midRt) && Math.abs(err) < 8
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  (tolerance 8%)`)
  return pass
}

let ok = true
ok = run('lively hall     ', 1.60, 60) && ok
ok = run('bare classroom  ', 0.90, 55) && ok
ok = run('treated room    ', 0.45, 50) && ok
ok = run('small dry office', 0.28, 45) && ok
ok = run('noisy capture   ', 0.90, 28) && ok

console.log(`\n${ok ? 'ALL PASS' : 'FAILURES ABOVE'}`)
process.exit(ok ? 0 : 1)
