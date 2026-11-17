import { useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent, ReactNode } from "react";
import type { LoomBus } from "@domain/commands/bus.ts";
import type { InvocationContext } from "@domain/types/commands.ts";
import type { GraphDocument } from "@domain/types/graph.ts";
import type { NodeId } from "@domain/types/ids.ts";
import type { GraphPatchOperation } from "@domain/types/patch.ts";
import { isParameterSlot, storedStaticValue } from "@domain/parameters/slots.ts";
import type { StoredParameter } from "@domain/types/parameters.ts";
import type { BankCatalogue } from "@domain/presets/bank-view.ts";
import type { NodeRegistryView } from "@nodes/registry/registry.ts";
import { CONTROL_SET_DEFAULT_COMMAND, planControlDefaults } from "@domain/commands/control-default-commands.ts";
import {
  BOARD_MAX_COLUMNS,
  boardNamesMember,
  CONTROL_DEFAULT_KEYS,
  CONTROL_WIDGET_TYPES,
  controlNameOf,
  surfaceNameOf,
  panelLacks,
  panelLacksSwitch,
  type BoardRect,
  type PanelBoard,
  type PanelBoardItem,
  type StoredBoard,
} from "@nodes/definitions/controls.ts";
import { boardBaseFontPx, boardFit, boardValueEm, controlCaption, formatControlValue, type BoardCells, type BoardFit } from "./board-fit.ts";
import { BoardMember } from "./board-members.tsx";
import { ControlTargets } from "./control-targets.tsx";
import { ControlWidget, type ControlWrite } from "./control-widget.tsx";
import {
  boardOperations,
  boardRectFits,
  boardWithColumns,
  boardWithLabel,
  boardWithLabelText,
  boardWithRect,
  boardWithout,
  removeFromPanelOperations,
} from "./panel-board-edit.ts";
import { joinPanelOperations } from "./panel-join.ts";
import { useLiveNode } from "./use-live-node.ts";
import { usePresetCatalogue } from "./use-preset-catalogue.ts";
import styles from "./panel-board.module.css";

/**
 * T1516b — A PANEL BOARD, DRAWN: every control at the rect `panelBoard` gives it, and free
 * text labels between them. One component for both places a board shows on the desk:
 *
 * - the Controls tab (`variant="tab"`) draws it at a FIXED, compact cell size — the board
 *   does not stretch to the pane; a big board scrolls — and offers EDIT mode;
 * - the Panel node's canvas body (`variant="canvas"`) scales the same grid to the node's
 *   width, square cells, play only — its header's pencil opens the SAME editor in a
 *   popover (T1518b, `panel-edit.tsx`).
 *
 * PLAY (the default) only operates the controls: no chips, no arrows, no handles. EDIT
 * (the pencil in the tab header, or on the Panel node's) turns the controls inert and makes the board the thing
 * being edited — drag a control to move it by whole cells, drag its corner to resize,
 * select it to see what it drives (× unlinks) or take it off the Panel, add and edit text
 * labels. A drag shows its ghost live and writes ONE patch on drop (`panel-board-edit.ts`);
 * a drop the no-overlap rule refuses writes nothing.
 *
 * T1518b — every item is drawn at the type size its rect has room for, and says only what
 * fits (`board-fit.ts`): since VNB9 the caption is cut before the value goes, never both. The same
 * rule at the tab's fixed cells and at the canvas body's scaled ones.
 *
 * T1501b — a board also holds a Presets bank (a strip of preset buttons), a Layer (its
 * switch and fader) and a Cue List (GO / BACK), drawn by `board-members.tsx` at their
 * rects like any widget, in both places and in edit mode. They press bus commands, so a
 * board is handed the bus and the invocation it writes under.
 *
 * T1527b — EDIT mode's "+ Add…" puts any node this Panel still lacks on it (`panelLacks`,
 * `joinPanelOperations`: a widget wired in, a bank, layer or cue list named on the board),
 * one patch. It is the Panel-side door, and with two or more Panels the only one besides
 * the drop: a node's own "+ panel" offers only when there is exactly one Panel (one
 * answer, and the room node-box models for it), and the node menu is at its eleven-row
 * cap — a Panel-titled submenu there would have to displace a row on every node for a
 * gesture that belongs to four node families. Removing is here too, so both directions of
 * membership live in the one place a board is arranged.
 */

