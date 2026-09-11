import { describe, expect, it } from "vitest";
import { compute, draw, frame, target, timer } from "vgpu";
import type { TimerFrameDrop } from "vgpu";

import { nodeGpuHost, probeDawn } from "./node-gpu-host.ts";

/**
 * T1295 (vgpu patch theme 6) ON A REAL DEVICE: A SPAN WHOSE WORK NEVER RAN IS NOT A RESULT,
 * AND A FRAME WHOSE TIMER WAS DISCARDED SAYS SO.
 *
 * ## The two holes
 *
 * 1. THE PHANTOM. `Compute.dispatch()` and `Draw.draw()` build and submit their OWN command
 *    buffer, and since T1247 they reserve a timestamp pair in the open frame first
 *    (`Frame.attachExternalSpan`). A throw after that reservation and before `queue.submit()`
 *    left the pair reserved: the frame resolved it out of an unwritten query set and reported
 *    a duration for a pass that never ran. T1247 attached the span after every throwing
 *    PRECONDITION to keep the window small, and left it open. The patch retracts the span on
 *    every exit that does not reach the queue.
 *
 * 2. THE SILENT FRAME. `Frame.pass` already rolls a failed pass back — by discarding the
 *    timer for the WHOLE frame, so every span of that frame, the passes that DID run included,
 *    produced nothing and nothing said so. The patch reports that frame through
 *    `timer.onDropped` with reason "abandoned".
 *
 * The throws are injected at the first call after the reservation — the command encoder for
 * a dispatch, the render pass descriptor for a draw — because nothing in a valid program
 * throws there on demand. The frame's OTHER span is the control: it must still report.
 */

const KERNEL = "@compute @workgroup_size(1) fn main() {}";
const TRIANGLE = /* wgsl */ `
@vertex fn vs(@builtin(vertex_index) index: u32) -> @builtin(position) vec4f {
  let x = f32(index % 2u) * 2.0 - 1.0;
  let y = f32(index / 2u) * 2.0 - 1.0;
  return vec4f(x, y, 0.0, 1.0);
}
@fragment fn fs() -> @location(0) vec4f { return vec4f(1.0); }
`;

async function openTimedGpu() {
  const probe = await probeDawn();
  if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);
  const session = await nodeGpuHost().create({});
  if (!(session.requestedFeatures ?? []).includes("timestamp-query")) {
    session.dispose();
    throw new Error(`${probe.adapter ?? "adapter"} granted no timestamp-query; nothing to gate`);
  }
  const gpu = session.gpu;
  const clock = timer(gpu);
  const results: Readonly<Record<string, number>>[] = [];
  const drops: TimerFrameDrop[] = [];
  clock.onResults((spans) => results.push(spans));
  clock.onDropped((drop) => drops.push(drop));
  /** Results resolve off a mapped buffer; wait until the queue and the readback have both landed. */
  const settle = async (count: number): Promise<void> => {
    await gpu.settled();
    const deadline = performance.now() + 5_000;
    while (results.length < count && performance.now() < deadline) {
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  };
  return { session, gpu, clock, results, drops, settle };
}

describe("T1295 — the throw window between a self-submitted span and its submit", () => {
  it("a dispatch that throws after reserving its pair reports nothing, and its frame's other span still does", async () => {
    const { session, gpu, clock, results, drops, settle } = await openTimedGpu();
    try {
      const kernel = compute(gpu, KERNEL);
      const f = frame(gpu);
      kernel.dispatch(1, 1, 1, { timer: clock.span("ran"), frame: f });

      const device = gpu.gpu as unknown as { createCommandEncoder: (...args: unknown[]) => unknown };
      const createCommandEncoder = device.createCommandEncoder;
      device.createCommandEncoder = () => {
        throw new Error("injected after the pair was reserved");
      };
      try {
        expect(() => kernel.dispatch(1, 1, 1, { timer: clock.span("threw"), frame: f })).toThrow(
          "injected after the pair was reserved",
        );
      } finally {
        device.createCommandEncoder = createCommandEncoder;
      }

      f.submit();
      await settle(1);
      expect(results, "the frame had one dispatch that ran, so it reports once").toHaveLength(1);
      const spans = results[0] ?? {};
      expect(Object.keys(spans), "the dispatch that ran is timed").toContain("ran");
      // Before the patch this key was present: a duration read out of an unwritten pair.
      expect(Object.keys(spans), "the dispatch that threw never ran and must not be a result").not.toContain(
        "threw",
      );
      expect(drops, "a retracted span is not a lost frame: the frame reported").toEqual([]);
    } finally {
      session.dispose();
    }
  }, 60_000);

  it("a draw that throws after reserving its pair reports nothing, and its frame's other span still does", async () => {
    const { session, gpu, clock, results, drops, settle } = await openTimedGpu();
    try {
      const canvas = target(gpu, { size: [4, 4] });
      const triangle = draw(gpu, { shader: TRIANGLE, targets: [canvas], vertices: 3 });
      const f = frame(gpu);
      triangle.draw({ target: canvas, timer: clock.span("drawn"), frame: f });

      const writable = canvas as unknown as { renderPassDescriptor: (...args: unknown[]) => unknown };
      const renderPassDescriptor = writable.renderPassDescriptor;
      writable.renderPassDescriptor = () => {
        throw new Error("injected after the pair was reserved");
      };
      try {
        expect(() => triangle.draw({ target: canvas, timer: clock.span("threw"), frame: f })).toThrow(
          "injected after the pair was reserved",
        );
      } finally {
        writable.renderPassDescriptor = renderPassDescriptor;
      }

      f.submit();
      await settle(1);
      expect(results).toHaveLength(1);
      const spans = results[0] ?? {};
      expect(Object.keys(spans)).toContain("drawn");
      expect(Object.keys(spans), "the draw that threw never ran and must not be a result").not.toContain("threw");
      expect(drops).toEqual([]);
    } finally {
      session.dispose();
    }
  }, 60_000);

  it("a frame whose pass fails loses its timer for the whole frame, and says so instead of going quiet", async () => {
    const { session, gpu, clock, results, drops, settle } = await openTimedGpu();
    try {
      const canvas = target(gpu, { size: [4, 4] });
      const f = frame(gpu);
      f.pass({ target: canvas, timer: clock.span("ran") }, () => {});
      expect(() =>
        f.pass({ target: canvas, timer: clock.span("failed") }, () => {
          throw new Error("pass body failed");
        }),
      ).toThrow("pass body failed");
      f.submit();
      await settle(0);

      // vgpu's existing rollback: the timer is discarded for the frame, so "ran" — a pass
      // that did execute — has no result either. That loss is correct; its silence was not.
      expect(results).toEqual([]);
      expect(drops.map((drop) => drop.reason)).toEqual(["abandoned"]);
      expect(drops[0]?.frame).toBe(f);
      expect(drops[0]?.spans, "the frame had attached both spans before the second pass failed").toBe(2);
    } finally {
      session.dispose();
    }
  }, 60_000);
});
