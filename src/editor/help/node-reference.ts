import type { NodeDefinition } from "@domain/types/node-definition.ts";
import { friendlyPortLabel, groupByCategory } from "@editor/library/search.ts";

/**
 * The node half of the help panel, DERIVED from the registry's manifests (T200, §V105).
 *
 * A manifest already carries the title, the category, the description, the ports and the
 * parameter schema — the whole reference. Copying any of it into a help document creates
 * a second source that a renamed parameter silently falsifies, so nothing here is typed
 * out: this module reshapes what `NodeRegistryView.list()` returns and adds no facts.
 *
 * Port types are rendered with `friendlyPortLabel`, the same short form the node library
 * uses mid-drag, rather than the diagnostic form (§V57) — a reference page is read to
 * learn what connects to what, not to parse a type signature.
 */

export interface PortReference {
  readonly id: string;
  readonly label: string;
  readonly type: string;
  readonly optional: boolean;
}

export interface ParameterReference {
  readonly key: string;
  readonly label: string;
  readonly type: string;
  readonly unit: string | undefined;
}

export interface NodeReference {
  readonly type: string;
  readonly title: string;
  readonly category: string;
  readonly description: string | undefined;
  readonly inputs: readonly PortReference[];
  readonly outputs: readonly PortReference[];
  readonly parameters: readonly ParameterReference[];
}

export interface NodeReferenceSection {
  readonly category: string;
  readonly nodes: readonly NodeReference[];
}

function portsOf(ports: NodeDefinition["inputs"]): readonly PortReference[] {
  return ports.map((port) => ({
    id: port.id,
    label: port.label,
    type: friendlyPortLabel(port.type),
    optional: port.optional === true,
  }));
}

function parametersOf(definition: NodeDefinition): readonly ParameterReference[] {
  return Object.entries(definition.parameters)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, parameter]) => ({
      key,
      label: parameter.label,
      type: parameter.type,
      // Only a number parameter carries a unit; asking the union for one would be a
      // fact this module invented rather than read.
      unit: parameter.type === "number" ? parameter.unit : undefined,
    }));
}

export function nodeReference(definition: NodeDefinition): NodeReference {
  return {
    type: definition.type,
    title: definition.title,
    category: definition.category,
    description: definition.description,
    inputs: portsOf(definition.inputs),
    outputs: portsOf(definition.outputs),
    parameters: parametersOf(definition),
  };
}

/** Every installed node, grouped the way the registry itself groups them. */
export function nodeReferenceSections(
  definitions: readonly NodeDefinition[],
): readonly NodeReferenceSection[] {
  return groupByCategory([...definitions].sort((a, b) => a.title.localeCompare(b.title))).map(
    (bucket) => ({
      category: bucket.category,
      nodes: bucket.definitions.map(nodeReference),
    }),
  );
}
