import { nodeNames } from "@domain/graph/names.ts";
import {
  channelTargetName,
  dependenciesFrom,
  sourceReferenceKind,
} from "@domain/graph/parameter-dependencies.ts";
import { effectiveParameterSchema } from "@domain/parameters/resolve.ts";
import { isComponentKeyOf, parseComponentKey } from "@domain/parameters/slots.ts";
import { sourceReferenceTokens, sourceReferencesOf } from "@domain/graph/source-references.ts";
import type { GraphDocument, GraphNode } from "@domain/types/graph.ts";
import type { NodeDefinition } from "@domain/types/node-definition.ts";
import { REFERENCE_KIND_COLOR } from "@editor/edges/index.ts";
import type { ParameterSourceView, ReferenceParameter } from "@ui/controls/index.ts";

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

/**
 * WHICH NODES each of a node's rows READS — T1336b, the other half of the same tie.
 *
 * §T987 above answers it for a parameter whose VALUE is a node's name. This answers it for
 * a parameter whose BINDING names one: `op('lfo1').chan.value` in an expression, or a
 * `driven` slot addressing a channel. Those two produce the overwhelming majority of the
 * dashed lines on the canvas, and until now the panel named the node behind NONE of them —
 * the name was written once, inside the expression text, behind the mode-panel disclosure.
 * The owner reported the parameter as missing twice over for exactly that reason.
 *
 * ⚑ THE WALK IS `dependenciesFrom`, WHICH IS THE CANVAS'S OWN. `parameterDependencies` is
 * what `graph-canvas.tsx` flattens into lines; `dependenciesFrom` is its single-node form,
 * already exported and already used by the cycle gate. Re-deriving "which node does this
 * expression read" here would be a third opinion on §V154's union, and the §T248 docblock
 * is explicit that a picture disagreeing with the walk is worse than no picture. So the
 * inspector reads the dependencies the canvas draws, and hues them from the table the
 * canvas strokes with.
 *
 * Two things are deliberately left out:
 *
 *  - the SOURCE-REFERENCE kinds (`camera`, `scene`, `feedback`, …). `ReferenceField` names
 *    those on the control itself, in this same hue; naming them a second time under the
 *    field would be two marks for one relationship.
 *  - a name that resolves to NOTHING. `dependenciesFrom` drops it, the canvas draws no
 *    line for it, and so there is no line here to tie a mark to. `op('ghost')` is reported
 *    where it belongs — as the row's diagnostic, at resolution.
 *
 * Keyed by the ROW's parameter key: a binding on `rotate.y` (§V113 — E10's own, and the
 * one the owner was looking at) belongs to the `rotate` row, because that is the row that
 * exists. The component/base split is `isComponentKeyOf`, the schema's own rule, so a
 * parameter whose name merely contains a dot is not silently re-homed onto a row that does
 * not exist.
 */
export function parameterSources(
  graph: GraphDocument,
  registry: ReferenceRegistry,
  node: GraphNode,
): ReadonlyMap<string, readonly ParameterSourceView[]> {
  const rows = new Map<string, ParameterSourceView[]>();
  /*
   * §T903 — a node INSTANCE is in hand, so the schema comes through the funnel. A
   * component's promoted parameters exist only in its effective schema, and reading the
   * DECLARED one here would decide that `blur.radius` is not a component key on exactly
   * the nodes whose keys are assembled at runtime.
   */
  const schema = effectiveParameterSchema(registry.get(node.type), node.parameters);

  for (const dependency of dependenciesFrom(graph, node, node.id)) {
    if (dependency.kind !== "reference" && dependency.kind !== "driven") continue;
    const target = graph.nodes[dependency.to];
    if (target === undefined) continue;

    const parsed = parseComponentKey(dependency.parameterKey);
    const component =
      parsed === null || !isComponentKeyOf(schema, dependency.parameterKey) ? null : parsed;
    const rowKey = component?.base ?? dependency.parameterKey;
    const view: ParameterSourceView = {
      // The canvas's own table, read rather than copied — §T987's tie, on §T986's half of
      // the parameter model.
      color: REFERENCE_KIND_COLOR[dependency.kind],
      // The name AS THE DOCUMENT WROTE IT, which is the label `nodeNames` resolved and the
      // text the user will find in the expression (§B170: never an id). A channel address
      // carries a channel after the colon; only the part before it names the node.
      name:
        dependency.kind === "driven"
          ? channelTargetName(dependency.address)
          : dependency.address,
      type: target.type,
      channel: component?.component ?? null,
      address: dependency.address,
    };

    const existing = rows.get(rowKey);
    if (existing === undefined) {
      rows.set(rowKey, [view]);
      continue;
    }
    // `op('lfo1').chan.a + op('lfo1').chan.b` is ONE relationship read twice, and the
    // canvas collapses it to one line for the same reason (`referenceLinesOf`). Two
    // identical marks under one field would say there are two of something.
    if (
      existing.some(
        (entry) =>
          entry.name === view.name && entry.channel === view.channel && entry.color === view.color,
      )
    ) {
      continue;
    }
    existing.push(view);
  }

  return rows;
}
