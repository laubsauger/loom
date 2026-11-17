# Chroma, chord/key and pitch/note tracking for Loom: design

> Design of record for §T1751b–§T1757b. Accepted 2026-11-12 with every recommendation in section 7 taken:
> input-less projection nodes; names shared with the `harmony` bag where the meaning is the same; the tonal
> nodes smooth by default (0 is raw, events stay raw); triads plus "none"; free run gets the causal, later
> reading; automatic tuning first; the pass runs in the worklet; this work takes feature track v4 and adds no
> flatness; five voices in the record, four by default on the node; gates use synthesised signals only.
> BUILD ORDER CHANGED from section 6: chroma (§T1751b), then `pnpm render` audio (§T1754b), then MIDI note
> input, then the polled path and centred offline windows (§T1752b), chord and key, lead pitch, voices, the
> fixture and its example. Slice 1 as built differs in two places: the polled fallback publishes no claim
> until §T1752b, and the peak floor gained an absolute amplitude (a tone outside the range left rounding
> residue inside it that a relative floor promoted to notes).
> CORRECTION to section 2.4 (found building §T1755b): clarity alone does NOT make polyphony "no claim". A
> consonant interval is periodic (a fifth reads a clarity of 0.9996, a major triad at C4 0.97) and the
> prototype's one triad only read "no pitch" because its common period fell below the window. The lead pitch
> therefore also requires energy AT its fundamental (`PITCH_FUNDAMENTAL_SHARE`), at the stated cost that an
> instrument with a very weak fundamental reads no pitch.


2026-11-12. Design only. Nothing under `src/` and nothing in `SPEC.md` was changed.
The prototype scripts that produced the numbers were session scratch (their results are the tables below;
the built analyser reproduces them in `chroma.test.ts`). Every number marked "measured" comes from those scripts on this
machine (M3 Max, node 24), using the repository's own `fftInPlace`. Numbers marked "estimated"
were not measured.

## 0. Summary

- **Where the analysis runs:** in the existing engine, beside the FFT bins (the §T821 ruling),
  as a second, longer analysis window. The results are new fields of the one session feature
  record (`AudioFeatures`), so the worklet, the polled fallback, the offline pre-analysis and a
  recorded track all carry them through the code that exists today.
- **Surface:** three new projection nodes that read the session's record the way `audioIn`
  does: `audioChroma` (kind `chroma`), `audioChord` (kind `chord`, carries the key too) and
  `audioNotes` (kind `notes`, a lead pitch plus up to five tracked voices). The existing audio
  nodes get no new channels. A deterministic fixture `tonePattern` (kind `tones`) stands in for
  the three, as `audioPattern` stands in for the sources.
- **Algorithms:** peak-interpolated pitch-class folding of an 8192-sample Hann window (HPCP
  family) with an automatic tuning estimate; chord by 24 triad templates plus "none", decoded
  with one small HMM (filtered live, Viterbi offline); key by profile correlation over a long
  window; lead pitch by MPM (FFT autocorrelation); voices by harmonic-summation salience over
  the same peak list, with slot-stable tracking.
- **Seven slices.** The first gives the silk-medusa scene twelve true pitch-class energies from
  its own audio file, live, in free run.
- **Three things in the current pipeline fight this:** the spectrum that leaves the engine is
  8-bit decibels of a 2048 window (useless for pitch), `pnpm render` feeds no audio at all, and
  the scene that drives this plays its file in free run, where there is no pre-analysed track.

## 1. What exists (verified)

| Fact | Where |
| --- | --- |
| One session capture, one feature record per frame. `audioIn` and `audioFileIn` are pure projections of `ValueEvaluateContext.audio`. `projectFeatures` is typed `Record<keyof AudioFeatures, number>` and `audio.test.ts` pins that both nodes publish every field. | `src/nodes/definitions/audio.ts` |
| Engine core: `createHopAnalyser`, 2048-sample Blackman window every 512 samples (93.75 hops/s at 48 kHz). It emits analyser-shaped **bytes** (dB from -100 to -30 mapped onto 0..255, truncated), flux, and SuperFlux per detector band. The float dB spectrum exists only as a private scratch array inside the core. | `src/domain/audio/analysis/hop-analyser.ts`, `stft.ts` |
| Worklet shim: a ring of `fftSize * 2` samples, posts one hop message per 512 samples. All constants arrive as `processorOptions`. | `src/app/audio-analysis.worklet.ts`, `audio-analysis-protocol.ts` |
| Reducer: hops since the last displayed frame become one `AudioFeatures`. Counts and maxima are interval-shaped (§V357). | `src/app/audio-analysis-frame.ts` |
| Polled fallback: `getFloatTimeDomainData` of the last `fftSize` samples, once per frame, through the same core and reducer. Named in the status line (§V288). | `src/app/use-audio-input.ts` (`polledReader`) |
| Offline pre-analysis: the same core and reducer walked over PCM decoded at a fixed 48 kHz, one record per project frame, whole-track tempo written back into every frame. In-memory cache keyed `hash|fps|threshold|retrigger`. Read at the playhead only when `playMode` is `timeline`. | `src/app/audio-offline-analysis.ts`, `audio-pre-analysis.ts` |
| Feature track: version 3, 38 flat fields per frame, refuses any other version by name. No `.loomtrack.json` is tracked in the repository (`git ls-files` finds none). | `src/domain/audio/feature-track.ts` |
| `audioPattern`: a pure function of the frame clock, drums only, publishes the source channel set plus `bar`/`barPhase`. | `audio.ts` |
| **`pnpm render` has no audio.** `src/tooling/offline-render.ts` and `render-project.ts` contain no reference to audio. The frame driver has an `audio` seam (`frame-driver.ts:33`), the tooling does not fill it, so every audio node renders silence. The in-app Render dialog does read the pre-analysed track, and only under the timeline lock. | `src/tooling/` |
| Open row §T1370b already names "spectral flatness at the source (feature track v4)". | `SPEC.md:2041` |
| Next free ids at the time of writing: T1751b, V1034 (V1031 to V1033 are claimed by §T1719b). Grep again before taking one. | `SPEC.md` |

