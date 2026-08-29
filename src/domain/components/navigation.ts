import type {
  ComponentPath,
  GraphComponentDefinition,
  ParentScope,
} from "../types/components.ts";
import type { RuntimeDiagnostic } from "../types/diagnostics.ts";
import type { GraphDocument, GraphNode } from "../types/graph.ts";
import type { ComponentId, NodeId } from "../types/ids.ts";
import type { NodeDefinition } from "../types/node-definition.ts";
import type { ParameterValue, StoredParameter } from "../types/parameters.ts";
import { storedStaticValue } from "../parameters/slots.ts";
import type { NodeRegistryView } from "../../nodes/registry/registry.ts";
import { componentNodeType } from "./component-type.ts";

/** Static view of a stored bag: slots collapse to their retained static payload (T202). */
function staticParameterView(
  stored: Readonly<Record<string, StoredParameter>>,
): Record<string, ParameterValue> {
  const view: Record<string, ParameterValue> = {};
  for (const [key, value] of Object.entries(stored)) {
    const flat = storedStaticValue(value);
    if (flat !== undefined) view[key] = flat;
  }
  return view;
}
import { readComponentInstance } from "./instance.ts";
import { buildParentScope } from "./parent-scope.ts";
import type { ComponentRegistryView } from "./registry.ts";

/**
 * Entering, leaving and naming a place inside a component (T130, §V82).
 *
 * A `ComponentPath` is a list of INSTANCE node ids, each one living in the graph the
 * previous entry opened. Resolving it produces the chain of frames the breadcrumb bar
 * shows, the graph the canvas should be editing, and the lexical `parent` scope for
 * everything in that graph (§V81) — one walk, because they are all the same walk.
 *
 * The same frames are what makes a diagnostic read `Main / DreamyFeedback_2 / Blur_1 /
 * shader.wgsl:42` instead of naming an internal node id the user has never seen (§V82).
 */

export interface ComponentFrame {
  /** The instance node, as it exists in the graph one level out. */
  instanceNodeId: NodeId;
  instanceNode: GraphNode;
  componentId: ComponentId;
  /** The version this instance is pinned to (§V84) — not necessarily the latest. */
  version: number;
  definition: GraphComponentDefinition;
  /** The component's internal graph: what the canvas edits at this depth. */
  graph: GraphDocument;
  /** Effective published values of the instance, resolved through §V61. */
  parameters: Readonly<Record<string, ParameterValue>>;
  /** Derived display name, e.g. `Bloom_1`. `GraphNode` carries no name field. */
  label: string;
}

export interface Breadcrumb {
  label: string;
  /** Path to navigate to when this crumb is clicked. The root crumb's path is empty. */
  path: ComponentPath;
}

export interface ResolvedComponentPath {
  frames: readonly ComponentFrame[];
  /** The graph the editor is showing — the root document, or the innermost component. */
  graph: GraphDocument;
  /** Innermost component, or null at the root. This is the recursion check's `host`. */
  hostComponentId: ComponentId | null;
  /** Lexical scope for nodes in `graph`; undefined at the root (§V81). */
  scope: ParentScope | undefined;
  breadcrumbs: readonly Breadcrumb[];
  /** How much of `path` actually resolved. Shorter than `path` means it was truncated. */
  resolvedPath: ComponentPath;
  diagnostics: readonly RuntimeDiagnostic[];
}

export interface ResolveComponentPathInput {
  root: GraphDocument;
  path: ComponentPath;
  components: ComponentRegistryView;
  nodes: NodeRegistryView;
  /**
   * Effective published values of an instance node. MUST be `resolveParameters` (§V61) —
   * it is injected rather than imported so this module stays headless and the compiler
   * can pass the same function the editor does.
   */
  resolveValues: (
    node: GraphNode,
    definition: NodeDefinition,
  ) => Readonly<Record<string, ParameterValue>>;
}

/**
 * Ordinal-based label for an instance, counted over the graph it lives in and in sorted
 * id order, so two actors — and two sessions — derive the same name (§V40).
 */
