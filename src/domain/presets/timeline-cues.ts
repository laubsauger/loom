import type { RuntimeDiagnostic } from "../types/diagnostics.ts";
import { fpsOf, subframesOf } from "../types/frame.ts";
import type { FrameEvaluationInput } from "../types/frame.ts";
import type { GraphDocument, GraphNode } from "../types/graph.ts";
import type { NodeId } from "../types/ids.ts";
import type { NodeDefinition } from "../types/node-definition.ts";
import type { ParameterSchema, StoredParameter } from "../types/parameters.ts";
import type { NodeRegistryView } from "../../nodes/registry/registry.ts";
import { isComponentNodeType, parseComponentNodeType } from "../components/component-type.ts";
import { publishedSchema } from "../components/published-page.ts";
import { nodeByName } from "../graph/names.ts";
import { effectiveParameterSchema, resolveStored, type ParameterMorphStep, type ParameterMorphs } from "../parameters/resolve.ts";
import { componentAddressedDefinition, isParameterSlot, parseComponentKey, storedStaticValue } from "../parameters/slots.ts";
import { defaultParameterValue } from "../parameters/validate.ts";
import { parsePresetBank, type MorphCurve } from "./bank.ts";
import { bankOf, type BankCatalogue } from "./bank-view.ts";
import { notABank, presetMorph, presetRecallEnd } from "./commands.ts";
import { CUE_FOLLOW_TIMELINE, CUE_LIST_NODE_TYPE, cueReachFrame, parseCueList, type CueList } from "./cue-list.ts";
import { easeMorph } from "./morph.ts";
import { morphableKey, publishedTargets, type MorphIndexInput } from "./morph-index.ts";

/**
 * T1508b (§T1398b second ruling B) — TIMELINE-PLACED CUES THAT AN EXPORT REPRODUCES: a cue
 * list whose `follow` is `timeline` is a PURE FUNCTION OF THE PLAYHEAD. The design is
 * `docs/presets-followups-design-2026-10-03.md` Part 2; the owner's three rulings are its
 * owner questions, answered "yes" (SPEC §T1508b).
 *
 * ## Values apply as drivers, never as writes
 *
 * A timed cue writes NOTHING. Each cue's end is what its recall WOULD write — the one
 * planner's `after` map (`presetRecallEnd`), so shots expand and ruling 4's skips apply
 * exactly as at GO — computed once per revision, and the resolver folds those ends over the
 * stored slot on `timeSeconds`, inside `buildMorphIndex` (`withTimelineCues`). One index, so
 * the compile, the flattening and the Dawn harness read the same thing (§B8's shape), and an
 * export — which steps the timeline from frame 0 — renders what playback showed. The
 * document's revision is the same after an export as before it.
 *
 * ## The fold on one key (the design doc §2.2 Q2)
 *
 * The cues of every following list that cover the key, in `at` order (ties: list name,
 * then position). Before the first is reached, the key is not the timeline's at all — the
 * stored slot, or a live recall's fade, shows. From the first one on, the timeline OUTRANKS
 * the stored slot and any live morph (owner ruling 1: a fader, a GO or the phone moving a
 * covered key writes the document but does not show until the list is back to live): start
 * from the newest cue that has FINISHED (or the stored slot when none has), and blend each
 * later reached cue in, `V = lerp(V, resolve(to_i), ease_i((t − at_i) / seconds_i))`. A
 * later cue arriving mid-fade therefore continues from what is on screen. Both ends resolve
 * live, so an expression end keeps moving. A key with no in-between (an enum, a string, a
 * boolean) cuts at its cue.
 *
 * Whether a cue is REACHED is a frame index against a per-revision integer (`cueReachFrame`),
 * never `n / fps >= at` as floats. Progress is still `(timeSeconds − at) / seconds`.
 *
 * ## Structural settings switch at the crossings (§T1537b; owner ruling 2's follow-up)
 *
 * A Layer's on/off and a key the compiler reads as structure (`compileTime`, a
 * resolution-policy input, a source reference such as a Layer's `picture`) cannot be a
 * driver: the plan itself differs. So a timed cue CUTS them at its frame, and what changes is
 * the GRAPH THAT IS COMPILED — the document with the timeline's structural overrides at the
 * playhead applied (`buildTimelineStructure` → `applyTimelineStructure`), never a write. The
 * overrides are piecewise constant between crossings, so each segment is one plan: the live
 * loop recompiles at a crossing (ahead of it, warmed, §T1507b), an export swaps plans on the
 * crossing frame, and both read the same function of the playhead.
 *
 * A structural key on a component INSTANCE (§T1544b) reaches the compile only through the
 * instance's published fan-out, so the override follows it: an instance key is structural
 * when a parameter it is published onto is (`publishedReachesStructure`, judged by the
 * definition), and the structure overrides those parameters inside the flat graph
 * (`publishedTargets`, the flattening's own origins), each cut in the form flattening
 * writes there. Still SKIPPED with the named warning (`cue.timeline.structural`): an
 * instance whose definition cannot be read (no catalogue, or not installed) while its own
 * page calls the key structural — there is no fan-out to follow.
 *
 * ## A timed list is all-timed (owner ruling 3)
 *
 * GO, BACK and fire are refused on a following list (`cue.timeline`, `cue-commands.ts`); a
 * cue with no `at` is skipped with a warning; manual cues run from a second, live list.
 *
 * ## The bank's Morph and Curve are read STORED (§T1559b (2), owner ruling 2026-10-05)
 *
 * GO reads the bank's Morph once, at the command, and writes the seconds into the record it
 * commits. A timed cue writes nothing and `stepsAt` recomputes its fade at every playhead,
 * so a live Morph has no moment to be read at that keeps playback, a cold seek and an export
 * equal: read at the current frame the fade's length changes during the fade, and read at
 * the cue's reach frame it needs channel values of a past frame. So a timed cue fades over
 * what the document says (`resolveStored`), and a bank whose Morph or Curve is DRIVEN gets a
 * named warning (`cue.timeline.drivenMorph`) stating the value in use.
 */

