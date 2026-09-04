// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
 * T1157 — a portrait/landscape swap, asserted on the PIXELS the plan comes back with.
 * ═══════════════════════════════════════════════════════════════════════════════════
 *
 * The owner wanted one click to flip whatever resolution is selected. The interesting
 * claim is therefore not "a handler fired" but "the resolution the project actually uses
 * is the other way round afterwards" — so every case below reads the size out of the plan
 * the backend was handed, the same way `resolution-readout.test.tsx` does, and the click
 * that produces it is a real click on the button a user presses.
 *
 * ## Why this surface and not the two components' own suites
 *
 * `swap-dimensions.test.tsx` asserts the control hands back the swapped pair. That would
 * stay green with the button wired to nothing, wired to the wrong command, or wired to a
 * mode that never reaches the compiler — "built, tested, never wired" (§V220, B46). The
 * link is the claim, so the link is what is exercised: mount the real `App`, click, and
 * require the compiler's own output row to have moved.
 *
 * ## The fixture, pinned rather than read (§V906)
 *
 * 960×540 and 1600×900, written down here. Neither is the document default, and nothing
 * below reads `DEFAULT_PROJECT_SETTINGS`: a gate that measures against a moving constant
 * stops meaning anything the day the constant moves, silently. Both pairs are asymmetric,
 * so a swap is visible; the square case uses 1024×1024 for the opposite reason.
 */

beforeAll(() => {
  installDomStubs();
  installFlowStubs();
});
afterEach(cleanup);

/** Pinned, not read off the defaults (§V906). Asymmetric, so a swap is visible. */
const NODE_BOX = { width: 960, height: 540 } as const;
const PROJECT_BOX = { width: 1600, height: 900 } as const;
const SQUARE = { width: 1024, height: 1024 } as const;
/** Above every size here, so nothing below is clamped and a swap is the only mover. */
const DEVICE_CAP = 16_384;

