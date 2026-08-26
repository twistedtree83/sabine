import { prepare, hairline, label, dataBar, type Frame } from './canvas'
import type { Spectrogram } from '../dsp/spectrogram'
import type { AnalysisResult, BandResult } from '../dsp/types'

const PAD = { top: 18, right: 16, bottom: 26, left: 40 }

function plotBox(f: Frame) {
  return {
    x: PAD.left,
    y: PAD.top,
    w: Math.max(1, f.w - PAD.left - PAD.right),
    h: Math.max(1, f.h - PAD.top - PAD.bottom),
  }
}

/* ---------------------------------------------------------------------------
   1. The sweep itself, as a spectrogram.

   One measure, so one hue: the accent at an opacity that rises with energy.
   A log frequency axis turns the exponential sweep into a straight line,
   which is the argument for using one.
--------------------------------------------------------------------------- */

export function drawSpectrogram(
  canvas: HTMLCanvasElement,
  sg: Spectrogram,
  progress = 1,
  accentOverride?: string,
) {
  const f = prepare(canvas)
  if (!f) return
  const b = plotBox(f)
  const { ctx, t } = f
  const accent = accentOverride ?? t.accent

  const logMin = Math.log(sg.fMin)
  const span = Math.log(sg.fMax) - logMin
  const yFor = (hz: number) => b.y + b.h - ((Math.log(hz) - logMin) / span) * b.h

  ctx.save()
  ctx.beginPath()
  ctx.rect(b.x, b.y, b.w, b.h)
  ctx.clip()

  const shown = Math.max(1, Math.ceil(sg.columns * progress))
  const cw = b.w / sg.columns + 0.6
  const rh = b.h / sg.rows + 0.6
  ctx.fillStyle = accent
  for (let c = 0; c < shown; c++) {
    const x = b.x + (c / sg.columns) * b.w
    for (let r = 0; r < sg.rows; r++) {
      const db = sg.data[c * sg.rows + r]
      if (db < -sg.floorDb) continue
      // Linear in decibels, so the ramp is monotone in perceived lightness.
      const a = 1 + db / sg.floorDb
      ctx.globalAlpha = a * a
      ctx.fillRect(x, b.y + b.h - ((r + 1) / sg.rows) * b.h, cw, rh)
    }
  }
  ctx.restore()

  for (const hz of [50, 100, 250, 500, 1000, 2500, 5000, 10000, 20000]) {
    if (hz < sg.fMin || hz > sg.fMax) continue
    const y = yFor(hz)
    hairline(f, b.x, y, b.x + b.w, y, t.hairline)
    label(f, hz >= 1000 ? `${hz / 1000}k` : `${hz}`, b.x - 8, y, t.inkMuted, 'right')
  }
  label(f, 'Hz', b.x - 8, b.y - 8, t.inkMuted, 'right')

  const step = sg.seconds <= 5 ? 1 : 2
  for (let s = 0; s <= sg.seconds + 1e-6; s += step) {
    const x = b.x + (s / sg.seconds) * b.w
    label(f, `${s}`, x, b.y + b.h + 12, t.inkMuted, s === 0 ? 'left' : 'center')
  }
  label(f, 's', b.x + b.w, b.y + b.h + 12, t.inkMuted, 'right')

  hairline(f, b.x, b.y + b.h, b.x + b.w, b.y + b.h, t.hairlineFirm)
}

/* ---------------------------------------------------------------------------
   2. Live input while the sweep plays.
--------------------------------------------------------------------------- */

