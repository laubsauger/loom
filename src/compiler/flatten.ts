import type {
  ComponentPath,
  ComponentRecursionError,
  GraphComponentDefinition,
  ParentScope,
} from "../domain/types/components.ts";
import type { RuntimeDiagnostic } from "../domain/types/diagnostics.ts";
import type { FlatGraph, GraphDocument, GraphEdge, GraphNode } from "../domain/types/graph.ts";
import type { NodeId, PortId } from "../domain/types/ids.ts";
import type {
  ParameterSchema,
  ParameterValue,
  StoredParameter,
} from "../domain/types/parameters.ts";
import type { ParameterMorphs } from "../domain/parameters/resolve.ts";
import { NO_PAGES, type FlatteningReads, type InstanceChannelSource, type InstanceChannelSources, type InstancePage, type InstancePages } from "../domain/parameters/node-references.ts";
import { NO_MORPHS, buildMorphIndex, type MorphIndexInput, type PublishedOrigin } from "../domain/presets/morph-index.ts";
import { timelineCueProblems } from "../domain/presets/timeline-cues.ts";
import { renumberedName, rewriteNodeNameReferences } from "../domain/graph/names.ts";
import { isPreviewablePortKind } from "../domain/graph/previewable.ts";
import { effectiveParameterSchema, STORED_READ } from "../domain/parameters/resolve.ts";
import { componentKey, isComponentKeyOf, isParameterSlot, parseComponentKey, storedStaticValue } from "../domain/parameters/slots.ts";
import type { NodeRegistryView } from "../nodes/registry/registry.ts";
import type { NodeDefinition } from "../domain/types/node-definition.ts";
import type { PortType } from "../domain/types/ports.ts";
import type { ChannelMask } from "../domain/types/graph.ts";
import { compareEdgeOrder } from "../domain/graph/edge-order.ts";
import { bypassPassthroughPairs } from "../domain/graph/bypass.ts";
import { channelMaskBoundaryDefinition } from "./channel-mask-boundary.ts";
import {
  PARENT_BINDINGS_STATE_KEY,
  buildParentScope,
  componentSourcePath,
  describeRecursion,
  detectComponentRecursion,
  instanceDisplayNames,
  instanceOwnParameters,
  internalParameterPath,
  isComponentInstance,
  isComponentNodeType,
  parentBindResolver,
  parentScopeDrivers,
  parseInternalParameterPath,
  parseParentReference,
  publishedSchema,
  readComponentInstance,
  readParentBindings,
} from "../domain/components/index.ts";
import type { ComponentRegistryView } from "../domain/components/index.ts";
import { CompilerDiagnosticCode, compilerDiagnostic } from "./diagnostics.ts";
import { resolveNodeParameters } from "./validate.ts";
import type { ActiveSink } from "./types.ts";
import { COMPONENT_ID_SEPARATOR, flattenedNodeId } from "../domain/components/internal-resolutions.ts";
import type { NameScope } from "../domain/components/addressing.ts";
import { resolvePathReferences } from "./path-references.ts";
import { resolveParentReferences, type EnclosingInstance } from "./parent-references.ts";
import { parentReadsOf } from "../domain/expressions/index.ts";
import { applyInstance } from "../domain/components/apply-instance.ts";
import { isDefaultChannelMask } from "../domain/types/graph.ts";
export { COMPONENT_ID_SEPARATOR, flattenedNodeId } from "../domain/components/internal-resolutions.ts";

/**
 * Component flattening (T134, T135, §V82, §V83).
 *
 * A component does not compile as a node. It is INLINED into the parent logical graph
 * before anything else in the compiler runs, so the plan the backend receives has no idea
 * components exist — pruning, ordering, resolution propagation and resource assignment
 * all keep working on one flat graph, unchanged (§V25, §V21, §V6).
 *
 * Two things have to survive that inlining, and they are the whole of this module:
 *
 *  - the VALUES. An internal parameter driven by a published knob takes the instance's
 *    value, not the value stored in the definition's graph (§V80); a `parent.<key>`
 *    binding takes the value from the owning instance, walked lexically (§V81). Both are
 *    resolved here, at compile time (§V21), and baked onto the flattened node — so the
 *    rest of the compiler reads one ordinary `GraphNode` and cannot get it wrong.
 *
 *    T1017 qualifies "baked": a published knob whose mode can MOVE per frame is handed
 *    down as its own unresolved SLOT rather than a number, so the internal parameter it
 *    drives animates through the per-frame values-only resolution (§V163) while this
 *    walk stays a pure function of the document and keeps its memo (§V529). Still one
 *    ordinary `GraphNode`: a slot is what a parameter written by hand holds too. See
 *    `publishedPage`.
 *
 *  - the SOURCE PATH. Every flattened node keeps `Main / DreamyFeedback_2 / Blur_1`, so a
 *    diagnostic, a timing row or a profile entry names a place the user can navigate to
 *    rather than an internal node id they have never seen (§V82).
 *
 * ## Id namespacing
 *
 * A flattened internal node is named `<instance node id>/<internal node id>`, applied once
 * per level of nesting: `feedback1/blur2/inner3`. That makes two instances of the same
 * component disjoint (`feedback1/blur` vs `feedback2/blur`), keeps root node ids untouched
 * so an existing plan's resource ids do not move, and stays reversible — splitting on "/"
 * gives back the instance chain, which is how `sources` is built. Node ids may not contain
 * "/"; `internalParameterPath` in the components track already relies on the same rule.
 */

/** Separator between an instance id and the ids it namespaces. */
/** The instance chain a flattened id encodes, outermost first. Empty for a root node. */
export function componentPathOf(flatNodeId: NodeId): ComponentPath {
  const segments = flatNodeId.split(COMPONENT_ID_SEPARATOR);
  const path: NodeId[] = [];
  for (let index = 0; index < segments.length - 1; index += 1) {
    path.push(segments.slice(0, index + 1).join(COMPONENT_ID_SEPARATOR));
  }
  return path;
}

/** One endpoint in the flattened graph. */
export interface FlatEndpoint {
  readonly nodeId: NodeId;
  readonly portId: PortId;
}

/**
 * Where a node in the flattened graph came from (§V82).
 *
 * Recorded for every node seen at every depth — including the instance nodes that were
 * inlined away, so a diagnostic about the instance itself also has a path.
 */
export interface ComponentSource {
  /** Id in the flattened graph. */
  readonly nodeId: NodeId;
  /** Enclosing instance chain as flattened ids, outermost first. Empty at the root. */
  readonly path: ComponentPath;
  /** The node's id inside the graph it was authored in. */
  readonly internalNodeId: NodeId;
  /** `Main / DreamyFeedback_2 / Blur_1` — what a diagnostic or timing row shows. */
  readonly sourcePath: string;
}

export interface FlattenRequest {
  readonly graph: GraphDocument;
  /** Node manifests. Normally the component-aware view, so nested types resolve. */
  readonly registry: NodeRegistryView;
  readonly components: ComponentRegistryView;
}

/**
 * §T1551b: a flattening IS what a parameter read needs from one (`FlatteningReads`), so the
 * runtime hands it to readers whole — a field added there is a type error here first.
 */
