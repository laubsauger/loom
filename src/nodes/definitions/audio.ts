import type { CompiledNodeDescription, NodeDefinition } from "../../domain/types/node-definition.ts";
import { MEDIA_TRANSPORT_PARAMETERS } from "../../domain/media/transport.ts";
import { VALUE_PORT } from "./common-ports.ts";

/**
 * T414 — Audio In: sound as channels, the way Mouse is the pointer as channels.
 *
 * The node is a pure PROJECTION of `ValueEvaluateContext.audio` — the per-frame feature
 * record the session's transport stamps into FrameInputs. It owns no analyser, opens no
 * stream and holds no state; the app layer computes features once per displayed frame
 * (§V182's one-listener rule, applied to sound), and everything downstream is a pure
 * function of (frame, features). That single field is the entire §V45 determinism
 * carve-out: a REPLAY feeds a recorded feature track through the same field and
 * reproduces the performance bit-exactly; a session with no audio (offline render
 * without a track, headless, mic denied) reads all-zero silence — the same silence
 * every run, never a different render per attempt (§V329).
 *
 * DELIBERATELY NOT HERE, and why:
 *  - smoothing. `valueLag` downstream gives both the raw transient AND the damped
 *    envelope; a source that smooths internally gives you neither, and a trigger wants
 *    the raw one.
 *  - a `beat` channel. Beat detection is a CLAIM, not a measurement; a confidently
 *    wrong beat is worse than the honest onset envelope below, thresholded by the user
 *    (`valueTrigger`) for the transients they mean.
 */
export const audioInNode: NodeDefinition = {
  type: "audioIn",
  version: 1,
  title: "Audio In",
  category: "input",
  description:
    "The session's audio input as channels: level (RMS), low / lowMid / highMid / high band energies, and onset — a spectral-flux envelope that rises on ANY energy increase, not a beat detector; threshold it with Trigger. NO beat or bar channels: a live input has no declared tempo, and a guessed one would be wrong. For musical structure, run an Audio Pattern at the tempo you are playing to and take bar/beat from there. Silent (all zeros) when no audio input is live. CLOCKLESS (§V436): the numbers come from what the analyser heard this frame, so a timeline loop passes straight through them.",
  tags: ["value", "input", "audio", "sound", "music", "fft"],
  inputs: [],
  outputs: [{ id: "out", label: "Out", type: VALUE_PORT }],
  parameters: {
    /*
     * T434: capture configuration, read by the APP's capture hook — never by compile.
     * The session has ONE audio capture (like it has one pointer): an `audioFileIn`
     * with a file bound takes precedence (a bound file is deliberate authoring);
     * otherwise the first `audioIn` by node id opens the microphone, and every audio
     * node reads the same features.
     */
    device: {
      type: "string",
      label: "Device",
      default: "",
      description:
        "Microphone device id, from the inspector's device picker. Empty = the system default. Device names are hidden by the browser until microphone access is granted.",
    },
  },
  valueEvaluate: ({ audio }) => projectFeatures(audio),
  compile: (): CompiledNodeDescription => ({ passes: [] }),
};

/** Both audio nodes publish the SAME channels: the session has one feature record. */
function projectFeatures(audio: { level: number; low: number; lowMid: number; highMid: number; high: number; onset: number; onsetCount: number; onsetMax: number } | undefined) {
  return {
    level: audio?.level ?? 0,
    low: audio?.low ?? 0,
    lowMid: audio?.lowMid ?? 0,
    highMid: audio?.highMid ?? 0,
    high: audio?.high ?? 0,
    onset: audio?.onset ?? 0,
    // T437: interval-shaped onset events — count of rising threshold crossings and the
    // interval's peak. Per-frame analysis makes these 0|1 and == onset; a faster hop
    // later refines fidelity, never meaning.
    onsetCount: audio?.onsetCount ?? 0,
    onsetMax: audio?.onsetMax ?? 0,
  };
}

