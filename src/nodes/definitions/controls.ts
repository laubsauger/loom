import type { CompiledNodeDescription, MigrationResult, NodeDefinition } from "../../domain/types/node-definition.ts";
import type { GraphDocument, GraphNode } from "../../domain/types/graph.ts";
import type { NodeId } from "../../domain/types/ids.ts";
import type { ParameterDefinition, ParameterSchema, StoredParameter } from "../../domain/types/parameters.ts";
import { incomingEdgesInOrder } from "../../domain/graph/edge-order.ts";
import { overridingWire, sourceReferencesOf } from "../../domain/graph/source-references.ts";
import { isParameterSlot, staticBindingValue, storedStaticValue } from "../../domain/parameters/slots.ts";
import { PRESETS_NODE_TYPE, parsePresetBank } from "../../domain/presets/bank.ts";
import { bankViewOf, type BankCatalogue } from "../../domain/presets/bank-view.ts";
import { isComponentNodeType, parseComponentNodeType } from "../../domain/components/component-type.ts";
import { kindFromName, kindOfType, roleOrName } from "../../domain/graph/node-kinds.ts";
import { CUE_LIST_NODE_TYPE } from "../../domain/presets/cue-list.ts";
import { VALUE_PORT } from "./common-ports.ts";

const noPasses = (): CompiledNodeDescription => ({ passes: [] });

/**
 * T1388b — LIVE CONTROLS: widget nodes and the Panel that lays them out (TouchDesigner's
 * Slider / Button COMPs and their container, in this app's node idiom).
 *
 * A widget is a VALUE node whose value is set by hand: its channel carries what the control
 * shows, under a name the user picks (`heat`, `glitch`), so any parameter anywhere reads it
 * the way it reads any channel — `op('slider1').chan.heat` — and one control can drive many
 * things. The node's own body on the canvas IS the control (`control-widget.tsx`), and a
 * Panel gathers the widgets wired into it into a performance surface — drawn on its own
 * body, bigger in the Controls tab, and on a phone when published (T1512b, `panelLayout`).
 *
 * Headless like every definition (§V11): the value lives in parameters; the UI writes them
 * through the command bus, one undo group per gesture (`createParameterEditor`).
 */

const str = (value: unknown, fallback: string): string => (typeof value === "string" && value !== "" ? value : fallback);
const num = (value: unknown, fallback: number): number => (typeof value === "number" && Number.isFinite(value) ? value : fallback);

/** A channel name must be an identifier, or nothing downstream can address it. */
export function controlChannel(values: Readonly<Record<string, unknown>>): string {
  const name = str(values["channel"], "value");
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : "value";
}

const channelParameter = {
  type: "string" as const,
  label: "Channel",
  default: "value",
  description: "The name this control publishes under — what a parameter reads: op('<node>').chan.<channel>.",
};
const captionParameter = {
  type: "string" as const,
  label: "Caption",
  default: "",
  description: "What the control says on a panel. Empty: the channel name.",
};

/* ------------------------------------------------------------ defaults (T1619b) */

/**
 * T1619b — A CONTROL'S DEFAULT: where Reset sends it (`docs/control-reset-design-2026-10-06.md`).
 *
 * Each key a hand moves has a key beside it that holds its default, an ordinary parameter:
 * the inspector edits it, and undo, the audit, copy and paste and a save carry it with
 * nothing built. A Button has none, because nothing of it is set by hand and left.
 *
 * `control.setDefault` copies the current value into it, and a control made on the bus is
 * born with it (`bornAtDefault`). One that stores none has NO default (`controlDefaults`).
 * A preset never stores or recalls it (`presetHolds` below), so recalling a look cannot
 * change what Reset means.
 *
 * One table, read by the definitions' `parametersFor` and `migrate`, by the two commands
 * (`domain/commands/control-default-commands.ts`) and by the preset capture.
 */
export const CONTROL_DEFAULT_KEYS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  slider: { value: "defaultValue" },
  toggle: { on: "defaultOn" },
  xyPad: { x: "defaultX", y: "defaultY" },
};

/**
 * B261 — WHAT OF A CONTROL IS STATE: the keys a hand (or a recall) moves. The rest is
 * AUTHORING: the name it publishes under, its caption, its range, its step, its default.
 *
 * A preset whose target is a whole control used to hold every key, so recalling a look
 * put back the range and the caption its author had since changed. It holds the state
 * keys now. A target that names one key (`slider_heat.max`) still stores that key: the
 * author asked for it by name. A default key is the exception, never stored and never
 * recalled, named or not.
 */
export const CONTROL_STATE_KEYS: Readonly<Record<string, readonly string[]>> = {
  slider: ["value"],
  toggle: ["on"],
  button: ["held", "presses"],
  xyPad: ["x", "y"],
};

/** Does a preset hold this key of this node type? `whole`: the target names the node, not the key. */
export function presetHolds(type: string, key: string, whole: boolean): boolean {
  if (Object.values(CONTROL_DEFAULT_KEYS[type] ?? {}).includes(key)) return false;
  const state = CONTROL_STATE_KEYS[type];
  return !whole || state === undefined || state.includes(key);
}

/** What a Slider and each axis of an XY Pad read while nothing is stored for them. */
const UNSET_NUMBER = 0.5;

/** What each value key of a control reads while nothing is stored for it: the type's own declared value. */
const DECLARED_VALUES: Readonly<Record<string, Readonly<Record<string, number | boolean>>>> = {
  slider: { value: UNSET_NUMBER },
  toggle: { on: false },
  xyPad: { x: UNSET_NUMBER, y: UNSET_NUMBER },
};

/**
 * A stored bound of a control's range: the number the document states, `declared` when
 * nothing is stored, and null when an expression drives it (its value is not known here).
 */
function storedBound(stored: unknown, declared: number): number | null {
  if (stored === undefined) return declared;
  const value = plainValue(stored as StoredParameter);
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** A number as the control's channel carries it: inside Min..Max (`valueEvaluate`'s own rule). A range an expression drives does not clamp. */
function clampToRange(stored: Readonly<Record<string, unknown>>, value: number): number {
  const lo = storedBound(stored["min"], 0);
  const hi = storedBound(stored["max"], 1);
  if (lo === null || hi === null) return value;
  return Math.min(Math.max(lo, hi), Math.max(Math.min(lo, hi), value));
}

