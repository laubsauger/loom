import { describe, expect, it } from "vitest";

import type { GraphDocument } from "../domain/types/graph.ts";
import { SHOWCASE_BEAT_FILE } from "./build-showcase-beat.ts";
import { shippedClipAudio } from "./shipped-clip-audio.ts";

/**
 * T1312b — THE DOCUMENT'S SYNC OFFSET REACHES THE OFFLINE FEED, OR LIVE AND OFFLINE DISAGREE.
 *
 * The offset exists because the picture lands after the sound it reacts to: analysis
 * describes the sound now, then the graph evaluates, the GPU renders and the compositor
 * presents. Reading the pre-analysed track AHEAD by that latency pulls the picture back onto
 * the beat without touching playback.
 *
 * The hazard the gate is for is not the arithmetic — `audio-pre-analysis.test.ts` pins that —
 * it is that this file is a SECOND surface reading the same track. The app applies the offset
 * per frame from the node's resolved parameters; if this one ignored it, every shipped gate,
 * thumbnail, look baseline and cook-oracle run would hear a different frame than the app,
 * which is §V47 gone and would show up as claims that pass while the app is visibly late.
 */

const FPS = 60;

function graphWith(parameters: Record<string, unknown>): GraphDocument {
  return {
    revision: 1,
    nodes: {
      clip1: {
        id: "clip1",
        type: "audioFileIn",
        definitionVersion: 1,
        position: { x: 0, y: 0 },
        label: "clip1",
        parameters: { file: SHOWCASE_BEAT_FILE, playMode: "timeline", ...parameters },
      },
    },
    edges: {},
    groups: {},
  } as unknown as GraphDocument;
}

describe("T1312b — the sync offset is the document's, on every surface that reads the track", () => {
  it("reads the same frame ahead that the same offset reads on the playhead", () => {
    const plain = shippedClipAudio(graphWith({}), FPS);
    const led = shippedClipAudio(graphWith({ syncOffset: 0.25 }), FPS);
    if (plain === undefined || led === undefined) throw new Error("the showcase clip is bound; both feeds must exist");

    // A quarter second of lead at 60 fps is fifteen frames: the feed at frame 100 hears what
    // the un-led feed hears at 115. Exact, on a real analysed clip, not a tolerance.
    const AT = 100;
    const LEAD_FRAMES = 15;
    expect(led(AT)).toEqual(plain(AT + LEAD_FRAMES));
    expect(led(AT + 30)).toEqual(plain(AT + 30 + LEAD_FRAMES));
  });

  it("is OFF at its default, so every shipped document hears exactly what it heard before", () => {
    // The claim that makes this landable without re-recording the catalogue: a document that
    // never stored the parameter, and one that stored its default, are the same sound.
    const unset = shippedClipAudio(graphWith({}), FPS);
    const zero = shippedClipAudio(graphWith({ syncOffset: 0 }), FPS);
    if (unset === undefined || zero === undefined) throw new Error("both feeds must exist");
    for (const frameIndex of [0, 1, 37, 292, 600]) {
      expect(zero(frameIndex), `frame ${String(frameIndex)}`).toEqual(unset(frameIndex));
    }
  });

  it("moves the sound NOWHERE: a lead changes which features a frame hears, not the clip", () => {
    // The trap this row was opened around: `readTrackAtPlayhead` and `applyMediaPlayhead` take
    // the same transport, so an offset on the TRANSPORT would have moved playback instead of
    // the picture. Here the proof is structural — the led feed's frames all exist in the
    // un-led feed's own sequence, simply earlier, so nothing was resampled or re-timed.
    const plain = shippedClipAudio(graphWith({}), FPS);
    const led = shippedClipAudio(graphWith({ syncOffset: 0.1 }), FPS);
    if (plain === undefined || led === undefined) throw new Error("both feeds must exist");
    const shifted = [0, 25, 50].map((frameIndex) => led(frameIndex));
    const original = [0, 25, 50].map((frameIndex) => plain(frameIndex + 6));
    expect(shifted).toEqual(original);
  });
});
