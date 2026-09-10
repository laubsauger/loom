import { describe, expect, it } from "vitest";

import { compileGraph } from "../../compiler/index.ts";
import { createComponentSystem } from "../../domain/components/registry.ts";
import { loadProject } from "../../domain/project/index.ts";
import { listExamples } from "../../examples/catalogue.ts";
import { exampleRegistry } from "../../examples/runner.ts";
import type { GpuFrameTiming } from "../backend/backend-types.ts";
import { nodeGpuHost, probeDawn } from "../backend/vgpu/node-gpu-host.ts";
import { createVgpuBackend } from "../backend/vgpu/vgpu-backend.ts";
import { createFrameDriver } from "../execution/frame-driver.ts";
import { offlineTransport } from "../execution/offline-transport.ts";
import { createPointerSource } from "../execution/pointer.ts";
import { createTelemetryHub, telemetryPlan } from "./hub.ts";

/**
 * T1243 ON A REAL DEVICE: THE FRAME'S GPU TIME FITS INSIDE THE FRAME.
 *
 * ## The bug this is the gate for
 *
 * `hub.frameBucket()` reported the SUM of the per-pass spans as "GPU time". On E24 in the
 * browser that read 88–105 ms per frame while frames presented every 10 ms — a figure
 * that could not be true of a frame that was visibly finishing. The cause is measured in
 * `hub.ts` (`frameBucket` docblock): on Apple GPUs every pass's begin timestamp samples at
 * the command buffer's start, so the spans NEST and their sum is ~(N+1)/2 × the frame.
 * The fix is a second figure — the frame's EXTENT, earliest pass begin → latest pass end
 * of one submit, which vgpu's timer now hands beside the spans — and the bucket says which
 * of the two it holds (`basis`, §V86).
 *
 * ## The assertion, and why the slack is what it is
 *
 * Each frame here is stepped, then its output is read back and AWAITED before the next
 * step. A readback cannot resolve before the GPU has finished the frame, so the wall
 * interval between consecutive steps is an upper bound on that frame's GPU extent, by
 * construction — the headless stand-in for "presented interval". The 10 % slack covers
 * the only thing that can legitimately break the bound: the GPU timestamp counter and
 * `performance.now` are different clocks, and Dawn's conversion of Metal's ticks to
 * nanoseconds is a calibration, not an identity. Anything past that is a wrong figure.
 *
 * The same bound applied to the OLD figure (the pass sum) fails on this adapter — that
 * half is what makes this a gate rather than a tautology (§V147, red-verified by
 * substituting `passSumMs` for `gpuMs` in `frameBucket`). It is asserted only where the
 * cause reproduces (a Metal adapter); on a GPU whose passes serialise, sum ≈ extent and
 * the old figure would not have been ten times wrong — the test SAYS which case it saw.
 */
