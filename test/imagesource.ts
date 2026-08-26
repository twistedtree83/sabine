/**
 * A physically-derived room, not a hand-tuned one.
 *
 * The image-source method: every reflection off a flat wall is equivalent to
 * a straight path from a mirrored copy of the source. Enumerate the mirror
 * images of a shoebox up to third order and you get the real early reflection
 * pattern, with the diffuse tail emerging on its own as the image density
 * grows. The wall distances are then ground truth, so the reflection finder
 * either recovers them or it does not.
 */

import { makeSweep } from '../src/dsp/sweep.ts'
import { convolve } from '../src/dsp/fft.ts'
import { analyse } from '../src/dsp/analyse.ts'
import { SPEED_OF_SOUND, earlyReflections, findDirectSound } from '../src/dsp/acoustics.ts'

const fs = 48000
let seed = 20250825
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff * 2 - 1 }

const L = [9, 7, 2.9]            // room, metres
const P = [4.5, 3.5, 1.15]       // laptop position
const SEP = 0.15                 // speaker to microphone
const ALPHA = 0.12               // average absorption
const R = Math.sqrt(1 - ALPHA)   // pressure reflection coefficient
const ORDER = 6

function imageSourceRoom(seconds: number) {
  const n = Math.round(seconds * fs)
  const h = new Float32Array(n)

  // Direct sound: the receiver sits SEP metres from the source.
  h[0] += 1 / SEP

  // Allen and Berkley's enumeration. Each axis has two families of mirror
  // images, x = (1 - 2p) * xs + 2 * m * L for p in {0, 1}; leaving one out
  // is exactly how you lose the floor bounce.
  for (let px = 0; px <= 1; px++) {
    for (let py = 0; py <= 1; py++) {
      for (let pz = 0; pz <= 1; pz++) {
        for (let mx = -ORDER; mx <= ORDER; mx++) {
          for (let my = -ORDER; my <= ORDER; my++) {
            for (let mz = -ORDER; mz <= ORDER; mz++) {
              const bounces =
                Math.abs(mx - px) + Math.abs(mx) +
                Math.abs(my - py) + Math.abs(my) +
                Math.abs(mz - pz) + Math.abs(mz)
              if (bounces === 0) continue // the direct sound, already placed
              const ix = (1 - 2 * px) * P[0] + 2 * mx * L[0]
              const iy = (1 - 2 * py) * P[1] + 2 * my * L[1]
              const iz = (1 - 2 * pz) * P[2] + 2 * mz * L[2]
              const d = Math.hypot(ix - P[0], iy - P[1], iz - P[2])
              if (d <= 0) continue
              const k = Math.round((d / SPEED_OF_SOUND) * fs)
              if (k >= n) continue
              h[k] += (Math.pow(R, bounces) / d) * (bounces % 2 === 0 ? 1 : -1)
            }
          }
        }
      }
    }
  }

  // The lattice thins out faster than a real room's scattering does, so top
  // the late field up with diffuse noise on the same decay slope.
  const rtSabine = (0.161 * (L[0] * L[1] * L[2])) / (2 * (L[0] * L[1] + L[0] * L[2] + L[1] * L[2]) * ALPHA)
  const lateStart = Math.round(0.05 * fs)
  const decay = Math.log(1000) / rtSabine
  let tailRef = 0
  for (let i = lateStart; i < lateStart + 500 && i < n; i++) tailRef = Math.max(tailRef, Math.abs(h[i]))
  for (let i = lateStart; i < n; i++) {
    h[i] += rnd() * tailRef * 0.8 * Math.exp((-(i - lateStart) / fs) * decay)
  }
  return { h, rtSabine }
}

const { h, rtSabine } = imageSourceRoom(3)

// Ground truth: first-order images are the six surfaces.
const truth = [
  { what: 'floor', metres: P[2] },
  { what: 'ceiling', metres: L[2] - P[2] },
  { what: 'near side wall', metres: Math.min(P[1], L[1] - P[1]) },
  { what: 'far side wall', metres: Math.max(P[1], L[1] - P[1]) },
  { what: 'end wall', metres: Math.min(P[0], L[0] - P[0]) },
].sort((a, b) => a.metres - b.metres)