/** The pencil: edit mode's switch — in the Controls tab's header and on the Panel node's (T1518b). */
export function Pencil() {
  return (
    <svg className={styles.pencil} viewBox="0 0 12 12" aria-hidden="true" focusable="false">
      <path d="M2 10l.6-2.4L8.2 2l1.8 1.8-5.6 5.6L2 10zM7.2 3l1.8 1.8" />
    </svg>
  );
}

/** The tab's cell, in px: compact (owner: "hard to overview"), still a thumb's width. */
export const BOARD_CELL_PX = 52;
/** The tab's gap between cells, in px. A move steps by cell + gap. */
export const BOARD_GAP_PX = 4;
const PITCH = BOARD_CELL_PX + BOARD_GAP_PX;
/** Empty rows an edit-mode board offers below its last item, so a control can move down. */
const EDIT_SPARE_ROWS = 2;

const placement = (rect: BoardRect): CSSProperties => ({
  gridColumn: `${String(rect.x + 1)} / span ${String(rect.w)}`,
  gridRow: `${String(rect.y + 1)} / span ${String(rect.h)}`,
});

/** `.canvas .item` — `padding: 1px`, both sides. */
const CANVAS_ITEM_PADDING_PX = 2;

type CellMetrics = BoardCells;

const TAB_CELLS: CellMetrics = { cellPx: BOARD_CELL_PX, widthOf: (w) => w * BOARD_CELL_PX + (w - 1) * BOARD_GAP_PX };

/** The canvas body: `columns` square cells across `widthPx`, no gap, a hairline of padding. */
const canvasCells = (widthPx: number, columns: number): CellMetrics => {
  const cellPx = widthPx / columns;
  return { cellPx, widthOf: (w) => w * cellPx - CANVAS_ITEM_PADDING_PX };
};

/** T1518b — what this item has room to say at this cell size. */
function fitOf(item: PanelBoardItem, cells: CellMetrics): BoardFit {
  const widthPx = cells.widthOf(item.rect.w);
  if (item.kind === "label") return boardFit({ kind: "label", caption: item.text, valueEm: 0, widthPx, cellPx: cells.cellPx });
  // T1501b: a bank, a layer and a cue list are several parts; each part fits itself (`board-members.tsx`).
  if (boardNamesMember(item.node)) return { fontPx: boardBaseFontPx(cells.cellPx), value: true, caption: "whole" };
  const parameters = item.node.parameters as Record<string, unknown>;
  return boardFit({ kind: item.node.type, caption: controlCaption(parameters), valueEm: boardValueEm(item.node.type, parameters), widthPx, cellPx: cells.cellPx });
}

/** An item's box: its place on the grid, and the type size its rect has room for. */
const itemStyle = (item: PanelBoardItem, fit: BoardFit): CSSProperties => ({ ...placement(item.rect), fontSize: `${String(fit.fontPx)}px` });

const rectAttr = (rect: BoardRect): string => `${String(rect.x)},${String(rect.y)},${String(rect.w)},${String(rect.h)}`;

/**
 * What a board item is called, in its accessible name and as the title of its inspector.
 * T1593b: a bank, a layer or a cue list by its ROLE, as the board itself captions it
 * (`surfaceNameOf`); the catalogue is what reads a look instance's kind.
 */
function boardItemName(item: PanelBoardItem, catalogue: BankCatalogue | undefined): string {
  if (item.kind === "label") return item.text === "" ? "label" : item.text;
  if (boardNamesMember(item.node)) return surfaceNameOf(item.node, catalogue);
  return controlCaption(item.node.parameters as Record<string, unknown>);
}

/** What a board needs to PLAY: the parameter writer, and the bus its bank, layer and cue-list items press. */
interface BoardPlay {
  readonly write: ControlWrite;
  readonly bus: LoomBus;
  readonly invocation: InvocationContext;
}

