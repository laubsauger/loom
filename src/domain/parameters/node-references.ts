import { nodeByName, nodeNames } from "../graph/names.ts";
import { nearestSpelling } from "../expressions/index.ts";
import type {
  SubtreeMemory,
  KindedNodeReferenceResult as NodeReferenceResult,
  NodeReferenceReader,
  ReferenceFailureKind,
  SpelledLike,
} from "../expressions/index.ts";
import type { RuntimeDiagnostic } from "../types/diagnostics.ts";
import type { FrameEvaluationInput } from "../types/frame.ts";
import type { FlatOrAuthoredGraph, GraphDocument, GraphNode } from "../types/graph.ts";
import type { NodeId, PortId } from "../types/ids.ts";
import type { ParameterChannels } from "../types/node-definition.ts";
import type { ParameterDefinition, ParameterSchema, ParameterValue } from "../types/parameters.ts";
import { componentKey, componentNamesFor } from "./slots.ts";
import {
  CHANNEL_RESOLVER_MISSING,
  CHANNELS_UNAVAILABLE_CODE,
  effectiveParameterSchema,
  NO_MORPHS,
  REFERENCE_CYCLE_CODE,
  resolveParameterSchema,
  type ChannelResolver,
  type ParameterMorphs,
  type ParameterReadOptions,
  type ParameterSchemaSource,
  type ResolvedParameters,
  type ResolveParametersOptions,
} from "./resolve.ts";

/**
 * Reading `op('noise1').par.gain` — the cross-node value path (T316, §V148, §V127).
 *
 * The reference has been storable, validatable and rename-rewritable since T221: the
 * grammar parses it, `names.ts` rewrites it when the target is renamed, and liveness
 * counts it as a dependency (§V154). What it could not do was RESOLVE, so "copy
 * reference → paste → evaluate" — §V148's round trip — held only for the same-node case,
 * which becomes a bind. A cross-node paste stored correctly and then failed.
 *
 * ## One reader, both sides
 *
 * The seam is `ResolveParametersOptions.nodes`, and the reason it is there rather than in
 * the inspector is B8. When the compiler and the inspector each had their own idea of
 * what a parameter was worth, the inspector showed the corrected value and the GPU
 * rendered the other one. A reader supplied by only one of them recreates exactly that,
 * inverted: the plan would carry the referenced value and the panel would show the
 * fallback. So the compiler builds one from the graph it is compiling, the inspector
 * builds one from the graph it is showing, and both go through this function.
 *
 * ## Why resolution recurses, and why that needs a guard
 *
 * `op('a').par.x` is worth whatever `a.x` RESOLVES to, and `a.x` may itself be an
 * expression reading `op('b').par.y`. So a read is a resolve, and a chain of references
 * is a chain of resolves. Which means it can close a loop.
 *
 * §V152 wants that rejected at authoring time with the path named, and since T331 it is:
 * `referenceCyclesThrough` refuses the patch that closes the loop, and
 * `referenceCycleDiagnostics` reports one that arrived from a file. This guard is the
 * last line rather than the only one — §V244's point being that a runtime mitigation must
 * not become the reason the gate never gets built. It stays because a `.loom.json` can
 * still be hand-edited, and it names the loop rather than reporting a stack overflow,
 * because a user who typed the cycle needs to be told which two nodes they joined.
 *
 * ## The guard is keyed by (node, key), and so is the gate (§B293)
 *
 * A read resolves the ONE parameter it names (`targetOf`), so the chain being resolved is
 * a chain of parameters and a ring is a parameter reached again. It used to resolve the
 * target's WHOLE schema, with the guard keyed by node to match: `a.x → b.y` beside
 * `b.z → a.w` really did recurse then, and a parameter could not read another parameter
 * of its own node at all (a camera's Look At from the length of its own Heading was "a
 * cycle" from wherever that camera was read). `reference-cycles.ts` is keyed the same way;
 * making either half finer without the other would accept documents the other refuses.
 *
 * ORDER WITHIN ONE NODE IS NOT A QUESTION. Nothing here resolves a node "in a pass": each
 * parameter is resolved when it is asked for, a sibling it reads is resolved by that read
 * (as a `bind` has always done), and the memo below makes that once a reader.
 */

/**
 * A path this reader understands. `par` is the only namespace v1 exposes, and one
 * component may follow the parameter (`par.color.r`, §V113/T332).
 */
const PARAMETER_NAMESPACE = "par";
/** T901: `op('lfo1').chan.value` — a value node's OUTPUT channel, TD's CHOP-read idiom. */
const CHANNEL_NAMESPACE = "chan";

/**
 * T1485b — ONE EXPOSED VALUE OUTPUT OF A COMPONENT INSTANCE, and the node publishing it.
 *
 * `op('analysis1').chan.level` names an instance, and flattening DELETES the instance: the
 * compiler reads `op()` against the flat graph, where nothing is called `analysis1`, and
 * the inspector reads against the document, where `analysis1` exists but no channel
 * resolver has ever published under its name (the value graph runs flat, so its bags are
 * keyed by the INNER labels). So neither side could read it, and examples read through a
 * labelled node downstream instead.
 *
 * The flattening already knows the answer — `instanceOutputs` maps each exposed port to the
 * inner endpoint it became — so it records, once, which inner LABEL publishes each value
 * output (`FlattenedGraph.instanceChannels`), and the reader turns an instance read into
 * reads of those labels through whichever channel resolver it was handed. No resolver
 * learns what an instance is; the address it is asked for is one it already answers.
 */
export interface InstanceChannelSource {
  /** The exposed output port — what a refusal names. */
  readonly port: PortId;
  /** The publisher's LABEL in the flattened graph: the address its bag is read under (§V129). */
  readonly publisher: string;
}

/**
 * Instance LABEL → its exposed value outputs, in exposure order, ONE ENTRY PER DISTINCT
 * PUBLISHER (two ports onto one inner node are one bag — the value graph publishes per
 * node — so they carry one signal and cannot disagree).
 */
export type InstanceChannelSources = ReadonlyMap<string, readonly InstanceChannelSource[]>;

