import './styles.css'

import microphoneIcon from '@phosphor-icons/core/assets/regular/microphone.svg?raw'
import checkIcon from '@phosphor-icons/core/assets/regular/check-circle.svg?raw'
import warningIcon from '@phosphor-icons/core/assets/regular/warning.svg?raw'
import infoIcon from '@phosphor-icons/core/assets/regular/info.svg?raw'
import redoIcon from '@phosphor-icons/core/assets/regular/arrow-clockwise.svg?raw'

import { makeSweep } from './dsp/sweep'
import { spectrogram } from './dsp/spectrogram'
import { OCTAVE_CENTRES } from './dsp/bands'
import { measure, requestMicrophone, MicrophoneError, type Capture } from './audio/capture'
import type { AnalysisResult } from './dsp/types'
import {
  drawSpectrogram, drawLevel, drawImpulse, drawDecay, drawBands,
  bandAtPointer, timeAtPointer,
} from './ui/plots'
import { animate, onRedraw, prepare, prefersReducedMotion, hairline, label, dataBar } from './ui/canvas'
import {
  TREATMENTS, BB93, predict, verdict, volume, absorptionFromRt,
  BAND_LABELS, type BandValues, type RoomDims,
} from './sabine'

/* --- tiny helpers -------------------------------------------------------- */

const $ = <T extends HTMLElement>(id: string) => {
  const el = document.getElementById(id)
  if (!el) throw new Error(`missing #${id}`)
  return el as T
}

const ICONS: Record<string, string> = {
  microphone: microphoneIcon,
  check: checkIcon,
  warning: warningIcon,
  info: infoIcon,
  redo: redoIcon,
}

function setIcon(host: Element, name: keyof typeof ICONS | string) {
  host.innerHTML = ICONS[name] ?? ICONS.info
}

document.querySelectorAll<HTMLElement>('[data-icon]').forEach((el) => setIcon(el, el.dataset.icon!))

const fmt = (v: number, digits = 2) => (Number.isFinite(v) ? v.toFixed(digits) : '—')

/* --- elements ------------------------------------------------------------ */

const els = {
  measure: $<HTMLButtonElement>('measure'),
  measureLabel: $('measureLabel'),
  measureIcon: document.querySelector<HTMLElement>('#measure .ico')!,
  help: $('help'),
  figureTitle: $('figureTitle'),
  figureSub: $('figureSub'),
  stageCanvas: $<HTMLCanvasElement>('stageCanvas'),
  results: $('results'),
  notice: $('notice'),
  noticeText: $('noticeText'),
  rtValue: $('rtValue'),
  rtCaption: $('rtCaption'),
  verdict: $('verdict'),
  verdictText: $('verdictText'),
  verdictIcon: document.querySelector<HTMLElement>('#verdict .ico')!,
  metrics: $('metrics'),
  irCanvas: $<HTMLCanvasElement>('irCanvas'),
  irReadout: $('irReadout'),
  decayCanvas: $<HTMLCanvasElement>('decayCanvas'),
  decayReadout: $('decayReadout'),
  bandCanvas: $<HTMLCanvasElement>('bandCanvas'),
  bandReadout: $('bandReadout'),
  reflectionsFigure: $('reflectionsFigure'),
  ruler: $('ruler'),
  rulerEnd: $('rulerEnd'),
  bandTable: $('bandTable'),
  calc: $('calc'),
  absorbers: $('absorbers'),
  predValue: $('predValue'),
  predDelta: $('predDelta'),
  predVerdict: $('predVerdict'),
  predVerdictText: $('predVerdictText'),
  predVerdictIcon: document.querySelector<HTMLElement>('#predVerdict .ico')!,
  predCanvas: $<HTMLCanvasElement>('predCanvas'),
  predNote: $('predNote'),
  dimL: $<HTMLInputElement>('dimL'),
  dimW: $<HTMLInputElement>('dimW'),
  dimH: $<HTMLInputElement>('dimH'),
}

/* --- state --------------------------------------------------------------- */

type State = 'idle' | 'measuring' | 'analysing' | 'done' | 'error'
let state: State = 'idle'
let stream: MediaStream | null = null
let latest: AnalysisResult | null = null

/* --- idle: draw the sweep the instrument is about to play ---------------- */