export interface FlattenedGraph extends FlatteningReads {
  /** Effective component-instance nodes before inlining, for inspecting their published page. */
  readonly instanceNodes: ReadonlyMap<NodeId, GraphNode>;
  /** The parent logical graph with every instance inlined. No component types remain —
   *  except a MUTED or BYPASSED instance, kept whole so the compiler's splice can see
   *  its flags (T1032); the splice removes it before any node compiles. §T1552b: a
   *  `FlatGraph`, so a consumer that needs this cannot be handed the authored document. */
  readonly graph: FlatGraph;
  /** Flattened node id -> where it came from, sorted by id. */
  readonly sources: ReadonlyMap<NodeId, ComponentSource>;
  /**
   * Flattened instance id -> its exposed OUTPUT ports, in exposure order, mapped to the
   * internal endpoint each became. This is what redirects a sink that named the instance.
   */
  readonly instanceOutputs: ReadonlyMap<NodeId, ReadonlyMap<PortId, FlatEndpoint>>;
  /**
   * T1485b: instance LABEL -> the inner labels its exposed VALUE outputs publish under,
   * which is what lets `op('<instance>').chan.<c>` read an instance this flattening deleted.
   * Derived from `instanceOutputs`, the redirect textures already use (`instanceChannelsOf`).
   */
  readonly instanceChannels: InstanceChannelSources;
  /** Sinks the flattened-away instances implied — a previewed instance (§V28, §V25). */
  readonly sinks: ReadonlyArray<ActiveSink>;
  /** Non-null when the graph recurses; the graph is returned untouched (§V83). */
  readonly recursion: ComponentRecursionError | null;
  readonly diagnostics: ReadonlyArray<RuntimeDiagnostic>;
  /** Nonpersisted definitions for explicit component output processing boundaries. */
  readonly compilerDefinitions?: ReadonlyMap<string, NodeDefinition>;
  /** True when at least one instance was inlined. */
  readonly changed: boolean;
  /**
   * T1497b: flattened node id → key → the ROOT document parameter that value was
   * published from (§V80's fan-out, followed through every nesting level).
   *
   * Inlining dissolves an instance, so nothing called `city` is left to resolve — only
   * the internal parameters its published page was written onto. A preset morph is
   * recorded against the instance's key (that is what the bank targets and what the
   * recall wrote), and this is the map that lets it reach the parameters actually on the
   * GPU. An instance's own `overrides` win over publishing and therefore have no origin.
   *
   * T1524b: a `parent.<key>` read (§V81) has an origin too, marked `baked` — the internal
   * parameter holds the value the scope resolved to, never the publisher's slot.
   */
  readonly publishedOrigins: ReadonlyMap<NodeId, Readonly<Record<string, PublishedOrigin>>>;
  /**
   * T1497b: the preset morphs in flight in this document, indexed over THIS flattening
   * (`buildMorphIndex`). Here because the flattening is the one object every frame path
   * already holds and already shares (T615, §V529) — the compile, the value graph and the
   * frame loop's "does anything move" all read the same index, built once per
   * `(document revision, catalogue revision)` like the flat graph itself.
   */
  readonly morphs: ParameterMorphs;
}

/** T1497b: `LevelInput.origins`, grouped by internal node like the overrides they shadow. */
function originsByNode(
  origins: Readonly<Record<string, PublishedOrigin>>,
): Map<NodeId, Record<string, PublishedOrigin>> {
  const grouped = new Map<NodeId, Record<string, PublishedOrigin>>();
  for (const path of Object.keys(origins).sort()) {
    const parsed = parseInternalParameterPath(path);
    const origin = origins[path];
    if (parsed === null || origin === undefined) continue;
    const forNode = grouped.get(parsed.nodeId) ?? {};
    grouped.set(parsed.nodeId, forNode);
    forNode[parsed.key] = origin;
  }
  return grouped;
}

/**
 * T1497b: where each internal parameter of ONE instance takes its published value from,
 * keyed like `effectiveInternalOverrides` and built in the same order (a later published
 * parameter wins a shared target; the instance's own `overrides` win over both and so
 * leave no origin).
 *
 * `inherited` is this instance's own published keys' origins when it is itself inside a
 * component — a knob fed from one level up passes that origin on — and `null` at the
 * root, where the instance's stored parameters ARE the origin.
 */
function publishedOriginsFor(
  definition: GraphComponentDefinition,
  instance: GraphNode,
  rootNodeId: NodeId | null,
  inherited: Readonly<Record<string, PublishedOrigin>>,
): Record<string, PublishedOrigin> {
  const own = readComponentInstance(instance)?.overrides ?? {};
  const keyOrigins = publishedKeyOrigins(definition, rootNodeId, inherited);
  const origins: Record<string, PublishedOrigin> = {};
  for (const published of definition.parameters) {
    const origin = keyOrigins[published.key];
    if (origin === undefined) continue;
    for (const target of published.targets) {
      const path = internalParameterPath(target.nodeId, target.key);
      if (!(path in own)) origins[path] = origin;
    }
  }
  return origins;
}

/**
 * Where each PUBLISHED KEY of one instance takes its value from, in the root document:
 * itself at the root (`rootNodeId`), and whatever fed it from one level up otherwise
 * (`inherited` — a fan-out, or since T1524b a `parent.<key>` bind). Both of the ways a
 * published value reaches the inside read this one rule: §V80's fan-out
 * (`publishedOriginsFor`) and §V81's `parent.<key>` scope (`LevelInput.scopeOrigins`).
 */
function publishedKeyOrigins(
  definition: GraphComponentDefinition,
  rootNodeId: NodeId | null,
  inherited: Readonly<Record<string, PublishedOrigin>>,
): Record<string, PublishedOrigin> {
  const origins: Record<string, PublishedOrigin> = {};
  for (const published of definition.parameters) {
    const origin = rootNodeId === null ? inherited[published.key] : { nodeId: rootNodeId, key: published.key };
    if (origin !== undefined) origins[published.key] = origin;
  }
  return origins;
}

/**
 * T1524b: the origin of a `parent.<key>` read — the root parameter behind the published
 * key the reference names, marked `baked` because flattening writes the VALUE it read
 * (§V81) and never the publisher's slot. `undefined` when the reference names nothing, or
 * a key no root parameter stands behind.
 */
function parentOrigin(
  scopeOrigins: ReadonlyArray<Readonly<Record<string, PublishedOrigin>>>,
  ref: string,
): PublishedOrigin | undefined {
  const reference = parseParentReference(ref);
  if (reference === null) return undefined;
  const origin = scopeOrigins[scopeOrigins.length - reference.hops]?.[reference.key];
  return origin === undefined ? undefined : { nodeId: origin.nodeId, key: origin.key, baked: true };
}

/** Overrides addressed `<internalNodeId>/<key>`, grouped by internal node. */
function overridesByNode(
  overrides: Readonly<Record<string, StoredParameter>>,
): Map<NodeId, Record<string, StoredParameter>> {
  const grouped = new Map<NodeId, Record<string, StoredParameter>>();
  for (const path of Object.keys(overrides).sort()) {
    const parsed = parseInternalParameterPath(path);
    if (parsed === null) continue;
    const value = overrides[path];
    if (value === undefined) continue;
    const forNode = grouped.get(parsed.nodeId);
    if (forNode === undefined) grouped.set(parsed.nodeId, { [parsed.key]: value });
    else forNode[parsed.key] = value;
  }
  return grouped;
}

// `publishedPage` and `publishedSchema` — T1017's two shapes of one instance's page, and
// the page as a schema — live in `domain/components/published-page.ts` since B238, so
// `component.detach` writes a page onto real nodes by the very rule this walk uses.