export function drawLevel(canvas: HTMLCanvasElement, history: number[], progress: number, phase: string) {
  const f = prepare(canvas)
  if (!f) return
  const b = plotBox(f)
  const { ctx, t } = f

  hairline(f, b.x, b.y + b.h, b.x + b.w, b.y + b.h, t.hairlineFirm)
  // Clipping is the one failure mode a user can fix in the moment.
  const clipY = b.y + b.h * 0.06
  hairline(f, b.x, clipY, b.x + b.w, clipY, t.critical, [3, 3])
  label(f, 'clipping', b.x + b.w - 4, clipY - 8, t.critical, 'right')

  const columns = Math.max(1, Math.round(b.w))
  ctx.save()
  ctx.fillStyle = t.accent
  for (let c = 0; c < history.length && c < columns; c++) {
    const v = Math.min(1, history[c])
    const h = Math.max(1, v * b.h)
    ctx.globalAlpha = v > 0.94 ? 1 : 0.85
    ctx.fillStyle = v > 0.94 ? t.critical : t.accent
    ctx.fillRect(b.x + c, b.y + b.h - h, 1, h)
  }
  ctx.restore()

  const x = b.x + progress * b.w
  hairline(f, x, b.y, x, b.y + b.h, t.inkMuted)
  label(f, phase, b.x + 4, b.y + 8, t.inkSecondary, 'left', 11)
}

/* ---------------------------------------------------------------------------
   3. The impulse response, in decibels.

   On a linear amplitude axis the direct sound is a spike an order of
   magnitude taller than everything after it, and the decay that actually
   matters is squashed into the bottom tenth of the plot. Acoustics has
   always drawn this in decibels for that reason. Each column is a stem from
   the floor up to the level at that instant, so a discrete reflection reads
   as a spike standing clear of the decay behind it.

   One series, so no legend: the title says what is plotted.
--------------------------------------------------------------------------- */

const IR_FLOOR_DB = -45

export function drawImpulse(
  canvas: HTMLCanvasElement,
  ir: Float32Array,
  seconds: number,
  progress = 1,
) {
  const f = prepare(canvas)
  if (!f) return
  const b = plotBox(f)
  const { ctx, t } = f

  let peak = 0
  for (let i = 0; i < ir.length; i++) if (ir[i] > peak) peak = ir[i]
  if (peak <= 0) peak = 1

  const yFor = (db: number) => b.y + (db / IR_FLOOR_DB) * b.h
  for (const db of [0, -10, -20, -30, -40]) {
    const y = yFor(db)
    hairline(f, b.x, y, b.x + b.w, y, t.hairline)
    label(f, `${db}`, b.x - 8, y, t.inkMuted, 'right')
  }
  label(f, 'dB', b.x - 8, b.y - 8, t.inkMuted, 'right')

  const msTicks = [0, 25, 50, 100, 150, 200, 250, 300].filter((ms) => ms / 1000 <= seconds)
  for (const ms of msTicks) {
    const x = b.x + (ms / 1000 / seconds) * b.w
    label(f, `${ms}`, x, b.y + b.h + 12, t.inkMuted, ms === 0 ? 'left' : 'center')
  }
  label(f, 'ms', b.x + b.w, b.y + b.h + 12, t.inkMuted, 'right')

  const floorY = b.y + b.h
  const shown = Math.floor(ir.length * progress)

  ctx.save()
  ctx.strokeStyle = t.accent
  ctx.lineWidth = 1
  ctx.globalAlpha = 0.85
  ctx.beginPath()
  for (let i = 0; i < shown; i++) {
    const db = 20 * Math.log10(Math.max(ir[i], 1e-9) / peak)
    if (db < IR_FLOOR_DB) continue
    const x = Math.round(b.x + (i / (ir.length - 1)) * b.w) + 0.5
    ctx.moveTo(x, floorY)
    ctx.lineTo(x, yFor(db))
  }
  ctx.stroke()
  ctx.restore()

  hairline(f, b.x, floorY, b.x + b.w, floorY, t.hairlineFirm)

}

/* ---------------------------------------------------------------------------
   4. The Schroeder decay curve, with the fitted slope over it.
--------------------------------------------------------------------------- */

