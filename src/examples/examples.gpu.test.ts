import { beforeAll, describe, expect, it } from "vitest";

import { compileGraph } from "../compiler/index.ts";
import type { RuntimeDiagnostic } from "../domain/types/diagnostics.ts";
import type { GraphDocument, GraphNode } from "../domain/types/graph.ts";
// The sanctioned Dawn host: `src/runtime/backend/vgpu/` is the only place a `vgpu` import
// is legal (§V3), and this is that boundary's node entry point.
import { nodeGpuHost, probeDawn } from "../runtime/backend/vgpu/node-gpu-host.ts";
import { createVgpuBackend } from "../runtime/backend/vgpu/vgpu-backend.ts";
import { listExamples } from "./catalogue.ts";
import { TIER_B_CAPABILITIES, exampleRegistry, frameSequence, requireExample } from "./runner.ts";
import { renderHeadless } from "../tests/headless/render-harness.ts";

/**
 * EVERY SHIPPED EXAMPLE, BUILT ON A REAL DEVICE (T362/T363, §V89, §V280).
 *
 * `runner.test.ts` builds every example on `vgpu/mock`, and the README has always said
 * plainly what that leaves out: the mock executes no shaders, so **no WGSL in an example
 * has ever been compiled by anything**. E2 has shipped a Gray-Scott kernel since the first
 * week and a typo in it would have surfaced on somebody's screen, not in CI. E12 ships a
 * second kernel and E13 ships a third (a point kernel, code-generated into a module), so
 * the hole stopped being theoretical.
 *
 * This is the other half of §V280's pairing, run over the same files: the mock host proves
 * the plan is CONSTRUCTIBLE, Dawn proves the shaders it names are COMPILABLE and that every
 * binding the plan declares is one the module actually has. Neither host finds the other's
 * bugs, and running one file on both is what makes the environment-split class visible at
 * all.
 *
 * Discovered from the directory, like the rest of the suite: a new example is covered by
 * dropping it in `examples/`.
 *
 * WHAT THIS STILL DOES NOT CLAIM: pixels. Nothing is read back and nothing is compared to a
 * reference image. "It compiles and runs six frames without a device error" is a real gate
 * and it is a smaller one than it looks — say so rather than letting the file name imply
 * more (§V147, B15).
 */

let dawnError: string | undefined;

beforeAll(async () => {
  dawnError = (await probeDawn()).error;
}, 60_000);

/** Same count `runner.test.ts` replays, so a ping-pong pair is bound both ways round. */
const FRAME_COUNT = 6;

describe.each(listExamples())("$fileName on Dawn", (file) => {
  it("compiles every shader it names and steps without a device error", async () => {
    // Required, never skipped: skipping turns the one test that can see a broken kernel
    // into a green tick on every machine without a GPU.
    if (dawnError !== undefined) throw new Error(`Dawn did not start: ${dawnError}`);

    const { plan, document } = requireExample(file);
    const backend = createVgpuBackend({ host: nodeGpuHost() });
    const diagnostics: RuntimeDiagnostic[] = [];
    backend.onDiagnostic((diagnostic) => diagnostics.push(diagnostic));

    try {
      await backend.initialize({});
      // Where a WGSL error lands: the backend reflects each source, builds its bind groups
      // and creates the pipelines here.
      const compiled = await backend.compile(plan);
      expect(
        diagnostics.filter((d) => d.severity === "error").map((d) => `${d.code}: ${d.message}`),
      ).toEqual([]);

      for (const inputs of frameSequence(document, FRAME_COUNT)) {
        backend.render(compiled, inputs);
      }
      expect(
        diagnostics.filter((d) => d.severity === "error").map((d) => `${d.code}: ${d.message}`),
      ).toEqual([]);
      expect(backend.status.framesSubmitted).toBe(FRAME_COUNT);
    } finally {
      backend.dispose();
    }
  }, 60_000);
});

