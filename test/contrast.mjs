/**
 * Contrast audit.
 *
 * The palette is read out of src/styles.css rather than restated here. A second
 * copy of the tokens is a copy that goes stale the first time one of them moves,
 * and this file exists precisely to catch a token that moved.
 *
 * Every pair below occurs in the interface: a foreground token that lands on a
 * background token somewhere in the stylesheet or on a canvas. Adding a token is
 * not enough; where it lands has to be added here too.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const css = readFileSync(join(root, 'src/styles.css'), 'utf8')

// The token blocks contain no nested braces, so the first `}` closes them.
const blocks = [...css.matchAll(/:root\s*\{([^}]*)\}/g)].map((m) => m[1])
if (blocks.length !== 2) {
  console.error(`expected a light and a dark :root block in styles.css, found ${blocks.length}`)
  process.exit(1)
}
const declarations = (block) =>
  Object.fromEntries([...block.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)].map(([, k, v]) => [k, v.trim()]))

const LIGHT = declarations(blocks[0])
const DARK = { ...LIGHT, ...declarations(blocks[1]) } // dark overrides, it does not replace

/* --- WCAG 2.1 relative luminance ------------------------------------------ */

const lin = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4) }
const luminance = (hex) => {
  const m = /^#([0-9a-f]{6})$/i.exec(hex)
  if (!m) throw new Error(`not a six-digit hex colour: ${hex}`)
  const n = parseInt(m[1], 16)
  return 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255)
}
const contrast = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

/* --- what has to clear what ----------------------------------------------- */

const TEXT = 4.5  // WCAG 1.4.3 AA, text below 24px — which is nearly all of it
const LARGE = 3.0 // WCAG 1.4.3 AA at 24px+, and 1.4.11 for a graphic that carries meaning
const RULE = 1.4  // house minimum: a hairline that has to stay visible but must not shout

/** [foreground, background, minimum, where it happens] */
const PAIRS = [
  ['--ink',           '--surface',        TEXT,  'body copy'],
  ['--ink',           '--surface-raised', TEXT,  'the calculator inputs'],
  ['--ink',           '--surface-sunk',   TEXT,  'the worst-band callout on the octave chart'],
  ['--ink-secondary', '--surface',        TEXT,  'the lede, table cells, absorber areas'],
  ['--ink-secondary', '--surface-raised', TEXT,  'the plot readout chip, the notice, the delta'],
  ['--ink-secondary', '--surface-sunk',   TEXT,  'canvas phase and value labels'],
  ['--ink-muted',     '--surface',        TEXT,  'captions, figure subtitles, metric labels'],
  ['--ink-muted',     '--surface-raised', TEXT,  'the prediction note'],
  ['--ink-muted',     '--surface-sunk',   TEXT,  'canvas axis labels'],
  ['--good',          '--surface',        TEXT,  'the verdict status line'],
  ['--good',          '--surface-raised', TEXT,  'a status inside a panel — the pair holds one line'],
  ['--critical',      '--surface',        TEXT,  'the verdict status line, the launch warning'],
  ['--critical',      '--surface-raised', TEXT,  'the notice icon'],
  ['--critical',      '--surface-sunk',   TEXT,  'the clipping label on the level meter'],
  ['--accent-text',   '--surface',        TEXT,  'prose links, the measured key'],
  ['--accent-text',   '--surface-raised', TEXT,  'prose links inside a panel'],
  ['--accent-ink',    '--accent',         TEXT,  'the primary button label'],
  ['--accent',        '--surface',        LARGE, 'the hero figure, focus rings, the ruler stem'],
  ['--accent',        '--surface-raised', LARGE, 'the predicted RT60 figure'],
  ['--accent',        '--surface-sunk',   LARGE, 'every measured mark on a plot'],
  ['--hairline-firm', '--surface',        RULE,  'the ruler baseline, the quiet button border'],
]

let failures = 0
for (const [mode, tokens] of [['LIGHT', LIGHT], ['DARK', DARK]]) {
  console.log(`\n${mode}`)
  for (const [fg, bg, need, where] of PAIRS) {
    for (const token of [fg, bg]) {
      if (!(token in tokens)) { console.error(`  MISSING ${token} in ${mode}`); process.exit(1) }
    }
    const r = contrast(tokens[fg], tokens[bg])
    const ok = r >= need
    if (!ok) failures++
    const pair = `${fg} on ${bg}`.padEnd(38)
    const gate = `(needs ${need.toFixed(1)})`
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${r.toFixed(2).padStart(5)}:1 ${gate}  ${pair}  ${where}`)
  }
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE${failures === 1 ? '' : 'S'} ABOVE`)
process.exit(failures === 0 ? 0 : 1)
