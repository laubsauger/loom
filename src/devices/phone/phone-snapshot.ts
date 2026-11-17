import type { FrameClock } from "../../domain/types/frame.ts";
import type { GraphDocument, GraphNode } from "../../domain/types/graph.ts";
import type { NodeId } from "../../domain/types/ids.ts";
import type { NodeDefinition } from "../../domain/types/node-definition.ts";
import type { StoredParameter } from "../../domain/types/parameters.ts";
import { isParameterSlot, staticBindingValue } from "../../domain/parameters/slots.ts";
import { effectiveParameterSchema } from "../../domain/parameters/resolve.ts";
import { PRESETS_NODE_TYPE, parsePresetBank } from "../../domain/presets/bank.ts";
import { bankViewOf, type BankView } from "../../domain/presets/bank-view.ts";
import type { ComponentRegistryView } from "../../domain/components/registry.ts";
import { PRESET_RECALL_COMMAND } from "../../domain/presets/commands.ts";
import { CUE_SET_STANDBY_COMMAND } from "../../domain/presets/cue-commands.ts";
import {
  CUE_BACK_COMMAND,
  CUE_GO_COMMAND,
  CUE_LIST_NODE_TYPE,
  nextCueName,
  parseCueList,
  previousCue,
  type CueList,
  type CuePosition,
} from "../../domain/presets/cue-list.ts";
import { morphRunning, parseMorphRecords, type MorphRecord } from "../../domain/presets/morph.ts";
import { followsTimeline, timelineCuePosition, timelineStructuralSettings } from "../../domain/presets/timeline-cues.ts";
import type { NodeRegistryView } from "../../nodes/registry/registry.ts";
import { layerNode } from "../../nodes/definitions/layer.ts";
import {
  CONTROL_WIDGET_TYPES,
  LAYER_NODE_TYPE,
  surfaceNameOf,
  switchesOnBoard,
  layerPicture,
  controlButtonNode,
  controlChannel,
  controlSliderNode,
  controlToggleNode,
  controlXYNode,
  panelBoard,
  panelLayout,
  panelMembers,
  panelTitle,
} from "../../nodes/definitions/controls.ts";
import {
  PHONE_WRITABLE_KEYS,
  type PhoneBoard,
  type PhoneBoardItem,
  type PhonePanel,
  type PhoneRow,
  type PhoneSet,
  type PhoneSnapshot,
  type PhoneWidget,
} from "./phone-protocol.ts";

/**
 * T1396b — WHAT A PHONE MAY SEE, AND WHETHER WHAT IT SENT MAY BE WRITTEN. The page's half
 * of the phone door's policy, pure and headless: a document in, a snapshot or a patch out.
 *
 * ## One rule decides both, so they cannot disagree
 *
 * `publishedWidgets` is the ONLY place that decides which widget a phone can reach. The
 * snapshot draws from it and the vet checks against it, so a widget the phone was never
 * shown is a widget it cannot write — including one that WAS shown a moment ago on a Panel
 * whose Phone switch has since been turned off, because the vet re-reads the document on
 * every write rather than trusting what it last sent. A handle is the widget node's id: a
 * phone that guesses another node's id reaches the same refusal as one that sends garbage.
 *
 * ## Members come from the one Panel derivation
 *
 * Which widgets a Panel shows, and in what order, is `panelLayout` (`controls.ts`, T1512b):
 * the widgets wired into it in wiring order, or its layout override's names resolved by
 * `node.label ?? node.id` — the SAME function the Panel's canvas body and the Controls tab
 * draw from, so the phone cannot show another order than the desk. It reads the DOCUMENT
 * graph, so a widget inside a component is invisible to a Panel outside it — T1143's
 * missing publish surface. A name with no widget behind it is dropped (the desk prints
 * "no control named …"; a phone has nothing to do with that line).
 *
 * ## A driven widget is not published
 *
 * A key the document DRIVES (an expression, a bind) is not the user's to move — the
 * editor's own widget draws "driven" and refuses the gesture. The phone contract has no
 * read-only widget, so the simplest correct answer is to leave such a widget out of the
 * snapshot and refuse a write to it. "Driven" here means a slot whose mode is not
 * `static`; a slot in static mode holds a plain value in its static binding and a bare
 * write updates that binding (`apply-patch.ts`, §V108), so it is published like a plain
 * value. Every key the phone reads or writes counts — a slider with an expression on its
 * Max is left out too, because the range the phone would draw is not the range in force.
 * The Panel's own Phone switch follows the same rule: only a plain (or static) `true`
 * publishes it; a switch an expression flips is not a door an expression gets to open.
 *
 * ## Banks, layers and cue lists (T1503b, §T1398b ruling 12)
 *
 * A Presets bank, a Layer and a Cue List join a Panel's BOARD by name (`panelBoard`, T1501b),
 * and a phone reaches exactly the ones on a board whose Panel has Phone on —
 * `publishedMembers`, the same one-rule-for-both as the widgets. What a phone may do to one
 * is recall a preset, switch a layer and move its opacity, and GO / BACK / stand a cue by.
 * `PHONE_COMMANDS` is every bus command the vet can name, and Store and Delete are not in
 * it: there is no key a phone can send that the vet turns into either.
 *
 * A layer whose opacity the document drives IS published, unlike a driven widget: its
 * switch is still the phone's to press. The fader is marked not writable
 * (`opacityWritable`), and a write to it is refused.
 *
 * T1505b: a look's INSTANCE on a board by name, whose component holds a page bank, is a
 * bank to the phone too — drawn as a `preset` strip from its component's presets, with its
 * own `current` and fades, and a recall on it is the recall the desk runs. Seeing inside a
 * component needs the catalogue (`components`); without one an instance is simply not
 * published, so the snapshot and the vet still agree.
 */

