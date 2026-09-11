import { describe, expect, it } from "vitest";

import { compileGraph } from "../../compiler/index.ts";
import { createComponentSystem } from "../../domain/components/registry.ts";
import { loadProject } from "../../domain/project/index.ts";
import { listExamples } from "../../examples/catalogue.ts";
import { exampleRegistry } from "../../examples/runner.ts";
import { expandLoops, spanBasePassId } from "../backend/plan.ts";
import { nodeGpuHost, probeDawn } from "../backend/vgpu/node-gpu-host.ts";
import { createVgpuBackend } from "../backend/vgpu/vgpu-backend.ts";
import { createFrameDriver } from "../execution/frame-driver.ts";
import { offlineTransport } from "../execution/offline-transport.ts";
import { createPointerSource } from "../execution/pointer.ts";
import { createTelemetryHub, telemetryPlan } from "./hub.ts";

/**
 * T1295 ON A REAL DEVICE: EVERY TIMED FRAME THE EXPORT PATH SUBMITS EITHER REPORTS OR SAYS
 * IT NEVER WILL.
 *
 * ## The bug this is the gate for
 *
 * vgpu's timer resolves each frame's timestamps into one of THREE staging buffers and reads
 * them back asynchronously; when all three are still waiting, it DROPS the frame rather than
 * block. The frame loop submits one frame per tick, so three is plenty there. The export
 * path (`encodeSegmented`) submits one frame per compute segment of a render, all inside one
 * synchronous call, so no staging slot can free in between.
 *
 * MEASURED before the fix (scratch probe, this backend, 3 warm-up + 20 renders, results
 * counted per render against the timed frames it encoded, re-run on a reserved machine with
 * identical counts):
 *
 * - E47-Hologram, 8 timed segments per render: every render delivered EXACTLY 3 results —
 *   the ring depth — so 62.5 % of its frames never reported and 21 of its passes were never
 *   timed at all. E13-Prism: 5 segments, 40 %, 27 passes. 8 of the 60 shipped examples have
 *   more than three.
 * - Stepped back to back with no await (the render harness's shape — it yields to the event
 *   loop once a second), 100 % of frames after the first render were dropped, every example.
 *
 * And NOTHING SAID SO: a dropped frame simply never reached `onResults`, which is exactly
 * what a frame whose results have not landed yet looks like. The export's pixels were never
 * affected — only its GPU timing, which read as whole while describing a fraction.
 *
 * ## What is asserted, and why each holds exactly (§V147)
 *
 * 1. ACCOUNTING: for every submitted render, results + reported drops = the timed frames it
 *    encoded. Not a bound — an equality, in both drive modes. This is the property the row
 *    is about: a missing figure can always say it is missing.
 * 2. RECOVERY (awaited mode): the ring grows at a frame boundary after a drop, so once warm
 *    every render reports ALL its frames with no drop, and every timed pass in the plan is
 *    named by some result. Before the fix: 3 of 8 per render, forever, and 21 passes never.
 * 3. The count reaches the FRAME FIGURE: the telemetry hub's `frame.droppedFrames` equals the
 *    backend's reported drops, so the performance panel's number carries its own caveat.
 * 4. Back to back, drops still happen — no depth fixes a run that never lets a readback
 *    land — and every one of them is reported (claim 1 again, in the mode that loses most).
 */

const WARMUP = 3;
const RENDERS = 12;

/**
 * `encodeSegmented`'s split rule, over the EXPANDED order the backend encodes: a dispatch
 * that follows frame-deferred work starts a new frame. A frame is TIMED when it holds a pass
 * `encode` attaches a span to. Claim 2 checks this rule against the device — once warm, each
 * render's result count must equal it exactly — so a drifted copy fails loudly here.
 */
function timedFramesPerRender(passes: ReturnType<typeof expandLoops>): number {
  const timedKinds = new Set(["dispatch", "draw", "effect"]);
  let frames = 0;
  let timed = false;
  let deferred = false;
  for (const pass of passes) {
    if (pass.kind === "loop") continue;
    if (pass.kind === "dispatch" && deferred) {
      if (timed) frames += 1;
      timed = false;
      deferred = false;
    }
    if (pass.kind !== "dispatch") deferred = true;
    if (timedKinds.has(pass.kind)) timed = true;
  }
  return timed ? frames + 1 : frames;
}