function labelFor(graph: GraphDocument, instanceNodeId: NodeId, name: string): string {
  let ordinal = 0;
  for (const nodeId of Object.keys(graph.nodes).sort()) {
    const node = graph.nodes[nodeId];
    if (node === undefined) continue;
    const state = readComponentInstance(node);
    if (state === null) continue;
    if (node.type !== graph.nodes[instanceNodeId]?.type) continue;
    ordinal += 1;
    if (nodeId === instanceNodeId) return `${name}_${ordinal}`;
  }
  return name;
}

/**
 * Walks a path as far as it resolves. A path that no longer resolves — the instance was
 * deleted, the component uninstalled — is TRUNCATED with a diagnostic rather than
 * throwing: the editor's job at that point is to put the user somewhere real, not to
 * become unusable because a bookmark went stale.
 */
export function resolveComponentPath(input: ResolveComponentPathInput): ResolvedComponentPath {
  const diagnostics: RuntimeDiagnostic[] = [];
  const frames: ComponentFrame[] = [];
  const resolvedPath: NodeId[] = [];
  let graph = input.root;

  for (const instanceNodeId of input.path) {
    const instanceNode = graph.nodes[instanceNodeId];
    if (instanceNode === undefined) {
      diagnostics.push({
        severity: "warning",
        code: "component.path.missingNode",
        message: `Component path stops here: node "${instanceNodeId}" is not in the graph any more.`,
      });
      break;
    }
    const state = readComponentInstance(instanceNode);
    if (state === null) {
      diagnostics.push({
        severity: "warning",
        code: "component.path.notAComponent",
        message: `Component path stops here: "${instanceNodeId}" is not a component instance.`,
        nodeId: instanceNodeId,
      });
      break;
    }
    const definition = input.components.get(state.componentId, state.version);
    if (definition === undefined) {
      diagnostics.push({
        severity: "warning",
        code: "component.path.notInstalled",
        message: `Cannot enter "${instanceNodeId}": component "${state.componentId}" version ${state.version} is not installed.`,
        nodeId: instanceNodeId,
        suggestion: "Install the component package, or upgrade the instance to a version you have (§V10).",
      });
      break;
    }

    const manifest = input.nodes.get(componentNodeType(state.componentId, state.version));
    // No manifest = no resolver; the static view of each stored value (a slot's
    // retained static payload, T202) is the honest fallback — never the raw envelope.
    const parameters =
      manifest === undefined
        ? staticParameterView(instanceNode.parameters)
        : input.resolveValues(instanceNode, manifest);

    frames.push({
      instanceNodeId,
      instanceNode,
      componentId: state.componentId,
      version: state.version,
      definition,
      graph: definition.graph,
      parameters,
      label: labelFor(graph, instanceNodeId, definition.name),
    });
    resolvedPath.push(instanceNodeId);
    graph = definition.graph;
  }

  const innermost = frames[frames.length - 1];
  const breadcrumbs: Breadcrumb[] = [{ label: "Main", path: [] }];
  for (let index = 0; index < frames.length; index += 1) {
    const frame = frames[index] as ComponentFrame;
    breadcrumbs.push({ label: frame.label, path: resolvedPath.slice(0, index + 1) });
  }

  return {
    frames,
    graph,
    hostComponentId: innermost === undefined ? null : innermost.componentId,
    // Outermost first: `buildParentScope` chains them so the innermost is `parent`.
    scope: buildParentScope(frames.map((frame) => frame.parameters)),
    breadcrumbs,
    resolvedPath,
    diagnostics,
  };
}

/** Instance-id -> display name, ready for `formatComponentPath` (§V82). */
export function componentPathNames(frames: readonly ComponentFrame[]): Record<NodeId, string> {
  const names: Record<NodeId, string> = {};
  for (const frame of frames) names[frame.instanceNodeId] = frame.label;
  return names;
}

/** The path one level out. Empty when already at the root. */
export function parentPath(path: ComponentPath): ComponentPath {
  return path.slice(0, -1);
}

/** The path after entering `instanceNodeId` from `path`. */
export function enterPath(path: ComponentPath, instanceNodeId: NodeId): ComponentPath {
  return [...path, instanceNodeId];
}
