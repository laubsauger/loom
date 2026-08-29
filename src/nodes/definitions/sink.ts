import type { NodeDefinition } from "../../domain/types/node-definition.ts";

/**
 * §V25: the compiler evaluates only nodes reachable backward from an ACTIVE SINK; the
 * rest are pruned. A sink is declared here explicitly, via `tags` — never inferred from
 * "has no outputs", because an unconnected filter node also has no consumers and that is
 * exactly the case that must still get pruned.
 *
 * `NodeDefinition` has no first-class `sink` field. This track does not own
 * `src/domain/types/node-definition.ts` (track B does), so `tags` — the existing free-form
 * metadata array — is the closest available explicit extension point. If the compiler
 * track wants a dedicated boolean field instead, that is a one-line addition to the
 * contract plus a one-line change to `isSinkNode` below; every call site stays the same.
 */
export const SINK_TAG = "sink";

/** The compiler's (and anyone else's) way to ask "is this an active sink?" (§V25). */
/** Reads the first-class field first; the tag remains a legacy fallback. */
export function isSinkNode(definition: NodeDefinition): boolean {
  return definition.tags?.includes(SINK_TAG) ?? false;
}
