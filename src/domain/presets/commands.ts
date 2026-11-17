import type { RuntimeDiagnostic } from "../types/diagnostics.ts";
import type { FrameClock } from "../types/frame.ts";
import type { GraphDocument, GraphNode } from "../types/graph.ts";
import type { NodeId, Revision } from "../types/ids.ts";
import type { ParameterDefinition, ParameterSchema, StoredParameter } from "../types/parameters.ts";
import type { GraphPatchOperation } from "../types/patch.ts";
import type { NodeRegistryView } from "../../nodes/registry/registry.ts";
import type { CommandContext, CommandOutcome, LoomBus } from "../commands/bus.ts";
import { applyGraphPatch } from "../commands/apply-patch.ts";
import { z } from "zod";
import { finiteInput, idInput, nodeIdInput } from "../commands/input-schema.ts";
import { nodeByName } from "../graph/names.ts";
import { TEMPO_RESYNC_COMMAND, TEMPO_TAP_COMMAND } from "../tempo/project-tempo.ts";
import { effectiveParameterSchema, resolveParameters, resolveStored } from "../parameters/resolve.ts";
import { parameterReadOptions, type ParameterReadContext } from "../parameters/node-references.ts";
import {
  componentAddressedDefinition,
  componentNamesFor,
  isComponentKeyOf,
  isParameterSlot,
  parseComponentKey,
  storedStaticValue,
} from "../parameters/slots.ts";
import { defaultParameterValue, validateParameters } from "../parameters/validate.ts";
import {
  MORPH_CURVES,
  isPresetName,
  PRESET_ON_TARGET_KEY,
  parsePresetBank,
  parsePresetTargets,
  serializePresetBank,
  type MorphCurve,
  type MorphSpec,
  type Preset,
  type PresetBank,
  type PresetTarget,
  type PresetValues,
} from "./bank.ts";
import {
  MAX_MORPH_RECORDS,
  morphRunning,
  nextMorphRecords,
  renameRecordsNode,
  sameStored,
  serializeMorphRecords,
  type MorphRecord,
} from "./morph.ts";
import { bankMorphRecords } from "./morph-index.ts";
import {
  PAGE_TARGET,
  isPresetsNode,
  PRESET_CURRENT_KEY,
  PRESET_MORPHS_KEY,
  PRESET_STATE_KEYS,
  bankOf,
  heldMorphRecords,
  isPageBank,
  presetCatalogueHolderFor,
  withPageBankPresets,
  type BankCatalogue,
  type BankLookup,
  type BankView,
  type PresetCatalogue,
} from "./bank-view.ts";
import { isComponentNodeType } from "../components/component-type.ts";
import { enteredThrough } from "../components/addressing.ts";
import { readComponentInstance } from "../components/instance.ts";
import { presetHolds } from "../../nodes/definitions/controls.ts";
import { CUE_BACK_COMMAND, CUE_GO_COMMAND } from "./cue-list.ts";

/**
 * T1496b (§T1398b S1) — `preset.store` and `preset.recall`: a bank's Store captures its
 * declared targets as whole slots, and its Recall writes them back as ONE patch.
 *
 * ## One recall is one patch (the design doc §4.4)
 *
 * Every target, and the bank's own `current`, go into ONE `GraphPatch` applied through
 * `applyGraphPatch` — so the recall is one revision, one undo group and one audit entry
 * under the name `preset.recall` and the invoking actor, and one undo puts every target
 * back. Per-node writes would be N undo steps and a half-recalled look after the first
 * undo. `splitUndo` keeps it its own group even inside a caller's transaction: a Panel
 * gesture's coalescing must not swallow a recall into a slider drag.
 *
 * ## Skip what is gone, refuse only when nothing is left (ruling 4)
 *
 * A bank outlives its targets: a node gets deleted, a component's page loses a key, a
 * hand-edited value stops fitting. Each such entry is SKIPPED with a warning that names
 * it (`glow`, `glow.radius`), and the rest applies. Only a recall that would change no
 * target at all is refused — "recalled" with nothing moved would be a lie in the audit
 * log. Validation is the same one `setParameters` runs (the node's EFFECTIVE schema, so a
 * component instance's published page and a customWgsl's reflected controls count, §T903),
 * checked per key BEFORE the patch is built, so one bad value cannot abort the others.
 *
 * ## The whole slot (ruling 2)
 *
 * A preset holds a key's STORED form: a bare value, or the whole slot with its mode and
 * every retained binding, so an expression comes back as that expression. A bare value
 * written over a slot would, through `setParameters`, only update the slot's retained
 * static (§B166) and leave an expression in effect — so a recall writes it as a
 * static-mode slot instead, keeping the slot's other bindings (§V108: never destructive).
 *
 * ## A morph commits the END state, and a record beside it (T1497b, the design doc §5)
 *
 * A recall with a non-zero morph writes exactly the values a cut writes — the document
 * holds the destination from that moment, so the inspector, Store, a save, the phone and
 * undo all see it — plus ONE record in the bank's `morphs` parameter, in the SAME patch:
 * where each changed key came from, the absolute clock's reading at the recall, the
 * duration and the curve. The fade is the resolver's business (`resolve.ts`, through
 * `morph-index.ts`), a pure function of the document and the frame; nothing here runs per
 * frame, and one undo takes the record away together with the values, so the screen cuts
 * back. Which morph applies is §5.1's precedence: the recall's own `morph`, else the
 * preset's, else the bank's `morph` / `curve` parameters.
 *
 * The handler reads NO clock (§V44). `context.frameClock` is the last frame the app's
 * transport produced, attached to the bus the way the channel resolver is; a bus with no
 * app has none, and a morph asked for there commits as a cut and says so
 * (`preset.recall.morphUnavailable`) — the values land either way.
 *
 * ## A shot: other banks' presets, in the same patch (T1499b, the design doc §8.1)
 *
 * A preset's `recalls` name other banks' presets. The planner EXPANDS them depth-first
 * and lays every preset's values into one map before it resolves a single name, so a shot
 * is still one patch — one revision, one undo, one audit entry — however many banks it
 * reaches, and its morph is still ONE record, in the recalled bank, over every key the
 * shot changed. What is laid later wins: a preset's recalls in the order written, then
 * the preset's OWN values over all of them (ruling 14). The same holds at every level, so
 * the shot itself always has the last word. A nested preset's own `morph` is not read:
 * the shot is the recall, and §5.1's ladder is about the recall.
 *
 * A CYCLE is refused, naming the banks on it, and so is a nesting deeper than
 * `MAX_RECALL_DEPTH`: both are mistakes in the bank's text, not targets that went away,
 * so nothing is written rather than a guess at where to stop. A recall that names a bank
 * or a preset that is NOT THERE is ruling 4's case instead — skipped with a warning that
 * names it, and the rest applies.
 *
 * Each nested bank a preset actually wrote something from gets its `current` in the same
 * patch: `current` is "the last preset recalled", and a Panel beside the shots bank would
 * otherwise go on highlighting the look the shot just replaced.
 *
 * ## On/off (T1498b's seam, the design doc §4.4 step 5 and §7.2; any node since T1770b)
 *
 * A preset's `on` map is written as `setNodeUi { bypassed: !on }` on each named node, in
 * the same patch, so an on/off is undone with the rest of the recall. Always a cut — it is
 * structural. It began as the Layer's switch and T1770b took the fence down: off is the
 * bypass flag on ANY root node or instance (ruling 9, one flag for one idea). A Layer
 * passes its stack, an effect passes its input, a source has nothing to pass and is silent
 * (`bypassPassthroughPorts`), and an instance that is off is not inlined, so its interior
 * costs nothing (T1032). A bank whose presets each hold the whole `on` row of a set of
 * sources is therefore the exclusive choice among them: one patch, so no frame reads two
 * of them on, or none.
 *
 * ## The seam the cue list uses
 *
 * `planPresetRecall` is THE recall planner: the cue list's GO (§T1500b) runs it with the
 * cue's morph and adds its own `current`/`standby` to the same patch.
 */

declare module "../types/commands.ts" {
  interface CommandMap {
    "preset.store": { input: PresetStoreInput; output: PresetStoreOutput };
    "preset.recall": { input: PresetRecallInput; output: PresetRecallOutput };
  }
}

export const PRESET_STORE_COMMAND = "preset.store";
export const PRESET_RECALL_COMMAND = "preset.recall";

