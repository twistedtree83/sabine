# Status, 26 August 2026

Sabine is built and working end to end. The contrast defect is closed. What is
left is the part that needs hardware and a real room.

## Done and verified

- **Full DSP pipeline.** Exponential sine sweep, matched inverse filter, FFT
  deconvolution, Lundeby truncation, Schroeder integration, T20/T30/EDT with r²,
  C50/C80/D50, octave bands 125 Hz to 4 kHz, early arrivals from the Hilbert
  envelope.
- **`npm test` passes** (just over 2 minutes, so run it in the background):
  - `contrast` every colour pair, both schemes, WCAG AA — runs first, instant
  - `synthetic` five rooms 0.28 s to 1.6 s, one at 28 dB SNR, all within 3%
  - `bands` bass-heavy room, every octave within 3%
  - `imagesource` 9x7x2.9 m shoebox by the image-source method: measured RT60
    1.11 s against Sabine's 1.12 s, floor/ceiling/side wall each to within 3 cm
  - `skirts` octave filter -3 dB at band edges, -52 dB at the neighbouring centre
- **Verified in the browser** via the dev-only `window.__demo(rt)` hook (stripped
  from production by `import.meta.env.DEV`), in both colour schemes, with the
  canvases redrawn after the scheme change rather than left stale.
- Production build 30 kB JS (11.7 kB gzipped), typecheck clean.
- **Deployed.** `twistedtree83/sabine`, live at
  <https://twistedtree83.github.io/sabine/>. A push to `main` runs typecheck,
  `npm test` and the build before Pages sees anything, so a room that measures
  wrong or a token that fails contrast cannot reach the live site.

## Closed since the last status

A multi-agent review raised 34 findings; 11 were refuted under adversarial
verification and the surviving 23 are all closed. The two that mattered were
one defect seen from both ends: a fixed 4-second analysis window that ran off
the end of the recording, and a Lundeby noise floor seeded from inside the
region where it had. A 1.6 s room at 24 dB SNR read 11.45 s, labelled T20 with
r2 = 0.91 and no warning shown. Both close by deriving the window from the
recording length instead of a constant.

The rest of the review's value was in the test suite, which passed throughout
while proving much less than the README claimed:

- `skirts.ts` asserted nothing and always exited 0
- `bands.ts` filtered its own room with the function it was measuring
- `synthetic.ts` used a capture geometry the instrument never records, and a
  PRNG that looped every 218 ms
- `imagesource.ts` accepted reflections within 0.25 m against a stated 3 cm
- the calculator the project is named after had no test at all
- `npx esbuild` was fetched from the network on every run

All fixed, and the README now quotes thresholds the suite enforces. Three of
the fixes were verified by mutation - dropping the filter order to 3, flipping
the sign on `replaces`, putting the Sabine constant 2% out - because a test
that cannot fail is not worth having.


- **The six WCAG contrast failures.** The single amber is now three tokens —
  `--accent` for marks and the button, `--accent-ink` for the label on it,
  `--accent-text` for amber at body size — because one colour cannot clear both
  3:1 against the plot surface and 4.5:1 against the page. Light `--ink-muted`
  went darker (`#5f696f`), dark `--critical` lighter (`#e25c43`). All 42 pairs
  pass. See the Colour section of the README.
- **The audit no longer keeps its own copy of the palette.** `test/contrast.mjs`
  parses `src/styles.css`, so a token that moves cannot pass a stale check, and
  it runs as part of `npm test` rather than by hand.
- **Two failures the old audit could not see**, because it only checked against
  `--surface`: `--critical` on the raised panel (the notice icon) and on the
  plot surface (the clipping label). The audit now covers all three surfaces.
- **The skip link never appeared.** It was `.visually-hidden` with no focus
  rule, so a keyboard user tabbing into the page landed on one clipped pixel
  with nothing to see — WCAG 2.4.7. It now returns on `:focus`.
- **No regression in the chart palette.** Both schemes still pass the lightness
  band, chroma floor and normal-vision checks; dark colour-vision separation
  improved from ΔE 8.2 to 8.8.
- **The mobile check, finally seen rather than reasoned about.** `resize_window`
  reports success but Chrome clamps the window, so the page never drops below
  1200 CSS px that way. An iframe has its own viewport and its own media queries:
  loading the app into one at 390 and 768 px shows the real narrow layout. At
  375 px client width the document does not scroll horizontally, in the landing
  view or the full results. The stage, plots and calculator each collapse to one
  column, `.dims` keeps three fields on a row at 92 px each, and the masthead
  note hides as designed. The only element wider than the viewport is the data
  table at 540 px, which is the intended behaviour — it sits inside
  `.table-wrap { overflow-x: auto }` and scrolls within itself.

## Not done

- **Never tested against a real microphone in a real room.** All validation is
  synthetic. The `getUserMedia` constraint path, the AudioWorklet capture and the
  browser-DSP warning have not been exercised on real hardware. This is the
  biggest open risk and the next thing worth doing.
- **No second position.** ISO 3382 wants an average over several source and
  receiver placements; the instrument measures one. Two positions that disagree
  would be worth surfacing rather than hiding.
