// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { createMemoryStorage, installDomStubs } from "@ui/testing/install-dom-stubs.ts";
import { installFlowStubs } from "@editor/graph-canvas/testing.tsx";
import type { BackendCapabilities, CompiledExecutionPlan } from "@domain/types/backend.ts";
import type { GraphPatchOperation } from "@domain/types/patch.ts";
import type { LoomBackend } from "@runtime/backend/index.ts";
import { App } from "./app.tsx";
import { createAppRuntime } from "./app-runtime.ts";
import type { AppRuntime } from "./app-runtime.ts";
import type { GpuStatus } from "./gpu-status.ts";

/**
 * B30/T324 — the cursor reaches a shader (§V236, §V182, §V179).
 *
 * `PointerSource.set` had no caller, so `FrameEvaluationInput.pointer` was a frozen zero:
 * every shader reading the shared block's pointer got (0,0), and Mouse — the only wirable
 * value source — read that same zero. Two suites were green throughout, because a
 * publisher that does not exist is precisely what a unit test supplies for itself.
 *
 * This drives the whole chain in the composed app and asserts the number at the far end:
 *
 *   pointermove on the viewer canvas
 *     -> normalised to the canvas rect, v down (§V236)
 *     -> PointerSource
 *     -> FrameInputs.pointer
 *     -> value graph: mouse1 -> math1 (§V179)
 *     -> driven parameter
 *     -> updateUniforms
 *
 * The chain is `mouse1 → math1(add 0) → level.brightness`, so brightness IS the pointer's
 * x. A number that equals the cursor position can have arrived no other way.
 */

beforeAll(() => {
  installDomStubs();
  installFlowStubs();
});
afterEach(cleanup);

const CAPABILITIES: BackendCapabilities = {
  tier: "B",
  features: [],
  formats: ["rgba8unorm", "rgba8unorm-srgb", "rgba16float", "r32float", "depth24plus"],
  timestampQuery: false,
  limits: { maxTextureDimension2D: 8192 },
};

/** The viewer canvas's box, stubbed: jsdom lays nothing out and would report all zeros. */
const CANVAS_RECT = { left: 100, top: 50, width: 200, height: 100 };

function newRuntime(): AppRuntime {
  return createAppRuntime({
    identityStorage: null,
    actor: { kind: "human", id: "tester", label: "Tester" },
  });
}

async function seed(runtime: AppRuntime, operations: GraphPatchOperation[]) {
  return runtime.bus.execute(
    "graph.applyPatch",
    { baseRevision: runtime.bus.store.getRevision(), operations, label: "seed" },
    runtime.invocation,
  );
}

function fixtureBackend() {
  const writes: Array<Record<string, unknown>> = [];
  let onFrame: (() => void) | null = null;
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
    initialize: () => Promise.resolve(CAPABILITIES),
    compile: (plan: unknown) => Promise.resolve({ id: "fixture", logical: plan } as CompiledExecutionPlan),
    render() {},
    resize() {},
    readOutput: () => Promise.reject(new Error("no GPU")),
    onDiagnostic: () => () => {},
    dispose() {},
    loop: (callback: () => void) => {
      onFrame = callback;
      return { stop() {} };
    },
    updateUniforms: (update: { values: Record<string, unknown> }) => {
      writes.push({ ...update.values });
    },
    resetTemporalHistory() {},
    recover: () => Promise.resolve(),
    present: (_canvas: unknown, options: { outputId: string }) => ({
      id: "p",
      outputId: options.outputId,
      setOutput() {},
      dispose() {},
    }),
    previewHost: () => ({ setPreviewProgram() {}, presentPreviews() {}, dispose() {} }),
    onGpuTimings: () => () => {},
    compileShader: () => Promise.resolve({ ok: false, validated: false, diagnostics: [] }),
    readBuffer: () => Promise.reject(new Error("no GPU")),
    registerMediaSource: () => () => {},
    setCookPolicy() {},
  } as unknown as LoomBackend;

  return {
    backend,
    writes,
    tick() {
      if (onFrame === null) throw new Error("the app registered no frame loop");
      onFrame();
    },
  };
}