interface LevelInput {
  readonly graph: GraphDocument;
  /** The component this graph belongs to, or null for the root document. */
  readonly definition: GraphComponentDefinition | null;
  readonly prefix: string;
  /** Enclosing instance chain as flattened ids, outermost first. */
  readonly path: ComponentPath;
  /**
   * Effective values for this level's internal parameters, keyed `<nodeId>/<key>` (§V80).
   *
   * A `StoredParameter`, not a value: T1017 lets an ANIMATED published knob travel as its
   * own unresolved slot, so the internal parameter it drives re-resolves per frame.
   */
  readonly overrides: Readonly<Record<string, StoredParameter>>;
  /** T1497b: for the overrides that are a published fan-out, the root parameter they came from. */
  readonly origins: Readonly<Record<string, PublishedOrigin>>;
  /** Published values of the enclosing instances, outermost first (§V81). */
  readonly chain: ReadonlyArray<Readonly<Record<string, ParameterValue>>>;
  /** T1524b: `chain`'s twin — each enclosing instance's published key → the root parameter behind it. */
  readonly scopeOrigins: ReadonlyArray<Readonly<Record<string, PublishedOrigin>>>;
  /** Authoring scopes carried alongside projected values, keyed by internal parameter path. */
  readonly parameterScopes: Readonly<Record<string, string>>;
  readonly scopeParameterScopes: ReadonlyArray<Readonly<Record<string, string>>>;
}

interface LevelResult {
  /** External input port id -> the internal endpoint it maps to, in exposure order. */
  readonly inputs: Map<PortId, FlatEndpoint>;
  readonly outputs: Map<PortId, FlatEndpoint>;
}

/**
 * Is flattening this document the IDENTITY? (T1176)
 *
 * ## Why the question is worth asking
 *
 * `flattenComponents` runs on every document revision — every knob turn, every commit —
 * and the overwhelming majority of documents contain no component instance at all. For
 * those, the whole walk below is an elaborate way of producing the graph it was given:
 * every node comes back as `{ ...node, id: node.id, parameters: { ...node.parameters } }`
 * and every edge as a field-for-field copy of itself. The costly part is not the copying
 * — it is `effectiveParameterSchema`, which REFLECTS a `customWgsl` node's schema out of
 * its WGSL source, and which the walk computes for every node whether or not anything
 * needs it. (It is read in exactly one place: the `parent.<key>` driver loop in
 * `effectiveParameters`. With no drivers, nothing reads it.)
 *
 * ## The four things that make the walk NOT the identity
 *
 * All four are checked, and any of them sends the document down the full walk:
 *
 *  1. a COMPONENT INSTANCE — the whole point of the walk;
 *  2. `state.parentBindings` on a node — at the root there is no parent scope, so
 *     `parentScopeDrivers` reports `component.parentScope.notFound` and the diagnostic
 *     is the answer. Legal to author (a node cut out of a component and pasted into the
 *     root graph has one), and silently dropping the diagnostic would leave a parameter
 *     reading a value that no longer exists with nothing said;
 *  3. a `bind`-mode slot whose ref starts `parent.` — the same case through §V107's
 *     slot, where the walk warns and falls back to §V108's retained static.
 *  4. a `parent()` read in an expression (VN36) — the same case again, through the grammar,
 *     and the same answer: `compiler/parent-reference-no-parent` and the retained static.
 *
 * §V83's recursion detector is skipped with them, and provably: it walks the document's
 * component references, and a document with no instance has none.
 *
 * The scan is a reference walk over `node.parameters`, so it costs a fraction of the one
 * reflection it saves.
 */
function flatteningIsIdentity(graph: GraphDocument): boolean {
  for (const nodeId of Object.keys(graph.nodes)) {
    const node = graph.nodes[nodeId];
    if (node === undefined) continue;
    if (isComponentInstance(node)) return false;
    if (node.state?.[PARENT_BINDINGS_STATE_KEY] !== undefined) return false;
    for (const key of Object.keys(node.parameters ?? {})) {
      const stored = node.parameters?.[key];
      if (!isParameterSlot(stored) || stored.mode !== "bind") continue;
      const binding = stored.bindings.bind;
      if (binding?.kind === "bind" && binding.ref.startsWith("parent.")) return false;
    }
    // VN36 — 4. a `parent()` read in an active expression: at the root it has no parent, and
    // the walk is what says so.
    for (const key of Object.keys(node.parameters ?? {})) {
      const stored = node.parameters?.[key];
      if (!isParameterSlot(stored) || stored.mode !== "expression") continue;
      const binding = stored.bindings.expression;
      if (binding?.kind === "expression" && parentReadsOf(binding.source).length > 0) return false;
    }
  }
  return true;
}

/**
 * The flattening of a document with nothing to flatten (T1176).
 *
 * Every field is what the full walk below produces for that document, and the two are
 * held together by `flatten-identity.test.ts`, which flattens each shipped example BOTH
 * ways — as the root document (here) and as the graph of a component instantiated once
 * (the walk) — and requires the results to agree node for node.
 *
 * Two details are load-bearing rather than incidental:
 *
 *  - the records are rebuilt in SORTED KEY ORDER, because the walk builds them that way
 *    (`Object.keys(...).sort()`), and key order is diagnostic order in the problems pane;
 *  - the node and edge OBJECTS are the document's own. The walk minted copies; nothing
 *    downstream ever wrote to one, and sharing them means a reference comparison against
 *    the raw document now answers correctly instead of always "different".
 */
function identityFlattening(graph: GraphDocument): FlattenedGraph {
  const nodes: Record<NodeId, GraphNode> = {};
  const sources = new Map<NodeId, ComponentSource>();
  for (const nodeId of Object.keys(graph.nodes).sort()) {
    const node = graph.nodes[nodeId];
    if (node === undefined) continue;
    nodes[nodeId] = node;
    sources.set(nodeId, {
      nodeId,
      path: [],
      internalNodeId: node.id,
      sourcePath: componentSourcePath([], {}, node.label ?? nodeId),
    });
  }

  const edges: Record<string, GraphEdge> = {};
  for (const edgeId of Object.keys(graph.edges).sort()) {
    const edge = graph.edges[edgeId];
    if (edge !== undefined) edges[edgeId] = edge;
  }

  return {
    graph: flat({ revision: graph.revision, nodes, edges, groups: {} }),
    sources,
    instanceOutputs: new Map(),
    instanceChannels: new Map(),
    instancePages: NO_PAGES,
    sinks: [],
    recursion: null,
    diagnostics: [],
    changed: false,
    publishedOrigins: new Map(),
    instanceNodes: new Map(),
    morphs: NO_MORPHS,
  };
}

/**
 * Flattens a graph, recursively.
 *
 * `detectComponentRecursion` runs first and the walk is abandoned when it fires, so this
 * function terminates by construction rather than by a depth counter — one detector,
 * shared with the editor, so the two can never disagree about what is legal (§V83).
 *
 * T1176: `flatteningIsIdentity` answers first, for the documents that have no component
 * in them at all — which is most of them, on every commit.
 */
/**
 * §T1552b — THE MINT. A `FlatGraph` is made here and nowhere else (the gate in
 * `frame-path-flattening.test.ts` refuses an `as FlatGraph` cast in any other module), so
 * holding one means the flattener produced it.
 */
function flat(graph: GraphDocument): FlatGraph {
  return graph as FlatGraph;
}

/**
 * §T1552b — the graph a compile reads when it was handed NO catalogue: the document as it
 * is. Not a flattening — an instance in it stays an instance and meets the manifest's
 * `component.notFlattened` tripwire — but it is the graph that compile evaluates, so it is
 * named here rather than cast at the compile. §T1559b: the node-body plot's cut-out
 * (`value-plot-chain.ts`) is named the same way: no catalogue, and no instance in it.
 */
export function compiledWithoutCatalogue(graph: GraphDocument): FlatGraph {
  return flat(graph);
}