What the driving scene reads today (from `projects/silk-medusa/silk-medusa-clair.loom.json`, an
`automation_score` node with 62 lanes made from MIDI): `voice0..4` × `Pitch`, `PitchClass`,
`Velocity`, `Start`, `Duration`, `Id`, `PositionPitch`, `Envelope`; `root`, `tonalCenter`,
`chordIndex`, `harmonicTension`, `harmonicBrightness`, `harmonicComplexity`, `noteDensity`,
`musicalEnergy`, `phraseProgress`, `beat`, `beatPhase`. This is the `harmony` node's bag (the
other agent's untracked work). Its `audiofile_score` node plays
`media/silk-medusa/clair-de-lune-piano.m4a` in **free run** with a declared 60 bpm.

That file matters twice: it is the owner-level repro, and it comes with ground truth (the MIDI
the lanes were made from), so detection quality can be scored against the score.

## 2. Algorithms

### 2.1 Chroma

**Window.** A second analysis window of 8192 samples (171 ms at 48 kHz, 5.86 Hz per bin), Hann,
taken every 2048 samples (23.4 frames/s). Measured on synthetic triads with six harmonics each
(share of folded energy that lands on the three chord classes, and the best against the
second-best triad template):

| Window | C major at C4 | at C3 | at C2 | A minor at A2 |
| --- | --- | --- | --- | --- |
| 4096 (85 ms) | 0.93, right | 0.93, right | 0.34, **wrong chord** | 0.65, **wrong chord** |
| 8192 (171 ms) | 0.92, right | 0.93, right | 0.92, right | 0.93, right |
| 16384 (341 ms) | 0.92, right | 0.93, right | 0.93, right | 0.93, right |

8192 is the shortest window that holds down to C2 (65 Hz), and 16384 buys nothing more while
doubling the latency. The remaining 7 to 8 % off-chord energy is real: the third and fifth
harmonics of each chord tone are other pitch classes (B, D, G sharp for C major). The existing
2048 window cannot do this job at all: 23.4 Hz bins are wider than a semitone below about
400 Hz, and the bytes that leave the core clip at -30 dB and quantise to 0.27 dB.

**Folding.** Not "each bin to its nearest pitch class". Measured, that plain fold drops to 0.64
at C2 and names the wrong chord for input 35 to 50 cents off pitch. Instead (the HPCP method,
Gómez 2006, the same family the Essentia CHOPs for TouchDesigner use):

1. Magnitude spectrum, then local maxima between 55 Hz and 4200 Hz above a floor 60 dB under
   the frame's strongest peak.
2. Parabolic interpolation on log magnitude gives each peak a frequency well under one bin and
   an amplitude.
3. Each peak adds its energy to the nearest pitch class with a cos² weight on its distance from
   the class centre (zero at a quarter tone), relative to the current tuning.

Measured with this fold: 0.92 or better in every case above, template score 0.98 to 0.99
against 0.72 to 0.73 for the runner-up.

**Tuning.** The energy-weighted circular mean of the peaks' deviation from the nearest
semitone. Measured: input 35 cents sharp reads 35.1; 50 cents sharp reads 49.9 on an 8192
window, and the fold then recovers 0.93 on-chord. Input exactly a quarter tone off is
ambiguous between two labellings by nature; the estimate is smoothed and only moves when it is
stable, so the labels cannot flip frame to frame. Live: starts at A = 440 Hz and follows the
estimate with a time constant of about 5 s, fed only by confident frames. Offline: one estimate
for the whole file, applied from the first frame. Published as `tuning` in cents. A fixed
reference (a parameter in Hz) is a deferred row, not part of the first build, because it is an
engine setting with a provenance cost (section 6, decision 6).

**Harmonic/percussive weighting, whitening.** Peak picking is already a form of whitening
(only maxima contribute, the 60 dB floor is relative to the frame). Two things were tested and
rejected:

- *Persistence weighting* (keep only peaks that were present in the previous frame, a causal
  stand-in for harmonic/percussive separation). Measured: white noise keeps 0.94 of its energy
  with the usual 75 % overlap, and still 0.87 against a non-overlapping frame. It does not
  separate noise from tone at this peak density. Not built.
- *Median-filter HPSS.* Needs a look-ahead of several frames, so it adds latency live, and
  costs a sort per bin. Not built in this plan; a deferred row if drums prove to pollute chords
  on real mixes. Measured for scale: a triad under white noise five times its tone amplitude
  still reads C major on 9 frames of 9.

**Confidence.** `chromaConfidence` is how concentrated the folded energy is: the share held by
the four strongest classes, mapped so that one third (flat) is 0 and 0.9 is 1. Measured share:
clean triad 0.96, triad under loud noise 0.85, white noise 0.43. A single tone and a clean
triad read exactly 1 by construction (four classes or fewer hold everything), which keeps the
tests analytic. The two mapping constants are first values and must be set against recorded
music in slice 1 (the house lesson from §T701/§T776).

**What consumers get.** Per class, `sqrt(E_k / E_max)`: an amplitude-like profile whose
strongest class reads 1 whenever anything tonal sounds, and all zeros under a silence gate
(frame level below -70 dBFS). Loudness is deliberately not in it: `level` and the bands already
carry loudness, and a profile multiplied by loudness would inherit the 0.89-median problem
§T1323b measured. The node multiplies the profile by a smooth gate on the confidence by
default, so noise and drums fade the classes out instead of flickering them.

**Cost.** Measured: `fftInPlace` at 8192 takes 138 µs; the whole unoptimised prototype frame
(window, FFT, `Math.hypot` magnitudes, peaks, fold, with allocations) takes 635 µs. At 23.4
frames/s that is 15 ms of audio-thread time per second, 1.5 %. The risk is not the average but
the spike: one render quantum is 2.67 ms, and the worklet shares the audio thread with the
file monitor and the harmony synth. Target after the obvious work (reused arrays, squared
magnitudes, no `hypot`): under 300 µs, estimated. Offline, the unoptimised figure adds about
4.5 s to the walk of a five-minute track (about 2 s today), so the tonal walk only runs when a
tonal node exists (section 3.5).

**Latency.** The window's centre is 85 ms behind its end. Measured on a C major to F major
change at a known sample: the raw per-frame winner flips at the first window ending 112 ms
after the change. Live chroma therefore lags about 85 to 110 ms; offline it lags 0 (section 3.3).

