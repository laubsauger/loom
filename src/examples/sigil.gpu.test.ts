import { beforeAll, describe, expect, it } from "vitest";

import { compileGraph } from "../compiler/index.ts";
import { createNodeRegistry } from "../nodes/registry/registry.ts";
import { allNodeDefinitions } from "../nodes/definitions/index.ts";
import { createVgpuBackend } from "../runtime/backend/vgpu/vgpu-backend.ts";
import { nodeGpuHost, probeDawn } from "../runtime/backend/vgpu/node-gpu-host.ts";
import { listExamples } from "./catalogue.ts";
import { requireExample, TIER_B_CAPABILITIES } from "./runner.ts";

/**
 * T727 — E38'S TWO CLAIMS, BOTH ACROSS TIME (§V681).
 *
 * E38's subject is a CYCLE: a mark assembles out of a population, comes apart, and comes
 * back. Neither thing that can go wrong with it is visible in a frame.
 *
 *  1. MEMBERSHIP DOES NOT CHANGE HANDS. `mark` is sampled at the mote's HOME CELL, so the
 *     glyph that re-forms is the glyph that came apart. Sample at the live position
 *     instead — `home + drift`, the plausible alternative — and the mark's population
 *     drifts: motes that wander in are captured, motes that wander out are dropped.
 *     MEASURED at build time: 6528 members become 8302 with 3573 slots changing sides over
 *     one cycle, while the look instrument reads range 0.8953 for BOTH, to four decimals.
 *
 *  2. THE GLYPH COMES BACK. One whole cycle after frame 0 the assembly plateau has come
 *     round again and every member must be back on its own cell. MEASURED: mean |drift|
 *     over members 0.0011 intact, 0.0962 with the gather term removed — 87x, and the same
 *     look range to four decimals again.
 *
 * The pair also pins each other's blind spot: claim 1 alone passes on a population frozen
 * in the dispersed state, and claim 2 alone passes on a mark made of the wrong motes.
 *
 * The neighbour checked at build time and NOT gated here, because it is a matter of
 * texture rather than of correctness: removing the sub-cell jitter reddens neither claim.
 */

function e38() {
  const file = listExamples().find((entry) => entry.fileName === "E38-Sigil.loom.json");
  if (file === undefined) throw new Error("E38-Sigil.loom.json is not shipped");
  return requireExample(file);
}

let dawnError: string | undefined;
beforeAll(async () => {
  dawnError = (await probeDawn()).error;
}, 60_000);

describe("E38 Sigil — the mark is the same motes every time it re-forms (T727, §V681)", () => {
  it("keeps every membership, and puts every member back on its cell", async () => {
    if (dawnError !== undefined) throw new Error(`Dawn did not start: ${dawnError}`);

    const { document } = e38();
    const gather = document.graph.nodes["gather"];
    if (gather === undefined) throw new Error("E38 has no gather node");
    const capacity = Number(gather.parameters["capacity"]);
    expect(capacity).toBeGreaterThan(0);

    /* The cycle's period, read off the document rather than retyped (§V349): the assembly
       plateau comes round again after exactly one of these. */
    const cycle = document.graph.nodes["cycle"];
    const frequency = Number(cycle?.parameters["frequency"]);
    expect(frequency, "E38's cycle LFO carries no frequency").toBeGreaterThan(0);
    const period = Math.round(60 / frequency);

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
    const read = async (id: string) => new Float32Array(await backend.readBuffer(id));

    try {
      await backend.initialize({});
      const compiled = await backend.compile(plan);

      let early: Float32Array | undefined;
      let settledMark: Float32Array | undefined;
      let settledDrift: Float32Array | undefined;
      /* Frame `period` is one whole cycle after frame 0, so the assembly plateau is back. */
      for (let frameIndex = 0; frameIndex <= period; frameIndex += 1) {
        backend.render(compiled, {
          frame: { timeSeconds: frameIndex / 60, deltaSeconds: 1 / 60, frameIndex, mode: "offline", randomSeed: 38 },
          pointer: { x: 0, y: 0, buttons: 0 },
          resolution: [320, 180],
        });
        if (frameIndex === 60) early = await read("scratch:gather:mark");
      }
      settledMark = await read("scratch:gather:mark");
      settledDrift = await read("scratch:gather:drift");
      expect(errors).toEqual([]);

      // CLAIM 1 — not one slot changed sides across the whole cycle.
      let changed = 0;
      let members = 0;
      let driftSum = 0;
      for (let i = 0; i < capacity; i += 1) {
        const before = early?.[i] ?? 0;
        const after = settledMark[i] ?? 0;
        if (Math.abs(before - after) > 1e-5) changed += 1;
        if (after <= 0.5) continue;
        const b = i * 4; // vec3f strides at 16 bytes
        driftSum += Math.hypot(settledDrift[b] ?? 0, settledDrift[b + 1] ?? 0, settledDrift[b + 2] ?? 0);
        members += 1;
      }
      expect(changed, "the mark's population changed hands across a cycle").toBe(0);

      /* The guard on the guard (§V337): claim 1 is trivially true of a mark with no members
         and of one that is the whole population. The picture claims a ring and a pip, which
         is a small minority of a full-frame grid. */
      expect(members).toBeGreaterThan(capacity * 0.02);
      expect(members).toBeLessThan(capacity * 0.30);

      // CLAIM 2 — and they are all back on their own cells.
      const meanDrift = driftSum / members;
      expect(meanDrift, "the glyph did not re-form: members are not back on their cells").toBeLessThan(0.02);
    } finally {
      backend.dispose();
    }
  }, 180_000);
});
