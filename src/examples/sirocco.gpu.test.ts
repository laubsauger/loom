import { beforeAll, describe, expect, it } from "vitest";
import { readKernelAttribute } from "../nodes/definitions/test-support.ts";

import { compileGraph } from "../compiler/index.ts";
import { createNodeRegistry } from "../nodes/registry/registry.ts";
import { allNodeDefinitions } from "../nodes/definitions/index.ts";
import { createVgpuBackend } from "../runtime/backend/vgpu/vgpu-backend.ts";
import { nodeGpuHost, probeDawn } from "../runtime/backend/vgpu/node-gpu-host.ts";
import { listExamples } from "./catalogue.ts";
import { requireExample, TIER_B_CAPABILITIES } from "./runner.ts";

/**
 * T727 — E37'S REASON TO EXIST, ASSERTED STRUCTURALLY (§V681).
 *
 * §V681 is the whole design of this file: NO STILL-FRAME INSTRUMENT CAN SEE MOTION
 * DAMAGE. E37 is a streak field, and its entire claim is a CORRESPONDENCE — that each
 * ribbon belongs to the mote it is drawn from, and that each mote's position advances by
 * its own velocity. A mutation that re-deals which trail goes with which point renders a
 * frame that is statistically identical: the same number of ribbons, the same lengths, the
 * same colours, the same histogram. The look baseline cannot see it (§V678 — ten
 * deliberate breakages survived it), the legibility gates cannot see it, and neither can a
 * human looking at a still. Only a claim that NAMES the correspondence sees it.
 *
 * So both claims below are per-slot equalities read off the GPU, not pictures:
 *
 *   1. WITHIN one frame: trail[i] == position[i] − velocity[i] × TRAIL, for every i.
 *      This is the beam's far end (T680), and it is what makes the streak a reading of
 *      THIS mote rather than a decoration near it.
 *
 *   2. ACROSS a frame pair: position(n+1)[i] − position(n)[i] == velocity(n+1)[i] × dt,
 *      for every i. This is the integrator's own step, and it is the claim a still frame
 *      structurally cannot make. Re-deal the population between frames and the pixels do
 *      not move; this fails on every slot.
 *
 * The constants come OUT OF THE SHIPPED KERNEL rather than being retyped here (§V349) —
 * one number, one home — with a floor on TRAIL so the arithmetic cannot be made trivially
 * true by zeroing it, which would pass claim 1 while drawing no streaks at all.
 */

function e37() {
  const file = listExamples().find((entry) => entry.fileName === "E37-Sirocco.loom.json");
  if (file === undefined) throw new Error("E37-Sirocco.loom.json is not shipped");
  return requireExample(file);
}

/** A WGSL `const NAME: f32 = <number>;` out of a kernel parameter. §V349: one home. */
function kernelConstant(source: string, name: string): number {
  const match = new RegExp(`const ${name}: f32 = ([0-9.]+);`).exec(source);
  if (match === null) throw new Error(`E37's kernel declares no const ${name}`);
  return Number(match[1]);
}

let dawnError: string | undefined;
beforeAll(async () => {
  dawnError = (await probeDawn()).error;
}, 60_000);