export function flattenComponents(request: FlattenRequest): FlattenedGraph {
  // T1176: the overwhelming majority of documents have nothing to flatten. See
  // `flatteningIsIdentity`.
  if (flatteningIsIdentity(request.graph)) {
    const identity = identityFlattening(request.graph);
    const indexed: MorphIndexInput = { document: request.graph, registry: request.registry, components: request.components, flattened: identity };
    // T1497b: nothing was inlined, so the document's own nodes are what resolves.
    // §T1559b (2): and what its cue lists that follow the timeline cannot do as written.
    return { ...identity, diagnostics: timelineCueProblems(indexed), morphs: buildMorphIndex(indexed) };
  }

  const diagnostics: RuntimeDiagnostic[] = [];

  const recursion = detectComponentRecursion({
    componentId: null,
    graph: request.graph,
    source: request.components,
  });
  if (recursion !== null) {
    diagnostics.push(
      compilerDiagnostic("error", CompilerDiagnosticCode.componentRecursion, describeRecursion(recursion), {
        suggestion:
          "A component may not contain itself, directly or through another component (§V83). Break the loop before compiling.",
      }),
    );
    return {
      // §V83: untouched, and nothing compiles it — the compile stops on `recursion`.
      graph: flat(request.graph),
      sources: new Map(),
      instanceOutputs: new Map(),
      instanceChannels: new Map(),
      instancePages: NO_PAGES,
      sinks: [],
      recursion,
      diagnostics,
      changed: false,
      publishedOrigins: new Map(),
      instanceNodes: new Map(),
      morphs: NO_MORPHS,
    };
  }

  const nodes: Record<NodeId, GraphNode> = {};
  const instanceNodes = new Map<NodeId, GraphNode>();
  /** VN36: each instance's published page as a schema, for `instancePages`. */
  const pageSchemas = new Map<NodeId, ParameterSchema>();
  const edges: Record<string, GraphEdge> = {};
  const sources = new Map<NodeId, ComponentSource>();
  const instanceOutputs = new Map<NodeId, ReadonlyMap<PortId, FlatEndpoint>>();
  const compilerDefinitions = new Map<string, NodeDefinition>();
  const channelBoundaries: Array<{ id: string; type: string; outputType: PortType; mask: ChannelMask;
    inputs: Array<{ endpoint: FlatEndpoint; type: PortType }> }> = [];
  const publishedOrigins = new Map<NodeId, Readonly<Record<string, PublishedOrigin>>>();
  /**
   * T1524b: each ROOT instance's published page as a schema, for the morph index — which
   * resolves a fade's ends on the instance and so must not depend on `request.registry`
   * being the component-aware view (the offline harness hands a plain one).
   */
  const instanceSchemas = new Map<NodeId, ParameterSchema>();
  const sinks: ActiveSink[] = [];
  /** Flattened instance id -> display name, the pieces a source path is made of. */
  const instanceNames: Record<NodeId, string> = {};
  let changed = false;

  const report = (diagnostic: RuntimeDiagnostic, nodeId: NodeId): void => {
    diagnostics.push({ ...diagnostic, nodeId });
  };

  /**
   * Every label the flat graph has claimed so far, across ALL levels (B41).
   *
   * Labels are copied into the flat graph verbatim, and name references — op(), driven
   * channels, source references, §V128's clause list — resolve on the flat graph
   * GLOBALLY (first-wins in `nodeNames`). Two instances of one component therefore
   * carried identical internal labels, and every reference in the second instance
   * silently bound the FIRST instance's node. Each level's labels are made globally
   * unique on entry, and the clause-complete rename rewrite keeps that level's own
   * references pointing at its own nodes. The root level runs first against an empty
   * set, so a name the user can see is never the one renamed.
   */
  const usedNames = new Set<string>();

  const withUniqueNames = (level: GraphDocument): GraphDocument => {
    const levelLabels = new Set<string>();
    for (const node of Object.values(level.nodes)) {
      if (node.label !== undefined) levelLabels.add(node.label);
    }

    const renames: Array<{ nodeId: NodeId; oldName: string; newName: string }> = [];
    for (const nodeId of Object.keys(level.nodes).sort()) {
      const label = level.nodes[nodeId]?.label;
      if (label === undefined || !usedNames.has(label)) continue;
      const candidate = renumberedName(label, (name) => usedNames.has(name) || levelLabels.has(name));
      // Reserving the new name here keeps two renames at one level from colliding, and
      // keeps a new name from shadowing a sibling's still-pending old one.
      levelLabels.add(candidate);
      renames.push({ nodeId, oldName: label, newName: candidate });
    }

    let graph = level;
    if (renames.length > 0) {
      // The level graph is the component DEFINITION's — shared by every instance — so
      // the rename works on a copy, never the definition.
      graph = structuredClone(level) as GraphDocument;
      for (const rename of renames) {
        rewriteNodeNameReferences(graph, rename.oldName, rename.newName, { paths: false });
        const node = graph.nodes[rename.nodeId];
        if (node !== undefined) graph.nodes[rename.nodeId] = { ...node, label: rename.newName };
      }
    }
    for (const label of levelLabels) usedNames.add(label);
    return graph;
  };

  /*
   * VN35: every graph of the flattening as names see it, keyed by its prefix (the root is
   * `""`), with the names AS WRITTEN — read off the level's own graph, before
   * `withUniqueNames` renumbers them. `path-references.ts` resolves paths against these.
   */
  const scopes = new Map<string, NameScope & { readonly names: Map<string, { node: NodeId } | { scope: string }> }>();
  const scopeOf = new Map<NodeId, string>();
  const authoredOf = new Map<NodeId, string>();
  const parameterScopes = new Map<NodeId, Readonly<Record<string, string>>>();
  const nameNode = (prefix: string, authored: string | undefined, flatId: NodeId): void => {
    scopeOf.set(flatId, prefix);
    if (authored === undefined) return;
    authoredOf.set(flatId, authored);
    const names = scopes.get(prefix)?.names;
    if (names !== undefined && !names.has(authored)) names.set(authored, { node: flatId });
  };

  const recordSource = (flatId: NodeId, path: ComponentPath, node: GraphNode, leaf: string): void => {
    sources.set(flatId, {
      nodeId: flatId,
      path,
      internalNodeId: node.id,
      sourcePath: componentSourcePath(path, instanceNames, leaf),
    });
  };

  /**
   * Effective parameter values for one node: stored values, then the published fan-out and
   * the instance's own overrides (§V80), then any `parent.<key>` binding (§V81).
   *
   * Both mechanisms are read through the components track's own functions rather than off
   * `GraphNode.parameters`, and the result is handed to the compiler's parameter resolver
   * below — so there is still exactly one place a value is validated against a schema.
   */
  const effectiveParameters = (
    node: GraphNode,
    schema: ParameterSchema | undefined,
    forNode: Readonly<Record<string, StoredParameter>>,
    scope: ParentScope | undefined,
    flatId: NodeId,
    scopeOrigins: ReadonlyArray<Readonly<Record<string, PublishedOrigin>>>,
    /** T1524b: filled with the root parameter behind each `parent.<key>` value written below. */
    bound: Record<string, PublishedOrigin>,
    keyScopes: Record<string, string>,
    scopeParameterScopes: ReadonlyArray<Readonly<Record<string, string>>>,
  ): Record<string, StoredParameter> => {
    const parameters: Record<string, StoredParameter> = { ...node.parameters };
    for (const key of Object.keys(forNode).sort()) {
      const value = forNode[key];
      if (value !== undefined) parameters[key] = value;
    }

    // Slot-mode `parent.*` binds (§V107, T203) are baked here, where the scope exists —
    // the flat graph is a compile artifact resolved without one. A bind that cannot
    // resolve is reported and falls back to the slot's retained static value (§V108) by
    // simply leaving the slot in place minus its scope, i.e. deleting nothing.
    const resolveRef = parentBindResolver(scope);
    for (const key of Object.keys(parameters).sort()) {
      const stored = parameters[key];
      if (stored === undefined || !isParameterSlot(stored)) continue;
      if (stored.mode !== "bind") continue;
      const binding = stored.bindings.bind;
      if (binding?.kind !== "bind" || !binding.ref.startsWith("parent.")) continue;
      const lookup = resolveRef(binding.ref);
      if (!lookup.ok) {
        report(
          compilerDiagnostic(
            "warning",
            CompilerDiagnosticCode.componentParameterConflict,
            `"${key}" is bound to "${binding.ref}": ${lookup.message}`,
            { suggestion: "Fix the ref, or switch the parameter back to its static value (§V108)." },
          ),
          flatId,
        );
        const retained = storedStaticValue(stored);
        if (retained === undefined) delete parameters[key];
        else parameters[key] = retained;
        continue;
      }
      parameters[key] = lookup.value;
      const reference = parseParentReference(binding.ref)!;
      const authoredScope = scopeParameterScopes[scopeParameterScopes.length - reference.hops]?.[reference.key];
      if (authoredScope !== undefined) keyScopes[key] = authoredScope;
      const origin = parentOrigin(scopeOrigins, binding.ref);
      if (origin !== undefined) bound[key] = origin;
    }

    const drivers = parentScopeDrivers(node, scope, {
      onDiagnostic: (diagnostic) => report(diagnostic, flatId),
    });
    for (const key of Object.keys(drivers).sort()) {
      if (key in forNode) {
        // Both mechanisms claim the same parameter. The instance-level value wins because
        // it is the outer, per-instance statement — but silently shadowing one authored
        // mechanism with another is exactly the bug §V54 names, so it is reported.
        report(
          compilerDiagnostic(
            "warning",
            CompilerDiagnosticCode.componentParameterConflict,
            `"${key}" is both driven by a published parameter and bound to a parent value; the published value wins.`,
            { suggestion: "Unpublish the parameter, or remove the parent binding (§V80, §V81)." },
          ),
          flatId,
        );
        continue;
      }
      const parameterDefinition = schema?.[key];
      if (parameterDefinition === undefined) {
        report(
          compilerDiagnostic(
            "warning",
            CompilerDiagnosticCode.componentParameterConflict,
            `"${key}" is bound to a parent value but "${node.type}" declares no such parameter.`,
            { suggestion: "Remove the binding, or bind a parameter the node actually has." },
          ),
          flatId,
        );
        continue;
      }
      const driven = drivers[key]?.({ node, key, definition: parameterDefinition });
      if (driven === undefined) continue;
      parameters[key] = driven;
      const reference = parseParentReference(readParentBindings(node)[key] ?? "");
      const authoredScope = reference === null ? undefined : scopeParameterScopes[scopeParameterScopes.length - reference.hops]?.[reference.key];
      if (authoredScope !== undefined) keyScopes[key] = authoredScope;
      const origin = parentOrigin(scopeOrigins, readParentBindings(node)[key] ?? "");
      if (origin !== undefined) bound[key] = origin;
    }
    return parameters;
  };

  const addNode = (node: GraphNode, flatId: NodeId): void => {
    if (nodes[flatId] !== undefined) {
      report(
        compilerDiagnostic(
          "error",
          CompilerDiagnosticCode.componentIdCollision,
          `Flattening produced two nodes called "${flatId}"; the second is dropped.`,
          { suggestion: 'Node ids may not contain "/", which separates an instance from its internals.' },
        ),
        flatId,
      );
      return;
    }
    nodes[flatId] = node;
  };

  const flattenLevel = (input: LevelInput): LevelResult => {
    const levelGraph = withUniqueNames(input.graph);
    if (!scopes.has(input.prefix)) scopes.set(input.prefix, { parent: undefined, label: undefined, names: new Map() });
    const scope = buildParentScope(input.chain);
    /** VN36: the instances around this level, outermost first, as a `parent()` read sees them. */
    const parents: EnclosingInstance[] = input.path.map((instanceId) => ({
      label: instanceNodes.get(instanceId)?.label,
      schema: pageSchemas.get(instanceId),
    }));
    const grouped = overridesByNode(input.overrides);
    const origins = originsByNode(input.origins);
    /** Raw instance id -> the boundary of the subgraph it expanded into. */
    const childInputs = new Map<NodeId, ReadonlyMap<PortId, FlatEndpoint>>();
    const childOutputs = new Map<NodeId, ReadonlyMap<PortId, FlatEndpoint>>();
    const maskedInstances: Array<{ node: GraphNode; definition: GraphComponentDefinition; flatId: string }> = [];

    const names = instanceDisplayNames(
      levelGraph,
      (componentId, version) => request.components.get(componentId, version)?.name ?? componentId,
    );

    for (const nodeId of Object.keys(levelGraph.nodes).sort()) {
      const node = levelGraph.nodes[nodeId];
      if (node === undefined) continue;
      const flatId = flattenedNodeId(input.prefix, nodeId);
      const authored = input.graph.nodes[nodeId]?.label;
      const instance = readComponentInstance(node);
      const componentDefinition =
        instance === null ? undefined : request.components.get(instance.componentId, instance.version);

      const schema =
        componentDefinition === undefined
          ? // T903: a reflecting node INSIDE a component keeps its reflected controls through
            // the flattener — the static schema would drop every key its shader declares, so a
            // published knob would resolve to nothing exactly where §T880 aims it.
            effectiveParameterSchema(request.registry.get(node.type), node.parameters)
          : publishedSchema(componentDefinition);
      // T1524b: the root parameters this node's values came from — the published fan-out
      // (§V80) and, beside it, every `parent.<key>` read `effectiveParameters` resolves.
      const publishedFrom: Record<string, PublishedOrigin> = { ...origins.get(nodeId) };
      const overrides = grouped.get(nodeId) ?? {};
      const keyScopes: Record<string, string> = {};
      for (const key of new Set([...Object.keys(node.parameters), ...Object.keys(overrides)])) {
        keyScopes[key] = key in overrides ? input.parameterScopes[internalParameterPath(nodeId, key)] ?? input.prefix : input.prefix;
      }
      const parameters = resolveParentReferences(
        effectiveParameters(node, schema, overrides, scope, flatId, input.scopeOrigins, publishedFrom, keyScopes, input.scopeParameterScopes),
        parents,
        diagnostic => report(diagnostic, flatId),
      );
      for (const key of Object.keys(parameters)) if (keyScopes[key] === undefined) keyScopes[key] = input.prefix;
      parameterScopes.set(flatId, keyScopes);
      const resolved: GraphNode = { ...node, id: flatId, parameters };
      scopeOf.set(flatId, input.prefix);
      if (authored !== undefined) authoredOf.set(flatId, authored);

      if (instance !== null) {
        instanceNodes.set(flatId, resolved);
        if (componentDefinition !== undefined) pageSchemas.set(flatId, schema ?? {});
        if (Object.keys(publishedFrom).length > 0) publishedOrigins.set(flatId, publishedFrom);
      }

      if (instance === null) {
        addNode(resolved, flatId);
        nameNode(input.prefix, authored, flatId);
        recordSource(flatId, input.path, node, node.label ?? nodeId);
        // T1497b: the published values this node carries, and where each came from.
        if (Object.keys(publishedFrom).length > 0) publishedOrigins.set(flatId, publishedFrom);
        continue;
      }

      if (componentDefinition === undefined) {
        // §V10: an uninstalled component is a placeholder, not a reason to lose the rest of
        // the project. The node is kept so the unknown-type diagnostic names it.
        report(
          compilerDiagnostic(
            "error",
            CompilerDiagnosticCode.componentMissing,
            `Component "${instance.componentId}" version ${instance.version} is not installed, so "${flatId}" cannot be flattened.`,
            { suggestion: "Install the component package, or upgrade the instance to a version you have (§V84)." },
          ),
          flatId,
        );
        addNode(resolved, flatId);
        nameNode(input.prefix, authored, flatId);
        recordSource(flatId, input.path, node, node.label ?? nodeId);
        continue;
      }

      if (node.ui?.muted === true || node.ui?.bypassed === true) {
        /*
         * T1032 — MUTE AND BYPASS ON AN INSTANCE MUST SURVIVE FLATTENING. Inlining
         * dissolves the instance node, and its ui flags dissolved with it — so muting
         * a component changed nothing (owner-reported: "if I bypass and mute that
         * whole component, that somehow doesn't change the output"). A muted or
         * bypassed instance is therefore NOT inlined: the node stays, carrying its
         * flags, and the compiler's ONE mute/bypass splice treats it exactly as any
         * other node (§V109 — a second component-shaped copy of that rule here would
         * drift). A muted instance's whole interior then costs nothing (the splice
         * removes the node before compile, so the synthesized manifest's
         * "notFlattened" error can never fire); a bypassed one passes its input
         * through when the boundary types are coherent, by the same
         * bypassPassthroughPorts rule every node answers to — and an incoherent
         * bypass mutes, exactly as it does on a plain node.
         */
        addNode(resolved, flatId);
        nameNode(input.prefix, authored, flatId);
        recordSource(flatId, input.path, node, node.label ?? nodeId);
        continue;
      }

      if (input.definition === null) instanceSchemas.set(node.id, publishedSchema(componentDefinition));
      const label = node.label ?? names[nodeId] ?? componentDefinition.name;
      instanceNames[flatId] = label;
      if (!isDefaultChannelMask(node.channelMask)) maskedInstances.push({ node, definition: componentDefinition, flatId });
      recordSource(flatId, input.path, node, label);

      // The instance's published page, validated against its re-authored definitions.
      // STORED space (T307, §V56): flattening writes these back onto internal parameters
      // and feeds them to `parent.<key>` drivers, and both of those re-resolve. Handing
      // over the evaluation values would decode a display colour twice — a picked
      // mid-grey reaching the shader at 0.0376 instead of 0.2140 (B8, T187).
      //
      // T1017: and an ANIMATED knob does not hand over a number at all — it hands over
      // its slot, so the internal parameter animates per frame while this walk stays a
      // pure function of the document (§V529's memo). `publishedPage` is the one place
      // both shapes are decided; see its docblock for why they are not two call sites.
      //
      // T1553b: the page, its fan-out and the instance's internal masks and resolution
      // overrides are ONE projection, shared with `component.detach` (`applyInstance`).
      const publishedDiagnostics: RuntimeDiagnostic[] = [];
      const applied = applyInstance({
        definition: componentDefinition,
        instance: resolved,
        // §T1557b: the document, not a moment — this walk is a pure function of it (§V529).
        // §T1641b slice 2: the page is the published parameters, and the instance's manifest
        // declares more beside it (a look's own preset state). The same list the manifest is
        // built from, so the compile cannot call a key the write gate accepts undeclared.
        readPage: (instanceNode, pageSchema) =>
          resolveNodeParameters(instanceNode, pageSchema, node.type, publishedDiagnostics, STORED_READ, {
            retained: Object.keys(instanceOwnParameters(componentDefinition)),
          }),
      });
      const page = applied.page;
      for (const diagnostic of publishedDiagnostics) {
        if (!page.deferred.has(diagnostic)) diagnostics.push(diagnostic);
      }
      const published = page.values;

      for (const path of applied.missing.channelMasks) diagnostics.push({ severity: "error", code: "component.channelMaskTargetMissing", nodeId: flatId,
        message: `Component channel mask override names missing internal node "${path}".` });
      // VN35: the instance is a graph of names; its own name, as written, is how a path enters it.
      scopes.set(flatId, { parent: input.prefix, label: authored, names: new Map() });
      const enclosing = scopes.get(input.prefix)?.names;
      if (authored !== undefined && enclosing !== undefined && !enclosing.has(authored)) enclosing.set(authored, { scope: flatId });
      const projectedScopes: Record<string, string> = {};
      const pageScopes: Record<string, string> = {};
      for (const publishedParameter of componentDefinition.parameters) {
        const authoredScope = keyScopes[publishedParameter.key] ?? input.prefix;
        pageScopes[publishedParameter.key] = authoredScope;
        for (const target of publishedParameter.targets) {
          projectedScopes[internalParameterPath(target.nodeId, target.key)] = authoredScope;
          for (const key of Object.keys(parameters)) {
            const component = parseComponentKey(key);
            if (component?.base === publishedParameter.key) {
              pageScopes[key] = keyScopes[key] ?? input.prefix;
              projectedScopes[internalParameterPath(target.nodeId, componentKey(target.key, component.component))] = pageScopes[key]!;
            }
          }
        }
      }
      // An internal override is authored on its target node, so it retains that node's scope.
      for (const path of Object.keys(readComponentInstance(resolved)?.overrides ?? {})) delete projectedScopes[path];
      const child = flattenLevel({
        graph: applied.graph,
        definition: componentDefinition,
        prefix: flatId,
        path: [...input.path, flatId],
        overrides: applied.overrides,
        origins: publishedOriginsFor(
          componentDefinition,
          resolved,
          input.definition === null ? node.id : null,
          publishedFrom,
        ),
        chain: [...input.chain, published],
        parameterScopes: projectedScopes,
        scopeParameterScopes: [...input.scopeParameterScopes, pageScopes],
        scopeOrigins: [
          ...input.scopeOrigins,
          publishedKeyOrigins(componentDefinition, input.definition === null ? node.id : null, publishedFrom),
        ],
      });
      // Said after the child level, where they were always said. The overrides themselves
      // landed on `applied.graph` before it: a nested path merged into the nested instance's
      // own, outer winning, so one nested descendant is overridden without editing the
      // shared definition or its sibling instance.
      for (const relativeId of applied.missing.resolutions) {
        diagnostics.push({ severity: "error", code: "component.resolutionTargetMissing", nodeId: flatId,
          message: `Component resolution override names missing internal node "${relativeId}".` });
      }
      childInputs.set(nodeId, child.inputs);
      childOutputs.set(nodeId, child.outputs);
      instanceOutputs.set(flatId, child.outputs);
      changed = true;

      // The instance node itself is gone, so a preview PINNED on it has to become a
      // preview of what it produced — otherwise §V25 prunes the whole component away.
      // The pin, not the switch (T353, §V297): the switch is default-on and would make
      // every instance an unconditional sink.
      //
      // T609: the first PREVIEWABLE exposed output, not the first output. Post-T607 the
      // sockets derive from boundary nodes in graph order, so an `event` or `camera`
      // socket can land first by accident of layout — and a sink naming a port with no
      // picture materializes nothing. The kind lives on the INNER node's own declared
      // port (the endpoint's node is already in the flat `nodes` map), judged by the one
      // shared previewability list (§V437). No previewable output, no sink: a pin on a
      // component with nothing drawable previews nothing, exactly like the node itself
      // would.
      if (node.ui?.previewPinned === true) {
        const drawable = [...child.outputs.values()].find((endpoint) => {
          const inner = nodes[endpoint.nodeId];
          const declared =
            inner === undefined
              ? undefined
              : request.registry.get(inner.type)?.outputs.find((port) => port.id === endpoint.portId);
          return declared !== undefined && isPreviewablePortKind(declared.type.kind);
        });
        if (drawable !== undefined) sinks.push({ nodeId: drawable.nodeId, portId: drawable.portId, kind: "preview" });
      }
    }

    const endpointOf = (
      nodeId: NodeId,
      portId: PortId,
      direction: "input" | "output",
    ): FlatEndpoint | undefined => {
      const boundary = direction === "input" ? childInputs.get(nodeId) : childOutputs.get(nodeId);
      if (boundary === undefined) return { nodeId: flattenedNodeId(input.prefix, nodeId), portId };
      return boundary.get(portId);
    };

    const definitionOf = (nodeId: string): NodeDefinition | undefined => {
      const type = nodes[nodeId]?.type;
      return type === undefined ? undefined : compilerDefinitions.get(type) ?? request.registry.get(type);
    };
    for (const instance of maskedInstances) {
      const preservedInputs: Array<{ endpoint: FlatEndpoint; type: PortType }> = [];
      for (const exposed of instance.definition.inputs) {
        const endpoint = childInputs.get(instance.node.id)?.get(exposed.externalId);
        const port = endpoint === undefined ? undefined : definitionOf(endpoint.nodeId)?.inputs.find(entry => entry.id === endpoint.portId);
        if (endpoint !== undefined && port?.type.kind === "texture2d" && port.type.sample !== "depth") {
          preservedInputs.push({ endpoint, type: port.type });
        }
      }
      const outputs = new Map(childOutputs.get(instance.node.id));
      let textures = 0;
      for (const [portId, processed] of outputs) {
        const port = definitionOf(processed.nodeId)?.outputs.find(entry => entry.id === processed.portId);
        if (port?.type.kind !== "texture2d" || port.type.sample === "depth") continue;
        const id = `${instance.flatId}/$channels:${portId}`;
        const type = `compiler:channel-mask:${id}`;
        compilerDefinitions.set(type, channelMaskBoundaryDefinition(type, port.type, instance.node.channelMask!));
        addNode({ id, type, definitionVersion: 1, parameters: {}, position: instance.node.position }, id);
        recordSource(id, input.path, instance.node, `${instance.node.label ?? instance.definition.name} channels ${portId}`);
        edges[`${id}:processed`] = { id: `${id}:processed`, source: processed, target: { nodeId: id, portId: "processed" } };
        channelBoundaries.push({ id, type, outputType: port.type, mask: instance.node.channelMask!, inputs: preservedInputs });
        const endpoint = { nodeId: id, portId: "out" };
        outputs.set(portId, endpoint);
        for (let i = 0; i < sinks.length; i += 1) {
          const sink = sinks[i]!;
          if (sink.nodeId === processed.nodeId && sink.portId === processed.portId) sinks[i] = { ...sink, ...endpoint };
        }
        textures += 1;
      }
      if (textures === 0) diagnostics.push({ severity: "error", code: "node.channelMask.unsupported", nodeId: instance.flatId,
        message: "Component channel processing requires an exposed texture output." });
      childOutputs.set(instance.node.id, outputs);
      instanceOutputs.set(instance.flatId, outputs);
    }
    for (const edgeId of Object.keys(levelGraph.edges).sort()) {
      const edge = levelGraph.edges[edgeId];
      if (edge === undefined) continue;
      const source = endpointOf(edge.source.nodeId, edge.source.portId, "output");
      const target = endpointOf(edge.target.nodeId, edge.target.portId, "input");
      if (source === undefined || target === undefined) {
        const unresolved = source === undefined ? edge.source : edge.target;
        diagnostics.push(
          compilerDiagnostic(
            "error",
            CompilerDiagnosticCode.componentPortUnresolved,
            `Edge "${flattenedNodeId(input.prefix, edgeId)}" reaches "${unresolved.portId}" on component instance "${flattenedNodeId(input.prefix, unresolved.nodeId)}", which the component does not expose.`,
            {
              nodeId: flattenedNodeId(input.prefix, unresolved.nodeId),
              portId: unresolved.portId,
              suggestion: "Expose the internal port on the component, or disconnect the edge (§V79).",
            },
          ),
        );
        continue;
      }
      const flatEdgeId = flattenedNodeId(input.prefix, edgeId);
      /*
       * B155 — `order` MUST survive flattening (§V131). This copy dropped it, and the
       * failure was invisible from either side alone: the compiler's own sort is
       * correct (declared order first, id as tiebreak), and the harness compiles a
       * component-free document WITHOUT flattening — so every gate saw the declared
       * order. The APP always flattens (it passes `components`), so in the running app
       * every variadic port fell back to the id tiebreak. E43/E41: `e-clip-pick`
       * sorts before `e-stand-pick`, the Switch's inputs arrived inverted, index 0
       * presented the fileless movie clip, and the whole rack behind it went black.
       */
      edges[flatEdgeId] = {
        id: flatEdgeId,
        ...(edge.order === undefined ? {} : { order: edge.order }),
        source: { ...source },
        target: { ...target },
      };
    }

    const inputs = new Map<PortId, FlatEndpoint>();
    const outputs = new Map<PortId, FlatEndpoint>();
    for (const [exposedPorts, into, direction] of [
      [input.definition?.inputs ?? [], inputs, "input"],
      [input.definition?.outputs ?? [], outputs, "output"],
    ] as const) {
      for (const exposed of exposedPorts) {
        const endpoint = endpointOf(exposed.nodeId, exposed.portId, direction);
        if (endpoint === undefined) {
          diagnostics.push(
            compilerDiagnostic(
              "error",
              CompilerDiagnosticCode.componentPortUnresolved,
              `Component "${input.definition?.name ?? ""}" exposes "${exposed.externalId}", which maps to "${exposed.nodeId}.${exposed.portId}" — a port that does not resolve.`,
              { suggestion: "Re-expose the port; the internal node or port it named has moved (§V79)." },
            ),
          );
          continue;
        }
        into.set(exposed.externalId, endpoint);
      }
    }

    return { inputs, outputs };
  };

  flattenLevel({
    graph: request.graph,
    definition: null,
    prefix: "",
    path: [],
    overrides: {},
    origins: {},
    chain: [],
    scopeOrigins: [],
    parameterScopes: {},
    scopeParameterScopes: [],
  });

  // Parent-level wires are known only after every level has expanded. Resolve the first
  // connected exposed texture input now, so nested components preserve their external input.
  const authoredEdges = Object.values(edges).sort(compareEdgeOrder);
  for (const boundary of channelBoundaries) {
    let preserved: { source: FlatEndpoint; type: PortType } | undefined;
    for (const candidate of boundary.inputs) {
      const edge = authoredEdges.find(entry => entry.target.nodeId === candidate.endpoint.nodeId && entry.target.portId === candidate.endpoint.portId);
      if (edge !== undefined) { preserved = { source: edge.source, type: candidate.type }; break; }
    }
    compilerDefinitions.set(boundary.type, channelMaskBoundaryDefinition(boundary.type, boundary.outputType, boundary.mask, preserved?.type));
    if (preserved !== undefined) edges[`${boundary.id}:preserved`] = { id: `${boundary.id}:preserved`, source: preserved.source,
      target: { nodeId: boundary.id, portId: "preserved" } };
  }

  // VN35: paths name nodes the walk above has now placed; resolve them before anything reads a name.
  // Dissolved pages carry expressions too; apply the same path rule before any reader uses them.
  const referenceNodes = { ...nodes, ...Object.fromEntries(instanceNodes) };
  diagnostics.push(...resolvePathReferences({ nodes: referenceNodes, edges, scopes, scopeOf, authoredOf, parameterScopes }));
  for (const id of Object.keys(nodes)) nodes[id] = referenceNodes[id]!;
  for (const id of instanceNodes.keys()) instanceNodes.set(id, referenceNodes[id]!);

  const graph = flat({
    revision: request.graph.revision,
    nodes,
    edges,
    // Groups are a canvas affordance, not a logical one: a flattened graph has no canvas.
    groups: {},
  });
  // T1497b: against the ROOT document (the banks and the nodes they name live there)
  // and this flattening (what actually resolves).
  // T1541b: with the catalogue, so a timed cue can name a look's instance.
  const indexed: MorphIndexInput = { document: request.graph, registry: request.registry, components: request.components, flattened: { graph, publishedOrigins, instanceSchemas } };
  /*
   * §T1559b (2): what the cue lists that follow the timeline cannot do as written, said
   * HERE for the reason the morph index is built here: once per `(document revision,
   * catalogue revision)`, however many frames and timeline segments compile over this
   * flattening. The compile appends a flattening's diagnostics as they are.
   */
  diagnostics.push(...timelineCueProblems(indexed));
  return {
    graph,
    sources,
    instanceOutputs,
    instanceChannels: instanceChannelsOf(instanceNodes, instanceOutputs, nodes, edges, request.registry),
    instancePages: instancePagesOf(instanceNodes, pageSchemas),
    sinks,
    recursion: null,
    diagnostics,
    ...(compilerDefinitions.size === 0 ? {} : { compilerDefinitions }),
    changed,
    instanceNodes,
    publishedOrigins,
    morphs: buildMorphIndex(indexed),
  };
}