/** The bank settings a recall's fade is read from when neither the cue nor the preset carries a morph. */
const BANK_MORPH_KEYS = ["morph", "curve"] as const;

/** §T1559b (2): a following list fires a bank whose Morph or Curve is driven. */
const CUE_TIMELINE_DRIVEN_MORPH = "cue.timeline.drivenMorph";

/** The mode a stored parameter is DRIVEN in, or null for a plain value (bare, or a static slot). */
function drivenMode(stored: StoredParameter | undefined): string | null {
  return isParameterSlot(stored) && stored.mode !== "static" ? stored.mode : null;
}

/** Does this node follow the timeline? Read from the STORED value, so it is per revision. */
export function followsTimeline(node: GraphNode): boolean {
  return node.type === CUE_LIST_NODE_TYPE && storedStaticValue(node.parameters["follow"]) === CUE_FOLLOW_TIMELINE;
}

/** Does any cue list follow the timeline? The per-revision half of "does this document animate". */
export function hasTimelineCueLists(graph: GraphDocument): boolean {
  return Object.values(graph.nodes).some(followsTimeline);
}

/** Frames per TIMELINE second at a frame: the project rate times the sub-frames it is stepped at. */
export function timelineRate(frame: Pick<FrameEvaluationInput, "fps" | "subframes">): number {
  return fpsOf(frame) * subframesOf(frame);
}

/**
 * The playhead as a FRAME INDEX on the timeline: `timeSeconds` is `n / rate` divided, never
 * accumulated (both transports), so this is `n` exactly. Read off `timeSeconds` rather than
 * `frameIndex` because a live rate change rebases the clock (`live-clock.ts`) and the two
 * then disagree; the playhead is the time.
 */
export function playheadFrame(timeSeconds: number, rate: number): number {
  return Math.round(timeSeconds * rate);
}

/**
 * Is this key STRUCTURAL — something a timed cue cannot drive, only cut through a recompile
 * (§T1537b)? `compileTime`, a resolution-policy input, or a source reference (a Layer's
 * `picture`, which decides which chain is compiled). The first two are `morphableKey`'s
 * structural half.
 */
export function structuralCueKey(definition: NodeDefinition | undefined, node: GraphNode, key: string): boolean {
  if (definition === undefined) return false;
  const schema = effectiveParameterSchema(definition, node.parameters);
  const component = schema[key] === undefined ? parseComponentKey(key) : null;
  const root = component === null ? key : component.base;
  if (schema[root]?.compileTime === true) return true;
  const policy = definition.resolutionPolicy as unknown as { kind?: unknown; width?: unknown; height?: unknown } | undefined;
  if (policy?.kind === "parameter" && (policy.width === root || policy.height === root)) return true;
  return (definition.sourceReferences ?? []).some((reference) => reference.parameter === root);
}

/**
 * §T1544b — does an instance's published `key` reach a STRUCTURAL parameter inside its
 * component? Each of the published parameter's targets is judged by its own node's
 * definition (`structuralCueKey`), through nested instances by the same rule — the
 * parameters flattening's fan-out (§V80) writes the key onto. `undefined` when the
 * definition cannot be read (no catalogue, or the component is not installed).
 */
function publishedReachesStructure(
  node: GraphNode,
  key: string,
  registry: NodeRegistryView,
  components: BankCatalogue | undefined,
  depth = 0,
): boolean | undefined {
  const ref = parseComponentNodeType(node.type);
  if (ref === null) return false;
  const definition = components?.get(ref.componentId, ref.version);
  if (definition === undefined) return undefined;
  const direct = definition.parameters.find((entry) => entry.key === key);
  const channel = direct === undefined ? parseComponentKey(key) : null;
  const published = direct ?? (channel === null ? undefined : definition.parameters.find((entry) => entry.key === channel.base));
  if (published === undefined) return false;
  for (const target of published.targets) {
    const inner = definition.graph.nodes[target.nodeId];
    if (inner === undefined) continue;
    if (isComponentNodeType(inner.type)) {
      // A cycle is the flattener's to refuse (§V83); this only stops looking.
      if (depth < 16 && publishedReachesStructure(inner, target.key, registry, components, depth + 1) === true) return true;
      continue;
    }
    if (structuralCueKey(registry.get(inner.type), inner, target.key)) return true;
  }
  return false;
}

/**
 * §T1537b — one timed cue's STRUCTURAL setting on one target: a Layer's on/off
 * (`bypassed`), or a structural key's stored form (`parameter`). Always a cut at `at`.
 */
interface StructuralLink {
  readonly at: number;
  readonly listName: string;
  /** The list it is a cue of, and what it sets, as the inspector names it (`layer1.on`). */
  readonly list: NodeId;
  readonly address: string;
  readonly position: number;
  readonly to: { readonly bypassed: boolean } | { readonly key: string; readonly parameter: StoredParameter };
}

/** The target a structural link sets: `on` for a Layer's switch, otherwise the key. */
const LAYER_SWITCH_TARGET = "\u0000on";

/** The node type whose switch the timeline follows: `layerNode.type` (`src/nodes/definitions/layer.ts`). */
const LAYER_NODE_TYPE = "layer";

/** A warning about a following list, and the cue it is about (`null`: the list itself). */
export interface TimelineCueWarning {
  readonly list: NodeId;
  readonly cue: string | null;
  readonly diagnostic: RuntimeDiagnostic;
}

