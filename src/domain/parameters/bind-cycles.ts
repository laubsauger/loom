import type { RuntimeDiagnostic } from "../types/diagnostics.ts";
import type { GraphNode } from "../types/graph.ts";
import type { ParameterSchema } from "../types/parameters.ts";
import { componentNamesFor, isParameterSlot, parseComponentKey } from "./slots.ts";

/**
 * Authoring-time bind-cycle detection (T205, §V110).
 *
 * A bind chain that loops (`a` binds `b`, `b` binds `a`) must be a diagnostic AT THE
 * MOMENT IT IS WRITTEN — never a per-frame hang, and never a mystery discovered by the
 * resolver's runtime backstop. The patch gate calls this after a `setParameters` lands
 * on the draft and refuses the patch when a cycle appears, so the document can simply
 * never hold one; the resolver's visited-set guard stays as defence in depth for
 * documents from elsewhere.
 *
 * The dependency graph has three kinds of edges, all same-node (`parent.*` refs cannot
 * cycle: a parent's published values are fully resolved before its internals are, so
 * the chain is a DAG by construction — §V81):
 *
 *  1. an ACTIVE bind (`slot.mode === "bind"`): key → ref. Inactive bind payloads are
 *     retained data (§V108), not dependencies; activating one is itself a patch, which
 *     re-runs this check.
 *  2. compound assembly (§V113): resolving `color` reads every stored `color.*`
 *     component slot, so `color` → `color.r`.
 *  3. component extraction: a ref to `color.r` resolves the whole of `color` first,
 *     so `color.r` → `color`.
 */

/** Every same-node dependency edge the resolver would follow, as `from → to` pairs. */
function bindEdges(node: GraphNode, schema: ParameterSchema): Map<string, Set<string>> {
  const edges = new Map<string, Set<string>>();
  const add = (from: string, to: string): void => {
    const existing = edges.get(from);
    if (existing === undefined) edges.set(from, new Set([to]));
    else existing.add(to);
  };

  for (const [key, stored] of Object.entries(node.parameters)) {
    if (!isParameterSlot(stored)) continue;
    if (stored.mode !== "bind") continue;
    const binding = stored.bindings.bind;
    if (binding?.kind !== "bind") continue;
    const ref = binding.ref;
    if (ref.startsWith("parent.")) continue;
    add(key, ref);
    // A ref to a component resolves its whole compound first.
    const parsed = parseComponentKey(ref);
    if (parsed !== null && schema[parsed.base] !== undefined) add(ref, parsed.base);
  }

  // Compound assembly reads every stored component slot.
  for (const [base, definition] of Object.entries(schema)) {
    const names = componentNamesFor(definition);
    if (names === null) continue;
    for (const name of names) {
      const component = `${base}.${name}`;
      if (node.parameters[component] !== undefined) add(base, component);
    }
  }

  return edges;
}

/**
 * Every distinct bind cycle on `node`, as error diagnostics naming the full loop.
 * Empty when the parameters are acyclic — the only state a patch may leave behind.
 */
export function bindCycleDiagnostics(node: GraphNode, schema: ParameterSchema): RuntimeDiagnostic[] {
  const edges = bindEdges(node, schema);
  const diagnostics: RuntimeDiagnostic[] = [];
  const settled = new Set<string>();

  for (const start of [...edges.keys()].sort()) {
    if (settled.has(start)) continue;
    const stack: string[] = [];
    const onStack = new Set<string>();

    const visit = (key: string): void => {
      if (settled.has(key)) return;
      if (onStack.has(key)) {
        const loop = [...stack.slice(stack.indexOf(key)), key];
        diagnostics.push({
          severity: "error",
          code: "parameter.bindCycle",
          message: `Bind chain is circular: ${loop.join(" → ")}.`,
          nodeId: node.id,
          suggestion: "Break the loop: one of these binds must become a static value or an expression (§V110).",
        });
        return;
      }
      stack.push(key);
      onStack.add(key);
      for (const next of [...(edges.get(key) ?? [])].sort()) visit(next);
      stack.pop();
      onStack.delete(key);
      settled.add(key);
    };

    visit(start);
  }

  return diagnostics;
}