const PREVIEW = makeSweep({ f1: 45, f2: 20000, duration: 4, sampleRate: 48000 })
const PREVIEW_SG = spectrogram(PREVIEW.signal, 48000, { columns: 560, rows: 200, fMin: 45 })

let drawStage: () => void = () => drawSpectrogram(els.stageCanvas, PREVIEW_SG, 1)
onRedraw(els.stageCanvas, () => drawStage())

// Drawing it left to right in time is the explanation: the ridge climbs at a
// constant slope on a log axis, which is what "equal time in every octave"
// means and why a sweep is the right signal.
animate(1500, (p) => {
  if (state === 'idle') drawSpectrogram(els.stageCanvas, PREVIEW_SG, p)
})

function setHelp(text: string, tone: 'normal' | 'warn' = 'normal') {
  els.help.textContent = text
  els.help.dataset.tone = tone === 'warn' ? 'warn' : ''
}

// A disabled element cannot hold focus, so disabling the button while it is
// focused makes the browser drop focus to <body>. A keyboard user who pressed
// Enter to measure would find their next Tab starting again from the skip link.
// Remember that it happened, and give focus back when the button returns.
let buttonHadFocus = false

function setButton(label: string, icon: string, disabled: boolean) {
  if (disabled && document.activeElement === els.measure) buttonHadFocus = true
  els.measureLabel.textContent = label
  setIcon(els.measureIcon, icon)
  els.measure.disabled = disabled
  if (!disabled && buttonHadFocus) {
    els.measure.focus()
    buttonHadFocus = false
  }
}

/**
 * Let the microphone go. Nothing needs it between measurements — run()
 * re-requests whenever the stream is missing or inactive, and permission is
 * remembered — and holding it keeps the browser's recording indicator lit and
 * the device open for the life of the tab, on a page that says nothing leaves
 * this device.
 */
function releaseMicrophone() {
  stream?.getTracks().forEach((t) => t.stop())
  stream = null
}

/* --- measuring ----------------------------------------------------------- */

els.measure.addEventListener('click', () => void run())

async function run() {
  if (state === 'measuring' || state === 'analysing') return

  // Claim the state machine before the first await, not after it. The guard
  // above used to sit on one side of `await requestMicrophone()` and the
  // assignment on the other, so two clicks inside that window both passed:
  // where permission is already remembered there is no prompt to swallow the
  // second click, only the tens of milliseconds it takes to open the device.
  // Both runs then opened their own AudioContext and played their own sweep
  // into the same room, and each recording contained both.
  state = 'measuring'
  setButton('Measuring', 'microphone', true)

  try {
    if (!stream || !stream.active) stream = await requestMicrophone()
  } catch (err) {
    state = 'error'
    const kind = err instanceof MicrophoneError ? err.kind : 'missing'
    setHelp(
      kind === 'denied'
        ? 'Microphone permission was declined. Allow it in the address bar, then try again.'
        : kind === 'insecure'
          ? 'The microphone needs a secure connection. Open this page over HTTPS or on localhost.'
          : 'No microphone was available to this browser.',
      'warn',
    )
    releaseMicrophone()
    setButton('Try again', 'redo', false)
    return
  }

  setHelp('Stay quiet. The room is being played to and listened to at the same time.')
  els.figureTitle.textContent = 'Listening'
  els.figureSub.textContent = 'Live microphone level'

  const history: number[] = []
  const phases: Record<string, string> = {
    listening: 'measuring the noise floor',
    sweeping: 'sweeping 45 Hz to 20 kHz',
    tail: 'listening to the tail',
  }
  let phase = phases.listening
  let progress = 0

  drawStage = () => drawLevel(els.stageCanvas, history, progress, phase)

  let capture: Capture
  try {
    capture = await measure(stream, {
      onLevel: (peak, elapsed, total) => {
        history.push(peak)
        progress = elapsed / total
        drawStage()
      },
      onPhase: (p) => {
        phase = phases[p]
        drawStage()
      },
    })
  } catch (err) {
    state = 'error'
    releaseMicrophone()
    setHelp(`The recording did not finish: ${err instanceof Error ? err.message : String(err)}`, 'warn')
    setButton('Try again', 'redo', false)
    resetStage()
    return
  }

  // The recording is in hand; the device is not needed again until the next
  // measurement asks for it.
  releaseMicrophone()

  state = 'analysing'
  setHelp('Deconvolving. This takes a moment.')
  els.figureTitle.textContent = 'Deconvolving'
  els.figureSub.textContent = 'Collapsing the sweep back into a single impulse'

  try {
    latest = await analyseInWorker(capture)
  } catch (err) {
    state = 'error'
    setHelp(`The analysis failed: ${err instanceof Error ? err.message : String(err)}`, 'warn')
    setButton('Try again', 'redo', false)
    resetStage()
    return
  }

  state = 'done'
  showResults(latest, capture)
}