/** One timed cue on one root key: when it is reached, how it fades, and the end it applies. */
interface TimedLink {
  readonly at: number;
  readonly seconds: number;
  readonly curve: MorphCurve;
  readonly to: StoredParameter;
  readonly listName: string;
  readonly position: number;
}

export interface TimelineCuePlan {
  /** Root node id → key → the timed cues covering it, in `at` order (ties: list name, position). */
  readonly chains: ReadonlyMap<NodeId, ReadonlyMap<string, readonly TimedLink[]>>;
  /**
   * §T1537b: root node id → target (a structural key, or the Layer's switch) → the timed
   * cues setting it, in the same order. What `buildTimelineStructure` folds.
   */
  readonly structure: ReadonlyMap<NodeId, ReadonlyMap<string, readonly StructuralLink[]>>;
  readonly warnings: readonly TimelineCueWarning[];
}

const nameOf = (node: GraphNode): string => node.label ?? node.id;

/**
 * Every following list, planned: the end each timed cue applies, per root key, and every
 * warning — an untimed cue, a bank or preset that is not there, the planner's own skips, a
 * structural key on an instance whose definition cannot be read, two lists on one key, a bank
 * whose Morph or Curve is driven (§T1559b (2)) — and (§T1537b) the
 * structural settings each timed cue cuts. Pure; per revision.
 *
 * T1541b: `components` is the catalogue a look's instance is a bank through (`bankOf`) —
 * the flattening's own, as recall reads the bus's. Without it a cue naming an instance is
 * skipped, saying why. An instance's preset reaches only its page (its `on` and `recalls`
 * are skipped by the recall planner), so it files no layer switch; a structural key on its page is
 * followed through the page's fan-out like any instance key (§T1544b).
 */
