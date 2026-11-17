import type { FlatGraph, GraphDocument } from "../types/graph.ts";
import { ZERO_FRAME } from "../types/frame.ts";
import type { FrameEvaluationInput } from "../types/frame.ts";
import type { ParameterValue, StoredParameter } from "../types/parameters.ts";
import type { NodeId } from "../types/ids.ts";
import type { NodeRegistryView } from "../../nodes/registry/registry.ts";
import { effectiveParameterSchema, resolveParameterSchema, type ChannelResolver, type ParameterMorphs } from "../parameters/resolve.ts";
import { NO_INSTANCES, NO_PAGES, parameterReadOptions } from "../parameters/node-references.ts";
import { nodeNames } from "../graph/names.ts";
import { NO_MORPHS, hasMorphRecords } from "../presets/morph-index.ts";
import { hasTimelineCueLists } from "../presets/timeline-cues.ts";
import { storedStaticValue } from "../parameters/slots.ts";
import { defaultParameterValue } from "../parameters/validate.ts";

/**
 * Graph-backed driven channels (T238-T240, §V143).
 *
 * The bridge between value-source NODES (LFO, Constant, Timer — anything declaring
 * `valueChannel`) and the parameter resolver's `driven` mode (T203): a parameter driven
 * by channel `lfo1` reads the value-source node NAMED `lfo1` (§V129 — names are
 * identifiers, which is what makes this addressing possible at all). Plug the result
 * into `ResolveParametersOptions.channels` and the reserved mode comes alive.
 *
 * Determinism (§V143, §V44, §V45): the value is a pure function of the source node's
 * parameter values and the frame — no wall clock anywhere — so offline render and live
 * playback agree frame for frame, and the same project at the same frame index is the
 * same picture on every machine.
 *
 * The SOURCE node's own parameters resolve as their static view here, deliberately: an
 * LFO whose frequency is itself driven would recurse through this resolver, and a
 * channel graph is exactly the kind of loop §V110 exists to prevent. Modulating an
 * LFO's frequency is real (TD does it) and arrives with channel-graph cycle detection,
 * not by accident.
 *
 * T1524b: `morphs` is the preset morphs in flight over this same graph
 * (`FlattenedGraph.morphs`). A source parameter a bank is still fading stores its
 * DESTINATION, so the static view alone would publish the end value while the value graph
 * in front of this backstop — and the picture — are half-way there. The fading keys are
 * therefore read through the resolver's own fold, over that same static view.
 */
export function graphChannelResolver(
  graph: FlatGraph,
  registry: NodeRegistryView,
  morphs?: ParameterMorphs,
): ChannelResolver {
  /**
   * ═══════════════════════════════════════════════════════════════════════════════════
   * THE NAME INDEX, BUILT ONCE PER RESOLVER (T1245)
   * ═══════════════════════════════════════════════════════════════════════════════════
   *
   * `nodeByName` calls `nodeNames`, which SORTS EVERY NODE ID AND BUILDS A FRESH `Map` —
   * and it was called once per `op('x').chan` read, which is once per driven parameter
   * per frame. §T1182's fast-path profile measured `nodeNames` at 13.7% of a 3000-frame
   * run, the largest self cost left in it. The index is a pure function of `graph`, so
   * building it once and asking it N times is the same N answers for a fraction of the
   * work. §T1172 did exactly this for the PARAMETER reader (`node-references.ts`); the
   * channel resolver was the other half of the same call and did not get it.
   *
   * ⚠ WHY THE SCOPE IS THIS CLOSURE, AND WHY THAT CANNOT GO STALE. `graph` is captured
   * ONCE, at construction, and this closure never reads any other document — so "the
   * graph this index describes" and "the graph this resolver answers about" are the same
   * object by construction, and there is no window between them for an edit to land in.
   * Every document that reaches here is a settled one: the store hands out a NEW frozen
   * object per revision (`setAutoFreeze(true)` in `store.ts`), and `flattenComponents`
   * returns a new one per (revision, catalogue revision). So a rename, an add, a delete
   * or a component re-flatten produces a new graph object, `use-graph-compile.ts`'s
   * `channels` memo — keyed on `flatGraph` — builds a NEW resolver over it, and that
   * resolver builds its own index on its first read. Nothing is invalidated because
   * nothing outlives the thing it describes.
   *
   * This is also why the index is NOT in `names.ts` and NOT keyed on graph identity in a
   * module-level map: `apply-patch.ts` calls `nodeNames` on an immer DRAFT it is still
   * mutating (two `addNode` ops in one patch, and the second `uniqueNodeName` must see
   * the first add), so a memo keyed on the object would hand it a pre-mutation index and
   * mint a duplicate name (§V127). `names.test.ts` gates that. No channel resolver is
   * ever built over a draft — `context.channels` comes down the bus from this one memo.
   *
   * `nodeNames` itself is the index, unchanged, so the two answers it has always given
   * are preserved exactly: on a DUPLICATE label the node whose id sorts first wins
   * (`Object.keys(...).sort()`, first-wins), and a name matching nothing is `undefined`,
   * which the caller reads as "not my channel".
   */
  let index: ReadonlyMap<string, NodeId> | null = null;
  return (channel, context) => {
    index ??= nodeNames(graph);
    const nodeId = index.get(channel);
    if (nodeId === undefined) return undefined;
    const node = graph.nodes[nodeId];
    if (node === undefined) return undefined;
    const definition = registry.get(node.type);
    if (definition?.valueChannel === undefined) return undefined;

    const values: Record<string, ParameterValue> = {};
    // T903: through the funnel, so a value node that reflects its own schema publishes the
    // controls it actually has. Every node with no hook returns its static schema unchanged.
    const schema = effectiveParameterSchema(definition, node.parameters);
    for (const [key, parameter] of Object.entries(schema)) {
      values[key] = storedStaticValue(node.parameters[key]) ?? defaultParameterValue(parameter);
    }
    // T1524b: a key a preset bank is fading, at this frame. The fold is the resolver's
    // (`resolveStoredAt`) — nothing here blends — and it settles on the same static view
    // the loop above reads, with no channel resolver and no reader, so this stays the
    // read the module note asks for. `driven` is the fold's own mark: a key whose fade is
    // over keeps the value the loop gave it — and once every fade is over, or the frame
    // is another epoch's, nothing is resolved here at all.
    const fading = context.frame !== undefined && morphs?.activeAt(context.frame) === true ? morphs.keysOf(nodeId) : undefined;
    if (fading !== undefined && context.frame !== undefined) {
      const parameters: Record<string, StoredParameter> = {};
      for (const [key, stored] of Object.entries(node.parameters)) {
        const retained = storedStaticValue(stored);
        if (retained !== undefined) parameters[key] = retained;
      }
      // §T1557b: through the factory, with NO channel resolver on purpose (said, not omitted):
      // this IS a channel resolver, and every slot was settled to its static above, so the
      // reader has no expression to answer — only the fold reads the frame and the morphs.
      const read = parameterReadOptions({ graph, registry, frame: context.frame, channels: undefined, flattening: { morphs: morphs ?? NO_MORPHS, instanceChannels: NO_INSTANCES, instancePages: NO_PAGES } });
      const resolved = resolveParameterSchema({ ...node, parameters }, schema, read);
      for (const key of fading) {
        const root = key.split(".")[0] as string;
        if (resolved.get(root)?.driven === true) values[root] = resolved.values[root] as ParameterValue;
      }
    }
    const frame: FrameEvaluationInput = context.frame ?? ZERO_FRAME;
    const value = definition.valueChannel(values, frame);
    return Number.isFinite(value) ? value : undefined;
  };
}

