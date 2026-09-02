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
import { toRgba8 } from "../runtime/export/image.ts";
import { BYTES_PER_PIXEL } from "../runtime/export/pixel-format.ts";

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
 * Everything else here and in `concepts/*.test.ts` is structural: which resource is bound to
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
    // T734: E24 shares this kernel VERBATIM and shares E2's fault, so it shares the
    // instrument too — same state target, same readout, same V channel.
    fileName = "E2-Reaction-Diffusion.loom.json",
  ): Promise<ReadonlyArray<Float32Array>> {
    const file = listExamples().find((entry) => entry.fileName === fileName);
    if (file === undefined) throw new Error(`${fileName} is not shipped`);
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
    // every structural assertion in `concepts/*.test.ts` would still pass on one. Measured:
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

  /**
   * T734 / §V626 / §V681 — THE COMPOSITION DOES NOT DIE, AND THE ADVECTION IS WHY.
   *
   * The owner's complaint was that E2 "becomes a static field of sorts". It never froze:
   * the composition did. On the file this replaces, tile CV over a 16x16 grid of 32px tiles
   * fell 0.695 at frame 60 to 0.137 at frame 600 and then sat between 0.099 and 0.177 for
   * the next fifty seconds — an evenly covered screen with nothing left to look at.
   *
   * §V681 is why the assertions below are shaped the way they are. "Becomes static" is a
   * claim about CHANGE OVER TIME, and no still-frame instrument can see it: a collapsed E2
   * still renders a handsome maze, and §V678 has ten structural breakages surviving the
   * look baseline, so the baseline is not the gate for this either. So the claim is made at
   * a LATE age (frame 900, fifteen seconds — well past where the old file had settled) and
   * against a CONTROL that removes exactly the mechanism and nothing else.
   *
   * The control is `flow1`'s weight set to zero. That is a graph with the same nodes, the
   * same passes, the same twenty substeps and the same wire — it renders a plausible
   * picture, and every structural assertion in `concepts/*.test.ts` still passes on it. Only
   * these two numbers see the difference.
   *
   * Measured on Dawn while writing this, at frame 900 of a 512x512 simulation:
   *
   *              featureSpread   moved over 10 frames
   *   shipped        257.7             149,582
   *   weight 0       106.2               3,268
   *
   * — composition 2.4x and motion 46x. The bands below are set well inside both.
   */
  it("keeps its composition alive at fifteen seconds, and the advection is what does it", async () => {
    if (dawnError !== undefined) throw new Error(`Dawn did not start: ${dawnError}`);

    const [live, liveLater] = await simulate((graph) => graph, [900, 910]);
    const [still, stillLater] = await simulate(withNode("flow", { weight: [0, 0] }), [900, 910]);

    // COMPOSITION. Feature density still varies region to region at fifteen seconds; with
    // the flow removed the plate has relaxed into one texture everywhere, which is the
    // "static field of sorts" as a number rather than as an opinion.
    expect(featureSpread(live as Float32Array)).toBeGreaterThan(
      featureSpread(still as Float32Array) * 1.8,
    );

    // MOTION, across a FRAME PAIR (§V681) — the half of the claim a still cannot carry.
    // A lattice in a stationary substrate is a fixed point, so this is the number that
    // separates "slowly evolving" from "arrived".
    expect(moved(live as Float32Array, liveLater as Float32Array)).toBeGreaterThan(
      moved(still as Float32Array, stillLater as Float32Array) * 10,
    );
  }, 300_000);

  /**
   * T734 — THE SAME CLAIM ON E24, WHOSE WIND WAS DOING THE WRONG THING FOR TWO HUNDRED
   * TASKS.
   *
   * E24 shares `GRAY_SCOTT_WGSL` verbatim, so it shares E2's band and E2's fault. It also
   * already HAD a node in §V626's slot — `wind1`, a Transform rotating 0.02 per iteration,
   * seventeen to twenty-four times a frame — and §V626 is precisely that a rotation turns a
   * lattice and leaves it a lattice. The stirring was decorative; the plate never sheared.
   *
   * Only the MOTION half is asserted here. E24's frame is mostly black outside `bowl1`'s
   * disc, so featureSpread over the whole frame measures the vignette rather than the
   * picture — and it is measurably blind to this: with the flow removed it goes UP, from
   * 191.9 to 233.9, because a relaxed plate has cleaner tile-to-tile edges. A number that
   * moves the wrong way under the mutation is not a gate, so it is not used as one.
   *
   * Measured at frame 900, 512x512, over ten frames: 17,369 pixels moved against 3,745 with
   * `wind1`'s weight zeroed — 4.6x. Rendered without a value graph, so `substeps` sits on
   * its retained 14 rather than the bass-driven 17-24; that makes this deterministic and
   * understates the shipped number, which is the safe direction for a floor.
   */
  it("stirs E24's plate by advection, not by spinning it (§V626)", async () => {
    if (dawnError !== undefined) throw new Error(`Dawn did not start: ${dawnError}`);

    const E24 = "E24-Audio-Reaction-Diffusion.loom.json";
    const [live, liveLater] = await simulate((graph) => graph, [900, 910], E24);
    const [still, stillLater] = await simulate(withNode("wind", { weight: [0, 0] }), [900, 910], E24);

    expect(moved(live as Float32Array, liveLater as Float32Array)).toBeGreaterThan(
      moved(still as Float32Array, stillLater as Float32Array) * 3,
    );
  }, 300_000);
});

