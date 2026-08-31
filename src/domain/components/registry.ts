import type { GraphComponentDefinition } from "../types/components.ts";
import type { RuntimeDiagnostic } from "../types/diagnostics.ts";
import type { GraphDocument } from "../types/graph.ts";
import type { ComponentId } from "../types/ids.ts";
import type { NodeDefinition } from "../types/node-definition.ts";
import type { PortDefinition } from "../types/ports.ts";
import type { PortDirection, NodeRegistryView } from "../../nodes/registry/registry.ts";
import { NodeDefinitionError } from "../../nodes/registry/registry.ts";
import { componentNodeType, parseComponentNodeType } from "./component-type.ts";
import { componentNodeDefinition, validateComponentDefinition } from "./definition.ts";
import { withBoundaryPorts } from "./boundary-ports.ts";
import { describeRecursion, detectComponentRecursion } from "./recursion.ts";
import type { ComponentGraphSource } from "./recursion.ts";

/**
 * The component catalogue (T128).
 *
 * Definitions live here, once, and instances reference them — which is the whole of
 * §V79: fixing a component fixes every linked instance because there was only ever one
 * copy to fix. Versions are kept side by side, because an instance pins one (§V84);
 * registering v2 must leave every v1 instance exactly as it was.
 *
 * Registration is also the choke point §V83 names: a definition that would close a
 * recursion loop, direct or indirect, is refused at register time — which covers both
 * "save" and "load", since both funnel through here.
 */

export class ComponentDefinitionError extends Error {
  readonly diagnostics: readonly RuntimeDiagnostic[];

  constructor(message: string, diagnostics: readonly RuntimeDiagnostic[]) {
    super(message);
    this.name = "ComponentDefinitionError";
    this.diagnostics = diagnostics;
  }
}

export interface ComponentRegistryView extends ComponentGraphSource {
  has(componentId: ComponentId, version?: number): boolean;
  get(componentId: ComponentId, version: number): GraphComponentDefinition | undefined;
  /** The highest registered version, which is what "upgrade available" is measured against. */
  latest(componentId: ComponentId): GraphComponentDefinition | undefined;
  versions(componentId: ComponentId): readonly number[];
  /** Latest version of each component, sorted by name — the library pane's list. */
  list(): readonly GraphComponentDefinition[];
  /** Every registered version, sorted by id then version. */
  all(): readonly GraphComponentDefinition[];
  /** Fires after any registration or removal, so the UI can re-render (§V1 projection). */
  subscribe(listener: () => void): () => void;
}

export interface ComponentRegistry extends ComponentRegistryView {
  /**
   * Registers a definition, REPLACING any definition already at the same id and version.
   *
   * Replacement is the point, not an accident: re-authoring a component at the same
   * version is how a fix reaches every linked instance (§V79). Publishing a *breaking*
   * change means bumping the version instead, so pinned instances are untouched (§V84).
   *
   * Throws `ComponentDefinitionError` when the definition is invalid or recursive.
   */
  register(definition: GraphComponentDefinition): void;
  /** Same checks, no mutation — what a command runs before it decides to reject. */
  validate(definition: GraphComponentDefinition): RuntimeDiagnostic[];
  remove(componentId: ComponentId, version?: number): void;
  view(): ComponentRegistryView;
}

const versionKey = (componentId: ComponentId, version: number): string => `${componentId}@${version}`;

export interface ComponentRegistryOptions {
  /**
   * Node manifests used to type exposed ports and to check published targets. This is
   * normally the COMPONENT-AWARE view, so a component nested inside a component types
   * correctly; `createComponentSystem` wires that knot for you.
   */
  nodes: () => NodeRegistryView;
  initial?: Iterable<GraphComponentDefinition>;
}