/**
 * T1497b — THE PULSE-FIRED COMMANDS A RENDER MUST NOT FIRE (the design doc §5.4).
 *
 * A take renders the document AS SAVED. Most pulses are part of that picture: a
 * Feedback's reset on `frame % 120 == 0` is a deterministic function of the frame and
 * touches no document, so the take fires it exactly as playback does. A RECALL is not —
 * it EDITS the document, so a `recall` pulse on a beat expression would rewrite the
 * project in the middle of its own export, and the second export of the same file would
 * start from a different document than the first. A live performance is not re-performed
 * by a render (T467); timeline-placed cues, which an export WOULD reproduce, are §T1508b.
 *
 * Named here, by the commands that own the behaviour, and read by the app's pulse watcher
 * (`src/app/pulse-firing.ts`). The cue list's GO and BACK (T1500b) are recalls with a
 * position attached, so its two pulses are here for the same reason.
 */
export const RENDER_BLOCKED_PULSE_COMMANDS: ReadonlySet<string> = new Set([
  PRESET_RECALL_COMMAND,
  CUE_GO_COMMAND,
  CUE_BACK_COMMAND,
  // T1787b: a Tempo node's Tap stores the tapped BPM in the document, and its Resync moves
  // the beat a take counts from its own zero (§V1038).
  TEMPO_TAP_COMMAND,
  TEMPO_RESYNC_COMMAND,
]);

export interface PresetStoreInput {
  /** The bank node. */
  nodeId: NodeId;
  /** The preset to write. An existing name is overwritten in place, keeping its position. */
  name: string;
}

/**
 * §T1556b — the preset commands' input schemas: THE definition, which the agent's
 * `store_preset` / `recall_preset` tools extend with `dryRun` rather than copy.
 */
export const presetStoreInputSchema = z.object({ nodeId: idInput, name: z.string().min(1) }).strict();

/** 0 is a cut, whatever the preset or the bank says. The curve list is the bank parser's. */
export const morphSpecSchema = z
  .object({ seconds: finiteInput.min(0), curve: z.enum(MORPH_CURVES as unknown as [MorphCurve, ...MorphCurve[]]) })
  .strict();

export const presetRecallInputSchema = z
  .object({
    // §T1695b: a node ADDRESS, so a recall handed up from a component session reaches the
    // instance in view (`nodeIdInput`, `input-schema.ts`).
    nodeId: nodeIdInput,
    /** Omitted: the preset named in the bank's Select. */
    name: z.string().min(1).optional(),
    /** How THIS recall is carried out, over the preset's and the bank's own morph. */
    morph: morphSpecSchema.optional(),
  })
  .strict();

export interface PresetStoreOutput {
  ok: boolean;
  preset: string | null;
  /** How many parameter keys the preset now holds. */
  captured: number;
  /** Every target token Store could not capture (a missing node, an unknown key). */
  missing: readonly string[];
}

export interface PresetRecallInput {
  /** The bank node. */
  nodeId: NodeId;
  /** The preset to recall. Absent: the bank's resolved `select`. */
  name?: string;
  /**
   * T1497b: how THIS recall is carried out, overriding the preset's and the bank's morph
   * (the design doc §5.1). `seconds: 0` is a cut whatever the preset says.
   */
  morph?: MorphSpec;
}

export interface PresetRecallOutput {
  ok: boolean;
  preset: string | null;
  /** `node.key` for every value written, and `layer.on` for every layer switched (T1499b). */
  applied: readonly string[];
  /** `node` or `node.key` for every entry skipped, each with a warning in `diagnostics`. */
  skipped: readonly string[];
  /**
   * T1497b: the morph the screen is now doing, or `null` when the recall was a cut — asked
   * for as one, nothing left to fade, or no frame clock attached (headless), which
   * `diagnostics` then names.
   */
  morph: MorphSpec | null;
}

function diagnostic(
  severity: RuntimeDiagnostic["severity"],
  code: string,
  message: string,
  nodeId?: NodeId,
  suggestion?: string,
): RuntimeDiagnostic {
  return {
    severity,
    code,
    message,
    ...(nodeId === undefined ? {} : { nodeId }),
    ...(suggestion === undefined ? {} : { suggestion }),
  };
}

/** The name a bank goes by in a message: its label, else its id. */
function bankName(node: GraphNode): string {
  return node.label ?? node.id;
}

/**
 * T1505b — why a node that is not a bank this bus can use is not one, in words. Shared by
 * `requireBank`, the cue list's target and Delete, so the three say the same sentence.
 * `where` opens the sentence (`"city"`, or `Cue "c1" (set): "city"`).
 */
export function bankLookupRefusal(
  lookup: Exclude<BankLookup, { ok: true }>,
  node: GraphNode,
  where: string,
  code: (why: string) => string = (why) => `preset.bank.${why}`,
): RuntimeDiagnostic {
  const said = `${where} ${notABank(lookup.why, node)}`;
  switch (lookup.why) {
    case "notBank":
      return diagnostic("error", code("type"), `${said}.`, node.id);
    case "noCatalogue":
      return diagnostic("error", code("noCatalogue"), `${said}; nothing was changed.`, node.id, "A look's presets live in its component; recall them where the component is installed (the app).");
    case "notInstalled":
      return diagnostic("error", code("notInstalled"), `${said}; nothing was changed.`, node.id);
    case "noPageBank":
      return diagnostic("error", code("noPageBank"), `${said}; nothing was changed.`, node.id, `Inside the component, add a Presets node whose Targets is "${PAGE_TARGET}".`);
  }
}

/** Why a node is not a bank here, as the end of a sentence that names it (T1541b: the timeline says it too). */
export function notABank(why: Exclude<BankLookup, { ok: true }>["why"], node: GraphNode): string {
  switch (why) {
    case "notBank":
      return `is a ${node.type} node, not a Presets bank`;
    case "noCatalogue":
      return "is a component instance, and this surface has no component catalogue to read its presets from";
    case "notInstalled":
      return "is an instance of a component that is not installed";
    case "noPageBank":
      return `is a component instance whose component holds no preset bank targeting ${PAGE_TARGET}`;
  }
}

/** The catalogue a bus's preset commands read, when one is attached (`bank-view.ts`). */
export function presetCatalogueOf(bus: object): PresetCatalogue | undefined {
  return presetCatalogueHolderFor(bus).current ?? undefined;
}

/** A node as a bank with no catalogue: what a caller holding a bare Presets node means. */
function asView(bank: GraphNode | BankView): BankView {
  return "holder" in bank ? bank : { kind: "node", holder: bank, bank, currentKey: "current", morphsKey: "morphs" };
}

/**
 * The bank a command names — a Presets node, or (T1505b) a component instance whose
 * definition holds a page bank — or the refusal that says why `nodeId` is not one.
 */
export function requireBank(
  graph: GraphDocument,
  nodeId: unknown,
  catalogue: PresetCatalogue | undefined,
): { ok: true; view: BankView; bank: PresetBank } | { ok: false; diagnostic: RuntimeDiagnostic } {
  if (typeof nodeId !== "string") {
    return { ok: false, diagnostic: diagnostic("error", "preset.bank.missing", "No bank node was named.") };
  }
  const node = graph.nodes[nodeId];
  if (node === undefined) {
    // T1505b: a flattened id (`outer/city`) is inside an instance. v1 stores and recalls a
    // look's presets on an instance in the ROOT graph only — nothing at the root writes a
    // nested instance's page.
    const entered = enteredThrough(nodeId);
    const head = entered === undefined ? undefined : graph.nodes[entered.instance];
    if (entered !== undefined && head !== undefined && isComponentNodeType(head.type)) {
      // §T1695b: an INNER bank (one that writes the component's own nodes) named from a
      // running instance, which is what an expression on its Recall pulse does. Its values
      // are the component's, one set for every instance, so there is nothing of THIS
      // instance for it to write: refused, and the sentence says so. The same button
      // pressed inside the component edits the component, on purpose.
      const state = readComponentInstance(head);
      const inner = state === null ? undefined : catalogue?.components.get(state.componentId, state.version)?.graph.nodes[entered.rest];
      if (inner !== undefined && isPresetsNode(inner) && !isPageBank(inner)) {
        return {
          ok: false,
          diagnostic: diagnostic(
            "error",
            "preset.bank.inner",
            `Bank "${bankName(inner)}" inside component instance "${bankName(head)}" writes the component's own nodes. Those values are the component's, the same for every instance, so a recall fired from a running instance is refused. Nothing was changed.`,
            head.id,
            `Recall it inside the component, where it edits the component for every instance; or target ${PAGE_TARGET} to make it the component's page bank, which is recalled per instance.`,
          ),
        };
      }
      return {
        ok: false,
        diagnostic: diagnostic(
          "error",
          "preset.bank.nested",
          `"${nodeId}" is inside component instance "${bankName(head)}"; a look's presets are stored and recalled on an instance in the root graph, not from inside another component. Nothing was changed.`,
          head.id,
          "Recall a preset of the outer instance instead, or detach it.",
        ),
      };
    }
    return { ok: false, diagnostic: diagnostic("error", "preset.bank.missing", `No node "${nodeId}".`) };
  }
  const lookup = bankOf(node, catalogue?.components);
  if (!lookup.ok) return { ok: false, diagnostic: bankLookupRefusal(lookup, node, `"${bankName(node)}"`) };
  const { view } = lookup;
  if (view.kind === "instance" && node.label === undefined) {
    return {
      ok: false,
      diagnostic: diagnostic("error", "preset.bank.unnamed", `Instance "${node.id}" has no name, and a look's presets reach its page by name.`, node.id, "Name the instance."),
    };
  }
  const parsed = parsePresetBank(view.bank.parameters["presets"]);
  if (!parsed.ok) {
    return {
      ok: false,
      diagnostic: diagnostic(
        "error",
        "preset.bank.malformed",
        `Bank "${bankName(node)}": ${parsed.reason}.`,
        node.id,
        view.kind === "instance"
          ? "Fix the Presets field of the bank inside the component; nothing was changed."
          : "Fix the Presets field in the inspector; nothing was changed.",
      ),
    };
  }
  return { ok: true, view, bank: parsed.bank };
}

