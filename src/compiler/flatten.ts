import type {
  ComponentPath,
  ComponentRecursionError,
  GraphComponentDefinition,
  ParentScope,
} from "../domain/types/components.ts";
import type { RuntimeDiagnostic } from "../domain/types/diagnostics.ts";
import type { GraphDocument, GraphEdge, GraphNode } from "../domain/types/graph.ts";
import type { NodeId, PortId } from "../domain/types/ids.ts";
import type {
  ParameterMode,
  ParameterSchema,
  ParameterValue,
  StoredParameter,
} from "../domain/types/parameters.ts";
import type { ResolvedParameters } from "../domain/parameters/resolve.ts";
import { renumberedName, rewriteNodeNameReferences } from "../domain/graph/names.ts";
import { isPreviewablePortKind } from "../domain/graph/previewable.ts";
import { effectiveParameterSchema } from "../domain/parameters/resolve.ts";
import { isParameterSlot, storedStaticValue } from "../domain/parameters/slots.ts";
import { storedValues } from "../domain/parameters/stored-values.ts";
import type { NodeRegistryView } from "../nodes/registry/registry.ts";
import {
  buildParentScope,
  componentSourcePath,
  describeRecursion,
  detectComponentRecursion,
  effectiveInternalOverrides,
  instanceDisplayNames,
  parentBindResolver,
  parentScopeDrivers,
  parseInternalParameterPath,
  readComponentInstance,
} from "../domain/components/index.ts";
import type { ComponentRegistryView } from "../domain/components/index.ts";
import { CompilerDiagnosticCode, compilerDiagnostic } from "./diagnostics.ts";
import { resolveNodeParameters } from "./validate.ts";
import type { ActiveSink } from "./types.ts";

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
export const COMPONENT_ID_SEPARATOR = "/";

export function flattenedNodeId(prefix: string, nodeId: NodeId): NodeId {
  return prefix === "" ? nodeId : `${prefix}${COMPONENT_ID_SEPARATOR}${nodeId}`;
}

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

export interface FlattenedGraph {
  /** The parent logical graph with every instance inlined. No component types remain —
   *  except a MUTED or BYPASSED instance, kept whole so the compiler's splice can see
   *  its flags (T1030); the splice removes it before any node compiles. */
  readonly graph: GraphDocument;
  /** Flattened node id -> where it came from, sorted by id. */
  readonly sources: ReadonlyMap<NodeId, ComponentSource>;
  /**
   * Flattened instance id -> its exposed OUTPUT ports, in exposure order, mapped to the
   * internal endpoint each became. This is what redirects a sink that named the instance.
   */
  readonly instanceOutputs: ReadonlyMap<NodeId, ReadonlyMap<PortId, FlatEndpoint>>;
  /** Sinks the flattened-away instances implied — a previewed instance (§V28, §V25). */
  readonly sinks: ReadonlyArray<ActiveSink>;
  /** Non-null when the graph recurses; the graph is returned untouched (§V83). */
  readonly recursion: ComponentRecursionError | null;
  readonly diagnostics: ReadonlyArray<RuntimeDiagnostic>;
  /** True when at least one instance was inlined. */
  readonly changed: boolean;
}

