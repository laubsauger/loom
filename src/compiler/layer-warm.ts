import { isComponentNodeType } from "../domain/components/index.ts";
import type { GraphDocument, GraphNode } from "../domain/types/graph.ts";
import { layerNode } from "../nodes/definitions/layer.ts";
import { compileGraph } from "./compile.ts";
import { flattenComponents } from "./flatten.ts";
import type { CompiledGraph, CompileRequest } from "./types.ts";

/**
 * §T1507b — THE PLAN A DOCUMENT WOULD HAVE WITH ITS BYPASSED LAYERS SWITCHED ON.
 *
 * A Layer that is off is bypassed (§T1498b): its picture's chain is pruned, so switching
 * it on is a structural recompile that builds every pass the chain brings back. This is
 * the plan the backend builds those passes AHEAD from (`warmPasses`), so the switch itself
 * builds nothing. It is never installed, rendered or announced.
 *
 * The compile it asks for is the caller's own request with one difference: every bypassed
 * Layer of the FLAT graph is on — so a layer inside a component instance counts too, and
 * the flattening the request carries is reused rather than redone. Same sinks, settings
 * and capabilities, so the passes it brings back have the ids and bytes the real switch
 * will compile them to.
 *
 * Bounded: at most {@link MAX_WARM_LAYERS} layers (by node id), and the backend holds at
 * most `MAX_WARM_EFFECTS` passes of what comes back.
 */
export const MAX_WARM_LAYERS = 8;

export interface WarmOptions {
  /**
   * T1771b: warm EVERY node that is off, not Layers only. A preset or a board switch turns
   * any node off and on (§T1770b), and its switch-on is the same structural recompile a
   * Layer's is. The app asks for this; a caller that means "the Layers this file ships off"
   * (`examples/runner.ts`, §V1030) leaves it out.
   */
  readonly every?: boolean;
}

/**
 * `request` with up to {@link MAX_WARM_LAYERS} of its off nodes on; null when there are none.
 *
 * Off is bypassed and not muted: mute is not what a switch writes. By default the nodes are
 * the bypassed Layers; with `every`, any bypassed node.
 *
 * A bypassed component INSTANCE cannot be switched on in the flat graph: it was not inlined
 * (§T1032), so its interior is not there to compile. With `every`, the root document's
 * bypassed instances are switched on in the DOCUMENT and it is flattened again, which is
 * what the real switch does; that needs the request's `components`, and is skipped without.
 * An instance bypassed inside a component definition is left off. The flattening made
 * here is the DOCUMENT's: a timeline segment's overrides on the request's own flattening
 * (§T1537b) are not carried onto it, so with both in play the warm plan is the document's
 * with its off nodes on — advisory, like every warm plan.
 */
export function layerWarmRequest(request: CompileRequest, options: WarmOptions = {}): CompileRequest | null {
  const every = options.every === true;
  const off = (node: GraphNode | undefined): boolean => node?.ui?.bypassed === true && node.ui.muted !== true;
  let budget = MAX_WARM_LAYERS;
  let base = request;

  if (every && request.components !== undefined) {
    const instances = Object.keys(request.graph.nodes)
      .filter((nodeId) => off(request.graph.nodes[nodeId]) && isComponentNodeType(request.graph.nodes[nodeId]!.type))
      .sort()
      .slice(0, budget);
    if (instances.length > 0) {
      budget -= instances.length;
      const nodes: GraphDocument["nodes"] = { ...request.graph.nodes };
      for (const nodeId of instances) nodes[nodeId] = { ...nodes[nodeId]!, ui: { ...nodes[nodeId]!.ui, bypassed: false } };
      const graph = { ...request.graph, nodes };
      base = { ...request, graph, flattened: flattenComponents({ graph, registry: request.registry, components: request.components }) };
    }
  }

  const flat = base.flattened?.graph ?? base.graph;
  const bypassed = Object.keys(flat.nodes)
    .filter((nodeId) => {
      const node = flat.nodes[nodeId]!;
      if (!off(node)) return false;
      return every ? !isComponentNodeType(node.type) : node.type === layerNode.type && node.ui?.bypassed === true;
    })
    .sort()
    .slice(0, budget);
  if (bypassed.length === 0) return base === request ? null : base;
  const nodes: GraphDocument["nodes"] = { ...flat.nodes };
  for (const nodeId of bypassed) {
    const node = nodes[nodeId]!;
    nodes[nodeId] = { ...node, ui: { ...node.ui, bypassed: false } };
  }
  // §T1552b: spread onto the graph it came from, so the flattening stays a `FlatGraph`.
  return base.flattened === undefined
    ? { ...base, graph: { ...base.graph, nodes } }
    : { ...base, flattened: { ...base.flattened, graph: { ...base.flattened.graph, nodes } } };
}

/** The plan of {@link layerWarmRequest}, or null when there is nothing to build ahead. */
export function compileLayerWarmPlan(request: CompileRequest, options: WarmOptions = {}): CompiledGraph | null {
  const warm = layerWarmRequest(request, options);
  if (warm === null) return null;
  const plan = compileGraph(warm);
  return plan.ok ? plan : null;
}