/**
 * THE DEFAULT OF EACH VALUE KEY that HOLDS one, from a control's stored parameters; null for
 * a node type that holds none (a Button, a Panel, anything else).
 *
 * A KEY WITH NO STORED DEFAULT HAS NO DEFAULT (the lead's ruling, 2026-10-06, T1619b S2).
 * It is absent here, never the type's 0.5: a control whose source authored no default
 * would otherwise reset to a number nobody chose, silently. `control.setDefault` gives it
 * one; a control made on the bus is born with one (`bornAtDefault`); the version 1 → 2
 * `migrate` gives every older control the value in its file. A default an expression
 * drives is not a stored default either.
 *
 * A number is read clamped into Min..Max and NOT snapped to Step: a reset restores what
 * the author wrote (T652).
 */
export function controlDefaults(type: string, stored: Readonly<Record<string, unknown>>): Readonly<Record<string, number | boolean>> | null {
  const keys = CONTROL_DEFAULT_KEYS[type];
  if (keys === undefined) return null;
  const defaults: Record<string, number | boolean> = {};
  for (const valueKey in keys) {
    const held = plainValue(stored[keys[valueKey] as string] as StoredParameter | undefined);
    if (type === "toggle") {
      if (typeof held === "boolean") defaults[valueKey] = held;
    } else if (typeof held === "number" && Number.isFinite(held)) {
      defaults[valueKey] = clampToRange(stored, held);
    }
  }
  return defaults;
}

/** How far a number may sit from its default and still be AT it, as a share of the range: float noise, nothing a hand can see. */
const AT_DEFAULT_SHARE = 1 / 10_000;

export interface ControlDefaultState {
  /** Value key → the default it resets to. A key that holds none is absent. */
  readonly defaults: Readonly<Record<string, number | boolean>>;
  /** Value key → what it holds now, as the channel carries it. A driven key is absent. */
  readonly current: Readonly<Record<string, number | boolean>>;
  /** The value keys that are AWAY from their default. A driven key is never one, nor one with no default. */
  readonly away: readonly string[];
  /** The value keys the document drives (an expression, a MIDI learn): not a hand's to move. */
  readonly driven: readonly string[];
  /** The hand-set value keys that hold NO default: neither at one nor away from one. */
  readonly missing: readonly string[];
}

/**
 * WHERE A CONTROL STANDS AGAINST ITS DEFAULT, or null for a node that holds none. The one
 * answer behind `control.reset`, `control.setDefault` and every surface that marks a
 * control as moved, so no two of them can disagree about "away".
 */
export function controlDefaultState(node: Pick<GraphNode, "type" | "parameters">): ControlDefaultState | null {
  const defaults = controlDefaults(node.type, node.parameters);
  const declared = DECLARED_VALUES[node.type];
  if (defaults === null || declared === undefined) return null;
  const lo = storedBound(node.parameters["min"], 0);
  const hi = storedBound(node.parameters["max"], 1);
  const slack = lo === null || hi === null ? 0 : Math.abs(hi - lo) * AT_DEFAULT_SHARE;
  const current: Record<string, number | boolean> = {};
  const away: string[] = [];
  const driven: string[] = [];
  const missing: string[] = [];
  for (const [key, unset] of Object.entries(declared)) {
    const stored = node.parameters[key];
    if (isParameterSlot(stored) && stored.mode !== "static") {
      driven.push(key);
      continue;
    }
    // Nothing stored reads as the schema default: this key's own default when it holds
    // one (`parametersFor`), the type's declared value when it does not.
    const held = plainValue(stored);
    const fallback = defaults[key] ?? unset;
    const now = typeof unset === "boolean" ? (typeof held === "boolean" ? held : fallback) : typeof held === "number" && Number.isFinite(held) ? clampToRange(node.parameters, held) : fallback;
    current[key] = now;
    const target = defaults[key];
    if (target === undefined) missing.push(key);
    else if (typeof now === "number" && typeof target === "number" ? Math.abs(now - target) > slack : now !== target) away.push(key);
  }
  return { defaults, current, away, driven, missing };
}

/**
 * A control's schema with its value keys' defaults set to the node's OWN stored defaults,
 * so "Reset to default" on its Value, the menu's `isOverridden` and every other reader of
 * a schema default mean the default Reset uses. Before this a Slider reset to 0.5 whatever
 * its range (§T1184's pattern). A key that holds no default keeps the declared one, and
 * the declared schema is returned itself while every default is the declared one. One
 * schema is kept per distinct default: schemas are read per frame, and their identity is
 * what memoised readers key on.
 */
function schemaWithDefaults(type: string, declared: ParameterSchema, kept: Map<string, ParameterSchema>, stored: Readonly<Record<string, unknown>>): ParameterSchema {
  const defaults = controlDefaults(type, stored) ?? {};
  let asDeclared = true;
  let signature = "";
  for (const key in defaults) {
    if ((declared[key] as { default?: unknown } | undefined)?.default !== defaults[key]) asDeclared = false;
    signature += `${key}=${String(defaults[key])} `;
  }
  if (asDeclared) return declared;
  const found = kept.get(signature);
  if (found !== undefined) return found;
  const schema: ParameterSchema = { ...declared };
  for (const key in defaults) schema[key] = { ...declared[key], default: defaults[key] } as ParameterDefinition;
  // Bounded: a default an agent sweeps must not grow this for the life of the page.
  if (kept.size >= 256) kept.clear();
  kept.set(signature, schema);
  return schema;
}

/**
 * Version 1 → 2 (§V10): a control saved before it held a default takes the value in the
 * file as its default, so "what was saved" is what Reset returns to from the first open.
 * A value an expression drives gives its retained hand-set value. A value the file never
 * stored gives the declared one, which is what that control showed. Only a driven value
 * with nothing retained under it is left without a default.
 */
function migrateControlDefaults(type: string, oldVersion: number, data: unknown): MigrationResult {
  const parameters: Record<string, unknown> = typeof data === "object" && data !== null ? { ...(data as Record<string, unknown>) } : {};
  if (oldVersion >= 2) return { parameters };
  for (const [defaultKey, value] of Object.entries(defaultsFromValues(type, parameters))) {
    if (parameters[defaultKey] === undefined) parameters[defaultKey] = value;
  }
  return { parameters };
}