### 2.2 Chord

- **Emission:** cosine similarity between the chroma profile (smoothed over about 0.3 s) and 24
  binary triad templates, plus a "none" state whose score rises as `chromaConfidence` falls.
- **Decode:** one 25-state HMM with a single self-transition probability (the hysteresis).
  Live it is run forward only (filtering), which behaves as "the new chord must stay ahead for
  a while": about 250 to 500 ms after the sound changes. Offline it is run as Viterbi over the
  whole file, which puts the boundary on the change itself, within one analysis frame (43 ms).
  One mechanism and one set of constants for both paths; the offline path is simply allowed to
  look ahead, as the tempo estimate already is.
- **Vocabulary:** major, minor and none. This is the vocabulary with the fewest confident
  errors: sevenths and suspended chords share three of four notes with a triad and mostly turn
  into flicker between neighbours. `chordQuality` is a number (0 none, 1 major, 2 minor) so a
  wider vocabulary can be added later without renaming a channel. It would be a version bump.
- **Confidence:** the margin between the winning state and the runner-up, scaled so the
  measured clean-triad margin (0.25 to 0.29) is about 1 and the noise margin (0.02) is about 0.
  When "none" wins, `chordConfidence` is 0 and root and quality are 0: the tempo claim's "0 is
  no claim" contract.
- **Cost:** 25 dot products of 12 per analysis frame. Negligible.

### 2.3 Key

Correlation of a long-window average chroma against the 24 rotations of the Krumhansl major
and minor profiles. Live: an average with a 20 s time constant, gated by `chromaConfidence`,
and a new key must lead for several seconds before it replaces the old one. Offline: a centred
30 s window, so the key at a frame already knows what follows. `keyConfidence` is the margin
between the best and second-best correlation; 0 is no claim. Latency live is tens of seconds
and the description says so: a key is a slow fact. Relative major/minor confusion (C major
against A minor) is the known failure of every profile method; the confidence drops there, it
does not lie.

### 2.4 Lead pitch (monophonic)

**MPM** (McLeod and Wyvill 2005): the normalised square difference function computed by FFT
autocorrelation on the 2048-sample window the hop analyser already has, the first key maximum
above 0.9 of the highest, parabolic interpolation. Range 47 Hz to 2 kHz (two periods must fit
the window).

- *Why not plain YIN:* measured, the direct difference function costs 926 µs per call at this
  window (8.7 % of the audio thread at hop rate). MPM by two 4096-point FFTs is about 2 × 63 µs
  plus linear passes, estimated 150 to 200 µs, run on every second hop (47 per second, under
  1 %). Accuracy is the same class: the prototype YIN read 222.17 Hz for a 222.17 Hz tone.
- *Why not pYIN:* its HMM decode is a batch method over many candidates per frame. Its benefit
  (no octave blips, honest voicing) is had here with a three-hop median and the clarity value.
- **Confidence** is MPM's clarity (the height of the chosen maximum). Measured on the
  prototype: a pure tone gives 1.000; a C major triad and white noise both give "no pitch".
  So polyphonic input and noise are no claim without any extra rule: `pitchConfidence` 0 and
  `pitch` 0.
- **Note onset:** a rising crossing of clarity through its gate, or a pitch jump of more than
  80 cents held for two hops, counted per frame interval as `pitchOnsetCount`.
- **Latency:** window centre 21 ms plus the median, about 32 ms, constant.

### 2.5 Voices (polyphonic)

Published for polyphonic input: the strongest N fundamental candidates as voices, N up to 5
(the `harmony` bag has five), each with a confidence. Not a melody extractor and not a
transcription; the description says so.

1. **Salience** by harmonic summation over the chroma peak list (no second FFT): for each
   candidate fundamental (each peak, and each peak divided by 2 and 3), sum the energy of the
   peaks within 35 cents of its harmonics 1 to 8, weighted 0.8 to the power h − 1.
2. **Pick with cancellation:** take the strongest candidate, remove the peaks it explained,
   repeat. This is what stops one note from appearing as three voices an octave and a fifth
   apart.
3. **Tracking:** a candidate within 80 cents of a living voice continues that voice in the
   same slot. A voice is born after two consecutive frames (85 ms) and dies after three missed
   frames. Slots never reorder, which is the property that keeps a visual from flickering:
   `voice2` stays the same note until that note ends. `voiceNId` counts births in the slot.
4. **Onset per voice:** a birth, or a rise of the voice's salience by more than 6 dB inside two
   frames (a repeated note). Its time is snapped to the nearest whole-spectrum SuperFlux event
   within 60 ms when there is one, because the short window times attacks better than the long
   one.
5. **Confidence per voice:** the share of the frame's peak energy the voice explains, scaled.
   `voiceCount` is how many voices are alive. On dense mixes this degrades to few voices at low
   confidence, which is the honest answer.

Cost estimated at about 100 µs per analysis frame (a few hundred candidates, eight binary
searches each). Latency live: 85 ms window centre plus the 85 ms birth rule. Offline: 0, and
onsets are placed on the SuperFlux event.

This is the part with the most risk. It gets its own slice, last among the engine slices, and
is scored against the Clair de Lune MIDI before it is called done (section 4.4).

### 2.6 How latency is published

Every tonal quantity describes sound that is a known time in the past. That time is a field of
the record (`tonalLag`, in seconds, and `pitchLag`), written by whichever path produced the
record, so a replay reproduces it. Each node publishes it as `lagSeconds` and `lagFrames`
(seconds × project fps), the same contract `personMask` has, so `op('chroma_x').chan.lagFrames`
into a `cache.index` delays a sibling branch by exactly that much.

## 3. Where it runs

### 3.1 Core

New pure modules under `src/domain/audio/analysis/`: `chroma.ts` (peaks, tuning, fold,
confidence), `chord.ts`, `key.ts`, `pitch.ts` (MPM), `voices.ts`, and `tonal-analyser.ts`
(`createTonalAnalyser`, the stateful wrapper: long windows in, one `TonalFrame` out). The
field names and their order live in `src/domain/audio/tonal-fields.ts`, as the spectrum band
names live in `spectrum-bands.ts`. No DOM, no clock: time enters as the number of samples a
window advanced, so every time constant is in seconds on any hop grid.