export function planTimelineCues(document: GraphDocument, registry: NodeRegistryView, components?: BankCatalogue): TimelineCuePlan {
  const warnings: TimelineCueWarning[] = [];
  /** Root node id → key → links, and which lists cover it. */
  const chains = new Map<NodeId, Map<string, TimedLink[]>>();
  /** §T1537b: root node id → target → structural links. */
  const structure = new Map<NodeId, Map<string, StructuralLink[]>>();
  /** `node.key` → the following lists that set it, name → id. */
  const coveredBy = new Map<string, Map<string, NodeId>>();

  for (const listId of Object.keys(document.nodes).sort()) {
    const listNode = document.nodes[listId];
    if (listNode === undefined || !followsTimeline(listNode)) continue;
    const listName = nameOf(listNode);
    const warn = (cue: string | null, code: string, message: string, suggestion?: string): void => {
      warnings.push({
        list: listNode.id,
        cue,
        diagnostic: { severity: "warning", code, message, nodeId: listNode.id, ...(suggestion === undefined ? {} : { suggestion }) },
      });
    };
    const parsed = parseCueList(listNode.parameters["cues"]);
    if (!parsed.ok) {
      warn(null, "cue.timeline.malformed", `Cue list "${listName}" follows the timeline, but ${parsed.reason}; it drives nothing.`, "Fix the Cues field.");
      continue;
    }
    /** §T1559b (2): `bank id\u0000key` already said for this list — once per bank setting, not per cue. */
    const drivenSaid = new Set<string>();
    for (const [position, cue] of parsed.list.cues.entries()) {
      const where = `Cue "${cue.name}" (${listName})`;
      if (cue.at === undefined) {
        warn(cue.name, "cue.timeline.untimed", `${where} has no At time, so the timeline skips it.`, "Give it a time, or run it from a second list that stays Live.");
        continue;
      }
      const at = cue.at;
      const bankId = nodeByName(document, cue.bank);
      const bankNode = bankId === undefined ? undefined : document.nodes[bankId];
      // T1541b: a look's instance is a bank through the catalogue (`bankOf`), as at GO.
      const lookup = bankOf(bankNode, components);
      if (bankNode === undefined || !lookup.ok) {
        const reason =
          bankNode === undefined || lookup.ok || lookup.why === "notBank" ? "is not a Presets bank in this document" : notABank(lookup.why, bankNode);
        warn(cue.name, "cue.timeline.bank", `${where}: "${cue.bank}" ${reason}; the timeline skips it.`);
        continue;
      }
      const { view } = lookup;
      const bank = parsePresetBank(view.bank.parameters["presets"]);
      const preset = bank.ok ? bank.bank.presets.find((candidate) => candidate.name === cue.preset) : undefined;
      if (preset === undefined) {
        warn(cue.name, "cue.timeline.preset", `${where}: bank "${cue.bank}" has no preset "${cue.preset}" it can read; the timeline skips it.`);
        continue;
      }
      // Morph and Curve are the bank's — for an instance, its component's page bank's (as at GO).
      // §T1557b: the document (`resolveStored`) — this structure is a pure function of it,
      // built once per revision; a channel-driven Morph is read live only at GO (`bankSettings`).
      const morph = presetMorph(cue.morph, preset, resolveStored(view.bank, registry.get(view.bank.type)).values);
      const end = presetRecallEnd(document, registry, view, preset, components);
      for (const said of end.diagnostics) {
        warnings.push({ list: listNode.id, cue: cue.name, diagnostic: { ...said, message: `${where}: ${said.message}`, nodeId: listNode.id } });
      }
      if (end.refused) continue;
      /*
       * §T1559b (2): this cue's fade is the BANK's (neither it nor its preset carries a
       * morph), read stored above, and the setting is driven — so GO and a Recall, which
       * read it live (`bankSettings`), would fade differently. Said on the BANK
       * (`nodeId`): whoever drives its Morph is looking at the bank, not at this list.
       * Not an instance bank: its settings are the definition's page bank's and GO reads
       * them stored too, so the two already agree.
       */
      if (cue.morph === undefined && preset.morph === undefined && view.kind === "node") {
        for (const key of BANK_MORPH_KEYS) {
          const mode = drivenMode(view.bank.parameters[key]);
          const setting = `${view.bank.id}\u0000${key}`;
          if (mode === null || drivenSaid.has(setting)) continue;
          drivenSaid.add(setting);
          const label = effectiveParameterSchema(registry.get(view.bank.type), view.bank.parameters)[key]?.label ?? key;
          warnings.push({
            list: listNode.id,
            cue: null,
            diagnostic: {
              severity: "warning",
              code: CUE_TIMELINE_DRIVEN_MORPH,
              message: `Cue list "${listName}" follows the timeline and fires bank "${nameOf(view.bank)}", whose ${label} is driven (${mode}). A timed cue that takes its fade from the bank does not read the driver: it uses the stored value, ${key === "morph" ? `${String(morph.seconds)} s` : morph.curve}. GO on a live list and a direct Recall read the driven value.`,
              nodeId: view.bank.id,
              suggestion: `Type a plain value into ${label}, or give each timed cue its own morph.`,
            },
          });
        }
      }
      /** Files a structural link (§T1537b) and notes which list covers its address. */
      const fileStructural = (node: GraphNode, target: string, address: string, to: StructuralLink["to"]): void => {
        const byTarget = structure.get(node.id) ?? new Map<string, StructuralLink[]>();
        structure.set(node.id, byTarget);
        const links = byTarget.get(target) ?? [];
        byTarget.set(target, links);
        links.push({ at, listName, list: listNode.id, address, position, to });
        const lists = coveredBy.get(address) ?? new Map<string, NodeId>();
        coveredBy.set(address, lists);
        lists.set(listName, listNode.id);
      };
      for (const { nodeId: layerId, bypassed } of end.layers) {
        const layer = document.nodes[layerId];
        if (layer === undefined) continue;
        if (layer.type !== LAYER_NODE_TYPE) {
          /*
           * T1770b: a preset switches any node, and the timeline follows a Layer's switch
           * only. A segment's structure is applied to the FLAT graph (`applyTimelineStructure`),
           * where an instance that is off was never inlined and cannot be switched on, and the
           * value graph evaluates the stored document's flattening, not the segment's. Refused
           * by name until §T1772b applies the segment before flattening.
           */
          warn(
            cue.name,
            "cue.timeline.switch",
            `${where} switches "${nameOf(layer)}" ${bypassed ? "off" : "on"}, and the timeline switches Layers only: a ${layer.type} node is not switched at the cue's time, so it is skipped.`,
            "Fire the cue from a live list (GO), or recall the preset from a Panel.",
          );
          continue;
        }
        fileStructural(layer, LAYER_SWITCH_TARGET, `${nameOf(layer)}.on`, { bypassed });
      }
      for (const [nodeName, keys] of Object.entries(end.after)) {
        const nodeId = nodeByName(document, nodeName);
        const node = nodeId === undefined ? undefined : document.nodes[nodeId];
        if (node === undefined) continue;
        const definition = registry.get(node.type);
        const instance = isComponentNodeType(node.type);
        for (const [key, to] of Object.entries(keys)) {
          // §T1544b: an instance's key is structural when its published fan-out reaches a
          // structural parameter inside — judged target by target, by the definition. Its
          // other targets still take the value below (the value fold's `accepts` rule).
          const reaches = instance ? publishedReachesStructure(node, key, registry, components) : false;
          if (instance && reaches === undefined && structuralCueKey(definition, node, key)) {
            warn(
              cue.name,
              "cue.timeline.structural",
              `${where} sets "${nodeName}.${key}", which changes what is compiled inside a component whose definition cannot be read here; the timeline cannot follow its published parameter, so it is skipped.`,
              "Set it in the document, or change it from a live list.",
            );
            continue;
          }
          if (instance ? reaches === true : structuralCueKey(definition, node, key)) {
            fileStructural(node, key, `${nodeName}.${key}`, { key, parameter: to });
            if (!instance) continue;
          }
          const byKey = chains.get(node.id) ?? new Map<string, TimedLink[]>();
          chains.set(node.id, byKey);
          const links = byKey.get(key) ?? [];
          byKey.set(key, links);
          links.push({ at: cue.at, seconds: morph.seconds, curve: morph.curve, to, listName, position });
          const address = `${nodeName}.${key}`;
          const lists = coveredBy.get(address) ?? new Map<string, NodeId>();
          coveredBy.set(address, lists);
          lists.set(listName, listNode.id);
        }
      }
    }
  }

  const order = (a: { at: number; listName: string; position: number }, b: { at: number; listName: string; position: number }): number =>
    a.at - b.at || (a.listName < b.listName ? -1 : a.listName > b.listName ? 1 : 0) || a.position - b.position;
  for (const byKey of [...chains.values(), ...structure.values()]) {
    for (const links of byKey.values()) links.sort(order);
  }
  // Two following lists on one key are ONE chain in time order — said on each of them.
  for (const [address, lists] of coveredBy) {
    if (lists.size < 2) continue;
    const names = [...lists.keys()].sort();
    for (const name of names) {
      const listId = lists.get(name) as NodeId;
      warnings.push({
        list: listId,
        cue: null,
        diagnostic: {
          severity: "warning",
          code: "cue.timeline.overlap",
          message: `Cue lists ${names.map((each) => `"${each}"`).join(" and ")} both follow the timeline and both set "${address}"; their cues run as one sequence, in time order.`,
          nodeId: listId,
          suggestion: "Let one list set each value, or switch one of them to Live.",
        },
      });
    }
  }
  return { chains, structure, warnings };
}

/**
 * §T1537b — what ONE following list switches in the compiled structure, as `node.key` (a
 * Layer's switch as `node.on`), sorted: the inspector's "switches structure" line.
 */
