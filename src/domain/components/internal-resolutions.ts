import type { GraphNode, NodeResolutionOverride } from "../types/graph.ts";
import { nodeResolutionOverrideSchema } from "../types/schemas.ts";

/** Component namespace contract: authored IDs contain no slash. */
export const COMPONENT_ID_SEPARATOR = "/";
export function flattenedNodeId(prefix: string, nodeId: string): string {
  return prefix === "" ? nodeId : `${prefix}${COMPONENT_ID_SEPARATOR}${nodeId}`;
}
export const INTERNAL_RESOLUTIONS_KEY = "componentResolutionOverrides";

/** Relative to the owning instance, so copying/renaming the instance never rewrites keys. */
export function internalResolutions(node: GraphNode): Readonly<Record<string, NodeResolutionOverride>> {
  const raw = node.state?.[INTERNAL_RESOLUTIONS_KEY];
  if (raw === undefined) return {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Invalid component resolution overrides");
  const result: Record<string, NodeResolutionOverride> = {};
  for (const [path, resolution] of Object.entries(raw)) {
    if (path.split(COMPONENT_ID_SEPARATOR).some(part => part.length === 0)) throw new Error("Invalid internal resolution path");
    result[path] = nodeResolutionOverrideSchema.parse(resolution) as NodeResolutionOverride;
  }
  return result;
}