/**
 * True when any parameter in the document animates per frame — an expression or driven
 * slot at any key. The frame loop uses this to decide whether values-only recompiles
 * run at frame rate at all; a static project pays nothing.
 *
 * T1497b: or a preset bank holds a MORPH RECORD. A morphing key stores a plain value —
 * its destination — so no slot mode gives it away, and a document that is otherwise
 * still would never be asked for the frames its fade is made of (the design doc §5.3).
 * This is the per-REVISION half of the question; whether a record still has a fade to do
 * is a question about a frame (`ParameterMorphs.activeAt`), and the frame loop asks that
 * one too, so a finished fade stops costing a per-frame resolve.
 *
 * T1508b: or a cue list FOLLOWS THE TIMELINE — its cues drive their keys from the playhead
 * and store nothing, so, like a morph, no slot mode gives them away.
 */
export function hasAnimatedParameters(graph: GraphDocument): boolean {
  return Object.values(graph.nodes).some(nodeHasAnimatedParameters) || hasMorphRecords(graph) || hasTimelineCueLists(graph);
}

/**
 * The same question about ONE node, which is the unit the inspector asks about (T893).
 *
 * Extracted rather than copied: the panel decides whether to sample the live frame at all
 * from this, and a second predicate that drifted would mean the inspector going quiet for
 * exactly the parameters the frame loop is animating. Component keys (`color.g`) live in
 * the same record, so a compound with one driven channel counts.
 *
 * `map` is the fifth mode and it is DELIBERATELY not here (T988, §V287). A map has no CPU
 * value: `resolveStored`'s `map` branch returns the RETAINED static and files the mapping
 * as data for the consumer to compile, so re-resolving it at frame 900 produces exactly
 * the number frame 0 produced. Listing it would arm the panel's 10 Hz sampler — a timer,
 * a `setState` and a full inspector re-render, ten times a second, for a value that
 * cannot move. `expression`, `driven` and `bind` are here because each of them CAN read
 * the frame: an expression through `frame.*`, a driven slot through its channel, a bind
 * through a sibling that is one of the first two.
 */
export function nodeHasAnimatedParameters(node: GraphDocument["nodes"][string]): boolean {
  return animatedParameterRoots(node).size > 0;
}

/**
 * The ROOT keys of a node's parameters that can read the frame: expression, driven or bind
 * mode, a component key (`color.g`) under its compound's root. Everything else the node
 * stores is a constant, resolved the same at every frame. The one list of those modes: the
 * frame compiler's `animatedRootKeys` (which adds the keys a preset morph covers) and the
 * value graph's per-node resolve (T1719b, T1179) both read it.
 */
export function animatedParameterRoots(node: GraphDocument["nodes"][string]): ReadonlySet<string> {
  const keys = new Set<string>();
  for (const [key, stored] of Object.entries(node.parameters)) {
    if (typeof stored !== "object" || stored === null || Array.isArray(stored)) continue;
    const mode = (stored as { mode?: unknown }).mode;
    if (mode === "expression" || mode === "driven" || mode === "bind") keys.add(key.split(".")[0] as string);
  }
  return keys;
}