/** The component catalogue, for a look's instance on a board (T1505b). Absent: none is published. */
type Catalogue = Pick<ComponentRegistryView, "get"> | undefined;

/** The plain value behind a stored parameter, or `DRIVEN` when a non-static mode is in force. */
const DRIVEN = Symbol("driven");
function plain(stored: StoredParameter | undefined): unknown {
  if (!isParameterSlot(stored)) return stored;
  return stored.mode === "static" ? staticBindingValue(stored) : DRIVEN;
}

const num = (value: unknown, fallback: number): number =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

/** The four control widgets: each is a node type and a phone kind by one name. */
type ControlKind = "slider" | "toggle" | "button" | "xyPad";
type WidgetNode = GraphNode & { readonly type: ControlKind };

const WIDGET_DEFINITIONS: Readonly<Record<ControlKind, NodeDefinition>> = {
  slider: controlSliderNode,
  toggle: controlToggleNode,
  button: controlButtonNode,
  xyPad: controlXYNode,
};

/**
 * A widget's declared default for a numeric key — one source for what "absent" means,
 * read through the schema funnel (§T903) like every other schema read.
 */
function declared(node: WidgetNode, key: string): number {
  const definition = effectiveParameterSchema(WIDGET_DEFINITIONS[node.type], node.parameters)[key];
  return num(definition !== undefined && "default" in definition ? definition.default : undefined, 0);
}

/** Keys the phone READS per widget type — driven on any of them leaves the widget out. */
const READ_KEYS: Readonly<Record<ControlKind, readonly string[]>> = {
  slider: ["value", "min", "max", "step"],
  toggle: ["on"],
  // `presses` is written by the page on a press edge, so it must not be driven either.
  button: ["held", "presses"],
  xyPad: ["x", "y", "min", "max"],
};

const isWidgetKind = (type: string): type is ControlKind =>
  CONTROL_WIDGET_TYPES.has(type) && Object.hasOwn(PHONE_WRITABLE_KEYS, type);

function isDriven(node: GraphNode, kind: ControlKind): boolean {
  return READ_KEYS[kind].some((key) => plain(node.parameters[key]) === DRIVEN);
}

/** A Panel's Phone switch, on only as a plain (or static-mode) `true`. */
export function isRemotePanel(node: GraphNode): boolean {
  return node.type === "panel" && plain(node.parameters["remote"]) === true;
}

/** What the controls pane captions a widget: its Caption, or its channel name. */
function captionOf(node: GraphNode): string {
  const caption = plain(node.parameters["caption"]);
  return typeof caption === "string" && caption !== ""
    ? caption
    : controlChannel(node.parameters as Record<string, unknown>);
}