/**
 * VN36 — ONE COMPONENT INSTANCE'S PUBLISHED PAGE, as a node a `.par` read can resolve.
 *
 * `op('rig1').par.gain` names an instance, and flattening DELETES the instance, so the flat
 * graph `op()` resolves against has nothing called `rig1`. T1485b answered that for `.chan`
 * (its exposed value outputs); this answers it for `.par`. The page is the instance as the
 * flattener resolved it (`FlattenedGraph.instanceNodes`: its own stored slots, `parent.`
 * binds already read where their scope is) and its published schema, which is what a read
 * of it resolves against, per frame, through the same `targetOf` as any node — so an
 * animated knob is evaluated once, at its publisher, and the reader gets a number.
 *
 * It is how `parent(n).par.key` reads: the flattener rewrites the read to
 * `op('<the n-th enclosing instance>').par.key` (`compiler/parent-references.ts`).
 *
 * ⚠ A STAGE-1 BRIDGE (COMP-model proposal 01 §4). Once a component is a folder of real
 * document nodes (stage 2) and linked instances are linked folders (stage 3), the COMP is a
 * node in the flat graph and `nodeIdNamed` finds it; this map retires with dissolved
 * instances.
 */
export interface InstancePage {
  /** The instance node as flattened: id is its flat id, parameters its page. */
  readonly node: GraphNode;
  /** Its published page as a schema (`publishedSchema`). */
  readonly schema: ParameterSchema;
}

/** Instance LABEL → its page. First-wins in flat-id order, as `nodeNames` is. */
export type InstancePages = ReadonlyMap<string, InstancePage>;

/**
 * The channel names `op('<instance>').chan.` can complete to: the union of what the
 * instance's publishers carry right now, MINUS every name two of them carry — the reader
 * refuses those by name (§V150: the menu may not offer what the reader rejects).
 */
function instanceChannelNames(
  sources: readonly InstanceChannelSource[],
  channelsOf: ((name: string) => readonly string[]) | undefined,
): readonly string[] {
  const carriers = new Map<string, number>();
  for (const source of sources) {
    for (const channel of new Set(channelsOf?.(source.publisher) ?? [])) {
      carriers.set(channel, (carriers.get(channel) ?? 0) + 1);
    }
  }
  return [...carriers].filter(([, count]) => count === 1).map(([channel]) => channel);
}

/**
 * WHAT `op('…')` CAN COMPLETE TO (T990), answered by the module that decides what it can
 * READ.
 *
 * The owner asked twice: "we know all the node names… and then the sub-properties should
 * also be autosuggested and completable so we don't have to guess all the time." The
 * guessing is the whole cost — a reference is three decisions deep (a name, a namespace,
 * a member) and every one of them fails silently into §V108's retained fallback, so a
 * typo reads as a working wire showing a plausible number.
 *
 * It lives HERE, beside the reader, rather than in the panel that draws the menu, and
 * that is the point rather than a filing convenience. §V150 says a menu that offers what
 * the grammar rejects teaches a wrong API with the tool's own authority; the only way to
 * be sure that cannot happen is for the offer and the refusal to read the same two
 * namespace constants, the same `schemaOf` funnel and the same `componentNamesFor`. A
 * second list in the UI layer would be right on the day it was written.
 *
 * §B170 binds the NAME half: `op()` takes the LABEL, never the id, and two examples
 * shipped dead because something matched on the wrong one. `nodeNames` is the authority
 * and it is keyed by label, so the offer cannot get that wrong either.
 */
export interface NodeReferenceMember {
  readonly text: string;
  /** Shown beside the name: what accepting it would read. */
  readonly detail?: string;
}

export interface NodeReferenceCatalogueOptions {
  readonly graph: GraphDocument;
  /** The same schema funnel the reader uses (§V814): a node's EFFECTIVE parameters. */
  readonly schemaOf: (node: GraphNode) => ParameterSchema | undefined;
  /**
   * The channel names the node called `name` is publishing RIGHT NOW.
   *
   * A function supplied by the caller, and it has to be: a bag is `valueEvaluate`'s
   * RETURN VALUE, so nothing in a definition declares its channel names — `valueMath`
   * republishes whatever arrives, `oscIn` and `midiIn` take theirs off the wire. There is
   * no static list to read and inventing one would be §V150's wrong-API menu. Absent, the
   * `chan` namespace still completes (it is a real namespace) and offers no members,
   * which is the truth: nothing here knows what is on the wire.
   */
  readonly channelsOf?: (name: string) => readonly string[];
  /** §T1674b: the channels a node's DEFINITION declares (a camera's composed pose). The reader's own source. */
  readonly declaredChannelsOf?: (node: GraphNode) => ParameterChannels | undefined;
  /** T1485b: the component instances `op('…').chan` can name — the reader's own map. */
  readonly instances?: InstanceChannelSources | undefined;
}

/** Every name `op('…')` can address — LABELS (§B170), in the graph's own sorted order. */
export function nodeReferenceNames(graph: GraphDocument): readonly string[] {
  return [...nodeNames(graph).keys()];
}

/**
 * The members completable at `op('name').<path…>.` — where `path` is the segments already
 * typed IN FULL and the answer is the set of next segments.
 *
 * `[]` for anything the reader would refuse: a name that is not in the graph, a namespace
 * that is not one of the two, a member under a channel (a channel is a leaf), a parameter
 * whose value an expression cannot read. That last filter is the one worth stating: an
 * `enum` resolves to a string and `asNumber` refuses it BY NAME, so offering it would be
 * a suggestion whose only outcome is the error message underneath it.
 */