/**
 * E26 MOVES, AND THE PICTURE IS THE BEAT (T475, T402, §V147, §V383).
 *
 * Two claims, both about pixels, both of which E26 fails silently without.
 *
 * MOTION. Every structural assertion in `concepts/*.test.ts` — the fan-out, the driven
 * slots, the two LFO rates — is equally true of a graph whose drift never reaches the
 * Transform's uniform. §V147 says a claim about the picture is tested on the picture, so
 * this renders through the real value graph (`animate`) and counts pixels that CHANGED
 * between two frames four seconds apart. Measured on Dawn while writing this: 841,412 of
 * 921,600 — 91.3% of the frame. A still image scores approximately zero.
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
    // Measured 0.9130. Half the frame is an enormous margin and still fails outright the
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

/**
 * E27 IS A RELIEF, AND IT MOVES (T475, T402, §V147, §V383).
 *
 * MOTION: 533,647 of 921,600 pixels — 57.9% — change between two frames four seconds
 * apart, measured on Dawn while writing this. Lower than E26's 91% because half the frame
 * is background, which is the honest number for an object on a dark ground.
 *
 * THE CONTROL, and it is the one that makes this a CROSSING rather than a picture: set the
 * kernel's height gain to zero and the sheet becomes flat. Everything else is unchanged —
 * same points, same per-point colour, same camera, same bloom — so the only difference is
 * whether the image was LIFTED into geometry. Measured: 336,347 pixels differ, 36.5% of the
 * frame. A structural test cannot tell those two apart; both compile, both draw 96,000
 * instances, both animate.
 */
describe("E27 lifts the picture into geometry, and it moves", () => {
  async function capture(
    mutate: (graph: GraphDocument) => GraphDocument,
    frames: ReadonlyArray<number>,
  ) {
    const file = listExamples().find((entry) => entry.fileName === "E27-Relief.loom.json");
    if (file === undefined) throw new Error("E27 is not shipped");
    const { document } = requireExample(file);
    const result = await renderHeadless({
      host: nodeGpuHost(),
      graph: mutate(document.graph),
      settings: document.settings,
      frames: Math.max(...frames) + 1,
      capture: [...frames],
      outputNodeId: "out",
      fps: 60,
      animate: true,
    });
    expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    return result.frames;
  }

  const rgb = (frame: { bytes: Uint8Array }, index: number): [number, number, number] => {
    const view = new DataView(frame.bytes.buffer, frame.bytes.byteOffset, frame.bytes.byteLength);
    const offset = index * 8;
    return [
      halfFloat(view.getUint16(offset, true)),
      halfFloat(view.getUint16(offset + 2, true)),
      halfFloat(view.getUint16(offset + 4, true)),
    ];
  };

  const differing = (
    a: { bytes: Uint8Array; width: number; height: number },
    b: { bytes: Uint8Array; width: number; height: number },
  ): number => {
    let count = 0;
    for (let index = 0; index < a.width * a.height; index += 1) {
      const p = rgb(a, index);
      const q = rgb(b, index);
      if (Math.abs(p[0] - q[0]) + Math.abs(p[1] - q[1]) + Math.abs(p[2] - q[2]) > 0.02) count += 1;
    }
    return count;
  };

  it("changes over half the frame in four seconds, and is a different picture lying flat", async () => {
    if (dawnError !== undefined) throw new Error(`Dawn did not start: ${dawnError}`);

    const [early, late] = await capture((graph) => graph, [60, 300]);
    if (early === undefined || late === undefined) throw new Error("no frames");
    // Measured 0.5790.
    expect(differing(early, late) / (early.width * early.height)).toBeGreaterThan(0.25);

    // THE CONTROL: the same graph with the lift turned off.
    const [flat] = await capture((graph) => {
      const lift = graph.nodes["lift"];
      if (lift === undefined) throw new Error("E27 has no lift node");
      const kernel = lift.parameters["kernel"];
      // T809 moved the gain from a constant to `1.05 + ctx.value1` (the audio scales the
      // lift amplitude), so this control now zeroes the whole term rather than the
      // constant — the substring is asserted first so a kernel edit fails LOUDLY here
      // instead of silently turning the control into a no-op.
      if (typeof kernel !== "string" || !kernel.includes("height * (1.05 + ctx.value1)")) {
        throw new Error("the lift kernel no longer carries the height gain this control edits");
      }
      return {
        ...graph,
        nodes: {
          ...graph.nodes,
          lift: {
            ...lift,
            parameters: {
              ...lift.parameters,
              kernel: kernel.replace("height * (1.05 + ctx.value1)", "height * 0.0"),
            },
          },
        },
      };
    }, [300]);
    if (flat === undefined) throw new Error("no control frame");
    // Measured 336,347 of 921,600. A tenth of the frame is a wide margin and still fails
    // outright if the sample stops reaching position.z.
    expect(differing(flat, late)).toBeGreaterThan(90_000);
  }, 300_000);
});