/** The ordered, lower-first range a widget clamps into (`valueEvaluate`'s own rule). */
function rangeOf(node: WidgetNode): [number, number] {
  const min = num(plain(node.parameters["min"]), declared(node, "min"));
  const max = num(plain(node.parameters["max"]), declared(node, "max"));
  return [Math.min(min, max), Math.max(min, max)];
}

const clamp = (value: number, [lo, hi]: readonly [number, number]): number => Math.min(hi, Math.max(lo, value));

interface Layout {
  readonly panel: GraphNode;
  /** Rows with each widget name resolved to its node; a name with nothing publishable behind it is gone. */
  readonly rows: ReadonlyArray<
    | { readonly kind: "heading" | "text"; readonly text: string }
    | { readonly kind: "widgets"; readonly nodes: readonly WidgetNode[] }
  >;
}

/** Every remote Panel, its rows from the one Panel derivation the desk draws from (T1512b). */
function remoteLayouts(graph: GraphDocument): Layout[] {
  return Object.values(graph.nodes)
    .filter(isRemotePanel)
    .map((panel) => ({
      panel,
      rows: panelLayout(graph, panel).rows.map((row) =>
        row.kind === "widgets"
          ? {
              kind: "widgets" as const,
              nodes: row.cells
                .flatMap((cell) => (cell.kind === "widget" ? [cell.node] : []))
                .filter((node): node is WidgetNode => isWidgetKind(node.type) && !isDriven(node, node.type)),
            }
          : row,
      ),
    }));
}

/** The one decision: widget node id → node, for every widget a phone may see and move. */
export function publishedWidgets(graph: GraphDocument): Map<NodeId, WidgetNode> {
  const out = new Map<NodeId, WidgetNode>();
  for (const layout of remoteLayouts(graph)) {
    for (const row of layout.rows) if (row.kind === "widgets") for (const node of row.nodes) out.set(node.id, node);
  }
  return out;
}

function phoneWidget(node: WidgetNode): PhoneWidget {
  const handle = node.id;
  const caption = captionOf(node);
  const p = (key: string): unknown => plain(node.parameters[key]);
  switch (node.type) {
    case "slider": {
      const range = rangeOf(node);
      return {
        kind: "slider",
        handle,
        caption,
        // What the channel carries, not a raw value outside the range the phone draws.
        value: clamp(num(p("value"), declared(node, "value")), range),
        min: num(p("min"), declared(node, "min")),
        max: num(p("max"), declared(node, "max")),
        step: Math.max(0, num(p("step"), 0)),
      };
    }
    case "toggle":
      return { kind: "toggle", handle, caption, on: p("on") === true };
    case "button":
      return { kind: "button", handle, caption, held: p("held") === true };
    case "xyPad": {
      const range = rangeOf(node);
      return {
        kind: "xyPad",
        handle,
        caption,
        x: clamp(num(p("x"), declared(node, "x")), range),
        y: clamp(num(p("y"), declared(node, "y")), range),
        min: num(p("min"), declared(node, "min")),
        max: num(p("max"), declared(node, "max")),
      };
    }
  }
}

/* ------------------------------------------------- banks, layers, cue lists (T1503b) */

type MemberKind = "preset" | "layer" | "cueList" | "switch";

/** The phone kind a board's by-name member is drawn as, by node type (`BOARD_NAMED_TYPES`). */
const MEMBER_KINDS: Readonly<Record<string, MemberKind>> = {
  [PRESETS_NODE_TYPE]: "preset",
  [LAYER_NODE_TYPE]: "layer",
  [CUE_LIST_NODE_TYPE]: "cueList",
};

/** T1505b: the bank a `preset` member reads — a Presets node, or a look's instance (its component's presets). */
const presetBankOf = (node: GraphNode, components: Catalogue): BankView | undefined => bankViewOf(node, components);

/**
 * T1771b: any OTHER node a board names is its on/off switch (`switchesOnBoard`, the desk's
 * rule). The phone is sent a `toggle` for it, the widget it already draws and presses, so
 * the page and the wire are unchanged; what a press WRITES is decided here, by the node.
 */
const memberKind = (node: GraphNode, components: Catalogue): MemberKind | null =>
  MEMBER_KINDS[node.type] ?? (presetBankOf(node, components)?.kind === "instance" ? "preset" : switchesOnBoard(node, components) ? "switch" : null);

