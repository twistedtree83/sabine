/** Shared canvas plumbing: device-pixel sizing, live theme tokens, animation. */

export interface Tokens {
  accent: string
  accentWash: string
  good: string
  critical: string
  ink: string
  inkSecondary: string
  inkMuted: string
  hairline: string
  hairlineFirm: string
  surface: string
  surfaceSunk: string
}

export function readTokens(el: HTMLElement = document.body): Tokens {
  const s = getComputedStyle(el)
  const v = (name: string) => s.getPropertyValue(name).trim()
  return {
    accent: v('--accent'),
    accentWash: v('--accent-wash'),
    good: v('--good'),
    critical: v('--critical'),
    ink: v('--ink'),
    inkSecondary: v('--ink-secondary'),
    inkMuted: v('--ink-muted'),
    hairline: v('--hairline'),
    hairlineFirm: v('--hairline-firm'),
    surface: v('--surface'),
    surfaceSunk: v('--surface-sunk'),
  }
}

export interface Frame {
  ctx: CanvasRenderingContext2D
  /** CSS-pixel dimensions of the drawing surface. */
  w: number
  h: number
  t: Tokens
}

export function prepare(canvas: HTMLCanvasElement): Frame | null {
  const rect = canvas.getBoundingClientRect()
  if (rect.width < 2 || rect.height < 2) return null
  const dpr = Math.min(window.devicePixelRatio || 1, 2)
  const w = Math.round(rect.width)
  const h = Math.round(rect.height)
  if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
    canvas.width = w * dpr
    canvas.height = h * dpr
  }
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, w, h)
  return { ctx, w, h, t: readTokens() }
}

export const prefersReducedMotion = () =>
  window.matchMedia('(prefers-reduced-motion: reduce)').matches

/**
 * Run `draw` with an eased 0..1 progress. Under reduced motion the final
 * frame is drawn once, immediately.
 */
export function animate(duration: number, draw: (p: number) => void): () => void {
  if (prefersReducedMotion()) {
    draw(1)
    return () => {}
  }
  let raf = 0
  let start = 0
  let finished = false

  const step = (now: number) => {
    if (finished) return
    if (!start) start = now
    const p = Math.min(1, (now - start) / duration)
    draw(1 - Math.pow(1 - p, 3))
    if (p < 1) raf = requestAnimationFrame(step)
    else finished = true
  }
  raf = requestAnimationFrame(step)

  // Animation frames do not run in a background tab, and a chart that never
  // reaches its last frame is a chart with missing data in it. Guarantee the
  // final state on a timer whatever the frame scheduler decides to do.
  const settle = window.setTimeout(() => {
    if (finished) return
    finished = true
    cancelAnimationFrame(raf)
    draw(1)
  }, duration + 250)

  return () => {
    finished = true
    cancelAnimationFrame(raf)
    clearTimeout(settle)
  }
}

/** Redraw on resize and on a light/dark switch, both debounced to a frame. */
export function onRedraw(canvas: HTMLCanvasElement, draw: () => void): () => void {
  let raf = 0
  const schedule = () => {
    cancelAnimationFrame(raf)
    raf = requestAnimationFrame(draw)
  }
  const ro = new ResizeObserver(schedule)
  ro.observe(canvas)
  const scheme = window.matchMedia('(prefers-color-scheme: dark)')
  scheme.addEventListener('change', schedule)
  return () => {
    cancelAnimationFrame(raf)
    ro.disconnect()
    scheme.removeEventListener('change', schedule)
  }
}

export function hairline(f: Frame, x1: number, y1: number, x2: number, y2: number, colour: string, dash?: number[]) {
  const { ctx } = f
  ctx.save()
  ctx.strokeStyle = colour
  ctx.lineWidth = 1
  if (dash) ctx.setLineDash(dash)
  ctx.beginPath()
  // Half-pixel offset keeps a 1px rule crisp.
  ctx.moveTo(Math.round(x1) + 0.5, Math.round(y1) + 0.5)
  ctx.lineTo(Math.round(x2) + 0.5, Math.round(y2) + 0.5)
  ctx.stroke()
  ctx.restore()
}

export function label(f: Frame, text: string, x: number, y: number, colour: string, align: CanvasTextAlign = 'left', size = 10) {
  const { ctx } = f
  ctx.save()
  ctx.fillStyle = colour
  ctx.font = `${size}px "Geist Mono Variable", ui-monospace, monospace`
  ctx.textAlign = align
  ctx.textBaseline = 'middle'
  ctx.fillText(text, x, y)
  ctx.restore()
}

/** A rectangle with rounded corners at the data end only, square at the baseline. */
export function dataBar(f: Frame, x: number, y: number, w: number, h: number, r: number) {
  const { ctx } = f
  const radius = Math.min(r, w / 2, h)
  ctx.beginPath()
  ctx.moveTo(x, y + h)
  ctx.lineTo(x, y + radius)
  ctx.quadraticCurveTo(x, y, x + radius, y)
  ctx.lineTo(x + w - radius, y)
  ctx.quadraticCurveTo(x + w, y, x + w, y + radius)
  ctx.lineTo(x + w, y + h)
  ctx.closePath()
}