/**
 * Everything that happens once a measurement exists. The dev hook below uses it
 * too, so the completion path it exercises is the real one rather than a
 * simplified copy that can drift away from it.
 */
function showResults(result: AnalysisResult, capture: Capture) {
  render(result, capture)
  resetStage()
  setButton('Measure again', 'redo', false)
  setHelp('Move the laptop and measure again. Two positions that disagree are telling you about the room.')

  // The results are unhidden rather than navigated to, so without this a screen
  // reader is told nothing: not that a measurement exists, and not that a
  // warning above it says the numbers cannot be trusted. Moving focus to the
  // region says both, and puts the next Tab inside the results rather than back
  // at the top of the document.
  els.results.focus({ preventScroll: true })
  buttonHadFocus = false
  els.results.scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'start' })
}

function resetStage() {
  els.figureTitle.textContent = 'The sweep'
  els.figureSub.textContent = '45 Hz to 20 kHz, equal time in every octave'
  drawStage = () => drawSpectrogram(els.stageCanvas, PREVIEW_SG, 1)
  drawStage()
}

function analyseInWorker(capture: Capture): Promise<AnalysisResult> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./dsp/worker.ts', import.meta.url), { type: 'module' })
    worker.onmessage = (e: MessageEvent<{ ok: boolean; result?: AnalysisResult; error?: string }>) => {
      worker.terminate()
      if (e.data.ok && e.data.result) resolve(e.data.result)
      else reject(new Error(e.data.error ?? 'unknown error'))
    }
    worker.onerror = (e) => {
      worker.terminate()
      reject(new Error(e.message || 'worker failed'))
    }
    worker.postMessage({
      recording: capture.recording,
      inverse: capture.sweep.inverse,
      sampleRate: capture.sampleRate,
    })
  })
}

/* --- rendering the result ------------------------------------------------ */

function render(r: AnalysisResult, capture: Capture) {
  els.results.hidden = false
  els.calc.hidden = false

  const warnings: string[] = []
  const on = [
    capture.mic.echoCancellation && 'echo cancellation',
    capture.mic.noiseSuppression && 'noise suppression',
    capture.mic.autoGainControl && 'automatic gain control',
  ].filter(Boolean) as string[]
  if (on.length) {
    warnings.push(
      `This browser kept ${listOf(on)} switched on for the microphone despite being asked not to. ` +
        `Echo cancellation in particular removes the sound of your own speaker returning through the room, ` +
        `which is the entire signal. Treat these numbers as indicative.`,
    )
  } else if (!capture.mic.reported) {
    // Not the same thing as the browser having honoured the request, and saying
    // so would be inventing a fact the API never gave us.
    warnings.push(
      `This browser does not report whether it applied echo cancellation, noise suppression or automatic ` +
        `gain control, so there is no way to confirm it left them off as asked. If the decay looks ` +
        `impossibly short, that is the likeliest reason.`,
    )
  }
  if (r.tooQuiet) {
    warnings.push(
      `The direct sound was only ${fmt(r.snrDb, 0)} dB above the noise floor. Turn the volume up, ` +
        `move the laptop away from a fan, and measure again.`,
    )
  }
  if (!r.broadband.valid) {
    warnings.push('No decay range sat far enough above the noise to fit a slope. The numbers below are unreliable.')
  }
  els.notice.hidden = warnings.length === 0
  els.noticeText.textContent = warnings.join(' ')

  // Headline: the mid-frequency average is the number every standard quotes.
  const midBands = [2, 3, 4].map((i) => r.bands[i]).filter((b) => b.valid && Number.isFinite(b.rt60))
  const mid = midBands.length ? midBands.reduce((a, b) => a + b.rt60, 0) / midBands.length : r.broadband.rt60

  els.rtValue.textContent = fmt(mid)
  els.rtCaption.textContent = midBands.length
    ? `Reverberation time, averaged over 500 Hz, 1 kHz and 2 kHz, from a ${r.broadband.label ?? 'partial'} fit.`
    : 'Reverberation time, broadband. Too little decay was measurable to average the speech bands.'

  const v = verdict(mid, BB93.general)
  els.verdict.dataset.state = v
  setIcon(els.verdictIcon, v === 'good' ? 'check' : v === 'bad' ? 'warning' : 'info')
  els.verdictText.textContent =
    v === 'good'
      ? `Within the 0.80 s limit for a general teaching space`
      : v === 'bad'
        ? `Over the 0.80 s limit for a general teaching space`
        : 'Not enough decay to judge'

  els.metrics.innerHTML = ''
  metric('Speech clarity', `${fmt(r.c50, 1)} dB`, c50Note(r.c50))
  metric('Early energy', `${fmt(r.d50, 0)}%`, 'arrives in the first 50 ms')
  metric('Signal to noise', Number.isFinite(r.snrDb) ? `${fmt(r.snrDb, 0)} dB` : 'clean', 'direct sound over the room noise')
  metric('Fit quality', fmt(r.broadband.r2, 3), `r² of the ${r.broadband.label ?? 'decay'} slope`)

  animate(900, (p) => drawImpulse(els.irCanvas, r.irPreview, r.irPreviewSeconds, p))
  animate(1100, (p) => drawDecay(els.decayCanvas, r, p))
  animate(900, (p) => drawBands(els.bandCanvas, r.bands, { limit: BB93.general, limitLabel: 'BB93 0.80 s' }, p, hoveredBand))

  renderReflections(r)
  renderTable(r)
  refreshPrediction()
}

