import type { FrameClock } from "@domain/types/frame.ts";
import { authoredGraph, type GraphDocument, type GraphNode } from "@domain/types/graph.ts";
import type { NodeId } from "@domain/types/ids.ts";
import { nodeByName } from "@domain/graph/names.ts";
import {
  parsePresetBank,
  parsePresetTargets,
  type MorphCurve,
  type MorphSpec,
  type PresetValues,
} from "@domain/presets/bank.ts";
import { bankSettings, presetMorph, type PresetRecallOutput, type PresetStoreOutput } from "@domain/presets/commands.ts";
import type { CueFireOutput, CueListQueryOutput, CueSetStandbyOutput } from "@domain/presets/cue-commands.ts";
import type { PresetDeleteOutput } from "@domain/presets/delete-command.ts";
import { morphProgress, morphRunning, type MorphRecord } from "@domain/presets/morph.ts";
import { PAGE_TARGET, bankViewOf, heldMorphRecords, presetCatalogueHolderFor, type BankView } from "@domain/presets/bank-view.ts";

import {
  cueNamedInput,
  cueStepInput,
  deletePresetInput,
  listCuesInput,
  listPresetsInput,
  recallPresetInput,
  storePresetInput,
} from "../schemas.ts";
import type {
  CueNamedInput,
  CueStepInput,
  DeletePresetInput,
  ListCuesInput,
  ListPresetsInput,
  RecallPresetInput,
  StorePresetInput,
} from "../schemas.ts";
import { failed, ok, result } from "../tool-support.ts";
import type { AgentTool, DispatchResult, ToolResult, ToolRuntime, ToolStatus } from "../types.ts";

/**
 * Preset banks and the cue list (T1502b, §T1398b S7 — the design doc §10).
 *
 * Nine adapters over commands that already exist: `preset.store` / `preset.recall` /
 * `preset.delete` (§T1496b, §T1497b, §T1499b) and `cue.go` / `cue.back` / `cue.fire` /
 * `cue.setStandby` with the `cue.list` query (§T1500b). Each tool forwards its input and
 * projects the command's own output; the planner, the one-patch rule, the undo step, the
 * audit entry and every refusal's sentence are the commands' (§V39). A refusal comes back
 * as the command's `rejected` with its diagnostics untouched.
 *
 * ## No capability class (§V38)
 *
 * A store, a recall, a delete and a GO are graph edits: undoable, audited and
 * actor-stamped, and nothing leaves the document. `capabilities.ts` says why those are
 * ungated, and these are no exception.
 *
 * ## What the SCREEN did is its own field
 *
 * A recall with a morph commits the END values at once and writes a record the picture
 * fades along — on the app's transport. A bus with no app (the headless server) has no
 * transport, so the same recall is a cut there, and the command says so in an `info`
 * diagnostic. An agent that reads `morph` in its own input and "ok" in the status would
 * report a fade nobody saw, so every tool that fires a recall projects three plain fields:
 * `transition` ("morph" / "cut" / "none"), `morphUnavailable`, and the `record` the
 * command wrote, read back from the bank it wrote it to.
 *
 * ## `list_presets` has no query behind it
 *
 * `cue.list` is a bus query; a bank's listing is not, so this reads `graph.get` and parses
 * the bank with the domain's own parsers — the same shape of projection `get_node` is.
 * A preset's `morph` is §5.1's ladder as `presetMorph` computes it, never a second copy.
 *
 * ## Not held for review
 *
 * These carry no `preview`, so a surface built with `requireApproval` runs them without a
 * card, as it does `layout_graph` and `import_component`: the operations are the
 * planner's, and deriving them here would be a second planner.
 *
 * Untrusted text (§V37): bank, preset and cue names travel in `data`. The messages this
 * file authors quote only the id the caller passed in.
 */

/** A fade, as an agent reads it: the record minus the stored values, plus where it is. */
export interface MorphView {
  readonly preset: string;
  /** The transport's absolute clock at the recall, in seconds. */
  readonly start: number;
  readonly seconds: number;
  readonly curve: MorphCurve;
  /** 0..1 along `seconds`, on this surface's frame clock at the moment of the call. */
  readonly progress: number;
  /** `node.key` for every value the fade covers. */
  readonly keys: readonly string[];
}

