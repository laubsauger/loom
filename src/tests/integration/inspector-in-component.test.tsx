// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { createMemoryStorage, installDomStubs } from "@ui/testing/install-dom-stubs.ts";
import { installFlowStubs } from "@editor/graph-canvas/testing.tsx";
import { componentNodeType } from "@domain/components/component-type.ts";
import type { CompiledGraph } from "@compiler/index.ts";
import type { GraphComponentDefinition } from "@domain/types/components.ts";
import type { GraphPatchOperation } from "@domain/types/patch.ts";
import type { NodeId } from "@domain/types/ids.ts";
import type { BackendCapabilities } from "@domain/types/backend.ts";
import type { LoomBackend } from "@runtime/backend/index.ts";
import { App } from "../../app/app.tsx";
import { createAppRuntime } from "../../app/app-runtime.ts";
import type { AppRuntime } from "../../app/app-runtime.ts";
import type { GpuStatus } from "../../app/gpu-status.ts";

/**
 * T1202 / §B189 — THE INSPECTOR SAID AN INTERIOR NODE WAS NOT IN THE PLAN. IT WAS.
 *
 * Owner, twice, the second time after losing an investigation to it: *"When I click on a
 * component's node it says NOT IN THE COMPILED PLAN for some reason, even where it IS the
 * output."* Measured on E47's real plan before the fix: `matte` matched no row, while
 * `cut/matte` returned `1280x720 rgba16float`. The rows were there; the lookup was
 * unprefixed, and `app.tsx` handed the pane `null` for the plan inside a component
 * anyway — §T423's safe half of an answer whose other half (translate the ids, §T1019)
 * arrived on the canvas in §T1051 and never on this pane.
 *
 * ## Why this is an `<App>` test and not a pane test
 *
 * The defect was TWO props, in two files, and either one alone still shows the lie: a
 * `InspectorPane` mounted by a test would be handed a plan and a path by the test itself
 * and be green by construction, which is this project's dominant bug class wearing a
 * green suit. So: the real app, a real starter component, a real compiled plan taken off
 * the backend seam, a real dive, and a real click on the interior node.
 *
 * ## What is asserted, and why in this order
 *
 * 1. THE PREMISE, from the plan itself — there is no row under the bare inner id and
 *    there is one under `instance/inner`. Without this the rest could pass against a plan
 *    where both spellings happened to work, and prove nothing.
 * 2. THE TEXT THE OWNER READ — the readout must not say "not in the compiled plan", and
 *    must show the size and format the plan's row actually carries. Exact values off the
 *    plan, never a shape check (§V147's spirit on a text surface).
 * 3. THE SIBLING LOOKUP — `inputResolutionsFor` had the identical bug, and its damage is
 *    quieter: the size SOURCE for an inheriting node degrades to "input unresolved"
 *    because the upstream row was searched for under its inner id too. Asserted through
 *    the words the panel writes, so a fix to one lookup and not the other is still red.
 * 4. THE CASE THE MESSAGE IS STILL FOR — an interior node the compiler really did drop
 *    must keep reading "not in the compiled plan", or the fix has replaced one lie with
 *    another. That orphan is CONSTRUCTED, because the shipped component has none.
 *
 * Sensitivity, red-verified by reverting each half separately: dropping `componentPath`
 * in `app.tsx`, restoring `compiled={insideComponent ? null : ...}`, or unprefixing
 * either lookup in `side-panes.tsx` brings "not in the compiled plan" back.
 *
 * The chosen interior node is DERIVED (first sorted id that inherits its resolution from
 * a connected input the plan resolved), not named: the component boundary port names are
 * being reworked in a parallel track, and a fixture keyed on `in_field` would go red for
 * a reason that has nothing to do with this bug.
 */

const CAPABILITIES: BackendCapabilities = {
  tier: "B",
  features: [],
  formats: ["rgba8unorm", "rgba8unorm-srgb", "rgba16float", "r32float", "depth24plus"],
  timestampQuery: false,
  limits: { maxTextureDimension2D: 8192 },
};

beforeAll(() => {
  installDomStubs();
  installFlowStubs();
});
afterEach(cleanup);

/** A backend that renders nothing and keeps every plan it is handed. */
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

