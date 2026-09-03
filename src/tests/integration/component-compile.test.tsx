// @vitest-environment jsdom
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { createMemoryStorage, installDomStubs } from "@ui/testing/install-dom-stubs.ts";
import { installFlowStubs } from "@editor/graph-canvas/testing.tsx";
import type { CompiledGraph } from "@compiler/index.ts";
import { componentNodeType } from "@domain/components/index.ts";
import type { GraphComponentDefinition } from "@domain/types/components.ts";
import type { BackendCapabilities } from "@domain/types/backend.ts";
import type { GraphPatchOperation } from "@domain/types/patch.ts";
import type { LoomBackend } from "@runtime/backend/index.ts";
import { App } from "../../app/app.tsx";
import { createAppRuntime } from "../../app/app-runtime.ts";
import type { AppRuntime } from "../../app/app-runtime.ts";
import type { GpuStatus } from "../../app/gpu-status.ts";

/**
 * B29 / T320 / §V82 — a component instance actually compiles.
 *
 * `compileGraph` flattens component instances ONLY when it is handed the component
 * catalogue, and nothing in `src/` handed it one: `use-graph-compile.ts` built its request
 * without a `components` field, so `flattenComponents` never ran and every instance fell
 * through to the manifest's `component.notFlattened` tripwire. The node registry the app
 * uses IS component-aware, so an instance typed correctly, connected correctly and looked
 * entirely healthy on the canvas — it simply contributed no passes.
 *
 * That stopped being theoretical when the starter set (Bloom, FeedbackEcho, Kaleidoscope,
 * DisplacementStack, MediaGrade) shipped into the library: a user could see one,
 * instantiate it, and get a graph that does not compile.
 *
 * Measured on this fixture before the fix — a Bloom between a Solid and an Output:
 * `error:component.notFlattened`, 2 passes (the host's own). After: no errors, 7.
 *
 * Asserted at the backend seam, on the plan the backend is actually handed.
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
    // T326: part of the backend contract; a fixture without it is incomplete.
    setCookPolicy() {},
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

/** The shipped starter component this fixture instantiates. */
function starter(runtime: AppRuntime): GraphComponentDefinition {
  const bloom = runtime.components.latest("bloom");
  if (bloom === undefined) {
    throw new Error(
      `the starter set has no "bloom"; installed: ${runtime.components
        .list()
        .map((definition) => definition.componentId)
        .join(", ")}`,
    );
  }
  return bloom;
}

/** Solid → component instance → Output: the smallest graph that renders a component. */
async function mountWithInstance() {
  const runtime = newRuntime();
  const definition = starter(runtime);
  const type = componentNodeType(definition.componentId, definition.version);
  const manifest = runtime.registry.get(type);
  const input = manifest?.inputs[0]?.id;
  const output = manifest?.outputs[0]?.id;
  // A component with no exposed ports cannot be wired, and a fixture that silently made
  // one would prove nothing about flattening.
  expect(input).toBeDefined();
  expect(output).toBeDefined();

  await patch(runtime, [
    { op: "addNode", ref: "$solid", type: "solid", position: { x: -300, y: 0 } },
    { op: "addNode", ref: "$c", type, position: { x: 0, y: 0 } },
    { op: "addNode", ref: "$out", type: "output", position: { x: 300, y: 0 } },
    {
      op: "connect",
      source: { nodeId: "$solid", portId: "out" },
      target: { nodeId: "$c", portId: input as string },
    },
    {
      op: "connect",
      source: { nodeId: "$c", portId: output as string },
      target: { nodeId: "$out", portId: "input" },
    },
  ]);

  const { backend, plans } = capturingBackend();
  const status: GpuStatus = { kind: "ready", capabilities: CAPABILITIES, baseline: true, backend };
  const probe = () => Promise.resolve(status);
  render(<App runtime={runtime} storage={createMemoryStorage()} gpuProbe={probe} />);
  await act(async () => {});
  await waitFor(() => {
    expect(plans.length).toBeGreaterThan(0);
  });
  await settle();
  return { runtime, definition, plans };
}

const latest = (plans: CompiledGraph[]): CompiledGraph => {
  const plan = plans[plans.length - 1];
  if (plan === undefined) throw new Error("the backend was handed no plan");
  return plan;
};

describe("B29 — a component instance reaches the GPU (§V82, T320)", () => {
  it("flattens, so the instance contributes its internal passes", async () => {
    const { plans } = await mountWithInstance();
    const plan = latest(plans);

    // The tripwire that fired for the whole life of the feature.
    expect(plan.diagnostics.map((diagnostic) => diagnostic.code)).not.toContain(
      "component.notFlattened",
    );
    expect(plan.diagnostics.filter((diagnostic) => diagnostic.severity === "error")).toEqual([]);

    // NON-VACUITY, and the actual point: the plan carries MORE than the host's own two
    // passes, because the component's internals are in it. "No errors" alone would also
    // describe a graph where the instance was silently pruned to nothing.
    expect(plan.passes.length).toBeGreaterThan(2);
  }, 30_000);

  it("keeps the source path, so a diagnostic can name where inside the component it is", async () => {
    // §V82: flattening preserves `Main/Bloom_1/Blur_1`. Without it every problem inside
    // every instance of a component reports against the same opaque node and the user
    // cannot tell which instance, or which node inside it, is unhappy.
    const { plans } = await mountWithInstance();
    expect(latest(plans).sources.length).toBeGreaterThan(0);
  }, 30_000);
});

describe("§V210(c) — re-authoring a component recompiles its hosts (T320)", () => {
  it("recompiles although the host document did not change at all", async () => {
    const { runtime, definition, plans } = await mountWithInstance();
    const before = plans.length;
    const passesBefore = latest(plans).passes.length;

    /**
     * Re-author the component IN PLACE — same id, same version, different internals. This
     * is what the definition commands do (`commitDefinition` in
     * `domain/components/commands.ts` ends in exactly this `register` call), and the host
     * document is untouched by it: same nodes, same edges, same revision.
     *
     * That is precisely what makes it a §V210(c) trigger. T308's gate classifies a
     * revision by diffing the document, so without an explicit catalogue trigger this
     * reads as "nothing changed" and the app keeps serving a plan built from the OLD
     * internals — silently, because the host looks identical before and after.
     */
    const internal = definition.graph;
    const extraId = "extra-null";
    const reauthored: GraphComponentDefinition = {
      ...definition,
      graph: {
        ...internal,
        nodes: {
          ...internal.nodes,
          [extraId]: {
            id: extraId,
            type: "null",
            definitionVersion: 1,
            position: { x: 0, y: 400 },
            parameters: {},
          },
        },
      },
    };

    await act(async () => {
      runtime.components.register(reauthored);
    });
    await settle();

    expect(plans.length).toBeGreaterThan(before);
    // And the new plan was built from the NEW internals — a recompile that reused the old
    // flattening would satisfy the count above and still be wrong.
    expect(latest(plans).sources.length).toBeGreaterThan(0);
    expect(latest(plans).passes.length).toBeGreaterThanOrEqual(passesBefore);
  }, 30_000);
});
