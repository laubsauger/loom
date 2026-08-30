// @vitest-environment jsdom
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { createMemoryStorage, installDomStubs } from "@ui/testing/install-dom-stubs.ts";
import { installFlowStubs } from "@editor/graph-canvas/testing.tsx";
import type { GraphEdge } from "@domain/types/graph.ts";
import type { GraphPatchOperation } from "@domain/types/patch.ts";
import { App } from "../../app/app.tsx";
import { createAppRuntime } from "../../app/app-runtime.ts";
import type { AppRuntime } from "../../app/app-runtime.ts";
import type { GpuStatus } from "../../app/gpu-status.ts";

/**
 * T213 / §V14b's sibling — dropping a NODE on an edge splices it inline.
 *
 * The same seam as T212 and tested the same way, at the composed level: the node is
 * dragged with real pointer events through the real canvas, and what is asserted is the
 * DOCUMENT — which edges exist afterwards, and how many undo entries it took.
 *
 * The drop point is derived from the wire the app actually drew (its `d`, projected
 * through the live viewport transform), so this cannot pass by aiming at geometry only
 * the test believes in.
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

function viewportTransform(container: HTMLElement): { x: number; y: number; zoom: number } {
  const style = container.querySelector<HTMLElement>(".react-flow__viewport")?.style.transform ?? "";
  const match = /translate\(([-\d.]+)px,\s*([-\d.]+)px\)\s*scale\(([-\d.]+)\)/.exec(style);
  if (match === null) throw new Error(`could not read the viewport transform from "${style}"`);
  return { x: Number(match[1]), y: Number(match[2]), zoom: Number(match[3]) };
}

/** The midpoint of the drawn wire, in graph coordinates. */
function edgeMidpoint(container: HTMLElement, edgeId: string): { x: number; y: number } {
  const path = container.querySelector<SVGPathElement>(
    `.react-flow__edge[data-id="${edgeId}"] path.react-flow__edge-path`,
  );
  if (path === null) throw new Error(`edge ${edgeId} is not rendered`);
  const numbers = (path.getAttribute("d") ?? "").match(/-?\d+(?:\.\d+)?/g)?.map(Number) ?? [];
  if (numbers.length < 8) throw new Error("unexpected edge path");
  const [x0, y0, cx0, cy0, cx1, cy1, x1, y1] = numbers as [
    number, number, number, number, number, number, number, number,
  ];
  return {
    x: 0.125 * x0 + 0.375 * cx0 + 0.375 * cx1 + 0.125 * x1,
    y: 0.125 * y0 + 0.375 * cy0 + 0.375 * cy1 + 0.125 * y1,
  };
}

/**
 * Drags a node so its CENTRE lands on a given graph-space point.
 *
 * The node is 178x120 (`installFlowStubs`), so the pointer travel is computed to put the
 * middle of the node body on the wire — which is what "dropping a node on a wire" means
 * to a person doing it.
 */
async function dragNodeCentreTo(
  container: HTMLElement,
  nodeId: string,
  graphPoint: { x: number; y: number },
  runtime: AppRuntime,
): Promise<void> {
  const element = container.querySelector(`.react-flow__node[data-id="${nodeId}"]`);
  if (element === null) throw new Error(`node ${nodeId} is not rendered`);
  const node = runtime.bus.store.getGraph().nodes[nodeId];
  if (node === undefined) throw new Error(`node ${nodeId} is not in the document`);

  const transform = viewportTransform(container);
  const wantedTopLeft = { x: graphPoint.x - 178 / 2, y: graphPoint.y - 120 / 2 };
  const deltaScreen = {
    x: (wantedTopLeft.x - node.position.x) * transform.zoom,
    y: (wantedTopLeft.y - node.position.y) * transform.zoom,
  };

  const from = { x: 300, y: 400 };
  await act(async () => {
    mouse(element, "mousedown", { button: 0, buttons: 1, clientX: from.x, clientY: from.y });
    // React Flow will not begin a node drag until the pointer has moved past its drag
    // threshold, and the move that crosses it is what establishes the drag's origin — so
    // the journey is measured from HERE, two pixels in, exactly as it is for a real hand.
    mouse(element.ownerDocument, "mousemove", {
      button: 0,
      buttons: 1,
      clientX: from.x + 2,
      clientY: from.y + 2,
    });
    const steps = 6;
    for (let step = 1; step <= steps; step += 1) {
      const t = step / steps;
      mouse(element.ownerDocument, "mousemove", {
        button: 0,
        buttons: 1,
        clientX: from.x + deltaScreen.x * t,
        clientY: from.y + deltaScreen.y * t,
      });
    }
    mouse(element.ownerDocument, "mouseup", {
      button: 0,
      buttons: 0,
      clientX: from.x + deltaScreen.x,
      clientY: from.y + deltaScreen.y,
    });
  });
}