export function nodeReferenceMembers(
  options: NodeReferenceCatalogueOptions,
  name: string,
  path: readonly string[],
): readonly NodeReferenceMember[] {
  const targetId = nodeByName(options.graph, name);
  const target = targetId === undefined ? undefined : options.graph.nodes[targetId];
  if (target === undefined) return [];

  const [namespace, key, ...rest] = path;
  if (namespace === undefined) {
    return [
      { text: PARAMETER_NAMESPACE, detail: "a parameter" },
      { text: CHANNEL_NAMESPACE, detail: "a published channel" },
    ];
  }
  if (rest.length > 0) return [];

  if (namespace === CHANNEL_NAMESPACE) {
    // `.chan.<channel>` is the whole path the reader accepts — nothing hangs off a channel.
    if (key !== undefined) return [];
    const sources = options.instances?.get(name);
    if (sources !== undefined) return instanceChannelNames(sources, options.channelsOf).map((text) => ({ text }));
    // §T1674b: declared channels are a static list, so they complete with what each one is.
    const declared = options.declaredChannelsOf?.(target);
    if (declared !== undefined) return Object.entries(declared.names).map(([text, detail]) => ({ text, detail }));
    return (options.channelsOf?.(name) ?? []).map((text) => ({ text }));
  }
  if (namespace !== PARAMETER_NAMESPACE) return [];

  const schema = options.schemaOf(target);
  if (schema === undefined) return [];
  if (key === undefined) {
    return Object.entries(schema)
      .filter(([, definition]) => readableAsNumber(definition))
      // The LABEL as the detail, because a key is an identifier and a label is what the
      // user saw in the panel they are referring to — `gain` next to "Gain" costs nothing
      // and `lowMid` next to "Low Mid" is the difference between finding it and not.
      .map(([parameterKey, definition]) => ({ text: parameterKey, detail: definition.label }));
  }
  const definition = schema[key];
  if (definition === undefined) return [];
  return (componentNamesFor(definition) ?? []).map((text) => ({ text }));
}

/**
 * Can an expression read this parameter — as a number itself, or via a component?
 *
 * Keyed on what `asNumber` accepts (number, boolean) plus the compounds `componentNamesFor`
 * can descend into, and NOT on a hand-kept type list, so a parameter kind added to the
 * union arrives excluded rather than silently offered.
 */
function readableAsNumber(definition: ParameterDefinition): boolean {
  if (componentNamesFor(definition) !== null) return true;
  return definition.type === "number" || definition.type === "boolean";
}


export interface NodeReferenceOptions {
  readonly graph: GraphDocument;
  /**
   * The parameter schema for a node, which is the definition's manifest — passed as a
   * lookup rather than a registry so a component's PUBLISHED schema (§V80), which exists
   * before any node manifest does, resolves through the same reader.
   */
  readonly schemaOf: (node: GraphNode) => ParameterSchema | undefined;
  /**
   * Everything else the referenced parameter needs to resolve — the frame, the channel
   * resolver. Carried through unchanged so a referenced expression reading `time` reads
   * the SAME time as the expression referencing it. Two frames in one evaluation is a
   * value that is right on its own and wrong in context.
   */
  readonly base?: Omit<ResolveParametersOptions, "nodes" | "schema">;
  /**
   * T1485b: the component instances `op('<instance>').chan.<c>` can name. Absent, an
   * instance's channels are unreadable, as they were before.
   */
  readonly instances?: InstanceChannelSources | undefined;
  /** VN36: the dissolved instances `op('<instance>').par.<key>` can name (`InstancePages`). */
  readonly pages?: InstancePages | undefined;
  /**
   * §T1674b: the channels a node's definition composes from its own parameters. Asked
   * BEFORE the channel resolver: they need none.
   */
  readonly declaredChannelsOf?: (node: GraphNode) => ParameterChannels | undefined;
}

/**
 * A number, or a reason it is not one.
 *
 * Only numeric parameters are readable, and that is §V71's rule rather than a limitation
 * of this function: an expression evaluates to a number, so a reference inside one has to
 * be a number too. A curve reports what it is instead of being coerced into whatever its
 * first channel happens to hold; a COMPOUND says which components it has, because
 * `op('x').par.color.r` is now a thing you can write (T332) and "reads a number" alone
 * would send the user looking for the wrong fix.
 */
function asNumber(value: ParameterValue | undefined, reference: string): NodeReferenceResult {
  if (typeof value === "number") return { ok: true, value };
  if (typeof value === "boolean") return { ok: true, value: value ? 1 : 0 };
  if (value === undefined) return { ok: false, kind: "unreadable", reason: `${reference} has no value` };
  return {
    ok: false,
    kind: "unreadable",
    reason: `${reference} is ${Array.isArray(value) ? "a list" : typeof value}, and an expression reads a number`,
  };
}

export function createNodeReferenceReader(options: NodeReferenceOptions, remember: ReaderMemory = {}): NodeReferenceReader {
  const scope: ReaderScope = { index: null, resolved: new Map(), cycles: 0, subtrees: null };
  if (remember.expressions === true) scope.subtrees = { values: new Map(), fired: () => scope.cycles };
  return askedBy(options, new Set(), scope);
}

/**
 * T1720b — what a reader may remember beyond §T1172's targets, asked for by a caller that
 * knows nothing it reads moves while the reader lives once it has been read: a frame's
 * compile, whose channels were settled before it began (`frame-compile.ts`), and the value
 * graph, whose channels are each read only after their publisher ran (`value-graph.ts`).
 */
export interface ReaderMemory {
  readonly expressions?: boolean;
}


/**
 * A reader on a path, with what a caller asks of it beside a read: the spelling help, and
 * §B293's `readingFrom`. The parameter that asks joins the path, so a read that comes back to
 * it is a ring at once. Inside a read the asker is already on the path (`targetOf` put it
 * there), and the reader is handed back as it is: only a resolve that STARTS here pays.
 */
function askedBy(options: NodeReferenceOptions, visited: ReadonlySet<ReadKey>, scope: ReaderScope): NodeReferenceReader {
  const reader: NodeReferenceReader = Object.assign(readerWithin(options, visited, scope), {
    ...(scope.subtrees === null ? {} : { subtrees: scope.subtrees }),
    spelledLike: (bare: string): SpelledLike => spelledLike(options, scope, bare),
    readingFrom: (nodeId: string, key: string): NodeReferenceReader => {
      const dot = key.indexOf(".");
      const id = readKey(nodeId, dot < 0 ? key : key.slice(0, dot));
      return visited.has(id) ? reader : askedBy(options, new Set([...visited, id]), scope);
    },
  });
  return reader;
}

/**
 * §T1641b: a read of a parameter that carries a failure of its own is `upstream`: it clears
 * when that one does. Two kinds pass UP the chain instead, because they are as true of the
 * reader as of what it read:
 *
 *  - a CYCLE. §V152's guard fires one hop inside the loop, so the reader at the top of a
 *    chain only ever sees the loop as its target's diagnostic; passing the kind up is what
 *    lets each parameter on the loop say so where its author is looking, at the severity a
 *    loop has everywhere else.
 *  - NO CHANNEL RESOLVER. A parameter that reads a parameter that reads a channel is waiting
 *    on the same caller (§V338). While the tier was found by searching the message, this
 *    held by accident of the text being quoted; 159 reads in the shipped examples depend on
 *    it at every structural compile (E55's haze reads the reactor's knobs).
 */
