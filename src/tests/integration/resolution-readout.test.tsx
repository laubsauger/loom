// @vitest-environment jsdom
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { createMemoryStorage, installDomStubs } from "@ui/testing/install-dom-stubs.ts";
import { installFlowStubs } from "@editor/graph-canvas/testing.tsx";
import type { CompiledGraph } from "@compiler/index.ts";
import type { BackendCapabilities } from "@domain/types/backend.ts";
import type { GraphPatchOperation } from "@domain/types/patch.ts";
import type { LoomBackend } from "@runtime/backend/index.ts";
import { App } from "../../app/app.tsx";
import { createAppRuntime } from "../../app/app-runtime.ts";
import type { AppRuntime } from "../../app/app-runtime.ts";
import type { GpuStatus } from "../../app/gpu-status.ts";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════
 * T1064 — the inspector's size readout is the PLAN's number, at the composed surface.
 * ═══════════════════════════════════════════════════════════════════════════════════
 *
 * ## The bug this replaces, and why it lasted
 *
 * The Common readout ran a SECOND implementation of the compiler's precedence ladder
 * (`editor/inspector/resolution.ts`), and was handed the project cap alone while
 * `compiler/resolution.ts` clamps to `min(project, maxTextureDimension2D)`. On any device
 * below the project cap — most of them — the panel printed a size no node on that machine
 * has ever had. Two implementations of one rule, and the user only ever sees one of them.
 *
 * ## Why this test is at the composed surface and not in the panel's own suite
 *
 * `inspector.test.tsx` already asserts that the panel reports the row it is GIVEN, and
 * `compiler/resolution.test.ts` already asserts that the compiler clamps to the device.
 * Both were green while the bug shipped, because the defect was never inside either of
 * them: it was that nothing carried one to the other. Deleting the mirror makes that link
 * load-bearing — the panel now has no answer of its own to fall back on — and an
 * unwired prop would show a dash rather than a wrong number, which is the same class of
 * failure §V220 and B46 record ("built, tested, never wired" is this project's dominant
 * bug, and B46 is literally the inspector on the wrong side of one).
 *
 * So: mount the real `App`, let it compile the document itself, click a node, and require
 * the number on screen to be the number in the plan the backend was handed.
 *
 * ## The fixture, chosen so a mirror could not pass (§V854)
 *
 * A 4000x4000 fixed override, a 4096 PROJECT cap, and a device that reports 2048. 4000 is
 * UNDER the project cap on purpose: a size over both caps resolves to 2048 either way and
 * the test would go green against the bug. The second case flips the device to 16384 and
 * requires 4000 back, so an implementation that clamped to a constant fails too.
 */

beforeAll(() => {
  installDomStubs();
  installFlowStubs();
});
afterEach(cleanup);

/** The project's own cap. The override below sits under it, deliberately. */
const PROJECT_CAP = 4096;
const ASKED = 4000;
/** Below the project cap, so only the device half of the min can produce it. */
const SMALL_DEVICE = 2048;
/** Above everything, so the same override comes back unclamped. */
const BIG_DEVICE = 16_384;

function capabilities(deviceCap: number): BackendCapabilities {
  return {
    tier: "B",
    features: [],
    formats: ["rgba8unorm", "rgba8unorm-srgb", "rgba16float", "r32float", "depth24plus"],
    timestampQuery: false,
    limits: { maxTextureDimension2D: deviceCap },
  };
}

function capturingBackend(): { backend: LoomBackend; plans: CompiledGraph[] } {
  const plans: CompiledGraph[] = [];
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
    loop: () => ({ stop: () => {} }),
    previewHost: () => ({
      setPreviewProgram: () => {},
      presentPreviews: () => {},
      dispose: () => {},
    }),
    present: () => ({ id: "p", outputId: "", setOutput: () => {}, dispose: () => {} }),
    onGpuTimings: () => () => {},
    onCpuTimings: () => () => {},
    compile: async (plan: CompiledGraph) => {
      plans.push(plan);
      return { id: "plan", passes: [] };
    },
    render: () => {},
    resize: () => {},
    updateUniforms: () => {},
    resetTemporalHistory: () => {},
    setCookPolicy: () => {},
    dispose: () => {},
  } as unknown as LoomBackend;
  return { backend, plans };
}

function newRuntime(): AppRuntime {
  return createAppRuntime({
    identityStorage: null,
    actor: { kind: "human", id: "tester", label: "Tester" },
  });
}

async function patch(runtime: AppRuntime, operations: GraphPatchOperation[]) {
  return runtime.bus.execute(
    "graph.applyPatch",
    { baseRevision: runtime.bus.store.getRevision(), operations },
    runtime.invocation,
  );
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 40));
  });
}