const sweep = makeSweep({ f1: 45, f2: 20000, duration: 4, sampleRate: fs })
const wet = convolve(sweep.signal, h)
const lead = Math.round(0.5 * fs)
const rec = new Float32Array(lead + wet.length + Math.round(0.5 * fs))
rec.set(wet, lead)
let pk = 0
for (const v of rec) pk = Math.max(pk, Math.abs(v))
for (let i = 0; i < rec.length; i++) rec[i] += rnd() * pk * Math.pow(10, -55 / 20)

const r = analyse({ recording: rec, inverse: sweep.inverse, sampleRate: fs })

console.log(`\nShoebox ${L.join(' x ')} m, absorption ${ALPHA}, Sabine RT60 = ${rtSabine.toFixed(2)} s`)
console.log(`measured RT60 = ${r.broadband.rt60.toFixed(2)} s (${r.broadband.label})   C50 ${r.c50.toFixed(1)} dB\n`)
console.log('surfaces actually present:')
for (const t of truth) console.log(`   ${t.metres.toFixed(2)} m  ${t.what}`)
console.log('\nreflection finder reported:')
if (!r.reflections.length) console.log('   (nothing)')
for (const x of r.reflections) {
  const near = truth.reduce((a, b) => (Math.abs(b.metres - x.distance) < Math.abs(a.metres - x.distance) ? b : a))
  const err = Math.abs(near.metres - x.distance)
  console.log(`   ${x.distance.toFixed(2)} m  at ${(x.time * 1000).toFixed(1)} ms, ${x.levelDb.toFixed(1)} dB   ` +
    `${err < 0.25 ? `= ${near.what}` : `<- no surface within 0.25 m (nearest ${near.what} at ${near.metres.toFixed(2)})`}`)
}
// The README quotes 3 cm. A 0.25 m gate is eight times looser than the claim,
// and wide enough to hide a systematic bias larger than the whole quoted
// accuracy - which is exactly what it was hiding.
const ACCURACY_M = 0.03

// An arrival is matched to a surface generously, so that a double bounce is not
// scored as a miss; the accuracy assertion below is what is actually tight.
const matched = r.reflections
  .map((x) => {
    const near = truth.reduce((a, b) => (Math.abs(b.metres - x.distance) < Math.abs(a.metres - x.distance) ? b : a))
    return { x, near, err: Math.abs(near.metres - x.distance) }
  })
  .filter((m) => m.err < 0.25)

const rtErr = Math.abs(r.broadband.rt60 - rtSabine) / rtSabine * 100

console.log(`\n${matched.length} of ${r.reflections.length} reported arrivals sit on a first-order surface`)
console.log(`RT60 measured ${r.broadband.rt60.toFixed(2)} s against Sabine's ${rtSabine.toFixed(2)} s  (${rtErr.toFixed(1)}%)`)
console.log('Arrivals that match no single surface are usually real double bounces:')
console.log('  a floor-then-ceiling path in this room is 2 x 2.9 = 5.8 m, which reads as 2.90 m.')

// A bias shows up as every error sharing a sign, which a per-arrival tolerance
// alone would not catch, so the mean signed error is asserted separately.
let ok = matched.length >= 3 && rtErr < 8
if (!ok) console.log(`\nFAIL  wanted >= 3 surfaces (got ${matched.length}) and RT60 within 8% (got ${rtErr.toFixed(1)}%)`)

console.log(`\naccuracy of each matched arrival (wants within ${(ACCURACY_M * 100).toFixed(0)} cm):`)
let signedSum = 0
for (const m of matched) {
  const signed = m.x.distance - m.near.metres
  signedSum += signed
  const good = Math.abs(signed) <= ACCURACY_M
  if (!good) ok = false
  console.log(`  ${good ? 'PASS' : 'FAIL'}  ${m.near.what.padEnd(16)} ${(signed * 100 >= 0 ? '+' : '')}${(signed * 100).toFixed(1)} cm`)
}
const bias = matched.length ? (signedSum / matched.length) * 100 : 0
const biasOk = Math.abs(bias) <= ACCURACY_M * 100 * 0.5
if (!biasOk) ok = false
console.log(`  ${biasOk ? 'PASS' : 'FAIL'}  mean signed error ${bias >= 0 ? '+' : ''}${bias.toFixed(1)} cm  (wants within ${(ACCURACY_M * 100 * 0.5).toFixed(1)} cm of zero)`)

console.log(`\n${ok ? 'PASS' : 'FAIL'}`)
process.exit(ok ? 0 : 1)