function upstreamKind(diagnostic: RuntimeDiagnostic): ReferenceFailureKind {
  if (diagnostic.code === REFERENCE_CYCLE_CODE) return "cycle";
  if (diagnostic.code === CHANNELS_UNAVAILABLE_CODE) return "noResolver";
  return "upstream";
}

/**
 * §T1641b — what in the graph is spelled like a bare name an expression could not read: a
 * node named it, or named `kind_<it>` (T1593b: the role is what an author remembers), and
 * every node publishing a channel of that name right now. For the message only. It runs on
 * a failure that can never evaluate, never on a read.
 */
function spelledLike(options: NodeReferenceOptions, scope: ReaderScope, bare: string): SpelledLike {
  scope.index ??= nodeNames(options.graph);
  const wanted = bare.toLowerCase();
  const channels = options.base?.channels;
  const nodes: string[] = [];
  const publishers: string[] = [];
  for (const [name, id] of scope.index) {
    const spelled = name.toLowerCase();
    if (spelled === wanted || spelled.endsWith(`_${wanted}`)) nodes.push(name);
    const node = options.graph.nodes[id];
    if (channels === undefined || node === undefined) continue;
    const supplied = channels(`${name}:${bare}`, {
      node,
      key: bare,
      definition: { type: "number", label: bare, default: 0 } as const,
      ...(options.base?.frame === undefined ? {} : { frame: options.base.frame }),
    });
    if (typeof supplied === "number" && Number.isFinite(supplied)) publishers.push(name);
  }
  return { nodes, publishers };
}

/**
 * ═══════════════════════════════════════════════════════════════════════════════════
 * THE NAME INDEX, BUILT ONCE PER READER (T1172)
 * ═══════════════════════════════════════════════════════════════════════════════════
 *
 * `nodeByName` calls `nodeNames`, which SORTS EVERY NODE ID AND BUILDS A FRESH `Map` —
 * and it was called once per `op()` read. E55's `haze1` alone makes twenty-one of them a
 * frame, so a graph's name index was rebuilt twenty-one times to answer twenty-one
 * questions about the same unchanged graph. The index is a pure function of the graph, so
 * building it once and asking it twenty-one times is the same answer for a twenty-first
 * of the work.
 *
 * ⚠ WHY THE SCOPE IS THE READER AND NOT THE GRAPH, A REVISION, OR A MODULE-LEVEL MAP.
 * A `GraphDocument` is not always a settled document: `apply-patch.ts` calls `nodeNames`
 * on an immer DRAFT it is still mutating — two `addNode` ops in one patch, and the second
 * one's `uniqueNodeName` MUST see the node the first one added. A memo keyed on graph
 * identity would hand it the index from before the first add and mint a duplicate name,
 * which §V127 says cannot exist. So this memo lives where the graph provably does not
 * move: inside ONE reader, which is built by `parameterReadOptions` per compile,
 * per inspector render, per OSC event, and is only ever read from. A new frame builds a
 * new reader and therefore a new index; there is nothing to invalidate and nothing that
 * could forget to. `names.ts` itself is left alone, which is what keeps the draft path
 * exactly as correct as it was.
 *
 * The scope is threaded through `readerWithin`'s recursion rather than captured per hop,
 * because a chain of references (`a → b → c`) walks the same graph the whole way down.
 */
interface ReaderScope {
  index: ReadonlyMap<string, NodeId> | null;
  /** T1172, §B293: what each (node, key) resolved to, for this reader's lifetime. See `targetOf`. */
  readonly resolved: Map<ReadKey, ResolvedParameters>;
  /** T1172: how many times §V152's cycle guard has fired. See `targetOf`. */
  cycles: number;
  /**
   * T1720b: subtree values by interned tree for the reader's life, or null for a reader that
   * remembers none. Kept under §T1172's rule: a value computed while the cycle guard fired is
   * not kept (`SubtreeMemory`, `evaluate.ts`).
   */
  subtrees: SubtreeMemory | null;
}

function nodeIdNamed(scope: ReaderScope, graph: GraphDocument, name: string): NodeId | undefined {
  scope.index ??= nodeNames(graph);
  return scope.index.get(name);
}

/**
 * ═══════════════════════════════════════════════════════════════════════════════════
 * THE TARGET MEMO (T1172) — THE ONE THAT CHANGES THE COMPLEXITY CLASS
 * ═══════════════════════════════════════════════════════════════════════════════════
 *
 * A read is a RESOLVE of the parameter it names — recursively, through that parameter's
 * own expressions (§B293: the one parameter; it was the target's whole set until the guard
 * moved to (node, key)). That is the right semantics (it is what makes
 * `op('a').par.x` worth whatever `a.x` is worth) and it was being paid once PER READ, so a
 * chain of references was quadratic and E55's twenty-one reads of `reactor1` resolved
 * `reactor1` twenty-one times a frame. §T1172 measured it, render cost held constant: 20
 * chained refs 5.4 ms/frame, 40 chained 15.3, 160 nodes + 160 chained **306 ms**.
 *
 * The memo is per READER, which is per frame — the same scope the name index lives in, and
 * for the same reason: a reader is built by `parameterReadOptions` and only ever read
 * from, so there is no window in which the graph it was built over can change underneath it.
 * A new frame builds a new reader and resolves everything again, which is what keeps a
 * driven value MOVING (§B181: a memo that survived the frame would freeze every reference
 * on the number it had when the memo was minted, and every static assertion would stay
 * green while the picture stopped).
 *
 * ⚠ WHY A CYCLE FORBIDS THE ENTRY. The result of a resolve depends on `visited` — but only
 * through §V152's guard, which is the sole place `visited` is read. So a resolve during
 * which the guard never fired is PATH-INDEPENDENT and safe to reuse under any other chain:
 * if a longer chain could make the guard fire inside this subtree, some parameter of that chain
 * is reachable from this target and also reaches it, which is a graph cycle — and that same
 * cycle fires the guard under the shorter chain too, one hop further down. So "no fire in
 * this subtree" is exactly the condition, and the counter around the resolve is how it is
 * read. Cycle-carrying documents (which §V152 refuses at authoring time and
 * `referenceCycleDiagnostics` reports on load) therefore keep resolving exactly as they
 * did, path by path, and go on naming the loop rather than a memo of it.
 */