/** Selects a node the way a person does — a real click — so the inspector shows it. */
async function selectNode(view: ReturnType<typeof render>, nodeId: string): Promise<void> {
  const element = view.container.querySelector(`[data-testid="node-${nodeId}"]`);
  if (element === null) throw new Error(`the node ${nodeId} did not render`);
  await act(async () => {
    const win = element.ownerDocument.defaultView;
    if (win === null) throw new Error("no window");
    for (const type of ["mousedown", "mouseup", "click"]) {
      const event = new win.MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        clientX: 40,
        clientY: 20,
      });
      Object.defineProperty(event, "view", { value: win });
      element.dispatchEvent(event);
    }
  });
  await settle();
}

/** The readout in the inspector header — the one line this whole row is about. */
function readout(view: ReturnType<typeof render>): string {
  const scroll = view.container.querySelector('[data-testid="inspector-scroll"]');
  const found = scroll?.parentElement?.querySelector('[aria-label="Resolved output"]') ?? null;
  const anywhere = found ?? view.container.querySelector('[aria-label="Resolved output"]');
  if (anywhere === null) throw new Error("the resolved-output readout did not render");
  return anywhere.textContent ?? "";
}

/**
 * solid → blur → output, with the BLUR pinned to a fixed 4000x4000.
 *
 * `blur` because it takes an input and materializes a target of its own, so the compiler
 * has a real resolution decision to make for it rather than a sink default.
 */
async function mountAt(deviceCap: number) {
  const runtime = newRuntime();
  const seeded = await patch(runtime, [
    { op: "addNode", ref: "$solid", type: "solid", position: { x: -300, y: 0 } },
    { op: "addNode", ref: "$blur", type: "blur", position: { x: 0, y: 0 } },
    { op: "addNode", ref: "$out", type: "output", position: { x: 300, y: 0 } },
    {
      op: "connect",
      source: { nodeId: "$solid", portId: "out" },
      target: { nodeId: "$blur", portId: "input" },
    },
    {
      op: "connect",
      source: { nodeId: "$blur", portId: "out" },
      target: { nodeId: "$out", portId: "input" },
    },
  ]);
  const blur = seeded.output.createdIds["$blur"] as string;

  // The project cap is the document default (`graph.ts`: 4096) — asserted, not assumed,
  // because the whole fixture rests on 4000 sitting UNDER it.
  expect(runtime.bus.store.getSettings?.()?.limits?.maxResolution ?? PROJECT_CAP).toBe(PROJECT_CAP);
  await patch(runtime, [
    {
      op: "setNodeResolution",
      nodeId: blur,
      resolution: { mode: "fixed", width: ASKED, height: ASKED },
    },
  ]);

  const { backend, plans } = capturingBackend();
  const status: GpuStatus = {
    kind: "ready",
    capabilities: capabilities(deviceCap),
    baseline: true,
    backend,
  };
  const view = render(
    <App runtime={runtime} storage={createMemoryStorage()} gpuProbe={() => Promise.resolve(status)} />,
  );
  await act(async () => {});
  await waitFor(() => {
    expect(plans.length).toBeGreaterThan(0);
  });
  await settle();

  const plan = plans[plans.length - 1];
  if (plan === undefined) throw new Error("the backend was handed no plan");
  const row = plan.outputs.find((output) => output.nodeId === blur);
  if (row === undefined) throw new Error("the plan materialized no output for the blur");
  return { view, blur, planned: [row.size[0], row.size[1]] as const };
}

describe("T1064 — the inspector shows the resolution the compiler actually resolved", () => {
  it("shows the DEVICE ceiling on a device below the project cap", async () => {
    const { view, blur, planned } = await mountAt(SMALL_DEVICE);

    /*
     * NON-VACUITY FIRST, and it is the whole point of the fixture: the plan really did
     * come back at the device ceiling rather than at what was asked for. Without this,
     * "the panel agrees with the plan" would be satisfied by both of them being wrong.
     */
    expect(planned).toEqual([SMALL_DEVICE, SMALL_DEVICE]);

    await selectNode(view, blur);
    const shown = readout(view);
    // THE CLAIM. Before this row the panel printed 4000 here — a size no node on a
    // 2048-limit device has ever had.
    expect(shown).toContain(`${planned[0]} × ${planned[1]}`);
    expect(shown).not.toContain(String(ASKED));
  }, 30_000);

  it("shows the asked-for size when the device can allocate it — the converse", async () => {
    // The same override, the same project cap, a device that can take it. An
    // implementation that clamped to a constant passes the case above and fails here.
    const { view, blur, planned } = await mountAt(BIG_DEVICE);
    expect(planned).toEqual([ASKED, ASKED]);

    await selectNode(view, blur);
    expect(readout(view)).toContain(`${ASKED} × ${ASKED}`);
  }, 30_000);
});
