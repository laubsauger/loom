import { flattenComponents } from "../compiler/flatten.ts";
import { resolveNodeParameters } from "../compiler/validate.ts";
import { createComponentSystem } from "../domain/components/registry.ts";
import { effectiveParameterSchema } from "../domain/parameters/resolve.ts";
import { loadProject } from "../domain/project/load.ts";
import type { RuntimeDiagnostic } from "../domain/types/diagnostics.ts";
import type { GraphDocument } from "../domain/types/graph.ts";
import { nodeRuntimeRequirements } from "../domain/types/node-definition.ts";
import { orderRequirements } from "../domain/types/requirements.ts";
import type { RuntimeRequirement, RuntimeRequirementId } from "../domain/types/requirements.ts";
import { allNodeDefinitions } from "../nodes/definitions/index.ts";
import { createNodeRegistry } from "../nodes/registry/registry.ts";

/**
 * T1340b: an alias, not a second type. This file used to OWN the vocabulary — seven ids,
 * seven labels, and a `switch` on node type to decide which applied — which meant the
 * EXAMPLE LIST knew a Syphon node needs macOS while the node itself did not. The table
 * moved to `@domain/types/requirements.ts` and the per-node answer moved onto the
 * definitions; what is left here is the document-level ROLL-UP, which is the only part
 * that was ever about examples.
 */
export type ExampleRuntimeRequirement = RuntimeRequirement;

const baseNodes = createNodeRegistry(allNodeDefinitions).view();

/** Requirements describe the authored file, including nodes a user may enable later.
 * Clear only demand flags on an analysis copy; the compiler still owns all component
 * expansion, version selection, published values and per-instance overrides. */
function authoredGraph(graph: GraphDocument): GraphDocument {
  return {
    ...graph,
    nodes: Object.fromEntries(Object.entries(graph.nodes).map(([id, node]) => [id, {
      ...node,
      ...(node.ui === undefined ? {} : { ui: { ...node.ui, muted: false, bypassed: false } }),
    }])),
  };
}

/** Pure, file-level runtime dependencies, not permission requests or demand analysis.
 * Invalid or unavailable metadata throws: callers must show unknown compatibility,
 * never silently turn an unreadable graph into a browser-compatible example. */
export function exampleRuntimeRequirements(project: unknown): readonly ExampleRuntimeRequirement[] {
  const system = createComponentSystem(baseNodes);
  const loaded = loadProject(JSON.stringify(project), { nodes: system.nodes, components: system.components });
  if (!loaded.ok) throw new Error(`Cannot determine example runtime requirements: ${loaded.reason}`);
  if (loaded.placeholders.length > 0) {
    throw new Error(`Cannot determine example runtime requirements: unavailable node ${loaded.placeholders[0]?.type}`);
  }
  // The local registry is owned by this analysis; the caller's persisted object is untouched.
  for (const definition of loaded.components) {
    system.components.register({ ...definition, graph: authoredGraph(definition.graph) });
  }
  const flattened = flattenComponents({
    graph: authoredGraph(loaded.document.graph), registry: system.nodes, components: system.components.view(),
  });
  const diagnostics: RuntimeDiagnostic[] = [...loaded.diagnostics, ...flattened.diagnostics];
  const ids = new Set<RuntimeRequirementId>();
  for (const node of Object.values(flattened.graph.nodes)) {
    const definition = system.nodes.get(node.type);
    if (definition === undefined || node.type.startsWith("component:")) {
      throw new Error(`Cannot determine example runtime requirements: unavailable node ${node.type}`);
    }
    /* T1340b: THE NODE'S OWN DECLARATION, not a type switch here. A node with no
       `requires` needs nothing beyond a browser tab, which is why the common case costs
       one absent field rather than a `default:` arm nobody maintains.

       Parameters are resolved for EVERY node rather than only for the one that was known
       to need them: which nodes have a parameter-dependent requirement is the
       definition's business now, and re-deriving that list here would put the switch
       back under a different name. Transport is compile-time, so these are the same
       effective values the app runs on. */
    const resolved = resolveNodeParameters(node, effectiveParameterSchema(definition, node.parameters), definition.title, diagnostics);
    let declared: readonly RuntimeRequirementId[];
    try {
      declared = nodeRuntimeRequirements(definition, resolved.values);
    } catch (error) {
      // The definition refused to classify itself. Refuse too — never fall back to a
      // default and call the file browser-compatible.
      throw new Error(
        `Cannot determine example runtime requirements: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
    for (const id of declared) ids.add(id);
  }
  const error = diagnostics.find((entry) => entry.severity === "error");
  if (error !== undefined) throw new Error(`Cannot determine example runtime requirements: ${error.message}`);
  return orderRequirements(ids);
}