/**
 * The other half of the one decision: bank / layer / cue-list node id → node, for every one
 * a phone may see and operate — those on the board of a Panel whose Phone switch is on.
 */
export function publishedMembers(graph: GraphDocument, components?: Catalogue): Map<NodeId, GraphNode> {
  const out = new Map<NodeId, GraphNode>();
  for (const panel of Object.values(graph.nodes)) {
    if (!isRemotePanel(panel)) continue;
    for (const item of panelBoard(graph, panel)?.items ?? []) {
      if (item.kind === "widget" && memberKind(item.node, components) !== null) out.set(item.node.id, item.node);
    }
  }
  return out;
}

/** A stored text parameter, trimmed; a driven one reads as empty. */
const textOf = (stored: StoredParameter | undefined): string => {
  const value = plain(stored);
  return typeof value === "string" ? value.trim() : "";
};

/** A bank's preset names, in bank order; an unreadable bank has none. A look's are its component's. */
function presetNames(bank: GraphNode, components: Catalogue): string[] {
  const parsed = parsePresetBank(plain((presetBankOf(bank, components)?.bank ?? bank).parameters["presets"]));
  return parsed.ok ? parsed.bank.presets.map((preset) => preset.name) : [];
}

/** The fades a bank still has to do on this clock. No clock (no frame loop): none. A look holds its own. */
function runningMorphs(bank: GraphNode, clock: FrameClock | undefined, components: Catalogue): MorphRecord[] {
  if (clock === undefined) return [];
  const key = presetBankOf(bank, components)?.morphsKey ?? "morphs";
  return parseMorphRecords(plain(bank.parameters[key])).filter((record) => morphRunning(record, clock));
}

/**
 * Every fade behind a `morphing: true` in the snapshot built at `clock`. The page watches
 * THESE records against its frame clock and rebuilds the snapshot when one stops running —
 * the end of a fade changes nothing in the document, so nothing else would say so.
 */
export function publishedMorphs(graph: GraphDocument, clock: FrameClock | undefined, components?: Catalogue): MorphRecord[] {
  if (clock === undefined) return [];
  return [...publishedMembers(graph, components).values()].flatMap((node) =>
    memberKind(node, components) === "preset" ? runningMorphs(node, clock, components) : [],
  );
}

interface LayerOpacity {
  /** The level, inside the range; the declared default when the document drives it. */
  readonly value: number;
  readonly writable: boolean;
  readonly range: readonly [number, number];
}

/** A layer's opacity through the schema funnel (§T903): its range and default are the layer's own. */
function layerOpacity(layer: GraphNode): LayerOpacity {
  const definition = effectiveParameterSchema(layerNode, layer.parameters)["opacity"] as Record<string, unknown> | undefined;
  const range: [number, number] = [num(definition?.["min"], 0), num(definition?.["max"], 1)];
  const fallback = num(definition?.["default"], 1);
  const stored = plain(layer.parameters["opacity"]);
  if (stored === DRIVEN) return { value: fallback, writable: false, range };
  return { value: clamp(num(stored, fallback), range), writable: true, range };
}

/** A cue list's cues and where it stands, as the desk's pad reads them (`board-members.tsx`). */
function cueState(node: GraphNode): { readonly list: CueList | null; readonly position: CuePosition } {
  const parsed = parseCueList(plain(node.parameters["cues"]));
  return {
    list: parsed.ok ? parsed.list : null,
    position: {
      current: textOf(node.parameters["current"]),
      standby: textOf(node.parameters["standby"]),
      wrap: plain(node.parameters["wrap"]) === true,
    },
  };
}

/** T1508b: where a following list is at the clock's playhead; nowhere with no clock (no frame loop). */
function timelinePosition(list: CueList | null, clock: FrameClock | undefined): { current: string | null; next: string | null } {
  if (list === null || clock?.timeSeconds === undefined || clock.timelineRate === undefined) return { current: null, next: null };
  return timelineCuePosition(list, clock.timeSeconds, clock.timelineRate);
}

/**
 * T1508b — the timeline positions behind the following lists in the snapshot built at
 * `clock`, as one string. A crossing changes nothing in the document, so the door compares
 * this once a frame and republishes exactly when a cue is crossed (the `morphing` rule).
 * Empty when no published list follows the timeline.
 */
