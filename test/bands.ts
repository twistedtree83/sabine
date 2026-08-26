/**
 * A room that rings longer at the bottom than the top, which is what a real
 * hard-surfaced room does. If the octave filters work, the measured curve
 * should follow the target curve down.
 */

import { makeSweep } from '../src/dsp/sweep.ts'
import { convolve } from '../src/dsp/fft.ts'
import { octaveBand, OCTAVE_CENTRES } from '../src/dsp/bands.ts'
import { analyse } from '../src/dsp/analyse.ts'

const fs = 48000
let seed = 987654
const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff }
const noise = () => rand() * 2 - 1

// Bass-heavy: 1.5 s at 125 Hz falling to 0.5 s at 4 kHz.
const TARGET = [1.5, 1.3, 1.05, 0.85, 0.65, 0.5]

function bandedRoom(lengthSec: number): Float32Array {
  const n = Math.round(lengthSec * fs)
  const white = new Float32Array(n)
  for (let i = 0; i < n; i++) white[i] = noise()

  const h = new Float32Array(n)
  OCTAVE_CENTRES.forEach((centre, b) => {
    // Filter noise into the band, then impose that band's decay envelope.
    const filtered = octaveBand(white, centre, fs)
    const decay = Math.log(1000) / TARGET[b]
    for (let i = 0; i < n; i++) h[i] += filtered[i] * Math.exp((-i / fs) * decay) * 1.2
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

console.log('\nband     target   measured   error')
let ok = true
r.bands.forEach((b, i) => {
  const err = ((b.rt60 - TARGET[i]) / TARGET[i]) * 100
  const good = b.valid && Math.abs(err) < 12
  ok = ok && good
  const hz = OCTAVE_CENTRES[i] >= 1000 ? `${OCTAVE_CENTRES[i] / 1000} kHz` : `${OCTAVE_CENTRES[i]} Hz`
  console.log(
    `${hz.padEnd(8)} ${TARGET[i].toFixed(2)} s   ${b.valid ? b.rt60.toFixed(2) + ' s' : ' --  '}   ` +
    `${b.valid ? (err >= 0 ? '+' : '') + err.toFixed(1) + '%' : ''}  ${good ? '' : '  <-- off'}`,
  )
})
console.log(`\n${ok ? 'PASS' : 'FAIL'}  the filters separate the bands (tolerance 12%)`)
process.exit(ok ? 0 : 1)
