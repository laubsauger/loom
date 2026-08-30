import { describe, expect, it } from "vitest";

import { nodeGpuHost, probeDawn } from "../../runtime/backend/vgpu/node-gpu-host.ts";
import { offlineTransport } from "../../runtime/execution/index.ts";
import { renderHeadless } from "./render-harness.ts";
import { EXAMPLE_DOCUMENTS } from "../../examples/documents.ts";
import { audioPatternNode } from "../../nodes/definitions/audio.ts";
import type { GraphDocument, ProjectDocument } from "../../domain/types/graph.ts";
import type { AudioFeatures } from "../../domain/types/frame.ts";
import type { FeatureTrack } from "../../domain/audio/feature-track.ts";
import {
  createFeatureTrackRecorder,
  featureTrackLength,
  featureTrackPlayer,
  parseFeatureTrack,
  readFeatureFrame,
  serializeFeatureTrack,
} from "../../domain/audio/feature-track.ts";

/**
 * T431 — RECORD, STORE, REPLAY, and prove the replay is the performance (§V352).
 *
 * `audio-replay.test.ts` proved the acceptance SHAPE with no recording involved: E24's
 * synthetic pattern is a pure function of the frame clock, so it renders identically
 * twice by construction. That is the control this file needs and could not otherwise
 * have — a deterministic source to record FROM, whose pictures are already known.
 *
 * The claim here is stronger and is the one T431 exists for: a recorded track, written
 * to text, read back, and fed through the engine's audio seam renders the SAME PIXELS as
 * the live source it was recorded from. If that holds, "render this performance offline"
 * is real; if it does not, a recorded track is a plausible file that renders a
 * performance nobody played.
 *
 * ## Why the graph is edited to swap one node
 *
 * E24's own docblock states the swap: `audioPattern` is a stand-in, and replacing that
 * ONE node with `audioIn` — keeping the label — makes every downstream mapping drive
 * from the session's feature record instead. That is exactly the substitution a replay
 * performs, so the test performs it literally rather than describing it.
 */

const e24 = EXAMPLE_DOCUMENTS.find((doc) => doc.name === "E24 Audio Reaction-Diffusion") as ProjectDocument;
const FPS = 60;
const FRAMES = 40;

/** The pattern's own definition, frame by frame — not a reimplementation of its maths. */
function trackFromPattern(frames: number): FeatureTrack {
  const music = e24.graph.nodes["music"];
  if (music === undefined) throw new Error("E24 has no `music` node to record from");
  // Read the document's OWN parameters rather than restating 112/1 here: a test that
  // hardcodes them would keep passing after someone retunes the example, while rendering
  // a different beat from the one E24 actually plays.
  const values: Record<string, number> = {};
  for (const [key, stored] of Object.entries(music.parameters ?? {})) {
    if (typeof stored !== "number") throw new Error(`E24's music.${key} is not a static number`);
    values[key] = stored;
  }
  const transport = offlineTransport({ fps: FPS, seed: e24.settings.randomSeed, mode: "fixed-step" });
  const recorder = createFeatureTrackRecorder(FPS);
  for (let index = 0; index < frames; index += 1) {
    const frame = transport.next();
    const channels = audioPatternNode.valueEvaluate?.({
      inputs: {},
      values,
      frame,
      state: {},
    });
    if (channels === undefined) throw new Error("audioPattern published no channels");
    recorder.capture(index, channels as unknown as AudioFeatures);
  }
  return recorder.track();
}

/** E24 with its pattern stand-in replaced by the live audio source (the documented swap). */
function graphDrivenByAudioIn(): GraphDocument {
  const music = e24.graph.nodes["music"];
  if (music === undefined) throw new Error("E24 has no `music` node to swap");
  return {
    ...e24.graph,
    nodes: { ...e24.graph.nodes, music: { ...music, type: "audioIn", parameters: {} } },
  };
}