/**
 * T1541b — A RECALL PULSE FIRED FROM INSIDE A LOOK (the design doc §1.2 Q4, the gap §T1500b
 * handed over). The pulse watcher runs on the FLATTENED document, so a page bank's `recall`
 * driven by an expression inside the component fires `preset.recall` with the flat id
 * `city/looks` — no root node. When `city` is a ROOT instance and `looks` is the page bank
 * its definition uses, that is the instance's own recall: it is carried out on `city`, one
 * patch, as a press on its strip would be. Anything deeper (`outer/city/looks`) is a nested
 * instance and stays refused by name in `requireBank` (`preset.bank.nested`), as is an inner
 * bank that is not the page bank (it would rewrite the definition).
 */
function pageBankPulse(graph: GraphDocument, nodeId: unknown, catalogue: PresetCatalogue | undefined): { instanceId: NodeId; flatId: string } | null {
  if (typeof nodeId !== "string" || graph.nodes[nodeId] !== undefined) return null;
  // One level only: the rest of the id is the bank's own, with no instance inside it.
  const entered = enteredThrough(nodeId);
  if (entered === undefined || enteredThrough(entered.rest) !== undefined) return null;
  const lookup = bankOf(graph.nodes[entered.instance], catalogue?.components);
  if (!lookup.ok || lookup.view.kind !== "instance" || lookup.view.bank.id !== entered.rest) return null;
  return { instanceId: entered.instance, flatId: nodeId };
}

/**
 * T1505b §1.2 Q5 — Store and Recall on a PAGE bank inside a definition session are refused:
 * there is no instance whose page could be captured or written, and a recall there would
 * rewrite the definition for every instance. A bank that targets internal nodes is not a
 * page bank and keeps working with the session's own undo.
 */
function inDefinitionRefusal(view: BankView, catalogue: PresetCatalogue | undefined, verb: "Store" | "Recall"): RuntimeDiagnostic | null {
  if (catalogue === undefined || catalogue.host === null || view.kind !== "node" || !isPageBank(view.bank)) return null;
  return diagnostic(
    "error",
    "preset.bank.inDefinition",
    `${verb} on bank "${bankName(view.holder)}" is refused inside the component: it targets ${PAGE_TARGET}, the page of an instance, and there is no instance here. Store and recall from an instance.`,
    view.holder.id,
    "Leave the component and use the instance's Presets section.",
  );
}

type Skip = (name: string, code: string, message: string, nodeId?: NodeId) => void;

/**
 * T1505b — a page bank's preset, spelled for the ROOT graph the planner resolves names in:
 * its `parent` values keyed by the instance's name. A page bank reaches only its
 * instance's published page, so values for any other name, and `on` / `recalls` (which
 * would name nodes inside the component), are skipped, each said by name.
 */
function rootPreset(view: BankView, preset: Preset, skip: Skip): Preset {
  if (view.kind === "node") return preset;
  const instance = bankName(view.holder);
  const values: Record<string, Readonly<Record<string, StoredParameter>>> = {};
  const who = `Preset "${preset.name}" (${instance})`;
  for (const [name, record] of Object.entries(preset.values)) {
    if (name === PAGE_TARGET) values[instance] = record;
    else skip(name, "preset.page.notParent", `${who} holds values for "${name}", and a look's preset reaches only its own page (${PAGE_TARGET}); skipped.`, view.holder.id);
  }
  for (const layer of Object.keys(preset.on ?? {})) {
    skip(`${layer}.on`, "preset.page.on", `${who} switches "${layer}", which is inside the component; a look's preset reaches only its page, so it was skipped.`, view.holder.id);
  }
  for (const recall of preset.recalls ?? []) {
    skip(`${recall.bank}.${recall.preset}`, "preset.page.recalls", `${who} recalls "${recall.preset}" from "${recall.bank}", which is inside the component; skipped.`, view.holder.id);
  }
  return { name: preset.name, values, ...(preset.morph === undefined ? {} : { morph: preset.morph }) };
}

/** Records as a holder stores them: an instance keeps them under `parent`, so a rename never touches them. */
function storedRecords(view: BankView, records: readonly MorphRecord[]): string {
  return serializeMorphRecords(view.kind === "instance" ? renameRecordsNode(records, bankName(view.holder), PAGE_TARGET) : records);
}

/** The holder kind of a bank the planner only knows by id (one whose records lost keys). */
function holderView(graph: GraphDocument, nodeId: NodeId, catalogue: RecallCatalogue | undefined): BankView | undefined {
  const lookup = bankOf(graph.nodes[nodeId], catalogue?.components);
  if (lookup.ok) return lookup.view;
  // No catalogue to confirm it, but an instance holding records holds them under `presetMorphs`.
  const node = graph.nodes[nodeId];
  return node !== undefined && isComponentNodeType(node.type)
    ? { kind: "instance", holder: node, bank: node, currentKey: PRESET_CURRENT_KEY, morphsKey: PRESET_MORPHS_KEY }
    : undefined;
}

/** A parameter's definition by key, component keys (`color.r`, §V113) included. */
function definitionFor(schema: ParameterSchema, key: string): ParameterDefinition | undefined {
  return schema[key] ?? componentAddressedDefinition(schema, key);
}

/**
 * What a key holds when nothing is stored for it — written into the preset so a recall
 * RESETS it (the design doc §4.3). A component key with nothing of its own follows its
 * compound, so it captures the compound's static component rather than the manifest's.
 */
function unstoredValue(node: GraphNode, schema: ParameterSchema, key: string, definition: ParameterDefinition): StoredParameter {
  const parsed = parseComponentKey(key);
  const base = parsed === null || schema[key] !== undefined ? undefined : schema[parsed.base];
  if (parsed !== null && base !== undefined) {
    const tuple = storedStaticValue(node.parameters[parsed.base]);
    const index = componentNamesFor(base)?.indexOf(parsed.component) ?? -1;
    const component = Array.isArray(tuple) && index >= 0 ? tuple[index] : undefined;
    if (typeof component === "number") return component;
  }
  return defaultParameterValue(definition);
}

/** A stored value, detached from the (frozen) document it was read from. */
function copied(stored: StoredParameter): StoredParameter {
  return JSON.parse(JSON.stringify(stored)) as StoredParameter;
}

export interface PresetCapture {
  readonly values: PresetValues;
  /** T1771b: node NAME → on (not bypassed), for every `name.@on` target. */
  readonly on: Readonly<Record<string, boolean>>;
  readonly captured: number;
  /** Target tokens (or `node.key`) that could not be captured. */
  readonly missing: readonly string[];
  readonly diagnostics: readonly RuntimeDiagnostic[];
}

/**
 * Store's capture (the design doc §4.3, ruling 3): every non-pulse parameter of a whole
 * target — a component instance's published page, since that IS its effective schema —
 * or just the named `node.key`, each AS STORED (a slot stays a slot, ruling 2).
 *
 * B261: of a whole Slider, Toggle, Button or XY Pad that is the keys a hand moves, not
 * its channel, caption, range or step; and a control's default is never captured, whole or
 * named (T1619b). Which keys those are is the controls' own table (`presetHolds`).
 */