/**
 * T434 — Audio File In: the `movieFileIn` analog for sound.
 *
 * Same shape as the movie node on purpose (§V7-family: a user who learned one should
 * recognise the other): one `asset` parameter holding the file, resolved by the app's
 * capture hook the same tolerant way media sources read theirs. Its analysis lands in the
 * SAME per-frame feature record every audio node projects — so a bound file takes over
 * the session's one capture, and `audioIn` nodes read the file too (documented on both).
 *
 * T493 — THE TRANSPORT IS THE MOVIE NODE'S, LITERALLY: `MEDIA_TRANSPORT_PARAMETERS` is
 * one object spread into both nodes, so play mode, speed, cue, trim and the at-end
 * behaviour cannot drift into two meanings, and `mediaPlayhead` is the one function that
 * turns them into a position for both. Before it, this node had `file` and `monitor` and
 * looping was hard-coded in the capture hook.
 *
 * TWO CLOCKS LIVE HERE AND THEY ARE DIFFERENT (§V436, §V453), which is why both are named
 * in the description rather than one being allowed to stand for the node:
 *  - the CHANNELS are clockless — they report what the analyser heard this frame, so a
 *    timeline lap passes straight through them;
 *  - the PLAYHEAD is timeline-anchored — where the track is in the piece is the point, so
 *    it wraps at the lap by design and a scrub finds the same second of the track. T586
 *    made that the OPT-IN mode rather than the default (the owner's call: a track you drop
 *    in should play when you press Play), which changes which clock the node ARRIVES on,
 *    not which clocks it owns. Free run reproduces nothing, and the render command names
 *    this node when it is on rather than letting the take diverge quietly.
 */
export const audioFileInNode: NodeDefinition = {
  type: "audioFileIn",
  // Version 1 still: every T493 key carries a default, so no stored data changed shape,
  // and T586's move of the `playMode` default is a default read differently rather than
  // anything a `migrate` could rewrite. See the same note on `movieFileIn` (§V10).
  version: 1,
  title: "Audio File In",
  category: "input",
  description:
    "Plays an audio file with a transport — play mode, speed, cue, trim, at-end behaviour and volume — and publishes its features as channels: level, low / lowMid / highMid / high, and onset (an energy-rise envelope, not a beat detector — threshold it with Trigger). NO beat or bar channels: nothing here knows an arbitrary file's tempo, and a bar count guessed from one would be confidently wrong at exactly the moment you built a phrase on it. To get structure, run an Audio Pattern beside it set to the track's BPM and take bar/beat from there — lock this node's Play Mode to the timeline and the two stay in step across a lap, because Audio Pattern is timeline-anchored too. A bound file takes over the session's single audio capture. Its CHANNELS are clockless (§V436): they report what was heard this frame, so a timeline loop passes straight through them. Its PLAYHEAD is FREE RUN by default (T586): it keeps its own playhead, so Play and Cue Pulse drive it and a track you just dropped in plays as soon as you press Play, whatever the timeline is doing. Lock it to the timeline and the playhead becomes TIMELINE-ANCHORED instead: the position derives from the frame, so bar one of the track lands on the in point, a scrub finds the same second every time, and an offline render reproduces. Free run gives up all three of those, and a render says so by name rather than quietly handing you a take that differs from what you heard.",
  tags: ["value", "input", "audio", "music", "file", "fft", "transport"],
  inputs: [],
  outputs: [{ id: "out", label: "Out", type: VALUE_PORT }],
  parameters: {
    file: { type: "asset", label: "File", kind: "audio", group: "File" },
    ...MEDIA_TRANSPORT_PARAMETERS,
    volume: {
      type: "number",
      label: "Volume",
      group: "Transport",
      default: 1,
      min: 0,
      max: 2,
      range: "floor",
      step: 0.01,
      description:
        "Monitoring level. Does NOT touch the analysis — the channels report the file at unity however loud you are playing it, so turning the room down does not silently rescale everything driven by it.",
    },
    monitor: {
      type: "boolean",
      label: "Monitor",
      group: "Transport",
      default: true,
      description: "Play the file audibly while analysing it.",
    },
  },
  valueEvaluate: ({ audio }) => projectFeatures(audio),
  compile: (): CompiledNodeDescription => ({ passes: [] }),
};