/**
 * Each default key of a control, holding the value its value key holds in `parameters`: the
 * hand-set value (under an expression, the one retained), or the declared one when nothing
 * is stored. A key with no such value is left out. The one rule behind the `migrate` above
 * and `bornWith` below.
 */
function defaultsFromValues(type: string, parameters: Readonly<Record<string, unknown>>): Record<string, number | boolean> {
  const defaults: Record<string, number | boolean> = {};
  for (const [valueKey, defaultKey] of Object.entries(CONTROL_DEFAULT_KEYS[type] ?? {})) {
    const stored = parameters[valueKey] as StoredParameter | undefined;
    const value = stored === undefined ? DECLARED_VALUES[type]?.[valueKey] : storedStaticValue(stored);
    if (type === "toggle" ? typeof value === "boolean" : typeof value === "number" && Number.isFinite(value)) defaults[defaultKey] = value as number | boolean;
  }
  return defaults;
}

/**
 * A CONTROL IS BORN AT ITS DEFAULT (`NodeDefinition.bornWith`): made on the bus — from the
 * library, by a paste, by an agent, from a parameter — the default it stores is the value
 * it is made with. Without this the manifest's 0.5 would be stored for a Slider created at
 * 7, and Reset would send it to a number nobody chose. A control that never went through
 * the bus (a document source that authored none) stores no default, and has none.
 */
const bornAtDefault =
  (type: string) =>
  (provided: Readonly<Record<string, StoredParameter>>): Record<string, StoredParameter> =>
    defaultsFromValues(type, provided);

const defaultDescription = (what: string): string =>
  `Where Reset sends ${what}. A control has no default until one is stored here: Set as default stores its current value. A preset never stores or recalls it.`;

const SLIDER_PARAMETERS: ParameterSchema = {
  channel: channelParameter,
  caption: captionParameter,
  value: { type: "number", label: "Value", default: UNSET_NUMBER },
  min: { type: "number", label: "Min", default: 0 },
  max: { type: "number", label: "Max", default: 1 },
  step: { type: "number", label: "Step", default: 0, min: 0, range: "floor", description: "0 is continuous; above 0 the slider snaps to multiples of it." },
  defaultValue: { type: "number", label: "Default", default: UNSET_NUMBER, description: defaultDescription("the slider") },
};
const SLIDER_SCHEMAS = new Map<string, ParameterSchema>();

export const controlSliderNode: NodeDefinition = {
  type: "slider",
  // 2 (T1619b): it holds its default. `migrate` gives an older file's slider its stored value as one.
  version: 2,
  title: "Slider",
  category: "value",
  description:
    "A hand-set number between Min and Max, published under its Channel name. Drag it on the canvas or on a Panel; map it to any parameter. CLOCKLESS: it changes only when someone moves it.",
  tags: ["control", "slider", "fader", "knob", "ui", "panel", "live", "perform"],
  inputs: [],
  outputs: [{ id: "out", label: "Out", type: VALUE_PORT }],
  parameters: SLIDER_PARAMETERS,
  parametersFor: (stored) => schemaWithDefaults("slider", SLIDER_PARAMETERS, SLIDER_SCHEMAS, stored),
  migrate: (oldVersion, data) => migrateControlDefaults("slider", oldVersion, data),
  bornWith: bornAtDefault("slider"),
  valueEvaluate: ({ values }) => {
    const lo = num(values["min"], 0);
    const hi = num(values["max"], 1);
    const v = num(values["value"], 0.5);
    return { [controlChannel(values)]: Math.min(Math.max(lo, hi), Math.max(Math.min(lo, hi), v)) };
  },
  compile: noPasses,
};

const TOGGLE_PARAMETERS: ParameterSchema = {
  channel: channelParameter,
  caption: captionParameter,
  on: { type: "boolean", label: "On", default: false },
  defaultOn: { type: "boolean", label: "Default", default: false, description: defaultDescription("the toggle") },
};
const TOGGLE_SCHEMAS = new Map<string, ParameterSchema>();

export const controlToggleNode: NodeDefinition = {
  type: "toggle",
  // 2 (T1619b): it holds its default, as the Slider does.
  version: 2,
  title: "Toggle",
  category: "value",
  description: "On or off, published under its Channel name as 1 or 0. CLOCKLESS.",
  tags: ["control", "toggle", "switch", "checkbox", "ui", "panel", "live", "perform"],
  inputs: [],
  outputs: [{ id: "out", label: "Out", type: VALUE_PORT }],
  parameters: TOGGLE_PARAMETERS,
  parametersFor: (stored) => schemaWithDefaults("toggle", TOGGLE_PARAMETERS, TOGGLE_SCHEMAS, stored),
  migrate: (oldVersion, data) => migrateControlDefaults("toggle", oldVersion, data),
  bornWith: bornAtDefault("toggle"),
  valueEvaluate: ({ values }) => ({ [controlChannel(values)]: values["on"] === true ? 1 : 0 }),
  compile: noPasses,
};

export const controlButtonNode: NodeDefinition = {
  type: "button",
  version: 1,
  title: "Button",
  category: "value",
  description:
    "A momentary button: its Channel is 1 while held, and <channel>Count counts the presses (a Count or Expression downstream can fire on a change). CLOCKLESS.",
  tags: ["control", "button", "trigger", "momentary", "bang", "ui", "panel", "live", "perform"],
  inputs: [],
  outputs: [{ id: "out", label: "Out", type: VALUE_PORT }],
  parameters: {
    channel: channelParameter,
    caption: captionParameter,
    held: { type: "boolean", label: "Held", default: false, description: "Set while the button is pressed." },
    presses: { type: "number", label: "Presses", default: 0, min: 0, range: "floor", step: 1 },
  },
  valueEvaluate: ({ values }) => {
    const name = controlChannel(values);
    return { [name]: values["held"] === true ? 1 : 0, [`${name}Count`]: num(values["presses"], 0) };
  },
  compile: noPasses,
};

