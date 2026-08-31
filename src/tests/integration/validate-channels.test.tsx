// @vitest-environment jsdom
import { act, cleanup, render, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { createMemoryStorage, installDomStubs } from "@ui/testing/install-dom-stubs.ts";
import { installFlowStubs } from "@editor/graph-canvas/testing.tsx";
import type { CompiledGraph } from "@compiler/index.ts";
import { createDomainBus } from "@domain/commands/index.ts";
import type { BackendCapabilities } from "@domain/types/backend.ts";
import type { InvocationContext } from "@domain/types/commands.ts";
import type { GraphPatchOperation } from "@domain/types/patch.ts";
import { allNodeDefinitions } from "@nodes/definitions/index.ts";
import { createNodeRegistry } from "@nodes/registry/registry.ts";
import type { ShaderloomBackend } from "@runtime/backend/index.ts";
import { App } from "../../app/app.tsx";
import { createAppRuntime } from "../../app/app-runtime.ts";
import type { AppRuntime } from "../../app/app-runtime.ts";
import type { GpuStatus } from "../../app/gpu-status.ts";
import { useGraphCompile } from "../../app/use-graph-compile.ts";

/**
 * T593 / B121 (§V61, §V109, B8) — the VALIDATOR and the COMPILER read ONE resolver.
 *
 * ## What was wrong
 *
 * `project.validate` lives in the domain, on the bus, and had no app context — so it
 * called `validateGraph(graph, registry)` with no `ChannelResolver` at all, and
 * `resolveParameters` therefore answered every `driven` slot with
 *
 *   Parameter "radius2" is driven by channel "…", which is not attached
 *
 * unconditionally, in every document and every tab. An agent driving the running app
 * reported that no driven binding ever attaches, "lfo1 fails too — an LFO has no audio
 * dependency, no file, no capture, nothing but the frame clock", and reasonably concluded
 * the channel bus was broken. Nothing was: the reader had no eyes.
 *
 * Third instance of B8's class. The first was the compiler versus the inspector's own
 * evaluator; the second was the inspector missing this same option (`use-graph-compile.ts`
 * records it, and its conclusion is the rule this file gates: THE TWO MUST NOT BE TWO
 * RESOLVERS).
 *
 * ## Why the gate is shaped like this
 *
 * §V437: gate the PROPERTY, not the instance. "validate reports no diagnostic for a driven
 * parameter" is the instance, and it would pass just as well if the command built its own
 * `graphChannelResolver(graph, registry)` — which is exactly the second resolver B8
 * forbids and which would agree, today, by inspection. So:
 *
 *  1. IDENTITY. What the bus hands a command is the SAME OBJECT the compile used —
 *     `toBe`, not `toEqual`. A rebuild fails this outright.
 *  2. REACH. The driven channel is `valueMath` fed by a Constant, and the value graph is
 *     the ONLY resolver in the ladder that answers it: `graphChannelResolver` answers for
 *     nodes declaring `valueChannel` — the LFO/Constant/Timer trio — and returns undefined
 *     for a Math stage. So a rebuilt resolver does not merely fail an identity check here,
 *     it gets the ANSWER wrong, in the same direction the bug did.
 *  3. AGREEMENT. The plan the backend is handed carries the channel's number, and the
 *     validator reports nothing about that parameter — one document, two readers.
 *  4. SENSITIVITY (§V461). A channel that genuinely does not exist STILL reports "not
 *     attached", so the false negative has not been traded for a false positive.
 *  5. HONESTY (§V338). A headless bus — no app, no resolver — says THAT, and does not
 *     accuse the document of an unattached channel it never looked for.
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

/** constant × 2. Not blur's default (8) and not the retained static (3). */
const CONSTANT = 11;
const THROUGH_MATH = 22;
const RETAINED = 3;
const BLUR_DEFAULT = 8;

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
    setCookPolicy: () => {},
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
 * solid → blur → output, with the blur's size DRIVEN through the VALUE GRAPH:
 * `constant1 (11) → valueMath1 (× 2) = 22`.
 *
 * A Math stage rather than an LFO deliberately (see point 2 in the module note): the
 * number is fixed, so the assertion is not about timing, and no resolver reachable from
 * inside the domain can answer the channel.
 */
async function mountDrivenBy(channel: string | null) {
  const runtime = newRuntime();
  const seeded = await patch(runtime, [
    { op: "addNode", ref: "$solid", type: "solid", position: { x: -300, y: 0 } },
    { op: "addNode", ref: "$blur", type: "blur", position: { x: 0, y: 0 } },
    { op: "addNode", ref: "$out", type: "output", position: { x: 300, y: 0 } },
    { op: "addNode", ref: "$k", type: "constant", position: { x: -300, y: 260 } },
    { op: "addNode", ref: "$m", type: "valueMath", position: { x: 0, y: 260 } },
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
    { op: "connect", source: { nodeId: "$k", portId: "out" }, target: { nodeId: "$m", portId: "a" } },
  ]);
  const ids = {
    blur: seeded.output.createdIds["$blur"] as string,
    constant: seeded.output.createdIds["$k"] as string,
    math: seeded.output.createdIds["$m"] as string,
  };

  // §V129: the node's NAME is its channel address. Read it rather than assume it.
  const mathName = runtime.bus.store.getGraph().nodes[ids.math]?.label;
  expect(mathName).toBeDefined();

  await patch(runtime, [
    { op: "setParameters", nodeId: ids.constant, parameters: { value: CONSTANT } },
    { op: "setParameters", nodeId: ids.math, parameters: { operation: "multiply", operand: 2 } },
    {
      op: "setParameters",
      nodeId: ids.blur,
      parameters: {
        size: {
          mode: "driven",
          bindings: {
            driven: { kind: "driven", channel: channel ?? (mathName as string) },
            // §V108's retained value — what validate reported for the whole bug.
            static: { kind: "static", value: RETAINED },
          },
        },
      } as never,
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

  const plan = plans[plans.length - 1];
  if (plan === undefined) throw new Error("the backend was handed no plan");
  return { runtime, ids, plan, mathName: mathName as string };
}

/** Every parameter-resolution diagnostic in a report, in order. */
const parameterDiagnostics = (diagnostics: ReadonlyArray<{ code: string; message: string }>) =>
  diagnostics.filter((entry) => entry.code.startsWith("parameter."));

describe("T593 — one resolver, two readers", () => {
  it("hands a command the SAME resolver object the compile used, not an equal one", async () => {
    // §V437's property, stated as identity. A `graphChannelResolver` rebuilt inside the
    // command would be a different object that agrees on the trio and disagrees on
    // everything else — the failure `use-graph-compile.ts:50` names by name.
    const runtime = newRuntime();
    const { result } = renderHook(() => useGraphCompile(runtime, CAPABILITIES));
    await settle();
    expect(runtime.bus.channelResolver()).toBe(result.current.channels);
  }, 30_000);

  it("re-publishes as the document changes, so a command never reads a stale ladder", async () => {
    const runtime = newRuntime();
    const { result, rerender } = renderHook(() => useGraphCompile(runtime, CAPABILITIES));
    await settle();
    const first = result.current.channels;

    await act(async () => {
      await patch(runtime, [
        { op: "addNode", ref: "$k", type: "constant", position: { x: 0, y: 0 } },
      ]);
    });
    rerender();
    await settle();

    // The memo is keyed on the document, so this IS a new object — and the bus must be
    // handing out the new one. An effect that captured the first would pin every later
    // command to a resolver built from a document that no longer exists.
    expect(result.current.channels).not.toBe(first);
    expect(runtime.bus.channelResolver()).toBe(result.current.channels);
  }, 30_000);

  it("validates a VALUE-GRAPH channel clean, on the plan that carries its number", async () => {
    const { runtime, ids, plan } = await mountDrivenBy(null);

    // Non-vacuity, the compiler's side: the channel really did reach the GPU plan, so
    // "validate says nothing" below is agreement rather than two silences.
    expect(sizesFor(plan, ids.blur)).toContain(THROUGH_MATH);
    expect(sizesFor(plan, ids.blur)).not.toContain(RETAINED);
    expect(sizesFor(plan, ids.blur)).not.toContain(BLUR_DEFAULT);

    const report = await runtime.bus.execute("project.validate", {}, runtime.invocation);
    // THE CLAIM. Before this fix every one of these documents came back with
    // `parameter.driven` — "not attached" — about a channel the plan was already using.
    expect(parameterDiagnostics(report.output.diagnostics)).toEqual([]);
    expect(report.output.ok).toBe(true);
  }, 30_000);

  it("STILL says not attached when the channel genuinely does not exist (§V461)", async () => {
    // The control. Without it the assertion above would also pass for a validator that had
    // been made incapable of producing the message at all — a false positive traded for a
    // false negative, which is not a fix.
    const { runtime } = await mountDrivenBy("ghost1");
    const report = await runtime.bus.execute("project.validate", {}, runtime.invocation);
    const driven = report.output.diagnostics.filter((entry) => entry.code === "parameter.driven");
    expect(driven).toHaveLength(1);
    expect(driven[0]?.message).toContain("ghost1");
    expect(driven[0]?.message).toContain("not attached");
  }, 30_000);
});

describe("T593 — a headless bus says it cannot look (§V338)", () => {
  it("reports the MISSING RESOLVER, not an unattached channel", async () => {
    // No app, so no ladder. The document is fine and its LFO is right there; what is
    // absent is the reader. An absence has to name what would make it present, and "the
    // channel is not attached" is a claim about the document that nothing here checked.
    const registry = createNodeRegistry(allNodeDefinitions).view();
    const { bus } = createDomainBus({ registry });
    const context: InvocationContext = {
      actor: { kind: "agent", id: "headless" },
      projectId: "project-1",
      capabilities: [],
    };

    const seeded = await bus.execute(
      "graph.applyPatch",
      {
        baseRevision: bus.store.getRevision(),
        operations: [
          { op: "addNode", ref: "$solid", type: "solid", position: { x: -300, y: 0 } },
          { op: "addNode", ref: "$blur", type: "blur", position: { x: 0, y: 0 } },
          { op: "addNode", ref: "$lfo", type: "lfo", position: { x: 0, y: 260 } },
          {
            op: "connect",
            source: { nodeId: "$solid", portId: "out" },
            target: { nodeId: "$blur", portId: "input" },
          },
        ],
      },
      context,
    );
    const blur = seeded.output.createdIds["$blur"] as string;
    const lfo = seeded.output.createdIds["$lfo"] as string;
    const lfoName = bus.store.getGraph().nodes[lfo]?.label as string;

    await bus.execute(
      "graph.applyPatch",
      {
        baseRevision: bus.store.getRevision(),
        operations: [
          {
            op: "setParameters",
            nodeId: blur,
            parameters: {
              size: {
                mode: "driven",
                bindings: {
                  driven: { kind: "driven", channel: lfoName },
                  static: { kind: "static", value: RETAINED },
                },
              },
            } as never,
          },
        ],
      },
      context,
    );

    expect(bus.channelResolver()).toBeUndefined();
    const report = await bus.execute("project.validate", {}, context);
    const parameters = parameterDiagnostics(report.output.diagnostics);
    expect(parameters.map((entry) => entry.code)).toEqual(["parameter.channels.unavailable"]);
    // It names the missing READER and what would supply one, and it does not say the
    // channel is unattached — the LFO is in the document and nothing looked for it.
    expect(parameters[0]?.message).toContain("no channel resolver");
    expect(parameters[0]?.message).not.toContain("not attached");
  }, 30_000);
});