export function timelineStructuralSettings(document: GraphDocument, registry: NodeRegistryView, listId: NodeId, components?: BankCatalogue): readonly string[] {
  const node = document.nodes[listId];
  if (node === undefined || !followsTimeline(node)) return [];
  const said = new Set<string>();
  for (const byTarget of planTimelineCues(document, registry, components).structure.values()) {
    for (const links of byTarget.values()) for (const link of links) if (link.list === listId) said.add(link.address);
  }
  return [...said].sort();
}

/** The warnings about ONE list, as its surfaces (the inspector, `cue.list`) show them. */
export function timelineCueWarnings(document: GraphDocument, registry: NodeRegistryView, listId: NodeId, components?: BankCatalogue): readonly TimelineCueWarning[] {
  const node = document.nodes[listId];
  if (node === undefined || !followsTimeline(node)) return [];
  return planTimelineCues(document, registry, components).warnings.filter((warning) => warning.list === listId);
}

/** The codes this module files itself: what a following list cannot do as it is written. */
const CUE_TIMELINE_CODES = "cue.timeline.";

/**
 * §T1559b (2) — THE TIMELINE WARNINGS THE DOCUMENT'S PROBLEMS CARRY: what ends up in
 * `compileGraph`'s diagnostics, so the Problems list, a node's badge and `get_diagnostics` say
 * them in both composition roots. Every `cue.timeline.*` warning of the plan, as the plan
 * filed it (its node, its text): a timed list that cannot fire as written is a problem its
 * author should see without opening the list's inspector (lead's ruling, 2026-10-05).
 *
 * NOT the recall planner's own skips a cue passes on (`preset.*`: a target that is gone, a
 * shot that recalls itself). One of those is an ERROR, and an error among the compile's
 * diagnostics fails the compile (`hasError`), which holds the picture on the previous plan
 * (§V9) — where the timeline only skips that cue. They stay on the list's own surfaces.
 *
 * WHEN THE PLANNER RUNS FOR THIS: only when a list follows the timeline — a document with
 * none pays one walk of its nodes (`hasTimelineCueLists`) — and then once per FLATTENING
 * (`flattenComponents` asks, beside the morph index), not once per compile: a frame or a
 * timeline segment compiled over that flattening reads `flattened.diagnostics`. A compile
 * handed no catalogue has no flattening and asks for itself.
 */
export function timelineCueProblems(input: MorphIndexInput): readonly RuntimeDiagnostic[] {
  if (!hasTimelineCueLists(input.document)) return [];
  return planTimelineCues(input.document, plannerRegistry(input), input.components)
    .warnings.filter((warning) => warning.diagnostic.code.startsWith(CUE_TIMELINE_CODES))
    .map((warning) => warning.diagnostic);
}

/**
 * Where a following list IS at a playhead: the newest timed cue reached (`current`) and the
 * first not yet reached (`next`), both by frame index. A cue with no `at` is not on the
 * timeline. What `cue.list`, the inspector and the phone show in place of the stored
 * `current` / `standby`, which a timed list never writes (§V16: no document write per frame).
 */
export function timelineCuePosition(list: CueList, timeSeconds: number, rate: number): { current: string | null; next: string | null } {
  const playhead = playheadFrame(timeSeconds, rate);
  const timed = list.cues
    .map((cue, position) => ({ cue, position }))
    .filter((entry): entry is { cue: typeof entry.cue & { at: number }; position: number } => entry.cue.at !== undefined)
    .sort((a, b) => a.cue.at - b.cue.at || a.position - b.position);
  let current: string | null = null;
  let next: string | null = null;
  for (const { cue } of timed) {
    if (cueReachFrame(cue.at, rate) <= playhead) current = cue.name;
    else {
      next = cue.name;
      break;
    }
  }
  return { current, next };
}

/** One key's timeline: the slot it starts from, and its cues with their ends as THIS node holds them. */
interface FiledTimeline {
  readonly start: StoredParameter;
  readonly steps: ReadonlyArray<{ readonly at: number; readonly seconds: number; readonly curve: MorphCurve; readonly to: StoredParameter }>;
}

/**
 * The registry the planner reads at index time. The Dawn harness flattens with the PLAIN
 * node registry, which knows no component type, and the planner would then skip every key
 * of a look instance as an unknown type where the app — whose registry is component-aware —
 * applies it. The flattening's published pages (`instanceSchemas`) answer for those types,
 * so the harness and the app plan the same ends.
 */
function plannerRegistry(input: MorphIndexInput): NodeRegistryView {
  const pages = input.flattened?.instanceSchemas;
  const byType = new Map<string, ParameterSchema>();
  for (const [nodeId, schema] of pages ?? []) {
    const node = input.document.nodes[nodeId];
    if (node !== undefined && !input.registry.has(node.type)) byType.set(node.type, schema);
  }
  /*
   * §T1544b: a flattening handed in WITHOUT its pages (`FlattenedGraph` does not carry them —
   * the structure's callers hold that shape) answers through the catalogue instead: the
   * published page IS the instance's schema (`publishedSchema`, flattening's own).
   */
  for (const node of Object.values(input.document.nodes)) {
    if (node === undefined || byType.has(node.type) || input.registry.has(node.type)) continue;
    const ref = parseComponentNodeType(node.type);
    const definition = ref === null ? undefined : input.components?.get(ref.componentId, ref.version);
    if (definition !== undefined) byType.set(node.type, publishedSchema(definition));
  }
  if (byType.size === 0) return input.registry;
  const base = input.registry;
  const synthesized = (type: string): NodeDefinition | undefined => {
    const schema = byType.get(type);
    return schema === undefined ? undefined : ({ type, parameters: schema } as unknown as NodeDefinition);
  };
  return {
    ...base,
    has: (type) => base.has(type) || byType.has(type),
    get: (type) => base.get(type) ?? synthesized(type),
    require: (type) => base.get(type) ?? synthesized(type) ?? base.require(type),
  };
}