describe("E37 Sirocco — the streak is a reading of its own mote (T727, §V681)", () => {
  it("holds both correspondences: within a frame, and across a frame pair", async () => {
    if (dawnError !== undefined) throw new Error(`Dawn did not start: ${dawnError}`);

    const { document } = e37();
    const streakNode = document.graph.nodes["streak"];
    if (streakNode === undefined) throw new Error("E37 has no streak node");
    const kernel = String(streakNode.parameters["kernel"]);
    const trailSeconds = kernelConstant(kernel, "TRAIL");
    const speedReference = kernelConstant(kernel, "SPEED_REFERENCE");
    const capacity = Number(streakNode.parameters["capacity"]);

    /* The floor that stops claim 1 being made trivially true. TRAIL = 0 satisfies
       `trail == position` on every slot and draws a field of zero-length ribbons — an
       empty frame that passes. Same shape as §V624: the parameter must still DO something.
       0.1 s is well under the shipped 0.34 and well over anything that draws nothing. */
    expect(trailSeconds, "a zeroed TRAIL would pass claim 1 and draw nothing").toBeGreaterThan(0.1);
    expect(speedReference).toBeGreaterThan(0);
    expect(capacity).toBeGreaterThan(0);

    const plan = compileGraph({
      graph: document.graph,
      settings: document.settings,
      registry: createNodeRegistry(allNodeDefinitions).view(),
      capabilities: TIER_B_CAPABILITIES,
    });
    expect(plan.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(plan.ok).toBe(true);

    const backend = createVgpuBackend({ host: nodeGpuHost() });
    const errors: string[] = [];
    backend.onDiagnostic((d) => {
      if (d.severity === "error") errors.push(`${d.code}: ${d.message}`);
    });

    const DELTA = 1 / 60;
    /* T1076: attributes are REGIONS of the node's packed buffer, so a readback names
       the node and the attribute and the layout does the rest. */
    const read = async (nodeId: string, attribute: string) =>
      (
        await readKernelAttribute(
          backend.readBuffer,
          document.graph.nodes[nodeId] as { type: string; parameters: Record<string, unknown> },
          nodeId,
          attribute,
        )
      ).floats;

    try {
      await backend.initialize({});
      const compiled = await backend.compile(plan);

      const step = (frameIndex: number): void => {
        backend.render(compiled, {
          frame: { timeSeconds: frameIndex * DELTA, deltaSeconds: DELTA, frameIndex, mode: "offline", randomSeed: 37 },
          pointer: { x: 0, y: 0, buttons: 0 },
          resolution: [320, 180],
        });
      };

      /* Past the warm start and any first-frame transient, then TWO ADJACENT frames — the
         pair is the instrument, and a single frame cannot be one. */
      for (let frameIndex = 0; frameIndex <= 40; frameIndex += 1) step(frameIndex);
      const positionA = await read("streak", "position");
      step(41);
      const positionB = await read("streak", "position");
      const velocityB = await read("streak", "velocity");
      const trailB = await read("streak", "trail");
      const sizeB = await read("streak", "size");
      expect(errors).toEqual([]);

      let worstTrail = 0;
      let worstStep = 0;
      let worstSize = 0;
      let moved = 0;
      for (let i = 0; i < capacity; i += 1) {
        const b = i * 4; // vec3f strides at 16 bytes
        for (let c = 0; c < 3; c += 1) {
          const p = positionB[b + c] ?? 0;
          const v = velocityB[b + c] ?? 0;

          // CLAIM 1 — the beam's far end is THIS mote's own velocity, this frame.
          worstTrail = Math.max(worstTrail, Math.abs((trailB[b + c] ?? 0) - (p - v * trailSeconds)));

          // CLAIM 2 — and this mote's position advanced by THIS mote's velocity.
          worstStep = Math.max(worstStep, Math.abs(p - (positionA[b + c] ?? 0) - v * DELTA));
        }
        const speed = Math.hypot(velocityB[b] ?? 0, velocityB[b + 1] ?? 0, velocityB[b + 2] ?? 0);
        worstSize = Math.max(worstSize, Math.abs((sizeB[i] ?? 0) - (0.35 + 1.65 * Math.min(1, speed / speedReference))));
        if (Math.hypot(
          (positionB[b] ?? 0) - (positionA[b] ?? 0),
          (positionB[b + 1] ?? 0) - (positionA[b + 1] ?? 0),
          (positionB[b + 2] ?? 0) - (positionA[b + 2] ?? 0),
        ) > 1e-6) moved += 1;
      }

      /* f32 tolerance, not a band that would tolerate a wrong answer (§V147). Measured on
         Dawn at build time: 6.2e-8 for the trail, 3.3e-7 for the size, and the step
         residual is a subtraction of two ~1.0 magnitudes so it carries one ulp more. */
      expect(worstTrail, "trail is not this mote's own velocity streak").toBeLessThan(1e-5);
      expect(worstStep, "a mote did not advance by its OWN velocity — correspondence re-dealt").toBeLessThan(1e-5);
      expect(worstSize, "size is not this mote's own speed").toBeLessThan(1e-5);

      /* And the population is genuinely MOVING, so neither claim above is being satisfied
         by a frozen buffer (§V681's own trap: a still simulation passes every equality). */
      expect(moved, "the cloud is not moving; both equalities above are then vacuous").toBe(capacity);
    } finally {
      backend.dispose();
    }
  }, 180_000);
});
