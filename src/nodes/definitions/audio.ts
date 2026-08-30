import type { CompiledNodeDescription, NodeDefinition } from "../../domain/types/node-definition.ts";
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
    "The session's audio input as channels: level (RMS), low / lowMid / highMid / high band energies, and onset — a spectral-flux envelope that rises on ANY energy increase, not a beat detector; threshold it with Trigger. Silent (all zeros) when no audio input is live. CLOCKLESS (§V436): the numbers come from what the analyser heard this frame, so a timeline loop passes straight through them.",
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
 * capture hook the same tolerant way media sources read theirs. The file loops, plays
 * audibly when `monitor` is on, and its analysis lands in the SAME per-frame feature
 * record every audio node projects — so a bound file takes over the session's one
 * capture, and `audioIn` nodes read the file too (documented on both).
 */
export const audioFileInNode: NodeDefinition = {
  type: "audioFileIn",
  version: 1,
  title: "Audio File In",
  category: "input",
  description:
    "Plays an audio file and publishes its features as channels: level, low / lowMid / highMid / high, and onset (an energy-rise envelope, not a beat detector — threshold it with Trigger). A bound file takes over the session's single audio capture. CLOCKLESS (§V436): the channels report what was heard this frame, so a timeline loop passes straight through them.",
  tags: ["value", "input", "audio", "music", "file", "fft"],
  inputs: [],
  outputs: [{ id: "out", label: "Out", type: VALUE_PORT }],
  parameters: {
    file: { type: "asset", label: "File", kind: "audio" },
    monitor: {
      type: "boolean",
      label: "Monitor",
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
export const audioPatternNode: NodeDefinition = {
  type: "audioPattern",
  version: 1,
  title: "Audio Pattern",
  category: "value",
  description:
    "A deterministic test beat as audio channels — kick, off-beat snare, eighth hats — synthesized from the frame clock. Same channels as Audio In (level, bands, onset, onsetCount, onsetMax), so swapping in a live source is one node. No microphone, no file, replayable by construction. TIMELINE-ANCHORED by design (§V436): it stands in for a track playing along the piece, so beat one lands at the in point and a scrub finds the same beat every time. A free-running version would drift out of step with the picture it is scoring.",
  tags: ["value", "audio", "test", "beat", "pattern", "deterministic"],
  inputs: [],
  outputs: [{ id: "out", label: "Out", type: VALUE_PORT }],
  parameters: {
    bpm: { type: "number", label: "BPM", default: 112, min: 20, max: 300 },
    amount: { type: "number", label: "Amount", default: 1, min: 0, max: 1, description: "Master gain on every channel." },
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

    const low = (0.12 + 0.88 * kick) * amount;
    const lowMid = (0.15 + 0.55 * snare + 0.15 * kick) * amount;
    const highMid = (0.1 + 0.5 * hat) * amount;
    const high = (0.06 + 0.45 * hat) * amount;
    /* T437's interval semantics, honestly: a slow frame under a fast bpm counts 2. */
    const onsetCount = Math.max(0, Math.floor(beats) - Math.floor(Math.max(beatsBefore, 0)));
    const onset = Math.max(kick, snare, hat) * amount;

    return {
      level: 0.3 * low + 0.3 * lowMid + 0.2 * highMid + 0.2 * high,
      low,
      lowMid,
      highMid,
      high,
      onset,
      onsetCount,
      onsetMax: onsetCount > 0 ? amount : onset,
    };
  },
  compile: (): CompiledNodeDescription => ({ passes: [] }),
};