export function capturePresetValues(
  graph: GraphDocument,
  registry: NodeRegistryView,
  bankNodeId: NodeId,
  targets: readonly PresetTarget[],
): PresetCapture {
  const values: Record<string, Record<string, StoredParameter>> = {};
  const on: Record<string, boolean> = {};
  const missing: string[] = [];
  const diagnostics: RuntimeDiagnostic[] = [];
  const skip = (name: string, code: string, message: string, nodeId?: NodeId): void => {
    missing.push(name);
    diagnostics.push(diagnostic("warning", code, message, nodeId));
  };

  for (const target of targets) {
    const nodeId = nodeByName(graph, target.node);
    const node = nodeId === undefined ? undefined : graph.nodes[nodeId];
    if (node === undefined) {
      skip(target.token, "preset.target.missing", `Target "${target.token}": no node is named "${target.node}".`);
      continue;
    }
    if (node.id === bankNodeId) {
      skip(target.token, "preset.target.self", `Target "${target.token}" is the bank itself; a bank does not store its own presets.`, node.id);
      continue;
    }
    // T1771b: `name.@on` asks for the node's switch, whatever its type; it is no parameter.
    if (target.key === PRESET_ON_TARGET_KEY) {
      on[target.node] = node.ui?.bypassed !== true;
      continue;
    }
    const definition = registry.get(node.type);
    if (definition === undefined) {
      skip(target.token, "preset.target.unknownType", `Target "${target.token}" is a ${node.type} node this build does not know.`, node.id);
      continue;
    }
    const schema = effectiveParameterSchema(definition, node.parameters);
    const record = (values[target.node] ??= {});
    if (target.key !== undefined) {
      const keyDefinition = definitionFor(schema, target.key);
      // T1619b: a control's default is not a preset's to hold, even named (`presetHolds`).
      if (keyDefinition === undefined || keyDefinition.type === "pulse" || PRESET_STATE_KEYS.has(target.key) || !presetHolds(node.type, target.key, false)) {
        skip(target.token, "preset.target.key", `Target "${target.token}": "${target.node}" has no storable parameter "${target.key}".`, node.id);
        continue;
      }
      const stored = node.parameters[target.key];
      record[target.key] = stored === undefined ? unstoredValue(node, schema, target.key, keyDefinition) : copied(stored);
      continue;
    }
    for (const [key, keyDefinition] of Object.entries(schema)) {
      // T1505b: an instance's own preset state is not part of the look it captures.
      if (keyDefinition.type === "pulse" || PRESET_STATE_KEYS.has(key)) continue;
      // B261: of a whole CONTROL a preset holds what a hand moves, not its range, caption or default.
      if (!presetHolds(node.type, key, true)) continue;
      const stored = node.parameters[key];
      record[key] = stored === undefined ? defaultParameterValue(keyDefinition) : copied(stored);
    }
    // A compound stored per component (§V113) is part of "every parameter" too.
    for (const key of Object.keys(node.parameters).sort()) {
      const stored = node.parameters[key];
      if (stored !== undefined && schema[key] === undefined && isComponentKeyOf(schema, key)) record[key] = copied(stored);
    }
  }

  for (const name of Object.keys(values)) {
    if (Object.keys(values[name] ?? {}).length === 0) delete values[name];
  }
  const captured = Object.values(values).reduce((sum, record) => sum + Object.keys(record).length, 0) + Object.keys(on).length;
  return { values, on, captured, missing, diagnostics };
}

export interface PresetRecallPlan {
  /**
   * One `setParameters` per target node, one `setNodeUi` per layer switched, then the
   * bank's `current` (with its `morphs` when they changed), then every other bank the
   * recall touched: a nested bank's `current` (T1499b), a bank whose records lost keys.
   * Empty when nothing applies.
   */
  readonly operations: readonly GraphPatchOperation[];
  /** `node.key` for every value written, and `layer.on` for every layer switched. */
  readonly applied: readonly string[];
  readonly skipped: readonly string[];
  readonly diagnostics: readonly RuntimeDiagnostic[];
  /** T1497b: the morph a record was written for, or `null` when this recall is a cut. */
  readonly morph: MorphSpec | null;
  /**
   * T1499b: the preset's `recalls` cannot be expanded at all (a cycle, or nested too
   * deep). `operations` and `applied` are empty and `diagnostics` holds the error that
   * names why — so a caller that refuses on "nothing applied" already refuses this.
   */
  readonly refused: boolean;
  /**
   * T1508b: node NAME → key → the stored form this recall writes, for every value in
   * `applied` — the recall's END, which a timeline cue applies as a driver without writing
   * it (`presetRecallEnd`). Layer switches are not in it: they are `setNodeUi` operations.
   */
  readonly after: Readonly<Record<string, Readonly<Record<string, StoredParameter>>>>;
}

/**
 * T1508b — WHAT A RECALL WOULD LEAVE ON SCREEN, without doing it: the planner's `after` map
 * (shots expanded, ruling 4's skips applied — the same planner a pad and a GO run, so a
 * timed cue cannot disagree with a fired one about a preset), the layers it would switch and
 * which way (§T1537b: a timed cue switches them at its time, through a recompile), and the
 * planner's own warnings. A cut with no clock, so no morph record is planned and nothing
 * reads a clock (§V44).
 *
 * T1541b: `bank` may be a look's instance (its `BankView`), and `components` lets a shot
 * recall one — the catalogue GO reads off the bus, handed in by the morph index.
 */
export function presetRecallEnd(
  graph: GraphDocument,
  registry: NodeRegistryView,
  bank: GraphNode | BankView,
  preset: Preset,
  components?: BankCatalogue,
): Pick<PresetRecallPlan, "after" | "skipped" | "diagnostics" | "refused"> & {
  readonly layers: ReadonlyArray<{ readonly nodeId: NodeId; readonly bypassed: boolean }>;
} {
  const plan = planPresetRecall(graph, registry, bank, preset, components === undefined ? {} : { catalogue: { components } });
  const layers = plan.operations.flatMap((operation) =>
    operation.op === "setNodeUi" && typeof operation.ui["bypassed"] === "boolean" ? [{ nodeId: operation.nodeId, bypassed: operation.ui["bypassed"] }] : [],
  );
  return { after: plan.after, skipped: plan.skipped, diagnostics: plan.diagnostics, refused: plan.refused, layers };
}

export interface PresetRecallPlanOptions {
  /**
   * T1497b: the morph this recall is carried out with, ALREADY DECIDED by §5.1's precedence
   * (`presetMorph`). Absent, or zero seconds, is a cut.
   */
  readonly morph?: MorphSpec | undefined;
  /** The app's frame clock (`CommandContext.frameClock`). Absent = no app; a morph cuts. */
  readonly clock?: FrameClock | undefined;
  /**
   * T1505b: the component catalogue, so a shot can recall a look by naming its instance.
   * Absent (a bus with none), such a recall is skipped with a warning that names it.
   * T1541b: only its lookup is read, so the morph index can hand in the flattening's.
   */
  readonly catalogue?: RecallCatalogue | undefined;
}

/** What the planner reads of a catalogue: the definitions a look's instance is a bank through. */
type RecallCatalogue = { readonly components: BankCatalogue };

/**
 * The value a recall writes for one key. A slot goes back verbatim; a bare value over a
 * SLOT becomes that slot in static mode, or `setParameters` would keep the slot's mode
 * and the recall would leave an expression in effect (§B166's merge, working as meant).
 */
function recallValue(existing: StoredParameter | undefined, stored: StoredParameter): StoredParameter {
  if (isParameterSlot(stored) || !isParameterSlot(existing)) return stored;
  return { mode: "static", bindings: { ...existing.bindings, static: { kind: "static", value: stored } } };
}

/**
 * T1499b — HOW DEEP A SHOT'S `recalls` MAY NEST (ruling 14: "depth 4"). The recalled
 * preset is depth 0 and each `recalls` hop is one deeper, so a shot may reach four banks
 * down a chain and a fifth hop is refused.
 */
export const MAX_RECALL_DEPTH = 4;

/** One preset on a recall's expansion, and how many `recalls` hops it sits from the recalled one. */
interface RecallStep {
  /** The holder: the bank node, or (T1505b) the instance that is the bank from outside. */
  readonly bank: GraphNode;
  readonly view: BankView;
  /** Spelled for the root graph (`rootPreset`): an instance bank's `parent` is its name here. */
  readonly preset: Preset;
  readonly depth: number;
}

/** A value on the merged map, and the preset that had the last word on it. */
interface Laid<T> {
  readonly value: T;
  readonly from: RecallStep;
}