describe("T431 — a recorded feature track replays the performance it recorded (§V352)", () => {
  it("renders the same pixels from a stored track as from the live source", async () => {
    const probe = await probeDawn();
    if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);

    const common = {
      host: nodeGpuHost(),
      settings: e24.settings,
      frames: FRAMES,
      capture: [FRAMES - 1],
      outputNodeId: "out",
      fps: FPS,
      animate: true,
    } as const;

    // 1. The performance: E24 driven by its own deterministic pattern node.
    const live = await renderHeadless({ ...common, graph: e24.graph });
    expect(live.diagnostics.filter((entry) => entry.severity === "error")).toEqual([]);

    // 2. The recording, THROUGH A FILE. Serialising and parsing is not ceremony: a track
    //    that only works while still in memory is not a recording, and the version check
    //    lives in the parser.
    const stored = serializeFeatureTrack(trackFromPattern(FRAMES));
    const parsed = parseFeatureTrack(stored);
    expect(parsed.ok, "the recorded track did not survive being written and read back").toBe(true);
    if (!parsed.ok) return;
    expect(featureTrackLength(parsed.track)).toBe(FRAMES);

    // 3. The replay: the same graph with `audioIn` in place of the pattern, fed the track
    //    through the engine's audio seam — and RECORDING what it is fed, so the round trip
    //    is closed rather than assumed.
    const captured = createFeatureTrackRecorder(FPS);
    const replayed = await renderHeadless({
      ...common,
      graph: graphDrivenByAudioIn(),
      audio: featureTrackPlayer(parsed.track),
      recordAudio: captured,
    });
    expect(replayed.diagnostics.filter((entry) => entry.severity === "error")).toEqual([]);

    // THE CLAIM: the replay is the performance, to the byte.
    expect(
      Buffer.compare(live.frames[0]?.bytes as Uint8Array, replayed.frames[0]?.bytes as Uint8Array),
      "a replayed track rendered different pixels from the source it was recorded from",
    ).toBe(0);

    // And what the engine READ on the way through is what the track held — the capture
    // path and the replay path agree, which is what makes re-recording a replay lossless.
    expect(captured.track().frames).toEqual(parsed.track.frames);

    // NON-VACUITY, and this test is worthless without it. "Replay matches live" would
    // hold trivially if the audio never reached pixels at all — every render would be the
    // same picture and the comparison would be comparing nothing. A DIFFERENT track must
    // therefore produce a DIFFERENT picture through the identical code path.
    const silent = createFeatureTrackRecorder(FPS);
    for (let index = 0; index < FRAMES; index += 1) silent.capture(index, null);
    const inSilence = await renderHeadless({
      ...common,
      graph: graphDrivenByAudioIn(),
      audio: featureTrackPlayer(silent.track()),
    });
    expect(
      Buffer.compare(live.frames[0]?.bytes as Uint8Array, inSilence.frames[0]?.bytes as Uint8Array),
      "a silent track rendered the same pixels as the performance — the audio reaches nothing",
    ).not.toBe(0);
  }, 240_000);

  it("replays byte-identically twice — T431's acceptance test", async () => {
    const probe = await probeDawn();
    if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);

    const parsed = parseFeatureTrack(serializeFeatureTrack(trackFromPattern(FRAMES)));
    if (!parsed.ok) throw new Error("the recorded track did not parse");

    const run = () =>
      renderHeadless({
        host: nodeGpuHost(),
        graph: graphDrivenByAudioIn(),
        settings: e24.settings,
        frames: FRAMES,
        capture: [FRAMES - 1],
        outputNodeId: "out",
        fps: FPS,
        animate: true,
        audio: featureTrackPlayer(parsed.track),
      });

    const first = await run();
    const second = await run();
    expect(
      Buffer.compare(first.frames[0]?.bytes as Uint8Array, second.frames[0]?.bytes as Uint8Array),
      "the same track rendered twice produced different pixels",
    ).toBe(0);
  }, 240_000);

  it("renders SILENCE past the end of the track rather than freezing or looping", async () => {
    const probe = await probeDawn();
    if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);

    // A track shorter than the render. §V288: the extra frames have no recorded sound,
    // and silence is the only answer that says so — holding would freeze a transient at
    // full level, looping would invent structure the performance never had.
    const short = parseFeatureTrack(serializeFeatureTrack(trackFromPattern(10)));
    if (!short.ok) throw new Error("the short track did not parse");
    const play = featureTrackPlayer(short.track);
    expect(play(9).level).toBeGreaterThan(0);
    expect(play(10)).toEqual(readFeatureFrame(short.track, 9999));

    const captured = createFeatureTrackRecorder(FPS);
    const result = await renderHeadless({
      host: nodeGpuHost(),
      graph: graphDrivenByAudioIn(),
      settings: e24.settings,
      frames: 20,
      capture: [19],
      outputNodeId: "out",
      fps: FPS,
      animate: true,
      audio: play,
      recordAudio: captured,
    });
    expect(result.diagnostics.filter((entry) => entry.severity === "error")).toEqual([]);

    // What the engine read past the end really was silence, recorded as such.
    const readBack = captured.track();
    expect(readFeatureFrame(readBack, 15).level).toBe(0);
    expect(readFeatureFrame(readBack, 9).level).toBeGreaterThan(0);
  }, 240_000);
});
