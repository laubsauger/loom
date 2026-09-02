// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { alice, contextFor, createHarness } from "@domain/commands/test-support.ts";
import type { CompiledGraph } from "@compiler/index.ts";
import type { LoomBackend } from "@runtime/backend/index.ts";
import type { ProjectSettings } from "@domain/types/graph.ts";
import { DEFAULT_PROJECT_SETTINGS } from "./app-runtime.ts";
import { transportHolderFor } from "./transport-commands.ts";
import { useFrameLoop } from "./use-frame-loop.ts";

/**
 * LOOPING THE RANGE (T433, T455, T464, §V170, §V181).
 *
 * ## A LOOP IS NOT A SEEK, and that is the claim here
 *
 * The owner caught the version that got this wrong: "we're resetting feedbacks and all
 * kinds of things whenever the timeline loops back. thats not how touchdesigner
 * necessarily works." Playback across an out point is CONTINUOUS — only the time VALUE
 * wraps. A feedback, a Cache or a point simulation has to survive it, or long-form
 * feedback work is impossible and every lap is a visible restart.
 *
 * §V181 is not weakened by that. It was written for the SEEK case — replayed frames must
 * not carry a trajectory from a history they did not come from — and was applied to the
 * lap by accident, where nothing is skipped and no frame is replayed. So BOTH halves are
 * asserted below: a lap clears nothing, and a seek still clears everything.
 *
 * ## Why a driven loop and not a unit
 *
 * The observable difference between the two implementations is whether
 * `resetTemporalHistory` (a backend method) and `onReset` (the CPU half, §V181) are
 * called, and whether frames are REPLAYED. None of that is visible from a pure function,
 * so the loop is driven here with a fake backend that records every frame it renders.
 *
 * ## What this does NOT prove
 *
 * That the PIXELS carry across the wrap. That is a §V147 claim about a picture and needs a
 * device. What is proved here is that nothing asks for a clear and no frame is re-run,
 * which is the only mechanism a reset could arrive through. Said plainly rather than
 * implied, because a feedback that resets every lap still renders a moving picture and
 * every structural test stays green — which is exactly how the OWNER came to be the one
 * who found it.
 */

afterEach(cleanup);

interface Seen {
  /** Every frame index the driver actually rendered, in order. */
  readonly rendered: number[];
  temporalResets: number;
  cpuResets: number;
}

/**
 * A backend whose `loop` hands back a TICK the test calls by hand.
 *
 * Driving frames explicitly rather than on a timer is what makes "which frame came after
 * which" an assertion instead of a race.
 */
function drivableBackend(): {
  backend: LoomBackend;
  seen: Seen;
  tick: () => void;
} {
  const seen: Seen = { rendered: [], temporalResets: 0, cpuResets: 0 };
  let running: (() => void) | null = null;
  const backend = {
    status: {
      initialized: true,
      disposed: false,
      halted: false,
      deviceGeneration: 1,
      temporalResets: 0,
      resourceBuilds: 0,
      framesSubmitted: 0,
      readbacks: 0,
      stale: false,
      estimatedResourceBytes: 0,
    },
    onDiagnostic: () => () => {},
    recover: async () => {},
    loop: (onFrame: () => void) => {
      running = onFrame;
      return {
        stop: () => {
          running = null;
        },
      };
    },
    previewHost: () => ({
      setPreviewProgram: () => {},
      presentPreviews: () => {},
      dispose: () => {},
    }),
    present: () => ({ id: "p", outputId: "", setOutput: () => {}, dispose: () => {} }),
    onGpuTimings: () => () => {},
    compile: async () => ({ id: "plan", passes: [] }),
    render: (_plan: unknown, inputs: { frame: { frameIndex: number } }) => {
      seen.rendered.push(inputs.frame.frameIndex);
    },
    resize: () => {},
    updateUniforms: () => {},
    resetTemporalHistory: () => {
      seen.temporalResets += 1;
    },
    setCookPolicy() {},
    dispose: () => {},
  } as unknown as LoomBackend;
  return {
    backend,
    seen,
    tick: () => {
      running?.();
    },
  };
}

const PLAN: CompiledGraph = { ok: true, passes: [], outputs: [] } as unknown as CompiledGraph;

function settingsWithRange(start: number, end: number): ProjectSettings {
  return { ...DEFAULT_PROJECT_SETTINGS, fps: 60, frameRange: { start, end } };
}