/** How a message names the preset an entry came from: the recalled one bare, a nested one with its bank. */
function said(step: RecallStep): string {
  return step.depth === 0 ? `Preset "${step.preset.name}"` : `Preset "${step.preset.name}" (${bankName(step.bank)})`;
}

const quotedList = (names: readonly string[]): string =>
  names.length < 2 ? `"${names[0] ?? ""}"` : `${names.slice(0, -1).map((name) => `"${name}"`).join(", ")} and "${names.at(-1) ?? ""}"`;

/**
 * T1499b — a preset's `recalls`, expanded depth-first (the design doc §4.4 step 2) into
 * the order their values are LAID: a preset's recalls first, in the order written, then
 * the preset itself, so the recalled preset comes last and its own values win.
 *
 * A cycle or a chain deeper than `MAX_RECALL_DEPTH` returns the refusal instead. A cycle
 * is the same (bank, preset) pair met again on the path that led to it — two presets of
 * one bank on a chain is not one, and ends.
 */
function expandRecalls(
  graph: GraphDocument,
  top: RecallStep,
  skip: Skip,
  catalogue: RecallCatalogue | undefined,
): { ok: true; steps: readonly RecallStep[] } | { ok: false; diagnostic: RuntimeDiagnostic } {
  const steps: RecallStep[] = [];
  const path: RecallStep[] = [];
  const spelled = (chain: readonly RecallStep[]): string => chain.map((step) => `${bankName(step.bank)}.${step.preset.name}`).join(" → ");
  const recalling = `Recalling "${top.preset.name}" (${bankName(top.bank)})`;

  const visit = (step: RecallStep): RuntimeDiagnostic | null => {
    path.push(step);
    for (const recall of step.preset.recalls ?? []) {
      const entry = `${recall.bank}.${recall.preset}`;
      const asks = `${said(step)} recalls "${recall.preset}" from "${recall.bank}"`;
      const bankId = nodeByName(graph, recall.bank);
      const bank = bankId === undefined ? undefined : graph.nodes[bankId];
      if (bank === undefined) {
        skip(entry, "preset.recalls.missing", `${asks}, and no node is named "${recall.bank}"; skipped.`, step.bank.id);
        continue;
      }
      // T1505b: a shot may recall a look's preset by naming its instance.
      const lookup = bankOf(bank, catalogue?.components);
      if (!lookup.ok) {
        const code = lookup.why === "notBank" ? "preset.recalls.type" : `preset.recalls.${lookup.why}`;
        skip(entry, code, `${asks}, and "${recall.bank}" ${notABank(lookup.why, bank)}; skipped.`, bank.id);
        continue;
      }
      const parsed = parsePresetBank(lookup.view.bank.parameters["presets"]);
      if (!parsed.ok) {
        skip(entry, "preset.recalls.malformed", `${asks}, and bank "${recall.bank}" cannot be read (${parsed.reason}); skipped.`, bank.id);
        continue;
      }
      const found = parsed.bank.presets.find((candidate) => candidate.name === recall.preset);
      if (found === undefined) {
        skip(entry, "preset.recalls.unknown", `${asks}, and bank "${recall.bank}" has no preset "${recall.preset}"; skipped.`, bank.id);
        continue;
      }
      const preset = rootPreset(lookup.view, found, skip);
      const next: RecallStep = { bank, view: lookup.view, preset, depth: step.depth + 1 };
      const loop = path.findIndex((on) => on.bank.id === bank.id && on.preset.name === preset.name);
      if (loop >= 0) {
        const cycle = [...path.slice(loop), next];
        const banks = [...new Set(cycle.map((on) => bankName(on.bank)))];
        return diagnostic(
          "error",
          "preset.recall.cycle",
          `${recalling} goes round in a circle: ${spelled(cycle)}. ${
            banks.length === 1 ? `Bank ${quotedList(banks)} recalls itself` : `Banks ${quotedList(banks)} recall each other`
          }; nothing was changed.`,
          step.bank.id,
          "Take one of those recalls out of the Presets field.",
        );
      }
      if (next.depth > MAX_RECALL_DEPTH) {
        return diagnostic(
          "error",
          "preset.recall.depth",
          `${recalling} nests its recalls ${String(next.depth)} deep (${spelled([...path, next])}); the limit is ${String(MAX_RECALL_DEPTH)}. Nothing was changed.`,
          step.bank.id,
          "Recall the deeper presets from the shot itself.",
        );
      }
      const refusal = visit(next);
      if (refusal !== null) return refusal;
    }
    path.pop();
    steps.push(step);
    return null;
  };

  const refusal = visit(top);
  return refusal === null ? { ok: true, steps } : { ok: false, diagnostic: refusal };
}

/**
 * THE recall planner (the design doc §4.4 steps 2, 3 and 5): expands the preset's
 * `recalls`, resolves every node name in `graph` NOW, checks each key against that node's
 * effective schema, and builds the operations for the one patch. Pure — no bus, no store —
 * so the cue list's GO (§T1500b) runs exactly this and a pad recall and a cue recall
 * cannot disagree.
 */
