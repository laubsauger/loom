import { nodeNames } from "@domain/graph/names.ts";
import { sourceReferenceKind } from "@domain/graph/parameter-dependencies.ts";
import { sourceReferenceTokens, sourceReferencesOf } from "@domain/graph/source-references.ts";
import type { GraphDocument, GraphNode } from "@domain/types/graph.ts";
import type { NodeDefinition } from "@domain/types/node-definition.ts";
import { REFERENCE_KIND_COLOR } from "@editor/edges/index.ts";
import type { ReferenceParameter } from "@ui/controls/index.ts";

/**
 * What the inspector must answer for a parameter that NAMES another node — T987.
 *
 * `ReferenceField` is presentational: it knows how a reference should read, and nothing
 * about the document. This is the other half — which of a node's parameters are
 * references, what each names right now, what it MAY name, and which hue the canvas draws
 * that relationship in.
 *
 * ## Eligibility is the compiler's rule, borrowed rather than re-decided
 *
 * `synthesizeSourceReferenceEdges` accepts a name when the named node's FIRST OUTPUT has
 * the same `type.kind` as the port the reference feeds, and refuses it by name otherwise
 * ("…but `cam1` is a noise and publishes no camera"). The picker offers exactly that set.
 * A looser picker would offer names the compiler then refuses, which is §V109's shape —
 * two halves of the tool disagreeing about what the document may say — and a stricter one
 * would hide legal references. It is stated as `outputs[0].type.kind`, the compiler's own
 * spelling, and NOT as `arePortsCompatible`: the synthesizer does not consult that either,
 * and agreeing with it instead of with the synthesizer would be agreeing with the wrong
 * thing.
 *
 * ## Names, never ids (§B170)
 *
 * Every candidate comes out of `nodeNames`, which is keyed by LABEL — the same map the
 * compiler resolves references through. A node with no label is not offered, because it
 * cannot be referenced: there is nothing to write. Two examples shipped dead because
 * something matched an id where a name was meant, and this list is one more chance at it.
 */

/** All this needs of the node registry. */
export interface ReferenceRegistry {
  get(type: string): NodeDefinition | undefined;
}

/**
 * Every reference parameter of `node`, keyed by parameter key. Empty for the overwhelming
 * majority of node types, which declare no `sourceReferences` at all.
 */
export function referenceParameters(
  graph: GraphDocument,
  registry: ReferenceRegistry,
  node: GraphNode,
): ReadonlyMap<string, ReferenceParameter> {
  const models = new Map<string, ReferenceParameter>();
  const specs = sourceReferencesOf(node.type);
  if (specs.length === 0) return models;

  const definition = registry.get(node.type);
  const named = nodeNames(graph);

  for (const spec of specs) {
    const noun = definition?.inputs.find((port) => port.id === spec.input)?.type.kind;
    // No installed definition, or a spec naming a port the definition does not declare:
    // there is no kind to filter by and no noun to name, so the row keeps the plain text
    // field rather than showing a picker built on a guess.
    if (noun === undefined) continue;

    const candidates: Array<{ name: string; type: string }> = [];
    for (const [name, targetId] of named) {
      if (targetId === node.id) continue;
      const target = graph.nodes[targetId];
      if (target === undefined) continue;
      if (registry.get(target.type)?.outputs[0]?.type.kind !== noun) continue;
      candidates.push({ name, type: target.type });
    }
    candidates.sort((a, b) => a.name.localeCompare(b.name));

    const targets = sourceReferenceTokens(spec, node.parameters).map((name) => {
      const targetId = named.get(name);
      const target = targetId === undefined ? undefined : graph.nodes[targetId];
      return { name, type: target?.type ?? null };
    });

    models.set(spec.parameter, {
      // The canvas's own table (§T248/§T391), read here rather than copied — the swatch
      // beside the parameter and the dashed line it causes are the same colour BY
      // CONSTRUCTION, which is the relation the owner went looking for and did not find.
      color: REFERENCE_KIND_COLOR[sourceReferenceKind(node.type, spec)],
      targets,
      candidates,
      list: spec.list === true,
      noun,
    });
  }

  return models;
}