/**
 * T1485b — each labelled instance's exposed VALUE outputs, as the inner labels that publish
 * them (see `InstanceChannelSource`).
 *
 * The kind is the INNER node's own declared port, judged as `instance-value-channels.ts`
 * judges it for the plot. Two ports onto one inner node are one publisher (one bag); the
 * first port to reach it names it. An unlabelled publisher has no address the value graph
 * publishes under, so it is not listed. Duplicate instance labels (legacy documents) keep
 * the first, as `nodeNames` does.
 */
function instanceChannelsOf(
  instanceNodes: ReadonlyMap<NodeId, GraphNode>,
  instanceOutputs: ReadonlyMap<NodeId, ReadonlyMap<PortId, FlatEndpoint>>,
  nodes: Readonly<Record<NodeId, GraphNode>>,
  edges: Readonly<Record<string, GraphEdge>>,
  registry: NodeRegistryView,
): InstanceChannelSources {
  const byLabel = new Map<string, readonly InstanceChannelSource[]>();
  for (const instanceId of [...instanceOutputs.keys()].sort()) {
    const label = instanceNodes.get(instanceId)?.label;
    if (label === undefined || byLabel.has(label)) continue;
    const sources: InstanceChannelSource[] = [];
    const seen = new Set<NodeId>();
    for (const [port, endpoint] of instanceOutputs.get(instanceId) ?? []) {
      if (seen.has(endpoint.nodeId)) continue;
      const inner = nodes[endpoint.nodeId];
      if (inner?.label === undefined) continue;
      const declared = registry.get(inner.type)?.outputs.find((output) => output.id === endpoint.portId);
      if (declared?.type.kind !== "value") continue;
      seen.add(endpoint.nodeId);
      sources.push({ port, publisher: inner.label });
    }
    byLabel.set(label, sources);
  }
  /*
   * T1779b (§V1035) — A BYPASSED INSTANCE IS WIRES BY NAME TOO. It is not inlined (§T1032), so
   * it has no `instanceOutputs`; its value outputs pass the value inputs the rule pairs them
   * with (`bypassPassthroughPairs`), so `op('<instance>').chan.<c>` reads what is wired INTO
   * those inputs: the publisher behind each, followed back through further bypassed nodes.
   * An output with no partner, and an input nothing is wired to, name no publisher. A MUTED
   * instance gets no entry: it publishes nothing by any route.
   */
  const edgeIds = Object.keys(edges).sort();
  const publishersBehind = (nodeId: NodeId, portId: PortId, seen: ReadonlySet<string>): string[] => {
    const node = nodes[nodeId];
    const key = `${nodeId}\u0000${portId}`;
    if (node === undefined || seen.has(key)) return [];
    const definition = registry.get(node.type);
    if (definition?.outputs.find((output) => output.id === portId)?.type.kind !== "value") return [];
    if (node.ui?.muted === true) return [];
    // Any node but an instance publishes under its own label (its own bypass is the value graph's, per frame).
    if (!isComponentNodeType(node.type)) return node.label === undefined ? [] : [node.label];
    // An instance still in the flat graph was not inlined; only a bypassed one passes anything.
    if (node.ui?.bypassed !== true) return [];
    const input = bypassPassthroughPairs(definition).get(portId);
    if (input === undefined) return [];
    const next = new Set(seen).add(key);
    return edgeIds.flatMap((id) => {
      const edge = edges[id];
      return edge !== undefined && edge.target.nodeId === nodeId && edge.target.portId === input ? publishersBehind(edge.source.nodeId, edge.source.portId, next) : [];
    });
  };
  for (const nodeId of Object.keys(nodes).sort()) {
    const node = nodes[nodeId];
    if (node?.label === undefined || byLabel.has(node.label)) continue;
    if (!isComponentNodeType(node.type) || node.ui?.bypassed !== true || node.ui.muted === true) continue;
    const sources: InstanceChannelSource[] = [];
    const seen = new Set<string>();
    for (const output of registry.get(node.type)?.outputs ?? []) {
      for (const publisher of publishersBehind(nodeId, output.id, new Set())) {
        if (seen.has(publisher)) continue;
        seen.add(publisher);
        sources.push({ port: output.id, publisher });
      }
    }
    byLabel.set(node.label, sources);
  }
  return byLabel;
}

