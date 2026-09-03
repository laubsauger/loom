import type { GraphDocument, GraphNode } from "../types/graph.ts";
import type { NodeId } from "../types/ids.ts";
import { isParameterSlot } from "../parameters/slots.ts";
import { parseExpression, type ExpressionAst } from "../expressions/index.ts";
import { nodeNames } from "./names.ts";
import { sourceReferenceTokens, sourceReferencesOf } from "./source-references.ts";

/**
 * What a parameter DEPENDS ON, as edges between nodes (T248, §V154).
 *
 * §V154 says the dependency graph is data edges ∪ parameter references, and this is the
 * second half of that union — the half with no wire. Three things read it and they must
 * not disagree:
 *
 *  - the CYCLE GATE (`reference-cycles.ts`), which refuses a patch;
 *  - LIVENESS (`liveness.ts`), which decides whether a node is dead;
 *  - the reference LINES on the canvas (§V151), which show the user the same fact.
 *
 * A line that disagrees with a refusal is worse than no line: it is the tool asserting
 * something about the document that the tool itself will not act on. So the traversal is
 * here, once, and the consumers filter it rather than re-deriving it.
 *
 * ## Two relationships, drawn the same way and RULED on differently
 *
 * `op('a').par.x` in an expression, and a `driven` slot naming a value node's channel,
 * are both "this parameter reads that node". For the picture they are one idea with two
 * labels. For the CYCLE GATE they are not: an `op()` chain resolves through
 * `resolveParameters` and can recurse forever (§V152, which is why the gate exists),
 * while a `driven` channel resolves through the value graph, which has its own topological
 * order and its own cycle rejection (§V179, T273). Widening the gate to driven edges here
 * would refuse documents the value graph handles correctly. Hence `kind`: one walk, and
 * each consumer says which relationships it is talking about.
 */

export type ParameterDependencyKind =
  /** `op('name').par.key` inside an expression (§V127). */
  | "reference"
  /** A `driven` slot naming a value node's channel (§V143, T238). */
  | "driven"
  /**
   * T350 (§V285): a source-reference parameter naming the node a Feedback records.
   * Who rules on it: LIVENESS counts it (the source chain is alive, §V154); the
   * LINES draw it (the loop the user sees is this, dashed); the CYCLE GATE exempts
   * it — closing the loop is this reference's entire purpose, and the compiler's
   * temporal split is what legalises the cycle it closes.
   */
  | "feedback"
  /**
   * T447: scene-assembly references — a Render naming its camera/lights/geometries, a
   * Geometry naming its material. Who rules: LIVENESS counts them (a referenced camera
   * is alive); the LINES draw them, hued per kind; the CYCLE GATE counts them too —
   * unlike feedback, scene assembly is acyclic and a loop through it is a real error.
   */
  | "camera"
  | "light"
  | "projector"
  | "scene"
  | "material";

export interface ParameterDependency {
  readonly from: NodeId;
  /** The parameter carrying it — a bare key or a component key (`color.r`, §V113). */
  readonly parameterKey: string;
  readonly kind: ParameterDependencyKind;
  /** As written: the referenced node's name, or the channel address. */
  readonly address: string;
  readonly to: NodeId;
}

/**
 * `op('name')` targets in one expression source. Parse-based; regex fallback for legacy text.
 *
 * The switch is EXHAUSTIVE over `ExpressionAst` on purpose — no `default` — so a seventh
 * node kind fails the typecheck here instead of silently dropping every reference nested
 * inside it. That is exactly how `call` was missed.
 */
