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
    let previousPalette = Number.NaN;
    const heldValues = new Set<number>();
    const paletteValues = new Set<number>();
    let boundaries = 0;
    for (let frame = 0; frame < 1900; frame += 1) {
      const evaluated = session.evaluate(document.graph, frameAt(frame, seed), {});
      const bar = evaluated.byId.get("beat")?.["bar"];
      const held = evaluated.byId.get("step")?.["bar"];
      // T828 addendum: the PALETTE is phrase-held on the same structure — the cut and
      // the colour land together, and both live under §V789's floor(bar/4) discipline.
      const palette = evaluated.byId.get("pstep")?.["bar"];
      expect(typeof bar, `frame ${frame}: audioPattern publishes bar`).toBe("number");
      expect(typeof held, `frame ${frame}: valueStep holds bar`).toBe("number");
      expect(typeof palette, `frame ${frame}: the palette step holds bar`).toBe("number");
      const phrase = Math.floor((bar as number) / 4);
      if (frame > 0 && phrase === previousPhrase) {
        // INSIDE a phrase the held values may not move by even one bit — a timer-based
        // cut would fail here on its first frame.
        expect(held, `frame ${frame} moved the held mix inside phrase ${phrase}`).toBe(previousHeld);
        expect(palette, `frame ${frame} moved the palette inside phrase ${phrase}`).toBe(previousPalette);
      }
      if (frame > 0 && phrase !== previousPhrase) boundaries += 1;
      previousPhrase = phrase;
      previousHeld = held as number;
      previousPalette = palette as number;
      heldValues.add(held as number);
      paletteValues.add(palette as number);
    }
    // 1900 frames at 122 bpm crosses four phrase boundaries; the picks are pseudo-random
    // so two may collide, but a set that never moved at all is a broken step.
    expect(boundaries).toBeGreaterThanOrEqual(3);
    expect(heldValues.size).toBeGreaterThanOrEqual(2);
    expect(paletteValues.size).toBeGreaterThanOrEqual(2);
  });

  it(
    "the breakdown bar IS downtime: the same phrase's quiet bar is measurably darker (T828)",
    async () => {
      if (dawnError !== undefined) throw new Error(`Dawn unavailable: ${dawnError}`);
      const { document } = e45();
      // Bar = 4·60/122 s ≈ 118 frames; the arrangement's breakdown is the LAST bar of
      // every four. Frame 200 (bar 1, full pattern) and frame 430 (bar 3, breakdown)
      // sit in the SAME phrase, so the shot mix and the palette are identical between
      // them — the only thing that changed is the music, and the picture must follow.
      const result = await renderHeadless({
        host: nodeGpuHost(),
        graph: document.graph,
        settings: document.settings,
        frames: 431,
        capture: [200, 430],
        animate: true,
        outputNodeId: "out",
      });
      const luma = (frame: (typeof result.frames)[number]): number => {
        const image = toRgba8(
          {
            width: frame.width,
            height: frame.height,
            format: frame.format,
            bytes: frame.bytes,
            rowStride: frame.width * (BYTES_PER_PIXEL[frame.format] ?? 8),
          },
          { space: result.plan.outputs.find((output) => output.nodeId === "out")?.space ?? "linear" },
        );
        let sum = 0;
        for (let at = 0; at < image.data.length; at += 4) {
          sum += (image.data[at] ?? 0) + (image.data[at + 1] ?? 0) + (image.data[at + 2] ?? 0);
        }
        return sum / (image.data.length * 0.75);
      };
      const music = luma(result.frames[0]!);
      const quiet = luma(result.frames[1]!);
      // Both directions: downtime is DARKER than the pattern (the web thins, the rain
      // stops, the dots fall to their trace), and it is not a BLACKOUT — the embers and
      // the dot-dust remain, which is what §V790's negative space means.
      expect(quiet).toBeLessThan(music * 0.8);
      expect(quiet).toBeGreaterThan(music * 0.15);
    },
    300_000,
  );

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
      // §V751 — the claim was re-derived when T828 lowered the floor, both numbers on
      // the record: at base radius 0.30 silence kept a resting web (silent > 0 was the
      // assertion); at T828's base 0.12 the 600-point swarm's nearest-neighbour
      // distances all exceed the radius and silence holds ZERO links. That is now the
      // DESIGN, not a defect: the web exists only while the music does — downtime's
      // trace is the dot-dust and the embers, never the web. The loud floor pins the
      // other direction, so a dead drive is still visible.
      expect(silent).toBe(0);
      expect(loud).toBeGreaterThan(100);
    },
    300_000,
  );

  it(
    "the glitch REACHES the frame: a firing frame tears the picture (T828 point 4)",
    async () => {
      if (dawnError !== undefined) throw new Error(`Dawn unavailable: ${dawnError}`);
      const { document } = e45();
      // The tear is a per-scanline horizontal shift with an RGB channel split, so a torn
      // frame differs from the SAME shots rendered without the glitch. The owner reported
      // "never seeing the chromatic aberration and the slices" — a threshold that killed
      // the whole drive, which passed every other gate because none looked at the glitch.
      // Frame 135 fires (measured); render it with the splice amount forced to 0 (the
      // §V147 identity, byte-passthrough) and to its live value, and the two must differ.
      const shoot = async (mutate: (g: GraphDocument) => void) => {
        const graph = structuredClone(document.graph) as GraphDocument;
        mutate(graph);
        const result = await renderHeadless({
          host: nodeGpuHost(),
          graph,
          settings: document.settings,
          frames: 136,
          capture: [135],
          animate: true,
          outputNodeId: "out",
        });
        return result.frames[0]!;
      };
      const glitched = await shoot(() => {});
      const clean = await shoot((graph) => {
        const splice = graph.nodes["splice"];
        if (splice === undefined) throw new Error("E45 has no `splice`");
        // Force amount to a static 0 — the kernel's §V147 passthrough — so the ONLY
        // difference from the live frame is the tear.
        (splice.parameters as Record<string, unknown>)["amount"] = 0;
      });
      let differing = 0;
      for (let at = 0; at < glitched.bytes.length; at += 1) {
        if (glitched.bytes[at] !== clean.bytes[at]) differing += 1;
      }
      // A tear that reaches the frame moves real pixels; an unwired glitch moves none.
      expect(differing).toBeGreaterThan(5000);
    },
    300_000,
  );
});
