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
  category: "value",
  description:
    "The session's audio input as channels: level (RMS), low / lowMid / highMid / high band energies, and onset — a spectral-flux envelope that rises on ANY energy increase, not a beat detector; threshold it with Trigger. Silent (all zeros) when no audio input is live.",
  tags: ["value", "input", "audio", "sound", "music", "fft"],
  inputs: [],
  outputs: [{ id: "out", label: "Out", type: VALUE_PORT }],
  parameters: {
    /*
     * Capture configuration, read by the APP's capture hook — never by compile. The
     * session has ONE audio input (like it has one pointer); when several audioIn
     * nodes exist, the first by node id configures the capture and all of them read
     * the same features.
     */
    source: {
      type: "enum",
      label: "Source",
      default: "mic",
      options: [
        { value: "mic", label: "Microphone" },
        { value: "file", label: "File / URL" },
      ],
    },
    url: {
      type: "string",
      label: "URL",
      default: "",
      inactiveWhen: (values) => (values["source"] === "mic" ? "The microphone needs no URL." : null),
      description: "Audio file to play and analyse. Loops.",
    },
    monitor: {
      type: "boolean",
      label: "Monitor",
      default: true,
      inactiveWhen: (values) => (values["source"] === "mic" ? "Monitoring a live microphone would feed back." : null),
      description: "Play the file audibly while analysing it.",
    },
  },
  valueEvaluate: ({ audio }) => ({
    level: audio?.level ?? 0,
    low: audio?.low ?? 0,
    lowMid: audio?.lowMid ?? 0,
    highMid: audio?.highMid ?? 0,
    high: audio?.high ?? 0,
    onset: audio?.onset ?? 0,
  }),
  compile: (): CompiledNodeDescription => ({ passes: [] }),
};