const XY_PARAMETERS: ParameterSchema = {
  channel: channelParameter,
  caption: captionParameter,
  x: { type: "number", label: "X", default: UNSET_NUMBER },
  y: { type: "number", label: "Y", default: UNSET_NUMBER },
  min: { type: "number", label: "Min", default: 0 },
  max: { type: "number", label: "Max", default: 1 },
  defaultX: { type: "number", label: "Default X", default: UNSET_NUMBER, description: defaultDescription("the pad's X") },
  defaultY: { type: "number", label: "Default Y", default: UNSET_NUMBER, description: defaultDescription("the pad's Y") },
};
const XY_SCHEMAS = new Map<string, ParameterSchema>();

export const controlXYNode: NodeDefinition = {
  type: "xyPad",
  // 2 (T1619b): it holds its default, as the Slider does.
  version: 2,
  title: "XY Pad",
  category: "value",
  description: "Two numbers from one drag, published as <channel>X and <channel>Y, each between Min and Max. CLOCKLESS.",
  tags: ["control", "xy", "pad", "2d", "ui", "panel", "live", "perform"],
  inputs: [],
  outputs: [{ id: "out", label: "Out", type: VALUE_PORT }],
  parameters: XY_PARAMETERS,
  parametersFor: (stored) => schemaWithDefaults("xyPad", XY_PARAMETERS, XY_SCHEMAS, stored),
  migrate: (oldVersion, data) => migrateControlDefaults("xyPad", oldVersion, data),
  bornWith: bornAtDefault("xyPad"),
  valueEvaluate: ({ values }) => {
    const name = controlChannel(values);
    const lo = num(values["min"], 0);
    const hi = num(values["max"], 1);
    const clamp = (v: number): number => Math.min(Math.max(lo, hi), Math.max(Math.min(lo, hi), v));
    return { [`${name}X`]: clamp(num(values["x"], 0.5)), [`${name}Y`]: clamp(num(values["y"], 0.5)) };
  },
  compile: noPasses,
};

/** One row of a Panel's layout: a heading, a line of text, or widgets side by side. */
export type PanelRow =
  | { readonly kind: "heading"; readonly text: string }
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "widgets"; readonly names: readonly string[] };

/**
 * A Panel's layout, one row per line: `# Heading`, `> a line of text`, or widget node names
 * separated by spaces or commas (shown side by side). Blank lines are spacing, dropped.
 */