/** The published parameter page of a component, as a parameter schema. */
function publishedSchema(definition: GraphComponentDefinition): ParameterSchema {
  const schema: ParameterSchema = {};
  for (const published of definition.parameters) schema[published.key] = published.definition;
  return schema;
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

/**
 * The published modes that mean the same thing wherever the slot is evaluated (T1017).
 *
 * `expression` reads `time`/`frame` and `op('name')`, and after flattening every name in
 * the document lives in ONE flat graph whose labels B41 already made unique — so the
 * expression resolves to the same node from the instance or from the internal parameter
 * it drives. `driven` names a channel, which is the same global namespace (§V129).
 *
 * `bind` is deliberately absent and it is the whole reason this is a whitelist rather
 * than "anything that is a slot": a bind ref is RELATIVE. `parent.gain` written on the
 * instance means the component that owns the INSTANCE; the same text carried one level
 * inward would mean the instance itself, silently reading a different knob. A sibling
 * ref moves the same way. So a bind is resolved here, where its scope is, and its value
 * is what fans out. `static` and `map` cannot move per frame at all (T988, §V287), so
 * there is nothing to defer.
 */
const HOP_INVARIANT_MODES: ReadonlySet<ParameterMode> = new Set<ParameterMode>(["expression", "driven"]);

/**
 * The two shapes of one instance's published page, built TOGETHER from one resolution.
 *
 * ## Why both, and why from one call (T1017, §V837, T1000)
 *
 * §V80's fan-out and §V81's lexical scope are fed by the same page and need it in
 * different shapes, and the last three instances of §V837 were all "one of two things
 * built at a different moment than the other". So there is one `resolveNodeParameters`
 * and one function that projects it, rather than a resolved page here and a stored page
 * computed at the call site — which is how "at which moment" gets set on one and
 * forgotten on the other.
 *
 *  - `values` — STORED space, every key a plain value. What `buildParentScope` reads,
 *    because a `ParentScope` is a value lookup: `parentBindResolver` and
 *    `parentScopeDrivers` both hand their answer straight to `validateParameterValue`.
 *  - `stored` — what §V80 writes onto internal parameters. Identical to `values` EXCEPT
 *    for a key whose active mode is hop-invariant AND which actually drives a target:
 *    that key keeps its SLOT, unresolved, so the internal parameter carries the
 *    expression or the channel and the ordinary per-frame values-only resolution (§V163)
 *    evaluates it at the frame, against the flat graph, through the one read path (§V61).
 *
 * ## Why a slot rather than a per-frame re-flattening
 *
 * This is §V5's split applied one layer up. The STRUCTURE a component flattens to —
 * which nodes, which edges, which resources — depends only on the document, which is why
 * `flattenComponents` is memoized on the document revision (§V529: it costs 5–7× the
 * value graph it feeds, and per-frame flattening made the correct version 1.4× SLOWER
 * than the broken one). Only the VALUE moves per frame. Handing the slot down means the
 * value is evaluated where every other animated parameter's is — in `validateGraph`, on
 * the flat graph, with the frame and the channel resolver already in hand — so animating
 * a published knob costs the flattener nothing at all.
 *
 * ## Why this cannot bring back B8's double decode
 *
 * The §V56 hazard is a display-space number decoded TWICE, and it needs a RESOLVED value
 * to happen: T307 kept this boundary on `entries[].value` (display-encoded) rather than
 * `values` (already decoded to linear) precisely so a picked mid-grey reaches the shader
 * at 0.2140 and not 0.0376 (B8, T187). Both halves above preserve that. `values` is
 * `storedValues(...)`, unchanged. `stored` substitutes the UNRESOLVED slot — a number
 * that has not been resolved cannot have been decoded, and the internal parameter it
 * lands on decodes exactly once, like any slot a user typed there directly. A compound
 * published per component (`tint.r`, §V113) has no slot at the bare key, so it takes the
 * `values` path unchanged and its decode count is untouched.
 */
interface PublishedPage {
  /** STORED space, fully resolved. The `parent.<key>` scope (§V81) reads this. */
  readonly values: Record<string, ParameterValue>;
  /** What §V80 fans out onto internal parameters; animated keys stay slots. */
  readonly stored: Record<string, StoredParameter>;
  /**
   * Diagnostics belonging to the deferred keys, to be DROPPED at this level.
   *
   * A key whose slot travels inward is not decided here, so neither is its verdict: the
   * flattener has no frame, no channel resolver and no reader, and reporting from that
   * position produced exactly the false alarms T1017 measured — `op()` warned and a
   * clock read 0 — about parameters that are about to resolve correctly at every target.
   * Identity, not text: these are the very objects `resolveNodeParameters` pushed.
   */
  readonly deferred: ReadonlySet<RuntimeDiagnostic>;
}

function publishedPage(
  resolved: ResolvedParameters,
  definition: GraphComponentDefinition,
): PublishedPage {
  // Only a knob that DRIVES something may defer: a published parameter with no targets
  // exists purely for `parent.<key>` (§V81), so its value is read here or nowhere, and
  // deferring it would silence a real diagnostic with nothing downstream to restate it.
  const driving = new Set<string>();
  for (const published of definition.parameters) {
    if (published.targets.length > 0) driving.add(published.key);
  }

  // THE un-decoded page, asked for the one way there is to ask (§V56, T307). `stored` is
  // a DELTA on it rather than a second walk of the same entries: a parallel loop here
  // would be a third caller inventing a third answer, which is the exact thing
  // `storedValues` exists to prevent.
  const values = storedValues(resolved);
  const stored: Record<string, StoredParameter> = { ...values };
  const deferred = new Set<RuntimeDiagnostic>();
  for (const entry of resolved.entries) {
    if (!driving.has(entry.key) || entry.slot === undefined) continue;
    if (!HOP_INVARIANT_MODES.has(entry.mode)) continue;
    stored[entry.key] = entry.slot;
    if (entry.diagnostic !== null) deferred.add(entry.diagnostic);
  }
  return { values, stored, deferred };
}

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
  /** Published values of the enclosing instances, outermost first (§V81). */
  readonly chain: ReadonlyArray<Readonly<Record<string, ParameterValue>>>;
}

