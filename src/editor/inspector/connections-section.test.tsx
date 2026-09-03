// @vitest-environment jsdom
import { StrictMode } from "react";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { createDomainBus } from "@domain/commands/index.ts";
import { alice, contextFor } from "@domain/commands/test-support.ts";
import { createSequentialIdFactory } from "@domain/graph/ids.ts";
import { createGraphStore } from "@domain/graph/store.ts";
import { incomingEdgesInOrder } from "@domain/graph/edge-order.ts";
import type { LoomBus } from "@domain/commands/bus.ts";
import type { NodeId } from "@domain/types/ids.ts";
import { overNode } from "@nodes/definitions/composite.ts";
import { solidNode } from "@nodes/definitions/solid.ts";
import { pointGridNode } from "@nodes/definitions/point-generators.ts";
import { textureToAttributeNode } from "@nodes/definitions/points.ts";
import { createNodeRegistry } from "@nodes/registry/registry.ts";
import { edgeFamilyColor } from "@editor/edges/flow.ts";
import { installDomStubs } from "@ui/testing/install-dom-stubs.ts";
import { Inspector } from "./inspector.tsx";
import type { InspectorProjectSettings } from "./inspector.tsx";

/**
 * The Connections view, driven the way a user drives it (T1049).
 *
 * Everything here goes through the REAL command bus against the REAL `over` manifest, and
 * every assertion is about the DOCUMENT — the edge order, the edge that survived — never
 * about the rows the component happened to render. A list that re-sorts itself and writes
 * nothing is exactly the implementation §T1049 warns about, and it would pass a test that
 * asked the DOM what order it was showing.
 *
 * The picture that order produces is asserted on a real GPU, next door in
 * `connections-picture.gpu.test.ts`. This file's job is the gesture and the undo group.
 *
 * THREE layers throughout (§V854). Two cannot tell "moved to the front" from "reversed",
 * and cannot tell "disconnected the row I clicked" from "disconnected a neighbour".
 */

beforeAll(installDomStubs);
afterEach(cleanup);

const settings: InspectorProjectSettings = {
  outputResolution: { width: 640, height: 480 },
  workingFormat: "rgba8unorm",
};

const context = contextFor(alice);

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 16));
  });
}

/** T269: Common is a page, so a Common assertion opens it, as a user does. */
function openCommon(): void {
  const tab = screen.getByRole("tab", { name: "Common" });
  fireEvent.mouseDown(tab, { button: 0 });
  fireEvent.click(tab);
}

interface Harness {
  bus: LoomBus;
  comp: NodeId;
  /** Edge ids of the three layers, in the order they were wired: red, green, blue. */
  layers: [string, string, string];
  /** The single wire on the ordinary `Front` input. */
  frontEdge: string;
  /** The `in2` edge ids as the DOCUMENT orders them right now. */
  order: () => string[];
  /** The peer node NAMES behind those edges, in document order. */
  names: () => string[];
  /** The peer NAMES wired into one port of the inspected node, in document order. */
  wiredTo: (portId: string) => string[];
  undoDepth: () => number;
}

