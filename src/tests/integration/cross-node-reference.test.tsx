// @vitest-environment jsdom
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { createMemoryStorage, installDomStubs } from "@ui/testing/install-dom-stubs.ts";
import { installFlowStubs } from "@editor/graph-canvas/testing.tsx";
import type { CompiledGraph } from "@compiler/index.ts";
import type { BackendCapabilities } from "@domain/types/backend.ts";
import type { GraphPatchOperation } from "@domain/types/patch.ts";
import type { ShaderloomBackend } from "@runtime/backend/index.ts";
import { App } from "../../app/app.tsx";
import { createAppRuntime } from "../../app/app-runtime.ts";
import type { AppRuntime } from "../../app/app-runtime.ts";
import type { GpuStatus } from "../../app/gpu-status.ts";

/**
 * T316 / §V148 / §V61 — a cross-node reference reaches the GPU, and the panel agrees.
 *
 * `op('blur1').par.size` has been storable and rename-rewritable since T221 and was not
 * READABLE: the evaluator said so in as many words, so §V148's round trip (copy →
 * paste → evaluate == the source's value) held only for the same-node case, which becomes
 * a bind.
 *
 * The reason this test is at the composed level rather than in the resolver's own suite
 * is B8. When the compiler and the inspector each had an opinion about what a parameter
 * was worth, the inspector showed the corrected colour and the GPU rendered the
 * uncorrected one, and both halves passed their own tests the whole time. A read path
 * supplied to one side and not the other rebuilds that bug exactly, inverted — so what is
 * asserted here is that the number in the PLAN and the number in the PANEL are the same
 * number, from one run of the real app.
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

const SOURCE_SIZE = 23;

function capturingBackend(): { backend: ShaderloomBackend; plans: CompiledGraph[] } {
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
    compile: async (plan: CompiledGraph) => {
      plans.push(plan);
      return { id: "plan", passes: [] };
    },
    render: () => {},
    resize: () => {},
    updateUniforms: () => {},
    resetTemporalHistory: () => {},
    dispose: () => {},
  } as unknown as ShaderloomBackend;
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

/**
 * solid → source blur → subject blur → output, where the SUBJECT's size is an expression
 * reading the SOURCE's size by name.
 */
async function mountWithReference(expression: string) {
  const runtime = newRuntime();
  const seeded = await patch(runtime, [
    { op: "addNode", ref: "$solid", type: "solid", position: { x: -300, y: 0 } },
    { op: "addNode", ref: "$src", type: "blur", position: { x: 0, y: 0 } },
    { op: "addNode", ref: "$subject", type: "blur", position: { x: 300, y: 0 } },
    { op: "addNode", ref: "$out", type: "output", position: { x: 600, y: 0 } },
    {
      op: "connect",
      source: { nodeId: "$solid", portId: "out" },
      target: { nodeId: "$src", portId: "input" },
    },
    {
      op: "connect",
      source: { nodeId: "$src", portId: "out" },
      target: { nodeId: "$subject", portId: "input" },
    },
    {
      op: "connect",
      source: { nodeId: "$subject", portId: "out" },
      target: { nodeId: "$out", portId: "input" },
    },
  ]);
  const ids = {
    src: seeded.output.createdIds["$src"] as string,
    subject: seeded.output.createdIds["$subject"] as string,
  };

  // The source's NAME is what the reference names (§V129: names are identifiers).
  const sourceName = runtime.bus.store.getGraph().nodes[ids.src]?.label;
  expect(sourceName).toBeDefined();

  await patch(runtime, [
    { op: "setParameters", nodeId: ids.src, parameters: { size: SOURCE_SIZE } },
    {
      op: "setParameters",
      nodeId: ids.subject,
      parameters: {
        size: {
          mode: "expression",
          bindings: {
            expression: { kind: "expression", source: expression.replace("%s", sourceName as string) },
          },
        },
      },
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
  return { runtime, view, ids, plan, sourceName: sourceName as string };
}

describe("T316 — a cross-node reference resolves everywhere (§V148, §V61)", () => {
  it("puts the referenced value in the plan's uniforms", async () => {
    const { ids, plan } = await mountWithReference("op('%s').par.size");

    // NON-VACUITY: the source really is in the plan at the value being referenced, so a
    // match below is a resolution and not a coincidence of defaults.
    expect(sizesFor(plan, ids.src)).toContain(SOURCE_SIZE);
    // THE CLAIM: the subject's uniform carries the SOURCE's number, not blur's default 8.
    expect(sizesFor(plan, ids.subject)).toContain(SOURCE_SIZE);
    expect(sizesFor(plan, ids.subject)).not.toContain(8);
  }, 30_000);

  it("evaluates the reference as arithmetic, not as a copied value", async () => {
    const { ids, plan } = await mountWithReference("op('%s').par.size * 2 + 1");
    expect(sizesFor(plan, ids.subject)).toContain(SOURCE_SIZE * 2 + 1);
  }, 30_000);

  it("shows the SAME number in the inspector as the plan carries (B8)", async () => {
    const { view, ids, plan } = await mountWithReference("op('%s').par.size");

    // Select the subject the way a person does — a real click on its node — so the
    // inspector is showing what a user would be looking at.
    const element = view.container.querySelector(`[data-testid="node-${ids.subject}"]`);
    if (element === null) throw new Error("the subject node did not render");
    await act(async () => {
      const win = element.ownerDocument.defaultView;
      if (win === null) throw new Error("no window");
      for (const type of ["mousedown", "mouseup", "click"]) {
        const event = new win.MouseEvent(type, { bubbles: true, cancelable: true, clientX: 40, clientY: 20 });
        Object.defineProperty(event, "view", { value: win });
        element.dispatchEvent(event);
      }
    });
    await settle();

    const planned = sizesFor(plan, ids.subject)[0];
    expect(planned).toBe(SOURCE_SIZE);

    // The panel renders the resolved value into its number field. Finding the plan's
    // number on screen is the whole assertion: one document, one resolver, one answer.
    const shown = view.container.querySelectorAll<HTMLInputElement>('input[type="text"], input[type="number"]');
    // Compared as NUMBERS, not strings: the field formats to its own precision ("23.00"),
    // and the claim is that the panel and the plan hold the same value, not that they
    // render it identically.
    const values = [...shown]
      .map((input) => Number.parseFloat(input.value))
      .filter((value) => Number.isFinite(value));
    expect(values).toContain(planned);
  }, 30_000);

  it("reports a reference to a node that is not there, rather than rendering a default", async () => {
    const { plan } = await mountWithReference("op('doesNotExist').par.size");
    const codes = plan.diagnostics.map((diagnostic) => diagnostic.code);
    expect(codes).toContain("parameter.expression");
    expect(
      plan.diagnostics.some((diagnostic) => diagnostic.message.includes("doesNotExist")),
    ).toBe(true);
  }, 30_000);
});