export function planPresetRecall(
  graph: GraphDocument,
  registry: NodeRegistryView,
  bank: GraphNode | BankView,
  recalled: Preset,
  options: PresetRecallPlanOptions = {},
): PresetRecallPlan {
  const operations: GraphPatchOperation[] = [];
  const applied: string[] = [];
  const skipped: string[] = [];
  const diagnostics: RuntimeDiagnostic[] = [];
  /** T1497b: node NAME → key → the stored form before / after, for every key written. */
  const before: Record<string, Record<string, StoredParameter>> = {};
  const after: Record<string, Record<string, StoredParameter>> = {};
  const skip = (name: string, code: string, message: string, nodeId?: NodeId): void => {
    skipped.push(name);
    diagnostics.push(diagnostic("warning", code, message, nodeId));
  };

  // T1505b: the bank may be an instance, whose preset reads `parent` for its own page.
  const view = asView(bank);
  const bankNode = view.holder;
  const preset = rootPreset(view, recalled, skip);
  const { catalogue } = options;
  const expansion = expandRecalls(graph, { bank: bankNode, view, preset, depth: 0 }, skip, catalogue);
  if (!expansion.ok) {
    return { operations: [], applied: [], skipped, diagnostics: [...diagnostics, expansion.diagnostic], morph: null, refused: true, after: {} };
  }

  /*
   * T1499b: ONE map for the whole shot, laid in expansion order, so whatever is laid later
   * wins — a nested preset under the one that recalls it, the recalled preset over all.
   * Everything below reads this map, never a preset, which is why a shot is one patch and
   * its morph one record.
   */
  const values = new Map<string, Map<string, Laid<StoredParameter>>>();
  const layers = new Map<string, Laid<boolean>>();
  for (const step of expansion.steps) {
    for (const [nodeName, record] of Object.entries(step.preset.values)) {
      // An instance bank IS its own target (T1505b): the skip is for a Presets node only.
      if (step.view.kind === "node" && nodeByName(graph, nodeName) === step.bank.id) {
        skip(nodeName, "preset.target.self", `${said(step)} holds values for the bank itself; they were skipped.`, step.bank.id);
        continue;
      }
      const laid = values.get(nodeName) ?? new Map<string, Laid<StoredParameter>>();
      values.set(nodeName, laid);
      for (const [key, stored] of Object.entries(record)) {
        // A compound laid over ANOTHER preset's per-component slot (`color` over `color.r`,
        // §V113) takes the channel too, or the nested value would still win it.
        for (const [other, under] of laid) {
          if (under.from !== step && parseComponentKey(other)?.base === key) laid.delete(other);
        }
        laid.set(key, { value: stored, from: step });
      }
    }
    for (const [nodeName, on] of Object.entries(step.preset.on ?? {})) layers.set(nodeName, { value: on, from: step });
  }
  /** The presets something was actually written from. */
  const wrote = new Set<RecallStep>();

  for (const nodeName of [...values.keys()].sort()) {
    const record = values.get(nodeName) ?? new Map<string, Laid<StoredParameter>>();
    /** A node-level skip is said once per preset that held values for the node. */
    const skipNode = (code: string, message: (who: string) => string, nodeId?: NodeId): void => {
      skipped.push(nodeName);
      for (const from of new Set([...record.values()].map((laid) => laid.from))) {
        diagnostics.push(diagnostic("warning", code, message(said(from)), nodeId));
      }
    };
    const nodeId = nodeByName(graph, nodeName);
    const node = nodeId === undefined ? undefined : graph.nodes[nodeId];
    if (node === undefined) {
      skipNode("preset.target.missing", (who) => `${who}: no node is named "${nodeName}"; its values were skipped.`);
      continue;
    }
    const definition = registry.get(node.type);
    if (definition === undefined) {
      skipNode("preset.target.unknownType", (who) => `${who}: "${nodeName}" is a ${node.type} node this build does not know; skipped.`, node.id);
      continue;
    }
    // T1532b: the keys are checked against the node's schema AFTER this recall's writes — a
    // preset holding a 4 × 4 Grid Warp brings the points a 3 × 3 node does not declare yet.
    const recalled = Object.fromEntries([...record].map(([key, laid]) => [key, laid.value]));
    const schema = effectiveParameterSchema(definition, { ...node.parameters, ...recalled });
    const writes: Record<string, StoredParameter> = {};
    for (const [key, laid] of [...record].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      const stored = laid.value;
      const who = said(laid.from);
      const name = `${nodeName}.${key}`;
      const keyDefinition = definitionFor(schema, key);
      // T1505b: an instance's own preset state is written below, never from a preset's values.
      if (keyDefinition === undefined || PRESET_STATE_KEYS.has(key)) {
        skip(name, "preset.target.key", `${who}: "${nodeName}" has no parameter "${key}"; skipped.`, node.id);
        continue;
      }
      if (keyDefinition.type === "pulse") {
        skip(name, "preset.target.pulse", `${who}: "${name}" is a pulse, which fires rather than holds a value; skipped.`, node.id);
        continue;
      }
      // T1619b: a preset written by hand may name a control's default. A recall never moves one.
      if (!presetHolds(node.type, key, false)) {
        skip(name, "preset.target.default", `${who}: "${name}" is a control's default, which a recall never changes; skipped.`, node.id);
        continue;
      }
      const invalid = validateParameters(schema, { [key]: stored }, node.id);
      if (invalid.length > 0) {
        skip(name, "preset.value.invalid", `${who}: the value for "${name}" does not fit it (${invalid[0]?.message ?? "invalid"}); skipped.`, node.id);
        continue;
      }
      writes[key] = recallValue(node.parameters[key], stored);
      applied.push(name);
      wrote.add(laid.from);
      // What the key holds NOW, as a slot a fade can start from: nothing stored is the
      // default Store would have captured for it (`unstoredValue`).
      (before[nodeName] ??= {})[key] = node.parameters[key] ?? unstoredValue(node, schema, key, keyDefinition);
      (after[nodeName] ??= {})[key] = writes[key] as StoredParameter;
    }
    if (Object.keys(writes).length === 0) continue;
    operations.push({ op: "setParameters", nodeId: node.id, parameters: writes });

    // A component slot (`color.r`) the preset does not cover still overrides the compound
    // it just wrote. Not skipped — nothing was refused — but said, so it is not a mystery.
    for (const key of Object.keys(node.parameters).sort()) {
      const parsed = parseComponentKey(key);
      if (parsed === null || writes[key] !== undefined || writes[parsed.base] === undefined) continue;
      if (!isComponentKeyOf(schema, key)) continue;
      diagnostics.push(
        diagnostic(
          "warning",
          "preset.recall.componentOverride",
          `Preset "${preset.name}" sets "${nodeName}.${parsed.base}", and "${nodeName}.${key}" holds its own value that still overrides that channel.`,
          node.id,
        ),
      );
    }
  }

  /*
   * T1771b — THE EXCLUSIVE CHOICE LEFT PARTIAL. A bank whose presets each switch the same set
   * of nodes is a selector: whichever is recalled, every node of the set is told on or off.
   * A preset that switches SOME of what its siblings switch leaves the rest as it found
   * them, so what is on after it depends on what was recalled before. That is legitimate
   * (a preset may mean "and leave the others"), so it is a remark and nothing is skipped; a
   * preset with no `on` row at all is a plain value preset and is not remarked on.
   */
  if (view.kind === "node" && Object.keys(preset.on ?? {}).length > 0) {
    const parsed = parsePresetBank(view.bank.parameters["presets"]);
    const own = new Set(Object.keys(preset.on ?? {}));
    const left = parsed.ok ? [...new Set(parsed.bank.presets.flatMap((each) => Object.keys(each.on ?? {})))].filter((name) => !own.has(name)).sort() : [];
    if (left.length > 0) {
      diagnostics.push(
        diagnostic(
          "warning",
          "preset.on.partial",
          `Preset "${preset.name}" (${bankName(bankNode)}) switches ${[...own].sort().map((name) => `"${name}"`).join(", ")} and leaves ${left.map((name) => `"${name}"`).join(", ")} as ${left.length === 1 ? "it is" : "they are"}: other presets of this bank switch ${left.length === 1 ? "it" : "them"}, so what is on after this recall depends on the one before.`,
          bankNode.id,
          `Give "${preset.name}" an on/off for ${left.map((name) => `"${name}"`).join(", ")} too, so the bank chooses exactly one state.`,
        ),
      );
    }
  }

  // On/off (the design doc §4.4 step 5, §7.2; any node, T1770b): the bypass flag, in the same patch.
  for (const layerName of [...layers.keys()].sort()) {
    const laid = layers.get(layerName);
    if (laid === undefined) continue;
    const name = `${layerName}.on`;
    const nodeId = nodeByName(graph, layerName);
    const node = nodeId === undefined ? undefined : graph.nodes[nodeId];
    if (node === undefined) {
      skip(name, "preset.on.missing", `${said(laid.from)}: no node is named "${layerName}"; its on/off was skipped.`);
      continue;
    }
    operations.push({ op: "setNodeUi", nodeId: node.id, ui: { bypassed: !laid.value } });
    applied.push(name);
    wrote.add(laid.from);
  }

  /*
   * T1499b: every OTHER bank a preset was actually written from shows that preset as its
   * `current`. A bank reached twice shows the later one; the recalled bank's own is below.
   */
  const elsewhere = new Map<NodeId, Record<string, StoredParameter>>();
  for (const step of expansion.steps) {
    if (step.bank.id !== bankNode.id && wrote.has(step)) elsewhere.set(step.bank.id, { [step.view.currentKey]: step.preset.name });
  }

  let morph: MorphSpec | null = null;
  if (operations.length > 0) {
    const { clock } = options;
    const asked = options.morph !== undefined && options.morph.seconds > 0 ? options.morph : null;
    if (asked !== null && clock === undefined) {
      // §V338: name what would make it present. The values below land regardless.
      diagnostics.push(
        diagnostic(
          "info",
          "preset.recall.morphUnavailable",
          `Preset "${preset.name}" asks for a ${String(asked.seconds)} s morph, but no frame clock is attached here, so it was recalled as a cut.`,
          bankNode.id,
          "A morph fades on the running app's transport; a headless bus has no transport, and the end state is what it commits.",
        ),
      );
    }

    // T1505b: an instance's records are read under its name, like every other bank's
    // (`bankMorphRecords`), so a shot's record and the look's own chain on one key.
    const own = heldMorphRecords(view);
    const others = new Map(
      bankMorphRecords(graph)
        .filter((bank) => bank.bankId !== bankNode.id)
        .map((bank) => [bank.bankId, bank.records] as const),
    );
    /** A key some record is still fading: it MOVES on screen even where this recall changes nothing. */
    const moving = (nodeName: string, key: string): boolean =>
      clock !== undefined &&
      [own, ...others.values()].some((records) =>
        records.some((record) => morphRunning(record, clock) && record.to[nodeName]?.[key] !== undefined),
      );

    let record: MorphRecord | null = null;
    if (asked !== null && clock !== undefined) {
      const from: Record<string, Record<string, StoredParameter>> = {};
      const to: Record<string, Record<string, StoredParameter>> = {};
      for (const [nodeName, keys] of Object.entries(after)) {
        for (const [key, written] of Object.entries(keys)) {
          const held = before[nodeName]?.[key];
          if (held === undefined || (sameStored(held, written) && !moving(nodeName, key))) continue;
          (from[nodeName] ??= {})[key] = copied(held);
          (to[nodeName] ??= {})[key] = copied(written);
        }
      }
      if (Object.keys(to).length > 0) {
        record = { epoch: clock.epoch, start: clock.absTimeSeconds, seconds: asked.seconds, curve: asked.curve, preset: preset.name, from, to };
        morph = asked;
      }
    }

    const book = nextMorphRecords({
      own,
      others,
      clock,
      applied: Object.fromEntries(Object.entries(after).map(([nodeName, keys]) => [nodeName, Object.keys(keys)])),
      record,
    });
    for (const gone of book.dropped) {
      diagnostics.push(
        diagnostic(
          "warning",
          "preset.recall.morphDropped",
          `Bank "${bankName(bankNode)}" already had ${String(MAX_MORPH_RECORDS)} morphs running, so the oldest ("${gone.preset}") was dropped; the keys only it covered jumped to their end values.`,
          bankNode.id,
        ),
      );
    }
    const morphs = storedRecords(view, book.own);
    operations.push({
      op: "setParameters",
      nodeId: bankNode.id,
      // Written only when the list actually changes, so a cut on a bank with nothing
      // fading is the same one-key write it was before morphs existed.
      parameters: { [view.currentKey]: preset.name, ...(morphs === storedRecords(view, own) ? {} : { [view.morphsKey]: morphs }) },
    });
    for (const [bankId, records] of book.others) {
      const holder = holderView(graph, bankId, catalogue);
      if (holder === undefined) continue;
      elsewhere.set(bankId, { ...elsewhere.get(bankId), [holder.morphsKey]: storedRecords(holder, records) });
    }
    for (const bankId of [...elsewhere.keys()].sort()) {
      operations.push({ op: "setParameters", nodeId: bankId, parameters: elsewhere.get(bankId) ?? {} });
    }
  }
  return { operations, applied, skipped, diagnostics, morph, refused: false, after };
}