async function setup(): Promise<Harness> {
  const store = createGraphStore({ ids: createSequentialIdFactory("t1049") });
  const { bus } = createDomainBus({
    store,
    registry: createNodeRegistry([overNode, solidNode]).view(),
  });

  const created = await bus.execute(
    "graph.applyPatch",
    {
      baseRevision: 0,
      operations: [
        { op: "addNode", ref: "$front", type: "solid", position: { x: 0, y: 0 } },
        { op: "addNode", ref: "$red", type: "solid", position: { x: 0, y: 100 } },
        { op: "addNode", ref: "$green", type: "solid", position: { x: 0, y: 200 } },
        { op: "addNode", ref: "$blue", type: "solid", position: { x: 0, y: 300 } },
        { op: "addNode", ref: "$comp", type: "over", position: { x: 300, y: 0 } },
        { op: "setNodeLabel", nodeId: "$front", label: "front1" },
        { op: "setNodeLabel", nodeId: "$red", label: "red1" },
        { op: "setNodeLabel", nodeId: "$green", label: "green1" },
        { op: "setNodeLabel", nodeId: "$blue", label: "blue1" },
        { op: "setNodeLabel", nodeId: "$comp", label: "over1" },
        {
          op: "connect",
          ref: "$ef",
          source: { nodeId: "$front", portId: "out" },
          target: { nodeId: "$comp", portId: "in1" },
        },
        {
          op: "connect",
          ref: "$er",
          source: { nodeId: "$red", portId: "out" },
          target: { nodeId: "$comp", portId: "in2" },
        },
        {
          op: "connect",
          ref: "$eg",
          source: { nodeId: "$green", portId: "out" },
          target: { nodeId: "$comp", portId: "in2" },
        },
        {
          op: "connect",
          ref: "$eb",
          source: { nodeId: "$blue", portId: "out" },
          target: { nodeId: "$comp", portId: "in2" },
        },
      ],
    },
    context,
  );
  expect(created.status).toBe("applied");
  const ids = created.output.createdIds as Record<string, string>;
  const comp = ids["$comp"] as NodeId;

  const order = (): string[] =>
    incomingEdgesInOrder(bus.store.getGraph(), comp, "in2").map((edge) => edge.id);
  const names = (): string[] => {
    const graph = bus.store.getGraph();
    return order().map((edgeId) => graph.nodes[graph.edges[edgeId]?.source.nodeId ?? ""]?.label ?? "?");
  };

  render(
    <StrictMode>
      <Inspector bus={bus} context={context} nodeId={comp} settings={settings} />
    </StrictMode>,
  );
  openCommon();

  const wiredTo = (portId: string): string[] => {
    const graph = bus.store.getGraph();
    return incomingEdgesInOrder(graph, comp, portId).map(
      (edge) => graph.nodes[edge.source.nodeId]?.label ?? "?",
    );
  };

  return {
    bus,
    comp,
    wiredTo,
    layers: [ids["$er"] as string, ids["$eg"] as string, ids["$eb"] as string],
    frontEdge: ids["$ef"] as string,
    order,
    names,
    undoDepth: () => bus.store.getHistory(alice).undo.length,
  };
}

/**
 * A node whose input ports are DIFFERENT KINDS — `textureToAttribute` takes a pointset and
 * a texture — so "can this wire go here" has a real answer to get wrong. A fixture whose
 * ports are all one type can never exercise a refusal (§V854's rule: the fixture must not
 * sit at the degenerate point of whatever the fault scales with).
 */
async function setupMixedTypes(): Promise<{
  bus: LoomBus;
  textureEdge: string;
  pointsEdge: string;
}> {
  const store = createGraphStore({ ids: createSequentialIdFactory("t1049-mixed") });
  const { bus } = createDomainBus({
    store,
    registry: createNodeRegistry([solidNode, pointGridNode, textureToAttributeNode]).view(),
  });
  const created = await bus.execute(
    "graph.applyPatch",
    {
      baseRevision: 0,
      operations: [
        { op: "addNode", ref: "$tex", type: solidNode.type, position: { x: 0, y: 0 } },
        { op: "addNode", ref: "$pts", type: pointGridNode.type, position: { x: 0, y: 100 } },
        { op: "addNode", ref: "$mix", type: textureToAttributeNode.type, position: { x: 300, y: 0 } },
        { op: "setNodeLabel", nodeId: "$tex", label: "solid1" },
        { op: "setNodeLabel", nodeId: "$pts", label: "grid1" },
        {
          op: "connect",
          ref: "$et",
          source: { nodeId: "$tex", portId: "out" },
          target: { nodeId: "$mix", portId: "texture" },
        },
        {
          op: "connect",
          ref: "$ep",
          source: { nodeId: "$pts", portId: "out" },
          target: { nodeId: "$mix", portId: "points" },
        },
      ],
    },
    context,
  );
  expect(created.status).toBe("applied");
  const ids = created.output.createdIds as Record<string, string>;
  render(
    <StrictMode>
      <Inspector
        bus={bus}
        context={context}
        nodeId={ids["$mix"] as NodeId}
        settings={settings}
      />
    </StrictMode>,
  );
  openCommon();
  return { bus, textureEdge: ids["$et"] as string, pointsEdge: ids["$ep"] as string };
}