export function drawDecay(canvas: HTMLCanvasElement, r: AnalysisResult, progress = 1) {
  const f = prepare(canvas)
  if (!f) return
  const b = plotBox(f)
  const { ctx, t } = f

  const seconds = Math.max(0.25, Math.min(r.decayPreviewSeconds, 2.5))
  const floorDb = -65
  const yFor = (db: number) => b.y + (db / floorDb) * b.h
  const xFor = (s: number) => b.x + (s / seconds) * b.w

  for (const db of [0, -10, -20, -30, -40, -50, -60]) {
    const y = yFor(db)
    hairline(f, b.x, y, b.x + b.w, y, t.hairline)
    label(f, `${db}`, b.x - 8, y, t.inkMuted, 'right')
  }
  label(f, 'dB', b.x - 8, b.y - 8, t.inkMuted, 'right')

  const step = Math.max(0.25, seconds / 5)
  for (let s = 0; s <= seconds + 1e-6; s += step) {
    const x = xFor(s)
    label(f, `${s.toFixed(2)}`, x, b.y + b.h + 12, t.inkMuted, s === 0 ? 'left' : 'center')
  }
  label(f, 's', b.x + b.w, b.y + b.h + 12, t.inkMuted, 'right')

  const curve = r.decayPreview
  const shown = Math.max(2, Math.floor(curve.length * progress))
  ctx.save()
  ctx.strokeStyle = t.accent
  ctx.lineWidth = 2
  ctx.lineJoin = 'round'
  ctx.lineCap = 'round'
  ctx.beginPath()
  for (let i = 0; i < shown; i++) {
    const s = (i / (curve.length - 1)) * r.decayPreviewSeconds
    if (s > seconds) break
    const x = xFor(s)
    const y = yFor(Math.max(floorDb, curve[i]))
    if (i === 0) ctx.moveTo(x, y)
    else ctx.lineTo(x, y)
  }
  ctx.stroke()
  ctx.restore()

  const fit = r.fitLine
  if (fit && progress > 0.6) {
    ctx.save()
    ctx.globalAlpha = Math.min(1, (progress - 0.6) / 0.4)
    ctx.strokeStyle = t.inkSecondary
    ctx.lineWidth = 1.5
    ctx.setLineDash([5, 4])
    ctx.beginPath()
    ctx.moveTo(xFor(fit.fromSec), yFor(fit.fromDb))
    // Extend the fitted line the full 60 dB, which is what the number means.
    const slope = (fit.toDb - fit.fromDb) / Math.max(1e-6, fit.toSec - fit.fromSec)
    const endSec = fit.fromSec + (floorDb - fit.fromDb) / slope
    ctx.lineTo(xFor(Math.min(endSec, seconds)), yFor(Math.max(floorDb, fit.fromDb + slope * (Math.min(endSec, seconds) - fit.fromSec))))
    ctx.stroke()
    ctx.restore()
  }
}

/* ---------------------------------------------------------------------------
   5. Octave bands against the schools limit.

   One series, one colour: the bars are ordered categories, and shading them
   by value would encode the bar length twice. The limit is an annotation,
   not a series, so it is a dashed rule with a word on it.
--------------------------------------------------------------------------- */

export interface BandChartOptions {
  limit?: number
  limitLabel?: string
}

