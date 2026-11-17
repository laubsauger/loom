import { describe, expect, it } from "vitest";
import { createDomainBus } from "@domain/commands/index.ts";
import { alice, contextFor } from "@domain/commands/test-support.ts";
import { createSequentialIdFactory } from "@domain/graph/ids.ts";
import { createGraphStore } from "@domain/graph/store.ts";
import type { GraphDocument, GraphNode } from "@domain/types/graph.ts";
import type { NodeId } from "@domain/types/ids.ts";
import type { GraphPatchOperation } from "@domain/types/patch.ts";
import { allNodeDefinitions } from "@nodes/definitions/index.ts";
import { panelBoard, serializePanelBoard, type PanelBoard } from "@nodes/definitions/controls.ts";
import { createNodeRegistry } from "@nodes/registry/registry.ts";
import {
  boardOperations,
  boardWithColumns,
  boardWithLabel,
  boardWithLabelText,
  boardWithRect,
  boardWithout,
  removeFromPanelOperations,
} from "./panel-board-edit.ts";
import { joinPanelOperations, panelUnderDrop } from "./panel-join.ts";

/**
 * T1516b — WHAT ARRANGING A BOARD WRITES. The owner's board is a performance surface, so the
 * rule that matters most is the one that stops a gesture from wrecking it: a drop onto
 * another control, off the side, or smaller than a control can be used is REFUSED — nothing
 * is written and nothing else moves (the no-overlap rule; pushing neighbours aside was the
 * alternative and it moves things nobody touched). Every accepted gesture is ONE patch and
 * so one undo.
 */

async function deskWith(stored?: string) {
  const store = createGraphStore({ ids: createSequentialIdFactory("e"), now: () => "2026-10-01T00:00:00.000Z" });
  const { bus } = createDomainBus({ store, registry: createNodeRegistry(allNodeDefinitions).view() });
  const add = (ref: string, type: string, label: string, parameters: Record<string, unknown> = {}): GraphPatchOperation =>
    ({ op: "addNode", ref: `$${ref}`, type, position: { x: 0, y: 0 }, label, parameters }) as GraphPatchOperation;
  const wire = (from: string): GraphPatchOperation =>
    ({ op: "connect", source: { nodeId: `$${from}`, portId: "out" }, target: { nodeId: "$panel", portId: "controls" } }) as GraphPatchOperation;
  const result = await bus.execute(
    "graph.applyPatch",
    {
      baseRevision: 0,
      operations: [
        add("heat", "slider", "heat"),
        add("invert", "toggle", "invert"),
        add("warp", "xyPad", "warp"),
        add("panel", "panel", "panel1", stored === undefined ? {} : { board: stored }),
        wire("heat"),
        wire("invert"),
        wire("warp"),
      ],
    },
    contextFor(alice),
  );
  const ids = result.output.createdIds as Record<string, NodeId>;
  const graph = (): GraphDocument => bus.store.getGraph();
  const panel = (): GraphNode => graph().nodes[ids["$panel"]!]!;
  const current = (): PanelBoard => panelBoard(graph(), panel())!;
  const apply = async (operations: GraphPatchOperation[]) =>
    bus.execute("graph.applyPatch", { baseRevision: bus.store.getRevision(), operations }, contextFor(alice));
  const undoDepth = () => bus.store.getHistory(contextFor(alice).actor).undo.length;
  return { bus, ids, graph, panel, current, apply, undoDepth };
}

const rects = (board: PanelBoard) => Object.fromEntries(board.items.map((item) => [item.key, item.rect]));

describe("T1516b — the no-overlap rule refuses, and moves nothing else", () => {
  // Flowed: heat 4×1 at (0,0), invert 2×1 at (4,0), warp 3×3 at (0,1).
  it("a move onto another control is refused: no write, every rect as it was", async () => {
    const desk = await deskWith();
    const board = desk.current();
    expect(boardWithRect(board, "member:invert", { x: 2, y: 0, w: 2, h: 1 })).toBeNull();
    expect(boardWithRect(board, "member:heat", { x: 0, y: 1, w: 4, h: 1 })).toBeNull();
  });

  it("a move into free cells is accepted, and pins every other item where it is drawn", async () => {
    const desk = await deskWith();
    const board = desk.current();
    const next = boardWithRect(board, "member:invert", { x: 5, y: 2, w: 2, h: 1 });
    expect(next).not.toBeNull();
    const before = desk.undoDepth();
    await desk.apply(boardOperations(desk.ids["$panel"]!, next!));
    expect(desk.undoDepth()).toBe(before + 1);
    expect(rects(desk.current())).toEqual({
      "member:heat": { x: 0, y: 0, w: 4, h: 1 },
      "member:invert": { x: 5, y: 2, w: 2, h: 1 },
      "member:warp": { x: 0, y: 1, w: 3, h: 3 },
    });
  });

  it("refuses off the board's side, and below a control's minimum size", async () => {
    const desk = await deskWith();
    const board = desk.current();
    expect(boardWithRect(board, "member:invert", { x: 7, y: 0, w: 2, h: 1 })).toBeNull();
    expect(boardWithRect(board, "member:invert", { x: -1, y: 4, w: 2, h: 1 })).toBeNull();
    // A pad below 2×2 cannot be dragged on; a toggle at 1×1 is fine.
    expect(boardWithRect(board, "member:warp", { x: 0, y: 1, w: 1, h: 3 })).toBeNull();
    expect(boardWithRect(board, "member:invert", { x: 4, y: 0, w: 1, h: 1 })).not.toBeNull();
    // A resize into a neighbour is refused the same as a move.
    expect(boardWithRect(board, "member:heat", { x: 0, y: 0, w: 5, h: 1 })).toBeNull();
  });

  it("narrowing the columns under a control is refused; widening is not", async () => {
    const desk = await deskWith();
    expect(boardWithColumns(desk.current(), 5)).toBeNull();
    expect(boardWithColumns(desk.current(), 12)?.columns).toBe(12);
  });
});

