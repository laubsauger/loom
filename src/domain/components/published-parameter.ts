import type {
  ExposedPort,
  GraphComponentDefinition,
  PublishedParameter,
} from "../types/components.ts";
import type { NodeId, PortId } from "../types/ids.ts";
import type { ParameterValue } from "../types/parameters.ts";
import type { GraphPatchOperation } from "../types/patch.ts";
import { defaultParameterValue } from "../parameters/validate.ts";

/**
 * Publishing (T131, T132) — the component's parameter page and its boundary ports.
 *
 * Every function here returns a NEW definition rather than mutating one. Definitions are
 * shared by every linked instance (§V79); mutating one in place would change what an
 * instance resolves against with nothing observing that it happened, and the registry's
 * synthesized-manifest cache is keyed on definition identity precisely so a re-authored
 * definition is a different object.
 */

/**
 * The operations one published-parameter edit turns into (§V80).
 *
 * A published knob may drive several internal parameters — one "Blur" driving three
 * radii — and they must land as ONE patch: §V32 makes all of them apply or none, §V34
 * makes the whole thing one undo group. Three separate commands would be three undo
 * steps, and undoing once would leave the component in a state the user never authored.
 *
 * Targets on the same internal node are merged into one `setParameters`, so a knob
 * driving two parameters of one node writes that node once.
 */
export function publishedParameterOperations(
  published: PublishedParameter,
  value: ParameterValue,
): GraphPatchOperation[] {
  const byNode = new Map<NodeId, Record<string, ParameterValue>>();
  // Sorted so the operation list is identical whoever built it (§V40).
  const targets = [...published.targets].sort(
    (a, b) => a.nodeId.localeCompare(b.nodeId) || a.key.localeCompare(b.key),
  );
  for (const target of targets) {
    const existing = byNode.get(target.nodeId);
    if (existing === undefined) byNode.set(target.nodeId, { [target.key]: value });
    else existing[target.key] = value;
  }
  return [...byNode.entries()].map(([nodeId, parameters]) => ({
    op: "setParameters",
    nodeId,
    parameters,
  }));
}

/** Default values for a component's whole parameter page — what a fresh instance gets. */
export function defaultPublishedValues(
  definition: GraphComponentDefinition,
): Record<string, ParameterValue> {
  const values: Record<string, ParameterValue> = {};
  for (const published of definition.parameters) {
    values[published.key] = defaultParameterValue(published.definition);
  }
  return values;
}

export function findPublishedParameter(
  definition: GraphComponentDefinition,
  key: string,
): PublishedParameter | undefined {
  return definition.parameters.find((published) => published.key === key);
}

/**
 * Adds or REPLACES a published parameter, KEEPING ITS PLACE ON THE PAGE.
 *
 * Replacement is re-authoring: the label, range and unit of the published control are
 * chosen for the component's user, not inherited from whichever internal parameter it
 * happens to drive (§V80). Editing the published definition is the normal case, not an
 * error to guard against.
 *
 * Position is part of the authored result, not an artefact of when the edit happened
 * (T423). Filtering and appending — what this did before there was an editor — meant
 * that renaming the label of the first knob dropped it to the bottom of the page, so a
 * component's public interface reshuffled itself every time its author touched it. A new
 * key still appends: there is no other honest place for it.
 */
export function publishParameter(
  definition: GraphComponentDefinition,
  published: PublishedParameter,
): GraphComponentDefinition {
  const at = definition.parameters.findIndex((each) => each.key === published.key);
  const parameters = [...definition.parameters];
  if (at === -1) parameters.push(published);
  else parameters[at] = published;
  return { ...definition, parameters };
}

/**
 * Moves a published parameter to `toIndex` — the ORDER half of the parameter page (T423).
 *
 * A component's parameter page is its public interface, and the order controls appear in
 * is the part of it the author reads first. It cannot be derived: alphabetical would put
 * "Amount" above "Blur" whatever the component does, and insertion order records only
 * the sequence in which somebody happened to publish. So it is authored, and stored as
 * the order of `definition.parameters` — the same argument `StopsField` makes for a
 * gradient's stops.
 *
 * Out-of-range indices CLAMP rather than refuse: "move the first one up" is a gesture a
 * user makes constantly and a refusal for it would be noise, not information.
 */
export function reorderPublishedParameter(
  definition: GraphComponentDefinition,
  key: string,
  toIndex: number,
): GraphComponentDefinition {
  const from = definition.parameters.findIndex((each) => each.key === key);
  if (from === -1) return definition;
  const parameters = [...definition.parameters];
  const [moved] = parameters.splice(from, 1);
  if (moved === undefined) return definition;
  const to = Math.max(0, Math.min(parameters.length, Math.trunc(toIndex)));
  parameters.splice(to, 0, moved);
  return { ...definition, parameters };
}

export function unpublishParameter(
  definition: GraphComponentDefinition,
  key: string,
): GraphComponentDefinition {
  return {
    ...definition,
    parameters: definition.parameters.filter((published) => published.key !== key),
  };
}

/**
 * Adds or re-authors a boundary port, KEEPING ITS PLACE in the port list.
 *
 * Same argument as `publishParameter` (T423): the order of `inputs`/`outputs` is the
 * order the ports are drawn on every instance of the component, so re-labelling the top
 * input must not slide it to the bottom of the node while wires are attached to it.
 */
export function exposePort(
  definition: GraphComponentDefinition,
  direction: "input" | "output",
  port: ExposedPort,
): GraphComponentDefinition {
  const replace = (ports: ExposedPort[]): ExposedPort[] => {
    const at = ports.findIndex((each) => each.externalId === port.externalId);
    if (at === -1) return [...ports, port];
    const next = [...ports];
    next[at] = port;
    return next;
  };
  return direction === "input"
    ? { ...definition, inputs: replace(definition.inputs) }
    : { ...definition, outputs: replace(definition.outputs) };
}

export function unexposePort(
  definition: GraphComponentDefinition,
  direction: "input" | "output",
  externalId: PortId,
): GraphComponentDefinition {
  const without = (ports: ExposedPort[]): ExposedPort[] =>
    ports.filter((each) => each.externalId !== externalId);
  return direction === "input"
    ? { ...definition, inputs: without(definition.inputs) }
    : { ...definition, outputs: without(definition.outputs) };
}