export function publishedTimelinePositions(graph: GraphDocument, clock: FrameClock | undefined): string {
  const positions: string[] = [];
  for (const node of publishedMembers(graph).values()) {
    if (memberKind(node, undefined) !== "cueList" || !followsTimeline(node)) continue;
    const at = timelinePosition(cueState(node).list, clock);
    positions.push(`${node.id}\u0000${at.current ?? ""}\u0000${at.next ?? ""}`);
  }
  return positions.join("\u0001");
}

function memberWidget(
  graph: GraphDocument,
  node: GraphNode,
  kind: MemberKind,
  clock: FrameClock | undefined,
  components: Catalogue,
  registry: NodeRegistryView | undefined,
): PhoneWidget {
  const handle = node.id;
  // T1593b: the phone draws a bank, a layer and a cue list as what they are, so each is
  // captioned by its ROLE, by the rule the desk's board uses (`surfaceNameOf`).
  const caption = surfaceNameOf(node, components);
  switch (kind) {
    case "preset":
      return {
        kind,
        handle,
        caption,
        presets: presetNames(node, components),
        current: textOf(node.parameters[presetBankOf(node, components)?.currentKey ?? "current"]) || null,
        morphing: runningMorphs(node, clock, components).length > 0,
      };
    case "switch":
      // On means not bypassed, as for a Layer.
      return { kind: "toggle", handle, caption, on: node.ui?.bypassed !== true };
    case "layer": {
      const opacity = layerOpacity(node);
      return {
        kind,
        handle,
        caption,
        on: node.ui?.bypassed !== true,
        opacity: opacity.value,
        opacityWritable: opacity.writable,
        // T1526b: what the layer shows — its Picture name, or "wired" when a wire feeds the
        // picture (§B233: the wire wins), by the rule the desk's item reads (`layerPicture`).
        picture: layerPicture(graph, node.id),
      };
    }
    case "cueList": {
      const { list, position } = cueState(node);
      const cues = list === null ? [] : list.cues.map((cue) => cue.name);
      const notes = list === null ? [] : list.cues.map((cue) => cue.note?.trim() ?? "");
      // T1508b: a list that follows the timeline is read-only here — where the playhead
      // has it, on the page's frame clock, and nothing a phone may press.
      if (followsTimeline(node)) {
        const at = timelinePosition(list, clock);
        // §T1544b: and what it switches in the structure at its cue times, read-only (the inspector's note).
        const structure = registry === undefined ? [] : timelineStructuralSettings(graph, registry, node.id, components);
        return { kind, handle, caption, cues, notes, current: at.current, next: at.next, canGo: false, canBack: false, following: true, structure };
      }
      const next = list === null ? null : nextCueName(list, position);
      return {
        kind,
        handle,
        caption,
        cues,
        notes,
        current: position.current || null,
        next,
        canGo: next !== null,
        canBack: list !== null && previousCue(list, position).ok,
        following: false,
        structure: [],
      };
    }
  }
}

/**
 * T1516b — a wired Panel's board as the phone draws it: the SAME `panelBoard` the Controls
 * tab and the canvas body draw, so the owner's arrangement is the phone's. A widget the
 * phone may not reach (driven) leaves its rect empty rather than moving anything else up —
 * the board is the owner's arrangement, not a flow. A Panel laid out by the legacy override
 * has no board; the phone draws its `rows`.
 */
function phoneBoard(
  graph: GraphDocument,
  panel: GraphNode,
  clock: FrameClock | undefined,
  components: Catalogue,
  registry: NodeRegistryView | undefined,
): PhoneBoard | undefined {
  const board = panelBoard(graph, panel);
  if (board === null) return undefined;
  const items = board.items.flatMap((item): PhoneBoardItem[] => {
    if (item.kind === "label") return [{ kind: "label", rect: item.rect, text: item.text }];
    const node = item.node;
    // T1503b: a bank, a layer or a cue list — on the board by name, drawn at its rect.
    const member = memberKind(node, components);
    if (member !== null) return [{ kind: "widget", rect: item.rect, widget: memberWidget(graph, node, member, clock, components, registry) }];
    return isWidgetKind(node.type) && !isDriven(node, node.type) ? [{ kind: "widget", rect: item.rect, widget: phoneWidget(node as WidgetNode) }] : [];
  });
  return { columns: board.columns, rows: board.rows, items };
}

