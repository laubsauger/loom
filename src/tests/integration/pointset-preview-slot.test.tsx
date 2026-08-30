// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { createMemoryStorage, installDomStubs } from "@ui/testing/install-dom-stubs.ts";
import { installFlowStubs } from "@editor/graph-canvas/testing.tsx";
import type { GraphPatchOperation } from "@domain/types/patch.ts";
import { App } from "../../app/app.tsx";
import { createAppRuntime } from "../../app/app-runtime.ts";
import type { AppRuntime } from "../../app/app-runtime.ts";
import type { GpuStatus } from "../../app/gpu-status.ts";

/**
 * B65 — DOES A POINT NODE HAVE A PLACE TO SHOW ITS SPLAT (§V350, T373, T415)?
 *
 * ## The bug
 *
 * `NodeView` decided whether to render a preview region from three facts: a texture2d
 * output, `category === "value"`, or a declared sink. A point generator is none of them,
 * so the region was never created — and everything downstream of it is bounds-driven.
 * `NodePreviewSlot` publishes the box it measures; `useNodePreviews` needs that box to
 * register the node as a preview sink; the sink is what makes the compiler synthesize the
 * splat target T373 built. No div, no bounds, no sink, no target, no picture — with every
 * unit suite in that chain green, because each one was handed the wiring it was testing.
 *
 * ## Why this gate is at the composed surface and asserts EXISTENCE
 *
 * §V350: T373's own coverage gate asserts that every pointset producer is a preview
 * CANDIDATE. That is true and it was true throughout the bug — it checks the REQUEST side
 * of the pipeline, one handoff away from the author's own code, while the failure was on
 * the DISPLAY side. So this asks the outermost observable question instead: mount the real
 * app around a real point generator from the real registry, and look for the node's
 * preview region in the tree.
 *
 * §V339 applies and is answered deliberately rather than dodged: a DOM-existence assertion
 * is NOT evidence that anything is visible, and jsdom paints nothing. Existence is the
 * right assertion for THIS defect specifically, because the element genuinely did not
 * exist — there was no box to be invisible. Whether the tile inside it ever gets pixels is
 * a GPU fact this environment cannot see at all, and the Dawn splat test (T373) is what
 * covers that end.
 */

beforeAll(() => {
  installDomStubs();
  installFlowStubs();
});
afterEach(cleanup);

const NO_WEBGPU: GpuStatus = { kind: "unavailable", reason: "No WebGPU in this environment." };

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

async function mountWith(type: string) {
  const runtime = newRuntime();
  const seeded = await seed(runtime, [
    { op: "addNode", ref: "$n", type, position: { x: 0, y: 0 } },
  ]);
  const nodeId = seeded.output.createdIds["$n"] as string;
  const probe = () => Promise.resolve(NO_WEBGPU);
  const view = await act(async () =>
    render(<App runtime={runtime} storage={createMemoryStorage()} gpuProbe={probe} />),
  );
  return { runtime, nodeId, container: view.container };
}

/**
 * There is deliberately no "a node with nothing to show has no slot" control here, and
 * the reason is a measurement rather than an omission: with this fix in, EVERY definition
 * in the shipped catalogue produces a texture, a pointset, a channel or is a sink, so no
 * real node is a negative control. Sensitivity is proven the other way instead — drop the
 * `producesPointset` disjunct in `node-view.tsx` and every case below goes red.
 */
describe("a point producer has a preview region in the running app (B65)", () => {
  it.each([["pointGenerator"], ["pointTorus"], ["pointKernel"]])(
    "renders the preview slot for %s",
    async (type) => {
      const { nodeId, container } = await mountWith(type);
      expect(container.querySelector(`[data-testid="node-preview-${nodeId}"]`)).not.toBeNull();
    },
  );
});