/**
 * VN36: instance LABEL → its page, for `op('<instance>').par.<key>` and so `parent()`.
 * First-wins in flat-id order, like `nodeNames` and `instanceChannelsOf`; B41 has already
 * made instance labels unique across the flattening, so first-wins decides nothing in a
 * flattening this walk produced. An unlabelled instance has no name to read it by.
 */
function instancePagesOf(
  instanceNodes: ReadonlyMap<NodeId, GraphNode>,
  pageSchemas: ReadonlyMap<NodeId, ParameterSchema>,
): InstancePages {
  const byLabel = new Map<string, InstancePage>();
  for (const instanceId of [...instanceNodes.keys()].sort()) {
    const node = instanceNodes.get(instanceId);
    const schema = pageSchemas.get(instanceId);
    if (node?.label === undefined || schema === undefined || byLabel.has(node.label)) continue;
    const parameters = Object.fromEntries(Object.entries(node.parameters).filter(([key]) => Object.hasOwn(schema, key) || isComponentKeyOf(schema, key)));
    byLabel.set(node.label, { node: { ...node, parameters }, schema });
  }
  return byLabel;
}

/**
 * Rewrites a sink that named a component instance to name what the instance became.
 *
 * Without this a pinned preview on an instance would name a node that no longer exists,
 * and the whole component would be pruned as unreachable (§V25, §V28).
 */