export interface PresetView {
  readonly name: string;
  /** `node.key` for every value the preset holds. The values are the bank's `presets` parameter. */
  readonly keys: readonly string[];
  /** Node name → on/off (a Layer, or any node or component instance: off is its bypass, T1770b), switched in the same step as the recall. */
  readonly on: Readonly<Record<string, boolean>>;
  /** Other banks' presets recalled in the same step (a shot), in the order laid. */
  readonly recalls: ReadonlyArray<{ readonly bank: string; readonly preset: string }>;
  /** The morph a recall of this preset uses when the call names none: its own, else the bank's. */
  readonly morph: MorphSpec;
}

export interface PresetBankView {
  readonly nodeId: NodeId;
  readonly name: string | null;
  /**
   * T1505b: the component whose presets these are, when the bank is a look's INSTANCE — its
   * presets live in the component (a Store writes the component, for every instance), and
   * its `current` and fades are this instance's own. `null` for a Presets node.
   */
  readonly component: string | null;
  /** The bank's Targets, as written: a node name, or `node.key`. */
  readonly targets: readonly string[];
  /** The preset recalled last. Empty before the first recall. */
  readonly current: string;
  /** The preset a recall with no name recalls. */
  readonly select: string;
  /** Why the bank's Presets field does not parse, or `null`. A malformed bank lists no presets. */
  readonly malformed: string | null;
  readonly presets: readonly PresetView[];
  /** The fades this bank is running now. Always empty where there is no transport. */
  readonly morphs: readonly MorphView[];
}

export interface PresetListing {
  readonly banks: readonly PresetBankView[];
  /**
   * The transport's absolute clock at the call, or `null` when this surface has none (the
   * headless server) — there a morph is a cut and `morphs` is always empty.
   */
  readonly clockSeconds: number | null;
}

/** What the screen did, beside what the command reports it wrote. */
export interface FadeReport {
  /** "morph": a fade is running. "cut": the values changed at once. "none": nothing was recalled. */
  readonly transition: "morph" | "cut" | "none";
  /** A morph was asked for and this surface has no transport to fade on, so it was a cut. */
  readonly morphUnavailable: boolean;
  /** The fade the recall started, or `null` — a cut, a refusal or a dry run. */
  readonly record: MorphView | null;
}

export type RecallPresetData = PresetRecallOutput & FadeReport;
export type CueFireData = CueFireOutput & FadeReport;

/** The diagnostic `planPresetRecall` adds when a morph is asked for with no frame clock attached. */
const MORPH_UNAVAILABLE_CODE = "preset.recall.morphUnavailable";

const statusOf = (status: DispatchResult<unknown>["status"]): ToolStatus => (status === "applied" ? "ok" : status);

const graphOf = (runtime: ToolRuntime): Promise<GraphDocument> => runtime.query("graph.get", {});

const text = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

const keysOf = (values: PresetValues): string[] =>
  Object.entries(values).flatMap(([nodeName, keys]) => Object.keys(keys).map((key) => `${nodeName}.${key}`));

function morphView(record: MorphRecord, clock: FrameClock): MorphView {
  return {
    preset: record.preset,
    start: record.start,
    seconds: record.seconds,
    curve: record.curve,
    progress: morphProgress(record, clock.absTimeSeconds),
    keys: keysOf(record.to),
  };
}

function commandResult<TData>(tool: string, dispatched: DispatchResult<unknown>, data: TData): ToolResult<TData> {
  return result(tool, statusOf(dispatched.status), data, {
    diagnostics: dispatched.diagnostics,
    revision: dispatched.revision,
    undoGroupId: dispatched.undoGroupId,
  });
}

/**
 * What the screen did after a command that recalls. The record is read back from the
 * bank's `morphs` — the recall appends its own last — rather than rebuilt from the input,
 * so what is reported is what the resolver will fade along.
 */
async function fadeReport(
  dispatched: DispatchResult<{ ok: boolean; preset: string | null; morph: MorphSpec | null }>,
  runtime: ToolRuntime,
  bankOf: (graph: GraphDocument) => GraphNode | undefined,
): Promise<FadeReport> {
  const { output } = dispatched;
  if (!output.ok) return { transition: "none", morphUnavailable: false, record: null };
  if (output.morph === null) {
    const morphUnavailable = dispatched.diagnostics.some((each) => each.code === MORPH_UNAVAILABLE_CODE);
    return { transition: "cut", morphUnavailable, record: null };
  }
  const clock = runtime.bus.frameClock();
  // A dry run validated the morph and wrote no record to read back.
  if (dispatched.status !== "applied" || clock === undefined) return { transition: "morph", morphUnavailable: false, record: null };
  // T1505b: the bank may be a look's instance, holding its fades in `presetMorphs`.
  const view = bankViewOf(bankOf(await graphOf(runtime)), catalogueOf(runtime));
  const written = (view === undefined ? [] : heldMorphRecords(view)).at(-1);
  return {
    transition: "morph",
    morphUnavailable: false,
    record: written === undefined || written.preset !== output.preset ? null : morphView(written, clock),
  };
}

