import { describe, expect, it } from "vitest";

import { nodeGpuHost, probeDawn } from "../../runtime/backend/vgpu/node-gpu-host.ts";
import { renderHeadless } from "./render-harness.ts";
import { EXAMPLE_DOCUMENTS } from "../../examples/documents.ts";
import { starterComponentsView } from "../../examples/component-files.ts";
import { AUDIO_DETECTOR_DEFAULTS } from "../../nodes/definitions/audio.ts";
import { analyseOffline } from "../../app/audio-offline-analysis.ts";
import { readTrackAtPlayhead } from "../../app/audio-pre-analysis.ts";
import { createFeatureTrackRecorder, featureTrackLength, readFeatureFrame } from "../../domain/audio/feature-track.ts";
import type { FeatureTrack } from "../../domain/audio/feature-track.ts";
import type { MediaTransportValues } from "../../domain/media/transport.ts";
import type { GraphDocument, ProjectDocument } from "../../domain/types/graph.ts";

/**
 * T1229 — the offline track is a REAL consumer of §T431's replay half: a bound file,
 * pre-analysed, indexed by the timeline playhead, rendered through the engine's audio
 * seam. `audio-track-replay.test.ts` proved a recorded track replays its performance;
 * this file proves the track a file yields offline renders reproducibly, and that the
 * transport — not the frame loop's history — decides which frame of it a render reads.
 *
 * The graph is E24 with its pattern stand-in swapped for `audioIn`, the substitution
 * E24's own docblock names; the sound is the synthetic click track pinned frame by frame
 * in `audio-offline-analysis.test.ts`. Neither is restated here.
 */

const e24 = EXAMPLE_DOCUMENTS.find((doc) => doc.name === "E24 Audio Reaction-Diffusion") as ProjectDocument;
const FPS = 60;
const FRAMES = 40;
const SAMPLE_RATE = 48_000;
const SECONDS = 12;

/** The click track of `audio-offline-analysis.test.ts`: 125 BPM from 0.5 s, accents every fourth. */
function clickTrack(): Float32Array {
  const pcm = new Float32Array(SAMPLE_RATE * SECONDS);
  for (let index = 0; index < 24; index += 1) {
    const start = Math.round((0.5 + index * 0.48) * SAMPLE_RATE);
    const height = index % 4 === 0 ? 1 : 0.5;
    for (let i = 0; i < 0.08 * SAMPLE_RATE && start + i < pcm.length; i += 1) {
      pcm[start + i] = height * Math.sin((2 * Math.PI * 60 * i) / SAMPLE_RATE) * Math.exp(-i / (0.02 * SAMPLE_RATE));
    }
  }
  return pcm;
}

function graphDrivenByAudioIn(): GraphDocument {
  const music = e24.graph.nodes["music"];
  if (music === undefined) throw new Error("E24 has no `music` node to swap");
  return {
    ...e24.graph,
    nodes: { ...e24.graph.nodes, music: { ...music, type: "audioIn", parameters: {} } },
  };
}

const TIMELINE: MediaTransportValues = {
  playMode: "timeline",
  play: true,
  speed: 1,
  cue: false,
  cuePoint: 0,
  trimStart: 0,
  trimEnd: 0,
  extend: "hold",
};

/** What `useAudioInput.read` does under the lock: the harness's frame index is the timeline. */
function scrub(track: FeatureTrack, transport: MediaTransportValues) {
  return (frameIndex: number) => readTrackAtPlayhead(track, transport, frameIndex / FPS, SECONDS, 0);
}

describe("T1229 — a pre-analysed file renders reproducibly, indexed by the transport", async () => {
  const { track } = analyseOffline(clickTrack(), SAMPLE_RATE, FPS, AUDIO_DETECTOR_DEFAULTS);

  // T1234: E24 instances the AudioAnalysis component; the starter library supplies it.
  const components = await starterComponentsView();
  const common = {
    host: nodeGpuHost(),
    settings: e24.settings,
    components,
    frames: FRAMES,
    capture: [FRAMES - 1],
    outputNodeId: "out",
    fps: FPS,
    animate: true,
    graph: graphDrivenByAudioIn(),
  } as const;

  it("the same file renders the same pixels twice, and a silent file renders different ones", async () => {
    const probe = await probeDawn();
    if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);

    const first = await renderHeadless({ ...common, audio: scrub(track, TIMELINE) });
    expect(first.diagnostics.filter((entry) => entry.severity === "error")).toEqual([]);
    const second = await renderHeadless({ ...common, audio: scrub(track, TIMELINE) });
    expect(
      Buffer.compare(first.frames[0]?.bytes as Uint8Array, second.frames[0]?.bytes as Uint8Array),
      "the same pre-analysed file rendered different pixels twice",
    ).toBe(0);

    // NON-VACUITY: the first click lands inside these 40 frames (0.5 s, frame 31), so a
    // file with no click must render a different picture through the identical path.
    const silent = analyseOffline(new Float32Array(SAMPLE_RATE * SECONDS), SAMPLE_RATE, FPS, AUDIO_DETECTOR_DEFAULTS);
    const inSilence = await renderHeadless({ ...common, audio: scrub(silent.track, TIMELINE) });
    expect(
      Buffer.compare(first.frames[0]?.bytes as Uint8Array, inSilence.frames[0]?.bytes as Uint8Array),
      "a silent file rendered the same pixels as the click track — the track reaches nothing",
    ).not.toBe(0);
  }, 240_000);

  it("a trimmed transport reads the file from its in point: the engine is fed frame 360 + i, not i", async () => {
    const probe = await probeDawn();
    if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);

    const trimmed = { ...TIMELINE, trimStart: 6 };
    const captured = createFeatureTrackRecorder(FPS);
    const result = await renderHeadless({ ...common, audio: scrub(track, trimmed), recordAudio: captured });
    expect(result.diagnostics.filter((entry) => entry.severity === "error")).toEqual([]);

    // What the engine READ, frame by frame, is the file at 6 s + i/fps — the scrub claim
    // through the real seam: no frame depends on the frames rendered before it.
    const read = captured.track();
    expect(featureTrackLength(read)).toBe(FRAMES);
    for (let index = 0; index < FRAMES; index += 1) {
      expect(readFeatureFrame(read, index)).toEqual(readFeatureFrame(track, 6 * FPS + index));
    }
    // And the window at 6 s holds a click of its own (6.26 s, index 12), so the read is
    // not silence agreeing with silence.
    const kicks = Array.from({ length: FRAMES }, (_, index) => readFeatureFrame(read, index).kickCount);
    expect(kicks.reduce((sum, count) => sum + count, 0)).toBe(1);

    // The pixels follow: a different in point is a different picture.
    const fromStart = await renderHeadless({ ...common, audio: scrub(track, TIMELINE) });
    expect(
      Buffer.compare(result.frames[0]?.bytes as Uint8Array, fromStart.frames[0]?.bytes as Uint8Array),
      "trimming the file to 6 s rendered the same pixels as reading it from 0 s",
    ).not.toBe(0);
  }, 240_000);
});
