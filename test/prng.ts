/**
 * One deterministic generator for the whole suite, so a failure is reproducible
 * and the noise is actually noise.
 *
 * The LCG this replaces multiplied a 31-bit seed by 1103515245, landing around
 * 2^61 - past the 53 bits a double carries exactly - so its low bits were
 * rounding error rather than state and the sequence collapsed into a cycle of
 * 10,466 samples. At 48 kHz that is a 218 ms period: a repeating tone, partly
 * coherent with the sweep, which is the one thing a noise-floor estimator finds
 * easy. The estimator is what most of these tests exist to exercise.
 */

export interface Random {
  (): number
  /** The generator's internal state. Exposed for assertNotPeriodic below. */
  state(): number
}

/** mulberry32: stays inside exact 32-bit integer arithmetic via imul. */
export function makeRandom(seed: number): Random {
  let s = seed >>> 0
  const next = () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  return Object.assign(next, { state: () => s }) as Random
}

/** Signed noise in -1..1. */
export function makeNoise(seed: number): () => number {
  const r = makeRandom(seed)
  return () => r() * 2 - 1
}

/**
 * The generator has to outlast the longest recording, or the noise is periodic
 * and every test is easier than the room. Checked rather than assumed, because
 * the failure it guards against is silent: the numbers still look like noise.
 *
 * It watches the internal state rather than the output, for two reasons. A
 * repeated *value* means nothing - outputs are 32-bit, so by the birthday bound
 * two collide with about even odds after 77,000 draws whatever the generator
 * does, and a guard written that way fails on a perfectly good one. And
 * watching for the opening sequence to recur is not enough either: the LCG this
 * replaced runs a tail into its cycle rather than round a ring, so its start
 * state never comes back and a guard anchored there sees nothing at all. The
 * state repeating anywhere is what a period actually is.
 */
export function assertNotPeriodic(seed: number, samples: number, sampleRate: number) {
  const r = makeRandom(seed)
  const seen = new Map<number, number>()
  for (let i = 0; i < samples; i++) {
    const s = r.state()
    const before = seen.get(s)
    if (before !== undefined) {
      const period = i - before
      console.log(
        `PRNG repeats every ${period} samples (${((period / sampleRate) * 1000).toFixed(0)} ms) - noise is not broadband`,
      )
      process.exit(1)
    }
    seen.set(s, i)
    r()
  }
}