/** The component catalogue the bus's preset commands read (T1505b), or none (the headless server). */
const catalogueOf = (runtime: ToolRuntime) => presetCatalogueHolderFor(runtime.bus).current?.components;

function bankView(view: BankView, runtime: ToolRuntime, clock: FrameClock | undefined, graph: GraphDocument): PresetBankView {
  const node = view.holder;
  // The bank's own settings as the commands read them (`bankSettings`: at this moment, through
  // the bus's read scope; for a look's instance, its component's page bank's). §T1557b: this
  // was `{ channels }` alone, so a Morph on `op('k1').chan.value` listed as its static.
  const settings = bankSettings(view, runtime.bus.registry, { ...runtime.bus.readScope(), graph: authoredGraph(graph) });
  const parsed = parsePresetBank(view.bank.parameters["presets"]);
  const instance = node.label ?? node.id;
  // A look's preset holds `parent`; what a recall writes is the instance's own page.
  const spelled = (name: string): string => (view.kind === "instance" && name === PAGE_TARGET ? instance : name);
  const current = view.kind === "instance" ? node.parameters[view.currentKey] : settings["current"];
  return {
    nodeId: node.id,
    name: node.label ?? null,
    component: view.definition?.name ?? null,
    targets: parsePresetTargets(view.bank.parameters["targets"]).map((target) =>
      target.key === undefined ? spelled(target.node) : `${spelled(target.node)}.${target.key}`,
    ),
    current: text(current),
    select: text(settings["select"]),
    malformed: parsed.ok ? null : parsed.reason,
    presets: (parsed.ok ? parsed.bank.presets : []).map((preset) => ({
      name: preset.name,
      keys: keysOf(Object.fromEntries(Object.entries(preset.values).map(([name, keys]) => [spelled(name), keys]))),
      on: { ...preset.on },
      recalls: [...(preset.recalls ?? [])],
      morph: presetMorph(undefined, preset, settings),
    })),
    morphs:
      clock === undefined
        ? []
        : heldMorphRecords(view)
            .filter((record) => morphRunning(record, clock))
            .map((record) => morphView(record, clock)),
  };
}

export const listPresets: AgentTool<ListPresetsInput, PresetListing> = {
  name: "list_presets",
  title: "List presets",
  description:
    "Every Presets bank: its targets, the preset recalled last (current), and each preset with the keys it holds, the nodes it switches on or off (on: a Layer, or any node or component instance; off is its bypass, so a source goes silent and an instance's interior stops costing anything), the other banks' presets it recalls and the morph a plain recall of it uses. morphs lists the fades running right now with their progress (0 to 1) on this surface's transport clock. clockSeconds null means this surface has no transport (the headless server): nothing fades there and morphs is always empty. The stored values themselves are the bank's presets parameter; read them with get_node. A component instance whose component holds a preset bank targeting parent is a bank too (component names it): its presets live in the component, and store_preset on it writes the component for every instance; current and morphs are that instance's own.",
  kind: "read",
  inputSchema: listPresetsInput,
  requires: { queries: ["graph.get"] },
  capabilities: [],
  mutates: false,
  async run(input, runtime) {
    const graph = await graphOf(runtime);
    const catalogue = catalogueOf(runtime);
    // T1505b: every bank — a Presets node, or a look's instance whose component holds one.
    const banks = Object.keys(graph.nodes)
      .sort()
      .map((nodeId) => bankViewOf(graph.nodes[nodeId], catalogue))
      .filter((view): view is BankView => view !== undefined)
      .filter((view) => input.nodeId === undefined || view.holder.id === input.nodeId);
    if (input.nodeId !== undefined && banks.length === 0) {
      return failed<PresetListing>("list_presets", "preset.bank.unknown", `No Presets bank with id "${input.nodeId}".`, {
        revision: graph.revision,
        suggestion: "Call list_presets without nodeId for the banks in this document.",
      });
    }
    const clock = runtime.bus.frameClock();
    return ok(
      "list_presets",
      { banks: banks.map((view) => bankView(view, runtime, clock, graph)), clockSeconds: clock?.absTimeSeconds ?? null },
      { revision: graph.revision },
    );
  },
};