/**
 * E33 — THE EMBLEM STILL READS AS A YIN-YANG WITH NOTHING BEHIND IT (T716).
 *
 * T716 deleted the mass, so the medallion's two tones and its dividing curve are carried
 * by 1728 instanced tiles and by nothing else. "The mass is absent" is a claim about the
 * graph and proves nothing about the picture (§V655), so this is a claim about PIXELS.
 *
 * Three properties, and the third is the one that cannot be faked by a two-tone disc:
 *   - the object's pixels fall into TWO populations of comparable size,
 *   - with a wide gap between their medians,
 *   - and NO STRAIGHT LINE separates them. A bisected disc is cut perfectly by one; a
 *     taiji's boundary is two arcs, so a straight cut has to give up the lobes.
 *
 * The control is the mutation that says the instrument can fail: replace `taiji` with a
 * straight bisector and the third number collapses (measured 17.4% -> 7.3%) while the
 * first two barely move, which is exactly the discrimination the claim needs.
 *
 * Measured at bc681b7: 45.6% / 129.6 luma / 17.4%, full resolution and display-encoded
 * from the plan's own space (§V618, §V627). The thresholds sit well clear of both sides.
 */
describe("E33 reads as a yin-yang without a disc behind it", () => {
  async function luma(
    mutate: (graph: GraphDocument) => GraphDocument,
    frames: ReadonlyArray<number> = [0],
  ): Promise<Float64Array[]> {
    const file = listExamples().find((entry) => entry.fileName === "E33-Obol.loom.json");
    if (file === undefined) throw new Error("E33 is not shipped");
    const { document } = requireExample(file);
    const result = await renderHeadless({
      host: nodeGpuHost(),
      graph: mutate(document.graph),
      settings: document.settings,
      frames: Math.max(...frames) + 1,
      capture: [...frames],
      outputNodeId: "out",
      fps: 60,
      animate: true,
    });
    expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    const space = result.plan.outputs.find((output) => output.nodeId === "out")?.space ?? "linear";
    return result.frames.map((frame) => {
      const image = toRgba8(
        {
          width: frame.width,
          height: frame.height,
          format: frame.format,
          bytes: frame.bytes,
          rowStride: frame.width * (BYTES_PER_PIXEL[frame.format] ?? 8),
        },
        { space },
      );
      const out = new Float64Array(image.width * image.height);
      for (let index = 0; index < out.length; index += 1) {
        const at = index * 4;
        out[index] =
          0.2126 * (image.data[at] ?? 0) + 0.7152 * (image.data[at + 1] ?? 0) + 0.0722 * (image.data[at + 2] ?? 0);
      }
      return out;
    });
  }

  /** The key's shadow off in every render, so the cast shadow is not counted as object. */
  const noShadow = (graph: GraphDocument): GraphDocument => {
    const key = graph.nodes["key"];
    if (key === undefined) throw new Error("E33 has no key light");
    return { ...graph, nodes: { ...graph.nodes, key: { ...key, parameters: { ...key.parameters, shadows: false } } } };
  };
  const noObject = (graph: GraphDocument): GraphDocument => {
    const shot = graph.nodes["shot"];
    if (shot === undefined) throw new Error("E33 has no render");
    return { ...graph, nodes: { ...graph.nodes, shot: { ...shot, parameters: { ...shot.parameters, scenes: "cyc1" } } } };
  };
  /** THE CONTROL: the tiles' two tones split by a straight line instead of by `taiji`. */
  const straightTone = (graph: GraphDocument): GraphDocument => {
    const segs = graph.nodes["segs"];
    if (segs === undefined) throw new Error("E33 has no tile kernel");
    const kernel = segs.parameters["kernel"];
    if (typeof kernel !== "string" || !kernel.includes("let tone = taiji(disc);")) {
      throw new Error("the tile kernel no longer reads its tone the way this control edits");
    }
    return {
      ...graph,
      nodes: {
        ...graph.nodes,
        segs: {
          ...segs,
          parameters: {
            ...segs.parameters,
            kernel: kernel.replace("let tone = taiji(disc);", "let tone = smoothstep(-0.03, 0.03, disc.x);"),
          },
        },
      },
    };
  };

  /** Otsu's threshold: the split that maximises between-class variance. */
  function otsu(values: readonly number[]): number {
    const histogram = new Float64Array(256);
    for (const value of values) {
      const bin = Math.max(0, Math.min(255, Math.round(value)));
      histogram[bin] = (histogram[bin] ?? 0) + 1;
    }
    let sum = 0;
    for (let index = 0; index < 256; index += 1) sum += index * (histogram[index] ?? 0);
    let below = 0;
    let weighted = 0;
    let best = 0;
    let bestVariance = -1;
    for (let index = 0; index < 256; index += 1) {
      below += histogram[index] ?? 0;
      if (below === 0) continue;
      const above = values.length - below;
      if (above === 0) break;
      weighted += index * (histogram[index] ?? 0);
      const variance = below * above * (weighted / below - (sum - weighted) / above) ** 2;
      if (variance > bestVariance) {
        bestVariance = variance;
        best = index;
      }
    }
    return best;
  }

  /**
   * The smallest share of the object a STRAIGHT LINE has to get wrong. Swept over 90
   * orientations; for each, the pixels are projected onto the normal and the best split
   * is found with a running count, so it is one sort per angle rather than a grid search.
   */
  function straightLineError(xs: readonly number[], ys: readonly number[], labels: readonly number[]): number {
    const ones = labels.reduce((total, value) => total + value, 0);
    let best = 1;
    for (let step = 0; step < 90; step += 1) {
      const theta = (step / 90) * Math.PI;
      const nx = Math.cos(theta);
      const ny = Math.sin(theta);
      const projected = xs
        .map((x, index) => ({ t: x * nx + (ys[index] ?? 0) * ny, label: labels[index] ?? 0 }))
        .sort((a, b) => a.t - b.t);
      let onesBefore = 0;
      for (let cut = 0; cut <= projected.length; cut += 1) {
        const zerosAfter = projected.length - cut - (ones - onesBefore);
        const error = (onesBefore + zerosAfter) / projected.length;
        best = Math.min(best, error, 1 - error);
        if (cut < projected.length && projected[cut]?.label === 1) onesBefore += 1;
      }
    }
    return best;
  }

  /**
   * T724 — THE MASS IS ABSENT WHERE THE OWNER OBJECTED TO IT AND PRESENT WHERE THE GIMMICK
   * IS, and both halves are one assertion.
   *
   * The owner asked twice, and the two asks pull opposite ways. First: "the obol thing
   * should not have the disc behind the cubes assembling the yinyang". Then, on the build
   * that deleted the mass outright: "obol is supposed to morph onto the organic blob not a
   * blob made up of cubes thats the whole gimmick". So the mass must draw NOTHING at the
   * emblem end and be the whole subject at the goo end, and a claim that checks only one
   * of those passes the build that got it wrong — deleting the mass passes "absent at the
   * emblem end", and never growing it passes "present at the goo end".
   *
   * Measured by DROPPING `body1` from the render and counting what changes, which is the
   * only way to ask "is it contributing" without asking "is it in the graph": 0 pixels at
   * frame 0 (and 0 at frame 2100, the other emblem moment), 106,056 at frame 484 (0592b2e).
   * The zero is exact, not a threshold — the mass is grown down to a speck behind a mosaic
   * that is still standing in front of it, so it reaches the frame not at all.
   */
  it("draws no pixel of the emblem and the whole subject of the goo", async () => {
    if (dawnError !== undefined) throw new Error(`Dawn did not start: ${dawnError}`);

    const withMass = await luma((graph) => graph, [0, 484]);
    const withoutMass = await luma(
      (graph) => {
        const shot = graph.nodes["shot"];
        if (shot === undefined) throw new Error("E33 has no render");
        const scenes = String(shot.parameters["scenes"]).split(/\s+/);
        if (!scenes.includes("body1")) throw new Error("E33's render no longer names the mass");
        return {
          ...graph,
          nodes: {
            ...graph.nodes,
            shot: { ...shot, parameters: { ...shot.parameters, scenes: scenes.filter((s) => s !== "body1").join(" ") } },
          },
        };
      },
      [0, 484],
    );
    const changed = (index: number): number => {
      const a = withMass[index];
      const b = withoutMass[index];
      if (a === undefined || b === undefined) throw new Error("no frame");
      let count = 0;
      for (let pixel = 0; pixel < a.length; pixel += 1) if (Math.abs((a[pixel] ?? 0) - (b[pixel] ?? 0)) > 1) count += 1;
      return count;
    };
    // ABSENT at the emblem end — exactly, not nearly. This is the owner's first ask.
    expect(changed(0)).toBe(0);
    // PRESENT at the goo end, and the subject rather than a detail. This is the second,
    // and it is what fails if somebody deletes the mass to satisfy the first.
    expect(changed(1)).toBeGreaterThan(50_000);
  }, 300_000);

  it("carries two high-contrast halves on the tiles alone, split by a curve no line can cut", async () => {
    if (dawnError !== undefined) throw new Error(`Dawn did not start: ${dawnError}`);

    const [[lit], [bare], [control]] = await Promise.all([
      luma(noShadow),
      luma((graph) => noObject(noShadow(graph))),
      luma((graph) => straightTone(noShadow(graph))),
    ]);
    if (lit === undefined || bare === undefined || control === undefined) throw new Error("no frames");

    // The object's own pixels: where drawing it changed the frame. The room is excluded
    // rather than thresholded, so a dark tile against a dark backdrop still counts.
    const xs: number[] = [];
    const ys: number[] = [];
    const values: number[] = [];
    const controlValues: number[] = [];
    const width = 1280;
    for (let index = 0; index < lit.length; index += 1) {
      if (Math.abs((lit[index] ?? 0) - (bare[index] ?? 0)) <= 2) continue;
      xs.push(index % width);
      ys.push(Math.floor(index / width));
      values.push(lit[index] ?? 0);
      controlValues.push(control[index] ?? 0);
    }
    // Measured 150,536 of 921,600. A face made of tiles that has lost most of its tiles
    // fails here before any of the three numbers below is reached.
    expect(values.length).toBeGreaterThan(100_000);

    const median = (input: readonly number[]): number => {
      const sorted = [...input].sort((a, b) => a - b);
      return sorted[Math.floor(sorted.length / 2)] ?? 0;
    };
    const read = (input: readonly number[]) => {
      const cut = otsu(input);
      const light = input.filter((value) => value > cut);
      const dark = input.filter((value) => value <= cut);
      return {
        minorShare: Math.min(light.length, dark.length) / input.length,
        contrast: median(light) - median(dark),
        labels: input.map((value) => (value > cut ? 1 : 0)),
      };
    };

    const shipped = read(values);
    // TWO HALVES. Measured 0.456; one flat tone measures 0.069.
    expect(shipped.minorShare).toBeGreaterThan(0.32);
    // AND THEY ARE LIGHT AGAINST DARK. Measured 129.6 luma of 255.
    expect(shipped.contrast).toBeGreaterThan(90);

    // THE CURVE. Measured 0.174 shipped against 0.073 for a straight bisector; the
    // control is rendered in the same run so the comparison cannot go stale.
    const shippedError = straightLineError(xs, ys, shipped.labels);
    const controlError = straightLineError(xs, ys, read(controlValues).labels);
    expect(shippedError).toBeGreaterThan(0.12);
    expect(controlError).toBeLessThan(0.10);
    expect(shippedError).toBeGreaterThan(controlError * 1.5);
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
