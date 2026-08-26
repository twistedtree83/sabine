# Sabine

Put a laptop on a desk, click once, and seven seconds later the page tells you your room's
reverberation time per octave band, its speech clarity, roughly how far away the nearest
surfaces are, and whether the room is fit for a child with hearing loss to learn in.

No measurement microphone, no app, no backend. Every sample stays on the device.

```bash
npm install
npm run dev        # http://localhost:5173/sabine/
npm run build      # -> dist/
npm run typecheck
npm test           # the DSP against rooms with known answers, and the palette
```

`getUserMedia` needs a secure context. `localhost` counts, so dev works over plain http;
a deployment needs HTTPS.

## What it actually does

It plays an **exponential sine sweep** and records it back. Convolving the recording with a
time-reversed, energy-compensated copy of that sweep collapses it into a single impulse: the
room's impulse response, which is everything the room does to any sound at all.

A sweep rather than a clap, because a laptop speaker distorts, and the harmonic distortion
products of a sweep collapse to a point *before* the linear impulse. They land in negative
time and get thrown away. A clap has no such courtesy, and a clap is never the same twice.

From the impulse response:

- **Lundeby truncation** finds where the decay disappears into the microphone's noise, so the
  Schroeder integral is not dominated by a flat tail of hiss. Skip this step and every room
  measures as more reverberant than it is.
- **Schroeder backward integration** turns the noisy decay into a smooth energy curve.
- **T20, T30 and EDT** come from least-squares fits over their ISO 3382 ranges, each reported
  with its r² and only quoted when the fit sits 10 dB clear of the noise.
- **C50, C80 and D50** are early-to-late energy ratios: speech clarity, music clarity, and the
  share of energy arriving in the first 50 ms.
- **Octave bands** from 125 Hz to 4 kHz, so you can see whether the problem is a bare ceiling
  or a boomy floor.
- **Early arrivals** are picked off the Hilbert envelope where they stand clear of the decay
  they sit on, and converted to distance. Speaker and microphone are centimetres apart, so an
  arrival *t* seconds late has travelled *ct* further and a single-bounce surface is half of
  that away.

Then the **Sabine calculator** runs the equation backwards. Predicting a room's absorption from
a materials list means guessing at surfaces nobody wrote down, and the guess is usually wrong by
more than the treatment you are considering. Since the room has just been measured, its
absorption is known: `A = 0.161 V / RT60`. A treatment is only a change to it, and everything
unknown about the room cancels.

## Two things that make it work at all

**The latency is never measured.** Browsers will not tell you honestly how long the audio output
and input pipelines delay things by. They do not have to. The recording contains the direct sound
as well as the reflections, so the impulse response carries its own zero in the direct arrival,
and everything is measured relative to that.

**The browser's microphone DSP is switched off, and then checked.** Streams get echo cancellation,
noise suppression and automatic gain control by default. Echo cancellation exists precisely to
remove the sound of your own speaker arriving back through the room, which here is the entire
signal. All three are requested off, and `track.getSettings()` is read back, because a browser is
allowed to say yes and do otherwise. If any survived, the measurement says so at the top.

## Is it right?

`npm test` measures rooms whose answers are known in advance. Every number quoted below is a
threshold the suite actually enforces, not an observation someone made once - which is what
they used to be.

| Test | What it enforces |
|---|---|
| `synthetic` | Seven rooms from 0.28 s to 1.6 s. The five at 45-60 dB SNR recover within 3%; two harder ones at 24 and 28 dB within 5%. |
| `clarity` | C50, C80 and D50 split at the right instant, against a flat impulse response whose answer is 0.00 dB by construction. |
| `calculator` | The Sabine equation, each treatment's area derivation, and the BB93 thresholds, against arithmetic written out by hand. |
| `bands` | A room ringing 1.5 s at 125 Hz and 0.5 s at 4 kHz, excited by sinusoids rather than by the filter under test. Every band within 8%, and the measured curve has to fall monotonically across the six with the bottom-to-top spread intact. |
| `imagesource` | A 9 x 7 x 2.9 m shoebox built by the image-source method: floor, ceiling and side wall each located to within 3 cm, with the mean signed error asserted separately, because a bias is exactly what a per-arrival tolerance hides. Its RT60 check is a consistency check rather than independent evidence - the late decay is painted at the Sabine slope, so it is `synthetic` that establishes reverberation accuracy. |
| `skirts` | The octave filter, at seven probe ratios across four bands: 0 dB at the centre, -3 at the edges, past -45 at the neighbouring centres, past -80 two octaves out. |
| `contrast` | Every colour pair in the interface, in both schemes, against WCAG AA - and it fails on any `:root` block it does not know how to check. |

Two habits run through all of these, both learned the hard way. A test must not build its
subject with the code it is about to measure - `bands` filtered its own room with the very
function under test, so the band centres agreed by construction and a filter tuned to the
wrong frequency would have passed. And the synthetic rooms are built on the capture geometry
the instrument actually records - a fixed lead-in, sweep and tail - rather than a recording
allowed to grow with the room. That
distinction is not academic: it was hiding an analysis window that ran off the end of its own
data, and with it a 1.6 s room reported as 11.45 s, labelled T20 with an r-squared of 0.91
and no warning shown. What the tests assert is therefore not only that the numbers are close,
but that a number the pipeline marks *valid* can be trusted at all.