### 3.2 Worklet (live, the default)

The ring grows to 16384 samples. Every fourth hop the processor hands the last 8192 samples to
the tonal analyser and posts one `tonal` message; MPM runs on every second hop on the window
already copied for the hop analyser. The reducer keeps the latest tonal frame and sums the
interval counts (`chordChangeCount`, `pitchOnsetCount`, `voiceNOnsetCount`) the way it sums
`kickCount`. The worklet stays a shim: the tonal options travel as `processorOptions`
(§V747).

If the measured spike is too close to the quantum on the owner's machine, the fallback is to
post raw sample blocks to a dedicated Worker and analyse there. That is a deferred row, not
the first build.

### 3.3 Offline pre-analysis (timeline-locked file)

`analyseOffline` walks the same tonal analyser every fourth hop. Because the whole file is in
hand, three things are better than live, in the way the tempo already is:

- the tuning is one whole-file estimate;
- the chord path is Viterbi, the key window is centred;
- each project frame receives the tonal frame whose window is **centred** on it, so `tonalLag`
  is 0.

The cache key gains the tonal flag. This is a feature track version bump (section 3.6).

### 3.4 Polled fallback

Same core. The fallback `AnalyserNode` is set to `fftSize` 8192; the hop analyser reads the
last 2048 of those samples (identical to today), the tonal analyser reads all of them, once
per displayed frame, with the elapsed samples as its time step. The status line already names
the fallback. No other code reads that analyser (checked: only `use-audio-input.ts`).

### 3.5 Only when asked for

The tonal analysis runs only when the document holds a tonal node. The capture hook already
reads the graph for the detector knobs; it gains one boolean in the capture configuration, and
a change re-acquires (the door a detector-knob change already uses). A track's provenance
records whether it was analysed with the tonal pass. A tonal node in a document with no audio
source reports a diagnostic rather than reading zeros quietly.

### 3.6 The record and the track

`AudioFeatures` grows; the audio source nodes do not project the new fields (section 5).
`FEATURE_TRACK_VERSION` moves twice:

- **4** (slice 1): `chroma0..chroma11`, `chromaConfidence`, `tuning`, `tonalLag`, and the chord
  and key fields (`chordRoot`, `chordQuality`, `chordConfidence`, `chordChangeCount`,
  `chordAge`, `keyTonic`, `keyMode`, `keyConfidence`). Chord and key ship as no claim (all 0)
  until slice 3 fills them, which is §T1227's pattern: the schema ships ahead of the estimator
  without lying.
- **5** (slice 5): `pitch`, `pitchConfidence`, `pitchOnsetCount`, `pitchLag`, `voiceCount`, and
  five voices × `Pitch`, `Level`, `Confidence`, `Age`, `OnsetCount`, `Id`. Held back from
  version 4 because the voice fields are the ones most likely to change once the tracker meets
  real music.

A bump is cheap today for the reason §T1227 gave: no track file ships and the cache is
in memory. §T1370b's spectral flatness also wants "v4"; whoever lands first takes 4. The peak
analysis here yields flatness almost for free, so folding it into this bump is an option the
owner can take (decision 8).

### 3.7 The `audioPattern` fixture