export function drawBands(
  canvas: HTMLCanvasElement,
  bands: BandResult[],
  opts: BandChartOptions = {},
  progress = 1,
  hovered = -1,
) {
  const f = prepare(canvas)
  if (!f) return
  const b = { ...plotBox(f), bottom: 0 }
  b.bottom = b.y + b.h
  const { ctx, t } = f

  const values = bands.map((x) => (Number.isFinite(x.rt60) ? x.rt60 : 0))
  const limit = opts.limit ?? 0.8
  const top = Math.max(1.2, Math.ceil(Math.max(...values, limit) * 4) / 4 + 0.15)
  const yFor = (v: number) => b.bottom - (v / top) * b.h

  const gridStep = top > 2 ? 0.5 : 0.25
  for (let v = 0; v <= top + 1e-6; v += gridStep) {
    const y = yFor(v)
    hairline(f, b.x, y, b.x + b.w, y, t.hairline)
    label(f, v.toFixed(2), b.x - 8, y, t.inkMuted, 'right')
  }
  label(f, 's', b.x - 8, b.y - 8, t.inkMuted, 'right')

  const slot = b.w / bands.length
  // Cap the bar and leave the rest of the slot as air; a 2px gap in the
  // surface colour is what separates neighbours, never a stroke.
  const barW = Math.max(6, Math.min(24, slot - 12))

  bands.forEach((band, i) => {
    const cx = b.x + slot * (i + 0.5)
    const x = cx - barW / 2
    const v = Number.isFinite(band.rt60) ? band.rt60 * progress : 0
    const y = yFor(v)
    const h = b.bottom - y

    ctx.save()
    if (!band.valid) {
      ctx.globalAlpha = 0.28
    } else if (hovered >= 0 && hovered !== i) {
      ctx.globalAlpha = 0.45
    }
    ctx.fillStyle = t.accent
    if (h > 0.5) {
      dataBar(f, x, y, barW, h, 4)
      ctx.fill()
    }
    ctx.restore()

    label(f, band.centre >= 1000 ? `${band.centre / 1000}k` : `${band.centre}`, cx, b.bottom + 12, t.inkMuted, 'center')
  })

  // Direct-label only the extreme: the worst band is the one that matters.
  let worst = -1
  bands.forEach((band, i) => {
    if (!band.valid) return
    if (worst < 0 || band.rt60 > bands[worst].rt60) worst = i
  })
  if (worst >= 0 && progress > 0.75) {
    const cx = b.x + slot * (worst + 0.5)
    const y = yFor(bands[worst].rt60 * progress)
    ctx.save()
    ctx.globalAlpha = Math.min(1, (progress - 0.75) / 0.25)
    label(f, `${bands[worst].rt60.toFixed(2)} s`, cx, y - 10, t.ink, 'center', 11)
    ctx.restore()
  }

  if (limit > 0 && limit < top) {
    const y = yFor(limit)
    hairline(f, b.x, y, b.x + b.w, y, t.hairlineFirm, [5, 4])
    const text = opts.limitLabel ?? `limit ${limit.toFixed(2)} s`
    ctx.save()
    ctx.font = '10px "Geist Mono Variable", ui-monospace, monospace'
    const width = ctx.measureText(text).width + 8
    ctx.fillStyle = t.surfaceSunk
    ctx.fillRect(b.x + b.w - width, y - 7, width, 14)
    ctx.restore()
    label(f, text, b.x + b.w - 4, y, t.inkSecondary, 'right')
  }

  label(f, 'Hz', b.x + b.w, b.bottom + 12, t.inkMuted, 'right')
}

/** Which bar, if any, the pointer is over. */
export function bandAtPointer(canvas: HTMLCanvasElement, clientX: number, count: number): number {
  const rect = canvas.getBoundingClientRect()
  const x = clientX - rect.left
  const box = { x: PAD.left, w: rect.width - PAD.left - PAD.right }
  if (x < box.x || x > box.x + box.w) return -1
  const i = Math.floor(((x - box.x) / box.w) * count)
  return i >= 0 && i < count ? i : -1
}

/** Time in seconds at a pointer position, for the crosshair readouts. */
export function timeAtPointer(canvas: HTMLCanvasElement, clientX: number, seconds: number): number | null {
  const rect = canvas.getBoundingClientRect()
  const x = clientX - rect.left
  const box = { x: PAD.left, w: rect.width - PAD.left - PAD.right }
  if (x < box.x || x > box.x + box.w) return null
  return ((x - box.x) / box.w) * seconds
}