export function createComponentRegistry(options: ComponentRegistryOptions): ComponentRegistry {
  const byVersion = new Map<string, GraphComponentDefinition>();
  const listeners = new Set<() => void>();

  const graphOf = (componentId: ComponentId, version: number): GraphDocument | undefined =>
    byVersion.get(versionKey(componentId, version))?.graph;

  const versions = (componentId: ComponentId): readonly number[] => {
    const found: number[] = [];
    for (const definition of byVersion.values()) {
      if (definition.componentId === componentId) found.push(definition.version);
    }
    return found.sort((a, b) => a - b);
  };

  const latest = (componentId: ComponentId): GraphComponentDefinition | undefined => {
    const all = versions(componentId);
    const top = all[all.length - 1];
    return top === undefined ? undefined : byVersion.get(versionKey(componentId, top));
  };

  const validate = (definition: GraphComponentDefinition): RuntimeDiagnostic[] => {
    const diagnostics = validateComponentDefinition(definition, options.nodes());
    // §V83: check against a catalogue where THIS definition is already installed, or a
    // component that references itself only after being registered would slip through.
    const source: ComponentGraphSource = {
      graphOf: (id, version) =>
        id === definition.componentId && version === definition.version
          ? definition.graph
          : graphOf(id, version),
    };
    const recursion = detectComponentRecursion({
      componentId: definition.componentId,
      graph: definition.graph,
      source,
    });
    if (recursion !== null) {
      diagnostics.push({
        severity: "error",
        code: "component.recursion",
        message: describeRecursion(recursion),
        suggestion: "A component may not contain itself, directly or through another component (§V83).",
      });
    }
    return diagnostics;
  };

  const notify = (): void => {
    for (const listener of [...listeners]) listener();
  };

  const registry: ComponentRegistry = {
    register(raw: GraphComponentDefinition): void {
      // T607: In/Out nodes inside the graph ARE sockets — folded in HERE, where a
      // definition enters the system, so the flattener, the manifest and validation
      // all read one effective interface (§V109).
      const definition = withBoundaryPorts(raw);
      const diagnostics = validate(definition);
      const errors = diagnostics.filter((diagnostic) => diagnostic.severity === "error");
      if (errors.length > 0) {
        throw new ComponentDefinitionError(
          `Invalid component "${definition.name}": ${errors.map((d) => d.message).join(" ")}`,
          diagnostics,
        );
      }
      byVersion.set(versionKey(definition.componentId, definition.version), definition);
      notify();
    },
    validate,
    remove(componentId: ComponentId, version?: number): void {
      if (version === undefined) {
        for (const each of versions(componentId)) byVersion.delete(versionKey(componentId, each));
      } else {
        byVersion.delete(versionKey(componentId, version));
      }
      notify();
    },
    has: (componentId, version) =>
      version === undefined
        ? versions(componentId).length > 0
        : byVersion.has(versionKey(componentId, version)),
    get: (componentId, version) => byVersion.get(versionKey(componentId, version)),
    latest,
    versions,
    graphOf,
    all: () =>
      [...byVersion.values()].sort(
        (a, b) => a.componentId.localeCompare(b.componentId) || a.version - b.version,
      ),
    list: () => {
      const ids = [...new Set([...byVersion.values()].map((definition) => definition.componentId))];
      const definitions: GraphComponentDefinition[] = [];
      for (const id of ids) {
        const top = latest(id);
        if (top !== undefined) definitions.push(top);
      }
      return definitions.sort((a, b) => a.name.localeCompare(b.name) || a.componentId.localeCompare(b.componentId));
    },
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    view(): ComponentRegistryView {
      return {
        has: registry.has,
        get: registry.get,
        latest: registry.latest,
        versions: registry.versions,
        list: registry.list,
        all: registry.all,
        graphOf: registry.graphOf,
        subscribe: registry.subscribe,
      };
    },
  };

  for (const definition of options.initial ?? []) registry.register(definition);
  return registry;
}

