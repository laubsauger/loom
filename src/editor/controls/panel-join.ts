import type { GraphDocument, GraphNode } from "@domain/types/graph.ts";
import type { NodeId } from "@domain/types/ids.ts";
import type { GraphPatchOperation } from "@domain/types/patch.ts";
import type { BankCatalogue } from "@domain/presets/bank-view.ts";
import { CONTROL_WIDGET_TYPES, PANEL_INPUT, joinsBoardByName, panelBoard, panelLacks, panelLacksSwitch, switchesOnBoard } from "@nodes/definitions/controls.ts";
import { boardOperations, boardWithMember } from "./panel-board-edit.ts";

/**
 * T1512b — HOW A WIDGET JOINS A PANEL, as patch operations.
 *
 * Membership is wiring (`panelLayout`, `controls.ts`), so every gesture that changes it is
 * an edge edit through the bus: dropping a widget node on a Panel and the widget's own "add
 * to panel" button both come here, and the answer is one patch — undoable as one step — or
 * nothing at all. Where a member SITS is the Panel's board (T1516b, `panel-board-edit.ts`),
 * which replaced the Controls tab's move-earlier/later buttons.
 *
 * T1501b — a Presets bank, a Layer and a Cue List join the same two ways, but BY NAME:
 * none of them has a value output to wire, so the patch is one board write that adds an
 * item naming the node (`boardWithMember`). A Panel laid out by its legacy Layout text has
 * no board, so it takes none of them.
 *
 * T1541b — a look's INSTANCE (a component whose definition holds a page bank, §T1505b) is
 * a bank from outside and joins exactly as a bank does, by name. Whether an instance is one
 * only the component catalogue can say (`bankOf`), so every function here takes it; the
 * callers read it off the bus (`presetCatalogueHolderFor`). Without one, no instance joins.
 *
 * T1771b — ANY OTHER NODE joins by name as its on/off switch (`switchesOnBoard`), by a drop
 * on the Panel or the board's "+ Add…": the same one board write.
 */

type Graph = Pick<GraphDocument, "nodes" | "edges">;

/** The nodes a Panel takes: the widgets it wires in, and the ones its board names. */
const joinsPanel = (node: GraphNode | undefined, catalogue: BankCatalogue | undefined): boolean =>
  node !== undefined && (CONTROL_WIDGET_TYPES.has(node.type) || joinsBoardByName(node, catalogue) || switchesOnBoard(node, catalogue));

/**
 * What putting this node on that Panel writes, or nothing when it is already there: a
 * widget's `out` wired into the Panel's Controls; a bank, layer or cue list named on its board.
 */
export function joinPanelOperations(graph: Graph, widgetId: NodeId, panelId: NodeId, catalogue?: BankCatalogue): GraphPatchOperation[] {
  const widget = graph.nodes[widgetId];
  const panel = graph.nodes[panelId];
  // T1527b: whether there is anything to write is `panelLacks` — the same answer the "+ panel"
  // button and the layout model's room for it come from (`soloPanelFor`, `controls.ts`).
  if (widget === undefined || panel === undefined) return [];
  if (!panelLacks(graph, panel, widget, catalogue) && !panelLacksSwitch(graph, panel, widget, catalogue)) return [];
  if (joinsBoardByName(widget, catalogue) || switchesOnBoard(widget, catalogue)) {
    const board = panelBoard(graph, panel);
    const stored = board === null ? null : boardWithMember(board, widget, catalogue);
    return stored === null ? [] : boardOperations(panelId, stored);
  }
  return [{ op: "connect", source: { nodeId: widgetId, portId: "out" }, target: { nodeId: panelId, portId: PANEL_INPUT } }];
}

/** A node's box on the canvas, in graph space. */
export interface CanvasBox {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * The Panel a widget was dropped ON: the one whose box holds the widget's centre. Graph
 * space both sides, so it means the same thing at every zoom (§V142, as T213's splice).
 * The topmost-drawn Panel wins when two overlap — the last in document order, which is
 * the one React Flow paints last. T1501b: a bank, a layer and a cue list drop the same way.
 */
export function panelUnderDrop(
  graph: Graph,
  widgetId: NodeId,
  centre: { readonly x: number; readonly y: number },
  boxOf: (nodeId: NodeId) => CanvasBox | null,
  catalogue?: BankCatalogue,
): NodeId | null {
  if (!joinsPanel(graph.nodes[widgetId], catalogue)) return null;
  let hit: NodeId | null = null;
  for (const node of Object.values(graph.nodes)) {
    if (node.type !== "panel") continue;
    const box = boxOf(node.id);
    if (box === null) continue;
    if (centre.x >= box.x && centre.x <= box.x + box.width && centre.y >= box.y && centre.y <= box.y + box.height) hit = node.id;
  }
  return hit;
}

// T1527b: `soloPanelFor` — when the "+ panel" button is offered — lives in `controls.ts`,
// where the layout model (`node-box.ts`) can ask it too.