function capabilities(): BackendCapabilities {
  return {
    tier: "B",
    features: [],
    formats: ["rgba8unorm", "rgba8unorm-srgb", "rgba16float", "r32float", "depth24plus"],
    timestampQuery: false,
    limits: { maxTextureDimension2D: DEVICE_CAP },
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

/** Radix activates a tab on mousedown, which `fireEvent.click` does not synthesise. */
function openCommon(): void {
  const tab = screen.getByRole("tab", { name: "Common" });
  fireEvent.mouseDown(tab, { button: 0 });
  fireEvent.click(tab);
}

/** The size the compiler resolved for one node in the LAST plan the backend was handed. */
function plannedSize(plans: CompiledGraph[], nodeId: string): readonly [number, number] {
  const plan = plans[plans.length - 1];
  if (plan === undefined) throw new Error("the backend was handed no plan");
  const row = plan.outputs.find((output) => output.nodeId === nodeId);
  if (row === undefined) throw new Error(`the plan materialized no output for ${nodeId}`);
  return [row.size[0], row.size[1]] as const;
}

async function press(button: HTMLElement): Promise<void> {
  await act(async () => {
    fireEvent.click(button);
  });
  await settle();
}

function swapButton(scope?: HTMLElement): HTMLButtonElement {
  const query = scope === undefined ? screen : within(scope);
  return query.getByRole("button", { name: "Swap width and height" }) as HTMLButtonElement;
}

/**
 * solid → blur → output. `blur` takes an input and materializes a target of its own, so
 * the compiler has a real resolution decision to make for it; `output` is the sink whose
 * size comes from the PROJECT, which is what the project-level case moves.
 */
async function mount(options: { readonly nodeResolution?: { width: number; height: number } } = {}) {
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
  const out = seeded.output.createdIds["$out"] as string;

  if (options.nodeResolution !== undefined) {
    await patch(runtime, [
      {
        op: "setNodeResolution",
        nodeId: blur,
        resolution: { mode: "fixed", ...options.nodeResolution },
      },
    ]);
  }

  const { backend, plans } = capturingBackend();
  const status: GpuStatus = {
    kind: "ready",
    capabilities: capabilities(),
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
  return { runtime, view, plans, blur, out };
}

/** Opens the settings dialog through the command every door onto it uses (§V307). */
async function openSettings(runtime: AppRuntime): Promise<HTMLElement> {
  await act(async () => {
    await runtime.bus.execute("ui.openSettings", {}, runtime.invocation);
  });
  await settle();
  return screen.getByTestId("project-settings");
}

async function setProjectResolution(
  runtime: AppRuntime,
  resolution: { width: number; height: number },
): Promise<void> {
  await act(async () => {
    await runtime.bus.execute(
      "project.setSettings",
      { settings: { outputResolution: resolution } },
      runtime.invocation,
    );
  });
  await settle();
}

describe("T1157 — one click swaps the pixels a NODE renders at", () => {
  it("turns a fixed 960×540 override into 540×960 in the plan the backend is handed", async () => {
    const { view, plans, blur } = await mount({ nodeResolution: NODE_BOX });

    /*
     * NON-VACUITY FIRST: the override really is in force before the click, at the pinned
     * fixture and not at some clamp or default. Without this, "the plan says 540×960
     * afterwards" could be satisfied by a plan that always said 540×960.
     */
    expect(plannedSize(plans, blur)).toEqual([NODE_BOX.width, NODE_BOX.height]);

    await selectNode(view, blur);
    openCommon();
    await settle();

    const control = swapButton();
    // Derived from the pair, so the button already knows the node is landscape.
    expect(control.dataset["orientation"]).toBe("landscape");

    await press(control);

    // THE CLAIM. Not "setResolution was called" — the compiler resolved the node the
    // other way round, and that is the plan the backend now holds.
    expect(plannedSize(plans, blur)).toEqual([NODE_BOX.height, NODE_BOX.width]);
  }, 30_000);

  it("is one undo, because it is a document edit like any other", async () => {
    const { runtime, view, plans, blur } = await mount({ nodeResolution: NODE_BOX });
    await selectNode(view, blur);
    openCommon();
    await settle();
    await press(swapButton());
    expect(plannedSize(plans, blur)).toEqual([NODE_BOX.height, NODE_BOX.width]);

    await act(async () => {
      await runtime.bus.execute("graph.undo", {}, runtime.invocation);
    });
    await settle();

    expect(plannedSize(plans, blur)).toEqual([NODE_BOX.width, NODE_BOX.height]);
  }, 30_000);

  it("keeps the node in `fit` rather than silently making it `fixed`", async () => {
    /*
     * The swap shares `writeBox` with the two number fields precisely so it cannot decide
     * the MODE for itself. A swap that dropped a `fit` node to `fixed` would look right in
     * the size readout and would have quietly thrown away the aspect-preserving behaviour
     * the user chose — the failure a "just write width and height" implementation makes.
     */
    const { runtime, view, blur } = await mount();
    await patch(runtime, [
      { op: "setNodeResolution", nodeId: blur, resolution: { mode: "fit", ...NODE_BOX } },
    ]);
    await settle();
    await selectNode(view, blur);
    openCommon();
    await settle();

    await press(swapButton());

    const stored = runtime.bus.store.getGraph().nodes[blur];
    // The mode survives, the box is swapped, and the source input the mode reads from is
    // still named — all three because the swap goes through the same write the fields do.
    expect(stored?.resolution).toEqual({
      mode: "fit",
      width: NODE_BOX.height,
      height: NODE_BOX.width,
      input: "input",
    });
  }, 30_000);
});

describe("T1157 — one click swaps the pixels the PROJECT renders at", () => {
  it("turns a 1600×900 output resolution into 900×1600 in the compiled plan", async () => {
    const { runtime, plans, out } = await mount();
    await setProjectResolution(runtime, PROJECT_BOX);

    // NON-VACUITY: the sink really is at the pinned project size before the click.
    expect(plannedSize(plans, out)).toEqual([PROJECT_BOX.width, PROJECT_BOX.height]);

    const dialog = await openSettings(runtime);
    await press(swapButton(dialog));

    // THE CLAIM, at the level the owner asked about: the project's own resolution.
    expect(plannedSize(plans, out)).toEqual([PROJECT_BOX.height, PROJECT_BOX.width]);
    expect(runtime.bus.store.getSettings().outputResolution).toEqual({
      width: PROJECT_BOX.height,
      height: PROJECT_BOX.width,
    });
  }, 30_000);

  it("dirties nothing on a square — the control says so instead of pretending", async () => {
    const { runtime, plans, out } = await mount();
    await setProjectResolution(runtime, SQUARE);
    expect(plannedSize(plans, out)).toEqual([SQUARE.width, SQUARE.height]);

    const dialog = await openSettings(runtime);
    const control = swapButton(dialog);
    expect(control.dataset["orientation"]).toBe("square");
    expect(control.disabled).toBe(true);

    /*
     * And the SYSTEM's half of the no-op, which holds whether or not the button is
     * disabled: the write a swap would make on a square is the value already there, and
     * `project.setSettings` refuses to burn a revision or an undo slot for it. This is
     * what an `orientation` field stored beside the pair would break — setting one on a
     * square is a document change with no pixels behind it (§T1064).
     */
    const before = runtime.bus.store.getRevision();
    const outcome = await runtime.bus.execute(
      "project.setSettings",
      { settings: { outputResolution: { width: SQUARE.height, height: SQUARE.width } } },
      runtime.invocation,
    );
    expect(outcome.output.changed).toEqual([]);
    expect(outcome.output.structural).toBe(false);
    expect(runtime.bus.store.getRevision()).toBe(before);
  }, 30_000);
});
