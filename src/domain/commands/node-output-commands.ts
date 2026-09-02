import type { NodeFormatOverride, NodeResolutionOverride } from "../types/graph.ts";
import type { RuntimeDiagnostic } from "../types/diagnostics.ts";
import type { NodeId, Revision } from "../types/ids.ts";
import type { GraphPatchResult } from "../types/patch.ts";
import type { LoomBus } from "./bus.ts";
import { applyGraphPatch } from "./apply-patch.ts";

/**
 * Per-node output overrides — TouchDesigner's "Common" page (§V50, §V51).
 *
 * These are thin wrappers over `graph.applyPatch`, deliberately: the patch path already
 * carries atomicity, audit, undo grouping and dryRun, so a second mutation route would
 * be a second place for those to be forgotten (§V29, §V32).
 */
declare module "../types/commands.ts" {
  interface CommandMap {
    /** Set or clear (`null`) a node's output resolution override (§V50). */
    "node.setResolution": {
      input: { nodeId: NodeId; resolution: NodeResolutionOverride | null };
      output: GraphPatchResult;
    };
    /** Set or clear (`null`) a node's output pixel format override (§V51). */
    "node.setFormat": {
      input: { nodeId: NodeId; format: NodeFormatOverride | null };
      output: GraphPatchResult;
    };
  }
}

const rejection = (
  _input: unknown,
  diagnostics: RuntimeDiagnostic[],
  revision: Revision,
): GraphPatchResult => ({
  status: "rejected",
  revision,
  appliedOperations: 0,
  diagnostics,
  createdIds: {},
});

export function registerNodeOutputCommands(bus: LoomBus): void {
  bus.registerCommand({
    name: "node.setResolution",
    description: "Set or clear a node's output resolution override (§V50).",
    handler: (input, context) =>
      applyGraphPatch(
        {
          baseRevision: context.graph.revision,
          label: input.resolution === null ? "Clear resolution" : "Set resolution",
          operations: [{ op: "setNodeResolution", nodeId: input.nodeId, resolution: input.resolution }],
        },
        context,
      ),
    rejectionOutput: rejection,
  });

  bus.registerCommand({
    name: "node.setFormat",
    description: "Set or clear a node's output pixel format override (§V51).",
    handler: (input, context) =>
      applyGraphPatch(
        {
          baseRevision: context.graph.revision,
          label: input.format === null ? "Clear format" : "Set format",
          operations: [{ op: "setNodeFormat", nodeId: input.nodeId, format: input.format }],
        },
        context,
      ),
    rejectionOutput: rejection,
  });
}