/** What a key that holds nothing resolves to: its declared default, as a slot a fold can start from. */
function unstored(definition: NodeDefinition | undefined, node: GraphNode, key: string): StoredParameter | undefined {
  const schema = effectiveParameterSchema(definition, node.parameters);
  const keyDefinition = schema[key] ?? componentAddressedDefinition(schema, key);
  return keyDefinition === undefined ? undefined : defaultParameterValue(keyDefinition);
}

/** The timeline half of the morph index: `null` when no list follows the timeline or none covers a key. */
export interface TimelineMorphs {
  keysOf(nodeId: string): ReadonlySet<string> | undefined;
  stepsAt(nodeId: string, key: string, frame: FrameEvaluationInput): readonly ParameterMorphStep[] | undefined;
}

/**
 * The timeline cues, FILED where they resolve: on the root node itself, and through every
 * published fan-out into a component (`publishedTargets`), each end travelling as what
 * flattening wrote. Called by `buildMorphIndex` and nowhere else.
 */
export function buildTimelineCueIndex(input: MorphIndexInput): TimelineMorphs | null {
  if (!hasTimelineCueLists(input.document)) return null;
  const registry = plannerRegistry(input);
  const plan = planTimelineCues(input.document, registry, input.components);
  if (plan.chains.size === 0) return null;
  const graph = input.flattened?.graph ?? input.document;

  const filed = new Map<NodeId, Map<string, FiledTimeline>>();
  const file = (nodeId: NodeId, key: string, timeline: FiledTimeline): void => {
    const byKey = filed.get(nodeId) ?? new Map<string, FiledTimeline>();
    filed.set(nodeId, byKey);
    byKey.set(key, timeline);
  };
  /** A key with no in-between cuts at its cue: the same links, every one of zero length. */
  const steps = (links: readonly TimedLink[], blends: boolean, to: (link: TimedLink) => StoredParameter | undefined): FiledTimeline["steps"] | null => {
    const out: Array<FiledTimeline["steps"][number]> = [];
    for (const link of links) {
      const end = to(link);
      if (end === undefined) return null;
      out.push({ at: link.at, seconds: blends ? link.seconds : 0, curve: link.curve, to: end });
    }
    return out;
  };

  for (const [nodeId, byKey] of plan.chains) {
    const rootNode = input.document.nodes[nodeId];
    if (rootNode === undefined) continue;
    const rootDefinition = registry.get(rootNode.type);
    for (const [key, links] of byKey) {
      const start = rootNode.parameters[key] ?? unstored(rootDefinition, rootNode, key);
      if (start === undefined) continue;
      const flatNode = graph.nodes[nodeId];
      if (flatNode !== undefined && flatNode.type === rootNode.type && !structuralCueKey(registry.get(flatNode.type), flatNode, key)) {
        const filedSteps = steps(links, morphableKey(registry.get(flatNode.type), flatNode, key), (link) => link.to);
        if (filedSteps !== null) file(nodeId, key, { start, steps: filedSteps });
      }
      const accepts = (definition: NodeDefinition | undefined, node: GraphNode, targetKey: string): boolean =>
        definition !== undefined && !structuralCueKey(definition, node, targetKey);
      for (const target of publishedTargets({ ...input, registry }, rootNode, key, accepts)) {
        const targetStart = target.end(start);
        if (targetStart === undefined) continue;
        const filedSteps = steps(links, morphableKey(target.definition, target.node, target.key), (link) => target.end(link.to));
        if (filedSteps !== null) file(target.nodeId, target.key, { start: targetStart, steps: filedSteps });
      }
    }
  }
  if (filed.size === 0) return null;

  const keys = new Map<NodeId, ReadonlySet<string>>();
  for (const [nodeId, byKey] of filed) keys.set(nodeId, new Set(byKey.keys()));

  return {
    keysOf: (nodeId) => keys.get(nodeId),
    stepsAt(nodeId, key, frame) {
      const timeline = filed.get(nodeId)?.get(key);
      if (timeline === undefined) return undefined;
      const rate = timelineRate(frame);
      const playhead = playheadFrame(frame.timeSeconds, rate);
      // In `at` order, so the reached cues are a prefix.
      let reached = 0;
      while (reached < timeline.steps.length && cueReachFrame((timeline.steps[reached] as FiledTimeline["steps"][number]).at, rate) <= playhead) {
        reached += 1;
      }
      // Before its first cue the key is not the timeline's: the stored slot, or a live fade.
      if (reached === 0) return undefined;
      const progress = (step: FiledTimeline["steps"][number]): number =>
        step.seconds > 0 ? Math.min(1, Math.max(0, (frame.timeSeconds - step.at) / step.seconds)) : 1;
      // The newest FINISHED cue ends every older one; the fold starts from its end.
      let finished = -1;
      for (let index = reached - 1; index >= 0; index -= 1) {
        if (progress(timeline.steps[index] as FiledTimeline["steps"][number]) >= 1) {
          finished = index;
          break;
        }
      }
      let from = finished >= 0 ? (timeline.steps[finished] as FiledTimeline["steps"][number]).to : timeline.start;
      if (finished === reached - 1) return [{ from, to: from, progress: 1, timed: true }];
      const out: ParameterMorphStep[] = [];
      for (let index = finished + 1; index < reached; index += 1) {
        const step = timeline.steps[index] as FiledTimeline["steps"][number];
        out.push({ from, to: step.to, progress: easeMorph(step.curve, progress(step)), timed: true });
        from = step.to;
      }
      return out;
    },
  };
}

