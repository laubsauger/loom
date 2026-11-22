// @vitest-environment jsdom
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { createMemoryStorage, installDomStubs } from "@ui/testing/install-dom-stubs.ts";
import { installFlowStubs } from "@editor/graph-canvas/testing.tsx";
import { parseWirePath } from "@editor/edges/edge-geometry.ts";
import type { GraphEdge } from "@domain/types/graph.ts";
import type { GraphPatchOperation } from "@domain/types/patch.ts";
import { App } from "../../app/app.tsx";
import { createAppRuntime } from "../../app/app-runtime.ts";
import type { AppRuntime } from "../../app/app-runtime.ts";
import type { GpuStatus } from "../../app/gpu-status.ts";

/**
 * Wire ties on the composed canvas (T1821b, §V1040; docs/wire-ties-design-2026-11-21.md).
 *
 * Driven the way `node-splice.test.tsx` drives T213: real events through the real app,
 * aimed at geometry read back from what the app DREW, and asserted on the DOCUMENT — which
 * ties exist, which wires pass them, how many undo steps a gesture took.
 */

beforeAll(() => {
  installDomStubs();
  installFlowStubs();
  installLayoutStubs();
});
afterEach(cleanup);

const NO_WEBGPU: GpuStatus = { kind: "unavailable", reason: "No WebGPU in this environment." };