/**
 * A `NodeRegistryView` that also answers for component types.
 *
 * This is composition rather than a change to `createNodeRegistry`: the node registry is
 * a fixed catalogue keyed by type, while components are added, re-authored and versioned
 * at runtime. Wrapping keeps the node registry's "register once, throw on duplicate"
 * contract intact and still lets the existing patch path validate a connection into a
 * component instance through the same `registry.port(...)` call it already makes.
 */
export function createComponentAwareRegistry(
  base: NodeRegistryView,
  components: ComponentRegistryView,
): NodeRegistryView {
  // Keyed on the definition OBJECT, so re-authoring a component (which registers a new
  // object) invalidates the synthesized manifest without any explicit invalidation.
  const synthesized = new WeakMap<GraphComponentDefinition, NodeDefinition>();

  const componentDefinitionFor = (type: string): NodeDefinition | undefined => {
    const ref = parseComponentNodeType(type);
    if (ref === null) return undefined;
    const definition = components.get(ref.componentId, ref.version);
    if (definition === undefined) return undefined;
    const cached = synthesized.get(definition);
    if (cached !== undefined) return cached;
    const built = componentNodeDefinition(definition, view);
    synthesized.set(definition, built);
    return built;
  };

  const get = (type: string): NodeDefinition | undefined =>
    componentDefinitionFor(type) ?? base.get(type);

  const view: NodeRegistryView = {
    has: (type: string) => get(type) !== undefined,
    get,
    require(type: string): NodeDefinition {
      const definition = get(type);
      if (definition === undefined) {
        throw new NodeDefinitionError(`Unknown node type "${type}".`, [
          { severity: "error", code: "node.unknownType", message: `Unknown node type "${type}".` },
        ]);
      }
      return definition;
    },
    list(): readonly NodeDefinition[] {
      const fromComponents: NodeDefinition[] = [];
      for (const definition of components.list()) {
        const built = componentDefinitionFor(
          componentNodeType(definition.componentId, definition.version),
        );
        if (built !== undefined) fromComponents.push(built);
      }
      return [...base.list(), ...fromComponents].sort((a, b) => a.type.localeCompare(b.type));
    },
    categories(): readonly string[] {
      return [...new Set(view.list().map((definition) => definition.category))].sort();
    },
    port(type: string, portId: string, direction: PortDirection): PortDefinition | undefined {
      const definition = componentDefinitionFor(type);
      if (definition === undefined) return base.port(type, portId, direction);
      const ports = direction === "input" ? definition.inputs : definition.outputs;
      return ports.find((port) => port.id === portId);
    },
    statefulDeclaration(type: string) {
      // A component has no §V46 declaration of its own: after flattening, the internal
      // nodes carry theirs. Claiming one here would be inventing an answer.
      if (parseComponentNodeType(type) !== null) return undefined;
      return base.statefulDeclaration(type);
    },
  };

  return view;
}

export interface ComponentSystem {
  components: ComponentRegistry;
  /** The registry to hand `createDomainBus` — knows both node types and components. */
  nodes: NodeRegistryView;
}

/**
 * Ties the two registries together. The component registry validates against the
 * component-aware node view, so a component nested inside a component types correctly.
 */
export function createComponentSystem(
  base: NodeRegistryView,
  initial?: Iterable<GraphComponentDefinition>,
): ComponentSystem {
  // A holder rather than a `let`, because the two halves genuinely reference each other:
  // the component registry validates against the node view, and the node view answers
  // from the component registry.
  const wiring: { nodes?: NodeRegistryView } = {};
  const components = createComponentRegistry({
    nodes: () => {
      const view = wiring.nodes;
      if (view === undefined) throw new Error("component system used before it was wired");
      return view;
    },
  });
  const nodes = createComponentAwareRegistry(base, components.view());
  wiring.nodes = nodes;
  // Registered only once the knot is tied: validating a nested component needs the
  // component-aware view that does not exist until the line above has run.
  for (const definition of initial ?? []) components.register(definition);
  return { components, nodes };
}
