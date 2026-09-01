import { beforeAll, describe, expect, it } from "vitest";

import { createValueGraphSession } from "../domain/channels/value-graph.ts";
import type { GraphDocument } from "../domain/types/graph.ts";
import { nodeGpuHost, probeDawn } from "../runtime/backend/vgpu/node-gpu-host.ts";
import { toRgba8 } from "../runtime/export/image.ts";
import { BYTES_PER_PIXEL } from "../runtime/export/pixel-format.ts";
import { renderHeadless } from "../tests/headless/render-harness.ts";
import { listExamples } from "./catalogue.ts";
import { exampleRegistry, requireExample } from "./runner.ts";

/**
 * T819 — E45's claims. The one that matters most is the SET's:
 *
 * THE PHRASE HOLD (§T749's beat quantisation generalised to phrase length, §V681): the
 * shot mix HOLDS between structural boundaries and CHANGES across one. That is the
 * difference between a VJ set and a slideshow, it is the owner's own definition of
 * "evolution", and no still frame or look baseline can see it — only a cross-frame
 * claim can. It is asserted at the CHANNEL level against the structure itself: the held
 * value may change exactly when the 4-bar phrase index changes, never inside one.
 *
 * The pixel corroboration keeps the channel claim honest about reaching the screen: a
 * mostly-A phrase and a mostly-B phrase render frames that differ massively.
 *
 * THE WEB IS THE MUSIC: Proximity's radius rides the high band, so the same document
 * with the pattern silenced grows a measurably sparser web — counted in the link
 * buffer's own alpha lane, not in pixels, because the claim is about CONNECTIONS.
 */

function e45() {
  const file = listExamples().find((entry) => entry.fileName === "E45-Pulse.loom.json");
  if (file === undefined) throw new Error("E45-Pulse.loom.json is not shipped");
  return requireExample(file);
}

let dawnError: string | undefined;
beforeAll(async () => {
  dawnError = (await probeDawn()).error;
}, 60_000);

function frameAt(frameIndex: number, randomSeed: number) {
  return {
    timeSeconds: frameIndex / 60,
    deltaSeconds: 1 / 60,
    frameIndex,
    mode: "offline" as const,
    randomSeed,
  };
}

describe("E45 Pulse — the set holds between boundaries and changes across one", () => {
  it("the held mix changes ONLY when the 4-bar phrase index changes (§V681, channel-exact)", () => {
    const { document } = e45();
    const session = createValueGraphSession(exampleRegistry());
    const seed = document.settings.randomSeed;

    let previousPhrase = -1;
    let previousHeld = Number.NaN;
    const heldValues = new Set<number>();
    let boundaries = 0;
    for (let frame = 0; frame < 1900; frame += 1) {
      const evaluated = session.evaluate(document.graph, frameAt(frame, seed), {});
      const bar = evaluated.byId.get("beat")?.["bar"];
      const held = evaluated.byId.get("step")?.["bar"];
      expect(typeof bar, `frame ${frame}: audioPattern publishes bar`).toBe("number");
      expect(typeof held, `frame ${frame}: valueStep holds bar`).toBe("number");
      const phrase = Math.floor((bar as number) / 4);
      if (frame > 0 && phrase === previousPhrase) {
        // INSIDE a phrase the held value may not move by even one bit — a timer-based
        // cut would fail here on its first frame.
        expect(held, `frame ${frame} moved the held value inside phrase ${phrase}`).toBe(previousHeld);
      }
      if (frame > 0 && phrase !== previousPhrase) boundaries += 1;
      previousPhrase = phrase;
      previousHeld = held as number;
      heldValues.add(held as number);
    }
    // 1900 frames at 122 bpm crosses four phrase boundaries; the picks are pseudo-random
    // so two may collide, but a set that never moved at all is a broken step.
    expect(boundaries).toBeGreaterThanOrEqual(3);
    expect(heldValues.size).toBeGreaterThanOrEqual(2);
  });

  it(
    "a mostly-A phrase and a mostly-B phrase reach the SCREEN as different pictures",
    async () => {
      if (dawnError !== undefined) throw new Error(`Dawn unavailable: ${dawnError}`);
      const { document } = e45();
      const result = await renderHeadless({
        host: nodeGpuHost(),
        graph: document.graph,
        settings: document.settings,
        frames: 1401,
        capture: [500, 1400],
        animate: true,
        outputNodeId: "out",
      });
      const errors = result.diagnostics.filter((d) => d.severity === "error");
      expect(errors.map((d) => d.message)).toEqual([]);
      const space = result.plan.outputs.find((output) => output.nodeId === "out")?.space ?? "linear";
      const [a, b] = result.frames.map((frame) =>
        toRgba8(
          {
            width: frame.width,
            height: frame.height,
            format: frame.format,
            bytes: frame.bytes,
            rowStride: frame.width * (BYTES_PER_PIXEL[frame.format] ?? 8),
          },
          { space },
        ),
      );
      let differing = 0;
      for (let at = 0; at < a!.data.length; at += 4) {
        if (a!.data[at] !== b!.data[at] || a!.data[at + 1] !== b!.data[at + 1] || a!.data[at + 2] !== b!.data[at + 2]) {
          differing += 1;
        }
      }
      expect(differing).toBeGreaterThan(40_000);
    },
    300_000,
  );

  it(
    "the web IS the music: silencing the pattern measurably thins the links",
    async () => {
      if (dawnError !== undefined) throw new Error(`Dawn unavailable: ${dawnError}`);
      const { document } = e45();

      const linkCount = async (amount: number): Promise<number> => {
        const graph = structuredClone(document.graph) as GraphDocument;
        const beat = graph.nodes["beat"];
        if (beat === undefined) throw new Error("E45 has no `beat`");
        (beat.parameters as Record<string, unknown>)["amount"] = amount;
        const result = await renderHeadless({
          host: nodeGpuHost(),
          graph,
          settings: document.settings,
          frames: 24,
          capture: [23],
          animate: true,
          outputNodeId: "out",
          probeBuffers: ["scratch:prox:tint"],
        });
        const tints = new Float32Array(result.buffers?.["scratch:prox:tint"] ?? new ArrayBuffer(0));
        let alive = 0;
        for (let at = 3; at < tints.length; at += 4) {
          if ((tints[at] ?? 0) > 0) alive += 1;
        }
        return alive;
      };

      const silent = await linkCount(0);
      const loud = await linkCount(1);
      // The base radius keeps a resting web — silence is a sparser web, never no web —
      // and the driven radius grows it. Both directions asserted, so a dead drive and a
      // dead baseline are both visible.
      expect(silent).toBeGreaterThan(0);
      expect(loud).toBeGreaterThan(silent);
    },
    300_000,
  );
});