export function parsePanelLayout(layout: string): PanelRow[] {
  return layout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .map((line): PanelRow => {
      if (line.startsWith("#")) return { kind: "heading", text: line.replace(/^#+\s*/, "") };
      if (line.startsWith(">")) return { kind: "text", text: line.replace(/^>\s*/, "") };
      return { kind: "widgets", names: line.split(/[\s,]+/).filter((name) => name !== "") };
    });
}

/**
 * T1512b — the Panel's one input: every widget wired in joins it, in wiring order. A
 * VARIADIC value port (§V131) rather than a new "many wires into one socket" idea: the
 * edge `order` the patch layer already keeps dense is the order on the Panel, and
 * `reorderEdges` is how the Panel rearranges its members — one patch, undoable.
 */
export const PANEL_INPUT = "controls";

/**
 * T1518b — a variadic input drawn as ONE socket that takes every wire, instead of one
 * socket per wire plus a spare (T695). The Panel's `controls` only: its members are
 * arranged on the board, not by socket, so N labelled rows were a tower taller than the
 * board with nothing to aim at. The stored edges and their `order` (§V131) are unchanged —
 * a wire dropped on the one socket appends — so this is a rule about DRAWING, read by the
 * node view, the edge projection and the layout model (`node-box.ts`) alike.
 */
export function isOneSocketInput(nodeType: string, portId: string): boolean {
  return nodeType === "panel" && portId === PANEL_INPUT;
}

/** The layout text a fresh Panel carried before T1512b: a heading and no controls — never an override. */
const LEGACY_DEFAULT_LAYOUT = "# Controls";

export const controlPanelNode: NodeDefinition = {
  type: "panel",
  version: 1,
  title: "Panel",
  category: "value",
  description:
    "A performance surface: wire Slider, Toggle, Button and XY Pad nodes into Controls (or drop one on the Panel) and they show on the Panel's body, in the Controls tab and, with Phone on, on a phone — on a board you arrange with the pencil on the Panel or in the Controls tab. Drop a Presets bank, a Layer or a Cue List on the Panel and it joins the board too: a button per preset, the layer's switch and fader, GO and BACK.",
  tags: ["control", "panel", "ui", "surface", "perform", "live", "dashboard"],
  inputs: [{ id: PANEL_INPUT, label: "Controls", type: VALUE_PORT, optional: true, variadic: true }],
  outputs: [],
  parameters: {
    title: { type: "string", label: "Title", default: "Controls" },
    // T1512b: an ADVANCED override, collapsed in the inspector. Empty = the wiring decides.
    layout: {
      type: "string",
      label: "Layout",
      group: "Advanced",
      default: "",
      multiline: true,
      description:
        "Optional: replaces the wiring order. One row per line: `# Heading`, `> a note`, or widget node names side by side.",
    },
    // T1396b: the phone door publishes a Panel only when this is on. Absent in a document
    // saved before it existed = off, which is what the default says, so no migration.
    remote: {
      type: "boolean",
      label: "Phone",
      default: false,
      description:
        "Publishes this panel to the phone door: a phone paired from the Panel's phone icon sees these controls and can move them, and nothing else in the project.",
    },
    // T1516b: the free board — where each control sits, in grid cells. Written by the
    // board's edit mode (the pencil, on the Panel node and in the Controls tab; T1518b), one patch per gesture; JSON like the preset bank, and last
    // in the manifest because it is code (T1052).
    board: {
      type: "code",
      language: "json",
      label: "Board",
      group: "Advanced",
      default: "",
      description:
        "Where each control sits on the Panel, in square grid cells — written by the pencil on the Panel or in the Controls tab. Empty: every control flows into the first free spot.",
    },
  },
  compile: noPasses,
};

export const controlNodeDefinitions: readonly NodeDefinition[] = [
  controlSliderNode,
  controlToggleNode,
  controlButtonNode,
  controlXYNode,
  controlPanelNode,
];

/** Widget types a Panel lays out. */
export const CONTROL_WIDGET_TYPES: ReadonlySet<string> = new Set(["slider", "toggle", "button", "xyPad"]);

/** The Layer node's type (`layer.ts`), named here for the board and the surfaces that draw it. */
export const LAYER_NODE_TYPE = "layer";

/**
 * T1501b — THE NODES A BOARD SHOWS BY NAME, WITH NO WIRE: a Presets bank (a button per
 * preset), a Layer (its switch and fader) and a Cue List (GO / BACK). None of them can be
 * wired into the Panel's value input — a bank and a cue list have no ports, and a layer's
 * output is a picture — so they join by a board item that NAMES them (`{member:<name>}`),
 * written when one is dropped on the Panel or its "+ panel" is pressed (`panel-join.ts`).
 */
export const BOARD_NAMED_TYPES: ReadonlySet<string> = new Set([PRESETS_NODE_TYPE, LAYER_NODE_TYPE, CUE_LIST_NODE_TYPE]);

/**
 * T1505b — A BOARD ITEM THAT NAMES THIS NODE IS KEPT: one of `BOARD_NAMED_TYPES`, or a
 * component instance — a look whose component holds a page bank IS a bank from outside, and
 * `preset.moveIntoComponent` points the Panel items that named the bank beside it at the
 * instance. Graph-only, so the board cannot know here whether the look holds presets: what
 * is DRAWN at the item is the surface's business (the desk's strip, the phone's snapshot),
 * each reading the bank through `bankOf`; an instance with none draws nothing there.
 */
export function boardNamesMember(node: GraphNode): boolean {
  // T1771b: any node a board names is kept, because any node can be its on/off switch
  // (`switchesOnBoard`). A widget is a member by its wire, and a Panel is not put on a Panel.
  return !CONTROL_WIDGET_TYPES.has(node.type) && node.type !== "panel";
}

/**
 * T1541b — CAN THIS NODE JOIN A BOARD BY NAME: one of `BOARD_NAMED_TYPES`, or a look's
 * INSTANCE — a component instance whose component holds a page bank, which is a bank from
 * outside (§T1505b). Only the catalogue can say the second (`bankViewOf`), so with none an
 * instance joins nothing, and an instance of a component with no page bank never does: an
 * item naming it would draw nothing. `boardNamesMember` above is the KEEP rule, and stays
 * graph-only on purpose.
 */
export function joinsBoardByName(node: GraphNode, catalogue: BankCatalogue | undefined): boolean {
  if (BOARD_NAMED_TYPES.has(node.type)) return true;
  return isComponentNodeType(node.type) && bankViewOf(node, catalogue)?.kind === "instance";
}

/**
 * T1771b — THIS NODE ON A BOARD IS ITS ON/OFF SWITCH: any node that is not already something
 * else there (a widget, a Panel, a bank, a Layer, a cue list, a look's instance, which is its
 * bank's strip). The switch is the Layer's own (`setNodeUi { bypassed }`, a state and never
 * a flip): an effect passes its input, a source is silent, a component instance that is off
 * is not inlined and costs nothing (§T1770b). One node, one flag, the surface is the same.
 *
 * It joins by name like a Layer, but only where the owner points at a Panel: a drop on it,
 * or its board's "+ Add…". It is NOT offered the node's own "+ panel" button (`soloPanelFor`),
 * which would put that button on every node of a document that holds one Panel.
 *
 * Whether an instance is a look only the catalogue can say, so with none no instance is a
 * switch: it draws nothing rather than the wrong thing.
 */
export function switchesOnBoard(node: GraphNode, catalogue: BankCatalogue | undefined): boolean {
  if (!boardNamesMember(node) || BOARD_NAMED_TYPES.has(node.type)) return false;
  if (!isComponentNodeType(node.type)) return true;
  return catalogue !== undefined && bankViewOf(node, catalogue)?.kind !== "instance";
}

/* ------------------------------------------------------------ membership */

/** A stored parameter's plain value: a static-mode slot is its static binding, a driven one is nothing. */
function plainValue(stored: StoredParameter | undefined): unknown {
  if (!isParameterSlot(stored)) return stored;
  return stored.mode === "static" ? staticBindingValue(stored) : undefined;
}

/**
 * A node's NAME: its label, or its id. This is the IDENTITY a board stores a member under,
 * a preset target names and `op('…')` reads. What a surface SHOWS for a bank, a Layer, a
 * Cue List or a Panel is `surfaceNameOf` below, which is not always the same string.
 */
export const controlNameOf = (node: GraphNode): string => node.label ?? node.id;

/**
 * What a Presets bank, a Layer, a Cue List or a Panel is CALLED on a surface with room for
 * one word: the ROLE of its name (T1593b, ruled 2026-10-05).
 *
 * A name is `kind_role`, so on stage a bank would read `presets_looks`, a layer
 * `layer_graphic`, a cue list `cuelist_set`. The board already DRAWS each as what it is (a
 * strip of presets, a switch and a fader, GO and BACK), so the kind in front is the same
 * fact a second time, in the one place where every character is read from across a room.
 * The board shows `looks`, `graphic`, `set`.
 *
 * ONE RULE FOR EVERY SUCH SURFACE (the desk's board, the Controls tab, the phone, the
 * Layers list), so they cannot caption one node two ways: `roleOrName`. A name with no
 * role (`presets1`) and a name that does not carry its kind (`looks`, anything saved
 * before the rule) are shown whole. Nothing is cut from a name the rule did not make.
 *
 * `catalogue` is for the one member that is not a built-in node: a look's INSTANCE, which
 * is a bank from outside (§T1505b). Its kind is its component's own name, which only the
 * catalogue knows; without one its name is shown whole rather than guessed at.
 *
 * It is a CAPTION and never an address. A board stores its members under `controlNameOf`,
 * and a phone's write names a node by id.
 */
export function surfaceNameOf(
  node: GraphNode,
  catalogue?: { get(componentId: string, version: number): { readonly name: string } | undefined },
): string {
  const name = controlNameOf(node);
  const instance = parseComponentNodeType(node.type);
  if (instance === null) return roleOrName(name, kindOfType(node.type));
  const component = catalogue?.get(instance.componentId, instance.version);
  return component === undefined ? name : roleOrName(name, kindFromName(component.name));
}

/** What a wired picture is called on a Layer's item: the wire wins over the name (§B233). */
const WIRED_PICTURE = "wired";

/**
 * T1527b — WHAT A LAYER SHOWS, for its board item on the desk and on the phone: the name in
 * its Picture parameter, or "wired" when a wire feeds the picture — by B233's rule, read
 * through the same function the compiler reads (`overridingWire`), so no surface names a
 * picture the wire has made dormant. Empty when it shows nothing.
 */
export function layerPicture(graph: Pick<GraphDocument, "nodes" | "edges">, nodeId: NodeId): string {
  const node = graph.nodes[nodeId];
  const spec = sourceReferencesOf(LAYER_NODE_TYPE).find((each) => each.parameter === "picture");
  if (node === undefined || spec === undefined) return "";
  if (overridingWire(spec, nodeId, graph.edges) !== undefined) return WIRED_PICTURE;
  const stored = plainValue(node.parameters["picture"]);
  return typeof stored === "string" ? stored.trim() : "";
}

/**
 * A Panel's title as every surface shows it: its Title, or the role of the node's name
 * (`desk` for `panel_desk`, T1593b; `surfaceNameOf`).
 */
export function panelTitle(panel: GraphNode): string {
  const title = plainValue(panel.parameters["title"]);
  return typeof title === "string" && title !== "" ? title : surfaceNameOf(panel);
}

/**
 * The layout text when it OVERRIDES the wiring, else null. Empty and the pre-T1512b default
 * (a lone `# Controls` heading) are not overrides — a fresh Panel follows its wires — and a
 * driven layout is not one either: an expression does not lay a Panel out.
 */
export function panelLayoutOverride(panel: GraphNode): string | null {
  const layout = plainValue(panel.parameters["layout"]);
  if (typeof layout !== "string") return null;
  const trimmed = layout.trim();
  return trimmed === "" || trimmed === LEGACY_DEFAULT_LAYOUT ? null : layout;
}

/** One place on a Panel row: a widget node, or an override name with no widget behind it. */
export type PanelCell =
  | { readonly kind: "widget"; readonly node: GraphNode }
  | { readonly kind: "missing"; readonly name: string };

/** A Panel row, resolved against the document. */
export type PanelSection =
  | { readonly kind: "heading" | "text"; readonly text: string }
  | { readonly kind: "widgets"; readonly cells: readonly PanelCell[] };

export interface PanelLayout {
  /** `wiring`: the widgets wired into Controls; `layout`: the override text decides. */
  readonly source: "wiring" | "layout";
  readonly rows: readonly PanelSection[];
}

/**
 * T1512b — WHAT A PANEL SHOWS, AND IN WHAT ORDER: the ONE derivation behind the Panel's
 * canvas body, the Controls tab and the phone snapshot (`phone-snapshot.ts`), so the three
 * cannot disagree about a Panel's members or their order.
 *
 * With no override the members are the widget nodes wired into `controls`, in edge order
 * (`incomingEdgesInOrder`, §V68/§V131), as one row the surface flows; a non-widget source
 * and a second wire from the same widget add nothing. With an override the text wins,
 * exactly as it read before T1512b — names resolve by `label ?? id` against this graph —
 * so a document laid out by text shows what it showed, with no migration.
 */
export function panelLayout(graph: Pick<GraphDocument, "nodes" | "edges">, panel: GraphNode): PanelLayout {
  const override = panelLayoutOverride(panel);
  if (override === null) {
    const seen = new Set<string>();
    const cells: PanelCell[] = [];
    for (const edge of incomingEdgesInOrder(graph, panel.id, PANEL_INPUT)) {
      const node = graph.nodes[edge.source.nodeId];
      if (node === undefined || !CONTROL_WIDGET_TYPES.has(node.type) || seen.has(node.id)) continue;
      seen.add(node.id);
      cells.push({ kind: "widget", node });
    }
    return { source: "wiring", rows: cells.length === 0 ? [] : [{ kind: "widgets", cells }] };
  }
  const byName = new Map(
    Object.values(graph.nodes)
      .filter((node) => CONTROL_WIDGET_TYPES.has(node.type))
      .map((node) => [controlNameOf(node), node]),
  );
  return {
    source: "layout",
    rows: parsePanelLayout(override).map((row): PanelSection => {
      if (row.kind !== "widgets") return row;
      return {
        kind: "widgets",
        cells: row.names.map((name): PanelCell => {
          const node = byName.get(name);
          return node === undefined ? { kind: "missing", name } : { kind: "widget", node };
        }),
      };
    }),
  };
}

/** The widget nodes on a Panel, in the order it shows them. */
export function panelMembers(graph: Pick<GraphDocument, "nodes" | "edges">, panel: GraphNode): GraphNode[] {
  return panelLayout(graph, panel).rows.flatMap((row) =>
    row.kind === "widgets" ? row.cells.flatMap((cell) => (cell.kind === "widget" ? [cell.node] : [])) : [],
  );
}

/* ------------------------------------------------------------------ the board */

/**
 * T1516b — A RECTANGLE ON A PANEL BOARD, in whole square cells; (0, 0) is the top-left cell.
 * The same shape as the phone contract's `BoardRect` (`phone-protocol.ts`), declared here
 * because a node definition imports nothing from the device layer.
 */
export interface BoardRect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/**
 * One stored board item: a widget the Panel shows, by NAME (`label ?? id`, the way the
 * layout override names them), or a free text label. Names rather than node ids because a
 * name is this app's reference currency (§V129): the rename clause (`names.ts`, kind 6)
 * carries it through a rename AND through a paste, which mints new ids but keeps — or
 * renumbers through that same clause — the names (§V320).
 *
 * T1501b: for a widget the item only PLACES a member the wiring made; for a bank, a layer
 * or a cue list (`BOARD_NAMED_TYPES`) the item IS the membership — there is no wire.
 */
export type StoredBoardItem =
  | { readonly member: string; readonly rect: BoardRect }
  | { readonly label: string; readonly rect: BoardRect };

/** What the Panel's `board` parameter holds, parsed. */
export interface StoredBoard {
  readonly columns: number;
  readonly items: readonly StoredBoardItem[];
}

/** A fresh board is eight cells wide (owner, T1516b). */
export const BOARD_DEFAULT_COLUMNS = 8;
/** The widest board the column field accepts. */
export const BOARD_MAX_COLUMNS = 24;

/** A size in whole cells. */
export interface CellSize {
  readonly w: number;
  readonly h: number;
}

/** The size a control takes when it first lands on a board (owner, T1516b). */
const DEFAULT_SIZE: Readonly<Record<string, CellSize>> = {
  slider: { w: 4, h: 1 },
  toggle: { w: 2, h: 1 },
  button: { w: 2, h: 1 },
  xyPad: { w: 3, h: 3 },
  // T1501b: a strip of preset buttons, a layer's switch, GO over BACK and the cue names.
  [PRESETS_NODE_TYPE]: { w: 4, h: 1 },
  [LAYER_NODE_TYPE]: { w: 2, h: 1 },
  [CUE_LIST_NODE_TYPE]: { w: 4, h: 2 },
};

/** The default size of an item of this widget type, or of a label (`null`). */
export function boardDefaultSize(type: string | null): CellSize {
  return (type === null ? undefined : DEFAULT_SIZE[type]) ?? { w: 2, h: 1 };
}

/** How many preset buttons a bank's strip puts on one board row at its default width. */
export const PRESETS_PER_BOARD_ROW = 4;

/**
 * T1501b — the size THIS node takes when it joins a board: its type's default, except that
 * a bank grows a row for every four presets it already holds, so a bank of ten does not
 * land as ten slivers on one row. Read once, at the join; after that the stored rect is
 * the owner's, and a bank that gains presets fits them into the rect it has.
 *
 * T1541b: a look's instance is a bank from outside, so it lands as a bank's strip, sized by
 * the presets its component holds (`catalogue`, `bankViewOf`).
 */
export function boardMemberSize(node: GraphNode, catalogue?: BankCatalogue): CellSize {
  const view = bankViewOf(node, catalogue);
  if (view === undefined) return boardDefaultSize(node.type);
  const size = boardDefaultSize(PRESETS_NODE_TYPE);
  const parsed = parsePresetBank(plainValue(view.bank.parameters["presets"]));
  const count = parsed.ok ? parsed.bank.presets.length : 0;
  return { w: size.w, h: Math.max(size.h, Math.ceil(count / PRESETS_PER_BOARD_ROW)) };
}

/** The smallest an item may be resized to: a pad needs 2×2 to be draggable at all, a cue list a cell each for BACK and GO. */
export function boardMinimumSize(type: string | null): CellSize {
  if (type === CUE_LIST_NODE_TYPE) return { w: 2, h: 1 };
  return type === "xyPad" ? { w: 2, h: 2 } : { w: 1, h: 1 };
}

const isInt = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value);

function parseRect(value: unknown): BoardRect | null {
  if (typeof value !== "object" || value === null) return null;
  const { x, y, w, h } = value as Record<string, unknown>;
  if (!isInt(x) || !isInt(y) || !isInt(w) || !isInt(h)) return null;
  return { x, y, w, h };
}

const EMPTY_BOARD: StoredBoard = { columns: BOARD_DEFAULT_COLUMNS, items: [] };

/**
 * The stored board, read forgivingly: empty text, malformed JSON or a driven slot is an
 * empty eight-column board (every member then flows), and an item that is not a member or
 * a label with a whole-cell rect is skipped rather than failing the Panel.
 */
export function parsePanelBoard(stored: StoredParameter | undefined): StoredBoard {
  const text = plainValue(stored);
  if (typeof text !== "string" || text.trim() === "") return EMPTY_BOARD;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return EMPTY_BOARD;
  }
  if (typeof raw !== "object" || raw === null) return EMPTY_BOARD;
  const record = raw as Record<string, unknown>;
  const columns = isInt(record["columns"]) ? Math.min(BOARD_MAX_COLUMNS, Math.max(1, record["columns"])) : BOARD_DEFAULT_COLUMNS;
  const items: StoredBoardItem[] = [];
  for (const entry of Array.isArray(record["items"]) ? (record["items"] as unknown[]) : []) {
    if (typeof entry !== "object" || entry === null) continue;
    const item = entry as Record<string, unknown>;
    const rect = parseRect(item["rect"]);
    if (rect === null) continue;
    if (typeof item["member"] === "string") items.push({ member: item["member"], rect });
    else if (typeof item["label"] === "string") items.push({ label: item["label"], rect });
  }
  return { columns, items };
}