const connections = (): HTMLElement => screen.getByRole("region", { name: "Connections" });
const rowFor = (edgeId: string): HTMLElement => {
  const row = connections().querySelector(`[data-edge-id="${edgeId}"]`);
  if (row === null) throw new Error(`no row for edge ${edgeId}`);
  return row as HTMLElement;
};
const socketSelect = (edgeId: string): HTMLSelectElement => {
  const select = rowFor(edgeId).querySelector("select");
  if (select === null) throw new Error(`no socket picker on edge ${edgeId}`);
  return select as HTMLSelectElement;
};
const gripIn = (edgeId: string): HTMLElement => {
  const grip = rowFor(edgeId).querySelector("button[draggable]");
  if (grip === null) throw new Error(`no reorder grip on edge ${edgeId}`);
  return grip as HTMLElement;
};

function dataTransfer(): DataTransfer {
  return { setData: () => {}, getData: () => "", effectAllowed: "" } as unknown as DataTransfer;
}

describe("T1049 — the Common page lists what is connected to this node", () => {
  it("names both ends by NAME, and says which socket each wire lands in (§B170)", async () => {
    const harness = await setup();
    const list = connections();
    // The layers, in document order, each sitting in the socket the node itself draws.
    for (const [index, name] of ["red1", "green1", "blue1"].entries()) {
      const edgeId = harness.layers[index] as string;
      expect(socketSelect(edgeId).value).toBe(`in2#${String(index)}`);
      const selected = socketSelect(edgeId).selectedOptions[0]?.textContent;
      expect(selected).toBe(`Behind ${String(index + 1)}`);
      expect(rowFor(edgeId).textContent).toContain(name);
    }
    // The ordinary input is here too, addressed by its bare port id: it has no slots.
    expect(socketSelect(harness.frontEdge).value).toBe("in1");
    // An id is an address, not a name — none of them appears in the list.
    expect(list.textContent).not.toContain(harness.comp);
  });

  it("says so plainly when nothing is wired, instead of rendering an empty box (§V91)", async () => {
    const store = createGraphStore({ ids: createSequentialIdFactory("t1049-empty") });
    const { bus } = createDomainBus({
      store,
      registry: createNodeRegistry([overNode, solidNode]).view(),
    });
    const created = await bus.execute(
      "graph.applyPatch",
      {
        baseRevision: 0,
        operations: [{ op: "addNode", ref: "$s", type: "solid", position: { x: 0, y: 0 } }],
      },
      context,
    );
    render(
      <StrictMode>
        <Inspector
          bus={bus}
          context={context}
          nodeId={created.output.createdIds["$s"] as NodeId}
          settings={settings}
        />
      </StrictMode>,
    );
    openCommon();
    expect(within(connections()).getByText("Nothing is wired to this node.")).toBeDefined();
  });
});