/**
 * The recall morphs with the timeline on top: on a key a following list covers, from its
 * first cue on, the timeline's steps; everywhere else, the recall chain unchanged. While a
 * timeline covers anything, every frame is active — a cue's cut must render on its frame
 * even in a document that is otherwise still (idle-skip, the design doc §2.4).
 */
export function withTimelineCues(recall: ParameterMorphs, timeline: TimelineMorphs | null): ParameterMorphs {
  if (timeline === null) return recall;
  const union = new Map<string, ReadonlySet<string> | undefined>();
  return {
    keysOf(nodeId) {
      if (union.has(nodeId)) return union.get(nodeId);
      const a = recall.keysOf(nodeId);
      const b = timeline.keysOf(nodeId);
      const keys = a === undefined ? b : b === undefined ? a : new Set([...a, ...b]);
      union.set(nodeId, keys);
      return keys;
    },
    stepsAt: (nodeId, key, frame) => timeline.stepsAt(nodeId, key, frame) ?? recall.stepsAt(nodeId, key, frame),
    activeAt: () => true,
  };
}

/**
 * §T1537b — THE TIMELINE'S STRUCTURE AT ONE PLAYHEAD: what the compiled graph differs from
 * the document by. Identity-stable — one object per distinct structure of a revision — so a
 * caller keys its compile on it, and `key` is the same string for the same structure.
 */
export interface TimelineStructureState {
  /** `""` when the structure is the document's own (nothing differs from what is stored). */
  readonly key: string;
  /** Layer node id → the `bypassed` flag the timeline holds it at. Only where it differs. */
  readonly bypassed: ReadonlyMap<NodeId, boolean>;
  /** Node id → structural key → the stored form the timeline holds. Only where it differs. */
  readonly parameters: ReadonlyMap<NodeId, Readonly<Record<string, StoredParameter>>>;
}

/** The document's own structure: nothing overridden. */
export const DOCUMENT_STRUCTURE: TimelineStructureState = Object.freeze({
  key: "",
  bypassed: new Map<NodeId, boolean>(),
  parameters: new Map<NodeId, Readonly<Record<string, StoredParameter>>>(),
});

/** Where the timeline's structure next CHANGES after a playhead: the frame, and what it changes to. */
export interface TimelineStructureCrossing {
  readonly frameIndex: number;
  readonly state: TimelineStructureState;
}

/**
 * §T1537b — the timeline's structural overrides as a PURE FUNCTION OF THE PLAYHEAD,
 * piecewise constant between crossings. Built once per revision; every answer is cached.
 */
export interface TimelineStructure {
  /** The structure at a frame (its playhead, at its rate — the same reading the value fold makes). */
  at(frame: Pick<FrameEvaluationInput, "timeSeconds" | "fps" | "subframes">): TimelineStructureState;
  /** The structure at playhead frame `playhead` on a timeline of `rate` frames per second. */
  atFrame(playhead: number, rate: number): TimelineStructureState;
  /** The first crossing after `playhead` where the structure becomes different; null when none. */
  nextAfter(playhead: number, rate: number): TimelineStructureCrossing | null;
  /** Every frame a structural cue is reached on, ascending, deduped. */
  crossings(rate: number): readonly number[];
}

/**
 * One overridable target, with what it holds when the timeline does not hold it: a node of
 * the graph that COMPILES (a root node, or — §T1544b — a parameter inside a component that
 * an instance's published key fans out onto), and its cuts in cue order, each already in
 * the form that node holds.
 */
interface StructuralTarget {
  readonly nodeId: NodeId;
  /** The key the cuts set, or `LAYER_SWITCH_TARGET` for a Layer's switch. */
  readonly key: string;
  readonly stored: StoredParameter | boolean | undefined;
  readonly links: ReadonlyArray<{ readonly at: number; readonly to: { readonly bypassed: boolean } | { readonly parameter: StoredParameter } }>;
}

const sameJson = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/**
 * §T1537b — the timeline's structure, or null when no following list cuts a structural
 * setting (then the compiled graph is always the document). Same planner, same registry
 * rule and same cue order as the value fold (`buildTimelineCueIndex`), so a cue that a
 * value reading reaches on frame n is the cue whose structure frame n compiles.
 */
