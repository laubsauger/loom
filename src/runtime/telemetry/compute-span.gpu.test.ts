import { describe, expect, it } from "vitest";

import { compileGraph } from "../../compiler/index.ts";
import { createComponentSystem } from "../../domain/components/registry.ts";
import { loadProject } from "../../domain/project/index.ts";
import { listExamples } from "../../examples/catalogue.ts";
import { exampleRegistry } from "../../examples/runner.ts";
import { spanBasePassId } from "../backend/plan.ts";
import type { GpuFrameTiming } from "../backend/backend-types.ts";
import { nodeGpuHost, probeDawn } from "../backend/vgpu/node-gpu-host.ts";
import { createVgpuBackend } from "../backend/vgpu/vgpu-backend.ts";
import { createFrameDriver } from "../execution/frame-driver.ts";
import { offlineTransport } from "../execution/offline-transport.ts";
import { createPointerSource } from "../execution/pointer.ts";
import { createTelemetryHub, telemetryPlan } from "./hub.ts";

/**
 * T1247 ON A REAL DEVICE: A COMPUTE DISPATCH IS GPU WORK, SO IT CARRIES A GPU SPAN.
 *
 * ## The bug this is the gate for
 *
 * `encodeDispatch`'s only instrumentation was `timed()` — the CPU encode clock (T256).
 * vgpu's `Compute.dispatch()` builds and submits its own command buffer, so it never
 * passed through `Frame.pass` and never received a `timestampWrites` pair. Two figures
 * were wrong in the same direction, silently:
 *
 * - the PER-PASS column showed every dispatch row as "pending" forever, however long the
 *   kernel ran;
 * - the FRAME EXTENT (§T1243) is earliest begin → latest end over the frame's timestamp
 *   pairs, and the compute's pair was not in the set — so a submit whose ONLY GPU work
 *   was compute reported nothing at all, and a mixed submit reported its render passes.
 *
 * `Draw.draw()` — the only way to issue a GPU-DRIVEN (indirect) draw — has the same
 * shape and had the same hole: it builds and submits its own command buffer, so a draw
 * of a million points read from a GPU-written args buffer was as invisible as the kernel
 * that wrote them. One mechanism fixes both, and this gate holds both to it.
 *
 * E9-Ember is the point-lifecycle example: fourteen dispatch passes (spawn, integrate,
 * scan, compact, the per-draw args) and three indirect draws, against nine effects.
 * Anyone reading its profile was reading a number with the particle system subtracted
 * out.
 *
 * WHAT THIS FIXTURE CANNOT REACH (T1295). E9 renders as exactly THREE timed frames per
 * render on the export path, and vgpu's timer had exactly three staging slots — so this gate
 * was green even while every frame past the third of a render was silently dropped, which
 * lost 21 of E47's passes outright. Its green says "self-submitted work carries a span", not
 * "every span arrives": that claim, on a fixture that did lose passes, is
 * `timing-drops.gpu.test.ts`.
 *
 * ## What is asserted, and why each holds exactly (§V147)
 *
 * 1. EVERY self-submitted pass in the plan — dispatch or indirect draw — reports a
 *    MEASURED span. Not a bound — a count,
 *    against the plan's own list. Before the fix the same expression reads `pending` /
 *    null for all seventeen, forever.
 * 2. The span names the backend hands out COVER every one of them: the self-submitted
 *    pairs are in the timed set, which is the whole mechanism the row is about.
 * 3. At least one submitted frame is TIMED BY SELF-SUBMITTED WORK ALONE. The export path
 *    (`encodeSegmented`) starts a new frame at every dispatch that follows deferred
 *    work, so E9 renders as several frames and some hold nothing that waits for the
 *    frame's own submit — only kernels, GPU-driven draws and swaps.
 *    Before this row those frames reserved no query pair, so vgpu encoded no resolve for
 *    them (`usedQueries === 0`) and they reported NOTHING AT ALL — not a zero, an
 *    absence. That a result exists for such a frame is the fix, and a render-only timer
 *    cannot produce one.
 * 4. Per submitted frame, `extent >= max(span)`. That is the extent's definition — the
 *    latest end minus the earliest begin cannot be shorter than any single pair inside
 *    it — so it is exact rather than a tolerance, and it is checked over a span set that
 *    now includes the compute pairs. §V86: no exclusive cost is derived here, and no
 *    figure is subtracted from another.
 * 5. The frame figure the PERFORMANCE PANEL reads (`hub.snapshot().frame`) covers the
 *    compute: `basis: "frame"` and `gpuMs >= ` the largest dispatch span on the panel.
 *
 * ## Why no assertion here says "> 0 ms"
 *
 * MEASURED on this Dawn build (T1247, scratchpad probes, E16-Murmuration, one device):
 * the first ~48 timer results carry exact timestamps — the three kernels read 0.009–
 * 0.013 ms and the draw 0.100 ms — and from roughly the 24th frame of a device's life
 * every timestamp is QUANTIZED TO A MULTIPLE OF 65 536 ns, after which those same
 * kernels read exactly 0.000 and the draw reads 0.131. It is the instrument, not the
 * work: render spans quantize identically, and a raw two-encoder WebGPU probe on the
 * same device times a heavy compute pass at 5.98 ms. So a magnitude threshold on a
 * sub-65 µs kernel is a coin flip, and the claims above are structural instead: a span
 * of 0.000 that is PRESENT is still a measurement (§V86), and it is what separates this
 * fix from the absence it replaced.
 */