/**
 * T442 — Audio Pattern: the audio path's TEST SIGNAL, and the reason the flagship
 * plays the moment it opens (B74, §V363: a demo must demonstrate itself).
 *
 * A deterministic beat — kick on the beat, snare on the off-beats, eighth-note hats —
 * synthesized as band envelopes from the FRAME CLOCK alone. Pure function of
 * (timeSeconds, deltaSeconds, params): no capture, no permission, no asset, and
 * therefore REPLAYABLE BY CONSTRUCTION — the deterministic audio source the capture
 * path cannot be, which is what a byte-identical replay gate needs (§V352 without even
 * a recorded track).
 *
 * It publishes the SAME channel set as audioIn/audioFileIn, so swapping a real source
 * in is replacing one node and keeping its label — every downstream edge and driven
 * channel reference survives untouched.
 *
 * `onsetCount` is computed over the frame INTERVAL (floor(beats(t)) − floor(beats(t−Δ)))
 * — so a low display rate under a high bpm honestly reports 2 events in one frame,
 * which makes this the first source to exercise T437's interval semantics beyond 0|1.
 */
/**
 * T701 — THE PATTERN'S BANDS LIVE IN THE ANALYSER'S DOMAIN, WHICH IS DECIBELS.
 *
 * `getByteFrequencyData` maps [-100, -30] dB onto 0..255, so an `audioIn` band channel
 * is literally `(dB + 100) / 70` — a LOGARITHM of amplitude. This node used to
 * synthesize its bands LINEAR in amplitude, and the two are different FUNCTIONS of the
 * same sound rather than the same function mis-scaled: a best-fit affine map between
 * them leaves 62-78% of the analyser's variance unexplained (T700), because no affine
 * map inverts a logarithm.
 *
 * What that cost, and why it is a defect rather than a taste gap (§V647): the pattern's
 * REST was real music's PEAK. Measured on E32, `low` sat at mean 0.25 / p01 0.12 under
 * the pattern and mean 0.89 / p01 0.72 under music, so every gain+bias pair fitted to
 * the pattern pinned against its ceiling the moment a real track was swapped in, and
 * §V477's "the bias is the rest state" was being satisfied against the wrong rest.
 * The node's own docblock promises that "swapping a real source in is replacing one
 * node" — the edges survived that swap and the MEANING did not.
 *
 * CONFIRMED LIVE, not modelled (T702, `src/tests/e2e/audio-analyser-domain.spec.ts`):
 * a real Chromium `AnalyserNode` reproduces the byte mapping on 20480/20480 bins with
 * zero error, and each band moves a fixed 0.142-0.144 per 10 dB against the predicted
 * 20/70 = 0.1429. The slope below is that measurement, not an assumption.
 *
 * ONE CONSTANT PER BAND, and it has to be per band. Music is not flat: across three
 * recorded tracks the analyser reads `low` at mean 0.88-0.91 but `high` at 0.03-0.42,
 * so a single calibration taken from `low` would fix the bottom and break the top.
 * Each reference is set so the band's FULL STRIKE lands on music's measured p99, and
 * the strike's own decay then places the rest — a real dB slope throughout, which is
 * what keeps `amount` behaving like the gain it claims to be (a halved `amount` is
 * -6 dB and costs 6/70 of every channel, exactly as it would on a live source).
 *
 * Resulting pattern distribution vs. the three tracks' p01 / mean / p99, all inside:
 *   low     rest 0.713 mean 0.775 peak 0.975 | music 0.69-0.83 / 0.88-0.91 / 0.96-0.98
 *   lowMid  rest 0.548 mean 0.573 peak 0.746 | music 0.39-0.45 / 0.54-0.64 / 0.71-0.77
 *   highMid rest 0.557 mean 0.572 peak 0.712 | music 0.05-0.37 / 0.19-0.57 / 0.50-0.72
 *   high    rest 0.381 mean 0.401 peak 0.574 | music 0.00-0.09 / 0.03-0.42 / 0.28-0.60
 *
 * `level` is deliberately NOT mapped: it is amplitude on BOTH paths already — the
 * analyser takes a time-domain RMS and this node sums linear envelopes — and it is the
 * control that made the diagnosis a measurement rather than an inference (§V648). It
 * is therefore computed from the LINEAR envelopes below, not from the published bands.
 */
