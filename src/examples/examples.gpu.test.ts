import { beforeAll, describe, expect, it } from "vitest";

import { compileGraph } from "../compiler/index.ts";
import type { RuntimeDiagnostic } from "../domain/types/diagnostics.ts";
import type { GraphDocument } from "../domain/types/graph.ts";
// The sanctioned Dawn host: `src/runtime/backend/vgpu/` is the only place a `vgpu` import
// is legal (§V3), and this is that boundary's node entry point.
import { nodeGpuHost, probeDawn } from "../runtime/backend/vgpu/node-gpu-host.ts";
import { createVgpuBackend } from "../runtime/backend/vgpu/vgpu-backend.ts";
import { listExamples } from "./catalogue.ts";
import { TIER_B_CAPABILITIES, exampleRegistry, frameSequence, requireExample } from "./runner.ts";

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
function halfFloat(bits: number): number {
  const sign = (bits & 0x8000) === 0 ? 1 : -1;
  const exponent = (bits & 0x7c00) >> 10;
  const fraction = bits & 0x03ff;
  if (exponent === 0) return sign * Math.pow(2, -14) * (fraction / 1024);
  if (exponent === 31) return fraction === 0 ? sign * Infinity : Number.NaN;
  return sign * Math.pow(2, exponent - 15) * (1 + fraction / 1024);
}
