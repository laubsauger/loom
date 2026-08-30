import { describe, expect, it } from "vitest";

import { nodeGpuHost, probeDawn } from "../../runtime/backend/vgpu/node-gpu-host.ts";
import { renderHeadless } from "./render-harness.ts";
import { EXAMPLE_DOCUMENTS } from "../../examples/documents.ts";
import type { ProjectDocument } from "../../domain/types/graph.ts";

/**
 * T442: the flagship demonstrates ITSELF — deterministically (B74, §V363).
 *
 * E24's music source is the synthetic pattern: a pure function of the frame clock, so
 * an audio-reactive render is REPLAYABLE BY CONSTRUCTION — the acceptance shape T431's
 * recorded tracks will have to meet, met today with no recording involved. And the
 * B15/§V361 half: the audio drive must reach PIXELS — a beat-driven render must differ
 * from the same graph rendered without its value graph, or every mapping in the
 * flagship is a wire that changes nothing when cut.
 */

const e24 = EXAMPLE_DOCUMENTS.find((doc) => doc.name === "E24 Audio Reaction-Diffusion") as ProjectDocument;

describe("E24 replays and reacts (T442, §V363)", () => {
  it("renders byte-identically twice with the value graph LIVE, and differently without it", async () => {
    const probe = await probeDawn();
    if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);

    const run = (animate: boolean) =>
      renderHeadless({
        host: nodeGpuHost(),
        graph: e24.graph,
        settings: e24.settings,
        frames: 40,
        capture: [39],
        outputNodeId: "out",
        animate,
      });

    const first = await run(true);
    const second = await run(true);
    expect(first.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    // Determinism by construction: same clock, same pattern, same bytes.
    expect(Buffer.compare(first.frames[0]?.bytes as Uint8Array, second.frames[0]?.bytes as Uint8Array)).toBe(0);

    // §V361: what observable differs if the drive is cut? THIS one. Without the value
    // graph the beat never reaches substeps, chemistry or colour — the pictures differ.
    const still = await run(false);
    expect(Buffer.compare(first.frames[0]?.bytes as Uint8Array, still.frames[0]?.bytes as Uint8Array)).not.toBe(0);
  }, 240_000);
});
