/**
 * Microphone capture and sweep playback.
 *
 * Two things here are load-bearing.
 *
 * First, the getUserMedia constraints. Browsers apply echo cancellation, noise
 * suppression and automatic gain control to microphone streams by default, and
 * all three would destroy this measurement: echo cancellation exists precisely
 * to remove the sound of your own speaker arriving back through the room, which
 * is the entire signal we are trying to record. They are switched off, and then
 * checked, because a browser is allowed to ignore the request.
 *
 * Second, absolute latency is never measured. The recording contains the direct
 * sound as well as the reflections, so the deconvolved impulse response carries
 * its own t = 0 in the direct arrival. Whatever the output and input pipelines
 * delay things by cancels out.
 */

import { makeSweep, type Sweep } from '../dsp/sweep'

const WORKLET_SOURCE = `
class SabineRecorder extends AudioWorkletProcessor {
  constructor() {
    super()
    this.buffer = new Float32Array(4096)
    this.filled = 0
  }
  process(inputs) {
    const input = inputs[0]
    const channel = input && input[0]
    if (!channel) return true
    for (let i = 0; i < channel.length; i++) {
      this.buffer[this.filled++] = channel[i]
      if (this.filled === this.buffer.length) {
        let peak = 0
        for (let k = 0; k < this.filled; k++) {
          const a = Math.abs(this.buffer[k])
          if (a > peak) peak = a
        }
        this.port.postMessage({ chunk: this.buffer.slice(), peak })
        this.filled = 0
      }
    }
    return true
  }
}
registerProcessor('sabine-recorder', SabineRecorder)
`

export interface MicSettings {
  echoCancellation: boolean
  noiseSuppression: boolean
  autoGainControl: boolean
  /** True when the browser honoured all three requests. */
  clean: boolean
  /**
   * False when the browser told us nothing about its own processing. Honoured
   * and unreported are indistinguishable through getSettings(), so the two
   * cases have to be said differently rather than guessed at.
   */
  reported: boolean
  label: string
}

export interface Capture {
  recording: Float32Array
  sampleRate: number
  sweep: Sweep
  mic: MicSettings
}

export interface MeasureOptions {
  /** Silence recorded before the sweep starts, seconds. Also the noise sample. */
  leadIn?: number
  /** Silence recorded after the sweep ends, seconds. Must exceed the room's RT60. */
  tail?: number
  duration?: number
  /** Playback gain, 0 to 1. */
  gain?: number
  onLevel?: (peak: number, elapsed: number, total: number) => void
  onPhase?: (phase: 'listening' | 'sweeping' | 'tail') => void
  signal?: AbortSignal
}

export class MicrophoneError extends Error {
  constructor(message: string, readonly kind: 'denied' | 'missing' | 'insecure' | 'unsupported') {
    super(message)
  }
}

export async function requestMicrophone(): Promise<MediaStream> {
  if (!window.isSecureContext) {
    throw new MicrophoneError('This page needs HTTPS to reach the microphone.', 'insecure')
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new MicrophoneError('This browser has no microphone API.', 'unsupported')
  }
  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: 1,
      },
      video: false,
    })
  } catch (err) {
    const name = err instanceof DOMException ? err.name : ''
    if (name === 'NotAllowedError' || name === 'SecurityError') {
      throw new MicrophoneError('Microphone permission was declined.', 'denied')
    }
    throw new MicrophoneError('No microphone was available.', 'missing')
  }
}

export function readMicSettings(stream: MediaStream): MicSettings {
  const track = stream.getAudioTracks()[0]
  const s = track?.getSettings() ?? {}

  // A browser is allowed to report none of these, and `undefined !== false` is
  // true — so reading them that way flagged every such browser as having kept
  // its processing on, on every measurement, and told the user a specific thing
  // that was not known to be so. Only an explicit `true` means on.
  const reported =
    s.echoCancellation !== undefined ||
    s.noiseSuppression !== undefined ||
    s.autoGainControl !== undefined
  const echoCancellation = s.echoCancellation === true
  const noiseSuppression = s.noiseSuppression === true
  const autoGainControl = s.autoGainControl === true

  return {
    echoCancellation,
    noiseSuppression,
    autoGainControl,
    // Only claim a clean stream when the browser actually confirmed one.
    clean: reported && !echoCancellation && !noiseSuppression && !autoGainControl,
    reported,
    label: track?.label || 'Microphone',
  }
}