`skirts` is why the band filter is an FFT-domain Butterworth mask and not a cascade of
biquads. Three cascaded second-order sections put the octave edges in exactly the right place
and then roll off so slowly that the neighbouring band is only 10 dB down, where IEC 61260
class 1 asks for about 61. A room that rings longer at the bottom leaks into every band above
it, and mid-band errors reached 27% before the filter was replaced.

## Where it lies

- **Your speaker.** A laptop cannot move much air below about 150 Hz, so the 125 Hz band is
  measured with far less signal than the rest. Bands whose decay had too little headroom over
  the noise are drawn faded, and the table gives the headroom in decibels for every band.
- **One position.** ISO 3382 wants an average over several source and receiver positions. This
  is one. Move the laptop and measure again; two positions that disagree are telling you
  something about the room.

- **The tail is the ceiling.** The impulse response can only be as long as the silence
  recorded after the sweep, which is 2.5 seconds. A room ringing much longer than that has no
  decay left to fit by the time the recording ends, and comes back unresolved rather than
  guessed at. Church, gym and atrium are out of range on purpose.
- **Later arrivals are not always one surface.** The first two are usually the floor and the
  ceiling. A double bounce off floor then ceiling in a 2.9 m room reads as 2.9 m, which is a
  real arrival but not a wall.
- **Absorption coefficients are typical published values**, and vary between products. The
  prediction is a design estimate, which is all the Sabine equation has ever been.

## Why bother

In a reverberant classroom every word overlaps the word before it. Building Bulletin 93 sets
0.8 seconds as the limit for a new general teaching space in England and Wales, and 0.6 for
rooms designed for pupils with hearing impairment or other special educational needs. Rooms
built before it, which is most of them, were never measured at all. The children at the back
have known for years.

## The name

Wallace Clement Sabine was a young physics lecturer at Harvard in 1895 when he was handed the
Fogg lecture hall, a room in which nobody could understand a lecture. He worked at night with
an organ pipe and a stopwatch, carrying seat cushions in from the Sanders Theatre and out
again, until he had the relationship that still carries his name: reverberation time is volume
divided by absorption. He invented architectural acoustics by measuring soft furnishings in
the dark.

## Layout

```
index.html            the instrument
src/
  main.ts             state machine, results rendering, the Sabine calculator UI
  sabine.ts           the absorption model and BB93 limits
  styles.css          tokens and layout
  dsp/
    sweep.ts          exponential sine sweep and its matched inverse filter
    fft.ts            radix-2 FFT, fast convolution, Hilbert envelope
    bands.ts          octave filtering as a Butterworth mask in the frequency domain
    acoustics.ts      Lundeby, Schroeder, T20/T30/EDT, C50/C80/D50, early arrivals
    spectrogram.ts    STFT on a log-frequency grid, for the sweep figure
    analyse.ts        the pipeline, from recording to result
    worker.ts         runs it off the main thread
  audio/capture.ts    getUserMedia constraints, AudioWorklet capture, sweep playback
  ui/
    canvas.ts         device-pixel sizing, live theme tokens, animation
    plots.ts          spectrogram, reflectogram, decay curve, octave bars
test/                 the validation above; prng.ts is shared by all of them
```

## Colour

Three amber tokens rather than one, because a single colour cannot be a chart
mark, a button background and body-sized text at the same time. A mark needs
3:1 against the plot surface, which caps how dark it can go; text needs 4.5:1
against the page, which sets a floor well below that. In light mode the two
windows do not overlap, so `--accent` carries the marks and the button,
`--accent-ink` is the near-black label on top of it, and `--accent-text` is a
darker step for anything amber at body size.

`test/contrast.mjs` reads the tokens straight out of `src/styles.css` — it does
not keep a second copy that could go stale — and checks each one against the
surfaces it actually lands on, in both schemes. It runs first in `npm test`,
because it takes no time and it fails on a token that moved.

The three chart colours were also checked for lightness band, chroma floor and
colour-vision separation:

| | accent | good | critical |
|---|---|---|---|
| light on `#f5f6f7` | `#b37615` | `#127f5f` | `#b33e28` |
| dark on `#111315` | `#c68320` | `#22a078` | `#e25c43` |

Good and critical sit at ΔE 7.9 under simulated deuteranopia in light mode,
inside the 6-8 band that is only legal with a second encoding. They have one:
the status line always ships the word beside the colour, never the colour
alone.

## Deploying

Pushing to `main` builds and deploys via `.github/workflows/deploy.yml`. Typecheck
and `npm test` both gate it: a room that measures wrong, or a token that fails
contrast, does not reach the live site.

Because Pages serves a project from a sub-path, `vite.config.ts` sets `base` to
`/sabine/` and the dev server matches it. Deploying anywhere else needs
`VITE_BASE` set, e.g. `VITE_BASE=/ npm run build` for a root domain.