export function opReferenceNames(source: string): string[] {
  const parsed = parseExpression(source);
  if (parsed.ok) {
    const names: string[] = [];
    const walk = (ast: ExpressionAst): void => {
      switch (ast.kind) {
        case "opRef":
          names.push(ast.name);
          return;
        case "unary":
          walk(ast.operand);
          return;
        case "binary":
          walk(ast.left);
          walk(ast.right);
          return;
        /*
         * A CALL'S ARGUMENTS ARE WHERE REAL REFERENCES LIVE. Missing this case cost the
         * owner a working example that read as dead: `clamp((op('beat1').chan.low - 0.7)
         * / 0.28, 0, 1)` drove a radius every frame while the canvas drew no reference
         * line, because the only `opRef` in it sits inside `clamp`'s arguments and the
         * walk returned at `default`. An audio node that visibly drives nothing is
         * indistinguishable from one wired to nothing.
         *
         * The consequence beyond the drawing is worse and is why this is not cosmetic:
         * `reference-cycles.ts` walks the SAME function, so a reference cycle routed
         * through any whitelisted call was undetectable.
         */
        case "call":
          for (const arg of ast.args) walk(arg);
          return;
        case "number":
        case "variable":
          return;
      }
    };
    walk(parsed.ast);
    return names;
  }
  // A stored source the current grammar refuses (older document): the reference is
  // still a dependency, so a syntactic scan beats pretending it is not there.
  return [...source.matchAll(/op\(\s*(['"])(.+?)\1\s*\)/g)].map((match) => match[2] ?? "");
}

/**
 * The node NAME a `driven` channel address points at.
 *
 * A channel is addressed `name` or `name:channel` (§I, T273/T344): `mouse1` takes the
 * node's only channel (or its `value`), `mouse1:x` names one of several. Only the part
 * before the colon is a node name.
 *
 * This existing rule had been implemented once, in the value-graph RESOLVER, and nowhere
 * else — so `liveness.ts` matched the whole address against node names and a Mouse driving
 * a parameter through `mouse1:x` read as DEAD while it was visibly working. That is §V154's
 * bug wearing the other binding mode: a dependency invisible to the walk that decides what
 * is reachable. One spelling of the rule, in the layer both callers can reach.
 */
export function channelTargetName(address: string): string {
  const colon = address.indexOf(":");
  return colon < 0 ? address : address.slice(0, colon);
}

/**
 * Everything ONE node's active bindings point at, as `{kind, address}` pairs.
 *
 * Active bindings only, per §V110's convention: a retained expression on a parameter
 * sitting in Constant is data, not a dependency (§V108), and activating it is itself an
 * edit. Component slots (`color.r`, §V113) carry expressions like any other key and are
 * walked the same way — a reference line has to appear for a channel-driven colour, which
 * is exactly the case §V113 exists to make possible.
 */
export function bindingTargets(
  parameters: GraphNode["parameters"],
): Array<{ parameterKey: string; kind: ParameterDependencyKind; address: string }> {
  const targets: Array<{ parameterKey: string; kind: ParameterDependencyKind; address: string }> = [];
  for (const key of Object.keys(parameters).sort()) {
    const stored = parameters[key];
    if (stored === undefined || !isParameterSlot(stored)) continue;
    const binding = stored.bindings[stored.mode];
    if (binding === undefined) continue;
    if (binding.kind === "driven") {
      targets.push({ parameterKey: key, kind: "driven", address: binding.channel });
      continue;
    }
    if (binding.kind !== "expression") continue;
    for (const name of opReferenceNames(binding.source)) {
      targets.push({ parameterKey: key, kind: "reference", address: name });
    }
  }
  return targets;
}

/** The `kind: "feedback"` half: a source-reference parameter, resolved like any name. */
function sourceReferenceDependency(
  node: GraphNode,
  nodeId: NodeId,
  byName: ReadonlyMap<string, NodeId>,
): ParameterDependency[] {
  const found: ParameterDependency[] = [];
  for (const spec of sourceReferencesOf(node.type)) {
    const kind: ParameterDependencyKind =
      node.type === "feedback"
        ? "feedback"
        : spec.input === "camera"
          ? "camera"
          : spec.input === "lights"
            ? "light"
            : spec.input === "projectors"
              ? "projector"
            : spec.input === "material"
              ? "material"
              : "scene";
    for (const name of sourceReferenceTokens(spec, node.parameters)) {
      const to = byName.get(name);
      if (to === undefined) continue;
      found.push({ from: nodeId, parameterKey: spec.parameter, kind, address: name, to });
    }
  }
  return found;
}

/** The name each kind of address resolves against — the one place the two differ. */
const targetNameOf = (kind: ParameterDependencyKind, address: string): string =>
  kind === "driven" ? channelTargetName(address) : address;

/**
 * Every parameter dependency in the document, keyed by the node that carries it.
 *
 * A dependency whose name resolves to nothing is DROPPED, and that is deliberate in both
 * directions: `op('ghost')` cannot close a cycle and cannot be drawn as a line to
 * anywhere, and it is already reported where it belongs — on the parameter, at resolution.
 * Refusing to write it, or drawing it into empty space, would both be worse than saying so
 * in the one place the user is looking at the parameter.
 */
export function parameterDependencies(graph: GraphDocument): Map<NodeId, ParameterDependency[]> {
  const byName = nodeNames(graph);
  const found = new Map<NodeId, ParameterDependency[]>();

  for (const nodeId of Object.keys(graph.nodes).sort()) {
    const node = graph.nodes[nodeId];
    if (node === undefined) continue;
    const outgoing: ParameterDependency[] = [];
    for (const { parameterKey, kind, address } of bindingTargets(node.parameters)) {
      const to = byName.get(targetNameOf(kind, address));
      if (to === undefined) continue;
      outgoing.push({ from: nodeId, parameterKey, kind, address, to });
    }
    outgoing.push(...sourceReferenceDependency(node, nodeId, byName));
    if (outgoing.length > 0) found.set(nodeId, outgoing);
  }

  return found;
}

/** Just one node's dependencies — what a gate scoped to a single node needs. */
export function dependenciesFrom(graph: GraphDocument, node: GraphNode, nodeId: NodeId): ParameterDependency[] {
  const byName = nodeNames(graph);
  const outgoing: ParameterDependency[] = [];
  outgoing.push(...sourceReferenceDependency(node, nodeId, byName));
  for (const { parameterKey, kind, address } of bindingTargets(node.parameters)) {
    const to = byName.get(targetNameOf(kind, address));
    if (to === undefined) continue;
    outgoing.push({ from: nodeId, parameterKey, kind, address, to });
  }
  return outgoing;
}
