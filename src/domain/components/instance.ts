import type { ComponentInstanceState } from "../types/components.ts";
import type { GraphDocument, GraphNode } from "../types/graph.ts";
import type { NodeId } from "../types/ids.ts";
import type { ParameterValue } from "../types/parameters.ts";
import { parseComponentNodeType } from "./component-type.ts";

/**
 * Reading a component instance out of the document (§V79).
 *
 * An instance stores exactly three things and never a copy of the internal graph:
 *
 *  - its identity and pinned version, carried by `node.type` and `node.definitionVersion`;
 *  - its own PUBLISHED parameter values, in `node.parameters` — the ordinary place, so
 *    `resolveParameters` (§V61), the inspector and `setParameters` all work unchanged;
 *  - optional per-internal-node overrides, in `node.state.componentOverrides`.
 *
 * `ComponentInstanceState` is therefore a VIEW assembled from those, not a fourth copy
 * of the same data sitting in `state`. Two records of one value is two records that can
 * disagree, and the one the compiler happens to read wins silently.
 */

/** Key under which an instance's internal-parameter overrides live in `node.state`. */
export const COMPONENT_OVERRIDES_STATE_KEY = "componentOverrides";

/** Key under which an internal node's lexical `parent.<key>` bindings live (§V81). */
export const PARENT_BINDINGS_STATE_KEY = "parentBindings";

/** Addresses one internal node's parameter, for an override or a diagnostic path. */
export function internalParameterPath(nodeId: NodeId, key: string): string {
  return `${nodeId}/${key}`;
}

export function parseInternalParameterPath(path: string): { nodeId: NodeId; key: string } | null {
  const slash = path.indexOf("/");
  if (slash <= 0 || slash === path.length - 1) return null;
  return { nodeId: path.slice(0, slash), key: path.slice(slash + 1) };
}

function readRecord(value: unknown): Record<string, ParameterValue> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, ParameterValue>;
}

/** True when this node is a component instance rather than an ordinary node. */
export function isComponentInstance(node: GraphNode): boolean {
  return parseComponentNodeType(node.type) !== null;
}

/**
 * The instance state a node represents, or null when it is not a component instance.
 *
 * `version` comes from the type, which is the lookup key; a `definitionVersion` that
 * disagrees is reported by `componentInstanceDiagnostics`, never silently preferred.
 */
export function readComponentInstance(node: GraphNode): ComponentInstanceState | null {
  const ref = parseComponentNodeType(node.type);
  if (ref === null) return null;
  const overrides = readRecord(node.state?.[COMPONENT_OVERRIDES_STATE_KEY]);
  return {
    componentId: ref.componentId,
    version: ref.version,
    parameters: { ...node.parameters },
    ...(overrides === undefined ? {} : { overrides: { ...overrides } }),
  };
}

/** The `parent.<key>` bindings declared on an internal node (§V81). */
export function readParentBindings(node: GraphNode): Readonly<Record<string, string>> {
  const raw = node.state?.[PARENT_BINDINGS_STATE_KEY];
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
  const bindings: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === "string") bindings[key] = value;
  }
  return bindings;
}

export interface ComponentInstanceRef {
  nodeId: NodeId;
  node: GraphNode;
  state: ComponentInstanceState;
}

/** Every component instance in a graph, in sorted node-id order (§V40 determinism). */
export function componentInstances(graph: GraphDocument): ComponentInstanceRef[] {
  const found: ComponentInstanceRef[] = [];
  for (const nodeId of Object.keys(graph.nodes).sort()) {
    const node = graph.nodes[nodeId];
    if (node === undefined) continue;
    const state = readComponentInstance(node);
    if (state !== null) found.push({ nodeId, node, state });
  }
  return found;
}

/**
 * A stable, human-readable name for an instance — the thing a diagnostic path is made
 * of (§V82). `GraphNode` has no per-instance name field, so the name is derived: the
 * component's name plus its ordinal among the instances of the same component in the
 * same graph, counted in sorted id order so two actors derive the same name.
 */
export function instanceDisplayNames(
  graph: GraphDocument,
  componentName: (componentId: string, version: number) => string,
): Record<NodeId, string> {
  const counters = new Map<string, number>();
  const names: Record<NodeId, string> = {};
  for (const instance of componentInstances(graph)) {
    const base = componentName(instance.state.componentId, instance.state.version);
    const ordinal = (counters.get(base) ?? 0) + 1;
    counters.set(base, ordinal);
    names[instance.nodeId] = `${base}_${ordinal}`;
  }
  return names;
}