/**
 * E12's ONE PIXEL ASSERTION, and the only one in the example suite (T362).
 *
 * Everything else here and in `concepts.test.ts` is structural: which resource is bound to
 * which input, what a uniform holds, which passes exist. All of that can be true of a fluid
 * that does not move. §V147/B15 is explicit that a test over shader SOURCE or plan SHAPE is
 * not evidence a pixel moved, and "it flows" is precisely a claim about pixels.
 *
 * So this measures the thing the example is named for. Park the pointer in the middle, run
 * five seconds, and count how much of the frame the dye reaches — once with the stirring
 * force on and once with `stir1.amount` at zero. Nothing else changes: same ink, same
 * injection, same diffusion Blur, same fade.
 *
 * With the flow off the ink is a stationary blob that a 1.4px Blur spreads a little. With
 * it on the ink is CARRIED. Measured on Dawn while writing this: 4,612 pixels against
 * 147,757 of 409,600 — a factor of thirty-two — so the ratio asserted below has an enormous
 * margin and still fails outright if advection, the velocity field, or the pointer's route
 * into the kernel regresses. Any of those leaves a graph that compiles, renders, and shows
 * a blob.
 */
describe("E12 actually flows", () => {
  const DYE_TARGET = "target:inject:out";
  const FRAMES = 300;

  async function dyeCoverage(amount: number): Promise<number> {
    const file = listExamples().find((entry) => entry.fileName === "E12-Fluid.loom.json");
    if (file === undefined) throw new Error("E12 is not shipped");
    const { document } = requireExample(file);

    const stir = document.graph.nodes["stir"];
    if (stir === undefined) throw new Error("E12 has no stir node");
    const graph: GraphDocument = {
      ...document.graph,
      nodes: { ...document.graph.nodes, stir: { ...stir, parameters: { ...stir.parameters, amount } } },
    };
    const plan = compileGraph({
      graph,
      settings: document.settings,
      registry: exampleRegistry(),
      capabilities: TIER_B_CAPABILITIES,
    });
    expect(plan.diagnostics.filter((d) => d.severity === "error")).toEqual([]);

    const backend = createVgpuBackend({ host: nodeGpuHost() });
    try {
      await backend.initialize({});
      const compiled = await backend.compile(plan);
      for (let index = 0; index < FRAMES; index += 1) {
        backend.render(compiled, {
          frame: {
            timeSeconds: index / 60,
            deltaSeconds: 1 / 60,
            frameIndex: index,
            mode: "offline",
            randomSeed: document.settings.randomSeed,
          },
          // Parked in the middle: the vortex is stationary, so anything that moves was
          // moved by the FLOW rather than by the pointer being dragged around.
          pointer: { x: 0.5, y: 0.5, buttons: 1 },
          resolution: [
            document.settings.outputResolution.width,
            document.settings.outputResolution.height,
          ],
        });
      }

      const image = await backend.readOutput(DYE_TARGET);
      expect(image.format).toBe("rgba16float");
      const view = new DataView(image.bytes.buffer, image.bytes.byteOffset, image.bytes.byteLength);
      let lit = 0;
      for (let y = 0; y < image.height; y += 1) {
        for (let x = 0; x < image.width; x += 1) {
          const offset = (y * image.rowStride) + (x * 8);
          const sum =
            halfFloat(view.getUint16(offset, true)) +
            halfFloat(view.getUint16(offset + 2, true)) +
            halfFloat(view.getUint16(offset + 4, true));
          if (sum > 0.01) lit += 1;
        }
      }
      return lit;
    } finally {
      backend.dispose();
    }
  }

  it("carries the dye across the frame, and does not without the stirring force", async () => {
    if (dawnError !== undefined) throw new Error(`Dawn did not start: ${dawnError}`);

    const flowing = await dyeCoverage(1);
    const still = await dyeCoverage(0);

    // The control first: with no force the ink stays where it was injected. If this ever
    // grows large, the comparison below stops meaning anything.
    expect(still).toBeGreaterThan(0);
    expect(still).toBeLessThan(20_000);
    // ...and with the force, the dye is somewhere else entirely.
    expect(flowing).toBeGreaterThan(still * 8);
  }, 120_000);
});

