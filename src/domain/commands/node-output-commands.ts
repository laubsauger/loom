import type { NodeFormatOverride, NodeResolutionOverride } from "../types/graph.ts";
import type { RuntimeDiagnostic } from "../types/diagnostics.ts";
import type { NodeId, Revision } from "../types/ids.ts";
import type { GraphPatchResult } from "../types/patch.ts";
import type { LoomBus } from "./bus.ts";
import { COMPONENT_ID_SEPARATOR, INTERNAL_RESOLUTIONS_KEY, internalResolutions } from "../components/internal-resolutions.ts";
import { isComponentInstance } from "../components/instance.ts";
import { nodeResolutionOverrideSchema } from "../types/schemas.ts";
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
    handler: (input, context) => {
      if (!context.graph.nodes[input.nodeId] && bus.flattenedGraph()?.nodes[input.nodeId]) {
        const separator = input.nodeId.indexOf(COMPONENT_ID_SEPARATOR);
        const ownerId = input.nodeId.slice(0, separator);
        const relativeId = input.nodeId.slice(separator + 1);
        const owner = context.graph.nodes[ownerId];
        if (separator > 0 && owner && isComponentInstance(owner)) {
          const parsed = input.resolution === null ? null : nodeResolutionOverrideSchema.safeParse(input.resolution);
          if (parsed && !parsed.success) {
            const diagnostics: RuntimeDiagnostic[] = [{ severity: "error", code: "node.resolution.invalid", nodeId: input.nodeId,
              message: "Invalid internal node resolution override." }];
            return { status: "rejected" as const, revision: context.graph.revision, diagnostics,
              output: rejection(input, diagnostics, context.graph.revision) };
          }
          const overrides = { ...internalResolutions(owner) };
          if (parsed === null) delete overrides[relativeId];
          else if (parsed.success && input.resolution !== null) overrides[relativeId] = input.resolution;
          const applied = context.apply({ label: "Set internal node resolution", recipe: draft => {
            const node = draft.nodes[ownerId]!;
            node.state = { ...node.state, [INTERNAL_RESOLUTIONS_KEY]: overrides };
          } });
          return { status: context.dryRun ? "validated" as const : "applied" as const, revision: applied.revision, diagnostics: [],
            ...(applied.undoGroupId === undefined ? {} : { undoGroupId: applied.undoGroupId }),
            output: { status: context.dryRun ? "validated" as const : "applied" as const, revision: applied.revision,
              appliedOperations: context.dryRun ? 0 : 1, diagnostics: [], createdIds: {} } };
        }
      }
      return applyGraphPatch(
        {
          baseRevision: context.graph.revision,
          label: input.resolution === null ? "Clear resolution" : "Set resolution",
          operations: [{ op: "setNodeResolution", nodeId: input.nodeId, resolution: input.resolution }],
        },
        context,
      );
    },
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