/**
 * Everything a phone can see, from every Panel whose Phone switch is on. `clock` is the
 * page's frame clock (`bus.frameClock()`), read only to say whether a bank is `morphing`;
 * without one nothing is.
 */
export function buildPhoneSnapshot(
  graph: GraphDocument,
  seq: number,
  clock?: FrameClock,
  components?: Catalogue,
  /** §T1544b: the node registry, so a following cue list can say what structure it switches. */
  registry?: NodeRegistryView,
): PhoneSnapshot {
  const panels: PhonePanel[] = remoteLayouts(graph).map(({ panel, rows }) => {
    const board = phoneBoard(graph, panel, clock, components, registry);
    return {
      title: panelTitle(panel),
      // Kept for a wired Panel too: a phone page from before the board still draws these.
      rows: rows.flatMap((row): PhoneRow[] => {
        if (row.kind !== "widgets") return [row];
        const widgets = row.nodes.map(phoneWidget);
        return widgets.length === 0 ? [] : [{ kind: "widgets", widgets }];
      }),
      ...(board === undefined ? {} : { board }),
    };
  });
  return { seq, panels };
}

/* ------------------------------------------------------------------ the vet */

/**
 * T1503b — EVERY BUS COMMAND A PHONE CAN CAUSE, beside the parameter and bypass patches.
 * Recall and the cue list's three; `preset.store` and `preset.delete` are not here, and
 * `PhoneCommandCall` cannot spell them (§T1398b ruling 12: no Store from the phone).
 */
export const PHONE_COMMANDS = [PRESET_RECALL_COMMAND, CUE_GO_COMMAND, CUE_BACK_COMMAND, CUE_SET_STANDBY_COMMAND] as const;

/** One command and the input the VET built for it — nothing the phone sent rides along but a checked name. */
export type PhoneCommandCall =
  | { readonly command: typeof PRESET_RECALL_COMMAND; readonly input: { readonly nodeId: NodeId; readonly name: string } }
  | { readonly command: typeof CUE_GO_COMMAND | typeof CUE_BACK_COMMAND; readonly input: { readonly nodeId: NodeId } }
  | { readonly command: typeof CUE_SET_STANDBY_COMMAND; readonly input: { readonly nodeId: NodeId; readonly cue: string } };

/**
 * What a vetted phone write becomes:
 *  - `parameters`: one `setParameters` on one node, through the phone's parameter editor;
 *  - `command` (T1503b): one of `PHONE_COMMANDS`, run on the bus as the phone;
 *  - `layerOn` (T1503b): the STATE a layer's switch was asked for — written as that state
 *    (`setNodeUi { bypassed }`), never a flip, so a double tap cannot switch it back.
 */
export type PhoneVet =
  | {
      readonly ok: true;
      readonly action: "parameters";
      readonly nodeId: NodeId;
      readonly kind: ControlKind | "layer";
      readonly entries: Readonly<Record<string, number | boolean>>;
      readonly phase: PhoneSet["phase"];
    }
  | ({ readonly ok: true; readonly action: "command" } & PhoneCommandCall)
  | { readonly ok: true; readonly action: "layerOn"; readonly nodeId: NodeId; readonly caption: string; readonly on: boolean; /** T1771b: any other node's board switch — the same write, named for what it is. */ readonly what?: "switch" }
  /**
   * `nodeId` (T1526b) is the control the refusal is about, present only when the write
   * named one that IS published — the id the snapshot gave the phone, so it is the page's
   * own to send back with the sentence. A write that named nothing published carries none.
   */
  | { readonly ok: false; readonly reason: string; readonly nodeId?: NodeId };

const refuse = (reason: string, nodeId?: NodeId): PhoneVet => ({ ok: false, reason, ...(nodeId === undefined ? {} : { nodeId }) });

/**
 * One phone write, checked against the document as it is NOW.
 *
 * The helper has checked the token; this checks everything else, because the page is the
 * party that owns the document and the only one that can know whether a Panel is still
 * published. Refusal sentences never quote what the phone sent — a key or a handle off
 * the LAN is data, not copy (§V37) — and do name the widget when there is one to name.
 */