describe("T1049 — reordering a layer, through the bus (§V29)", () => {
  it("moves the row the KEYBOARD asked for, and writes the new order to the document (§V19)", async () => {
    // §V19: a reorder that only works under a pointer is half a feature, and what it edits
    // is not decoration — it is which layer composites on top.
    const harness = await setup();
    const [red, green, blue] = harness.layers;
    expect(harness.names()).toEqual(["red1", "green1", "blue1"]);

    const grip = gripIn(blue);
    grip.focus();
    fireEvent.keyDown(grip, { key: "ArrowUp" });
    await settle();

    // Moved ONE place, not to the front and not reversed — the three-row fixture is what
    // makes those three different answers (§V854).
    expect(harness.order()).toEqual([red, blue, green]);
    expect(harness.names()).toEqual(["red1", "blue1", "green1"]);
    // Dense, so the sockets the user can point at still count 1, 2, 3 (T225).
    const graph = harness.bus.store.getGraph();
    expect(harness.order().map((id) => graph.edges[id]?.order)).toEqual([0, 1, 2]);
  });

  it("spends ONE undo entry on a gesture, whatever it crossed on the way (§V15)", async () => {
    // The held-key case. Two presses without an intervening key-up are one gesture, so one
    // undo must land on the order the gesture STARTED from — not halfway back through it.
    const harness = await setup();
    const [red, green, blue] = harness.layers;
    const before = harness.undoDepth();

    const grip = gripIn(blue);
    grip.focus();
    fireEvent.keyDown(grip, { key: "ArrowUp" });
    await settle();
    fireEvent.keyDown(gripIn(blue), { key: "ArrowUp", repeat: true });
    await settle();
    expect(harness.order()).toEqual([blue, red, green]);
    expect(harness.undoDepth()).toBe(before + 1);

    fireEvent.keyUp(gripIn(blue), { key: "ArrowUp" });
    const undone = await harness.bus.execute("graph.undo", {}, context);
    expect(undone.status).toBe("applied");
    expect(harness.order()).toEqual([red, green, blue]);
  });

  it("keeps the held row under the keyboard when its own row moves out from under it (§V850)", async () => {
    /*
     * The defect this defends against does not exist in jsdom: a browser blurs an element
     * when it is moved in the DOM, and a reorder moves the row it just moved. So the
     * second press of a held ArrowUp would land on nothing and a two-step gesture would
     * quietly become one — green here, broken on screen. The gate therefore BLURS the grip
     * itself, reproducing the browser's behaviour, and then asks for the second press.
     */
    const harness = await setup();
    const [red, green, blue] = harness.layers;
    const before = harness.undoDepth();

    const grip = gripIn(blue);
    grip.focus();
    fireEvent.keyDown(grip, { key: "ArrowUp" });
    grip.blur();
    await settle();

    // Focus came back to the row that moved, not to the row that took its place.
    expect(document.activeElement).toBe(gripIn(blue));
    fireEvent.keyDown(gripIn(blue), { key: "ArrowUp", repeat: true });
    await settle();

    expect(harness.order()).toEqual([blue, red, green]);
    // …and it is still ONE gesture: a blur is not the end of one.
    expect(harness.undoDepth()).toBe(before + 1);
  });

  it("starts a NEW undo entry once the gesture ends, so two separate moves undo separately", async () => {
    // The other half of the same claim, and the one that fails if the transaction is never
    // closed: every reorder for the rest of the session would silently join the first.
    const harness = await setup();
    const [red, green, blue] = harness.layers;

    const first = gripIn(blue);
    first.focus();
    fireEvent.keyDown(first, { key: "ArrowUp" });
    await settle();
    fireEvent.keyUp(gripIn(blue), { key: "ArrowUp" });

    const second = gripIn(blue);
    fireEvent.keyDown(second, { key: "ArrowUp" });
    await settle();
    fireEvent.keyUp(gripIn(blue), { key: "ArrowUp" });
    expect(harness.order()).toEqual([blue, red, green]);

    await harness.bus.execute("graph.undo", {}, context);
    expect(harness.order()).toEqual([red, blue, green]);
  });

  it("moves the row a DRAG dropped, to the position it was dropped on", async () => {
    const harness = await setup();
    const [red, green, blue] = harness.layers;
    const transfer = dataTransfer();

    fireEvent.dragStart(gripIn(blue), { dataTransfer: transfer });
    fireEvent.dragOver(rowFor(red), { dataTransfer: transfer });
    await settle();
    fireEvent.drop(rowFor(blue), { dataTransfer: transfer });

    expect(harness.order()).toEqual([blue, red, green]);
    expect(harness.names()).toEqual(["blue1", "red1", "green1"]);
  });

  it("writes nothing when a drag ends where it began", async () => {
    // A drag wanders over its own row on the way to anywhere. A revision and an audit entry
    // per pass is a history nobody can read back.
    const harness = await setup();
    const revision = harness.bus.store.getRevision();
    const transfer = dataTransfer();
    const [, , blue] = harness.layers;

    fireEvent.dragStart(gripIn(blue), { dataTransfer: transfer });
    fireEvent.dragOver(rowFor(blue), { dataTransfer: transfer });
    await settle();
    fireEvent.drop(rowFor(blue), { dataTransfer: transfer });
    await settle();

    expect(harness.bus.store.getRevision()).toBe(revision);
  });

  it("moves nothing with the arrow keys where the document has no ORDER to change", async () => {
    // `Front` takes one wire, so "which is first" is not a question it has an answer to —
    // `reorderEdges` rejects the port outright. The row is still DRAGGABLE, because moving
    // this wire to another socket is a different question and one this port can answer.
    const harness = await setup();
    const revision = harness.bus.store.getRevision();
    const grip = gripIn(harness.frontEdge);
    grip.focus();
    fireEvent.keyDown(grip, { key: "ArrowUp" });
    fireEvent.keyDown(grip, { key: "ArrowDown" });
    await settle();
    expect(harness.bus.store.getRevision()).toBe(revision);
  });

  it("offers nothing to arrange on the OUT side, and not a disabled control either (§V830)", async () => {
    // An output's edges fan out to consumers that each decide their own order and their own
    // socket, so there is no arrangement at this end. That is the absence of a control, not
    // a greyed-out one — and the row still names the consumer's slot, where the order lives.
    const harness = await setup();
    cleanup();
    const red = harness.bus.store.getGraph().edges[harness.layers[0]]?.source.nodeId as NodeId;
    render(
      <StrictMode>
        <Inspector bus={harness.bus} context={context} nodeId={red} settings={settings} />
      </StrictMode>,
    );
    openCommon();
    expect(connections().querySelectorAll("button[draggable]")).toHaveLength(0);
    expect(connections().querySelectorAll("select")).toHaveLength(0);
    expect(connections().textContent).toContain("Behind 1");
  });
});

