import type { ComponentPath, GraphComponentDefinition } from "../types/components.ts";
import type { GraphNode } from "../types/graph.ts";
import type { NodeId } from "../types/ids.ts";
import type { StoredParameter } from "../types/parameters.ts";
import { formatComponentPath } from "../types/components.ts";
import { internalParameterPath, readComponentInstance } from "./instance.ts";

/**
 * What the flattening compiler needs from this track (§V82, T134 is theirs).
 *
 * A component compiles by being flattened into the parent logical graph. Two things have
 * to survive that: the instance's published values, which are the reason the instance
 * looks different from its neighbours, and the SOURCE PATH, which is the reason a
 * diagnostic reads `Main / DreamyFeedback_2 / Blur_1 / shader.wgsl:42` rather than naming
 * an internal node id the user has never seen.
 */

/**
 * The internal parameter values an instance's published page implies (§V80).
 *
 * Keyed by `internalParameterPath(nodeId, key)`. One published value fans out to every
 * target it drives — the "Blur" knob writing three radii — which is exactly the same
 * mapping `publishedParameterOperations` produces when the component itself is edited;
 * this is the read-only form of it, for an instance whose internals are not in the
 * document at all.
 *
 * T1017: a page entry is a `StoredParameter`, not a `ParameterValue` — it may be the
 * instance's own EXPRESSION or DRIVEN slot, handed over unresolved so the internal
 * parameter it lands on re-resolves it per frame like any other animated parameter. The
 * caller (`compiler/flatten.ts`) decides which entries stay slots; this function only
 * carries whatever it is given to every target the knob drives.
 */
export function internalParameterValues(
  definition: GraphComponentDefinition,
  publishedValues: Readonly<Record<string, StoredParameter>>,
): Record<string, StoredParameter> {
  const values: Record<string, StoredParameter> = {};
  for (const published of definition.parameters) {
    const value = publishedValues[published.key];
    if (value === undefined) continue;
    for (const target of published.targets) {
      values[internalParameterPath(target.nodeId, target.key)] = value;
    }
  }
  return values;
}

/**
 * Everything to write onto the flattened internal nodes of one instance.
 *
 * Published values first, then the instance's own `overrides` — the escape hatch for the
 * case publishing did not anticipate, which by definition has to win over the general
 * mechanism it is escaping.
 */
export function effectiveInternalOverrides(
  definition: GraphComponentDefinition,
  instance: GraphNode,
  publishedValues: Readonly<Record<string, StoredParameter>>,
): Record<string, StoredParameter> {
  const state = readComponentInstance(instance);
  return {
    ...internalParameterValues(definition, publishedValues),
    ...(state?.overrides ?? {}),
  };
}

/**
 * The user-facing path of an internal node, for a diagnostic or a timing row (§V82).
 *
 * `names` maps instance node ids to their display names, which `componentPathNames`
 * builds from a resolved path.
 */
export function componentSourcePath(
  path: ComponentPath,
  names: Readonly<Record<NodeId, string>>,
  leaf: string,
): string {
  return `${formatComponentPath(path, names)} / ${leaf}`;
}