const ANALYSER_DB_SPAN = 70;

/**
 * dB inside the analyser's window at which each band's full strike sits, chosen from
 * real music's p99: `low` 0.975 (strike is linear 1.0), `lowMid` 0.746 (0.74),
 * `highMid` 0.712 (0.35), `high` 0.574 (0.285). Measured on three recorded feature
 * tracks — clankz / factory / hollowed, 2370 frames each after the silent lead-in.
 */
const BAND_REFERENCE_DB = { low: 68.25, lowMid: 54.84, highMid: 58.96, high: 51.08 } as const;

/**
 * T776 — THE ARRANGEMENT, and it exists because a fixture with no dynamics taught every
 * consumer a signal real music does not send.
 *
 * §T701 calibrated this node's PEAK onto music's peak. Nothing calibrated its FLOOR or its
 * SPREAD, and one scalar per band cannot carry a distribution's shape — so every band's
 * p01 equalled its p10 equalled its MEDIAN: a periodic beat returns to the same floor every
 * bar and spends no time below it. Measured against three recorded tracks (N=2400 each),
 * the pattern's span (p99-p01) was `high` 0.181 vs music's 0.280-0.534 and `highMid` 0.145
 * vs 0.345-0.447 — roughly THREE TIMES too narrow — while `low` at 0.255 vs 0.150-0.281
 * already matched. That gap is the measured cause of §B154: a rest state fitted just under
 * a floor real music does not have sits INSIDE music's lower tail, and E24's lens weights
 * went negative for up to 99.9% of a track (§T738, §V756).
 *
 * The fix is STRUCTURE, not a smaller floor. Shrinking the constant term was tested and is
 * WRONG: in a log domain that term sets the median as much as the floor, so the whole
 * distribution TRANSLATES down instead of widening — the pattern's `high` median fell
 * 0.389 -> 0.208 and E24's warpc1 went from 0% to 92.8% negative, worse than before.
 * Spread needs the band to be sometimes ABSENT over a musical timescale, which is what an
 * arrangement is, and brief dips will not do it: a sub-second gap is smoothed away by the
 * Lag every consumer puts downstream. So the quiet passage is a whole BAR.
 *
 * PER-BAND depths, not one master gain, and that is load-bearing: a uniform pull-back blew
 * `low`'s span to 0.601 against music's 0.150-0.281 — it would have BROKEN the one band
 * that was already right. These depths are musically true for the same reason they measure
 * right: a breakdown drops the top end and keeps the kick.
 *
 * The medians are PRESERVED (low 0.737 -> 0.734, high 0.381 -> 0.381), so the distribution
 * widens without its centre moving and a parameter tuned to the pattern's typical value
 * still rests where it did. What is new is the tail.
 */
const ARRANGEMENT_BARS = 4;
const ARRANGEMENT_PULLBACK = { low: 0.9, lowMid: 0.4, highMid: 0.12, high: 0.07 } as const;

/** T707: where a full strike's onset lands — real music's measured max (0.25-0.29, N=3). */
const ONSET_REFERENCE = 0.28;

/** Linear band amplitude → the analyser's byte-fraction domain. Silence reads 0, as it does live. */
function toAnalyserDomain(linear: number, referenceDb: number): number {
  if (linear <= 0) return 0;
  const channel = (20 * Math.log10(linear) + referenceDb) / ANALYSER_DB_SPAN;
  if (channel <= 0) return 0;
  return channel >= 1 ? 1 : channel;
}