/** The board as the parameter stores it: one item per line, so the Advanced view stays readable. */
export function serializePanelBoard(board: StoredBoard): string {
  const items = board.items.map((item) => `    ${JSON.stringify(item)}`);
  return `{\n  "columns": ${String(board.columns)},\n  "items": [${items.length === 0 ? "" : `\n${items.join(",\n")}\n  `}]\n}`;
}

/** One thing on a derived board. `key` names it for an edit gesture: `member:<name>` or `label:<n>`. */
export type PanelBoardItem =
  | { readonly kind: "widget"; readonly key: string; readonly node: GraphNode; readonly rect: BoardRect }
  | { readonly kind: "label"; readonly key: string; readonly text: string; readonly rect: BoardRect };

export interface PanelBoard {
  readonly columns: number;
  /** The bottom edge of the lowest item, in cells. */
  readonly rows: number;
  /** Stored items in stored order, then the members that flowed, in wiring order. */
  readonly items: readonly PanelBoardItem[];
}

/** Do two rects share a cell? Touching edges do not. */
export const boardRectsOverlap = (a: BoardRect, b: BoardRect): boolean =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/** A stored rect pulled inside the board's columns and up to the item's minimum size. */
function clampRect(rect: BoardRect, columns: number, minimum: CellSize): BoardRect {
  const w = Math.min(columns, Math.max(minimum.w, rect.w));
  const h = Math.max(minimum.h, rect.h);
  return { x: Math.min(columns - w, Math.max(0, rect.x)), y: Math.max(0, rect.y), w, h };
}

