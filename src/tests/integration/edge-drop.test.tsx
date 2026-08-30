// @vitest-environment jsdom
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { createMemoryStorage, installDomStubs } from "@ui/testing/install-dom-stubs.ts";
import { installFlowStubs } from "@editor/graph-canvas/testing.tsx";
import type { GraphDocument } from "@domain/types/graph.ts";
import type { GraphPatchOperation } from "@domain/types/patch.ts";
import { App } from "../../app/app.tsx";
import { createAppRuntime } from "../../app/app-runtime.ts";
import type { AppRuntime } from "../../app/app-runtime.ts";
import type { GpuStatus } from "../../app/gpu-status.ts";

/**
 * T212 / §V14b / §V14c — releasing a connection over an EDGE replaces it.
 *
 * At the COMPOSED level, and it has to be: the whole gesture is a seam. React Flow owns
 * the pointer stream, the edge component owns the curve, the canvas owns the projection
 * from screen to graph space, and the bus owns the patch. A unit test on any one of them
 * would supply the very thing that breaks — and §B records five times this codebase shipped
 * a feature whose every layer was green (B9, B10, B12, B13, B23).
 *
 * So the drop point is computed from the edge THE APP ACTUALLY DREW: its path is read out
 * of the DOM and projected back through the live viewport transform. If the hit test used
 * different geometry than the renderer, or the transform were wrong, this test could not
 * find the wire.
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
    x, y, width, height,
    top: y, left: x, right: x + width, bottom: y + height,
    toJSON: () => ({}),
  } as DOMRect;
}

/**
 * jsdom has no layout. The flow container gets a plausible rect so `fitView` produces a
 * real transform and screen↔graph projection means something; everything else — handle
 * positions, the curve, the transform itself — is the app's own arithmetic.
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

function mouse(target: Element | Document, type: string, init: MouseEventInit): void {
  const doc = target instanceof Document ? target : target.ownerDocument;
  const win = doc.defaultView;
  if (win === null) throw new Error("no window");
  const event = new win.MouseEvent(type, { bubbles: true, cancelable: true, ...init });
  Object.defineProperty(event, "view", { value: win });
  target.dispatchEvent(event);
}

interface Transform {
  x: number;
  y: number;
  zoom: number;
}

/** The live camera, read from the viewport element the user is looking through. */
function viewportTransform(container: HTMLElement): Transform {
  const style = container.querySelector<HTMLElement>(".react-flow__viewport")?.style.transform ?? "";
  const match = /translate\(([-\d.]+)px,\s*([-\d.]+)px\)\s*scale\(([-\d.]+)\)/.exec(style);
  if (match === null) throw new Error(`could not read the viewport transform from "${style}"`);
  return { x: Number(match[1]), y: Number(match[2]), zoom: Number(match[3]) };
}

/**
 * A client point on the middle of the drawn edge.
 *
 * The `d` attribute is the exact cubic the edge rendered, so its t=0.5 point is a point
 * ON the wire — not an approximation of one, and not a number this test invented.
 */
function midpointOfEdge(container: HTMLElement, edgeId: string): { x: number; y: number } {
  const path = container.querySelector<SVGPathElement>(
    `.react-flow__edge[data-id="${edgeId}"] path.react-flow__edge-path`,
  );
  if (path === null) throw new Error(`edge ${edgeId} is not rendered`);
  const d = path.getAttribute("d") ?? "";
  const numbers = d.match(/-?\d+(?:\.\d+)?/g)?.map(Number) ?? [];
  if (numbers.length < 8) throw new Error(`unexpected edge path "${d}"`);
  const [x0, y0, cx0, cy0, cx1, cy1, x1, y1] = numbers as [
    number, number, number, number, number, number, number, number,
  ];
  // Cubic at t = 0.5.
  const graph = {
    x: 0.125 * x0 + 0.375 * cx0 + 0.375 * cx1 + 0.125 * x1,
    y: 0.125 * y0 + 0.375 * cy0 + 0.375 * cy1 + 0.125 * y1,
  };
  const transform = viewportTransform(container);
  return { x: graph.x * transform.zoom + transform.x, y: graph.y * transform.zoom + transform.y };
}

function handleOf(container: HTMLElement, nodeId: string, portId: string, type: "source" | "target") {
  const node = container.querySelector(`.react-flow__node[data-id="${nodeId}"]`);
  if (node === null) throw new Error(`node ${nodeId} is not rendered`);
  const handle = node.querySelector(`.react-flow__handle-${type === "source" ? "right" : "left"}[data-handleid="${portId}"]`);
  if (handle === null) throw new Error(`node ${nodeId} has no ${type} handle "${portId}"`);
  return handle;
}

/** One connection drag: press a port, drag to a point, release there. */
async function dragConnection(
  handle: Element,
  to: { x: number; y: number },
): Promise<void> {
  await act(async () => {
    mouse(handle, "mousedown", { button: 0, buttons: 1, clientX: 400, clientY: 500 });
    for (let step = 1; step <= 6; step += 1) {
      const t = step / 6;
      mouse(handle.ownerDocument, "mousemove", {
        button: 0,
        buttons: 1,
        clientX: 400 + (to.x - 400) * t,
        clientY: 500 + (to.y - 500) * t,
      });
    }
    mouse(handle.ownerDocument, "mouseup", { button: 0, buttons: 0, clientX: to.x, clientY: to.y });
  });
}