async function renderE47(mode: "awaited" | "back-to-back") {
  const probe = await probeDawn();
  if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);
  const file = listExamples().find((example) => example.fileName.startsWith("E47-"));
  if (file === undefined) throw new Error("E47 example not found");

  const backend = createVgpuBackend({ host: nodeGpuHost() });
  const hub = createTelemetryHub({ intervalMs: 0, now: () => performance.now() });
  try {
    const capabilities = await backend.initialize({});
    if (!capabilities.timestampQuery) {
      throw new Error(`${probe.adapter ?? "adapter"} reports no timestamp-query; nothing to gate`);
    }
    const { components, nodes } = createComponentSystem(exampleRegistry());
    const loaded = loadProject(file.text, { nodes, components });
    if (!loaded.ok) throw new Error(`${file.fileName} did not load: ${loaded.reason}`);
    const plan = compileGraph({
      graph: loaded.document.graph,
      settings: loaded.document.settings,
      registry: nodes,
      capabilities,
      components: components.view(),
    });
    const errors = plan.diagnostics.filter((d) => d.severity === "error");
    if (errors.length > 0) throw new Error(errors.map((d) => d.message).join("; "));
    const output = plan.outputs[0];
    if (output === undefined) throw new Error("E47 compiled to no output");

    const expanded = expandLoops(plan.passes);
    const timedFrames = timedFramesPerRender(expanded);
    const timedPassIds = new Set(
      expanded
        .filter((pass) => pass.kind === "dispatch" || pass.kind === "draw" || pass.kind === "effect")
        .map((pass) => pass.id),
    );

    const compiled = await backend.compile(plan);
    hub.setPlan(telemetryPlan(plan));
    const onDropped = backend.onGpuTimingsDropped;
    if (onDropped === undefined) throw new Error("the vgpu backend must report dropped frames");
    hub.attachTimingSource({
      timestampQuery: capabilities.timestampQuery,
      timestampQueryRequested: capabilities.timestampQueryRequested === true,
      onPassTimings: (listener) => backend.onGpuTimings(listener),
      onTimingsDropped: (listener) => onDropped.call(backend, listener),
    });

    const results = new Map<number, number>();
    const drops = new Map<number, number>();
    const named = new Set<string>();
    let lastArrival = performance.now();
    backend.onGpuTimings((spans, frame) => {
      const submit = frame?.submit ?? -1;
      results.set(submit, (results.get(submit) ?? 0) + 1);
      for (const name of Object.keys(spans)) named.add(spanBasePassId(name));
      lastArrival = performance.now();
    });
    onDropped.call(backend, (drop) => {
      const submit = drop.submit ?? -1;
      drops.set(submit, (drops.get(submit) ?? 0) + 1);
    });

    const { settings } = loaded.document;
    const driver = createFrameDriver({
      backend,
      transport: offlineTransport({ fps: 60, seed: settings.randomSeed, mode: "fixed-step" }),
      pointer: createPointerSource(),
      resolution: () => [settings.outputResolution.width, settings.outputResolution.height],
    });
    driver.setPlan(compiled);

    const total = WARMUP + RENDERS;
    for (let index = 0; index < total; index += 1) {
      driver.step();
      if (mode === "awaited") await backend.readOutput(output.resourceId);
    }
    await backend.readOutput(output.resourceId);
    // Results resolve off mapped buffers; wait until they stop arriving.
    const deadline = performance.now() + 10_000;
    while (performance.now() - lastArrival < 300 && performance.now() < deadline) {
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }

    const submits = Array.from({ length: total }, (_, index) => index + 1);
    return {
      timedFrames,
      submits,
      results,
      drops,
      untimed: [...timedPassIds].filter((id) => !named.has(id)),
      hubDropped: hub.snapshot().frame.droppedFrames,
    };
  } finally {
    hub.dispose();
    backend.dispose();
  }
}

describe("T1295 — every timed frame of the export path reports or says it never will, E47-Hologram", () => {
  it("awaited: accounts for every frame, and reports all of them once the ring has grown", async () => {
    const run = await renderE47("awaited");
    expect(run.timedFrames, "E47 is the example with the most timed segments; the row needs > 3").toBeGreaterThan(3);

    // (1) Accounting, exact, every render.
    for (const submit of run.submits) {
      expect(
        (run.results.get(submit) ?? 0) + (run.drops.get(submit) ?? 0),
        `render ${submit}: results + reported drops must equal its ${run.timedFrames} timed frames`,
      ).toBe(run.timedFrames);
    }
    // The ring starts at vgpu's three slots and this render needs more, so the first render
    // MUST drop — which is what makes the reporting half a measurement, not a formality.
    const dropped = [...run.drops.values()].reduce((sum, count) => sum + count, 0);
    expect(dropped, "the first render outruns three staging slots; its drops must be reported").toBeGreaterThan(0);

    // (2) Recovery: once warm, every frame of every render reports and nothing drops.
    for (const submit of run.submits.slice(WARMUP)) {
      expect(run.results.get(submit), `render ${submit} after warm-up`).toBe(run.timedFrames);
      expect(run.drops.get(submit) ?? 0, `render ${submit} after warm-up dropped`).toBe(0);
    }
    expect(run.untimed, `timed passes no result ever named: ${run.untimed.join(", ")}`).toEqual([]);

    // (3) The frame figure carries the count.
    expect(run.hubDropped).toBe(dropped);
  }, 180_000);

  it("back to back: a run that never yields still loses frames, and reports every one", async () => {
    const run = await renderE47("back-to-back");
    for (const submit of run.submits) {
      expect(
        (run.results.get(submit) ?? 0) + (run.drops.get(submit) ?? 0),
        `render ${submit}: results + reported drops must equal its ${run.timedFrames} timed frames`,
      ).toBe(run.timedFrames);
    }
    const dropped = [...run.drops.values()].reduce((sum, count) => sum + count, 0);
    expect(dropped, "no staging depth survives a run that never lets a readback land").toBeGreaterThan(0);
    expect(run.hubDropped).toBe(dropped);
  }, 180_000);
});