/** Solid → Bloom instance → Output: the smallest graph whose plan contains an interior. */
async function appAroundAnInstance() {
  const runtime = newRuntime();
  const definition: GraphComponentDefinition | undefined = runtime.components.latest("bloom");
  if (definition === undefined) throw new Error("the starter set has no \"bloom\"");
  const type = componentNodeType(definition.componentId, definition.version);
  const manifest = runtime.registry.get(type);
  const inPort = manifest?.inputs[0]?.id;
  const outPort = manifest?.outputs[0]?.id;
  // A component with no exposed ports cannot be wired, and an unwired instance is pruned
  // out of the plan — which is the one state the message under test is TRUE for.
  expect(inPort).toBeDefined();
  expect(outPort).toBeDefined();

  const placed = await patch(runtime, [
    { op: "addNode", ref: "$solid", type: "solid", position: { x: -300, y: 0 } },
    { op: "addNode", ref: "$c", type, position: { x: 0, y: 0 } },
    { op: "addNode", ref: "$out", type: "output", position: { x: 300, y: 0 } },
    {
      op: "connect",
      source: { nodeId: "$solid", portId: "out" },
      target: { nodeId: "$c", portId: inPort as string },
    },
    {
      op: "connect",
      source: { nodeId: "$c", portId: outPort as string },
      target: { nodeId: "$out", portId: "input" },
    },
  ]);
  expect(placed.status, placed.diagnostics.map((d) => d.message).join("; ")).toBe("applied");
  const instance = placed.output.createdIds["$c"] as NodeId;

  const { backend, plans } = capturingBackend();
  const status: GpuStatus = { kind: "ready", capabilities: CAPABILITIES, baseline: true, backend };
  render(
    <App runtime={runtime} storage={createMemoryStorage()} gpuProbe={() => Promise.resolve(status)} />,
  );
  await act(async () => {});
  await waitFor(() => {
    expect(plans.length).toBeGreaterThan(0);
  });
  const plan = plans[plans.length - 1] as CompiledGraph;
  return { runtime, definition, instance, plan };
}

/**
 * The interior node this test clicks: it INHERITS its size from a connected input the
 * plan resolved, so it exercises both lookups at once — its own row (`plannedOutputFor`)
 * and its upstream's (`inputResolutionsFor`, which writes the source words).
 */
function inheritingInterior(
  runtime: AppRuntime,
  definition: GraphComponentDefinition,
  instance: NodeId,
  plan: CompiledGraph,
): NodeId {
  const interior = definition.graph;
  const flat = (id: string): string => `${instance}/${id}`;
  const hasRow = (id: string): boolean => plan.outputs.some((row) => row.nodeId === flat(id));
  const chosen = Object.keys(interior.nodes)
    .sort()
    .find((id) => {
      const node = interior.nodes[id as NodeId];
      if (node === undefined || !hasRow(id)) return false;
      const policy = runtime.registry.get(node.type)?.resolutionPolicy;
      if (policy?.kind !== "inherit") return false;
      // Its input must be fed by something the plan also resolved, or "input unresolved"
      // would be the honest answer and the sibling assertion would be vacuous.
      return Object.values(interior.edges).some(
        (edge) => edge.target.nodeId === id && hasRow(edge.source.nodeId),
      );
    });
  if (chosen === undefined) {
    throw new Error(
      `no interior node of "${definition.componentId}" inherits its resolution from a resolved input; ` +
        `plan rows: ${plan.outputs.map((row) => row.nodeId).join(", ")}`,
    );
  }
  return chosen as NodeId;
}

async function dive(runtime: AppRuntime, instance: NodeId): Promise<void> {
  const dived = await act(async () =>
    runtime.bus.execute("graph.diveIn", { nodeId: instance }, runtime.invocation),
  );
  expect(dived.status, dived.diagnostics.map((d) => d.code).join(",")).toBe("applied");
}

/** Click a node on whatever canvas is mounted and wait for the inspector to follow. */
async function select(nodeId: NodeId): Promise<void> {
  const element = await waitFor(() => {
    const found = document.querySelector(`.react-flow__node[data-id="${nodeId}"]`);
    if (found === null) throw new Error(`"${nodeId}" is not on the canvas`);
    return found;
  });
  await act(async () => {
    fireEvent.click(element);
  });
  await waitFor(() => {
    expect(within(inspector()).queryByLabelText("Resolved output")).not.toBeNull();
  });
}