describe("T1516b — labels and removal, one patch each", () => {
  it("adds a label in the first free spot, edits it, removes it", async () => {
    const desk = await deskWith();
    const added = boardWithLabel(desk.current(), "Look");
    await desk.apply(boardOperations(desk.ids["$panel"]!, added.stored));
    const label = desk.current().items.find((item) => item.key === added.key);
    expect(label).toMatchObject({ kind: "label", text: "Look", rect: { x: 6, y: 0, w: 2, h: 1 } });
    await desk.apply(boardOperations(desk.ids["$panel"]!, boardWithLabelText(desk.current(), added.key, "Picture")!));
    expect(desk.current().items.find((item) => item.key === added.key)).toMatchObject({ text: "Picture" });
    await desk.apply(boardOperations(desk.ids["$panel"]!, boardWithout(desk.current(), added.key)));
    expect(desk.current().items.some((item) => item.kind === "label")).toBe(false);
  });

  it("Remove from panel cuts the wire and drops the rect in ONE patch; one undo restores both", async () => {
    const desk = await deskWith(serializePanelBoard({ columns: 8, items: [{ member: "invert", rect: { x: 6, y: 3, w: 2, h: 1 } }] }));
    const before = desk.undoDepth();
    await desk.apply(removeFromPanelOperations(desk.graph(), desk.ids["$panel"]!, desk.current(), "member:invert"));
    expect(desk.undoDepth()).toBe(before + 1);
    expect(Object.values(desk.graph().edges).some((edge) => edge.source.nodeId === desk.ids["$invert"])).toBe(false);
    expect(desk.current().items.map((item) => item.key)).toEqual(["member:heat", "member:warp"]);
    expect(String(desk.panel().parameters["board"])).not.toContain('"invert"');
    // The widget node itself stays in the document.
    expect(desk.graph().nodes[desk.ids["$invert"]!]).toBeDefined();
    await desk.bus.execute("graph.undo", {}, contextFor(alice));
    expect(rects(desk.current())["member:invert"]).toEqual({ x: 6, y: 3, w: 2, h: 1 });
  });
});

/**
 * T1771b — DROPPING ANY NODE ON A PANEL PUTS ITS ON/OFF SWITCH THERE. The drop is the way a
 * performer says "this one, on this Panel", so it must find the Panel under a plain node
 * (not only under a widget or a bank), write one board item naming it, and write nothing
 * for a node that is already there or for a Panel dropped on a Panel.
 */
describe("T1771b — a plain node joins a Panel by name, as its switch", () => {
  const blur = (id: string, label: string): GraphNode => ({ id, type: "blur", label, definitionVersion: 1, position: { x: 0, y: 0 }, parameters: {} }) as GraphNode;
  const stage = (board?: string): GraphDocument =>
    ({
      revision: 1,
      groups: {},
      edges: {},
      nodes: {
        soft: blur("soft", "blur_soft"),
        panel: { id: "panel", type: "panel", label: "panel1", definitionVersion: 1, position: { x: 0, y: 0 }, parameters: board === undefined ? {} : { board } },
        other: { id: "other", type: "panel", label: "panel2", definitionVersion: 1, position: { x: 0, y: 0 }, parameters: {} },
      },
    }) as never;
  const box = (id: NodeId) => (id === "panel" ? { x: 0, y: 0, width: 100, height: 100 } : id === "other" ? { x: 500, y: 0, width: 100, height: 100 } : null);

  it("the Panel under the drop takes it, as one board item at the switch's size", () => {
    const graph = stage();
    expect(panelUnderDrop(graph, "soft" as NodeId, { x: 50, y: 50 }, box)).toBe("panel");
    expect(panelUnderDrop(graph, "soft" as NodeId, { x: 300, y: 50 }, box)).toBeNull();
    expect(joinPanelOperations(graph, "soft" as NodeId, "panel" as NodeId)).toEqual([
      { op: "setParameters", nodeId: "panel", parameters: { board: serializePanelBoard({ columns: 8, items: [{ member: "blur_soft", rect: { x: 0, y: 0, w: 2, h: 1 } }] }) } },
    ]);
  });

  it("already on the board, or a Panel on a Panel: nothing is written", () => {
    const placed = stage(serializePanelBoard({ columns: 8, items: [{ member: "blur_soft", rect: { x: 0, y: 0, w: 2, h: 1 } }] }));
    expect(joinPanelOperations(placed, "soft" as NodeId, "panel" as NodeId)).toEqual([]);
    expect(panelUnderDrop(stage(), "other" as NodeId, { x: 50, y: 50 }, box)).toBeNull();
    expect(joinPanelOperations(stage(), "other" as NodeId, "panel" as NodeId)).toEqual([]);
  });
});