function targetOf(
  options: NodeReferenceOptions,
  scope: ReaderScope,
  visited: ReadonlySet<ReadKey>,
  targetId: NodeId,
  target: GraphNode,
  schema: ParameterSchema,
  key: string,
  definition: ParameterDefinition,
): ResolvedParameters {
  const id = readKey(targetId, key);
  const hit = scope.resolved.get(id);
  if (hit !== undefined) return hit;
  const firesBefore = scope.cycles;
  // The recursive step. The ONE parameter resolves with the same frame and channels, and
  // with a reader that remembers we came through here — so a ring is caught one hop before
  // it would repeat rather than however many frames later the stack gives out. The whole
  // schema rides along as the SIBLING schema: a bind on the target reads its own node.
  const resolved = resolveParameterSchema(target, { [key]: definition }, {
    ...readOptionsOf({
      ...options.base,
      nodes: askedBy(options, new Set([...visited, id]), scope),
    }),
    schema,
  });
  if (scope.cycles === firesBefore) scope.resolved.set(id, resolved);
  return resolved;
}

/** §B293: one parameter of one node, by its BASE key (a compound resolves whole). */
type ReadKey = string;
const readKey = (nodeId: NodeId, key: string): ReadKey => `${nodeId}\u0000${key}`;
const ringText = (chain: readonly string[]): string => chain.map((entry) => entry.replace("\u0000", ".")).join(" → ");

/**
 * §T1551b — WHAT A FLATTENING CONTRIBUTES TO A READ, beside its graph.
 *
 * `FlattenedGraph` carries both, so the runtime hands its flattening over WHOLE
 * (`runtime.flattened.current()`) and no consumer picks fields off it. That is the point:
 * every evaluation input the flattening grew — the morphs (T1497b), the instances
 * (T1485b) — was threaded by hand into each of a dozen readers, and the ones that were
 * missed still compiled. A field added HERE reaches every reader handed a flattening, and
 * is a type error at every site that spells one out (`NO_FLATTENING`, the compiler's
 * `flatteningReadsOf`, the inspector).
 */
export interface FlatteningReads {
  /** T1497b: the preset morphs in flight — a reference to a fading parameter reads the fade. */
  readonly morphs: ParameterMorphs;
  /** T1485b: the component instances `op('<instance>').chan.<c>` can name. */
  readonly instanceChannels: InstanceChannelSources;
  /** VN36: the component instances `op('<instance>').par.<key>` (and so `parent()`) can name. */
  readonly instancePages: InstancePages;
  /**
   * T1668b — THE SAME OBJECT FOR TWO FLATTENINGS THAT DIFFER IN VALUES ONLY, where the
   * producer can say so (the app's one flattening, `flattened-graph.ts`, which asks
   * `classifyRevision`). What depends on a document's structure alone — who reads whom,
   * the order value nodes evaluate in — is memoised on this instead of on the flattened
   * document, which is another object for every value written. Absent: no such promise,
   * and a reader keys on the document itself.
   */
  readonly structure?: object;
}

/** No component instance to name. One object, so "none" is an identity check. */
export const NO_INSTANCES: InstanceChannelSources = new Map();

/** No instance page to read (VN36). One object, so "none" is an identity check. */
export const NO_PAGES: InstancePages = new Map();

/**
 * A read with no flattening behind it: nothing fading, no instance to name. A caller that
 * has none says so with this, by name — there is no omitted field for it to forget.
 */
export const NO_FLATTENING: FlatteningReads = { morphs: NO_MORPHS, instanceChannels: NO_INSTANCES, instancePages: NO_PAGES };

/**
 * §T1551b — THE LIVE READ WORLD: what every CPU reader outside the plan resolves with — the
 * compile's channel resolver and the runtime's flattening, each a getter read at the moment
 * of a resolve. Produced ONCE, by the composition root (`app.tsx`'s `liveReads`), and handed
 * to the analyze, depth, vision, perform-window and viewer readers whole, so none of them
 * assembles its own from whatever it happens to hold.
 */
export interface LiveParameterReads {
  readonly channels: () => ChannelResolver | undefined;
  /** The runtime's flattening (`runtime.flattened.current()`), or `NO_FLATTENING`. */
  readonly flattening: () => FlatteningReads;
}

/**
 * What a call site knows: the graph being read, the catalogue, WHEN, the channels, and the
 * flattening. §T1551b: EVERY FIELD IS REQUIRED. `frame` and `channels` may be `undefined`,
 * but the key must be written, so "no moment" and "no resolver" are things a caller says
 * rather than things it leaves out — and an input added here later is a type error at every
 * site that does not supply it, which is the whole guard.
 */
export interface ParameterReadContext {
  /**
   * The graph `op()` names resolve in, and WHICH one (§T1552b): the flattening a frame path
   * evaluates (`runtime.flattened.current().graph`), or the document as authored, said by
   * name (`authoredGraph(document)`: the inspector, a command's read scope). A bare
   * `GraphDocument` is a type error, so no reader evaluates one side believing it the other.
   */
  readonly graph: FlatOrAuthoredGraph;
  /**
   * The catalogue, as the ONE thing this reads from it: a type's schema source (§T903).
   * Structural, so the pulse watcher — which is handed exactly that and no more — asks
   * this factory for its reader like every other call site (T1500b).
   */
  readonly registry: { readonly get: (type: string) => ParameterSchemaSource | undefined };
  /**
   * The moment. A PARAMETER rather than a field the caller sets afterwards, because
   * setting it on the resolve and forgetting it on the reader is the entire bug (§B46).
   * `undefined` = the zero frame: what the document says.
   */
  readonly frame: FrameEvaluationInput | undefined;
  /** `undefined` = `op('x').chan.*` reports "no channel resolver" and §V108's static stands. */
  readonly channels: ChannelResolver | undefined;
  /**
   * The morphs in flight and the instances `op()` can name (`FlatteningReads`): the
   * runtime's flattening, whole, or `NO_FLATTENING`. Read INSIDE the reader, which is why
   * they are here at all.
   */
  readonly flattening: FlatteningReads;
}

