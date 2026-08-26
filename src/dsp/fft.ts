/**
 * Iterative radix-2 Cooley-Tukey FFT, in-place, on split real/imaginary arrays.
 *
 * Everything downstream needs one thing from this file: fast circular
 * convolution of two multi-second buffers. At 48 kHz a 10 s recording is
 * 480k samples, so the transform runs at n = 2^20 and the whole analysis
 * lives in a worker.
 */

const twiddleCache = new Map<number, { cos: Float64Array; sin: Float64Array }>()

function twiddles(n: number) {
  let t = twiddleCache.get(n)
  if (t) return t
  const half = n >> 1
  const cos = new Float64Array(half)
  const sin = new Float64Array(half)
  for (let i = 0; i < half; i++) {
    cos[i] = Math.cos((-2 * Math.PI * i) / n)
    sin[i] = Math.sin((-2 * Math.PI * i) / n)
  }
  t = { cos, sin }
  twiddleCache.set(n, t)
  return t
}

/** Smallest power of two >= n. */
export function nextPow2(n: number): number {
  let p = 1
  while (p < n) p <<= 1
  return p
}

function bitReverse(re: Float64Array, im: Float64Array, n: number) {
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t
      t = im[i]; im[i] = im[j]; im[j] = t
    }
  }
}

/** In-place forward FFT. `n` must be a power of two. */
export function fft(re: Float64Array, im: Float64Array) {
  const n = re.length
  bitReverse(re, im, n)
  const { cos, sin } = twiddles(n)
  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1
    const step = n / len
    for (let i = 0; i < n; i += len) {
      for (let k = 0, tw = 0; k < half; k++, tw += step) {
        const wr = cos[tw]
        const wi = sin[tw]
        const a = i + k
        const b = a + half
        const xr = re[b] * wr - im[b] * wi
        const xi = re[b] * wi + im[b] * wr
        re[b] = re[a] - xr
        im[b] = im[a] - xi
        re[a] += xr
        im[a] += xi
      }
    }
  }
}

/** In-place inverse FFT, scaled by 1/n. */
export function ifft(re: Float64Array, im: Float64Array) {
  const n = re.length
  for (let i = 0; i < n; i++) im[i] = -im[i]
  fft(re, im)
  const inv = 1 / n
  for (let i = 0; i < n; i++) {
    re[i] *= inv
    im[i] = -im[i] * inv
  }
}

/**
 * Linear convolution of `a` and `b` via the frequency domain.
 * The result is trimmed to a.length + b.length - 1.
 */
export function convolve(a: Float32Array, b: Float32Array): Float32Array {
  const outLen = a.length + b.length - 1
  const n = nextPow2(outLen)

  const ar = new Float64Array(n)
  const ai = new Float64Array(n)
  const br = new Float64Array(n)
  const bi = new Float64Array(n)
  ar.set(a)
  br.set(b)

  fft(ar, ai)
  fft(br, bi)

  for (let i = 0; i < n; i++) {
    const re = ar[i] * br[i] - ai[i] * bi[i]
    const im = ar[i] * bi[i] + ai[i] * br[i]
    ar[i] = re
    ai[i] = im
  }

  ifft(ar, ai)

  const out = new Float32Array(outLen)
  for (let i = 0; i < outLen; i++) out[i] = ar[i]
  return out
}

/**
 * Magnitude of the analytic signal: the Hilbert envelope.
 *
 * A sliding RMS window is the obvious way to get an envelope and the wrong
 * one here, because it spreads a single-sample arrival over the whole window
 * and flattens exactly the impulsive peaks we are looking for. Zeroing the
 * negative frequencies and taking the magnitude of what comes back gives an
 * envelope that follows the signal instant by instant.
 */
export function hilbertEnvelope(x: Float32Array): Float32Array {
  const n = nextPow2(x.length)
  const re = new Float64Array(n)
  const im = new Float64Array(n)
  re.set(x)

  fft(re, im)

  const half = n >> 1
  for (let k = 1; k < half; k++) {
    re[k] *= 2
    im[k] *= 2
  }
  for (let k = half + 1; k < n; k++) {
    re[k] = 0
    im[k] = 0
  }

  ifft(re, im)

  const out = new Float32Array(x.length)
  for (let i = 0; i < x.length; i++) out[i] = Math.hypot(re[i], im[i])
  return out
}
