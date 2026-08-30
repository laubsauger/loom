import type { RuntimeDiagnostic } from "../types/diagnostics.ts";
import type { GraphDocument } from "../types/graph.ts";
import type { NodeId } from "../types/ids.ts";
import { isParameterSlot } from "../parameters/slots.ts";
import { opReferenceNames } from "./liveness.ts";
import { nodeNames } from "./names.ts";

/**
 * Authoring-time `op()` reference cycles (T331, §V152, §V244).
 *
 * `bindCycleDiagnostics` refuses a loop of `bind` refs on ONE node. A cross-node
 * reference — `op('a').par.x` — closes a loop that is invisible to it and to a texture
 * topo sort alike: no edge exists between the two nodes at all, so nothing in the graph
 * layer had an opinion about `a` reading `b` while `b` reads `a`.
 *
 * There has been a runtime guard for it since T316 (`node-references.ts` carries a
 * visited set and NAMES the loop instead of overflowing the stack). §V244 is the reason
 * that is not the end of the story: a mitigation which makes a bug survivable removes the
 * pressure to prevent it, and §V152 asks for the cycle to be REFUSED when it is written,
 * with the path named. A named runtime failure still means the user authored something
 * the document should never have held, and every reader downstream — the compiler, the
 * inspector, a `.loom.json` opened tomorrow — has to cope with it forever.
 *
 * ## The unit of the cycle is the NODE, not the parameter
 *
 * `op('a').par.x` resolves by resolving `a`'s WHOLE schema (`resolveParameterSchema` is
 * what the reader calls, because a sibling bind inside `a` needs the schema anyway). So
 * `a.x → b.y` together with `b.z → a.w` really does recurse forever even though the two
 * parameter chains never touch: reading `b.y` resolves `b.z` on the way past. The
 * reader's visited set is keyed by node id for that reason, and this gate is keyed the
 * same way DELIBERATELY (§V61's spirit: one answer to "is this a cycle", not two).
 * Making the gate finer than the reader would accept documents the reader then refuses
 * one hop down — where §V243 says the failure is invisible at the top of the chain.
 * If the reader ever resolves a single parameter in isolation, both halves move together.
 *
 * ## Why a dangling reference is not a cycle
 *
 * `op('ghost')` names nothing, so it contributes no edge. It is already reported where it
 * belongs — at resolution, on the parameter that carries it — and refusing a patch for it
 * would make an expression unwritable until the node it names exists, which is backwards
 * from how people build a network.
 */

/** One reference: the parameter that carries it, and the node it reaches. */
interface ReferenceEdge {
  readonly from: NodeId;
  readonly parameterKey: string;
  readonly to: NodeId;
}

/**
 * Every ACTIVE `op()` reference in the document, as node → node edges.
 *
 * Active bindings only, matching §V110's convention and `liveness.ts`: a retained
 * expression on a parameter sitting in Constant is data, not a dependency (§V108), and
 * activating it is itself a patch which re-runs this check. Component slots (`color.r`,
 * §V113) are ordinary carriers of an expression and are walked like any other key.
 */
function referenceEdges(graph: GraphDocument): Map<NodeId, ReferenceEdge[]> {
  const byName = nodeNames(graph);
  const edges = new Map<NodeId, ReferenceEdge[]>();

  for (const nodeId of Object.keys(graph.nodes).sort()) {
    const node = graph.nodes[nodeId];
    if (node === undefined) continue;
    const outgoing: ReferenceEdge[] = [];
    for (const key of Object.keys(node.parameters).sort()) {
      const stored = node.parameters[key];
      if (stored === undefined || !isParameterSlot(stored)) continue;
      const binding = stored.bindings[stored.mode];
      if (binding?.kind !== "expression") continue;
      for (const name of opReferenceNames(binding.source)) {
        const target = byName.get(name);
        // A reference to a name nothing carries is a dangling reference, reported at
        // resolution. It cannot close a loop, so it is not this function's business.
        if (target === undefined) continue;
        outgoing.push({ from: nodeId, parameterKey: key, to: target });
      }
    }
    if (outgoing.length > 0) edges.set(nodeId, outgoing);
  }

  return edges;
}