describe("T1243 — the frame's GPU extent on Dawn, E24", () => {
  it("fits inside the frame's own interval, and the pass sum does not", async () => {
    const probe = await probeDawn();
    if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);

    const file = listExamples().find((example) => example.fileName.startsWith("E24-"));
    if (file === undefined) throw new Error("E24 example not found");

    const backend = createVgpuBackend({ host: nodeGpuHost() });
    const hub = createTelemetryHub({ intervalMs: 0, now: () => performance.now() });
    try {
      const capabilities = await backend.initialize({});
      if (!capabilities.timestampQuery) {
        throw new Error(`${probe.adapter ?? "adapter"} reports no timestamp-query; nothing to gate`);
      }

      // §V12: compile against what THIS device reports, exactly as the harness does.
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
      if (output === undefined) throw new Error("E24 compiled to no output");

      const compiled = await backend.compile(plan);
      hub.setPlan(telemetryPlan(plan));
      hub.attachTimingSource({
        timestampQuery: capabilities.timestampQuery,
        timestampQueryRequested: capabilities.timestampQueryRequested === true,
        onPassTimings: (listener) => backend.onGpuTimings(listener),
      });

      /** Every result the backend handed out: the extent, and the sum of its spans. */
      const results: { frame: GpuFrameTiming; passSumMs: number }[] = [];
      backend.onGpuTimings((spans, frame) => {
        if (frame === undefined) throw new Error("the vgpu backend must hand the frame extent");
        results.push({
          frame,
          passSumMs: Object.values(spans).reduce((sum, ms) => sum + ms, 0),
        });
      });

      const { settings } = loaded.document;
      const driver = createFrameDriver({
        backend,
        transport: offlineTransport({ fps: 60, seed: settings.randomSeed, mode: "fixed-step" }),
        pointer: createPointerSource(),
        resolution: () => [settings.outputResolution.width, settings.outputResolution.height],
      });
      driver.setPlan(compiled);

      // Warm-up: pipelines compile lazily on the first frames; those intervals are CPU.
      const WARMUP = 5;
      const FRAMES = 20;
      // THIS frame's step → its readback resolving: the bound belongs to the frame it
      // measures, not to the one before (a spike compared with its predecessor's interval
      // is a false failure).
      const intervals: number[] = [];
      for (let index = 0; index < WARMUP + FRAMES; index += 1) {
        const start = performance.now();
        driver.step();
        await backend.readOutput(output.resourceId);
        if (index >= WARMUP) intervals.push(performance.now() - start);
      }
      // Timer results resolve off a mapped buffer, one frame behind; let them land.
      const deadline = performance.now() + 5_000;
      while (results.length < WARMUP + FRAMES && performance.now() < deadline) {
        await new Promise<void>((resolve) => setTimeout(resolve, 5));
      }
      expect(results.length, "one timing result per submitted frame").toBe(WARMUP + FRAMES);

      const submits = results.map((r) => r.frame.submit);
      expect(submits, "each result names its submit, in order").toEqual(
        results.map((_, index) => index + 1),
      );

      const SLACK = 0.1;
      const measured = results.slice(WARMUP);
      for (const [index, { frame }] of measured.entries()) {
        const bound = intervals[index]! * (1 + SLACK);
        expect(
          frame.gpuMs,
          `frame ${index + WARMUP + 1}: extent ${frame.gpuMs.toFixed(3)} ms exceeds its interval ${intervals[index]!.toFixed(3)} ms × ${1 + SLACK}`,
        ).toBeLessThanOrEqual(bound);
        expect(frame.gpuMs, "a measured frame has a positive extent").toBeGreaterThan(0);
      }

      // The hub's bucket carries the same figure, labelled, with the sum kept beside it.
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
      const bucket = hub.snapshot().frame;
      const last = results.at(-1)!;
      expect(bucket.basis).toBe("frame");
      expect(bucket.availability).toBe("measured");
      expect(bucket.gpuMs).toBe(last.frame.gpuMs);
      expect(bucket.passSumMs).toBeCloseTo(last.passSumMs, 6);

      // Dawn names the backend, not the chip ("Metal driver on macOS …"); Metal here IS
      // Apple silicon, and the stage-boundary sampling is that GPU's.
      const apple = (probe.adapter ?? "").toLowerCase().includes("metal");
      const meanExtent = measured.reduce((sum, r) => sum + r.frame.gpuMs, 0) / measured.length;
      const meanSum = measured.reduce((sum, r) => sum + r.passSumMs, 0) / measured.length;
      const meanInterval = intervals.reduce((sum, ms) => sum + ms, 0) / intervals.length;
      const verdict = `${probe.adapter}: interval ${meanInterval.toFixed(2)} ms, extent ${meanExtent.toFixed(2)} ms, pass sum ${meanSum.toFixed(2)} ms over ${plan.passes.length} passes`;
      if (apple) {
        // The row's bug, reproduced: the old figure fails the very bound the new one meets.
        expect(meanSum, `spans nest on Apple, so the sum must overshoot — ${verdict}`).toBeGreaterThan(
          meanInterval * (1 + SLACK),
        );
        expect(meanSum / meanExtent, verdict).toBeGreaterThan(2);
      } else {
        // Serial passes: sum and extent agree to within the gaps between passes.
        expect(meanSum, `serial adapter — ${verdict}`).toBeLessThanOrEqual(meanExtent * (1 + SLACK));
      }
    } finally {
      hub.dispose();
      backend.dispose();
    }
  }, 60_000);
});