`audioPattern` publishes no tonal channels, and the rule it lives under still holds: it
publishes every channel the live **source** nodes publish, and they publish none of these. A
drum pattern has no honest chroma, and inventing one would train consumers on a signal music
does not send (§T776's lesson).

The tonal nodes get their own understudy, `tonePattern` (slice 6): a pure function of the
frame clock that plays a four-chord progression in a chosen key at a chosen tempo with an
arpeggiated lead, and publishes the union of the three tonal nodes' channels under the same
names. Chroma is computed from the sounding notes and a fixed harmonic series (fundamental 1,
partials at 1/h), so the third and fifth leak as they do in a real spectrum: shape, not
measurement, and said so, as §T1347b says of the pattern's spectrum. Swapping a real analysis
in is replacing one node and keeping its label.

### 3.8 Clocks (§V436)

- The analysis fields are **clockless**: what was heard, with a stated lag. A timeline loop
  passes straight through them. Durations (`chordAge`, `voiceNAge`) are stored as elapsed
  seconds, never as a position on a clock, so a record replays anywhere.
- `voiceNStart` on the node is derived (`absolute time − age`), on the free-running clock the
  `harmony` node uses for the same channel.
- Under the timeline lock the track is read at the playhead, so the same fields become a pure
  function of the frame: **timeline-anchored**, exact on scrub, reproducible offline.
- `tonePattern` is timeline-anchored by construction, like `audioPattern`.

### 3.9 `pnpm render`

It must get audio or none of this reproduces from the command line. `offline-render.ts`
already decodes movie files with ffmpeg; the same door decodes a bound audio file to 48 kHz
mono float PCM, walks `analyseOffline`, and fills the frame driver's `audio` seam through
`readTrackAtPlayhead`. A free-run file is refused by name, as the Render dialog already
refuses to promise it. One caveat to state in the row: ffmpeg's resampler is not Chrome's, so
a command-line render and an in-app render of a 44.1 kHz file are each reproducible but not
bit-identical to each other. This slice needs `analyseOffline`, the reducer and
`computeAudioFeatures` to be importable from tooling; they are pure and can move from
`src/app` to `src/domain/audio` (a file move: gates and a widened test run).

## 4. Node surface

### 4.1 TouchDesigner and Notch

- **TouchDesigner.** Audio File In / Audio Device In CHOPs output samples. Analysis is a
  separate operator wired after the source: Audio Spectrum CHOP, Audio Band EQ, Analyze CHOP,
  Beat CHOP. The stock `audioAnalysis` palette component offers low/mid/high, kick, snare,
  rhythm and spectral centroid. I found no built-in pitch or chroma operator; pitch, HPCP
  chroma and key come from third-party operators (the Essentia CHOP suite: one CHOP per
  analysis, pitch by YinFFT, chroma by HPCP), or from a spectrum plus an argmax. (Checked by
  web search today; I did not find a stock Pitch CHOP in Derivative's documentation.)
- **Notch.** Sound Loader and Sound Capture are the sources. Sound Modifier and Sound FFT
  Modifier are separate nodes that name a source and output one value; FFT Region Modifiers
  hang several regions off one analysis. No pitch or chroma.

What both share: the source is one operator, each analysis is its own operator with its own
parameters and its own small output, and the source's output is not widened when an analysis
is added. What Loom cannot copy literally: in both tools the wire carries samples. In Loom a
value wire carries a bag of numbers and the session has exactly one capture, of which every
audio node is a projection (§T414, §T434).

### 4.2 The choice

**Recommended: three projection nodes with no inputs**, siblings of `audioIn`, each reading
its fields from the session's record.

Rejected alternatives, with the reason:

1. *More channels on `audioIn` / `audioFileIn` / `audioPattern`* (the §T1347b precedent). About
   58 more channels on every audio node. Measured: an Expression node copies its input bag once
   per statement, 4.8 µs at 45 channels and 10.6 µs at 93, so a ten-statement Expression fed by
   an audio node goes from 48 to 106 µs a frame. Every channel menu, every `get_channels`
   answer and every tile's history grows the same way, in every document, including the ones
   that never read a pitch. And `audioPattern` would have to invent a chroma for drums.
2. *A node with a value input wired from an audio source.* The wire could only carry the bag,
   so either the source publishes the fields anyway (alternative 1 again) or the wire carries
   nothing and the node reads the session record behind it. A wire that carries nothing is the
   workaround shape. If Loom later grows more than one capture, every audio projection gains a
   source reference at once, `audioIn` included.
3. *Chord and key computed in the value graph from chroma channels.* Possible (twelve numbers
   at frame rate), but a stateful node decides again after every scrub, cannot use the offline
   look-ahead, and would not be exact on replay. In the record they are.

### 4.3 The nodes

All category `input`, output `out` (value). Kinds are one lowercase word each, new rows in
`NODE_KINDS`.

**`audioChroma`**, title Chroma, kind `chroma`

- Channels: `chroma0` … `chroma11` (C = 0, the numbering `root` and `voiceNPitchClass` already
  use, so `chroma` plus a root is index arithmetic), `chromaConfidence`, `tuning` (cents),
  `lagSeconds`, `lagFrames`.
- Parameters: `gate` (boolean, default on: multiply the classes by a smooth step on the
  confidence), `attack` and `release` in seconds (defaults 0.03 and 0.25; 0 is raw). The
  smoothing is frame-rate independent and makes the node `stateful`.

**`audioChord`**, title Chord, kind `chord`

- Channels: `root` (0 to 11), `chordQuality` (0 none, 1 major, 2 minor), `chordConfidence`,
  `chordChangeCount` (changes inside the frame interval), `chordAge` (seconds), `tonalCenter`
  (key tonic, 0 to 11), `keyMode` (0 none, 1 major, 2 minor), `keyConfidence`, `lagSeconds`,
  `lagFrames`.
- Parameters: `minConfidence` (default 0.2; below it the node publishes no chord). No
  vocabulary parameter until a second vocabulary exists.
- Stateless: a pure projection.

**`audioNotes`**, title Notes, kind `notes`

- Lead channels: `pitch` (MIDI number with a fraction, 0 with no claim), `pitchConfidence`,
  `pitchOnsetCount`.
- Voice channels, for N from 0 to `voices − 1`: `voiceNPitch` (nearest MIDI note),
  `voiceNPositionPitch` (the same, glided), `voiceNPitchClass`, `voiceNVelocity` (level at the
  onset), `voiceNEnvelope` (attack/release follower of the voice's level), `voiceNStart`,
  `voiceNId`, `voiceNOnsetCount`, `voiceNConfidence`; plus `voiceCount`, `noteDensity` (the
  same number under the harmony bag's name), `lagSeconds`, `lagFrames`.
- Parameters: `voices` (1 to 5, default 4), `glide` (seconds), `attack`, `release`,
  `minConfidence`.

**`tonePattern`**, title Tone Pattern, kind `tones`: `bpm`, `key`, `mode`, `amount`; the union
of the channels above.

The voice, `root` and `tonalCenter` names are the `harmony` bag's names wherever the meaning
is the same, so the silk-medusa network can swap its score for the three nodes merged into one
port. Channels the audio cannot know are not published (`voiceNDuration`, `chordIndex`,
`phraseProgress`, the harmonic tension and brightness scores); the scene needs its own source
for those, and that is network authoring, not engine work.

### 4.4 Smoothing, and a house rule this touches

`audio.ts` says in its docblock that the source deliberately does not smooth, because a
trigger wants the raw transient and `valueLag` downstream gives both. That reasoning holds for
events, and here every event is still published raw and interval-shaped (`…OnsetCount`,
`chordChangeCount`). For the continuous tonal channels the owner asked for the opposite
default ("cleanup and smoothing … look pretty with any kind of audio source"), and a chroma
that updates 23 times a second steps visibly at 60 fps without a follower. So the tonal nodes
smooth by default and `0` gives the raw value. This is a deliberate difference from the source
nodes, named here so it is decided, not drifted into (decision 3).

## 5. Test plan

All on synthesised signals, exact or analytically derived (§V147). No tolerance bands; where a
value is not closed-form the assertion is an ordering or an exact count.

**Core, headless (`src/domain/audio/analysis/*.test.ts`)**

- A sine at A4 exactly: `chroma9` is 1, the other eleven are exactly 0, confidence 1, tuning 0.
- A sine 35 cents sharp of A4: tuning reads 35 within the interpolation's analytic error bound
  (derive the bound for a Hann window; the prototype read 35.1), and `chroma9` stays 1.
- C major at C2, C3 and C4, six harmonics: the three chord classes are the three largest, and
  each of the others equals the value predicted from the harmonic series (the fifth of each
  tone at 1/3 amplitude, the third at 1/5). This is the test that fails if the fold goes back
  to "nearest bin".
- Silence: every tonal field is 0, confidence 0. White noise from a fixed seed: confidence
  under the gate, chord "none", `pitchConfidence` 0, `voiceCount` 0.
- C major to F major at sample S, offline: the chord boundary lands on the analysis frame that
  contains S, and `chordChangeCount` summed over the track is exactly 1. Live decode of the
  same signal: the change is reported no later than the stated bound after S, and never
  before it.
- Chord under drums: the same triad plus the shipped `showcase-beat` click pattern still reads
  C major on every frame after the first second.
- Key: a C major scale and cadence reads tonic 0, mode 1; its relative minor material reads
  tonic 9, mode 2; a chromatic cluster reads `keyConfidence` 0.
- MPM: tones at 55, 220, 222.17 and 1760 Hz read their frequency within the parabolic bound; a
  triad and noise read no claim; a two-note sequence with the step at sample S gives
  `pitchOnsetCount` summing to exactly 2 with the second inside the stated lag of S.
- Voices: two simultaneous tones a tenth apart give `voiceCount` 2 with those two pitches and
  no octave ghost; a held note plus an arpeggio above it keeps the held note in its slot for
  the whole signal with one `Id` (the flicker property, asserted as slot stability).

**Gates that can fail.** Each of these is red-verified by editing and restored by editing: the
fold (swap in the nearest-bin fold: the C2 and detuned tests fail); the tuning (pin it to 0:
the 35-cent test fails); the hysteresis (set the self-transition to uniform: the change count
test reads more than 1 under noise); cancellation in the voice picker (remove it: the octave
ghost appears).

**Contract pins.** `feature-track.test.ts`: version, field order and stride, and a version 3
track refuses by name. `audio.test.ts`: the pin changes from "the sources publish every record
field" to "every record field is published by exactly one node family, and the sources publish
exactly the source fields"; `audioPattern` against the live sources still differs by `bar` and
`barPhase` only; `tonePattern` against the three tonal nodes differs by nothing.

**Wiring guards.** The composition-seams gate requires `createTonalAnalyser` to be reached
from a product entry point (worklet and offline walk). A parity test like the existing
worklet one: the same PCM through the worklet path, the polled path and the offline walk
gives the same chroma frame for the same window. For each node, "what differs if the edge were
cut": a document whose render is driven by `chroma0` differs between a C tone and a D tone and
equals the silent render when the node is muted.

**The literal repro, through the real stack.** Playwright, `chromium` project (the worklet
needs no GPU), beside `audio-engine.spec.ts`: a document with `audioFileIn` in free run bound
to a small synthesised file (C major for two seconds, then F major) and a `chroma` node; press
Play; read the channels through the page's tool surface; assert C, E, G lead in the first half
and F, A, C in the second. Then the Dawn half, in the manner of §T1229's E24 test: the same
file under the timeline lock renders byte-identically twice and differently from silence.

**The quality score (not a gate).** A script kept in the repository (§V798: a measured
artefact a later task depends on lives in the repo) that runs the offline walk over
`clair-de-lune-piano.m4a` and scores it against the MIDI-derived lanes in
`silk-medusa-clair.loom.json`: chroma against the sounding pitch classes, voices against the
score's notes, and the confidence constants are set from it together with two or three of the
recorded tracks §T701 used.

**Which commands the change reaches.** New files under `src/`, new node types, a domain type
and a recorded contract change: `pnpm typecheck`, the named test files, `pnpm test:gates`
once per slice (composition-seams, node-kinds, declared-defaults, effective-schema-closure,
headless, side-effects, gate-list, doc-drift if a doc names the channels),
`pnpm test:first-import` (new domain modules), `pnpm build` (the worklet chunk must stay
self-contained, §T1225) and the worklet e2e specs, all through `tools/heavy.sh`. No full
suite. `pnpm vitest related` is not used on node definitions (§T1228 measured 219 s).

**Examples and docs.** No shipped example changes in slices 1 to 5. Slice 6 adds one new
example (next free number, E90 today) generated with `--only E90`, with its `.md`, README row
and claims test. `CLAUDE.md`/`AGENTS.md` need no change. The audio nodes' long descriptions
gain one sentence pointing at the tonal nodes.

## 6. Slices

Ids are the next free ones today; grep before taking them. Row text is drafted in the SPEC's
compressed style.

### Slice 1: chroma from a file, live (T1751b)

Core `chroma.ts` and `tonal-analyser.ts`; worklet, protocol and reducer; the causal offline
walk (same frames as live, lag in the record); record version 4; the `audioChroma` node; the
on-demand flag; the polled path publishes no claim and the status line says chroma needs the
worklet.

Files: new `src/domain/audio/analysis/chroma.ts`, `tonal-analyser.ts`,
`src/domain/audio/tonal-fields.ts`, `src/nodes/definitions/audio-tonal.ts` and their tests;
edits to `src/domain/types/frame.ts`, `src/domain/audio/feature-track.ts`,
`src/app/audio-analysis-protocol.ts`, `audio-analysis.worklet.ts`, `audio-analysis-frame.ts`,
`audio-offline-analysis.ts`, `audio-pre-analysis.ts`, `use-audio-input.ts`,
`src/nodes/definitions/audio.ts` (the projection type only), `audio.test.ts`, `index.ts`,
`src/domain/graph/node-kinds.ts` (carries another session's edits: add one row, touch nothing
else); one e2e spec.

After it: open `silk-medusa-clair`, add a Chroma node, press Play. Twelve lanes follow the
piano; D flat, A flat and F dominate (the piece is in D flat major); the lanes fall to zero in
the rests.

> T1751b|.|**CHROMA — 12 PITCH-CLASS ENERGIES FROM ANY AUDIO SOURCE; FEATURE TRACK v4.** owner: *"we should get both of them in. those are essential audio tools"*. finding: the spectrum that leaves the core is 8-bit dB of a 2048 window (23.4 Hz bins, clipped @ −30 dB) ∴ pitch class is inexpressible downstream; §T821 holds — detectors where the bins live. build: 2nd window 8192 Hann every 2048 (171 ms, 23.4/s), spectral peaks 55–4200 Hz w/ parabolic interpolation, cos² fold to 12 classes rel. an AUTO tuning estimate (circular mean of peak deviation), `sqrt(E/Emax)` profile, confidence = top-4 class share. measured (design `docs/…`): 4096 names the WRONG chord @ C2, 8192 holds 0.92 on-chord C2–C4; nearest-bin fold fails @ +35 c, peak fold 0.93; persistence weighting does ⊥ reject noise (0.87–0.94 kept) ∴ ⊥ built. surface: NEW projection node `audioChroma` (kind `chroma`), ⊥ channels on the sources (Expression copies its bag per statement: 4.8 → 10.6 µs @ 45 → 93 ch). record v4 = chroma ×12, `chromaConfidence`, `tuning`, `tonalLag`, + chord/key fields @ NO CLAIM until §T1753b. runs only when a tonal node exists; polled path = no claim, NAMED|V147,V288,V352,V357,V436,V747,T821,T1226,T1227,T1347b

### Slice 2: every path, and the offline gains (T1752b)

The polled fallback runs the tonal core (analyser at 8192); the offline walk centres its
windows and uses one whole-file tuning (`tonalLag` 0); three-path parity test; the Dawn
byte-identity test under the timeline lock.

Files: `use-audio-input.ts`, `audio-offline-analysis.ts`, tests, one gpu test.

After it: with the file locked to the timeline, scrubbing shows the same chroma at the same
second every time, and it leads the free-run reading by the 85 ms the live path owes.

> T1752b|.|**CHROMA ON EVERY PATH; OFFLINE IS CENTRED.** polled fallback analyses the last 8192 of an 8192 analyser (hop core still reads the last 2048 ∴ bands unchanged); `analyseOffline` gives frame *i* the window CENTRED on *i*/fps & ONE whole-file tuning ∴ `tonalLag` 0 under the timeline lock, 0.085 live — the lag is a RECORD field ∴ ⊥ a version event. parity: worklet = polled = offline on one window. Dawn: locked file renders byte-identically ×2 & ≠ silence|V47,V288,V436,T1229,T1751b

### Slice 3: chord and key (T1753b)

`chord.ts`, `key.ts`; filtered decode live, Viterbi and a centred key window offline; fills
the version 4 fields; the `audioChord` node.

After it: a Chord node beside the Chroma node names the chord under Clair de Lune; `root`
steps at chord changes and holds between them; the key settles on D flat major within the
first half minute live, and from the first frame under the timeline lock.

> T1753b|.|**CHORD & KEY — A CLAIM W/ A CONFIDENCE, AT MUSICAL RATES.** 24 triads + NONE, cosine on 0.3 s chroma, ONE 25-state HMM: FILTERED live (≈250–500 ms behind), VITERBI offline (boundary on the change, ±1 analysis frame). key = Krumhansl profile correlation, 20 s average live, centred 30 s offline. confidence = margin over the runner-up (measured: triad 0.25–0.29, noise 0.02); 0 = NO CLAIM & root/quality 0 (§T1227's contract). node `audioChord` (kind `chord`): `root`, `chordQuality`, `chordConfidence`, `chordChangeCount`, `chordAge`, `tonalCenter`, `keyMode`, `keyConfidence`, lag. ⊥ sevenths: they turn into flicker between neighbours — a wider vocabulary is a version event, own row|V147,V352,V357,T1227,T1229,T1751b

### Slice 4: `pnpm render` hears the file (T1754b)

ffmpeg decode, `analyseOffline`, the `audio` seam; move the pure analysis modules from
`src/app` to `src/domain/audio`; refuse a free-run file by name.

After it: `pnpm render projects/…loom.json --clip 10` of an audio-driven project shows the
picture moving with the file, the same on every run. Today it renders silence without saying
so.

> T1754b|.|**`pnpm render` FEEDS NO AUDIO: EVERY AUDIO NODE RENDERS SILENCE, UNSAID.** `offline-render.ts` fills `movies` & `pictures`, ⊥ the frame driver's `audio` seam. build: a bound Audio File In decodes through ffmpeg (48 kHz mono f32, the door §T1737b uses), walks `analyseOffline`, reads `readTrackAtPlayhead` per stepped frame; free run REFUSES by name; `--spp` sub-frames read the track @ their own time. move `analyseOffline`/reducer/`computeAudioFeatures` `src/app` → `src/domain/audio` (pure already). ⚠ ffmpeg's resampler ≠ Chrome's ∴ CLI & in-app renders of a 44.1 k file each reproduce, ⊥ bit-equal to each other — said ∈ `--help`|V288,V436,T1229,T1738b,T1750b

### Slice 5: lead pitch (T1755b)

`pitch.ts` (MPM), record version 5 (pitch and voice fields, voices at no claim), the
`audioNotes` node with the lead channels.

After it: sing or play one note into the microphone and `pitch` follows it within about 30 ms;
play a chord and `pitchConfidence` drops to 0 instead of jumping around.

> T1755b|.|**LEAD PITCH — MPM ON THE HOP WINDOW; FEATURE TRACK v5.** NSDF by FFT autocorrelation on the 2048 window, every 2nd hop, 47 Hz–2 kHz, 3-hop median, clarity = `pitchConfidence`; polyphony & noise read NO CLAIM (prototype: triad & white noise → no pitch). ⊥ YIN direct (measured 926 µs/call = 8.7 % of the audio thread), ⊥ pYIN (batch decode). `pitchOnsetCount` interval-shaped. node `audioNotes` (kind `notes`): `pitch`, `pitchConfidence`, `pitchOnsetCount`, lag ≈ 32 ms. v5 reserves the voice fields @ no claim for §T1756b|V147,V352,V357,T1226,T1751b

### Slice 6: voices (T1756b)

`voices.ts`; fills the voice fields; the node's voice channels under the harmony bag's names;
the Clair de Lune scoring script.

After it: under the piano file, four voice lanes hold notes, each lane keeps its note until it
ends, and a new note raises `voiceNOnsetCount` for one frame.

> T1756b|.|**NOTE VOICES — THE STRONGEST N FUNDAMENTALS, SLOT-STABLE.** harmonic-summation salience over §T1751b's peak list (h ≤ 8, 0.8^h), pick W/ CANCELLATION (⊥ octave ghosts), track ±80 c ∈ a FIXED slot, born after 2 frames, dead after 3 missed; onset = birth ∨ +6 dB, snapped to the SuperFlux event ≤ 60 ms. ≤ 5 voices × pitch/level/confidence/age/onsetCount/id, `voiceCount`. node channels wear the `harmony` bag's names where the meaning is the same (`voiceNPitch`, `…PitchClass`, `…Velocity`, `…Envelope`, `…Start`, `…Id`, `…PositionPitch`) ∴ a score ↔ audio swap is one node. ⊥ a transcription & says so. SCORED against the MAESTRO MIDI behind `silk-medusa-clair` before it closes; the script lives ∈ the repo (§V798)|V147,V352,V357,V798,T1751b,T1755b

### Slice 7: fixture and example (T1757b)

`tonePattern`; one shipped example (E90 today) with its claims test; a sentence on each audio
source's description.

After it: a new example opens and plays its own chord progression as colour and form with no
file and no microphone; replacing its Tone Pattern with the three tonal nodes and a file is a
node swap.

> T1757b|.|**`tonePattern` — THE TONAL NODES' UNDERSTUDY, & E90.** a 4-chord progression w/ an arpeggiated lead from the frame clock (`bpm`, `key`, `mode`), TIMELINE-ANCHORED, publishing the UNION of `audioChroma`/`audioChord`/`audioNotes` under the same names; chroma from the sounding notes × a fixed 1/h series — SHAPE ⊥ MEASUREMENT, said. `audioPattern` gains NOTHING: it mirrors the SOURCES, & drums have no honest chroma (§T776). E90 demonstrates itself (§V363), `--only E90`|V363,V436,T442,T776,T1347b,T1751b

### Then, outside the engine

A `silk-medusa-audio.loom.json` variant that replaces the score with the three nodes. This is
network authoring through the Loom tools, and it belongs to whoever owns that project.

### Deferred, each a row when the work starts

A fixed tuning reference (Hz) as an engine knob with provenance; a wider chord vocabulary;
median-filter harmonic/percussive separation; tonal analysis on a Worker; a persisted
pre-analysis cache (already named by §T1229).

## 7. Risks and decisions for the owner

1. **Nodes without an input wire.** Recommended (section 4.2). The alternative that keeps a
   wire is 58 more channels on every audio node. *Recommendation: the three projection nodes.*
2. **Channel names shared with the `harmony` bag.** `root`, `tonalCenter` and the `voiceN…`
   names would be shared with a contract that is another agent's untracked work and may still
   move. *Recommendation: share them, and tell that agent the names are now depended on.*
3. **Smoothing on by default in the tonal nodes,** against the source nodes' "no smoothing
   here" rule (section 4.4). *Recommendation: yes, with 0 as raw; events stay raw.*
4. **Chord vocabulary: triads only.** *Recommendation: yes for the first build.*
5. **Offline better than live.** Under the timeline lock chords land on the change and the lag
   is 0; in free run they are 250 to 500 ms late. The silk-medusa scene plays in free run
   (your fix for the crackle under the lock), so it gets the late version. The scene's motion
   brief (a note is an impulse answered over 0.6 to 1 s) hides most of that, but the crackle
   itself is the real obstacle to the better path. *Recommendation: accept for now, and treat
   the timeline-lock crackle as its own bug.*
6. **Tuning: automatic only at first.** Music a quarter tone off standard pitch is ambiguous
   by nature, and a live input has no estimate in its first seconds (it starts at 440).
   *Recommendation: automatic first, a fixed reference as a later row.*
7. **Audio-thread budget.** 635 µs measured for the unoptimised chroma frame inside a 2.67 ms
   quantum, on the thread that also plays the file. *Recommendation: build it in the worklet,
   measure on your machine in slice 1 with the monitor on, and move to a Worker only if it
   glitches.*
8. **Version numbering against §T1370b's flatness.** *Recommendation: this work takes version
   4, and adds `flatness` in the same bump only if you want §T1370b closed with it.*
9. **Five voices or four.** Five matches the harmony bag; each voice is six record fields.
   *Recommendation: five in the record, the node defaults to four.*
10. **Quality on full mixes is unmeasured.** Every number here is from synthetic signals. The
    constants for confidence, hysteresis and voice birth must be set against Clair de Lune and
    the recorded tracks in slices 1, 3 and 6, and the voice tracker may turn out weak on dense
    material. *Recommendation: slice 6 closes only with its score written down, whatever the
    score is.*
11. **Licence of the scoring material.** The Clair de Lune MIDI is MAESTRO (CC BY-NC-SA). A
    scoring script that reads it from `projects/silk-medusa` is fine; a test fixture derived
    from it and shipped in `examples/` or `public/` is not obviously fine. *Recommendation:
    gates use synthesised signals only; the score stays a project-side measurement.*

## 8. What in the existing pipeline fights this

- **The bytes.** `HopFeatures` carries `Uint8Array` spectra shaped for `AnalyserNode` parity.
  Nothing downstream of the core can recover pitch from them, so the tonal analysis has to be
  a second analysis inside the engine, not a consumer of the first.
- **The worklet ring and message.** Sized for one 2048 window and one message type; both grow.
- **`projectFeatures` and its test** assume every record field is published by every source
  node. That assumption is replaced, not worked around.
- **Free run reads live hops only.** A file in free run never uses its pre-analysis, so the
  owner's scene cannot have look-ahead quality until the timeline lock is usable for it.
- **`pnpm render` is silent** for audio nodes and says nothing (slice 4).
- **The pre-analysis cache key and provenance** know only the detector knobs; they gain the
  tonal flag.
- **The analysis code tooling needs lives in `src/app`** (`analyseOffline`, the reducer,
  `computeAudioFeatures`), which is why slice 4 includes a move.
- **Dirty shared files.** `src/domain/graph/node-kinds.ts` and `SPEC.md` carry other sessions'
  uncommitted edits; each slice adds its rows by editing, and stages nothing.

## Sources for section 4.1

- Derivative, Palette:audioAnalysis: https://derivative.ca/UserGuide/Palette:audioAnalysis
- Essentia CHOP suite for TouchDesigner: https://darienbrito.github.io/EssentiaTD
- Notch manual, Working with audio: https://manual.notch.one/2026.1/en/docs/learning/working-with-audio/
- Notch manual, Sound FFT Modifier: https://manual.notch.one/2026.2/en/docs/reference/nodes/modifiers/sound-fft-modifier/
- Notch manual, Sound Modifier: https://manual.notch.one/2026.2/en/docs/reference/nodes/modifiers/sound-modifier/