export function buildTimelineStructure(input: MorphIndexInput): TimelineStructure | null {
  if (!hasTimelineCueLists(input.document)) return null;
  const registry = plannerRegistry(input);
  // T1541b: the same catalogue as the value fold, so both plan the same cues.
  const plan = planTimelineCues(input.document, registry, input.components);
  if (plan.structure.size === 0) return null;

  const targets: StructuralTarget[] = [];
  /** §T1544b: a structural target inside a component, as the value fold's mirror takes the others. */
  const structuralInside = (definition: NodeDefinition | undefined, node: GraphNode, key: string): boolean =>
    definition !== undefined && structuralCueKey(definition, node, key);
  for (const nodeId of [...plan.structure.keys()].sort()) {
    const node = input.document.nodes[nodeId];
    const byTarget = plan.structure.get(nodeId);
    if (node === undefined || byTarget === undefined) continue;
    for (const target of [...byTarget.keys()].sort()) {
      const links = byTarget.get(target) ?? [];
      if (target !== LAYER_SWITCH_TARGET && isComponentNodeType(node.type)) {
        /*
         * §T1544b — an INSTANCE's key does not exist in the graph that compiles: flattening
         * wrote it onto parameters inside. Follow that fan-out (`publishedTargets`, the
         * flattening's own `publishedOrigins`) to each structural one, every cut travelling
         * as what flattening writes there (`end`), and override THOSE.
         */
        for (const inside of publishedTargets({ ...input, registry }, node, target, structuralInside)) {
          const mapped: Array<StructuralTarget["links"][number]> = [];
          for (const link of links) {
            const end = "parameter" in link.to ? inside.end(link.to.parameter) : undefined;
            if (end === undefined) break;
            mapped.push({ at: link.at, to: { parameter: end } });
          }
          if (mapped.length !== links.length) continue;
          const stored = inside.node.parameters[inside.key] ?? unstored(inside.definition, inside.node, inside.key);
          targets.push({ nodeId: inside.nodeId, key: inside.key, stored, links: mapped });
        }
        continue;
      }
      const stored =
        target === LAYER_SWITCH_TARGET ? node.ui?.bypassed === true : (node.parameters[target] ?? unstored(registry.get(node.type), node, target));
      targets.push({
        nodeId,
        key: target,
        stored,
        links: links.map((link) => ({ at: link.at, to: "bypassed" in link.to ? { bypassed: link.to.bypassed } : { parameter: link.to.parameter } })),
      });
    }
  }
  if (targets.length === 0) return null;

  /** One state per distinct structure, so equal structures are one object (and one plan). */
  const byKey = new Map<string, TimelineStructureState>([["", DOCUMENT_STRUCTURE]]);
  interface RateEntry {
    readonly crossings: readonly number[];
    readonly segments: Array<TimelineStructureState | undefined>;
  }
  /** Per rate: the crossings, and the state of each segment (index = crossings reached). */
  const perRate = new Map<number, RateEntry>();

  const segmentsAt = (rate: number): RateEntry => {
    let entry = perRate.get(rate);
    if (entry === undefined) {
      const frames = new Set<number>();
      for (const target of targets) for (const link of target.links) frames.add(cueReachFrame(link.at, rate));
      const crossings = [...frames].sort((a, b) => a - b);
      entry = { crossings, segments: new Array<TimelineStructureState | undefined>(crossings.length + 1) };
      perRate.set(rate, entry);
    }
    return entry;
  };

  /** The structure once every link reached by `playhead` has cut. */
  const fold = (playhead: number, rate: number): TimelineStructureState => {
    const bypassed = new Map<NodeId, boolean>();
    const parameters = new Map<NodeId, Record<string, StoredParameter>>();
    const keyParts: unknown[] = [];
    for (const target of targets) {
      // In cue order, so the reached links are a prefix and the last one reached holds.
      let held: StructuralTarget["links"][number] | undefined;
      for (const link of target.links) {
        if (cueReachFrame(link.at, rate) > playhead) break;
        held = link;
      }
      if (held === undefined) continue;
      if ("bypassed" in held.to) {
        if (held.to.bypassed === target.stored) continue;
        bypassed.set(target.nodeId, held.to.bypassed);
        keyParts.push([target.nodeId, "on", !held.to.bypassed]);
      } else {
        if (sameJson(held.to.parameter, target.stored)) continue;
        const record = parameters.get(target.nodeId) ?? {};
        parameters.set(target.nodeId, record);
        record[target.key] = held.to.parameter;
        keyParts.push([target.nodeId, target.key, held.to.parameter]);
      }
    }
    const key = keyParts.length === 0 ? "" : JSON.stringify(keyParts);
    const known = byKey.get(key);
    if (known !== undefined) return known;
    const state: TimelineStructureState = { key, bypassed, parameters };
    byKey.set(key, state);
    return state;
  };

  /** Segment `index` (crossings reached) of `rate`, folded once. */
  const segment = (index: number, rate: number): TimelineStructureState => {
    const entry = segmentsAt(rate);
    const known = entry.segments[index];
    if (known !== undefined) return known;
    const state = index === 0 ? DOCUMENT_STRUCTURE : fold(entry.crossings[index - 1] as number, rate);
    entry.segments[index] = state;
    return state;
  };

  /** How many crossings `playhead` has reached. */
  const reached = (crossings: readonly number[], playhead: number): number => {
    let low = 0;
    let high = crossings.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if ((crossings[middle] as number) <= playhead) low = middle + 1;
      else high = middle;
    }
    return low;
  };

  const atFrame = (playhead: number, rate: number): TimelineStructureState => segment(reached(segmentsAt(rate).crossings, playhead), rate);

  return {
    at: (frame) => {
      const rate = timelineRate(frame);
      return atFrame(playheadFrame(frame.timeSeconds, rate), rate);
    },
    atFrame,
    nextAfter(playhead, rate) {
      const { crossings } = segmentsAt(rate);
      const from = reached(crossings, playhead);
      const now = segment(from, rate);
      for (let index = from + 1; index <= crossings.length; index += 1) {
        const state = segment(index, rate);
        if (state !== now) return { frameIndex: crossings[index - 1] as number, state };
      }
      return null;
    },
    crossings: (rate) => segmentsAt(rate).crossings,
  };
}

/**
 * §T1537b — the document with a structure applied: the graph that is COMPILED for a frame
 * whose playhead is in that structure's segment. Pure; the input is untouched, and a node
 * the graph does not hold is ignored. The document's own structure is the graph itself.
 */
// §T1552b: generic, so the flattening a segment compiles stays a `FlatGraph` (a spread keeps the kind).
export function applyTimelineStructure<G extends GraphDocument>(graph: G, state: TimelineStructureState): G {
  if (state.key === "") return graph;
  const nodes: Record<NodeId, GraphNode> = { ...graph.nodes };
  for (const [nodeId, bypassed] of state.bypassed) {
    const node = nodes[nodeId];
    if (node !== undefined) nodes[nodeId] = { ...node, ui: { ...node.ui, bypassed } };
  }
  for (const [nodeId, parameters] of state.parameters) {
    const node = nodes[nodeId];
    if (node !== undefined) nodes[nodeId] = { ...node, parameters: { ...node.parameters, ...parameters } };
  }
  return { ...graph, nodes };
}
