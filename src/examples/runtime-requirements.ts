import { flattenComponents } from "../compiler/flatten.ts";
import { resolveNodeParameters } from "../compiler/validate.ts";
import { createComponentSystem } from "../domain/components/registry.ts";
import { effectiveParameterSchema } from "../domain/parameters/resolve.ts";
import { loadProject } from "../domain/project/load.ts";
import type { RuntimeDiagnostic } from "../domain/types/diagnostics.ts";
import type { GraphDocument } from "../domain/types/graph.ts";
import { allNodeDefinitions } from "../nodes/definitions/index.ts";
import { createNodeRegistry } from "../nodes/registry/registry.ts";

export interface ExampleRuntimeRequirement {
  readonly id: "helper" | "desktop" | "macos" | "apple-silicon" | "ndi-sdk" | "windows" | "not-implemented";
  readonly label: string;
  readonly description: string;
}

const REQUIREMENTS: readonly ExampleRuntimeRequirement[] = [
  { id: "helper", label: "Device helper", description: "Requires the local device helper; the hosted browser alone cannot run all features." },
  { id: "desktop", label: "Desktop only", description: "Requires the Loom desktop app; unavailable in the hosted browser." },
  { id: "macos", label: "macOS", description: "Uses a macOS-only integration." },
  { id: "apple-silicon", label: "Apple Silicon", description: "Native Vision requires an Apple Silicon Mac and the configured Python Vision worker." },
  { id: "ndi-sdk", label: "NDI SDK", description: "Requires the macOS desktop development build with a locally supplied NDI SDK; the SDK is not bundled." },
  { id: "windows", label: "Windows", description: "Targets Windows desktop video sharing; macOS cannot run this transport." },
  { id: "not-implemented", label: "Not implemented", description: "Spout's native transport is not implemented on any shipping host. This graph supports preparation only, not live video sharing." },
];

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
  const ids = new Set<ExampleRuntimeRequirement["id"]>();
  for (const node of Object.values(flattened.graph.nodes)) {
    const definition = system.nodes.get(node.type);
    if (definition === undefined || node.type.startsWith("component:")) {
      throw new Error(`Cannot determine example runtime requirements: unavailable node ${node.type}`);
    }
    switch (node.type) {
      case "oscIn": case "oscOut": case "laserOut":
        ids.add("helper");
        break;
      case "syphonIn": case "syphonOut":
        ids.add("desktop"); ids.add("macos");
        break;
      case "ndiIn": case "ndiOut":
        ids.add("desktop"); ids.add("macos"); ids.add("ndi-sdk");
        break;
      case "spoutIn": case "spoutOut":
        ids.add("desktop"); ids.add("windows"); ids.add("not-implemented");
        break;
      case "personMask": {
        const resolved = resolveNodeParameters(node, effectiveParameterSchema(definition, node.parameters), definition.title, diagnostics);
        // Transport is compile-time, so this is the same effective value the app uses.
        const transport = resolved.values["transport"];
        ids.add("macos");
        if (transport === "native") {
          ids.add("desktop"); ids.add("apple-silicon");
        } else if (transport === "helper") {
          ids.add("helper");
        } else {
          throw new Error(`Cannot determine example runtime requirements: unknown Vision transport ${String(transport)}`);
        }
        break;
      }
    }
  }
  const error = diagnostics.find((entry) => entry.severity === "error");
  if (error !== undefined) throw new Error(`Cannot determine example runtime requirements: ${error.message}`);
  return REQUIREMENTS.filter((requirement) => ids.has(requirement.id));
}