const graphOf = (runtime: AppRuntime): GraphDocument => runtime.bus.store.getGraph();
const edgeList = (runtime: AppRuntime) => Object.values(graphOf(runtime).edges);

/**
 * solid1 → output, plus a second solid nobody is wired to. The classic "I want THAT one
 * feeding the output instead" moment.
 */
async function mountTwoSourcesOneSink() {
  const runtime = newRuntime();
  const seeded = await seed(runtime, [
    { op: "addNode", ref: "$a", type: "solid", position: { x: 0, y: 0 } },
    { op: "addNode", ref: "$b", type: "solid", position: { x: 0, y: 260 } },
    { op: "addNode", ref: "$out", type: "output", position: { x: 360, y: 0 } },
    {
      op: "connect",
      ref: "$edge",
      source: { nodeId: "$a", portId: "out" },
      target: { nodeId: "$out", portId: "input" },
    },
  ]);
  const ids = {
    a: seeded.output.createdIds["$a"] as string,
    b: seeded.output.createdIds["$b"] as string,
    out: seeded.output.createdIds["$out"] as string,
    edge: seeded.output.createdIds["$edge"] as string,
  };

  const probe = () => Promise.resolve(NO_WEBGPU);
  const view = render(<App runtime={runtime} storage={createMemoryStorage()} gpuProbe={probe} />);
  await act(async () => {});
  await waitFor(() => {
    expect(view.container.querySelectorAll(".react-flow__edge").length).toBe(1);
  });
  return { runtime, view, ids };
}

describe("T212 — dropping a connection on an edge replaces it (§V14b)", () => {
  it("takes the edge's target, in ONE patch and ONE undo entry (§V32, §V34)", async () => {
    const { runtime, view, ids } = await mountTwoSourcesOneSink();
    const actor = runtime.invocation.actor;
    const before = runtime.bus.store.getHistory(actor).undo.length;

    // Released on the WIRE, nowhere near the output's 7px input dot (§V99).
    const drop = midpointOfEdge(view.container, ids.edge);
    await dragConnection(handleOf(view.container, ids.b, "out", "source"), drop);

    await waitFor(() => {
      expect(edgeList(runtime)[0]?.source.nodeId).toBe(ids.b);
    });
    // Still exactly one edge: this REPLACED, it did not add a second producer to an
    // input that only takes one (§V14).
    expect(edgeList(runtime)).toHaveLength(1);
    expect(edgeList(runtime)[0]?.target).toEqual({ nodeId: ids.out, portId: "input" });

    // The disconnect and the connect are one atomic change, so one undo restores the
    // ORIGINAL wire — not "the old edge is still gone and the new one has vanished".
    expect(runtime.bus.store.getHistory(actor).undo.length).toBe(before + 1);
    await act(async () => {
      await runtime.bus.execute("graph.undo", {}, runtime.invocation);
    });
    expect(edgeList(runtime)).toHaveLength(1);
    expect(edgeList(runtime)[0]?.source.nodeId).toBe(ids.a);
  }, 20_000);

  it("leaves the graph alone when the release misses every wire", async () => {
    const { runtime, view, ids } = await mountTwoSourcesOneSink();
    const actor = runtime.invocation.actor;
    const before = runtime.bus.store.getHistory(actor).undo.length;

    // Far from the edge, far from every port: empty canvas.
    await dragConnection(handleOf(view.container, ids.b, "out", "source"), { x: 940, y: 660 });

    expect(edgeList(runtime)).toHaveLength(1);
    expect(edgeList(runtime)[0]?.source.nodeId).toBe(ids.a);
    expect(runtime.bus.store.getHistory(actor).undo.length).toBe(before);
  }, 20_000);

  it("refuses a drop whose types do not fit, rather than making an illegal edge (§V13)", async () => {
    const runtime = newRuntime();
    // `mouse` emits a VALUE, not a texture, so nothing it produces belongs on a texture
    // wire. The gesture must decline; §V13 has no implicit conversion.
    const seeded = await seed(runtime, [
      { op: "addNode", ref: "$a", type: "solid", position: { x: 0, y: 0 } },
      { op: "addNode", ref: "$v", type: "mouse", position: { x: 0, y: 260 } },
      { op: "addNode", ref: "$out", type: "output", position: { x: 360, y: 0 } },
      {
        op: "connect",
        ref: "$edge",
        source: { nodeId: "$a", portId: "out" },
        target: { nodeId: "$out", portId: "input" },
      },
    ]);
    const valueId = seeded.output.createdIds["$v"] as string;
    const edgeId = seeded.output.createdIds["$edge"] as string;

    const probe = () => Promise.resolve(NO_WEBGPU);
    const view = render(<App runtime={runtime} storage={createMemoryStorage()} gpuProbe={probe} />);
    await act(async () => {});
    await waitFor(() => {
      expect(view.container.querySelectorAll(".react-flow__edge").length).toBe(1);
    });

    const drop = midpointOfEdge(view.container, edgeId);
    await dragConnection(handleOf(view.container, valueId, "out", "source"), drop);

    expect(edgeList(runtime)).toHaveLength(1);
    expect(edgeList(runtime)[0]?.id).toBe(edgeId);
  }, 20_000);
});