const edges = (runtime: AppRuntime): GraphEdge[] => Object.values(runtime.bus.store.getGraph().edges);

/**
 * The node's centre came to rest on the given point, within the band a splice would have
 * accepted. What makes a "nothing happened" assertion mean the rule refused rather than
 * the drop missing.
 */
function expectCentredOn(
  runtime: AppRuntime,
  nodeId: string,
  point: { x: number; y: number },
): void {
  const position = runtime.bus.store.getGraph().nodes[nodeId]?.position;
  expect(position).toBeDefined();
  if (position === undefined) return;
  expect(Math.abs(position.x + 178 / 2 - point.x)).toBeLessThan(30);
  expect(Math.abs(position.y + 120 / 2 - point.y)).toBeLessThan(30);
}

/** solid → output, with a blur parked out of the way. */
async function mountChainAndSpareNode(spare = "blur") {
  const runtime = newRuntime();
  const seeded = await seed(runtime, [
    { op: "addNode", ref: "$a", type: "solid", position: { x: 0, y: 0 } },
    { op: "addNode", ref: "$out", type: "output", position: { x: 520, y: 0 } },
    { op: "addNode", ref: "$mid", type: spare, position: { x: 0, y: 400 } },
    {
      op: "connect",
      ref: "$edge",
      source: { nodeId: "$a", portId: "out" },
      target: { nodeId: "$out", portId: "input" },
    },
  ]);
  const ids = {
    a: seeded.output.createdIds["$a"] as string,
    out: seeded.output.createdIds["$out"] as string,
    mid: seeded.output.createdIds["$mid"] as string,
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

describe("T213 — dropping a node on an edge splices it inline (§V14b, §V13)", () => {
  it("rewires upstream → node → downstream in ONE patch and ONE undo entry", async () => {
    const { runtime, view, ids } = await mountChainAndSpareNode();
    const actor = runtime.invocation.actor;
    const before = runtime.bus.store.getHistory(actor).undo.length;

    await dragNodeCentreTo(view.container, ids.mid, edgeMidpoint(view.container, ids.edge), runtime);

    await waitFor(() => {
      expect(edges(runtime)).toHaveLength(2);
    });
    const bySource = new Map(edges(runtime).map((edge) => [edge.source.nodeId, edge]));
    expect(bySource.get(ids.a)?.target).toEqual({ nodeId: ids.mid, portId: "input" });
    expect(bySource.get(ids.mid)?.target).toEqual({ nodeId: ids.out, portId: "input" });
    // The original wire is gone, not left dangling beside the new pair.
    expect(edges(runtime).some((edge) => edge.id === ids.edge)).toBe(false);

    // The move and the splice are one gesture: ONE undo restores the original wire AND
    // puts the node back where it came from.
    expect(runtime.bus.store.getHistory(actor).undo.length).toBe(before + 1);
    await act(async () => {
      await runtime.bus.execute("graph.undo", {}, runtime.invocation);
    });
    expect(edges(runtime)).toHaveLength(1);
    expect(edges(runtime)[0]?.source.nodeId).toBe(ids.a);
    expect(edges(runtime)[0]?.target.nodeId).toBe(ids.out);
    expect(runtime.bus.store.getGraph().nodes[ids.mid]?.position).toEqual({ x: 0, y: 400 });
  }, 20_000);

  it("is still an ordinary move when the node lands nowhere near a wire", async () => {
    const { runtime, view, ids } = await mountChainAndSpareNode();
    const midpoint = edgeMidpoint(view.container, ids.edge);

    await dragNodeCentreTo(
      view.container,
      ids.mid,
      { x: midpoint.x, y: midpoint.y + 320 },
      runtime,
    );

    await waitFor(() => {
      expect(runtime.bus.store.getGraph().nodes[ids.mid]?.position.y).toBeGreaterThan(100);
    });
    // Moving a node past a wire must not rewire the graph — this is the gesture people
    // perform hundreds of times an hour while tidying up.
    expect(edges(runtime)).toHaveLength(1);
    expect(edges(runtime)[0]?.id).toBe(ids.edge);
  }, 20_000);

  it("refuses a node whose ports cannot take both ends (§V13)", async () => {
    // `mouse` emits a VALUE. It has no texture input and no texture output, so there is
    // no way for it to sit on a texture wire — and no implicit conversion to invent one.
    const { runtime, view, ids } = await mountChainAndSpareNode("mouse");

    const midpoint = edgeMidpoint(view.container, ids.edge);
    await dragNodeCentreTo(view.container, ids.mid, midpoint, runtime);

    // The node really landed ON the wire — so this is a REFUSAL, not a near miss that
    // would have passed whatever the splice rules said.
    await waitFor(() => {
      expectCentredOn(runtime, ids.mid, midpoint);
    });
    expect(edges(runtime)).toHaveLength(1);
    expect(edges(runtime)[0]?.id).toBe(ids.edge);
  }, 20_000);

  it("refuses a splice that would close a loop (§V4)", async () => {
    // solid → blur → output. Dropping the BLUR onto the wire it already feeds would make
    // blur its own upstream. A cycle is legal only across an explicit temporal node, and
    // a gesture that creates an illegal one hands the user a graph that stops compiling
    // for a reason they cannot see.
    const runtime = newRuntime();
    const seeded = await seed(runtime, [
      { op: "addNode", ref: "$a", type: "solid", position: { x: 0, y: 0 } },
      { op: "addNode", ref: "$b", type: "blur", position: { x: 260, y: 0 } },
      { op: "addNode", ref: "$out", type: "output", position: { x: 620, y: 0 } },
      {
        op: "connect",
        source: { nodeId: "$a", portId: "out" },
        target: { nodeId: "$b", portId: "input" },
      },
      {
        op: "connect",
        ref: "$down",
        source: { nodeId: "$b", portId: "out" },
        target: { nodeId: "$out", portId: "input" },
      },
    ]);
    const blurId = seeded.output.createdIds["$b"] as string;
    const downId = seeded.output.createdIds["$down"] as string;

    const probe = () => Promise.resolve(NO_WEBGPU);
    const view = render(<App runtime={runtime} storage={createMemoryStorage()} gpuProbe={probe} />);
    await act(async () => {});
    await waitFor(() => {
      expect(view.container.querySelectorAll(".react-flow__edge").length).toBe(2);
    });

    const midpoint = edgeMidpoint(view.container, downId);
    await dragNodeCentreTo(view.container, blurId, midpoint, runtime);

    // Again: on the wire, and refused for the rule rather than for the aim.
    await waitFor(() => {
      expectCentredOn(runtime, blurId, midpoint);
    });
    // Two edges still, both the originals.
    expect(edges(runtime)).toHaveLength(2);
    expect(edges(runtime).some((edge) => edge.id === downId)).toBe(true);
  }, 20_000);
});