export function redirectSink(
  sink: ActiveSink,
  instanceOutputs: ReadonlyMap<NodeId, ReadonlyMap<PortId, FlatEndpoint>>,
): ActiveSink {
  const outputs = instanceOutputs.get(sink.nodeId);
  if (outputs === undefined) return sink;
  const portId = sink.portId ?? [...outputs.keys()][0];
  const endpoint = portId === undefined ? undefined : outputs.get(portId);
  if (endpoint === undefined) return sink;
  return { nodeId: endpoint.nodeId, portId: endpoint.portId, kind: sink.kind };
}

/**
 * Stamps a diagnostic with the source path of the node it names (§V82).
 *
 * A diagnostic about `feedback1/blur2/warp` is unreadable; the same diagnostic followed by
 * `Main / DreamyFeedback_1 / Blur_2 / warp` names a place the user can navigate to.
 */
export function withSourcePath(
  diagnostic: RuntimeDiagnostic,
  sources: ReadonlyMap<NodeId, ComponentSource>,
): RuntimeDiagnostic {
  if (diagnostic.nodeId === undefined) return diagnostic;
  const source = sources.get(diagnostic.nodeId);
  if (source === undefined || source.path.length === 0) return diagnostic;
  return { ...diagnostic, message: `${diagnostic.message} (${source.sourcePath})` };
}