export const storePreset: AgentTool<StorePresetInput, PresetStoreOutput> = {
  name: "store_preset",
  title: "Store preset",
  description:
    "Store a bank's targets under a preset name: every parameter of each node named in the bank's targets parameter, or the single node.key named there, or for a target written node.@on whether that node is on (not bypassed), captured as stored, so an expression stays an expression. An existing name is overwritten in place; the name must be an identifier. One undo step. A bank with no targets, or none that can be captured, is refused: set its targets parameter first.",
  kind: "mutate",
  inputSchema: storePresetInput,
  requires: { commands: ["preset.store"] },
  capabilities: [],
  mutates: true,
  async run(input, runtime) {
    const dispatched = await runtime.execute<PresetStoreOutput>("preset.store", { nodeId: input.nodeId, name: input.name });
    return commandResult("store_preset", dispatched, dispatched.output);
  },
};

const HOW_IT_LANDED =
  "The document takes the END values at once either way; transition says what the SCREEN did. morph, with record, means a fade is running on the transport (list_presets reports its progress). cut means it changed at once, and morphUnavailable true means a morph was asked for but this surface has no transport to fade on (the headless server): do not report a fade.";

export const recallPreset: AgentTool<RecallPresetInput, RecallPresetData> = {
  name: "recall_preset",
  title: "Recall preset",
  description: `Recall a bank's preset: every value it holds is written back in ONE step that one undo reverses, together with the other banks' presets and the on/off switches it names. Omit name for the preset in the bank's Select. morph {seconds, curve} overrides the preset's and the bank's own morph for this recall; seconds 0 forces a cut. ${HOW_IT_LANDED} A target that is gone is skipped and named in skipped; a recall with nothing left to apply is refused.`,
  kind: "mutate",
  inputSchema: recallPresetInput,
  requires: { commands: ["preset.recall"], queries: ["graph.get"] },
  capabilities: [],
  mutates: true,
  async run(input, runtime) {
    const dispatched = await runtime.execute<PresetRecallOutput>("preset.recall", {
      nodeId: input.nodeId,
      ...(input.name === undefined ? {} : { name: input.name }),
      ...(input.morph === undefined ? {} : { morph: input.morph }),
    });
    const fade = await fadeReport(dispatched, runtime, (graph) => graph.nodes[input.nodeId]);
    return commandResult<RecallPresetData>("recall_preset", dispatched, { ...dispatched.output, ...fade });
  },
};

export const deletePreset: AgentTool<DeletePresetInput, PresetDeleteOutput> = {
  name: "delete_preset",
  title: "Delete preset",
  description:
    "Delete one preset from a bank; one undo step brings it back. Cues and other presets that name it are not rewritten: a cue that fires it is then refused and a preset that recalls it skips it, each naming what is missing.",
  kind: "mutate",
  inputSchema: deletePresetInput,
  requires: { commands: ["preset.delete"] },
  capabilities: [],
  mutates: true,
  async run(input, runtime) {
    const dispatched = await runtime.execute<PresetDeleteOutput>("preset.delete", { nodeId: input.nodeId, name: input.name });
    return commandResult("delete_preset", dispatched, dispatched.output);
  },
};

export const listCues: AgentTool<ListCuesInput, CueListQueryOutput> = {
  name: "list_cues",
  title: "List cues",
  description:
    "Every Cue List: its cues in order (each a bank, a preset, an optional morph, note and at — the cue's time on the timeline in seconds), the cue fired last (current), the standby, and next: the cue cue_go would fire now, or null when GO would be refused. follow is live or timeline; a timeline list applies each cue at its at as the playhead passes (an export reproduces it), refuses cue_go / cue_back / cue_fire, and reports timelineCurrent / timelineNext at the page's clock, warnings for what it skips, and structure: the structural settings it switches at its cue times (node.key, a Layer's on/off as node.on — each recompiles the plan on its cue frame; the document keeps its stored setting). Time cues by editing the cues JSON with set_parameters. morphs lists the fades its banks are running with their progress; it, timelineCurrent and timelineNext are always empty on a surface with no transport (the headless server).",
  kind: "read",
  inputSchema: listCuesInput,
  requires: { queries: ["cue.list", "graph.get"] },
  capabilities: [],
  mutates: false,
  async run(input, runtime) {
    const listing = await runtime.query<CueListQueryOutput>("cue.list", input.nodeId === undefined ? {} : { nodeId: input.nodeId });
    const revision = await runtime.revision();
    if (input.nodeId !== undefined && listing.lists.length === 0) {
      return failed<CueListQueryOutput>("list_cues", "cue.list.unknown", `No Cue List with id "${input.nodeId}".`, {
        revision,
        suggestion: "Call list_cues without nodeId for the cue lists in this document.",
      });
    }
    return ok("list_cues", listing, { revision });
  },
};