describe("T1049 — the rows carry the PORT FAMILY colour (§V26, §V17)", () => {
  it("paints each row from the same function the canvas paints its wires with", () => {
    // Owner: "we can easily also use the colour coding on these ins and outputs, because we
    // know all of these colours". The point of asserting against `edgeFamilyColor` rather
    // than against a token name is that a panel with its own palette would still look
    // plausible while teaching a second vocabulary — a texture wire has to read the same
    // here as it does on the canvas.
    return setupMixedTypes().then((harness) => {
      const colorOf = (edgeId: string): string =>
        (rowFor(edgeId) as HTMLElement).style.getPropertyValue("--row-color");
      expect(colorOf(harness.textureEdge)).toBe(edgeFamilyColor("texture2d"));
      expect(colorOf(harness.pointsEdge)).toBe(edgeFamilyColor("pointset"));
      // Two families, two colours: a constant would satisfy either line on its own.
      expect(colorOf(harness.textureEdge)).not.toBe(colorOf(harness.pointsEdge));
    });
  });
});

describe("T1049 — REASSIGNING a wire to another socket, from the list", () => {
  /*
   * The half the first pass deferred and the owner overruled: "reordering AND reassigning…
   * the whole exercise here was that we can also from here quickly shuffle this around.
   * That was like 50 percent of the request."
   *
   * Both paths below go through `connectDropOperations` — the canvas's own function,
   * extracted rather than copied — so what a drop MEANS here cannot drift from what it
   * means out there.
   */

  it("moves the wire to the socket it was dropped on, and replaces what was there", async () => {
    // Blue, dragged from the third layer onto `Front`. Two things must both be true, and a
    // patch that got either alone would look plausible: blue now feeds Front, and the wire
    // that WAS on Front is gone rather than sitting alongside it on a one-wire port.
    const harness = await setup();
    const [red, green, blue] = harness.layers;
    const transfer = dataTransfer();

    fireEvent.dragStart(gripIn(blue), { dataTransfer: transfer });
    fireEvent.dragOver(rowFor(harness.frontEdge), { dataTransfer: transfer });
    fireEvent.drop(rowFor(harness.frontEdge), { dataTransfer: transfer });
    await settle();

    const graph = harness.bus.store.getGraph();
    expect(graph.edges[harness.frontEdge]).toBeUndefined();
    expect(graph.edges[blue]).toBeUndefined();
    expect(harness.wiredTo("in1")).toEqual(["blue1"]);
    // The layers it left behind closed up, so the sockets still count 1, 2 (T225).
    expect(harness.order()).toEqual([red, green]);
    expect(harness.order().map((id) => graph.edges[id]?.order)).toEqual([0, 1]);
  });

  it("does NOT rewire on the way past — only the socket actually dropped on (§V32)", async () => {
    // A destructive gesture must not fire per row the pointer crosses. Reorder is live
    // because it is reversible and non-destructive; a re-target replaces a connection, and
    // dragging over four rows must not delete four of them.
    const harness = await setup();
    const transfer = dataTransfer();
    const [, , blue] = harness.layers;

    fireEvent.dragStart(gripIn(blue), { dataTransfer: transfer });
    fireEvent.dragOver(rowFor(harness.frontEdge), { dataTransfer: transfer });
    await settle();
    // Still on Front, still three layers: crossing is not dropping.
    expect(harness.bus.store.getGraph().edges[harness.frontEdge]).toBeDefined();
    expect(harness.order()).toHaveLength(3);
  });

  it("reassigns from the KEYBOARD through the socket picker (§V19)", async () => {
    // A drag-only reassign would be half a feature. The picker is a native <select>, so it
    // is keyboard- and screen-reader-operable without this panel inventing a widget.
    const harness = await setup();
    const [, , blue] = harness.layers;

    fireEvent.change(socketSelect(blue), { target: { value: "in1" } });
    await settle();

    expect(harness.wiredTo("in1")).toEqual(["blue1"]);
    expect(harness.bus.store.getGraph().edges[harness.frontEdge]).toBeUndefined();
  });

  it("offers only sockets that would ACCEPT the wire, rather than listing refusals (§V830)", async () => {
    // `textureToAttribute` takes a pointset and a texture. A texture wire can only go in
    // one of them, so the picker has one entry — and a control with no choice in it is not
    // rendered at all rather than rendered inert.
    const harness = await setupMixedTypes();
    expect(rowFor(harness.textureEdge).querySelector("select")).toBeNull();
    expect(rowFor(harness.textureEdge).textContent).toContain("Texture");
  });

  it("REFUSES an incompatible drop, says why, and leaves the graph alone (§V288, §V13)", async () => {
    // The owner's bar: "just reverse it, or just error, or whatever". Silence is the one
    // answer that is not allowed — the drop was aimed at a named row, so nothing happening
    // reads as a broken panel rather than as a refusal.
    const harness = await setupMixedTypes();
    const transfer = dataTransfer();
    const before = harness.bus.store.getRevision();

    fireEvent.dragStart(gripIn(harness.textureEdge), { dataTransfer: transfer });
    fireEvent.drop(rowFor(harness.pointsEdge), { dataTransfer: transfer });
    await settle();

    // §V32: a refused gesture leaves the document byte-identical.
    expect(harness.bus.store.getRevision()).toBe(before);
    expect(harness.bus.store.getGraph().edges[harness.textureEdge]).toBeDefined();
    expect(harness.bus.store.getGraph().edges[harness.pointsEdge]).toBeDefined();
    // And it NAMES the two types rather than saying "invalid" (§V288).
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("texture2d");
    expect(alert.textContent).toContain("pointset");
  });

  it("shows an empty socket only while a wire is actually being moved", async () => {
    // At rest the list answers "what is connected"; during a drag it answers "where can
    // this go". A spare socket sitting there permanently is chrome on every node.
    const harness = await setup();
    const [, , blue] = harness.layers;
    const transfer = dataTransfer();
    const spare = (): Element | null => connections().querySelector('[data-socket="in2#spare"]');

    expect(spare()).toBeNull();
    fireEvent.dragStart(gripIn(blue), { dataTransfer: transfer });
    await settle();
    expect(spare()).not.toBeNull();
    fireEvent.dragEnd(gripIn(blue));
    await settle();
    expect(spare()).toBeNull();
  });
});

