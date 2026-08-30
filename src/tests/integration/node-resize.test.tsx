// @vitest-environment jsdom
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { createMemoryStorage, installDomStubs } from "@ui/testing/install-dom-stubs.ts";
import { installFlowStubs } from "@editor/graph-canvas/testing.tsx";
import { MIN_NODE_SIZE } from "@domain/types/graph.ts";
import type { GraphPatchOperation } from "@domain/types/patch.ts";
import { loadProject, serializeProjectDocument } from "@domain/project/index.ts";
import { App } from "../../app/app.tsx";
import { createAppRuntime } from "../../app/app-runtime.ts";
import type { AppRuntime } from "../../app/app-runtime.ts";
import type { GpuStatus } from "../../app/gpu-status.ts";

/**
 * T208 / §V116 / §V15 — resizing a node is ONE document edit.
 *
 * Deliberately at the COMPOSED level, driving the real resize control the real node
 * renders inside the real canvas, and asserting on the DOCUMENT rather than on component
 * state. A unit test here would have to supply the pointer stream itself, and the thing
 * that breaks in a resize gesture is precisely the wiring between React Flow's change
 * stream and the patch: a `dimensions` change per pointer move filling the undo stack
 * with sixty entries, or a measurement change committing an edit nobody made. Both are
 * invisible to a test that hands the component the changes it expects (§B: B9, B10, B13).
 *
 * So what is asserted is what a user would notice: the size is in the document, the
 * floor holds, and ONE undo puts it back.
 */

beforeAll(() => {
  installDomStubs();
  installFlowStubs();
  installLayoutStubs();
});
afterEach(cleanup);

const NO_WEBGPU: GpuStatus = { kind: "unavailable", reason: "No WebGPU in this environment." };

function domRect(x: number, y: number, width: number, height: number): DOMRect {
  return {
    x,
    y,
    width,
    height,
    top: y,
    left: x,
    right: x + width,
    bottom: y + height,
    toJSON: () => ({}),
  } as DOMRect;
}

/**
 * jsdom has no layout, and the resizer converts pointer movement through the pane's own
 * rect and the viewport transform. A pane of zero size makes `fitView` produce a
 * degenerate transform and every screen→graph conversion meaningless, so the flow
 * container gets a plausible size. Nothing else is faked: the transform, the measured
 * node and the pointer arithmetic are all the real code.
 */
function installLayoutStubs(): void {
  const base = Element.prototype.getBoundingClientRect;
  Object.defineProperty(Element.prototype, "getBoundingClientRect", {
    configurable: true,
    value: function stub(this: Element): DOMRect {
      if (this.classList.contains("react-flow")) return domRect(0, 0, 1000, 700);
      if (this.classList.contains("react-flow__pane")) return domRect(0, 0, 1000, 700);
      return base.call(this);
    },
  });
}

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

/**
 * d3-drag (which is what React Flow's resizer runs on) reads `event.view`, and jsdom's
 * own brand check rejects the test realm's window as a `MouseEvent` init member — so it
 * is attached after construction, exactly as `viewport-transform.test.tsx` does.
 */
function mouse(target: Element | Document, type: string, init: MouseEventInit): void {
  const doc = target instanceof Document ? target : target.ownerDocument;
  const win = doc.defaultView;
  if (win === null) throw new Error("no window");
  const event = new win.MouseEvent(type, { bubbles: true, cancelable: true, ...init });
  Object.defineProperty(event, "view", { value: win });
  target.dispatchEvent(event);
}

async function mountWithNode() {
  const runtime = newRuntime();
  const seeded = await seed(runtime, [
    { op: "addNode", ref: "$solid", type: "solid", position: { x: 0, y: 0 } },
  ]);
  const nodeId = seeded.output.createdIds["$solid"] as string;

  const probe = () => Promise.resolve(NO_WEBGPU);
  const view = render(<App runtime={runtime} storage={createMemoryStorage()} gpuProbe={probe} />);
  await act(async () => {});
  await waitFor(() => {
    expect(view.container.querySelectorAll(".react-flow__node").length).toBe(1);
  });
  return { runtime, view, nodeId };
}

/** Selecting the node is what reveals its resize handles, so it is part of the gesture. */
async function select(view: { container: HTMLElement }, nodeId: string): Promise<void> {
  const node = view.container.querySelector(`[data-testid="node-${nodeId}"]`);
  if (node === null) throw new Error("node did not render");
  await act(async () => {
    mouse(node, "mousedown", { button: 0, buttons: 1, clientX: 90, clientY: 60 });
    mouse(node.ownerDocument, "mouseup", { button: 0, buttons: 0, clientX: 90, clientY: 60 });
    mouse(node, "click", { button: 0, buttons: 0, clientX: 90, clientY: 60 });
  });
}