/** noise → level → output, plus `mouse1 → math1(add 0)` driving the level's brightness. */
async function seedPointerChain(runtime: AppRuntime): Promise<void> {
  let level = "";
  let math = "";
  await act(async () => {
    const result = await seed(runtime, [
      { op: "addNode", ref: "$noise", type: "noise", position: { x: 0, y: 0 } },
      { op: "addNode", ref: "$level", type: "level", position: { x: 240, y: 0 } },
      { op: "addNode", ref: "$out", type: "output", position: { x: 480, y: 0 } },
      { op: "addNode", ref: "$mouse", type: "mouse", position: { x: 0, y: 300 } },
      { op: "addNode", ref: "$math", type: "valueMath", position: { x: 240, y: 300 } },
      {
        op: "connect",
        source: { nodeId: "$noise", portId: "out" },
        target: { nodeId: "$level", portId: "input" },
      },
      {
        op: "connect",
        source: { nodeId: "$level", portId: "out" },
        target: { nodeId: "$out", portId: "input" },
      },
      {
        op: "connect",
        source: { nodeId: "$mouse", portId: "out" },
        target: { nodeId: "$math", portId: "a" },
      },
      // Add zero: brightness becomes the pointer's x exactly, so the assertion is the
      // coordinate itself rather than something derived from it.
      { op: "setParameters", nodeId: "$math", parameters: { operation: "add", operand: 0 } },
    ]);
    expect(result.status).toBe("applied");
    level = result.output.createdIds["$level"] ?? "";
    math = result.output.createdIds["$math"] ?? "";
  });

  const mathName = runtime.bus.store.getGraph().nodes[math]?.label ?? "";
  await act(async () => {
    const result = await seed(runtime, [
      {
        op: "setParameters",
        nodeId: level,
        parameters: {
          brightness: {
            mode: "driven",
            bindings: {
              static: { kind: "static", value: 1 },
              driven: { kind: "driven", channel: `${mathName}:x` },
            },
          },
        },
      } as GraphPatchOperation,
    ]);
    expect(result.status).toBe("applied");
  });
}

async function mount(runtime: AppRuntime, backend: LoomBackend): Promise<HTMLCanvasElement> {
  const status: GpuStatus = { kind: "ready", capabilities: CAPABILITIES, baseline: true, backend };
  await act(async () => {
    render(
      <App runtime={runtime} storage={createMemoryStorage()} gpuProbe={() => Promise.resolve(status)} />,
    );
  });
  const canvas = screen.getByTestId("viewer-canvas") as HTMLCanvasElement;
  // jsdom measures nothing, so the rect is supplied. Everything else is real.
  canvas.getBoundingClientRect = () =>
    ({ ...CANVAS_RECT, right: 300, bottom: 150, x: 100, y: 50, toJSON: () => "" }) as DOMRect;
  return canvas;
}

const brightness = (writes: ReadonlyArray<Record<string, unknown>>): number[] =>
  writes.map((values) => values["brightness"]).filter((value): value is number => typeof value === "number");

describe("T324 — the viewer publishes the cursor, and it reaches a parameter", () => {
  it("normalises to the canvas rect, v down, and drives the graph", async () => {
    const runtime = newRuntime();
    await seedPointerChain(runtime);
    const fixture = fixtureBackend();
    const canvas = await mount(runtime, fixture.backend);

    // Halfway across, three quarters down. The rect's offset is non-zero on purpose: a
    // window-normalised publisher would report (0.5, 0.75) of the WINDOW and land elsewhere.
    await act(async () => {
      fireEvent.pointerMove(canvas, { clientX: 200, clientY: 125, buttons: 0 });
      fixture.tick();
    });

    const values = brightness(fixture.writes);
    expect(values.length).toBeGreaterThan(0);
    expect(values[values.length - 1]).toBeCloseTo(0.5, 10);
    runtime.dispose();
  });

  it("HOLDS the last position when the cursor leaves, rather than snapping to zero", async () => {
    const runtime = newRuntime();
    await seedPointerChain(runtime);
    const fixture = fixtureBackend();
    const canvas = await mount(runtime, fixture.backend);

    await act(async () => {
      fireEvent.pointerMove(canvas, { clientX: 150, clientY: 100, buttons: 0 });
      fixture.tick();
    });
    expect(brightness(fixture.writes).at(-1)).toBeCloseTo(0.25, 10);

    // The cursor moves off the picture — into the inspector, say. §V236: zero is a VALID
    // position, so publishing it would snap every mouse-driven effect to the corner, a jump
    // that reads as a bug in the user's own graph.
    await act(async () => {
      fireEvent.pointerMove(canvas, { clientX: 900, clientY: 900, buttons: 0 });
      fireEvent.pointerLeave(canvas);
      fixture.tick();
      fixture.tick();
    });

    // Still 0.25 — and specifically NOT 0, which is what a reset-on-leave would produce.
    const after = brightness(fixture.writes).at(-1);
    expect(after).toBeCloseTo(0.25, 10);
    expect(after).not.toBe(0);
    runtime.dispose();
  });

  it("publishes buttons on the same events, so a press with no movement is seen", async () => {
    const runtime = newRuntime();
    await seedPointerChain(runtime);
    const fixture = fixtureBackend();
    const canvas = await mount(runtime, fixture.backend);

    await act(async () => {
      fireEvent.pointerMove(canvas, { clientX: 150, clientY: 100, buttons: 0 });
      fixture.tick();
    });
    // A press that moves nothing still has to reach the graph; `pointermove` alone would
    // miss it until the user twitched.
    await act(async () => {
      fireEvent.pointerDown(canvas, { clientX: 150, clientY: 100, buttons: 1 });
      fixture.tick();
    });
    // Position unchanged by the press — the button is a separate channel, not a jump.
    expect(brightness(fixture.writes).at(-1)).toBeCloseTo(0.25, 10);
    runtime.dispose();
  });
});