describe("T1049 — disconnecting from the list", () => {
  it("drops the edge on the row that was clicked, and compacts the survivors", async () => {
    // The middle row, deliberately: an off-by-one that took a neighbour would be invisible
    // on the first or last (§V854's fixture rule, applied to targeting).
    const harness = await setup();
    const [red, green, blue] = harness.layers;

    fireEvent.click(
      within(rowFor(green)).getByRole("button", { name: "Disconnect Behind 2 from green1" }),
    );
    await settle();

    expect(harness.bus.store.getGraph().edges[green]).toBeUndefined();
    expect(harness.order()).toEqual([red, blue]);
    const graph = harness.bus.store.getGraph();
    expect(harness.order().map((id) => graph.edges[id]?.order)).toEqual([0, 1]);
  });

  it("disconnects from the OUT side too, and undoes as one entry", async () => {
    const harness = await setup();
    const green = harness.bus.store.getGraph().edges[harness.layers[1]]?.source.nodeId as NodeId;
    cleanup();
    render(
      <StrictMode>
        <Inspector bus={harness.bus} context={context} nodeId={green} settings={settings} />
      </StrictMode>,
    );
    openCommon();

    const before = harness.undoDepth();
    fireEvent.click(within(connections()).getByRole("button", { name: /^Disconnect Out from/ }));
    await settle();
    expect(harness.bus.store.getGraph().edges[harness.layers[1]]).toBeUndefined();
    expect(harness.undoDepth()).toBe(before + 1);

    await harness.bus.execute("graph.undo", {}, context);
    expect(harness.order()).toEqual(harness.layers);
  });
});