/**
 * §V837 / §T1129 — THE ONE FACTORY. The reader and the options it is read alongside are
 * built here, together, or they are not built.
 *
 * `op('lfo1').chan.value` is read INSIDE the reader, off `NodeReferenceOptions.base`. The
 * reader is a CLOSURE built before the resolve, so the `frame` and `channels` handed to
 * `resolveParameters` never reach it: a caller that builds a reader with no `base` gets a
 * panel, a plan or a pump that answers every `.chan` read with "this context has no
 * channel resolver", falls back to §V108's retained static, and freezes there while the
 * picture animates. That is §B8's shape, and it has now recurred FOUR times — §T593, the
 * inspector (§T1000), the OSC pump (§T1001), and §B46 before them.
 *
 * Every one of those fixes was correct and local, and every one left the next call site
 * free to omit the pairing again: three sites each spelled this out, and nothing made
 * site four spell it. So the pairing is no longer spelled at a call site at all. A caller
 * says WHICH graph, WHICH catalogue and WHEN; it cannot say "reader without base",
 * because there is no longer an argument for it.
 *
 * §T1551b closed the same hole one level up: the CONTEXT's fields were optional, so the
 * morphs (T1497b) and the instances (T1485b) each reached only the readers someone
 * remembered to hand them to. They are required now (`ParameterReadContext`), and
 * `parameter-read-context.test.ts` holds that no product file builds a reader any other way.
 */
export function parameterReadOptions(context: ParameterReadContext, remember: ReaderMemory = {}): ParameterReadOptions {
  const { morphs, instanceChannels, instancePages } = context.flattening;
  const base = {
    ...(context.channels === undefined ? {} : { channels: context.channels }),
    ...(context.frame === undefined ? {} : { frame: context.frame }),
    morphs,
  };
  return readOptionsOf({
    nodes: createNodeReferenceReader({
      graph: context.graph,
      /*
       * §T903 — through the funnel: `op('lantern').par.orbitSpeed` reads a key that only
       * exists in the node's REFLECTED schema, and a static-schema reader would answer
       * "no such parameter" for a control the inspector is showing.
       */
      schemaOf: (node) => {
        // §T1641b: a type this build does not have is NOT a node with no parameters. Read as
        // an empty schema, every reference to a placeholder said "has no parameter", which
        // is a claim about the document; the truth is about the build (§V10).
        const source = context.registry.get(node.type);
        return source === undefined ? undefined : effectiveParameterSchema(source, node.parameters);
      },
      base,
      instances: instanceChannels,
      pages: instancePages,
      declaredChannelsOf: (node) => context.registry.get(node.type)?.parameterChannels,
    }, remember),
    ...base,
  });
}

/**
 * §T1557b — THE BRAND, applied. This module is the producer of `ParameterReadOptions`, and
 * the only one: `node-references.test.ts` refuses the cast anywhere else, so a read is
 * either built here from a complete `ParameterReadContext` or it is `STORED_READ`.
 */
function readOptionsOf(options: Pick<ResolveParametersOptions, "frame" | "channels" | "nodes" | "morphs">): ParameterReadOptions {
  return options as ParameterReadOptions;
}

/**
 * T1485b — `op('<instance>').chan.<c>`: the union of the instance's exposed value outputs.
 *
 * Each publisher is asked for `<c>` exactly as `op('<publisher>').chan.<c>` would ask, so an
 * instance reads the same number as the node inside it. A name more than one publisher
 * carries RIGHT NOW is refused, naming every port it arrived on: picking one would be a
 * number that looks like an answer while the other output says something else (§V71's
 * reasoning, one level up). The bare-channel fallback of `.chan.value` holds only for an
 * instance with ONE publisher, which is the case where it reads exactly like that node.
 */
function readInstanceChannel(
  reference: string,
  name: string,
  key: string,
  sources: readonly InstanceChannelSource[],
  channels: ChannelResolver,
  frame: FrameEvaluationInput | undefined,
  nodeNamed: (label: string) => GraphNode | undefined,
): NodeReferenceResult {
  const found: Array<{ port: PortId; value: number }> = [];
  for (const source of sources) {
    // The context rides along for resolvers that want the frame; they key on the ADDRESS.
    // The publisher is in the flat graph; in the document, the instance stands for it.
    const node = nodeNamed(source.publisher) ?? nodeNamed(name);
    if (node === undefined) return { ok: false, kind: "node", reason: `${reference}: there is no node named "${name}"` };
    const context = {
      node,
      key,
      definition: { type: "number", label: key, default: 0 } as const,
      ...(frame === undefined ? {} : { frame }),
    };
    const direct = channels(`${source.publisher}:${key}`, context);
    const supplied =
      direct ?? (key === "value" && sources.length === 1 ? channels(source.publisher, context) : undefined);
    if (typeof supplied === "number" && Number.isFinite(supplied)) found.push({ port: source.port, value: supplied });
  }
  const [first, ...others] = found;
  if (first === undefined) {
    return { ok: false, kind: "channel", reason: `${reference}: "${name}" publishes no channel "${key}" right now` };
  }
  if (others.length > 0) {
    const ports = found.map((entry) => `"${entry.port}"`);
    const listed = `${ports.slice(0, -1).join(", ")} and ${ports[ports.length - 1]}`;
    return {
      ok: false,
      kind: "ambiguous",
      reason: `${reference}: "${name}" publishes "${key}" on ${found.length} outputs, ${listed}, so the read is ambiguous — rename the channel on one of them inside the component, or read the node that feeds one`,
    };
  }
  return { ok: true, value: first.value };
}

/**
 * `visited` carries the chain of nodes already being resolved on THIS path.
 *
 * Per-path, not per-reader: two unrelated parameters both reading `op('gain1').par.value`
 * are not a cycle, and a reader that shared one visited set across a whole compile would
 * call the second one a loop. The set grows only as the recursion descends.
 */
