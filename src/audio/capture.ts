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
  const echoCancellation = s.echoCancellation !== false
  const noiseSuppression = s.noiseSuppression !== false
  const autoGainControl = s.autoGainControl !== false
  return {
    echoCancellation,
    noiseSuppression,
    autoGainControl,
    clean: !echoCancellation && !noiseSuppression && !autoGainControl,
    label: track?.label || 'Microphone',
  }
}

export async function measure(stream: MediaStream, opts: MeasureOptions = {}): Promise<Capture> {
  const leadIn = opts.leadIn ?? 0.5
  const tail = opts.tail ?? 2.5
  const duration = opts.duration ?? 4
  const gain = opts.gain ?? 0.6

  const ctx = new AudioContext()
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

  const done = new Promise<void>((resolve, reject) => {
    recorder.port.onmessage = (e: MessageEvent<{ chunk: Float32Array; peak: number }>) => {
      const { chunk, peak } = e.data
      const room = Math.min(chunk.length, totalSamples - written)
      if (room > 0) {
        recording.set(chunk.subarray(0, room), written)
        written += room
      }
      opts.onLevel?.(peak, written / sampleRate, totalSeconds)
      if (written >= totalSamples) resolve()
    }
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
    phaseTimers.forEach(clearTimeout)
    recorder.port.onmessage = null
    try { player.stop() } catch { /* already finished */ }
    source.disconnect()
    recorder.disconnect()
    mute.disconnect()
    await ctx.close()
  }

  return { recording, sampleRate, sweep, mic: readMicSettings(stream) }
}