/** GO, BACK and fire differ in the command and in what they send it; the projection is one. */
function cueFireTool<TInput>(
  tool: Pick<AgentTool<TInput, CueFireData>, "name" | "title" | "description" | "inputSchema">,
  command: string,
  commandInput: (input: TInput) => unknown,
): AgentTool<TInput, CueFireData> {
  return {
    ...tool,
    kind: "mutate",
    requires: { commands: [command], queries: ["graph.get"] },
    capabilities: [],
    mutates: true,
    async run(input, runtime) {
      const dispatched = await runtime.execute<CueFireOutput>(command, commandInput(input));
      const { bank } = dispatched.output;
      // A cue names its bank by NAME; the record is in that bank's `morphs`.
      const fade = await fadeReport(dispatched, runtime, (graph) => {
        const bankId = bank === null ? undefined : nodeByName(graph, bank);
        return bankId === undefined ? undefined : graph.nodes[bankId];
      });
      return commandResult<CueFireData>(tool.name, dispatched, { ...dispatched.output, ...fade });
    },
  };
}

const stepInput = (input: CueStepInput): unknown => (input.nodeId === undefined ? {} : { nodeId: input.nodeId });

export const cueGo = cueFireTool<CueStepInput>(
  {
    name: "cue_go",
    title: "Cue GO",
    description: `GO: fire a cue list's standby cue. Its preset is recalled and the list moves on as ONE step that one undo reverses, after which the next GO fires the same cue again. Omit nodeId for the one list whose Keys switch is on. Past the last cue without Wrap, or on a cue whose bank or preset is gone, it is refused and the standby stays where it is. ${HOW_IT_LANDED}`,
    inputSchema: cueStepInput,
  },
  "cue.go",
  stepInput,
);

export const cueBack = cueFireTool<CueStepInput>(
  {
    name: "cue_back",
    title: "Cue BACK",
    description: `BACK: fire the cue before the list's current one, with that cue's own morph; the standby becomes the cue after it. It is a recall, not an undo: use undo to take a GO back. It does not wrap, so before the first cue it is refused. Omit nodeId for the one list whose Keys switch is on. ${HOW_IT_LANDED}`,
    inputSchema: cueStepInput,
  },
  "cue.back",
  stepInput,
);

export const cueFire = cueFireTool<CueNamedInput>(
  {
    name: "cue_fire",
    title: "Fire cue",
    description: `Fire a named cue of a cue list directly, out of order; the standby becomes the cue after it. One step, one undo. A cue the list does not hold, or one whose bank or preset is gone, is refused. ${HOW_IT_LANDED}`,
    inputSchema: cueNamedInput,
  },
  "cue.fire",
  (input) => ({ nodeId: input.nodeId, cue: input.cue }),
);

export const setCueStandby: AgentTool<CueNamedInput, CueSetStandbyOutput> = {
  name: "set_cue_standby",
  title: "Set cue standby",
  description:
    "Move a cue list's standby, the cue cue_go fires next, without firing anything. One undo step. A cue the list does not hold is refused.",
  kind: "mutate",
  inputSchema: cueNamedInput,
  requires: { commands: ["cue.setStandby"] },
  capabilities: [],
  mutates: true,
  async run(input, runtime) {
    const dispatched = await runtime.execute<CueSetStandbyOutput>("cue.setStandby", { nodeId: input.nodeId, cue: input.cue });
    return commandResult("set_cue_standby", dispatched, dispatched.output);
  },
};

export const presetTools: readonly AgentTool[] = [
  listPresets,
  storePreset,
  recallPreset,
  deletePreset,
  listCues,
  cueGo,
  cueBack,
  cueFire,
  setCueStandby,
] as readonly AgentTool[];