export const audioPatternNode: NodeDefinition = {
  type: "audioPattern",
  version: 1,
  title: "Audio Pattern",
  category: "value",
  description:
    "A deterministic test beat as audio channels — kick, off-beat snare, eighth hats — synthesized from the frame clock. Publishes the same level/band/onset channels as Audio In, so swapping in a live source is one node — the bands are published in the ANALYSER'S OWN DECIBEL DOMAIN (T701), calibrated so a full strike lands where real music's peaks land, which is what makes a parameter tuned here still have range under a real track. PLUS the musical structure only a node that knows its own tempo can publish: beat and bar count from the in point, beatPhase and barPhase ramp 0..1 inside each. Wire bar into Step to hold a value for a phrase. No microphone, no file, replayable by construction. TIMELINE-ANCHORED by design (§V436): it stands in for a track playing along the piece, so beat one lands at the in point and a scrub finds the same beat every time. A free-running version would drift out of step with the picture it is scoring.",
  tags: ["value", "audio", "test", "beat", "pattern", "deterministic"],
  inputs: [],
  outputs: [{ id: "out", label: "Out", type: VALUE_PORT }],
  parameters: {
    bpm: { type: "number", label: "BPM", default: 112, min: 20, max: 300, range: "floor" },
    amount: { type: "number", label: "Amount", default: 1, min: 0, max: 1, range: "bounded", description: "Master gain on every channel." },
    /**
     * T776 — how deeply the last bar of every four pulls back. 1 is the measured setting
     * that puts the bands on real music's spread; 0 restores the flat pre-T776 fixture for
     * anyone who needs the old numbers back.
     */
    arrangement: {
      type: "number",
      label: "Arrangement",
      default: 1,
      min: 0,
      max: 1,
      range: "bounded",
      description:
        "Depth of the four-bar arrangement: the last bar of every four drops the top end and keeps the kick, the way a breakdown does. This is what gives the bands the SPREAD real music has — a flat pattern tunes every consumer against a floor music never sends. 0 is the old flat beat.",
    },
    /**
     * T548 — the time signature, so `bar` means something. Four is the overwhelming
     * default and three is the other one people actually reach for, so it is a plain
     * number rather than an enum: 7 is a legitimate answer and a picker would refuse it.
     */
    beatsPerBar: {
      type: "number",
      label: "Beats / Bar",
      default: 4,
      min: 1,
      max: 32,
      step: 1,
      range: "floor",
      description: "How many beats make a bar — what the bar and barPhase channels count in.",
    },
  },
  valueEvaluate: ({ values, frame }) => {
    const bpm = typeof values["bpm"] === "number" ? values["bpm"] : 112;
    const amount = typeof values["amount"] === "number" ? values["amount"] : 1;
    const beats = (frame.timeSeconds * bpm) / 60;
    const beatsBefore = ((frame.timeSeconds - frame.deltaSeconds) * bpm) / 60;
    const beatPhase = beats - Math.floor(beats);

    /* Exponential strikes: an instant attack on the boundary, a musical decay after. */
    const kick = Math.exp(-beatPhase * 7);
    const snare = Math.floor(beats) % 2 === 1 ? Math.exp(-beatPhase * 9) * 0.8 : 0;
    const hatPhase = beats * 2 - Math.floor(beats * 2);
    const hat = Math.exp(-hatPhase * 14) * 0.5;

    /*
     * The strike envelopes, LINEAR in amplitude — the physical quantity `amount` gains.
     * They are the input to the dB map above, and `level`'s RMS-like sum still reads
     * them directly: only the four BAND channels are published in the analyser's domain.
     */
    /*
     * T776's arrangement. `beatsPerBar` is read here rather than further down because the
     * bar is now structural: it decides what the BANDS do, not just what `bar` counts.
     * A clean cut on the bar line is what a breakdown actually does, and every consumer
     * already has a Lag to soften it.
     *
     * `onset` is deliberately NOT scaled: it rides the strike envelopes, and §T707
     * established that no shipped example drives from `:onset` (they read `:onsetCount`).
     * `level` needs no special case — it is summed from these amplitudes below.
     */
    const beatsPerBar = Math.max(1, Math.floor(typeof values["beatsPerBar"] === "number" ? values["beatsPerBar"] : 4));
    const arrangement = Math.min(1, Math.max(0, typeof values["arrangement"] === "number" ? values["arrangement"] : 1));
    const quiet = Math.max(0, beats) / beatsPerBar % ARRANGEMENT_BARS >= ARRANGEMENT_BARS - 1;
    const pull = (band: keyof typeof ARRANGEMENT_PULLBACK): number =>
      quiet ? 1 - arrangement * (1 - ARRANGEMENT_PULLBACK[band]) : 1;

    const lowAmplitude = (0.12 + 0.88 * kick) * amount * pull("low");
    const lowMidAmplitude = (0.15 + 0.55 * snare + 0.15 * kick) * amount * pull("lowMid");
    const highMidAmplitude = (0.1 + 0.5 * hat) * amount * pull("highMid");
    const highAmplitude = (0.06 + 0.45 * hat) * amount * pull("high");
    const low = toAnalyserDomain(lowAmplitude, BAND_REFERENCE_DB.low);
    const lowMid = toAnalyserDomain(lowMidAmplitude, BAND_REFERENCE_DB.lowMid);
    const highMid = toAnalyserDomain(highMidAmplitude, BAND_REFERENCE_DB.highMid);
    const high = toAnalyserDomain(highAmplitude, BAND_REFERENCE_DB.high);
    /* T437's interval semantics, honestly: a slow frame under a fast bpm counts 2. */
    const onsetCount = Math.max(0, Math.floor(beats) - Math.floor(Math.max(beatsBefore, 0)));
    /*
     * T707 — onset is CALIBRATED like the bands, not just shaped like them. The real
     * path's onset is a spectral-flux ENVELOPE that reads mean 0.014-0.033, p99
     * 0.13-0.20, max 0.25-0.29 across 2370 frames × 3 recorded tracks — this channel
     * used to peak at 1.0, roughly 3.5× hot, so anything tuned against it would slam
     * on a real track's gentlest rise. Same construction as the band references: the
     * pattern's full strike lands on music's measured MAX. Same N=3 caveat as the
     * bands, carried rather than hidden. `onsetCount` needs none of this — it is an
     * event count on both paths.
     */
    const onset = Math.max(kick, snare, hat) * amount * ONSET_REFERENCE;

    /*
     * T548 — MUSICAL STRUCTURE AS CHANNELS, which is the middle TIMESCALE the value graph
     * had no way to address. E24 and E31 vary at two rates: per FRAME (the bands) and per
     * PIECE (a half-minute LFO). Nothing happened at PHRASE length, and that middle rate is
     * most of what separates a loop from a performance.
     *
     * TD's Beat CHOP publishes a ramp, a pulse and a count per unit, and the ramp and the
     * count are the two this node can honestly give: a PULSE is already `onsetCount` here,
     * measured over the frame INTERVAL (T437), and a second pulse computed a second way
     * would be §V109's two answers to one question.
     *
     * `beat` and `bar` COUNT — 0 at the in point, monotonic, integers. `beatPhase` and
     * `barPhase` RAMP 0..1 within each. Both phases exist, rather than only the bar's:
     * a bar phase without a beat phase invites `barPhase * beatsPerBar % 1`, which is the
     * beat phase computed by hand and wrong at the wrap.
     *
     * TIMELINE-ANCHORED, inherited rather than chosen: these are `beats` — the same number
     * the bands are already synthesized from — so structure and sound cannot disagree about
     * where in the piece they are. That is the whole reason the count is derived HERE and
     * not by a downstream node with a clock of its own.
     */
    const beatIndex = Math.floor(Math.max(0, beats));
    const barPosition = Math.max(0, beats) / beatsPerBar;

    return {
      level: 0.3 * lowAmplitude + 0.3 * lowMidAmplitude + 0.2 * highMidAmplitude + 0.2 * highAmplitude,
      low,
      lowMid,
      highMid,
      high,
      onset,
      onsetCount,
      // The interval peak is the same envelope's unit, so it wears the same calibration.
      onsetMax: onsetCount > 0 ? amount * ONSET_REFERENCE : onset,
      beat: beatIndex,
      beatPhase: Math.max(0, beats) - beatIndex,
      bar: Math.floor(barPosition),
      barPhase: barPosition - Math.floor(barPosition),
    };
  },
  compile: (): CompiledNodeDescription => ({ passes: [] }),
};