export async function measure(stream: MediaStream, opts: MeasureOptions = {}): Promise<Capture> {
  const leadIn = opts.leadIn ?? 0.5
  const tail = opts.tail ?? 2.5
  const duration = opts.duration ?? 4
  const gain = opts.gain ?? 0.6

  const ctx = new AudioContext()

  // Everything from here on can throw, and an AudioContext that escapes without
  // being closed stays alive with the microphone still connected to it. The UI
  // offers "Try again", so each failure used to leak another one until the
  // per-document cap made `new AudioContext()` itself throw and only a reload
  // recovered. Whatever happens, the context is closed on the way out.
  try {
    return await record(ctx, stream, { leadIn, tail, duration, gain }, opts)
  } finally {
    if (ctx.state !== 'closed') await ctx.close().catch(() => {})
  }
}

interface Geometry { leadIn: number; tail: number; duration: number; gain: number }

async function record(
  ctx: AudioContext,
  stream: MediaStream,
  { leadIn, tail, duration, gain }: Geometry,
  opts: MeasureOptions,
): Promise<Capture> {
  await ctx.resume()

  const workletUrl = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: 'application/javascript' }))
  try {
    await ctx.audioWorklet.addModule(workletUrl)
  } finally {
    URL.revokeObjectURL(workletUrl)
  }

  const sampleRate = ctx.sampleRate
  // 20 Hz is below what any laptop speaker can move air at, and the extra
  // sweep time down there is time not spent measuring the speech bands.
  const sweep = makeSweep({ f1: 45, f2: Math.min(20000, sampleRate / 2 - 500), duration, sampleRate })

  const totalSeconds = leadIn + duration + tail
  const totalSamples = Math.ceil(totalSeconds * sampleRate)
  const recording = new Float32Array(totalSamples)
  let written = 0

  const source = ctx.createMediaStreamSource(stream)
  const recorder = new AudioWorkletNode(ctx, 'sabine-recorder')
  // A worklet with no output still needs a sink to be pulled by the graph.
  const mute = ctx.createGain()
  mute.gain.value = 0
  source.connect(recorder)
  recorder.connect(mute).connect(ctx.destination)

  // If the input stalls — an interrupted context on mobile after a phone call,
  // a device pulled mid-measurement — the worklet simply stops posting and
  // nothing ever settles this promise. That left the page stuck on "Measuring"
  // with its only button disabled, recoverable solely by reload. A silence this
  // long is a failure whatever caused it.
  const STALL_MS = 3000
  let stallTimer = 0

  const done = new Promise<void>((resolve, reject) => {
    const fail = (message: string) => reject(new Error(message))
    const restartStallTimer = () => {
      clearTimeout(stallTimer)
      stallTimer = window.setTimeout(
        () => fail('The microphone stopped sending audio. Check nothing else has taken it, then try again.'),
        STALL_MS,
      )
    }

    recorder.port.onmessage = (e: MessageEvent<{ chunk: Float32Array; peak: number }>) => {
      const { chunk, peak } = e.data
      const room = Math.min(chunk.length, totalSamples - written)
      if (room > 0) {
        recording.set(chunk.subarray(0, room), written)
        written += room
      }
      opts.onLevel?.(peak, written / sampleRate, totalSeconds)
      if (written >= totalSamples) resolve()
      else restartStallTimer()
    }
    restartStallTimer()
    opts.signal?.addEventListener('abort', () => reject(new DOMException('Cancelled', 'AbortError')), { once: true })
  })

  const buffer = ctx.createBuffer(1, sweep.signal.length, sampleRate)
  buffer.getChannelData(0).set(sweep.signal)
  const player = ctx.createBufferSource()
  player.buffer = buffer
  const out = ctx.createGain()
  out.gain.value = gain
  player.connect(out).connect(ctx.destination)

  const startAt = ctx.currentTime + leadIn
  player.start(startAt)
  opts.onPhase?.('listening')
  const phaseTimers = [
    window.setTimeout(() => opts.onPhase?.('sweeping'), leadIn * 1000),
    window.setTimeout(() => opts.onPhase?.('tail'), (leadIn + duration) * 1000),
  ]

  try {
    await done
  } finally {
    clearTimeout(stallTimer)
    phaseTimers.forEach(clearTimeout)
    recorder.port.onmessage = null
    try { player.stop() } catch { /* already finished */ }
    source.disconnect()
    recorder.disconnect()
    mute.disconnect()
  }

  return { recording, sampleRate, sweep, mic: readMicSettings(stream) }
}