export function vetPhoneSet(graph: GraphDocument, set: PhoneSet, components?: Catalogue): PhoneVet {
  if (set.phase !== "live" && set.phase !== "commit") return refuse("A phone sent a write with no gesture phase.");
  const handle = typeof set.handle === "string" ? (set.handle as NodeId) : null;
  const node = handle === null ? undefined : publishedWidgets(graph).get(handle);
  if (node === undefined) {
    const member = handle === null ? undefined : publishedMembers(graph, components).get(handle);
    const memberIs = member === undefined ? null : memberKind(member, components);
    if (member !== undefined && memberIs !== null) return vetMember(member, memberIs, set, components);
    // Also where a widget lands whose Panel was just switched off, and a driven widget
    // on a published Panel — told apart here only when the widget really is on one.
    const named = handle === null ? undefined : graph.nodes[handle];
    if (named !== undefined && isWidgetKind(named.type) && isDriven(named, named.type) && namedOnRemotePanel(graph, named)) {
      return refuse(`“${captionOf(named)}” is driven by the document, so a phone cannot move it.`);
    }
    return refuse("A phone tried to move a control that is not published to the phone door.");
  }
  const kind = node.type;
  const caption = captionOf(node);
  /** A refusal about THIS widget: it is published, so the phone that moved it can be shown the sentence on it (T1526b). */
  const no = (reason: string): PhoneVet => refuse(reason, node.id);
  const values = typeof set.values === "object" && set.values !== null ? set.values : {};
  const keys = Object.keys(values);
  if (keys.length === 0) return no(`A phone's write to “${caption}” carried no values.`);
  const writable: readonly string[] = PHONE_WRITABLE_KEYS[kind];
  if (!keys.every((key) => writable.includes(key))) {
    return no(`A phone tried to write a key a ${kind} does not let a phone write, on “${caption}”.`);
  }

  const p = (key: string): unknown => plain(node.parameters[key]);
  const number = (key: string): number | null => {
    const value = values[key];
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  };
  const flag = (key: string): boolean | null => {
    const value = values[key];
    return typeof value === "boolean" ? value : null;
  };
  const ok = (entries: Record<string, number | boolean>): PhoneVet => ({ ok: true, action: "parameters", nodeId: node.id, kind, entries, phase: set.phase });
  const notNumber = no(`A phone sent “${caption}” something that is not a finite number.`);
  const notFlag = no(`A phone sent “${caption}” something that is not true or false.`);

  switch (kind) {
    case "slider": {
      const value = number("value");
      if (value === null) return notNumber;
      const step = Math.max(0, num(p("step"), 0));
      const snapped = step > 0 ? Math.round(value / step) * step : value;
      return ok({ value: clamp(snapped, rangeOf(node)) });
    }
    case "xyPad": {
      const range = rangeOf(node);
      const entries: Record<string, number> = {};
      for (const key of keys) {
        const value = number(key);
        if (value === null) return notNumber;
        entries[key] = clamp(value, range);
      }
      return ok(entries);
    }
    case "toggle": {
      const on = flag("on");
      return on === null ? notFlag : ok({ on });
    }
    case "button": {
      const held = flag("held");
      if (held === null) return notFlag;
      const presses = num(p("presses"), declared(node, "presses"));
      // A press is counted on the false→true EDGE only: a repeated `held: true` from a
      // phone (or a phone pressing a button the person at the desk is already holding)
      // is not a second press. Both keys every time, so press and release are one
      // gesture identity in the parameter editor — ONE undo group per press (§V15).
      return ok({ held, presses: held && p("held") !== true ? presses + 1 : presses });
    }
  }
}

/**
 * T1503b — one write to a bank, a layer or a cue list that IS on a remote Panel's board.
 *
 * One key per write: each of these is one press (or one fader), and a write naming two
 * things at once has no order to do them in. Everything but a layer's opacity is `commit`
 * only — a recall or a GO is a press, not a drag, and a `live` one is refused by name.
 * A NAME (`recall`, `standby`) is checked against the bank or the list as it is NOW.
 */