/** rgba16float is half-precision; a readback is bytes, and this is how they mean anything. */
/**
 * E2 IS ALIVE, AND THE MAP IS WHAT MAKES IT (T388, §V147, B15).
 *
 * The owner's complaint about E2 was aesthetic — "not this interesting biochemistry cell
 * structure that feels alive and evolving" — and a test cannot judge a picture. What it CAN
 * do is pin the three mechanisms the look rests on, each of which fails silently: a
 * reaction-diffusion that has structurally frozen still renders a plausible image, and one
 * whose chemistry map is not reaching the kernel renders a perfectly nice uniform maze.
 *
 * All four numbers below were measured on Dawn while writing this, on the shipped file, at
 * frame 300 of a 512x512 simulation (262,144 pixels), counting pixels whose V exceeds 0.1.
 */
describe("E2 is alive, and its chemistry map is doing the work", () => {
  const STATE = "target:rd:out";
  const SIZE = 512;

  async function simulate(
    mutate: (graph: GraphDocument) => GraphDocument,
    captures: ReadonlyArray<number>,
  ): Promise<ReadonlyArray<Float32Array>> {
    const file = listExamples().find((entry) => entry.fileName === "E2-Reaction-Diffusion.loom.json");
    if (file === undefined) throw new Error("E2 is not shipped");
    const { document } = requireExample(file);
    const plan = compileGraph({
      graph: mutate(document.graph),
      settings: document.settings,
      registry: exampleRegistry(),
      capabilities: TIER_B_CAPABILITIES,
    });
    expect(plan.diagnostics.filter((d) => d.severity === "error")).toEqual([]);

    const backend = createVgpuBackend({ host: nodeGpuHost() });
    const frames: Float32Array[] = [];
    try {
      await backend.initialize({});
      const compiled = await backend.compile(plan);
      let index = 0;
      for (const target of captures) {
        for (; index < target; index += 1) {
          backend.render(compiled, {
            frame: {
              timeSeconds: index / 60,
              deltaSeconds: 1 / 60,
              frameIndex: index,
              mode: "offline",
              randomSeed: document.settings.randomSeed,
            },
            pointer: { x: 0.5, y: 0.5, buttons: 0 },
            resolution: [SIZE, SIZE],
          });
        }
        const image = await backend.readOutput(STATE);
        expect(image.format).toBe("rgba16float");
        const view = new DataView(image.bytes.buffer, image.bytes.byteOffset, image.bytes.byteLength);
        const v = new Float32Array(image.width * image.height);
        for (let y = 0; y < image.height; y += 1) {
          for (let x = 0; x < image.width; x += 1) {
            // Green is V, the reagent the pattern is made of. Read as DATA, which is also
            // why the example colours it through a Ramp rather than showing it.
            v[(y * image.width) + x] = halfFloat(view.getUint16((y * image.rowStride) + (x * 8) + 2, true));
          }
        }
        frames.push(v);
      }
    } finally {
      backend.dispose();
    }
    return frames;
  }

  /** Pixels the pattern occupies. */
  const coverage = (v: Float32Array): number => v.reduce((count, value) => count + (value > 0.1 ? 1 : 0), 0);

  /** Pixels that changed by more than half a percent of full scale. */
  function moved(a: Float32Array, b: Float32Array): number {
    let count = 0;
    for (let index = 0; index < a.length; index += 1) if (Math.abs((a[index] as number) - (b[index] as number)) > 0.02) count += 1;
    return count;
  }

  /**
   * How much the pattern's FEATURE DENSITY varies from region to region.
   *
   * Coverage cannot see this — spots and worms can occupy the same area — and feature
   * density is exactly what the eye reads as "different things are growing here and there".
   * Counted as horizontal 0.1-crossings per 64x64 tile; the spread across the 64 tiles is
   * the number that separates a map from a constant.
   */
  function featureSpread(v: Float32Array): number {
    const tiles: number[] = [];
    for (let ty = 0; ty < 8; ty += 1) {
      for (let tx = 0; tx < 8; tx += 1) {
        let crossings = 0;
        for (let y = ty * 64; y < (ty + 1) * 64; y += 1) {
          for (let x = (tx * 64) + 1; x < (tx + 1) * 64; x += 1) {
            if (((v[(y * SIZE) + x - 1] as number) > 0.1) !== ((v[(y * SIZE) + x] as number) > 0.1)) crossings += 1;
          }
        }
        tiles.push(crossings);
      }
    }
    const mean = tiles.reduce((a, b) => a + b, 0) / tiles.length;
    return Math.sqrt(tiles.reduce((a, b) => a + ((b - mean) ** 2), 0) / tiles.length);
  }

  const withNode =
    (id: string, parameters: GraphNode["parameters"]) =>
    (graph: GraphDocument): GraphDocument => {
      const node = graph.nodes[id];
      if (node === undefined) throw new Error(`E2 has no ${id} node`);
      const patched: GraphNode = { ...node, parameters: { ...node.parameters, ...parameters } };
      return { ...graph, nodes: { ...graph.nodes, [id]: patched } };
    };

  it("evolves, twenty times faster than one step per frame could (T387)", async () => {
    if (dawnError !== undefined) throw new Error(`Dawn did not start: ${dawnError}`);

    const [at300, at310] = await simulate((graph) => graph, [300, 310]);

    // IT MOVES. §V147/B15: a frozen simulation renders a perfectly plausible picture, and
    // every structural assertion in `concepts.test.ts` would still pass on one. Measured:
    // 14,035 pixels of 262,144 changed across ten displayed frames.
    expect(moved(at300 as Float32Array, at310 as Float32Array)).toBeGreaterThan(5_000);

    // AND SUBSTEPS ARE WHY. The same 300 displayed frames at one iteration each — which is
    // all this product could do before T387 — leave the pattern barely out of its seed
    // plate. Measured: 161,907 pixels covered against 28,028, a factor of 5.8.
    const [oneStep] = await simulate(withNode("state", { substeps: 1 }), [300]);
    expect(coverage(at300 as Float32Array)).toBeGreaterThan(coverage(oneStep as Float32Array) * 3);
  }, 300_000);

  it("runs genuinely different chemistries where the map says so, not one maze everywhere", async () => {
    if (dawnError !== undefined) throw new Error(`Dawn did not start: ${dawnError}`);

    // The two ends of the band the kernel walks, forced flat by having the Reorder write a
    // literal instead of the noise chain's luminance. Nothing else changes.
    const [low] = await simulate(withNode("pack", { outb: "zero" }), [300]);
    const [high] = await simulate(withNode("pack", { outb: "one" }), [300]);

    // They are not the same creature, and it is not close: measured 149,410 pixels covered
    // at one end against 10,500 at the other. A band whose ends behave alike is the uniform
    // look wearing a map, which is exactly what shipped before.
    expect(coverage(low as Float32Array)).toBeGreaterThan(coverage(high as Float32Array) * 8);

    // …and with the real map, feature density varies from region to region MORE than it
    // does under either constant. Measured spreads: 89.8 varied, 62.1 at the low end, 33.2
    // at the high end. This is the assertion that fails if the chemistry never reaches the
    // kernel — the Reorder's blue channel, the state texture's precision, the kernel's read
    // of `centre.b` — every one of which still renders a beautiful uniform maze.
    const [varied] = await simulate((graph) => graph, [300]);
    expect(featureSpread(varied as Float32Array)).toBeGreaterThan(featureSpread(low as Float32Array));
    expect(featureSpread(varied as Float32Array)).toBeGreaterThan(featureSpread(high as Float32Array));
  }, 300_000);
});