function readerWithin(
  options: NodeReferenceOptions,
  visited: ReadonlySet<ReadKey>,
  /** T1172: the name index this whole read shares — see `nodeIdNamed`. */
  scope: ReaderScope,
): NodeReferenceReader {
  return (name, path): NodeReferenceResult => {
    const reference = `op('${name}').${path.join(".")}`;

    const [namespace, key, component, ...rest] = path;

    /**
     * T901 — `op('name').chan.<channel>`: a value node's OUTPUT, read through the SAME
     * channels resolver the old `driven` mode used, so an expression can do inline maths on
     * a live signal (`op('lfo1').chan.value * 2 + 0.1`) — TD's model, where a channel read
     * is just an expression term and no separate mode exists. `.chan.value` also answers a
     * node's single/bare channel, exactly as the bare `driven` address did, so §T897's
     * migration maps `name` → op('name').chan.value and `name:c` → op('name').chan.c with
     * identical resolution by construction.
     */
    if (namespace === CHANNEL_NAMESPACE) {
      if (key === undefined || component !== undefined || rest.length > 0) {
        return {
          ok: false,
          kind: "unreadable",
          reason: `${reference}: name one channel, as op('${name}').chan.value or op('${name}').chan.low`,
        };
      }
      const channels = options.base?.channels;
      // §V338: name what would make it present, not accuse the graph — same contract as the
      // old driven mode's missing-resolver case, and the same INFO tier (the resolver gives
      // this KIND that tier), because a headless caller with no resolver is a normal state,
      // not a broken document.
      const resolverless: NodeReferenceResult = {
        ok: false,
        kind: "noResolver",
        reason: `${reference}: ${CHANNEL_RESOLVER_MISSING}, so "${name}"'s channels cannot be read`,
      };
      // T1485b: an INSTANCE is read through the inner nodes its value outputs expose. Asked
      // before the node lookup: in the flat graph the instance is gone, and in the document
      // it is present but publishes nothing under its own name.
      const sources = options.instances?.get(name);
      if (sources !== undefined) {
        if (channels === undefined) return resolverless;
        return readInstanceChannel(reference, name, key, sources, channels, options.base?.frame, (label) => {
          const id = nodeIdNamed(scope, options.graph, label);
          return id === undefined ? undefined : options.graph.nodes[id];
        });
      }
      // §T1641b: whether the node EXISTS is a fact about the document, so it is decided
      // before "no channel resolver", which is a fact about the caller. In the other order
      // every headless reader (a validate, a build script, a structural compile) answered a
      // read of a name nothing holds with the resolver's INFO, and said nothing of the name.
      const channelTarget = nodeIdNamed(scope, options.graph, name);
      const channelNode = channelTarget === undefined ? undefined : options.graph.nodes[channelTarget];
      if (channelNode === undefined) {
        return { ok: false, kind: "node", reason: `${reference}: there is no node named "${name}"` };
      }
      /*
       * §T1674b — A CHANNEL THE DEFINITION COMPOSES FROM THE NODE'S OWN PARAMETERS (a camera's
       * pose in the world). Decided before "no channel resolver": it needs none. It is the
       * `.par` read's own recursive step, off the same per-frame resolve of the target, so a
       * frame that reads seven channels of one camera resolves that camera once, and the
       * cycle guard is the same guard.
       */
      const declared = options.declaredChannelsOf?.(channelNode);
      if (declared !== undefined && channelTarget !== undefined) {
        if (!Object.hasOwn(declared.names, key)) {
          const offered = Object.keys(declared.names);
          const near = nearestSpelling(key, offered);
          return {
            ok: false,
            // Never, not "not yet": the list is the definition's, and this name is not on it.
            kind: "unreadable",
            reason: `${reference}: "${name}" publishes no channel "${key}"`,
            suggestion: `${near === null ? "" : `Nearest: "${near}". `}"${name}" (${channelNode.type}) publishes: ${offered.join(", ")}.`,
          };
        }
        // §B293: the channel is composed FROM these parameters, so one of them already being
        // resolved on this path is a ring, and it is named: the parameter, through the channel.
        const ringed = declared.reads.find((parameter) => visited.has(readKey(channelTarget, parameter)));
        if (ringed !== undefined) {
          scope.cycles += 1;
          return {
            ok: false,
            kind: "cycle",
            reason: `${reference}: that reference is a cycle (${ringText([...visited, `${channelTarget}.chan.${key}`, readKey(channelTarget, ringed)])}): "${name}" composes ${key} from its ${ringed}`,
          };
        }
        const schema = options.schemaOf(channelNode);
        if (schema === undefined) {
          return { ok: false, kind: "unknownType", reason: `${reference}: "${name}" has an unknown node type` };
        }
        // A parameter the channel is composed from that fell back is not a pose: its failure
        // is the read's (the rule the `.par` read has, over every parameter this one reads).
        const composedFrom: Record<string, ParameterValue> = {};
        for (const parameter of declared.reads) {
          const definition = Object.hasOwn(schema, parameter) ? schema[parameter] : undefined;
          if (definition === undefined) continue;
          const resolved = targetOf(options, scope, visited, channelTarget, channelNode, schema, parameter, definition);
          const entry = resolved.get(parameter);
          const governing = entry?.diagnostic ?? entry?.components?.find((each) => each.diagnostic != null)?.diagnostic ?? null;
          if (governing !== null) return { ok: false, kind: upstreamKind(governing), reason: `${reference}: ${governing.message}` };
          composedFrom[parameter] = resolved.values[parameter] as ParameterValue;
        }
        const composed = declared.evaluate(composedFrom)[key];
        if (typeof composed !== "number" || !Number.isFinite(composed)) {
          return { ok: false, kind: "channel", reason: `${reference}: "${name}" publishes no channel "${key}" right now` };
        }
        return { ok: true, value: composed };
      }
      if (channels === undefined) return resolverless;
      // The resolvers in use (value graph, analyze) key on the ADDRESS; the context rides
      // along for ones that want the frame. The definition is nominal — a channel is a
      // number by contract (§V143).
      const channelContext = {
        node: channelNode,
        key,
        definition: { type: "number", label: key, default: 0 } as const,
        ...(options.base?.frame === undefined ? {} : { frame: options.base.frame }),
      };
      const direct = channels(`${name}:${key}`, channelContext);
      const supplied = direct ?? (key === "value" ? channels(name, channelContext) : undefined);
      if (typeof supplied !== "number" || !Number.isFinite(supplied)) {
        return {
          ok: false,
          kind: "channel",
          reason: `${reference}: "${name}" publishes no channel "${key}" right now`,
        };
      }
      return { ok: true, value: supplied };
    }

    if (namespace !== PARAMETER_NAMESPACE) {
      return {
        ok: false,
        kind: "unreadable",
        reason: `${reference}: only .${PARAMETER_NAMESPACE} and .${CHANNEL_NAMESPACE} are readable (op('${name}').par.<parameter>, op('${name}').chan.<channel>)`,
      };
    }
    if (key === undefined || rest.length > 0) {
      return {
        ok: false,
        kind: "unreadable",
        reason: `${reference}: name one parameter, as op('${name}').par.gain, or one of its components, as op('${name}').par.color.r`,
      };
    }

    // VN36: a name no flat node carries may be a dissolved instance, read through its page.
    const page = nodeIdNamed(scope, options.graph, name) === undefined ? options.pages?.get(name) : undefined;
    const targetId = page?.node.id ?? nodeIdNamed(scope, options.graph, name);
    if (targetId === undefined) {
      return { ok: false, kind: "node", reason: `${reference}: there is no node named "${name}"` };
    }
    if (visited.has(readKey(targetId, key))) {
      // §V152. Named, not "maximum call stack exceeded": the user joined specific
      // parameters and has to be told which. T1172: counted, because a resolve whose subtree
      // fired this guard is path-dependent and may not be memoised — see `targetOf`.
      // §B293: THIS parameter is already being resolved on this path. Another parameter of
      // the same node is not, and is read like any other.
      scope.cycles += 1;
      return {
        ok: false,
        kind: "cycle",
        reason: `${reference}: that reference is a cycle (${ringText([...visited, readKey(targetId, key)])})`,
      };
    }
    const target = page?.node ?? options.graph.nodes[targetId];
    if (target === undefined) {
      return { ok: false, kind: "node", reason: `${reference}: there is no node named "${name}"` };
    }
    const schema = page?.schema ?? options.schemaOf(target);
    if (schema === undefined) {
      return { ok: false, kind: "unknownType", reason: `${reference}: "${name}" has an unknown node type` };
    }
    const definition = Object.hasOwn(schema, key) ? schema[key] : undefined;
    if (definition === undefined) {
      const declared = Object.keys(schema).sort();
      const near = nearestSpelling(key, declared);
      return {
        ok: false,
        kind: "unreadable",
        reason: `${reference}: "${name}" has no parameter "${key}"`,
        suggestion:
          declared.length === 0
            ? `"${name}" (${target.type}) declares no parameters.`
            : `${near === null ? "" : `Nearest: "${near}". `}"${name}" (${target.type}) declares: ${declared.join(", ")}.`,
      };
    }

    /**
     * §V113's component addressing, reached from another node (T332).
     *
     * The grammar has parsed `op('x').par.color.r` since T221; the reader refused it
     * rather than guess a namespace. It is not a nicety: colour is stored as four
     * independently-moded slots precisely so one channel can be driven, and a channel
     * nothing outside its own node can read is only half of that.
     *
     * The names and the error wording come from `componentNamesFor` and read like the
     * LOCAL bind case (`color.r` as a bind ref, `resolveBindRef`) because §V113 already
     * settled that grammar — a second spelling for the same idea is a thing users have to
     * learn twice and we have to keep in sync forever.
     *
     * The number handed back is the channel in its STORED space, which for a
     * `space: "display"` colour means the picker's number and not the linear one. Same as
     * the local bind, same as `ResolvedParameter.value`, and deliberate: the decode
     * happens once, where `values` leaves the resolver as evaluation input (T148, §V56).
     * Decoding here would decode twice for anything that lands back on a colour — T187's
     * measured bug (stored 0.5 reached the shader as 0.0376), and the reason the rule is
     * written down at all.
     */
    const componentNames = componentNamesFor(definition);
    if (component !== undefined) {
      if (componentNames === null) {
        return {
          ok: false,
          kind: "unreadable",
          reason: `${reference}: "${key}" is a ${definition.type} and has no components`,
        };
      }
      if (!componentNames.includes(component)) {
        return {
          ok: false,
          kind: "unreadable",
          reason: `${reference}: "${key}" has no component "${component}" (it has ${componentNames.join(", ")})`,
        };
      }
    }

    // T1172: through the per-frame memo, so a chain of references stops being quadratic.
    const resolved = targetOf(options, scope, visited, targetId, target, schema, key, definition);

    /**
     * The referenced parameter has to have resolved, not merely produced a number.
     *
     * §V108 hands back a fallback whenever a binding fails, so `values[key]` is populated
     * either way — and reading it blindly makes a broken reference look healthy. It is
     * worst for cycles: a loop is caught one hop down, that hop falls back to its default,
     * and the caller reads the default as a perfectly good answer. The cycle is then
     * INVISIBLE at the top of the chain, which is precisely where the person who wrote it
     * is looking.
     *
     * So a diagnostic on the referenced entry propagates. It is the right rule beyond
     * cycles too: referencing a parameter whose own expression is broken should say that,
     * rather than quietly yield the default and read as a working reference to a wrong
     * number.
     */
    const entry = resolved.get(key);

    if (component !== undefined) {
      const resolvedComponent = entry?.components?.find((each) => each.name === component);
      /**
       * §V262 — §V243 applied to the channel actually being read, and not wider.
       *
       * A component with its OWN slot resolved on its own terms, so the compound's
       * fallback says nothing about it and forwarding that diagnostic would be a false
       * alarm on a channel that is fine. One with no slot follows the compound, so it
       * inherits the compound's problem along with the compound's number — and reporting
       * the value without the diagnostic is exactly the fallback-hides-the-error trap,
       * one channel at a time and therefore harder to see.
       */
      const storedItself = target.parameters[componentKey(key, component)] !== undefined;
      const governing =
        resolvedComponent?.diagnostic ?? (storedItself ? null : (entry?.diagnostic ?? null));
      if (governing !== null) return { ok: false, kind: upstreamKind(governing), reason: `${reference}: ${governing.message}` };
      return asNumber(resolvedComponent?.value, reference);
    }

    if (entry?.diagnostic != null) {
      return { ok: false, kind: upstreamKind(entry.diagnostic), reason: `${reference}: ${entry.diagnostic.message}` };
    }
    if (componentNames !== null) {
      // A compound read WHOLE. Taking channel 0 would be a number that looks like an
      // answer (§V71); the fix is one keystroke away, so the message spells it.
      return {
        ok: false,
        kind: "unreadable",
        reason: `${reference} is a ${definition.type}, and an expression reads a number — name a component, as ${reference}.${componentNames[0] ?? "r"}`,
      };
    }
    return asNumber(entry?.value, reference);
  };
}
