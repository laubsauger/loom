import type { ComponentRecursionError } from "../types/components.ts";
import type { GraphDocument } from "../types/graph.ts";
import type { ComponentId } from "../types/ids.ts";
import { componentNodeType } from "./component-type.ts";
import { componentInstances } from "./instance.ts";

/**
 * Component recursion detection — direct AND indirect (§V83).
 *
 * A project that recursed would fail at compile with no way back: the flattener would
 * expand for ever, and the user's only route out would be hand-editing the file. So
 * recursion is not a compile error to be reported, it is a state that must be impossible
 * to reach — which is why this runs at instantiate, at save and at load.
 *
 * ONE implementation, used by both this track and the compiler track. Two detectors is
 * two chances for the compiler to accept a graph the editor refused, or the reverse.
 *
 * The indirect case (A contains B, B contains A) is the one that matters: nobody builds
 * `A` inside `A` by accident, and everybody builds the two-hop version eventually.
 */

/** Supplies the internal graph of an installed component version. */
export interface ComponentGraphSource {
  graphOf(componentId: ComponentId, version: number): GraphDocument | undefined;
}

export interface RecursionCheckInput {
  /**
   * The component whose internal graph `graph` is, or null when `graph` is the root
   * project document. Naming it is what lets `A → B → A` be caught while checking A's
   * own graph, before A has been written anywhere.
   */
  componentId: ComponentId | null;
  graph: GraphDocument;
  source: ComponentGraphSource;
}

/** Components referenced directly by a graph's instance nodes, deduplicated and sorted. */
export function componentReferences(
  graph: GraphDocument,
): ReadonlyArray<{ componentId: ComponentId; version: number }> {
  const seen = new Map<string, { componentId: ComponentId; version: number }>();
  for (const instance of componentInstances(graph)) {
    const key = `${instance.state.componentId}@${instance.state.version}`;
    if (!seen.has(key)) {
      seen.set(key, { componentId: instance.state.componentId, version: instance.state.version });
    }
  }
  return [...seen.values()];
}

/**
 * Walks the reference graph depth-first and returns the first cycle it closes, or null.
 *
 * The walk is keyed on componentId ALONE, not on `componentId@version`. Two versions of
 * one component are still the same component: `A@2 → B@1 → A@1` is a loop that expands
 * for ever just as surely as `A@1 → A@1` does, and version-keyed bookkeeping would let
 * it through.
 */
export function detectComponentRecursion(input: RecursionCheckInput): ComponentRecursionError | null {
  const { componentId, graph, source } = input;

  // Node on the DFS stack -> the chain that reached it, so a hit reports the whole loop
  // rather than just the id it closed on.
  const onStack = new Map<ComponentId, number>();
  const chain: ComponentId[] = [];

  const visitGraph = (document: GraphDocument): ComponentRecursionError | null => {
    for (const reference of componentReferences(document)) {
      const found = visit(reference.componentId, reference.version);
      if (found !== null) return found;
    }
    return null;
  };

  const visit = (id: ComponentId, version: number): ComponentRecursionError | null => {
    const openedAt = onStack.get(id);
    if (openedAt !== undefined) {
      // Closes the loop: report the chain from where the id was first opened, with the
      // repeat appended so the cycle reads A -> B -> A rather than A -> B.
      return { componentId: id, cycle: [...chain.slice(openedAt), id] };
    }
    const internal = source.graphOf(id, version);
    // An uninstalled component is a §V10 placeholder, not a cycle. It cannot be proven
    // acyclic either, but refusing to load a project because a package is missing would
    // be worse than the placeholder the rest of the system already expects.
    if (internal === undefined) return null;

    onStack.set(id, chain.length);
    chain.push(id);
    const found = visitGraph(internal);
    chain.pop();
    onStack.delete(id);
    return found;
  };

  if (componentId !== null) {
    onStack.set(componentId, 0);
    chain.push(componentId);
  }
  return visitGraph(graph);
}

/**
 * Would placing `componentId@version` inside `host` recurse? (§V83, at instantiate.)
 *
 * `host` is null when instantiating into the root project graph, where recursion is
 * impossible by construction — the root is not a component and so cannot be reached.
 */
export function wouldRecurse(
  host: ComponentId | null,
  componentId: ComponentId,
  version: number,
  source: ComponentGraphSource,
): ComponentRecursionError | null {
  // Asked by building the graph the instantiation would produce and running the one
  // detector over it. A second, "cheaper" reachability check here is exactly how the
  // editor and the compiler end up disagreeing about what is legal.
  const probe: GraphDocument = {
    revision: 0,
    nodes: {
      probe: {
        id: "probe",
        type: componentNodeType(componentId, version),
        definitionVersion: version,
        position: { x: 0, y: 0 },
        parameters: {},
      },
    },
    edges: {},
    groups: {},
  };
  return detectComponentRecursion({ componentId: host, graph: probe, source });
}

/** A diagnostic-ready sentence for a detected cycle. */
export function describeRecursion(error: ComponentRecursionError): string {
  return `Component recursion is not allowed: ${error.cycle.join(" → ")}.`;
}
