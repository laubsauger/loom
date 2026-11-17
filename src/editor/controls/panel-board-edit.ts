import type { GraphDocument, GraphNode } from "@domain/types/graph.ts";
import type { NodeId } from "@domain/types/ids.ts";
import type { GraphPatchOperation } from "@domain/types/patch.ts";
import { incomingEdgesInOrder } from "@domain/graph/edge-order.ts";
import type { BankCatalogue } from "@domain/presets/bank-view.ts";
import {
  BOARD_MAX_COLUMNS,
  joinsBoardByName,
  switchesOnBoard,
  PANEL_INPUT,
  boardDefaultSize,
  boardMemberSize,
  boardMinimumSize,
  boardRectsOverlap,
  controlNameOf,
  firstFreeRect,
  serializePanelBoard,
  storedBoardOf,
  type BoardRect,
  type PanelBoard,
  type PanelBoardItem,
  type StoredBoard,
} from "@nodes/definitions/controls.ts";

/**
 * T1516b — WHAT AN EDIT GESTURE ON A PANEL BOARD WRITES, as pure functions: the board in,
 * the next stored board (or a refusal) out. The Controls tab's edit mode calls these and
 * sends the answer through the bus as ONE patch (`boardOperations`), so every move, resize,
 * label and column change is one undo step.
 *
 * Every answer is the WHOLE derived board written back (`storedBoardOf`): an item that was
 * still flowing gets pinned where it is drawn, so editing one control never makes another
 * jump, and an item whose widget was unwired leaves storage here.
 *
 * ## The no-overlap rule: REFUSE
 *
 * A move or resize whose rect would cover another item, leave the board's columns, or
 * shrink below the item's minimum is refused — `null`, nothing written, the control stays
 * where it was. Pushing the neighbours aside was the alternative; it can cascade down the
 * board and move things the owner did not touch, which on a performance surface is worse
 * than a drop that does not take. The drag shows the refusal before the drop does.
 */

const sameRect = (a: BoardRect, b: BoardRect): boolean => a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;

const typeOf = (item: PanelBoardItem): string | null => (item.kind === "widget" ? item.node.type : null);

/** Would `rect` be a legal place for the item `key`: inside the columns, big enough, on nothing else? */
export function boardRectFits(board: PanelBoard, key: string, rect: BoardRect): boolean {
  const item = board.items.find((each) => each.key === key);
  if (item === undefined) return false;
  const minimum = boardMinimumSize(typeOf(item));
  if (rect.w < minimum.w || rect.h < minimum.h) return false;
  if (rect.x < 0 || rect.y < 0 || rect.x + rect.w > board.columns) return false;
  return !board.items.some((other) => other.key !== key && boardRectsOverlap(rect, other.rect));
}

/** The item `key` moved or resized to `rect`; `null` when refused or when nothing changed. */
export function boardWithRect(board: PanelBoard, key: string, rect: BoardRect): StoredBoard | null {
  const item = board.items.find((each) => each.key === key);
  if (item === undefined || sameRect(item.rect, rect) || !boardRectFits(board, key, rect)) return null;
  const stored = storedBoardOf(board);
  return { ...stored, items: stored.items.map((entry, index) => (board.items[index]!.key === key ? { ...entry, rect } : entry)) };
}

/** A new text label in the first free spot; its key is the one the next derivation gives it. */
export function boardWithLabel(board: PanelBoard, text: string): { readonly stored: StoredBoard; readonly key: string } {
  const stored = storedBoardOf(board);
  const rect = firstFreeRect(board.items.map((item) => item.rect), board.columns, boardDefaultSize(null));
  const labels = board.items.filter((item) => item.kind === "label").length;
  return { stored: { ...stored, items: [...stored.items, { label: text, rect }] }, key: `label:${String(labels)}` };
}

/**
 * T1501b — a bank, a layer or a cue list JOINS the board: an item naming it, in the first
 * free spot at the size the node asks for (`boardMemberSize`). `null` when it is not one of
 * those kinds or the board already shows it — for these nodes the item IS the membership.
 *
 * T1541b: a look's instance joins the same way, as its bank's strip (`joinsBoardByName`),
 * which only the catalogue can tell.
 */
export function boardWithMember(board: PanelBoard, node: GraphNode, catalogue?: BankCatalogue): StoredBoard | null {
  // T1771b: and any other node, as its on/off switch.
  if (!joinsBoardByName(node, catalogue) && !switchesOnBoard(node, catalogue)) return null;
  if (board.items.some((item) => item.kind === "widget" && item.node.id === node.id)) return null;
  const stored = storedBoardOf(board);
  const rect = firstFreeRect(board.items.map((item) => item.rect), board.columns, boardMemberSize(node, catalogue));
  return { ...stored, items: [...stored.items, { member: controlNameOf(node), rect }] };
}

/** A label's text changed; `null` when it is not a label or the text is the same. */
export function boardWithLabelText(board: PanelBoard, key: string, text: string): StoredBoard | null {
  const item = board.items.find((each) => each.key === key);
  if (item?.kind !== "label" || item.text === text) return null;
  const stored = storedBoardOf(board);
  return { ...stored, items: stored.items.map((entry, index) => (board.items[index]!.key === key ? { label: text, rect: item.rect } : entry)) };
}

/** The board without the item `key`. */
export function boardWithout(board: PanelBoard, key: string): StoredBoard {
  const stored = storedBoardOf(board);
  return { ...stored, items: stored.items.filter((_entry, index) => board.items[index]!.key !== key) };
}

/**
 * The board at a new column count. Refused (`null`) when an item would fall outside it —
 * narrowing never moves the owner's controls — and outside 1…`BOARD_MAX_COLUMNS`.
 */
export function boardWithColumns(board: PanelBoard, columns: number): StoredBoard | null {
  if (!Number.isInteger(columns) || columns < 1 || columns > BOARD_MAX_COLUMNS || columns === board.columns) return null;
  if (board.items.some((item) => item.rect.x + item.rect.w > columns)) return null;
  return { ...storedBoardOf(board), columns };
}

/** The ONE write every board gesture makes. */
export function boardOperations(panelId: NodeId, stored: StoredBoard): GraphPatchOperation[] {
  return [{ op: "setParameters", nodeId: panelId, parameters: { board: serializePanelBoard(stored) } }];
}

/**
 * "Remove from panel": the widget's wires into the Panel's Controls are cut and its rect
 * leaves the board, in ONE patch — one undo brings both back. The widget node stays.
 *
 * T1501b: a bank, a layer or a cue list has no wire — its item was the membership — so
 * removing it is the board write alone.
 */
export function removeFromPanelOperations(
  graph: Pick<GraphDocument, "nodes" | "edges">,
  panelId: NodeId,
  board: PanelBoard,
  key: string,
): GraphPatchOperation[] {
  const item = board.items.find((each) => each.key === key);
  if (item?.kind !== "widget") return [];
  const edgeIds = incomingEdgesInOrder(graph, panelId, PANEL_INPUT)
    .filter((edge) => edge.source.nodeId === item.node.id)
    .map((edge) => edge.id);
  return [...(edgeIds.length === 0 ? [] : [{ op: "disconnect" as const, edgeIds }]), ...boardOperations(panelId, boardWithout(board, key))];
}