type WidgetItem = Extract<PanelBoardItem, { readonly kind: "widget" }>;

/** What an item draws, from the node the board was laid out with: the editor's inert picture of it (it renders from the live document). */
function Item({ item, fit, cells, write, bus, invocation }: BoardPlay & { readonly item: PanelBoardItem; readonly fit: BoardFit; readonly cells: CellMetrics }) {
  if (item.kind === "label") return <div className={styles.label}>{item.text}</div>;
  if (boardNamesMember(item.node)) {
    return <BoardMember node={item.node} rect={item.rect} cells={cells} bus={bus} invocation={invocation} write={write} />;
  }
  return (
    <ControlWidget nodeId={item.node.id} type={item.node.type} parameters={item.node.parameters as Record<string, unknown>} write={write} size="board" showValue={fit.value} />
  );
}

/** One place on the board: its box on the grid, and what `fit` says its rect has room for. */
function Cell({ item, fit, children }: { readonly item: PanelBoardItem; readonly fit: BoardFit; readonly children: ReactNode }) {
  return (
    <div className={styles.item} style={itemStyle(item, fit)} data-board-item={item.key} data-rect={rectAttr(item.rect)} data-caption-fit={fit.caption}>
      {children}
    </div>
  );
}

/**
 * A control on the board, reading ITS OWN node (`useLiveNode`, T1668b): the board hands it
 * the node it was laid out from, and what it draws — its value, its caption's fit — is the
 * document's. So a value written to it renders this cell, on each surface that shows the
 * board, and no other.
 */
function ControlCell({ item, cells, write, bus, invocation }: BoardPlay & { readonly item: WidgetItem; readonly cells: CellMetrics }) {
  const node = useLiveNode(bus, item.node);
  const fit = fitOf({ ...item, node }, cells);
  return (
    <Cell item={item} fit={fit}>
      <Item item={{ ...item, node }} fit={fit} cells={cells} write={write} bus={bus} invocation={invocation} />
    </Cell>
  );
}

export interface PanelBoardGridProps extends BoardPlay {
  readonly board: PanelBoard;
  readonly variant: "canvas" | "tab";
  /** `variant="canvas"`: the width the board is scaled to, in px (`controlsContentWidth`), so type is sized for the real cell. */
  readonly widthPx?: number;
}