interface LevelResult {
  /** External input port id -> the internal endpoint it maps to, in exposure order. */
  readonly inputs: Map<PortId, FlatEndpoint>;
  readonly outputs: Map<PortId, FlatEndpoint>;
}

/**
 * Flattens a graph, recursively.
 *
 * `detectComponentRecursion` runs first and the walk is abandoned when it fires, so this
 * function terminates by construction rather than by a depth counter — one detector,
 * shared with the editor, so the two can never disagree about what is legal (§V83).
 */
export function flattenComponents(request: FlattenRequest): FlattenedGraph {
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
      graph: request.graph,
      sources: new Map(),
      instanceOutputs: new Map(),
      sinks: [],
      recursion,
      diagnostics,
      changed: false,
    };
  }

  const nodes: Record<NodeId, GraphNode> = {};
  const edges: Record<string, GraphEdge> = {};
  const sources = new Map<NodeId, ComponentSource>();
  const instanceOutputs = new Map<NodeId, ReadonlyMap<PortId, FlatEndpoint>>();
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
        rewriteNodeNameReferences(graph, rename.oldName, rename.newName);
        const node = graph.nodes[rename.nodeId];
        if (node !== undefined) graph.nodes[rename.nodeId] = { ...node, label: rename.newName };
      }
    }
    for (const label of levelLabels) usedNames.add(label);
    return graph;
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
      if (driven !== undefined) parameters[key] = driven;
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
    const scope = buildParentScope(input.chain);
    const grouped = overridesByNode(input.overrides);
    /** Raw instance id -> the boundary of the subgraph it expanded into. */
    const childInputs = new Map<NodeId, ReadonlyMap<PortId, FlatEndpoint>>();
    const childOutputs = new Map<NodeId, ReadonlyMap<PortId, FlatEndpoint>>();

    const names = instanceDisplayNames(
      levelGraph,
      (componentId, version) => request.components.get(componentId, version)?.name ?? componentId,
    );

    for (const nodeId of Object.keys(levelGraph.nodes).sort()) {
      const node = levelGraph.nodes[nodeId];
      if (node === undefined) continue;
      const flatId = flattenedNodeId(input.prefix, nodeId);
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
      const parameters = effectiveParameters(node, schema, grouped.get(nodeId) ?? {}, scope, flatId);
      const resolved: GraphNode = { ...node, id: flatId, parameters };

      if (instance === null) {
        addNode(resolved, flatId);
        recordSource(flatId, input.path, node, node.label ?? nodeId);
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
        recordSource(flatId, input.path, node, node.label ?? nodeId);
        continue;
      }

      if (node.ui?.muted === true || node.ui?.bypassed === true) {
        /*
         * T1030 — MUTE AND BYPASS ON AN INSTANCE MUST SURVIVE FLATTENING. Inlining
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
        recordSource(flatId, input.path, node, node.label ?? nodeId);
        continue;
      }

      const label = node.label ?? names[nodeId] ?? componentDefinition.name;
      instanceNames[flatId] = label;
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
      const publishedDiagnostics: RuntimeDiagnostic[] = [];
      const page = publishedPage(
        resolveNodeParameters(
          resolved,
          publishedSchema(componentDefinition),
          node.type,
          publishedDiagnostics,
        ),
        componentDefinition,
      );
      for (const diagnostic of publishedDiagnostics) {
        if (!page.deferred.has(diagnostic)) diagnostics.push(diagnostic);
      }
      const published = page.values;
      const childOverrides = effectiveInternalOverrides(componentDefinition, resolved, page.stored);

      const child = flattenLevel({
        graph: componentDefinition.graph,
        definition: componentDefinition,
        prefix: flatId,
        path: [...input.path, flatId],
        overrides: childOverrides,
        chain: [...input.chain, published],
      });
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
    chain: [],
  });

  return {
    graph: {
      revision: request.graph.revision,
      nodes,
      edges,
      // Groups are a canvas affordance, not a logical one: a flattened graph has no canvas.
      groups: {},
    },
    sources,
    instanceOutputs,
    sinks,
    recursion: null,
    diagnostics,
    changed,
  };
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