/**
 * The first free spot for an item of `size`, row-major: the top row first, then the
 * leftmost cell, where it overlaps nothing already placed. Deterministic, so one document
 * lays out the same on every surface and every load.
 */
export function firstFreeRect(placed: readonly BoardRect[], columns: number, size: CellSize): BoardRect {
  const w = Math.min(columns, size.w);
  for (let y = 0; ; y += 1) {
    for (let x = 0; x + w <= columns; x += 1) {
      const rect = { x, y, w, h: size.h };
      if (!placed.some((other) => boardRectsOverlap(rect, other))) return rect;
    }
  }
}

/**
 * T1516b — WHERE EVERYTHING SITS ON A PANEL: the ONE derivation behind the Controls tab, the
 * Panel's canvas body, the phone snapshot (`PhonePanel.board`) and the layout model
 * (`node-box.ts`), so no two of them can place a control differently.
 *
 * A Panel laid out by its legacy Layout override has no board (`null`) — its rows render
 * as they always did. Otherwise the members are `panelMembers` (the widgets wired in, in
 * wiring order): a member the stored board names keeps its stored rect (pulled inside the
 * columns and up to its minimum size), labels keep theirs, and every member with no stored
 * rect flows into the first free spot at its type's default size. A stored item whose widget
 * is no longer wired is left out here — and out of storage at the next write, because every
 * write stores this derivation (`storedBoardOf`).
 *
 * T1501b — a stored item that names a Presets bank, a Layer or a Cue List
 * (`BOARD_NAMED_TYPES`) is a member WITHOUT a wire: the item is the membership, so it is
 * kept while a node of one of those kinds carries that name and dropped — here, and from
 * storage at the next write — once the node is gone. It is still a `widget` item (a node at
 * a rect); what is drawn there follows `node.type`. A wired widget of the same name wins.
 */