function resizeHandle(view: { container: HTMLElement }): Element {
  const handle = view.container.querySelector(".react-flow__resize-control.bottom.right.handle");
  if (handle === null) throw new Error("the selected node has no bottom-right resize handle");
  return handle;
}

/** One resize gesture: press the handle, drag it, release. */
async function drag(handle: Element, from: [number, number], to: [number, number]): Promise<void> {
  await act(async () => {
    mouse(handle, "mousedown", { button: 0, buttons: 1, clientX: from[0], clientY: from[1] });
    const steps = 8;
    for (let step = 1; step <= steps; step += 1) {
      const t = step / steps;
      mouse(handle.ownerDocument, "mousemove", {
        button: 0,
        buttons: 1,
        clientX: from[0] + (to[0] - from[0]) * t,
        clientY: from[1] + (to[1] - from[1]) * t,
      });
    }
    mouse(handle.ownerDocument, "mouseup", { button: 0, buttons: 0, clientX: to[0], clientY: to[1] });
  });
}

describe("T208 — a node resize is one document edit (§V116, §V15, §V29)", () => {
  it("writes the size to the document as ONE undo entry, and one undo restores it", async () => {
    const { runtime, view, nodeId } = await mountWithNode();
    const actor = runtime.invocation.actor;

    // Mounting and selecting must not be edits: a canvas that writes on mount would make
    // every count below meaningless.
    const before = runtime.bus.store.getHistory(actor).undo.length;
    await select(view, nodeId);
    expect(runtime.bus.store.getHistory(actor).undo.length).toBe(before);

    await drag(resizeHandle(view), [178, 120], [318, 300]);

    await waitFor(() => {
      expect(runtime.bus.store.getGraph().nodes[nodeId]?.size).toBeDefined();
    });
    const size = runtime.bus.store.getGraph().nodes[nodeId]?.size;
    // The size TRACKS THE DRAG rather than being some constant the plumbing produced:
    // the node starts at the measured 178x120 and the pointer travelled +140,+180 in
    // screen px, which the real viewport transform converts to graph px. The bounds are
    // loose because the framing (and so the zoom) is the app's, not the test's — but a
    // handler that wrote a fixed size, or swapped the axes, fails both of these.
    expect(size?.width).toBeGreaterThan(248);
    expect(size?.height).toBeGreaterThan(210);
    // The pointer travelled further down than right, and the node grew accordingly —
    // which a swapped or duplicated axis would not reproduce.
    expect((size?.height ?? 0) - 120).toBeGreaterThan((size?.width ?? 0) - 178);

    // §V15: a drag is ONE history entry, not one per pointer move. Eight moves went in.
    expect(runtime.bus.store.getHistory(actor).undo.length).toBe(before + 1);

    await act(async () => {
      await runtime.bus.execute("graph.undo", {}, runtime.invocation);
    });
    expect(runtime.bus.store.getGraph().nodes[nodeId]?.size).toBeUndefined();
  }, 20_000);

  it("respects the minimum size the resize control and the document agree on (§V116)", async () => {
    const { runtime, view, nodeId } = await mountWithNode();
    await select(view, nodeId);

    // Drag far past the floor, up and to the left of the node's own origin.
    await drag(resizeHandle(view), [178, 120], [-400, -400]);

    await waitFor(() => {
      expect(runtime.bus.store.getGraph().nodes[nodeId]?.size).toBeDefined();
    });
    const size = runtime.bus.store.getGraph().nodes[nodeId]?.size;
    expect(size?.width).toBeGreaterThanOrEqual(MIN_NODE_SIZE.width);
    expect(size?.height).toBeGreaterThanOrEqual(MIN_NODE_SIZE.height);
  }, 20_000);

  it("survives save and reload — the composition is document state, not view state", async () => {
    const { runtime, view, nodeId } = await mountWithNode();
    await select(view, nodeId);
    await drag(resizeHandle(view), [178, 120], [318, 300]);
    await waitFor(() => {
      expect(runtime.bus.store.getGraph().nodes[nodeId]?.size).toBeDefined();
    });
    const size = runtime.bus.store.getGraph().nodes[nodeId]?.size;

    // §V116's actual stake: through the REAL save and the REAL load, not a JSON clone.
    // A size that lives only in React Flow's array reads identically in the app and is
    // gone the next time the project is opened, which is the failure the invariant names.
    const text = serializeProjectDocument(runtime.projectDocument());
    const reloaded = loadProject(text);
    expect(reloaded.ok).toBe(true);
    if (!reloaded.ok) return;
    expect(reloaded.document.graph.nodes[nodeId]?.size).toEqual(size);
  }, 20_000);
});
