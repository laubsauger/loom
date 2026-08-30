import { beforeAll, describe, expect, it } from "vitest";
import type { GraphDocument } from "../../domain/types/graph.ts";
import {
  nodeGpuHost as dawnGpuHost,
  probeDawn,
} from "../../runtime/backend/vgpu/node-gpu-host.ts";
import { OUTPUT_NODE_ID, paritySettings } from "../fixtures/parity-graphs.ts";
import { renderHeadless } from "./render-harness.ts";
import { decodeComponents } from "./pixel-compare.ts";

/**
 * Porter-Duff operators, checked on the picture (T282, §V147).
 *
 * The unit tests prove the six operators have six distinct weight pairs. That catches a
 * copy-paste and nothing else — six DIFFERENT wrong operators would pass it just as
 * happily. What decides whether `inside` means "inside" is what lands in the framebuffer,
 * so these two cases are asserted on texels.
 *
 * Two is deliberate rather than six. `inside` and `outside` are exact complements, so
 * getting both right is strong evidence the weights are wired to the meanings rather than
 * merely distinct — and a suite that renders every operator would cost six Dawn devices to
 * tell us the same thing.
 */

const SIZE = 8;

/** Front: opaque red everywhere. Back: a solid whose ALPHA is the interesting part. */
function clipGraph(operation: string, backAlpha: number): GraphDocument {
  const node = (id: string, type: string, parameters: Record<string, unknown>, x: number) => ({
    id,
    type,
    definitionVersion: 1,
    position: { x, y: 0 },
    parameters: parameters as never,
  });
  return {
    revision: 1,
    groups: {},
    nodes: {
      front: node("front", "solid", { color: [1, 0, 0, 1] }, 0),
      back: node("back", "solid", { color: [0, 0, 1, backAlpha] }, 0),
      mix: node("mix", "composite", { operation, opacity: 1 }, 200),
      [OUTPUT_NODE_ID]: node(OUTPUT_NODE_ID, "output", {}, 400),
    },
    edges: {
      e1: {
        id: "e1",
        source: { nodeId: "front", portId: "out" },
        target: { nodeId: "mix", portId: "in1" },
      },
      e2: {
        id: "e2",
        source: { nodeId: "back", portId: "out" },
        target: { nodeId: "mix", portId: "in2" },
      },
      e3: {
        id: "e3",
        source: { nodeId: "mix", portId: "out" },
        target: { nodeId: OUTPUT_NODE_ID, portId: "input" },
      },
    },
  };
}

let dawnError: string | undefined;
beforeAll(async () => {
  dawnError = (await probeDawn()).error;
}, 60_000);

/** Alpha of the first texel. The operators here differ in coverage, so alpha is the claim. */
async function outputAlpha(operation: string, backAlpha: number): Promise<number> {
  if (dawnError !== undefined) throw new Error(`Dawn could not start: ${dawnError}`);
  const result = await renderHeadless({
    host: dawnGpuHost(),
    graph: clipGraph(operation, backAlpha),
    settings: paritySettings({ size: SIZE }),
    frames: 1,
  });
  expect(result.diagnostics.filter((d) => d.severity !== "info")).toEqual([]);
  const frame = result.frames[0];
  if (frame === undefined) throw new Error("no frame");
  return decodeComponents(frame.bytes, frame.format)[3] ?? -1;
}

describe("Porter-Duff operators do what their names say", () => {
  it("`inside` keeps the front only where the back is opaque", async () => {
    // Opaque back: the front survives whole. Transparent back: nothing survives, because
    // "inside" of nothing is nothing.
    expect(await outputAlpha("inside", 1)).toBeCloseTo(1, 2);
    expect(await outputAlpha("inside", 0)).toBeCloseTo(0, 2);
  }, 90_000);

  it("`outside` is its exact complement", async () => {
    // The complement is what proves the weights are attached to the MEANINGS rather than
    // just being six different numbers: swapping the two operators' weights would leave
    // both tests above passing and both of these failing.
    expect(await outputAlpha("outside", 1)).toBeCloseTo(0, 2);
    expect(await outputAlpha("outside", 0)).toBeCloseTo(1, 2);
  }, 90_000);
});