/** The INSPECTOR's readout. The viewer pane publishes one under the same label — that is
 *  the OUTPUT node's size, a different claim about a different node (`side-panes.tsx`'s
 *  `<dl>`), and reading it here would make this file green on the wrong surface. */
const inspector = (): HTMLElement => screen.getByTestId("inspector-scroll");
const readout = (): HTMLElement => within(inspector()).getByLabelText("Resolved output");

describe("T1202 — the inspector reads the plan for a node inside a component (§B189)", () => {
  it("shows the interior node's own size and format instead of \"not in the compiled plan\"", async () => {
    const { runtime, definition, instance, plan } = await appAroundAnInstance();
    const inner = inheritingInterior(runtime, definition, instance, plan);

    // (1) THE PREMISE. The bare inner id is not in the plan and never was; the prefixed
    // one is. This is the whole bug in two assertions, taken off the real plan.
    expect(plan.outputs.filter((row) => row.nodeId === inner)).toEqual([]);
    const row = plan.outputs.find((r) => r.nodeId === `${instance}/${inner}`);
    if (row === undefined) throw new Error("the fixture chose a node with no plan row");

    await dive(runtime, instance);
    await select(inner);

    // (2) THE TEXT THE OWNER READ, and the numbers the plan actually holds.
    const text = readout().textContent ?? "";
    expect(text).not.toContain("not in the compiled plan");
    expect(text).toContain(`${row.size[0]} × ${row.size[1]}`);
    expect(text).toContain(row.format);
  }, 30_000);

  it("resolves the interior node's INPUT row too, so the size source names it", async () => {
    const { runtime, definition, instance, plan } = await appAroundAnInstance();
    const inner = inheritingInterior(runtime, definition, instance, plan);

    await dive(runtime, instance);
    await select(inner);

    /*
     * `inputResolutionsFor`'s own bug, in the words it decides.
     *
     * `resolutionSourceLabel` prints "node default · from <input>" when the upstream row
     * was found and "node default · input unresolved" when it was not — and with the
     * lookup unprefixed it was never found for ANY node inside ANY component, so every
     * inheriting interior node claimed its input was unresolved while its input was
     * sitting in the plan. The compact readout carries the source on its `title` (§V90).
     */
    const title = readout().getAttribute("title") ?? "";
    expect(title).not.toContain("input unresolved");
    expect(title).toContain("node default · from ");
  }, 30_000);

  it("still says \"not in the compiled plan\" for an interior node the plan really dropped", async () => {
    /*
     * THE LEGITIMATE CASE THE FIX COULD HAVE SWALLOWED. Prefixing every lookup must not
     * turn the message into dead code: an interior node NOTHING downstream of it carries
     * to a sink has no row under either spelling, and the readout must keep saying so —
     * that honesty is what §T1064 was for, and it is the half worth keeping.
     *
     * The orphan is CONSTRUCTED rather than looked for. Measured on the shipped `bloom`:
     * every one of its interior nodes has a plan row, so a version of this test that
     * hunted for a rowless one found none and passed by returning early — a guard whose
     * legitimate case never occurs is not a guard. So the component is re-authored in
     * place (the same call `domain/components/commands.ts` ends in) with one unconnected
     * `null` node added, which is exactly what the compiler prunes.
     */
    const { runtime, definition, instance } = await appAroundAnInstance();
    const orphan = "t1202-orphan" as NodeId;
    await act(async () => {
      runtime.components.register({
        ...definition,
        graph: {
          ...definition.graph,
          nodes: {
            ...definition.graph.nodes,
            [orphan]: {
              id: orphan,
              type: "null",
              definitionVersion: 1,
              position: { x: 0, y: 400 },
              parameters: {},
            },
          },
        },
      });
    });
    await act(async () => {});

    await dive(runtime, instance);
    await select(orphan);
    expect(readout().textContent ?? "").toContain("not in the compiled plan");
  }, 30_000);
});