/** PLAY mode: the board, operable, nothing else. */
export function PanelBoardGrid({ board, write, bus, invocation, variant, widthPx }: PanelBoardGridProps) {
  const cells = variant === "canvas" && widthPx !== undefined ? canvasCells(widthPx, board.columns) : TAB_CELLS;
  const grid: CSSProperties =
    variant === "canvas"
      ? {
          gridTemplateColumns: `repeat(${String(board.columns)}, minmax(0, 1fr))`,
          gridTemplateRows: `repeat(${String(board.rows)}, minmax(0, 1fr))`,
          aspectRatio: `${String(board.columns)} / ${String(board.rows)}`,
        }
      : {
          gridTemplateColumns: `repeat(${String(board.columns)}, ${String(BOARD_CELL_PX)}px)`,
          gridAutoRows: `${String(BOARD_CELL_PX)}px`,
          gap: `${String(BOARD_GAP_PX)}px`,
        };
  return (
    <div className={variant === "canvas" ? styles.canvas : styles.tab} style={grid} data-panel-board={variant} data-columns={board.columns} data-rows={board.rows}>
      {board.items.map((item) =>
        item.kind === "label" ? (
          <Cell key={item.key} item={item} fit={fitOf(item, cells)}>
            <div className={styles.label}>{item.text}</div>
          </Cell>
        ) : (
          <ControlCell key={item.key} item={item} cells={cells} write={write} bus={bus} invocation={invocation} />
        ),
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ edit mode */

export interface PanelBoardEditorProps extends BoardPlay {
  readonly graph: Pick<GraphDocument, "nodes" | "edges">;
  readonly panelId: NodeId;
  readonly board: PanelBoard;
  /** Sends ONE patch through the bus. */
  readonly apply: (operations: GraphPatchOperation[], label: string) => void;
  /** For the Drives chips' × (`ControlTargets`): unbinding reads the target's declared default. */
  readonly registry: NodeRegistryView;
}

interface Drag {
  readonly key: string;
  readonly mode: "move" | "resize";
  /** The pointer at the press, in BOARD space: client px plus the board area's scroll (T1518b). */
  readonly start: { readonly x: number; readonly y: number };
  readonly from: BoardRect;
  readonly moved: boolean;
}

/** The rect a drag of (dx, dy) whole cells asks for. */
const dragged = (drag: Drag, dx: number, dy: number): BoardRect =>
  drag.mode === "move"
    ? { ...drag.from, x: drag.from.x + dx, y: drag.from.y + dy }
    : { ...drag.from, w: drag.from.w + dx, h: drag.from.h + dy };

const capture = (event: ReactPointerEvent<HTMLElement>): void => {
  try {
    event.currentTarget.setPointerCapture(event.pointerId);
  } catch {
    // jsdom and a few browsers refuse capture for synthetic pointers; the drag still works.
  }
};

export function PanelBoardEditor({ graph, panelId, board, write, bus, invocation, apply, registry }: PanelBoardEditorProps) {
  const [selected, setSelected] = useState<string | null>(null);
  const catalogue = usePresetCatalogue(bus);
  const [ghost, setGhost] = useState<{ readonly key: string; readonly rect: BoardRect; readonly fits: boolean } | null>(null);
  const drag = useRef<Drag | null>(null);
  /**
   * T1518b — the board area scrolls by itself (a short dock keeps the toolbar and reaches
   * the spare rows), so a drag is measured in BOARD space: scrolling it mid-drag moves the
   * control by what was scrolled, exactly as moving the pointer would.
   */
  const workspace = useRef<HTMLDivElement | null>(null);
  const at = (event: ReactPointerEvent<HTMLElement>): { x: number; y: number } => ({
    x: event.clientX + (workspace.current?.scrollLeft ?? 0),
    y: event.clientY + (workspace.current?.scrollTop ?? 0),
  });
  const cellsFrom = (current: Drag, event: ReactPointerEvent<HTMLElement>): [number, number] => {
    const now = at(event);
    return [Math.round((now.x - current.start.x) / PITCH), Math.round((now.y - current.start.y) / PITCH)];
  };
  const commit = (stored: StoredBoard | null, label: string): void => {
    if (stored !== null) apply(boardOperations(panelId, stored), label);
  };

  const begin = (item: PanelBoardItem, mode: Drag["mode"]) => (event: ReactPointerEvent<HTMLElement>) => {
    event.stopPropagation();
    capture(event);
    drag.current = { key: item.key, mode, start: at(event), from: item.rect, moved: false };
  };
  const move = (event: ReactPointerEvent<HTMLElement>) => {
    const current = drag.current;
    if (current === null) return;
    const [dx, dy] = cellsFrom(current, event);
    if (dx === 0 && dy === 0 && !current.moved) return;
    drag.current = { ...current, moved: true };
    const rect = dragged(current, dx, dy);
    setGhost({ key: current.key, rect, fits: boardRectFits(board, current.key, rect) });
  };
  const end = (event: ReactPointerEvent<HTMLElement>) => {
    const current = drag.current;
    drag.current = null;
    setGhost(null);
    if (current === null) return;
    if (!current.moved) {
      setSelected(current.key);
      return;
    }
    const rect = dragged(current, ...cellsFrom(current, event));
    commit(boardWithRect(board, current.key, rect), current.mode === "move" ? "Move on panel" : "Resize on panel");
  };
  /** Arrow keys move a selected control a cell; with Shift they resize it. Same rule, same write. */
  const key = (item: PanelBoardItem) => (event: ReactKeyboardEvent<HTMLElement>) => {
    const steps: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    const step = steps[event.key];
    if (step === undefined) return;
    event.preventDefault();
    const [dx, dy] = step;
    const rect = event.shiftKey ? { ...item.rect, w: item.rect.w + dx, h: item.rect.h + dy } : { ...item.rect, x: item.rect.x + dx, y: item.rect.y + dy };
    commit(boardWithRect(board, item.key, rect), event.shiftKey ? "Resize on panel" : "Move on panel");
  };

  const rows = board.rows + EDIT_SPARE_ROWS;
  const slots: BoardRect[] = [];
  for (let y = 0; y < rows; y += 1) for (let x = 0; x < board.columns; x += 1) slots.push({ x, y, w: 1, h: 1 });
  const chosen = board.items.find((item) => item.key === selected);
  // T1527b: every node this Panel still lacks, by the predicate the join itself reads (`panelLacks`).
  // T1541b: with the catalogue, so a look's instance is offered as its bank.
  const panel = graph.nodes[panelId];
  const joinable =
    panel === undefined
      ? []
      : Object.values(graph.nodes)
          .filter((node) => panelLacks(graph, panel, node, catalogue))
          .sort((a, b) => controlNameOf(a).localeCompare(controlNameOf(b)));
  // T1771b: and every other node, as its on/off switch (`switchesOnBoard`) — listed apart, it is most of the document.
  const switchable =
    panel === undefined
      ? []
      : Object.values(graph.nodes)
          .filter((node) => panelLacksSwitch(graph, panel, node, catalogue))
          .sort((a, b) => controlNameOf(a).localeCompare(controlNameOf(b)));
  // T1619b: what "Set all as default" would write, asked of the command's own plan.
  const setAll = planControlDefaults("setDefault", graph, { nodeIds: [panelId] });

  return (
    <div className={styles.editor} data-board-editing>
      <div className={styles.toolbar}>
        <label className={styles.field}>
          Columns
          <input
            type="number"
            min={1}
            max={BOARD_MAX_COLUMNS}
            value={board.columns}
            className={styles.number}
            aria-label="Columns"
            onChange={(event) => commit(boardWithColumns(board, Number(event.target.value)), "Panel columns")}
          />
        </label>
        <button
          type="button"
          className={styles.tool}
          onClick={() => {
            const added = boardWithLabel(board, "Label");
            commit(added.stored, "Add label");
            setSelected(added.key);
          }}
        >
          + Label
        </button>
        {/* T1527b: what can still join THIS Panel — the one way in with several Panels besides the drop. */}
        <select
          className={styles.tool}
          aria-label="Add to panel"
          title="Put a node on this Panel"
          value=""
          disabled={joinable.length === 0 && switchable.length === 0}
          onChange={(event) => {
            const node = [...joinable, ...switchable].find((each) => each.id === event.target.value);
            if (node === undefined) return;
            apply(joinPanelOperations(graph, node.id, panelId, catalogue), "Add to panel");
            setSelected(`member:${controlNameOf(node)}`);
          }}
        >
          <option value="">{joinable.length === 0 && switchable.length === 0 ? "Nothing to add" : "+ Add…"}</option>
          {joinable.map((node) => (
            <option key={node.id} value={node.id}>
              {controlNameOf(node)}
            </option>
          ))}
          {switchable.length === 0 ? null : (
            <optgroup label="On/off switch for">
              {switchable.map((node) => (
                <option key={node.id} value={node.id}>
                  {controlNameOf(node)}
                </option>
              ))}
            </optgroup>
          )}
        </select>
        {/* T1619b: authoring lives where arranging does — every control here takes its value as its default. */}
        <button
          type="button"
          className={styles.tool}
          disabled={setAll.refusal !== null}
          title={setAll.refusal === null ? "Each control's value becomes its default" : (setAll.diagnostics[0]?.message ?? "Each value is its default already")}
          onClick={() => void bus.execute(CONTROL_SET_DEFAULT_COMMAND, { nodeIds: [panelId] }, invocation)}
        >
          Set all as default
        </button>
      </div>
      <div className={styles.workspace} ref={workspace} data-board-workspace>
        <div
          className={styles.tab}
          style={{
            gridTemplateColumns: `repeat(${String(board.columns)}, ${String(BOARD_CELL_PX)}px)`,
            gridTemplateRows: `repeat(${String(rows)}, ${String(BOARD_CELL_PX)}px)`,
            gap: `${String(BOARD_GAP_PX)}px`,
          }}
          data-panel-board="tab"
          data-columns={board.columns}
          data-rows={board.rows}
        >
          {slots.map((slot) => (
            <div key={`slot-${rectAttr(slot)}`} className={styles.slot} style={placement(slot)} aria-hidden="true" />
          ))}
          {board.items.map((item) => {
            const name = boardItemName(item, catalogue);
            const fit = fitOf(item, TAB_CELLS);
            return (
              <div
                key={item.key}
                className={`${styles.item} ${styles.editable} ${selected === item.key ? styles.selected : ""}`}
                style={itemStyle(item, fit)}
                data-board-item={item.key}
                data-rect={rectAttr(item.rect)}
                data-caption-fit={fit.caption}
              >
                {/* Inert: in edit mode a control is a thing to place, not to play. */}
                <div className={styles.inert} inert>
                  <Item item={item} fit={fit} cells={TAB_CELLS} write={write} bus={bus} invocation={invocation} />
                </div>
                <div
                  className={styles.mover}
                  role="button"
                  tabIndex={0}
                  aria-label={`Move ${name}`}
                  aria-pressed={selected === item.key}
                  title="Drag to move · arrows move · Shift+arrows resize"
                  onPointerDown={begin(item, "move")}
                  onPointerMove={move}
                  onPointerUp={end}
                  onKeyDown={key(item)}
                />
                <div
                  className={styles.handle}
                  role="button"
                  aria-label={`Resize ${name}`}
                  title="Drag to resize"
                  onPointerDown={begin(item, "resize")}
                  onPointerMove={move}
                  onPointerUp={end}
                />
              </div>
            );
          })}
          {ghost === null ? null : (
            <div className={`${styles.ghost} ${ghost.fits ? "" : styles.blocked}`} style={placement(ghost.rect)} data-board-ghost={ghost.fits ? "fits" : "blocked"} aria-hidden="true" />
          )}
        </div>
        <aside className={styles.inspect} data-board-inspect aria-label="Board item">
          {chosen === undefined ? (
            // The how-to lives on each control's tooltip (§V90); here, only the state.
            <p className={styles.hint}>Nothing selected</p>
          ) : chosen.kind === "widget" ? (
            <>
              <h3 className={styles.inspectTitle}>{boardItemName(chosen, catalogue)}</h3>
              {/* VN74: a widget's caption is renamed here, and its whole caption and value are read here. */}
              {CONTROL_WIDGET_TYPES.has(chosen.node.type) ? (
                <CaptionInspector
                  key={chosen.node.id}
                  node={graph.nodes[chosen.node.id] ?? chosen.node}
                  onCaption={(caption) => apply([{ op: "setParameters", nodeId: chosen.node.id, parameters: { caption } }], "Rename control")}
                />
              ) : null}
              {/* T1501b: a bank, a layer or a cue list publishes no channel, so it drives nothing to list. */}
              {CONTROL_WIDGET_TYPES.has(chosen.node.type) ? (
                <>
                  <p className={styles.inspectMeta}>Drives</p>
                  <ControlTargets graph={graph} registry={registry} widget={chosen.node} apply={apply} />
                </>
              ) : null}
              {/* T1619b: this one control's value becomes the value Reset returns it to. A Button holds none. */}
              {CONTROL_DEFAULT_KEYS[chosen.node.type] === undefined ? null : (
                <SetAsDefault graph={graph} nodeId={chosen.node.id} bus={bus} invocation={invocation} />
              )}
              <button
                type="button"
                className={styles.tool}
                onClick={() => {
                  apply(removeFromPanelOperations(graph, panelId, board, chosen.key), "Remove from panel");
                  setSelected(null);
                }}
              >
                Remove from panel
              </button>
            </>
          ) : (
            <LabelInspector
              key={chosen.key}
              text={chosen.text}
              onText={(text) => commit(boardWithLabelText(board, chosen.key, text), "Edit label")}
              onRemove={() => {
                commit(boardWithout(board, chosen.key), "Remove label");
                setSelected(null);
              }}
            />
          )}
        </aside>
      </div>
    </div>
  );
}

/** T1619b — "Set as default" for the selected control: greyed, with the command's own reason, when it would write nothing. */
function SetAsDefault({ graph, nodeId, bus, invocation }: Pick<BoardPlay, "bus" | "invocation"> & { readonly graph: Pick<GraphDocument, "nodes" | "edges">; readonly nodeId: NodeId }) {
  const plan = planControlDefaults("setDefault", graph, { nodeIds: [nodeId] });
  return (
    <button
      type="button"
      className={styles.tool}
      disabled={plan.refusal !== null}
      title={plan.refusal === null ? "Its value becomes its default" : (plan.diagnostics[0]?.message ?? "Its value is its default already")}
      onClick={() => void bus.execute(CONTROL_SET_DEFAULT_COMMAND, { nodeIds: [nodeId] }, invocation)}
    >
      Set as default
    </button>
  );
}

/**
 * VN74 — what a selected widget prints, as its readout does: a slider's number, a pad's pair,
 * a toggle's On/Off, a button's presses; "driven" where an expression or binding holds it.
 */
function controlValueText(type: string, parameters: Readonly<Record<string, StoredParameter>>): string {
  const read = (key: string, fallback: number): string => {
    const value = parameters[key];
    if (isParameterSlot(value) && value.mode !== "static") return "driven";
    const constant = storedStaticValue(value);
    return formatControlValue(typeof constant === "number" && Number.isFinite(constant) ? constant : fallback);
  };
  switch (type) {
    case "slider":
      return read("value", typeof parameters["min"] === "number" ? parameters["min"] : 0);
    case "xyPad":
      return `${read("x", 0.5)}, ${read("y", 0.5)}`;
    case "toggle":
      return isParameterSlot(parameters["on"]) && parameters["on"].mode !== "static" ? "driven" : storedStaticValue(parameters["on"]) === true ? "On" : "Off";
    case "button":
      return `×${String(storedStaticValue(parameters["presses"]) ?? 0)}`;
    default:
      return "";
  }
}

/**
 * VN74 — a widget's CAPTION, renamed from the board's editor: written to the node's
 * `caption` parameter on Enter or when the field is left, one patch and one undo step, and
 * only when it changed. Under it, the whole caption and the value, which a small cell may cut
 * (VNB9) — the place to read both in full.
 */
function CaptionInspector({ node, onCaption }: { readonly node: GraphDocument["nodes"][string]; readonly onCaption: (caption: string) => void }) {
  const parameters = node.parameters;
  const caption = storedStaticValue(parameters["caption"]);
  const stored = typeof caption === "string" ? caption : "";
  const [draft, setDraft] = useState<string | null>(null);
  const write = (): void => {
    if (draft !== null && draft !== stored) onCaption(draft);
    setDraft(null);
  };
  return (
    <>
      <label className={styles.field}>
        Caption
        <input
          type="text"
          value={draft ?? stored}
          className={styles.text}
          aria-label="Caption"
          placeholder={controlCaption(parameters)}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={write}
          onKeyDown={(event) => {
            if (event.key === "Enter") write();
          }}
        />
      </label>
      <p className={styles.inspectMeta} data-board-inspect-reading>
        <span data-board-inspect-caption>{controlCaption(parameters)}</span> · <span data-board-inspect-value>{controlValueText(node.type, parameters)}</span>
      </p>
    </>
  );
}

/** A label's text, written on Enter or when the field is left — one patch, not one per key. */
function LabelInspector({ text, onText, onRemove }: { readonly text: string; readonly onText: (text: string) => void; readonly onRemove: () => void }) {
  const [draft, setDraft] = useState(text);
  return (
    <>
      <label className={styles.field}>
        Text
        <input
          type="text"
          value={draft}
          className={styles.text}
          aria-label="Label text"
          onChange={(event) => setDraft(event.target.value)}
          onBlur={() => onText(draft)}
          onKeyDown={(event) => {
            if (event.key === "Enter") onText(draft);
          }}
        />
      </label>
      <button type="button" className={styles.tool} onClick={onRemove}>
        Remove label
      </button>
    </>
  );
}