/**
 * §T1557b — A BANK'S OWN SETTINGS (Select, Morph, Curve) AT THIS MOMENT, through the one read
 * path (§V61) and a read scope (`CommandContext.readScope`, `LoomBus.readScope`).
 *
 * This read used to be `{ channels }` alone — no cross-node reader — so `op('k1').chan.value`
 * on a bank's Morph fell back to its retained static while the channel said otherwise
 * (§B181's shape), here and in the three other readers of these settings (the cue list's GO,
 * `list_presets`, and a Recall pulse fired inside a look, which reads its flat bank directly).
 *
 * An INSTANCE bank's settings live on its component's page bank, a node of the DEFINITION's
 * graph: no live channel, morph or `op()` name of the root document belongs to it, and the
 * per-instance read is the flat bank a pulse names. So it is read as the document holds it
 * (`resolveStored`), which is what this read always was for it.
 */
export function bankSettings(view: BankView, registry: NodeRegistryView, scope: ParameterReadContext): Readonly<Record<string, unknown>> {
  const definition = registry.get(view.bank.type);
  if (view.kind === "instance") return resolveStored(view.bank, definition).values;
  return resolveParameters(view.bank, definition, parameterReadOptions(scope)).values;
}

/** A `MorphSpec` off the wire, or `null` when it is not one. */
function readMorphSpec(raw: unknown): MorphSpec | null {
  if (typeof raw !== "object" || raw === null) return null;
  const { seconds, curve } = raw as { seconds?: unknown; curve?: unknown };
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) return null;
  if (!MORPH_CURVES.includes(curve as MorphCurve)) return null;
  return { seconds, curve: curve as MorphCurve };
}

/**
 * WHICH morph a recall is carried out with (the design doc §5.1): the first present of the
 * caller's own, the preset's, the bank's `morph` / `curve` parameters. The cue list
 * (§T1500b) passes its cue's morph as `own`, which is where its rung of the ladder sits.
 */
export function presetMorph(own: MorphSpec | undefined, preset: Preset, bank: Readonly<Record<string, unknown>>): MorphSpec {
  if (own !== undefined) return own;
  if (preset.morph !== undefined) return preset.morph;
  return readMorphSpec({ seconds: bank["morph"], curve: bank["curve"] }) ?? { seconds: 0, curve: "smooth" };
}

/** A context whose `apply` always opens a fresh undo group (§V34 "unless explicitly split"). */
function splitUndoContext(context: CommandContext): CommandContext {
  return { ...context, apply: (request) => context.apply({ ...request, splitUndo: true }) };
}

/** The bank's `select`. Empty when unset or not a name. */
function resolvedSelect(bank: Readonly<Record<string, unknown>>): string {
  const select = bank["select"];
  return typeof select === "string" ? select.trim() : "";
}

function storeRefusal(revision: Revision, diagnostics: RuntimeDiagnostic[], missing: readonly string[] = []): CommandOutcome<PresetStoreOutput> {
  return { status: "rejected", revision, diagnostics, output: { ok: false, preset: null, captured: 0, missing } };
}

function recallRefusal(
  revision: Revision,
  diagnostics: RuntimeDiagnostic[],
  preset: string | null = null,
  skipped: readonly string[] = [],
): CommandOutcome<PresetRecallOutput> {
  return { status: "rejected", revision, diagnostics, output: { ok: false, preset, applied: [], skipped, morph: null } };
}

/**
 * T1505b — Store's capture for a bank: its targets as written, or for an instance bank the
 * page bank's `parent` / `parent.<key>` targets captured on the INSTANCE and keyed back to
 * `parent`, so the preset is the definition's and means every instance's own page.
 */
function captureFor(context: CommandContext, view: BankView, targets: readonly PresetTarget[]): PresetCapture {
  if (view.kind === "node") return capturePresetValues(context.graph, context.registry, view.holder.id, targets);
  const instance = bankName(view.holder);
  // T1771b: a look's preset reaches only its page (`preset.page.on` at recall), so it stores no switch.
  const paged = targets.filter((target) => target.key !== PRESET_ON_TARGET_KEY);
  const onInstance = paged.map((target): PresetTarget => ({ ...target, node: instance }));
  // No bank id to skip as "itself": the instance IS the one target.
  const capture = capturePresetValues(context.graph, context.registry, "", onInstance);
  const values = Object.fromEntries(Object.entries(capture.values).map(([name, keys]) => [name === instance ? PAGE_TARGET : name, keys]));
  const refused = targets.filter((target) => target.key === PRESET_ON_TARGET_KEY);
  return {
    ...capture,
    values,
    missing: [...capture.missing, ...refused.map((target) => target.token)],
    diagnostics: [
      ...capture.diagnostics,
      ...refused.map((target) =>
        diagnostic("warning", "preset.page.on", `Target "${target.token}": a look's preset reaches only its page, so it stores no on/off; switch the instance from a bank beside it.`, view.holder.id),
      ),
    ],
  };
}

/**
 * T1505b §1.2 Q5 (owner's ruling) — Store and Delete on an instance bank WRITE THE
 * COMPONENT: the page bank's `presets` in the definition, through the catalogue, exactly as
 * publishing a parameter does (`commitDefinition`, `components/commands.ts`). Every
 * instance gets the change and it travels with the file. Like every definition edit it has
 * no root undo — the document's revision does not move — and the result says so.
 */
export function commitPageBank(
  context: CommandContext,
  catalogue: PresetCatalogue,
  view: BankView,
  presets: readonly Preset[],
): { ok: true; status: "applied" | "validated"; diagnostics: RuntimeDiagnostic[] } | { ok: false; diagnostics: RuntimeDiagnostic[] } {
  const definition = view.definition;
  if (definition === undefined) return { ok: false, diagnostics: [diagnostic("error", "preset.bank.notInstalled", "The component is not installed.", view.holder.id)] };
  const next = withPageBankPresets(definition, view.bank, serializePresetBank({ version: 1, presets }));
  const problems = catalogue.components.validate(next);
  if (problems.some((each) => each.severity === "error")) return { ok: false, diagnostics: problems };
  if (!context.dryRun) catalogue.components.register(next);
  return { ok: true, status: context.dryRun ? "validated" : "applied", diagnostics: problems };
}

/** What a write into the component tells the caller (§1.2 Q5, Q6): who has it, no undo, and the file identity. */
export function componentWriteNote(view: BankView, what: string): RuntimeDiagnostic {
  const component = view.definition?.name ?? bankName(view.holder);
  return diagnostic(
    "info",
    "preset.component.written",
    `${what} component "${component}": every instance of it has the change, and it travels with the component. A component edit has no undo; ${
      what.startsWith("Deleted") ? "Store it again to bring it back" : "Delete is the reverse"
    }. Exported again, the file is a different "${component}" from copies exported before, so a project that holds an older copy takes this one in beside it.`,
    view.holder.id,
  );
}