function domRect(x: number, y: number, width: number, height: number): DOMRect {
  return { x, y, width, height, top: y, left: x, right: x + width, bottom: y + height, toJSON: () => ({}) } as DOMRect;
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

function event(target: Element | Document, type: string, init: MouseEventInit): void {
  const doc = target instanceof Document ? target : target.ownerDocument;
  const win = doc.defaultView;
  if (win === null) throw new Error("no window");
  const fired = new win.MouseEvent(type, { bubbles: true, cancelable: true, ...init });
  Object.defineProperty(fired, "view", { value: win });
  target.dispatchEvent(fired);
}

function viewportTransform(container: HTMLElement): { x: number; y: number; zoom: number } {
  const style = container.querySelector<HTMLElement>(".react-flow__viewport")?.style.transform ?? "";
  const match = /translate\(([-\d.]+)px,\s*([-\d.]+)px\)\s*scale\(([-\d.]+)\)/.exec(style);
  if (match === null) throw new Error(`could not read the viewport transform from "${style}"`);
  return { x: Number(match[1]), y: Number(match[2]), zoom: Number(match[3]) };
}

const toScreen = (container: HTMLElement, point: { x: number; y: number }) => {
  const transform = viewportTransform(container);
  return { x: point.x * transform.zoom + transform.x, y: point.y * transform.zoom + transform.y };
};

/** The legs of the wire the app drew for `edgeId`, read back from its `d`. */
function drawnLegs(container: HTMLElement, edgeId: string) {
  const path = container.querySelector<SVGPathElement>(`.react-flow__edge[data-id="${edgeId}"] path.react-flow__edge-path`);
  if (path === null) throw new Error(`edge ${edgeId} is not rendered`);
  const legs = parseWirePath(path.getAttribute("d") ?? "");
  if (legs === null) throw new Error("unreadable edge path");
  return legs;
}

/** The bezier midpoint of one drawn leg, in graph coordinates. */
function legMidpoint(leg: ReturnType<typeof drawnLegs>[number]): { x: number; y: number } {
  return {
    x: 0.125 * leg.p0.x + 0.375 * leg.c0.x + 0.375 * leg.c1.x + 0.125 * leg.p1.x,
    y: 0.125 * leg.p0.y + 0.375 * leg.c0.y + 0.375 * leg.c1.y + 0.125 * leg.p1.y,
  };
}

const edges = (runtime: AppRuntime): GraphEdge[] => Object.values(runtime.bus.store.getGraph().edges);
const ties = (runtime: AppRuntime) => runtime.bus.store.getGraph().ties ?? {};

async function mount(operations: GraphPatchOperation[], wires: number) {
  const runtime = createAppRuntime({ identityStorage: null, actor: { kind: "human", id: "tester", label: "Tester" } });
  const seeded = await runtime.bus.execute(
    "graph.applyPatch",
    { baseRevision: runtime.bus.store.getRevision(), operations, label: "seed" },
    runtime.invocation,
  );
  expect(seeded.status).toBe("applied");
  const view = render(<App runtime={runtime} storage={createMemoryStorage()} gpuProbe={() => Promise.resolve(NO_WEBGPU)} />);
  await act(async () => {});
  await waitFor(() => {
    expect(view.container.querySelectorAll(".react-flow__edge").length).toBe(wires);
  });
  return { runtime, view, ids: seeded.output.createdIds };
}

/** A press on a tie's grab ring, dragged by `delta` screen pixels and let go. */
async function dragTie(container: HTMLElement, tieId: string, delta: { x: number; y: number }, init: MouseEventInit = {}) {
  const ring = container.querySelector(`[data-testid="wire-tie-hit-${tieId}"]`);
  if (ring === null) throw new Error(`tie ${tieId} is not drawn`);
  const tie = container.querySelector(`[data-testid="wire-tie-${tieId}"]`);
  const from = toScreen(container, { x: Number(tie?.getAttribute("data-x")), y: Number(tie?.getAttribute("data-y")) });
  await act(async () => {
    event(ring, "pointerdown", { button: 0, buttons: 1, clientX: from.x, clientY: from.y });
    for (let step = 1; step <= 5; step += 1) {
      event(ring, "pointermove", { button: 0, buttons: 1, clientX: from.x + (delta.x * step) / 5, clientY: from.y + (delta.y * step) / 5 });
    }
    event(ring, "pointerup", { button: 0, buttons: 0, clientX: from.x + delta.x, clientY: from.y + delta.y, ...init });
  });
}

describe("T1821b — ties on the composed canvas", () => {
  it("draws a tied wire THROUGH its tie, and a node dropped on its second leg keeps the route upstream", async () => {
    const { runtime, view, ids } = await mount(
      [
        { op: "addNode", ref: "$a", type: "solid", position: { x: 0, y: 0 } },
        { op: "addNode", ref: "$out", type: "output", position: { x: 700, y: 0 } },
        { op: "addNode", ref: "$mid", type: "blur", position: { x: 0, y: 600 } },
        { op: "addTie", ref: "$t", position: { x: 330, y: 360 } },
        { op: "connect", ref: "$edge", source: { nodeId: "$a", portId: "out" }, target: { nodeId: "$out", portId: "input" }, via: ["$t"] },
      ],
      1,
    );
    const tieId = ids["$t"] as string;
    const edgeId = ids["$edge"] as string;

    // Two legs, meeting exactly at the tie: the wire goes down to it and back up.
    const legs = drawnLegs(view.container, edgeId);
    expect(legs).toHaveLength(2);
    expect(legs[0]?.p1).toEqual({ x: 330, y: 360 });
    expect(view.container.querySelector(`[data-testid="wire-tie-${tieId}"]`)).not.toBeNull();

    // Park the blur ON the second leg (tie → output). It splices in, and the tie stays on
    // the upstream wire, solid → tie → blur, as drawn.
    const onLeg = legMidpoint(legs[1] as (typeof legs)[number]);
    const node = runtime.bus.store.getGraph().nodes[ids["$mid"] as string];
    const element = view.container.querySelector(`.react-flow__node[data-id="${ids["$mid"]}"]`);
    if (node === undefined || element === null) throw new Error("the spare node is not drawn");
    const zoom = viewportTransform(view.container).zoom;
    const delta = { x: (onLeg.x - 178 / 2 - node.position.x) * zoom, y: (onLeg.y - 120 / 2 - node.position.y) * zoom };
    const from = { x: 300, y: 400 };
    await act(async () => {
      event(element, "mousedown", { button: 0, buttons: 1, clientX: from.x, clientY: from.y });
      event(element.ownerDocument, "mousemove", { button: 0, buttons: 1, clientX: from.x + 2, clientY: from.y + 2 });
      for (let step = 1; step <= 6; step += 1) {
        event(element.ownerDocument, "mousemove", { button: 0, buttons: 1, clientX: from.x + (delta.x * step) / 6, clientY: from.y + (delta.y * step) / 6 });
      }
      event(element.ownerDocument, "mouseup", { button: 0, buttons: 0, clientX: from.x + delta.x, clientY: from.y + delta.y });
    });

    await waitFor(() => expect(edges(runtime)).toHaveLength(2));
    const bySource = new Map(edges(runtime).map((edge) => [edge.source.nodeId, edge]));
    expect(bySource.get(ids["$a"] as string)?.target.nodeId).toBe(ids["$mid"]);
    expect(bySource.get(ids["$a"] as string)?.via).toEqual([tieId]);
    expect(bySource.get(ids["$mid"] as string)?.via).toBeUndefined();
    expect(Object.keys(ties(runtime))).toEqual([tieId]);
  }, 20_000);

  it("puts a tie ON a wire where it is double-clicked, as one undo step", async () => {
    const { runtime, view, ids } = await mount(
      [
        { op: "addNode", ref: "$a", type: "solid", position: { x: 0, y: 0 } },
        { op: "addNode", ref: "$out", type: "output", position: { x: 520, y: 300 } },
        { op: "connect", ref: "$edge", source: { nodeId: "$a", portId: "out" }, target: { nodeId: "$out", portId: "input" } },
      ],
      1,
    );
    const edgeId = ids["$edge"] as string;
    const leg = drawnLegs(view.container, edgeId)[0];
    if (leg === undefined) throw new Error("no wire");
    // A point a little off the wire: the tie must still land ON the drawn curve.
    const aimed = legMidpoint(leg);
    const client = toScreen(view.container, { x: aimed.x + 3, y: aimed.y });
    const wire = view.container.querySelector(`.react-flow__edge[data-id="${edgeId}"]`);
    if (wire === null) throw new Error("no wire element");
    const before = runtime.bus.store.getHistory(runtime.invocation.actor).undo.length;

    await act(async () => {
      event(wire, "dblclick", { button: 0, clientX: client.x, clientY: client.y, detail: 2 });
    });

    await waitFor(() => expect(Object.keys(ties(runtime))).toHaveLength(1));
    const [tie] = Object.values(ties(runtime));
    expect(runtime.bus.store.getGraph().edges[edgeId]?.via).toEqual([tie?.id]);
    // On the curve that was drawn, not where the cursor was: within a pixel of the aim.
    expect(Math.hypot((tie?.position.x ?? 0) - aimed.x, (tie?.position.y ?? 0) - aimed.y)).toBeLessThan(1.5);
    // No node browser opened on top of the wire.
    expect(view.container.ownerDocument.querySelector('[data-testid="node-search"]')).toBeNull();
    expect(runtime.bus.store.getHistory(runtime.invocation.actor).undo.length).toBe(before + 1);
  }, 20_000);

  it("moves a dragged tie with one undo step, merges one dropped on another, and removes a double-clicked one", async () => {
    const { runtime, view, ids } = await mount(
      [
        { op: "addNode", ref: "$a", type: "solid", position: { x: 0, y: 0 } },
        { op: "addNode", ref: "$b", type: "solid", position: { x: 0, y: 300 } },
        { op: "addNode", ref: "$fa", type: "blur", position: { x: 700, y: 0 } },
        { op: "addNode", ref: "$fb", type: "blur", position: { x: 700, y: 300 } },
        { op: "addTie", ref: "$ta", position: { x: 400, y: 100 } },
        { op: "addTie", ref: "$tb", position: { x: 400, y: 250 } },
        { op: "connect", ref: "$ea", source: { nodeId: "$a", portId: "out" }, target: { nodeId: "$fa", portId: "input" }, via: ["$ta"] },
        { op: "connect", ref: "$eb", source: { nodeId: "$b", portId: "out" }, target: { nodeId: "$fb", portId: "input" }, via: ["$tb"] },
      ],
      2,
    );
    const ta = ids["$ta"] as string;
    const tb = ids["$tb"] as string;
    const zoom = viewportTransform(view.container).zoom;
    const actor = runtime.invocation.actor;

    // A drag: the tie moves where it was let go, in one undo step.
    const before = runtime.bus.store.getHistory(actor).undo.length;
    await dragTie(view.container, ta, { x: 40 * zoom, y: -20 * zoom });
    await waitFor(() => expect(ties(runtime)[ta]?.position).toEqual({ x: 440, y: 80 }));
    expect(runtime.bus.store.getHistory(actor).undo.length).toBe(before + 1);

    // Dropped on the other tie: one tie, both wires through it — one strand.
    await dragTie(view.container, ta, { x: (400 - 440) * zoom, y: (250 - 80) * zoom });
    await waitFor(() => expect(Object.keys(ties(runtime))).toEqual([tb]));
    expect(runtime.bus.store.getGraph().edges[ids["$ea"] as string]?.via).toEqual([tb]);
    expect(runtime.bus.store.getGraph().edges[ids["$eb"] as string]?.via).toEqual([tb]);

    // Double-clicked: gone, both wires released, both still connected.
    const ring = view.container.querySelector(`[data-testid="wire-tie-hit-${tb}"]`);
    if (ring === null) throw new Error("merged tie is not drawn");
    await act(async () => {
      event(ring, "dblclick", { button: 0, detail: 2 });
    });
    await waitFor(() => expect(runtime.bus.store.getGraph().ties).toBeUndefined());
    expect(edges(runtime)).toHaveLength(2);
    expect(edges(runtime).every((edge) => edge.via === undefined)).toBe(true);
    expect(view.container.ownerDocument.querySelector('[data-testid="node-search"]')).toBeNull();
  }, 20_000);
});