describe("T1247 — compute dispatches carry a GPU span on Dawn, E9-Ember", () => {
  it("times every dispatch, and the frame extent covers the compute-only submits", async () => {
    const probe = await probeDawn();
    if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);

    const file = listExamples().find((example) => example.fileName.startsWith("E9-"));
    if (file === undefined) throw new Error("E9 example not found");

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
      if (output === undefined) throw new Error("E9 compiled to no output");

      /**
       * The passes whose cost this row is about, named by the PLAN rather than by hand:
       * every compute dispatch, AND every GPU-DRIVEN (indirect) draw — `Draw.draw()`
       * builds and submits its own command buffer exactly like `Compute.dispatch()`, so
       * the two were untimed for one reason and are fixed by one mechanism.
       */
      const dispatchIds = new Set(
        plan.passes.filter((pass) => pass.kind === "dispatch").map((pass) => pass.id),
      );
      const indirectDrawIds = new Set(
        plan.passes
          .filter((pass) => pass.kind === "draw" && typeof pass.instances === "object")
          .map((pass) => pass.id),
      );
      const selfSubmittedIds = new Set([...dispatchIds, ...indirectDrawIds]);
      expect(dispatchIds.size, "E9-Ember is the compute-heavy example; it must dispatch").toBeGreaterThan(
        0,
      );
      expect(
        indirectDrawIds.size,
        "E9-Ember renders its points from GPU-written draw args; the indirect half of this row needs one",
      ).toBeGreaterThan(0);

      const compiled = await backend.compile(plan);
      hub.setPlan(telemetryPlan(plan));
      hub.attachTimingSource({
        timestampQuery: capabilities.timestampQuery,
        timestampQueryRequested: capabilities.timestampQueryRequested === true,
        onPassTimings: (listener) => backend.onGpuTimings(listener),
      });

      /** Every result the backend handed out: one per SUBMITTED FRAME, extent included. */
      const results: { frame: GpuFrameTiming; spans: Readonly<Record<string, number>> }[] = [];
      backend.onGpuTimings((spans, frame) => {
        if (frame === undefined) throw new Error("the vgpu backend must hand the frame extent");
        results.push({ frame, spans });
      });

      const { settings } = loaded.document;
      const driver = createFrameDriver({
        backend,
        transport: offlineTransport({ fps: 60, seed: settings.randomSeed, mode: "fixed-step" }),
        pointer: createPointerSource(),
        resolution: () => [settings.outputResolution.width, settings.outputResolution.height],
      });
      driver.setPlan(compiled);

      // Warm-up: pipelines compile lazily on the first frames. Every step's readback is
      // awaited, so the GPU is idle again before the next one is encoded.
      const WARMUP = 3;
      const FRAMES = 10;
      for (let index = 0; index < WARMUP + FRAMES; index += 1) {
        driver.step();
        await backend.readOutput(output.resourceId);
      }
      // Timer results resolve off a mapped buffer, one frame or two behind; let them land.
      const deadline = performance.now() + 5_000;
      while (results.length === 0 && performance.now() < deadline) {
        await new Promise<void>((resolve) => setTimeout(resolve, 5));
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
      expect(results.length, "the timer reported at least one frame per render").toBeGreaterThanOrEqual(
        WARMUP + FRAMES,
      );

      // (4) The extent's own definition, over a set that now holds the compute pairs.
      for (const [index, { frame, spans }] of results.entries()) {
        const longest = Math.max(0, ...Object.values(spans));
        expect(
          frame.gpuMs,
          `result ${index}: extent ${frame.gpuMs.toFixed(3)} ms is shorter than its longest span ${longest.toFixed(3)} ms`,
        ).toBeGreaterThanOrEqual(longest);
      }

      // (2) The compute pairs are in the timed set at all.
      const timedIds = new Set<string>();
      for (const { spans } of results) {
        for (const name of Object.keys(spans)) timedIds.add(spanBasePassId(name));
      }
      const untimed = [...selfSubmittedIds].filter((id) => !timedIds.has(id));
      expect(
        untimed,
        `self-submitted passes the timer never named: ${untimed.join(", ")}`,
      ).toEqual([]);

      // (3) Submits whose entire timed content is self-submitted work — before T1247
      // those frames reserved no query pair at all, so vgpu encoded no resolve for them
      // and they produced no result: an absence, not a zero.
      const selfSubmittedOnly = results.filter(({ spans }) => {
        const names = Object.keys(spans);
        return names.length > 0 && names.every((name) => selfSubmittedIds.has(spanBasePassId(name)));
      });
      expect(
        selfSubmittedOnly.length,
        "E9 submits frames whose only GPU work is kernels and GPU-driven draws; before T1247 they reserved no query pair, so vgpu encoded no resolve and they reported nothing whatsoever",
      ).toBeGreaterThan(0);

      // (1) and (5): what the performance panel reads back.
      const snapshot = hub.snapshot();
      const dispatchRows = snapshot.passes.filter((row) => selfSubmittedIds.has(row.passId));
      expect(dispatchRows.length, "one panel row per self-submitted pass").toBe(
        selfSubmittedIds.size,
      );
      for (const row of dispatchRows) {
        expect(row.availability, `${row.passId} reads "${row.availability}"`).toBe("measured");
        expect(row.gpuMs, `${row.passId} has no number`).not.toBeNull();
      }

      const dispatchMs = dispatchRows.map((row) => row.gpuMs ?? 0);
      const longestDispatch = Math.max(...dispatchMs);
      const frameBucket = snapshot.frame;
      const verdict = `${probe.adapter}: frame ${frameBucket.gpuMs?.toFixed(3)} ms, pass sum ${frameBucket.passSumMs?.toFixed(3)} ms over ${snapshot.passes.length} passes; ${selfSubmittedIds.size} self-submitted spans [${dispatchMs.map((ms) => ms.toFixed(3)).join(", ")}], ${selfSubmittedOnly.length} self-submitted-only submits of ${results.length}`;
      expect(frameBucket.basis, verdict).toBe("frame");
      expect(frameBucket.availability, verdict).toBe("measured");
      expect(frameBucket.gpuMs, verdict).not.toBeNull();
      expect(frameBucket.gpuMs ?? 0, verdict).toBeGreaterThanOrEqual(longestDispatch);
    } finally {
      hub.dispose();
      backend.dispose();
    }
  }, 60_000);
});
