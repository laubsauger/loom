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
 * B46 / T374 / §V61 — a DRIVEN parameter reads the same channel in the panel and the plan.
 *
 * What shipped: `resolveParameters` answers a `driven` slot only when it is given a
 * channel resolver, `src/editor/inspector/` never passed one, and so every driven
 * parameter in the inspector fell back to its retained static and printed
 *
 *   Parameter "rotate.y" is driven by channel "lfo1", which is not attached
 *
 * on a document whose LFO was visibly animating that parameter a few pixels away. The
 * compile and the problems tab had been given the resolver (see the docblocks on
 * `use-graph-compile.ts` and `use-value-graph.ts`); the panel had not. That is B8 with
 * the sides swapped, and §V220's shape again — the resolver existed, was tested, and one
 * consumer was never wired to it.
 *
 * So the test is at the COMPOSED surface and supplies no resolver of its own. It mounts
 * the real `App`, and the number it looks for on screen has to have travelled from a
 * value node, through the app's own merge, into the panel.
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

/** The Constant's value. Not blur's default (8) and not the retained static (3). */
const CHANNEL_VALUE = 23;
const RETAINED = 3;
const BLUR_DEFAULT = 8;

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

/** Every `size` uniform the plan carries for one node's passes. */
function sizesFor(plan: CompiledGraph, nodeId: string): number[] {
  return plan.passes
    .filter((pass) => (pass as { nodeId?: string }).nodeId === nodeId)
    .flatMap((pass) => {
      const uniforms = (pass as { uniforms?: Record<string, unknown> }).uniforms;
      const size = uniforms?.["size"];
      return typeof size === "number" ? [size] : [];
    });
}

function numbersOnScreen(view: ReturnType<typeof render>): number[] {
  const shown = view.container.querySelectorAll<HTMLInputElement>(
    'input[type="text"], input[type="number"]',
  );
  return [...shown]
    .map((input) => Number.parseFloat(input.value))
    .filter((value) => Number.isFinite(value));
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

/** Opens a parameter's mode panel — the row's label IS the disclosure (T204). */
async function expandParameter(view: ReturnType<typeof render>, label: string): Promise<void> {
  const scroll = view.container.querySelector('[data-testid="inspector-scroll"]');
  if (scroll === null) throw new Error("the inspector did not render");
  const toggle = [...scroll.querySelectorAll("button")].find(
    (button) => button.textContent?.trim() === label && button.hasAttribute("aria-expanded"),
  );
  if (toggle === undefined) throw new Error(`no mode disclosure for "${label}"`);
  await act(async () => {
    toggle.click();
  });
  await settle();
}

function inspectorText(view: ReturnType<typeof render>): string {
  return view.container.querySelector('[data-testid="inspector-scroll"]')?.textContent ?? "";
}

/**
 * solid → blur → output, with the blur's size DRIVEN by a Constant's channel.
 *
 * A Constant rather than an LFO on purpose: its channel is a pure function of its own
 * parameter, so the number the panel must show is a fixed, distinctive one and the
 * assertion is not about timing.
 */
async function mountDrivenBy(channel: string | null) {
  const runtime = newRuntime();
  const seeded = await patch(runtime, [
    { op: "addNode", ref: "$solid", type: "solid", position: { x: -300, y: 0 } },
    { op: "addNode", ref: "$blur", type: "blur", position: { x: 0, y: 0 } },
    { op: "addNode", ref: "$out", type: "output", position: { x: 300, y: 0 } },
    { op: "addNode", ref: "$k", type: "constant", position: { x: 0, y: 260 } },
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
  const ids = {
    blur: seeded.output.createdIds["$blur"] as string,
    constant: seeded.output.createdIds["$k"] as string,
  };

  // §V129: the node's NAME is its channel address. Read it rather than assume it.
  const constantName = runtime.bus.store.getGraph().nodes[ids.constant]?.label;
  expect(constantName).toBeDefined();

  await patch(runtime, [
    { op: "setParameters", nodeId: ids.constant, parameters: { value: CHANNEL_VALUE } },
    {
      op: "setParameters",
      nodeId: ids.blur,
      parameters: {
        size: {
          mode: "driven",
          bindings: {
            driven: { kind: "driven", channel: channel ?? (constantName as string) },
            // §V108's retained value — what the panel showed for the whole bug.
            static: { kind: "static", value: RETAINED },
          },
        },
      } as never,
    },
  ]);

  const { backend, plans } = capturingBackend();
  const status: GpuStatus = { kind: "ready", capabilities: CAPABILITIES, baseline: true, backend };
  const probe = () => Promise.resolve(status);
  const view = render(<App runtime={runtime} storage={createMemoryStorage()} gpuProbe={probe} />);
  await act(async () => {});
  await waitFor(() => {
    expect(plans.length).toBeGreaterThan(0);
  });
  await settle();

  const plan = plans[plans.length - 1];
  if (plan === undefined) throw new Error("the backend was handed no plan");
  return { runtime, view, ids, plan, constantName: constantName as string };
}

describe("B46 — the inspector resolves driven parameters through the compile's resolver", () => {
  it("puts the CHANNEL's value in the plan, not the retained static", async () => {
    // Non-vacuity: the channel really does reach the GPU side, so a match in the panel
    // below is agreement and not two independent copies of the same default.
    const { ids, plan } = await mountDrivenBy(null);
    expect(sizesFor(plan, ids.blur)).toContain(CHANNEL_VALUE);
    expect(sizesFor(plan, ids.blur)).not.toContain(RETAINED);
    expect(sizesFor(plan, ids.blur)).not.toContain(BLUR_DEFAULT);
  }, 30_000);

  it("shows that same number in the panel (B8 inverted)", async () => {
    const { view, ids, plan } = await mountDrivenBy(null);
    await selectNode(view, ids.blur);

    expect(sizesFor(plan, ids.blur)).toContain(CHANNEL_VALUE);
    // THE CLAIM. Before T374 this field read 3 — §V108's retained value — while the plan
    // carried 23, which is B8 with the inspector on the fallback side.
    expect(numbersOnScreen(view)).toContain(CHANNEL_VALUE);
    expect(numbersOnScreen(view)).not.toContain(RETAINED);
  }, 30_000);

  it("stops claiming an attached channel is not attached (§V288)", async () => {
    const { view, ids } = await mountDrivenBy(null);
    await selectNode(view, ids.blur);
    await expandParameter(view, "Filter Size");

    // The mode panel is open — otherwise "no message" would be vacuously true.
    expect(inspectorText(view)).toContain("Channel");
    expect(inspectorText(view)).not.toContain("is not attached");
  }, 30_000);

  it("STILL says so when the channel genuinely does not exist", async () => {
    // The control for the assertion above: the same query, the same harness, and the
    // message present — so "not attached" is a fact about the document, not a message
    // the panel has been made incapable of producing.
    const { view, ids } = await mountDrivenBy("ghost1");
    await selectNode(view, ids.blur);
    await expandParameter(view, "Filter Size");

    const text = inspectorText(view);
    expect(text).toContain("is not attached");
    // §V288: the diagnostic names the parameter and the channel it could not find.
    expect(text).toContain("ghost1");
    expect(text).toContain("size");
  }, 30_000);
});