export function registerPresetCommands(bus: LoomBus): void {
  if (bus.hasCommand(PRESET_STORE_COMMAND)) return;

  bus.registerCommand({
    name: PRESET_STORE_COMMAND,
    inSession: "definition",
    inputSchema: presetStoreInputSchema,
    description:
      "Store a bank's targets, as their whole stored slots, under a preset name (§T1496b). On a component instance whose component holds a preset bank, the preset is written into the component, for every instance (§T1505b).",
    handler: (input, context) => {
      const revision = context.store.getRevision();
      const catalogue = presetCatalogueOf(bus);
      const found = requireBank(context.graph, input?.nodeId, catalogue);
      if (!found.ok) return storeRefusal(revision, [found.diagnostic]);
      const { view, bank } = found;
      const node = view.holder;
      const inside = inDefinitionRefusal(view, catalogue, "Store");
      if (inside !== null) return storeRefusal(revision, [inside]);
      const name = typeof input.name === "string" ? input.name.trim() : "";
      if (!isPresetName(name)) {
        return storeRefusal(revision, [
          diagnostic("error", "preset.name", "A preset name must be an identifier: letters, digits and _, not starting with a digit.", node.id),
        ]);
      }
      const targets = parsePresetTargets(view.bank.parameters["targets"]);
      if (targets.length === 0) {
        return storeRefusal(revision, [
          diagnostic("error", "preset.store.noTargets", `Bank "${bankName(node)}" declares no targets.`, node.id, "Name nodes (or node.key) in its Targets field."),
        ]);
      }
      const capture = captureFor(context, view, targets);
      if (capture.captured === 0) {
        return storeRefusal(
          revision,
          [
            ...capture.diagnostics,
            diagnostic("error", "preset.store.nothing", `Bank "${bankName(node)}": none of its targets could be captured, so "${name}" was not stored.`, node.id),
          ],
          capture.missing,
        );
      }
      const index = bank.presets.findIndex((preset) => preset.name === name);
      // T1771b: the switches the targets asked for (`name.@on`). None asked: a row written by hand stays.
      const switches = Object.keys(capture.on).length === 0 ? {} : { on: capture.on };
      const presets =
        index < 0
          ? [...bank.presets, { name, values: capture.values, ...switches }]
          : bank.presets.map((preset, at) => (at === index ? { ...preset, values: capture.values, ...switches } : preset));
      if (view.kind === "instance" && catalogue !== undefined) {
        const written = commitPageBank(context, catalogue, view, presets);
        if (!written.ok) return storeRefusal(revision, [...capture.diagnostics, ...written.diagnostics], capture.missing);
        return {
          status: written.status,
          revision,
          diagnostics: [...capture.diagnostics, ...written.diagnostics, componentWriteNote(view, `Stored "${name}" into`)],
          output: { ok: true, preset: name, captured: capture.captured, missing: capture.missing },
        };
      }
      const outcome = applyGraphPatch(
        {
          baseRevision: context.graph.revision,
          label: `Store "${name}" (${bankName(node)})`,
          operations: [{ op: "setParameters", nodeId: node.id, parameters: { presets: serializePresetBank({ version: 1, presets }) } }],
        },
        splitUndoContext(context),
      );
      const diagnostics = [...capture.diagnostics, ...(outcome.diagnostics ?? [])];
      const ok = outcome.status === "applied" || outcome.status === "validated";
      return {
        status: outcome.status,
        revision: outcome.revision ?? revision,
        diagnostics,
        ...(outcome.undoGroupId === undefined ? {} : { undoGroupId: outcome.undoGroupId }),
        output: { ok, preset: ok ? name : null, captured: ok ? capture.captured : 0, missing: capture.missing },
      };
    },
    rejectionOutput: () => ({ ok: false, preset: null, captured: 0, missing: [] }),
  });

  bus.registerCommand({
    name: PRESET_RECALL_COMMAND,
    // §T1695b: an inner bank's recall writes the definition; a page bank's page is an
    // instance's, so inside the component it is recalled on the instance in view.
    inSession: {
      definition: true,
      handsUp: "A recall aimed at the component's page bank goes to the instance the editor is viewing: the page it writes is that instance's.",
    },
    inputSchema: presetRecallInputSchema,
    description:
      "Recall a bank's preset: every target it holds written back as one patch, one undo step (§T1496b); with a morph, the end state commits at once and the screen fades to it (§T1497b). A preset's recalls (other banks' presets) and its layer on/off ride in the same patch (§T1499b).",
    handler: (input, context) => {
      const revision = context.store.getRevision();
      const catalogue = presetCatalogueOf(bus);
      // T1541b: a Recall pulse fired INSIDE a look names its page bank by flattened id.
      const pulse = pageBankPulse(context.graph, input?.nodeId, catalogue);
      const found = requireBank(context.graph, pulse?.instanceId ?? input?.nodeId, catalogue);
      if (!found.ok) return recallRefusal(revision, [found.diagnostic]);
      const { view, bank } = found;
      const node = view.holder;
      const inside = inDefinitionRefusal(view, catalogue, "Recall");
      if (inside !== null) {
        // §T1695b: the editor got here through an instance, and that instance's page is what
        // a page bank recalls. The root command takes it from there, as it does for a pulse
        // an expression fired (`pageBankPulse`). With no instance in view the refusal stands.
        const viewed = context.session?.instancePath();
        if (context.session !== undefined && viewed !== undefined && viewed.length > 0) return context.session.handUp();
        return recallRefusal(revision, [inside]);
      }
      // Select, Morph and Curve are the bank's — for an instance, its component's page bank's;
      // for a pulse from inside, that bank as THIS instance flattened it (its published Select).
      const flat = pulse === null ? undefined : bus.flattenedGraph();
      const flatBank = pulse === null ? undefined : flat?.nodes[pulse.flatId];
      const settings =
        flat === undefined || flatBank === undefined
          ? bankSettings(view, context.registry, context.readScope())
          : resolveParameters(flatBank, context.registry.get(flatBank.type), parameterReadOptions({ ...context.readScope(), graph: flat })).values;
      const name = typeof input.name === "string" ? input.name.trim() : resolvedSelect(settings);
      if (name === "") {
        return recallRefusal(revision, [
          diagnostic("error", "preset.recall.noName", `Bank "${bankName(node)}": no preset was named and its Select is empty.`, node.id),
        ]);
      }
      const preset = bank.presets.find((candidate) => candidate.name === name);
      if (preset === undefined) {
        const known = bank.presets.map((candidate) => candidate.name).join(", ");
        return recallRefusal(revision, [
          diagnostic(
            "error",
            "preset.recall.unknown",
            `Bank "${bankName(node)}" has no preset "${name}".`,
            node.id,
            known === "" ? "The bank is empty; Store one first." : `Its presets: ${known}.`,
          ),
        ]);
      }
      const own = input.morph === undefined ? undefined : readMorphSpec(input.morph);
      if (own === null) {
        return recallRefusal(
          revision,
          [
            diagnostic(
              "error",
              "preset.recall.morph",
              `Bank "${bankName(node)}": the morph must be { seconds ≥ 0, curve: ${MORPH_CURVES.join(" | ")} }; nothing was changed.`,
              node.id,
            ),
          ],
          name,
        );
      }
      const plan = planPresetRecall(context.graph, context.registry, view, preset, {
        morph: presetMorph(own, preset, settings),
        clock: context.frameClock,
        catalogue,
      });
      // T1499b: a cycle or too deep a nesting is refused by the planner, which names it.
      if (plan.refused) return recallRefusal(revision, [...plan.diagnostics], name, plan.skipped);
      if (plan.applied.length === 0) {
        // Ruling 4: refused only when NOTHING is left — and then loudly, naming why.
        return recallRefusal(
          revision,
          [
            ...plan.diagnostics,
            diagnostic("error", "preset.recall.nothing", `Preset "${name}" (${bankName(node)}) has nothing left to apply; nothing was changed.`, node.id),
          ],
          name,
          plan.skipped,
        );
      }
      const outcome = applyGraphPatch(
        { baseRevision: context.graph.revision, label: `Recall "${name}" (${bankName(node)})`, operations: [...plan.operations] },
        splitUndoContext(context),
      );
      const diagnostics = [...plan.diagnostics, ...(outcome.diagnostics ?? [])];
      const ok = outcome.status === "applied" || outcome.status === "validated";
      return {
        status: outcome.status,
        revision: outcome.revision ?? revision,
        diagnostics,
        ...(outcome.undoGroupId === undefined ? {} : { undoGroupId: outcome.undoGroupId }),
        output: { ok, preset: name, applied: ok ? plan.applied : [], skipped: plan.skipped, morph: ok ? plan.morph : null },
      };
    },
    rejectionOutput: (input) => ({ ok: false, preset: typeof (input as Partial<PresetRecallInput> | null)?.name === "string" ? (input as PresetRecallInput).name ?? null : null, applied: [], skipped: [], morph: null }),
  });
}