function mountLoop(settings: ProjectSettings) {
  const { bus } = createHarness("loop");
  const { backend, seen, tick } = drivableBackend();
  let cpuResets = 0;
  const view = renderHook(() =>
    useFrameLoop({
      bus,
      backend,
      compiled: PLAN,
      settings,
      onReset: () => {
        cpuResets += 1;
      },
    }),
  );
  return {
    bus,
    seen,
    tick,
    view,
    cpuResets: () => cpuResets,
    /**
     * `backend.compile` is async, and the driver renders nothing until its result reaches
     * `setPlan`. Without this the ticks below would all no-op and every assertion here
     * would be about an empty array — a suite that passes by measuring nothing.
     */
    ready: async () => {
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
    },
  };
}

describe("the loop cycles the document's range (T433, T464)", () => {
  it("is ON by default, so the frame counter is bounded rather than monotonic (T455)", () => {
    const { view } = mountLoop(settingsWithRange(0, 3));
    expect(view.result.current.looping).toBe(true);
  });

  it("wraps the counter to the IN POINT when playback reaches the out point", async () => {
    const { seen, tick, ready } = mountLoop(settingsWithRange(0, 3));
    await ready();
    // Frames 0,1,2 are inside the range; 3 IS the out point and ends the lap.
    await act(async () => {
      for (let index = 0; index <= 4; index += 1) tick();
    });
    // 0,1,2,3 then 0 again — the very next tick, in sequence. No frame is re-run and none
    // is skipped: the fifth tick is the second lap's first frame.
    expect(seen.rendered).toEqual([0, 1, 2, 3, 0]);
  });

  it("CLEARS NOTHING at the lap — the feedback keeps running (T464)", async () => {
    const { seen, tick, cpuResets, ready } = mountLoop(settingsWithRange(0, 2));
    await ready();
    await act(async () => {
      for (let index = 0; index <= 6; index += 1) tick();
    });
    // Two laps' worth of frames and not one reset between them. This is the owner's report
    // turned into an assertion: a `seek` at the lap boundary makes both of these non-zero
    // while the picture still moves and every other test stays green.
    expect(seen.temporalResets).toBe(0);
    expect(cpuResets()).toBe(0);
  });

  it("wraps to a non-zero in point WITHOUT replaying the frames before it", async () => {
    const { seen, tick, ready } = mountLoop(settingsWithRange(2, 4));
    await ready();
    await act(async () => {
      for (let index = 0; index <= 6; index += 1) tick();
    });
    // 0..4, then 2,3 — the lap goes straight to the in point. A seek would have re-run
    // 0,1,2 here, which is O(in point) stalled frames on every single lap.
    expect(seen.rendered).toEqual([0, 1, 2, 3, 4, 2, 3]);
    expect(seen.temporalResets).toBe(0);
  });

  it("still CLEARS on a seek — §V181 governs the JUMP, not the lap", async () => {
    const { bus, seen, tick, cpuResets, ready } = mountLoop(settingsWithRange(0, 100));
    await ready();
    await act(async () => {
      for (let index = 0; index < 3; index += 1) tick();
    });
    seen.rendered.length = 0;
    await act(async () => {
      await bus.execute("transport.seek", { frameIndex: 2 }, contextFor(alice));
    });
    // The user jumped, so the replayed frames must not inherit a trajectory from the
    // history just abandoned: history cleared, CPU stages cleared, frames re-run from zero.
    expect(seen.temporalResets).toBe(1);
    expect(cpuResets()).toBe(1);
    expect(seen.rendered).toEqual([0, 1, 2]);
  });

  it("runs past the out point once looping is off — that is LIVE mode (T455)", async () => {
    const { bus, seen, tick, ready } = mountLoop(settingsWithRange(0, 2));
    await ready();
    await act(async () => {
      await bus.execute("transport.toggleLoop", {}, contextFor(alice));
    });
    await act(async () => {
      for (let index = 0; index <= 4; index += 1) tick();
    });
    expect(seen.rendered).toEqual([0, 1, 2, 3, 4]);
    expect(seen.temporalResets).toBe(0);
  });

  it("does not lap a MANUAL step past the out point — a step addresses a frame on purpose", async () => {
    const { bus, seen, ready } = mountLoop(settingsWithRange(0, 1));
    await ready();
    // Pause first, so the steps below are the only frames rendered.
    await act(async () => {
      await bus.execute("transport.pause", {}, contextFor(alice));
    });
    await act(async () => {
      for (let index = 0; index < 4; index += 1) {
        await bus.execute("transport.stepFrame", { frames: 1 }, contextFor(alice));
      }
    });
    // Stepping is deliberate: taking the user back to the in point instead of to the frame
    // they asked for is the silent kind of wrong.
    expect(seen.rendered).toEqual([0, 1, 2, 3]);
    expect(seen.temporalResets).toBe(0);
    // And nothing is left armed to fire later.
    expect(transportHolderFor(bus).current?.isLooping()).toBe(true);
  });
});