function listOf(items: string[]): string {
  if (items.length <= 1) return items[0] ?? ''
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`
}

function c50Note(c50: number): string {
  if (!Number.isFinite(c50)) return 'not measurable'
  if (c50 >= 4) return 'speech is easy to follow'
  if (c50 >= 0) return 'workable, but tiring at the back'
  return 'consonants are being smeared'
}

function metric(labelText: string, value: string, note: string) {
  const el = document.createElement('div')
  el.className = 'metric'
  el.innerHTML =
    `<p class="metric__label"></p><p class="metric__value num"></p><p class="metric__note"></p>`
  el.querySelector('.metric__label')!.textContent = labelText
  el.querySelector('.metric__value')!.textContent = value
  el.querySelector('.metric__note')!.textContent = note
  els.metrics.append(el)
}

function renderReflections(r: AnalysisResult) {
  els.ruler.innerHTML = ''
  if (!r.reflections.length) {
    els.reflectionsFigure.hidden = true
    return
  }
  els.reflectionsFigure.hidden = false
  const maxDistance = Math.max(4, Math.ceil(Math.max(...r.reflections.map((x) => x.distance))))
  els.rulerEnd.textContent = `${maxDistance} m`

  for (const ref of r.reflections) {
    const tick = document.createElement('div')
    tick.className = 'ruler__tick'
    tick.style.left = `${(ref.distance / maxDistance) * 100}%`
    // Height carries level, mapped across the range these arrivals actually
    // occupy: -45 dB down to the direct sound.
    const strength = Math.max(0.18, Math.min(1, 1 + ref.levelDb / 45))
    tick.innerHTML =
      `<span class="ruler__meta num"></span><span class="ruler__dist num"></span><span class="ruler__stem"></span>`
    tick.querySelector('.ruler__meta')!.textContent = `${fmt(ref.levelDb, 0)} dB`
    tick.querySelector('.ruler__dist')!.textContent = `${fmt(ref.distance, 1)} m`
    ;(tick.querySelector('.ruler__stem') as HTMLElement).style.height = `${12 + strength * 46}px`
    els.ruler.append(tick)
  }
}

function renderTable(r: AnalysisResult) {
  els.bandTable.innerHTML = ''
  r.bands.forEach((band, i) => {
    const tr = document.createElement('tr')
    const cells = [
      BAND_LABELS[i],
      band.valid ? `${fmt(band.rt60)} s` : 'not resolved',
      band.label ?? '—',
      band.valid ? fmt(band.r2, 3) : '—',
      `${fmt(band.headroomDb, 0)} dB`,
    ]
    for (const text of cells) {
      const td = document.createElement('td')
      td.textContent = text
      tr.append(td)
    }
    els.bandTable.append(tr)
  })
}

/* --- chart hover --------------------------------------------------------- */

let hoveredBand = -1

function readout(el: HTMLElement, text: string | null) {
  el.dataset.visible = text ? 'true' : 'false'
  if (text) el.textContent = text
}

els.bandCanvas.addEventListener('pointermove', (e) => {
  if (!latest) return
  const i = bandAtPointer(els.bandCanvas, e.clientX, latest.bands.length)
  if (i === hoveredBand) return
  hoveredBand = i
  const band = i >= 0 ? latest.bands[i] : null
  readout(els.bandReadout, band ? `${BAND_LABELS[i]}  ${band.valid ? `${fmt(band.rt60)} s` : 'not resolved'}` : null)
  drawBands(els.bandCanvas, latest.bands, { limit: BB93.general, limitLabel: 'BB93 0.80 s' }, 1, hoveredBand)
})
els.bandCanvas.addEventListener('pointerleave', () => {
  if (!latest) return
  hoveredBand = -1
  readout(els.bandReadout, null)
  drawBands(els.bandCanvas, latest.bands, { limit: BB93.general, limitLabel: 'BB93 0.80 s' }, 1, -1)
})

els.irCanvas.addEventListener('pointermove', (e) => {
  if (!latest) return
  const t = timeAtPointer(els.irCanvas, e.clientX, latest.irPreviewSeconds)
  readout(els.irReadout, t === null ? null : `${(t * 1000).toFixed(1)} ms  ·  ${((343 * t) / 2).toFixed(2)} m away`)
})
els.irCanvas.addEventListener('pointerleave', () => readout(els.irReadout, null))

els.decayCanvas.addEventListener('pointermove', (e) => {
  if (!latest) return
  const seconds = Math.max(0.25, Math.min(latest.decayPreviewSeconds, 2.5))
  const t = timeAtPointer(els.decayCanvas, e.clientX, seconds)
  if (t === null) return readout(els.decayReadout, null)
  const idx = Math.round((t / latest.decayPreviewSeconds) * (latest.decayPreview.length - 1))
  const db = latest.decayPreview[Math.max(0, Math.min(latest.decayPreview.length - 1, idx))]
  readout(els.decayReadout, `${t.toFixed(2)} s  ·  ${db.toFixed(1)} dB`)
})
els.decayCanvas.addEventListener('pointerleave', () => readout(els.decayReadout, null))

onRedraw(els.irCanvas, () => latest && drawImpulse(els.irCanvas, latest.irPreview, latest.irPreviewSeconds, 1))
onRedraw(els.decayCanvas, () => latest && drawDecay(els.decayCanvas, latest, 1))
onRedraw(els.bandCanvas, () => latest && drawBands(els.bandCanvas, latest.bands, { limit: BB93.general, limitLabel: 'BB93 0.80 s' }, 1, hoveredBand))

/* --- the Sabine calculator ----------------------------------------------- */

const chosen = new Set<string>()

for (const s of TREATMENTS) {
  const row = document.createElement('label')
  row.className = 'absorber'
  row.innerHTML =
    `<input type="checkbox" />` +
    `<span><span class="absorber__name"></span><br /><span class="absorber__detail"></span></span>` +
    `<span class="absorber__area num"></span>`
  const input = row.querySelector('input') as HTMLInputElement
  input.id = `abs-${s.id}`
  row.querySelector('.absorber__name')!.textContent = s.name
  row.querySelector('.absorber__detail')!.textContent = s.detail
  input.addEventListener('change', () => {
    if (input.checked) chosen.add(s.id)
    else chosen.delete(s.id)
    refreshPrediction()
  })
  row.dataset.id = s.id
  els.absorbers.append(row)
}

for (const input of [els.dimL, els.dimW, els.dimH]) {
  input.addEventListener('input', () => refreshPrediction())
}

function room(): RoomDims {
  const num = (el: HTMLInputElement, fallback: number) => {
    const v = parseFloat(el.value)
    return Number.isFinite(v) && v > 0 ? v : fallback
  }
  return { length: num(els.dimL, 9), width: num(els.dimW, 7), height: num(els.dimH, 2.9) }
}

function measuredBands(): BandValues {
  if (!latest) return [NaN, NaN, NaN, NaN, NaN, NaN]
  return latest.bands.map((b) => (b.valid ? b.rt60 : NaN)) as BandValues
}

function refreshPrediction() {
  const r = room()
  const v = volume(r)

  // Each row shows the area or headcount it is working with, so the estimate
  // is never a black box.
  for (const s of TREATMENTS) {
    const row = els.absorbers.querySelector<HTMLElement>(`[data-id="${s.id}"] .absorber__area`)
    if (!row) continue
    row.textContent = s.perUnit ? `${s.perUnit.count(r)} ${s.perUnit.unit}` : `${s.area(r).toFixed(0)} m²`
  }

  const picked = TREATMENTS.filter((s) => chosen.has(s.id))
  const p = predict(r, measuredBands(), picked)

  els.predValue.textContent = fmt(p.midFrequency)
  const predState = verdict(p.midFrequency, BB93.general)
  els.predVerdict.dataset.state = predState
  setIcon(els.predVerdictIcon, predState === 'good' ? 'check' : predState === 'bad' ? 'warning' : 'info')

  if (!p.calibrated) {
    els.predVerdictText.textContent = 'Measure the room first'
    els.predDelta.textContent = ''
    els.predNote.textContent =
      'The prediction needs a measurement to calibrate against. Without one there is no way to know what the room already absorbs.'
    drawPrediction(null)
    return
  }

  const change = p.baseline - p.midFrequency
  els.predDelta.textContent = picked.length
    ? `${change >= 0 ? 'down' : 'up'} ${fmt(Math.abs(change))} s from ${fmt(p.baseline)} s`
    : `as measured`
  els.predVerdictText.textContent =
    predState === 'good' ? 'Within the 0.80 s limit'
      : predState === 'bad' ? 'Still over the 0.80 s limit'
        : 'Not enough to judge'

  const a = absorptionFromRt(p.baseline, v)
  els.predNote.textContent = picked.length
    ? `A room of ${v.toFixed(0)} m³ ringing for ${fmt(p.baseline)} s holds about ${a.toFixed(0)} sabins of absorption. ` +
      `The selection adds roughly ${p.addedSabins.toFixed(0)} more.`
    : `A room of ${v.toFixed(0)} m³ ringing for ${fmt(p.baseline)} s holds about ${a.toFixed(0)} sabins of absorption. ` +
      `Tick something to see what it would change.`

  drawPrediction(p.bands)
}

/**
 * The prediction chart carries two states of one measure, so it is drawn as
 * paired bars rather than two colours: the measured value as a hairline
 * outline, the predicted value filled. One accent throughout.
 */
function drawPrediction(bands: BandValues | null) {
  const f = prepare(els.predCanvas)
  if (!f) return
  const { ctx, t } = f
  const pad = { top: 14, right: 10, bottom: 22, left: 34 }
  const box = { x: pad.left, y: pad.top, w: f.w - pad.left - pad.right, h: f.h - pad.top - pad.bottom }

  const measured = measuredBands()
  const all = [...(bands ?? []), ...measured].filter((x) => Number.isFinite(x))
  const top = Math.max(1.0, Math.ceil(Math.max(...all, BB93.general, 0.5) * 4) / 4 + 0.1)
  const yFor = (v: number) => box.y + box.h - (v / top) * box.h

  for (let v = 0; v <= top + 1e-6; v += top > 2 ? 0.5 : 0.25) {
    const y = yFor(v)
    hairline(f, box.x, y, box.x + box.w, y, t.hairline)
    label(f, v.toFixed(2), box.x - 6, y, t.inkMuted, 'right', 9)
  }

  const slot = box.w / OCTAVE_CENTRES.length
  const barW = Math.max(5, Math.min(20, slot - 10))

  OCTAVE_CENTRES.forEach((centre, i) => {
    const cx = box.x + slot * (i + 0.5)
    const x = cx - barW / 2

    const before = measured[i]
    if (Number.isFinite(before)) {
      ctx.save()
      ctx.strokeStyle = t.hairlineFirm
      ctx.lineWidth = 1
      const y = yFor(before)
      dataBar(f, x + 0.5, y + 0.5, barW - 1, box.y + box.h - y - 1, 3)
      ctx.stroke()
      ctx.restore()
    }

    const after = bands?.[i]
    if (Number.isFinite(after)) {
      ctx.save()
      ctx.fillStyle = t.accent
      const y = yFor(after!)
      dataBar(f, x, y, barW, box.y + box.h - y, 3)
      ctx.fill()
      ctx.restore()
    }

    label(f, centre >= 1000 ? `${centre / 1000}k` : `${centre}`, cx, box.y + box.h + 11, t.inkMuted, 'center', 9)
  })

  const y = yFor(BB93.general)
  if (BB93.general < top) hairline(f, box.x, y, box.x + box.w, y, t.hairlineFirm, [4, 3])
  label(f, 'Hz', box.x + box.w, box.y + box.h + 11, t.inkMuted, 'right', 9)
  label(f, 's', box.x - 6, box.y - 6, t.inkMuted, 'right', 9)
}

onRedraw(els.predCanvas, () => refreshPrediction())
refreshPrediction()

/* --- development only ----------------------------------------------------
   Push a room with a known reverberation time through the real pipeline, so
   the results layout can be worked on without a microphone. Stripped from
   production builds by the bundler.
-------------------------------------------------------------------------- */

if (import.meta.env.DEV) {
  ;(window as unknown as Record<string, unknown>).__demo = async (rt = 1.05) => {
    const { convolve } = await import('./dsp/fft')
    const fs = 48000
    const sweep = makeSweep({ f1: 45, f2: 20000, duration: 4, sampleRate: fs })
    let seed = 4242
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff * 2 - 1 }

    // A shoebox built by the image-source method, so the early reflections
    // are where real geometry would put them rather than where I put them.
    const L = [9, 7, 2.9]
    const P = [4.5, 3.5, 1.15]
    const alpha = 0.161 * (L[0] * L[1] * L[2]) / (2 * (L[0] * L[1] + L[0] * L[2] + L[1] * L[2]) * rt)
    const R = Math.sqrt(Math.max(0.02, 1 - alpha))
    const n = Math.round(Math.max(1.5, rt * 2.4) * fs)
    const room = new Float32Array(n)
    room[0] = 1 / 0.15
    for (let px = 0; px <= 1; px++) for (let py = 0; py <= 1; py++) for (let pz = 0; pz <= 1; pz++) {
      for (let mx = -5; mx <= 5; mx++) for (let my = -5; my <= 5; my++) for (let mz = -5; mz <= 5; mz++) {
        const b = Math.abs(mx - px) + Math.abs(mx) + Math.abs(my - py) + Math.abs(my) +
                  Math.abs(mz - pz) + Math.abs(mz)
        if (b === 0) continue
        const d = Math.hypot(
          (1 - 2 * px) * P[0] + 2 * mx * L[0] - P[0],
          (1 - 2 * py) * P[1] + 2 * my * L[1] - P[1],
          (1 - 2 * pz) * P[2] + 2 * mz * L[2] - P[2],
        )
        const k = Math.round((d / 343) * fs)
        if (d <= 0 || k >= n) continue
        room[k] += (Math.pow(R, b) / d) * (b % 2 === 0 ? 1 : -1)
      }
    }
    const lateStart = Math.round(0.05 * fs)
    let tailRef = 0
    for (let i = lateStart; i < lateStart + 500 && i < n; i++) tailRef = Math.max(tailRef, Math.abs(room[i]))
    for (let i = lateStart; i < n; i++) {
      room[i] += rnd() * tailRef * 0.8 * Math.exp((-(i - lateStart) / fs) * (Math.log(1000) / rt))
    }

    const wet = convolve(sweep.signal, room)
    const lead = Math.round(0.5 * fs)
    const rec = new Float32Array(lead + wet.length + Math.round(0.5 * fs))
    rec.set(wet, lead)
    let peak = 0
    for (const v of rec) peak = Math.max(peak, Math.abs(v))
    for (let i = 0; i < rec.length; i++) rec[i] += rnd() * peak * Math.pow(10, -52 / 20)

    const capture: Capture = {
      recording: rec,
      sampleRate: fs,
      sweep,
      mic: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, clean: true, reported: true, label: 'synthetic' },
    }
    latest = await analyseInWorker(capture)
    state = 'done'
    showResults(latest, capture)
    ;(window as unknown as Record<string, unknown>).__result = latest
    return latest.broadband.rt60
  }
}