const displayName = (graph: GraphDocument, nodeId: NodeId): string =>
  graph.nodes[nodeId]?.label ?? nodeId;

/**
 * One loop back to `root`, as the edges taken, or null when `root` sits on none.
 *
 * `explored` is never unwound, which is what keeps this linear, and it is sound because
 * "can this node reach `root`" is a property of the NODE and not of the path that arrived
 * at it: the first visit explores it fully, so a later path reaching it would find
 * nothing new. That trades enumerating every loop for finding one — and one named path is
 * what §V152 asks the refusal to carry.
 */
function loopThrough(
  edges: ReadonlyMap<NodeId, ReferenceEdge[]>,
  root: NodeId,
): ReferenceEdge[] | null {
  const explored = new Set<NodeId>([root]);
  const stack: ReferenceEdge[] = [];

  const walk = (from: NodeId): ReferenceEdge[] | null => {
    for (const edge of edges.get(from) ?? []) {
      stack.push(edge);
      if (edge.to === root) return [...stack];
      if (!explored.has(edge.to)) {
        explored.add(edge.to);
        const found = walk(edge.to);
        if (found !== null) return found;
      }
      stack.pop();
    }
    return null;
  };

  return walk(root);
}

/** `b.gain → a.gain → b` — the path §V152 wants the refusal to name. */
function pathText(graph: GraphDocument, loop: readonly ReferenceEdge[], root: NodeId): string {
  const hops = loop.map((edge) => `${displayName(graph, edge.from)}.${edge.parameterKey}`);
  return [...hops, displayName(graph, root)].join(" → ");
}

function cycleDiagnostic(
  graph: GraphDocument,
  loop: readonly ReferenceEdge[],
  root: NodeId,
): RuntimeDiagnostic {
  return {
    severity: "error",
    code: "parameter.referenceCycle",
    message: `Parameter reference chain is circular: ${pathText(graph, loop, root)}.`,
    nodeId: root,
    suggestion:
      "Break the loop: one of these expressions must stop reading the other (§V152).",
  };
}

/**
 * Every `op()` reference cycle in the document, one diagnostic each.
 *
 * The whole-document form, for a graph that arrived from a FILE rather than through the
 * command bus — the compiler calls it, exactly as it calls `bindCycleDiagnostics`, so a
 * project someone hand-edited or an older export still reports in the problems tab
 * instead of only misbehaving at resolution.
 */
export function referenceCycleDiagnostics(graph: GraphDocument): RuntimeDiagnostic[] {
  const edges = referenceEdges(graph);
  const diagnostics: RuntimeDiagnostic[] = [];
  // A loop is found from every node on it; reporting it once per member would be N
  // copies of one problem. The first member (by id, so it is deterministic) reports.
  const reported = new Set<NodeId>();

  for (const root of [...edges.keys()].sort()) {
    if (reported.has(root)) continue;
    const loop = loopThrough(edges, root);
    if (loop === null) continue;
    diagnostics.push(cycleDiagnostic(graph, loop, root));
    for (const edge of loop) reported.add(edge.from);
  }

  return diagnostics;
}

/**
 * The cycles that pass through ONE node — the patch gate's question (§V152).
 *
 * Scoped to the node the patch wrote, and not to the whole document, because a
 * document can arrive carrying a cycle and refusing every unrelated edit until it is
 * fixed would make the file harder to repair than to abandon. A `setParameters` touches
 * one node, so any loop the patch CREATED runs through that node; a loop elsewhere is the
 * compiler's report, not this patch's rejection.
 *
 * Checked on the MERGED draft, like `bindCycleDiagnostics`: the loop may close through a
 * parameter this patch never touched, and the draft is discarded whole, so a document
 * that went through the bus can never hold one.
 */
export function referenceCyclesThrough(graph: GraphDocument, nodeId: NodeId): RuntimeDiagnostic[] {
  const loop = loopThrough(referenceEdges(graph), nodeId);
  return loop === null ? [] : [cycleDiagnostic(graph, loop, nodeId)];
}