/**
 * E26 MOVES, AND THE PICTURE IS THE BEAT (T475, T402, §V147, §V383).
 *
 * Two claims, both about pixels, both of which E26 fails silently without.
 *
 * MOTION. Every structural assertion in `concepts.test.ts` — the fan-out, the driven
 * slots, the two LFO rates — is equally true of a graph whose drift never reaches the
 * Transform's uniform. §V147 says a claim about the picture is tested on the picture, so
 * this renders through the real value graph (`animate`) and counts pixels that CHANGED
 * between two frames four seconds apart. Measured on Dawn while writing this: 889,405 of
 * 921,600 — 96.5% of the frame. A still image scores approximately zero.
 *
 * THE CONTROL, and it is the stronger half. Neutralise the Transform — scale to 1, drift
 * to 0 — and the two branches of the difference become the SAME image, so `beat` outputs
 * zero everywhere and the Lookup returns one colour. Measured: the rgb-sum spread across
 * the whole frame is 0.00000. That is what makes this an interference example rather than
 * a picture of rings: with the offset removed there is nothing left, so every visible
 * structure in the shipped frame is the beat between two readings of one field and
 * belongs to neither of them.
 */
describe("E26 is interference, and it moves", () => {
  async function capture(
    mutate: (graph: GraphDocument) => GraphDocument,
    frames: ReadonlyArray<number>,
  ) {
    const file = listExamples().find((entry) => entry.fileName === "E26-Interference.loom.json");
    if (file === undefined) throw new Error("E26 is not shipped");
    const { document } = requireExample(file);
    const result = await renderHeadless({
      host: nodeGpuHost(),
      graph: mutate(document.graph),
      settings: document.settings,
      frames: Math.max(...frames) + 1,
      capture: [...frames],
      outputNodeId: "out",
      fps: 60,
      // The drift is a VALUE, so without the value graph this renders a static frame and
      // the motion assertion below would be measuring nothing.
      animate: true,
    });
    expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    return result.frames;
  }

  const channels = (frame: { bytes: Uint8Array; width: number }, index: number): [number, number, number] => {
    const view = new DataView(frame.bytes.buffer, frame.bytes.byteOffset, frame.bytes.byteLength);
    const offset = index * 8;
    return [
      halfFloat(view.getUint16(offset, true)),
      halfFloat(view.getUint16(offset + 2, true)),
      halfFloat(view.getUint16(offset + 4, true)),
    ];
  };

  it("changes almost the whole frame over four seconds, and is one flat colour without the offset", async () => {
    if (dawnError !== undefined) throw new Error(`Dawn did not start: ${dawnError}`);

    const [early, late] = await capture((graph) => graph, [60, 300]);
    if (early === undefined || late === undefined) throw new Error("no frames");
    const pixels = early.width * early.height;
    let moved = 0;
    for (let index = 0; index < pixels; index += 1) {
      const a = channels(early, index);
      const b = channels(late, index);
      const delta = Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);
      if (delta > 0.02) moved += 1;
    }
    // Measured 0.9651. Half the frame is an enormous margin and still fails outright the
    // moment the drift stops reaching the Transform.
    expect(moved / pixels).toBeGreaterThan(0.5);

    // THE CONTROL: no offset, no scale difference, no picture.
    const [flat] = await capture((graph) => {
      const warp = graph.nodes["warp"];
      if (warp === undefined) throw new Error("E26 has no warp node");
      return {
        ...graph,
        nodes: {
          ...graph.nodes,
          warp: { ...warp, parameters: { ...warp.parameters, s: [1, 1], "t.x": 0, "t.y": 0 } },
        },
      };
    }, [300]);
    if (flat === undefined) throw new Error("no control frame");
    let low = Infinity;
    let high = -Infinity;
    for (let index = 0; index < flat.width * flat.height; index += 1) {
      const [r, g, b] = channels(flat, index);
      const sum = r + g + b;
      if (sum < low) low = sum;
      if (sum > high) high = sum;
    }
    expect(high - low).toBeLessThan(0.01);
  }, 300_000);
});

function halfFloat(bits: number): number {
  const sign = (bits & 0x8000) === 0 ? 1 : -1;
  const exponent = (bits & 0x7c00) >> 10;
  const fraction = bits & 0x03ff;
  if (exponent === 0) return sign * Math.pow(2, -14) * (fraction / 1024);
  if (exponent === 31) return fraction === 0 ? sign * Infinity : Number.NaN;
  return sign * Math.pow(2, exponent - 15) * (1 + fraction / 1024);
}
