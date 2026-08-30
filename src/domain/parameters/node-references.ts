import { nodeByName } from "../graph/names.ts";
import type { NodeReferenceReader, NodeReferenceResult } from "../expressions/index.ts";
import type { GraphDocument, GraphNode } from "../types/graph.ts";
import type { NodeId } from "../types/ids.ts";
import type { ParameterSchema, ParameterValue } from "../types/parameters.ts";
import { resolveParameterSchema, type ResolveParametersOptions } from "./resolve.ts";

/**
 * Reading `op('noise1').par.gain` — the cross-node value path (T316, §V148, §V127).
 *
 * The reference has been storable, validatable and rename-rewritable since T221: the
 * grammar parses it, `names.ts` rewrites it when the target is renamed, and liveness
 * counts it as a dependency (§V154). What it could not do was RESOLVE, so "copy
 * reference → paste → evaluate" — §V148's round trip — held only for the same-node case,
 * which becomes a bind. A cross-node paste stored correctly and then failed.
 *
 * ## One reader, both sides
 *
 * The seam is `ResolveParametersOptions.nodes`, and the reason it is there rather than in
 * the inspector is B8. When the compiler and the inspector each had their own idea of
 * what a parameter was worth, the inspector showed the corrected value and the GPU
 * rendered the other one. A reader supplied by only one of them recreates exactly that,
 * inverted: the plan would carry the referenced value and the panel would show the
 * fallback. So the compiler builds one from the graph it is compiling, the inspector
 * builds one from the graph it is showing, and both go through this function.
 *
 * ## Why resolution recurses, and why that needs a guard
 *
 * `op('a').par.x` is worth whatever `a.x` RESOLVES to, and `a.x` may itself be an
 * expression reading `op('b').par.y`. So a read is a resolve, and a chain of references
 * is a chain of resolves. Which means it can close a loop.
 *
 * §V152 wants that rejected at authoring time with the path named, and since T331 it is:
 * `referenceCyclesThrough` refuses the patch that closes the loop, and
 * `referenceCycleDiagnostics` reports one that arrived from a file. This guard is the
 * last line rather than the only one — §V244's point being that a runtime mitigation must
 * not become the reason the gate never gets built. It stays because a `.loom.json` can
 * still be hand-edited, and it names the loop rather than reporting a stack overflow,
 * because a user who typed the cycle needs to be told which two nodes they joined.
 *
 * The visited set is keyed by NODE, and the gate is keyed the same way on purpose: a read
 * resolves the target's whole schema, so `a.x → b.y` plus `b.z → a.w` really does recurse
 * even though the two parameter chains never touch. Making either half finer without the
 * other would accept documents the other refuses.
 */

/** A path this reader understands. `par` is the only namespace v1 exposes. */
const PARAMETER_NAMESPACE = "par";

export interface NodeReferenceOptions {
  readonly graph: GraphDocument;
  /**
   * The parameter schema for a node, which is the definition's manifest — passed as a
   * lookup rather than a registry so a component's PUBLISHED schema (§V80), which exists
   * before any node manifest does, resolves through the same reader.
   */
  readonly schemaOf: (node: GraphNode) => ParameterSchema | undefined;
  /**
   * Everything else the referenced parameter needs to resolve — the frame, the channel
   * resolver. Carried through unchanged so a referenced expression reading `time` reads
   * the SAME time as the expression referencing it. Two frames in one evaluation is a
   * value that is right on its own and wrong in context.
   */
  readonly base?: Omit<ResolveParametersOptions, "nodes" | "schema">;
}

/**
 * A number, or a reason it is not one.
 *
 * Only numeric parameters are readable, and that is §V71's rule rather than a limitation
 * of this function: an expression evaluates to a number, so a reference inside one has to
 * be a number too. A colour or a curve reports what it is instead of being coerced into
 * whatever its first channel happens to hold.
 */
function asNumber(value: ParameterValue | undefined, reference: string): NodeReferenceResult {
  if (typeof value === "number") return { ok: true, value };
  if (typeof value === "boolean") return { ok: true, value: value ? 1 : 0 };
  if (value === undefined) return { ok: false, reason: `${reference} has no value` };
  return {
    ok: false,
    reason: `${reference} is ${Array.isArray(value) ? "a list" : typeof value}, and an expression reads a number`,
  };
}

export function createNodeReferenceReader(options: NodeReferenceOptions): NodeReferenceReader {
  return readerWithin(options, new Set());
}

/**
 * `visited` carries the chain of nodes already being resolved on THIS path.
 *
 * Per-path, not per-reader: two unrelated parameters both reading `op('gain1').par.value`
 * are not a cycle, and a reader that shared one visited set across a whole compile would
 * call the second one a loop. The set grows only as the recursion descends.
 */
function readerWithin(
  options: NodeReferenceOptions,
  visited: ReadonlySet<NodeId>,
): NodeReferenceReader {
  return (name, path): NodeReferenceResult => {
    const reference = `op('${name}').${path.join(".")}`;

    const [namespace, key, ...rest] = path;
    if (namespace !== PARAMETER_NAMESPACE) {
      return {
        ok: false,
        reason: `${reference}: only .${PARAMETER_NAMESPACE} is readable (op('${name}').${PARAMETER_NAMESPACE}.<parameter>)`,
      };
    }
    if (key === undefined || rest.length > 0) {
      return { ok: false, reason: `${reference}: name one parameter, as op('${name}').par.gain` };
    }

    const targetId = nodeByName(options.graph, name);
    if (targetId === undefined) {
      return { ok: false, reason: `${reference}: there is no node named "${name}"` };
    }
    if (visited.has(targetId)) {
      // §V152. Named, not "maximum call stack exceeded": the user joined two specific
      // nodes and has to be told which.
      return {
        ok: false,
        reason: `${reference}: that reference is a cycle (${[...visited, targetId].join(" → ")})`,
      };
    }
    const target = options.graph.nodes[targetId];
    if (target === undefined) {
      return { ok: false, reason: `${reference}: there is no node named "${name}"` };
    }
    const schema = options.schemaOf(target);
    if (schema === undefined) {
      return { ok: false, reason: `${reference}: "${name}" has an unknown node type` };
    }
    if (!(key in schema)) {
      return { ok: false, reason: `${reference}: "${name}" has no parameter "${key}"` };
    }

    // The recursive step. The target resolves with the same frame and channels, and with
    // a reader that remembers we came through here — so a loop is caught one hop before
    // it would repeat rather than however many frames later the stack gives out.
    const resolved = resolveParameterSchema(target, schema, {
      ...options.base,
      nodes: readerWithin(options, new Set([...visited, targetId])),
    });

    /**
     * The referenced parameter has to have resolved, not merely produced a number.
     *
     * §V108 hands back a fallback whenever a binding fails, so `values[key]` is populated
     * either way — and reading it blindly makes a broken reference look healthy. It is
     * worst for cycles: a loop is caught one hop down, that hop falls back to its default,
     * and the caller reads the default as a perfectly good answer. The cycle is then
     * INVISIBLE at the top of the chain, which is precisely where the person who wrote it
     * is looking.
     *
     * So a diagnostic on the referenced entry propagates. It is the right rule beyond
     * cycles too: referencing a parameter whose own expression is broken should say that,
     * rather than quietly yield the default and read as a working reference to a wrong
     * number.
     */
    const entry = resolved.get(key);
    if (entry?.diagnostic != null) {
      return { ok: false, reason: `${reference}: ${entry.diagnostic.message}` };
    }
    return asNumber(entry?.value, reference);
  };
}
