import { octaveBand } from '../src/dsp/bands.ts'
const fs = 48000, N = 1 << 16
function toneResponse(centre: number, probe: number): number {
  const x = new Float32Array(N)
  for (let i = 0; i < N; i++) x[i] = Math.sin((2 * Math.PI * probe * i) / fs)
  const y = octaveBand(x, centre, fs)
  let e = 0; const from = N >> 2, to = N - (N >> 2)
  for (let i = from; i < to; i++) e += y[i] * y[i]
  return 10 * Math.log10(e / (to - from) / 0.5)
}
console.log('octave band centred on 1000 Hz')
for (const probe of [250, 500, 707, 1000, 1414, 2000, 4000]) {
  console.log(`  ${String(probe).padStart(5)} Hz  ${toneResponse(1000, probe).toFixed(1)} dB`)
}
