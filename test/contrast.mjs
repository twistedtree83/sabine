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

/**
 * Every rule block whose selector mentions :root, with the at-rule it sits in.
 *
 * Matching `:root {` with a regex and calling the second hit "dark" is how this
 * used to work, and it could not see a qualified selector such as
 * `:root[data-theme="dark"]` at all - a whole theme could sit in the stylesheet
 * unaudited while the run printed ALL PASS. So the blocks are found properly and
 * anything unaccounted for is an error rather than a silent skip.
 */
function rootBlocks(source) {
  const css = source.replace(/\/\*[\s\S]*?\*\//g, '') // comments can contain braces
  const out = []
  const atRules = []
  let prelude = ''
  let i = 0
  while (i < css.length) {
    const ch = css[i]
    if (ch === ';') { prelude = ''; i++; continue }       // @import and friends
    if (ch === '}') { atRules.pop(); prelude = ''; i++; continue }
    if (ch !== '{') { prelude += ch; i++; continue }

    const selector = prelude.trim()
    prelude = ''
    if (selector.startsWith('@')) { atRules.push(selector); i++; continue }

    let depth = 1
    let j = i + 1
    while (j < css.length && depth > 0) {
      if (css[j] === '{') depth++
      else if (css[j] === '}') depth--
      j++
    }
    if (selector.includes(':root')) {
      out.push({ selector, at: atRules.join(' '), body: css.slice(i + 1, j - 1) })
    }
    i = j
  }
  return out
}

const declarations = (block) =>
  Object.fromEntries([...block.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)].map(([, k, v]) => [k, v.trim()]))

const found = rootBlocks(css)
const isLight = (b) => b.selector === ':root' && b.at === ''
const isDark = (b) => /prefers-color-scheme\s*:\s*dark/.test(b.at)

const lightBlocks = found.filter(isLight)
const darkBlocks = found.filter(isDark)
const orphans = found.filter((b) => !isLight(b) && !isDark(b))

if (orphans.length) {
  console.error('styles.css has theme blocks this audit does not know how to check:')
  for (const o of orphans) console.error(`  ${o.at ? o.at + ' ' : ''}${o.selector}`)
  console.error('Add them to the audit or remove them - an unchecked theme is an unreadable one.')
  process.exit(1)
}
if (lightBlocks.length !== 1 || darkBlocks.length !== 1) {
  console.error(`expected one light and one dark :root block, found ${lightBlocks.length} and ${darkBlocks.length}`)
  process.exit(1)
}

const LIGHT = declarations(lightBlocks[0].body)
const DARK = { ...LIGHT, ...declarations(darkBlocks[0].body) } // dark overrides, it does not replace

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