export function panelBoard(graph: Pick<GraphDocument, "nodes" | "edges">, panel: GraphNode): PanelBoard | null {
  if (panelLayoutOverride(panel) !== null) return null;
  const stored = parsePanelBoard(panel.parameters["board"]);
  const { columns } = stored;
  const members = new Map(panelMembers(graph, panel).map((node) => [controlNameOf(node), node]));
  let named: Map<string, GraphNode> | null = null;
  const namedMember = (name: string): GraphNode | undefined => {
    named ??= new Map(
      Object.values(graph.nodes)
        .filter(boardNamesMember)
        .map((node) => [controlNameOf(node), node]),
    );
    return named.get(name);
  };
  const items: PanelBoardItem[] = [];
  const placed = new Set<string>();
  let labels = 0;
  for (const item of stored.items) {
    if ("label" in item) {
      items.push({ kind: "label", key: `label:${String(labels)}`, text: item.label, rect: clampRect(item.rect, columns, boardMinimumSize(null)) });
      labels += 1;
      continue;
    }
    const node = members.get(item.member) ?? namedMember(item.member);
    if (node === undefined || placed.has(item.member)) continue;
    placed.add(item.member);
    items.push({ kind: "widget", key: `member:${item.member}`, node, rect: clampRect(item.rect, columns, boardMinimumSize(node.type)) });
  }
  for (const [name, node] of members) {
    if (placed.has(name)) continue;
    const rect = firstFreeRect(items.map((item) => item.rect), columns, boardDefaultSize(node.type));
    items.push({ kind: "widget", key: `member:${name}`, node, rect });
  }
  return { columns, rows: items.reduce((bottom, item) => Math.max(bottom, item.rect.y + item.rect.h), 0), items };
}

/** A derived board as storage: every item at the rect it is drawn at now. */
export function storedBoardOf(board: PanelBoard): StoredBoard {
  return {
    columns: board.columns,
    items: board.items.map((item): StoredBoardItem =>
      item.kind === "label" ? { label: item.text, rect: item.rect } : { member: controlNameOf(item.node), rect: item.rect },
    ),
  };
}

/**
 * T1527b — CAN THIS NODE STILL JOIN THAT PANEL: a widget not yet wired into its Controls;
 * a bank, a layer or a cue list its board does not show yet (a Panel laid out by its legacy
 * Layout text has no board, so it takes none of them). The ONE answer behind the patch
 * that joins them (`joinPanelOperations`, `panel-join.ts`) and `soloPanelFor` below.
 */
export function panelLacks(graph: Pick<GraphDocument, "nodes" | "edges">, panel: GraphNode, node: GraphNode, catalogue?: BankCatalogue): boolean {
  if (panel.type !== "panel") return false;
  // T1541b: a look's instance joins by name like a bank — when the catalogue can see it is one.
  if (joinsBoardByName(node, catalogue)) {
    const board = panelBoard(graph, panel);
    return board !== null && !board.items.some((item) => item.kind === "widget" && item.node.id === node.id);
  }
  if (!CONTROL_WIDGET_TYPES.has(node.type)) return false;
  return !incomingEdgesInOrder(graph, panel.id, PANEL_INPUT).some((edge) => edge.source.nodeId === node.id);
}

/** T1771b: this Panel has a board that does not show this node's on/off switch yet (`switchesOnBoard`). */
export function panelLacksSwitch(graph: Pick<GraphDocument, "nodes" | "edges">, panel: GraphNode, node: GraphNode, catalogue?: BankCatalogue): boolean {
  if (panel.type !== "panel" || !switchesOnBoard(node, catalogue)) return false;
  const board = panelBoard(graph, panel);
  return board !== null && !board.items.some((item) => item.kind === "widget" && item.node.id === node.id);
}

/**
 * The document's only Panel, when the node is not on it yet — what the node's own "+ panel"
 * button offers. With two Panels there is no one answer, so it offers none.
 *
 * T1527b: here rather than in the editor because TWO things ask it and must not disagree —
 * the canvas, which draws the button (`control-bodies.tsx`), and the layout model, which
 * gives the button its room (`nodeControlsHeight`, `src/domain/graph/node-box.ts`, which
 * cannot import the editor). While only the canvas asked, E82's two banks and two layers
 * rendered 29px taller than the §V389 gate laid them out.
 */
export function soloPanelFor(graph: Pick<GraphDocument, "nodes" | "edges">, nodeId: NodeId, catalogue?: BankCatalogue): NodeId | null {
  const node = graph.nodes[nodeId];
  if (node === undefined) return null;
  let only: GraphNode | null = null;
  for (const each of Object.values(graph.nodes)) {
    if (each.type !== "panel") continue;
    if (only !== null) return null;
    only = each;
  }
  return only !== null && panelLacks(graph, only, node, catalogue) ? only.id : null;
}