function vetMember(node: GraphNode, kind: MemberKind, set: PhoneSet, components: Catalogue): PhoneVet {
  // The caption the phone drew this member under, so a refusal names what the person pressed.
  const caption = surfaceNameOf(node, components);
  /** A refusal about THIS member: it is published, so the phone that pressed it can be shown the sentence on it (T1526b). */
  const no = (reason: string): PhoneVet => refuse(reason, node.id);
  const values = typeof set.values === "object" && set.values !== null ? set.values : {};
  const keys = Object.keys(values);
  if (keys.length === 0) return no(`A phone's write to “${caption}” carried no values.`);
  // T1771b: a switch is drawn as a toggle, and takes what a toggle sends.
  const writable: readonly string[] = PHONE_WRITABLE_KEYS[kind === "switch" ? "toggle" : kind];
  if (!keys.every((key) => writable.includes(key))) {
    return no(`A phone tried to write a key a ${kind} does not let a phone write, on “${caption}”.`);
  }
  if (keys.length > 1) return no(`A phone sent “${caption}” two things in one write; a ${kind} takes one at a time.`);
  const key = keys[0] as string;
  const value = values[key];
  const pressOnly = (what: string): PhoneVet | null =>
    set.phase === "commit" ? null : no(`A phone sent “${caption}” ${what} as a live drag; it is one press, sent once.`);
  const call = (command: PhoneCommandCall): PhoneVet => ({ ok: true, action: "command", ...command });

  switch (kind) {
    case "switch": {
      // T1771b: the node's on/off — the Layer's write, the state asked for and never a flip.
      const live = pressOnly("its switch");
      if (live !== null) return live;
      if (typeof value !== "boolean") return no(`A phone sent “${caption}” something that is not true or false.`);
      return { ok: true, action: "layerOn", nodeId: node.id, caption, on: value, what: "switch" };
    }
    case "preset": {
      const live = pressOnly("a recall");
      if (live !== null) return live;
      // Not quoted back: what a phone sent is data off the LAN, not copy.
      if (typeof value !== "string" || !presetNames(node, components).includes(value)) {
        return no(`“${caption}” has no preset by the name a phone asked for; it was renamed or deleted since the phone drew it.`);
      }
      return call({ command: PRESET_RECALL_COMMAND, input: { nodeId: node.id, name: value } });
    }
    case "layer": {
      if (key === "on") {
        const live = pressOnly("its switch");
        if (live !== null) return live;
        if (typeof value !== "boolean") return no(`A phone sent “${caption}” something that is not true or false.`);
        return { ok: true, action: "layerOn", nodeId: node.id, caption, on: value };
      }
      const opacity = layerOpacity(node);
      if (!opacity.writable) return no(`“${caption}” has its opacity driven by the document, so a phone cannot move it.`);
      if (typeof value !== "number" || !Number.isFinite(value)) return no(`A phone sent “${caption}” something that is not a finite number.`);
      return { ok: true, action: "parameters", nodeId: node.id, kind, entries: { opacity: clamp(value, opacity.range) }, phase: set.phase };
    }
    case "cueList": {
      const live = pressOnly(key === "standby" ? "a standby" : key === "go" ? "a GO" : "a BACK");
      if (live !== null) return live;
      // T1508b: `cue.timeline`'s reason, said before anything is asked of the bus.
      if (followsTimeline(node)) return no(`“${caption}” follows the timeline; move the playhead. A phone cannot fire its cues.`);
      if (key === "standby") {
        const { list } = cueState(node);
        if (typeof value !== "string" || list === null || !list.cues.some((cue) => cue.name === value)) {
          return no(`“${caption}” has no cue by the name a phone asked for; it was renamed or deleted since the phone drew it.`);
        }
        return call({ command: CUE_SET_STANDBY_COMMAND, input: { nodeId: node.id, cue: value } });
      }
      if (value !== true) return no(`A phone sent “${caption}” a press that is not a press.`);
      return call({ command: key === "go" ? CUE_GO_COMMAND : CUE_BACK_COMMAND, input: { nodeId: node.id } });
    }
  }
}

function namedOnRemotePanel(graph: GraphDocument, widget: GraphNode): boolean {
  return Object.values(graph.nodes).some(
    (node) => isRemotePanel(node) && panelMembers(graph, node).some((member) => member.id === widget.id),
  );
}
