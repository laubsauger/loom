import type { AppCommandBus, CommandResult, InvocationContext } from "@domain/types/commands.ts";
import type { GraphPatch } from "@domain/types/patch.ts";
import type { NodeId, Revision } from "@domain/types/ids.ts";

/**
 * Committing an edited shader back into the document.
 *
 * A shader edit is a graph mutation like any other, so it goes through the command bus
 * as a `setShaderSource` operation and never touches the store directly (§V29). The
 * operation writes the node's `source` string parameter — the convention track B fixed
 * as `SHADER_SOURCE_PARAMETER` in `src/domain/commands/apply-patch.ts` — so this module
 * does not need to know the parameter name, only the operation.
 *
 * One patch is one undo group (§V34), which is why the editor commits on the same quiet
 * window it compiles on rather than per keystroke: a burst of typing becomes one
 * undoable edit, not forty.
 */

export const SHADER_EDIT_LABEL = "Edit shader";

export function shaderSourcePatch(
  nodeId: NodeId,
  source: string,
  baseRevision: Revision,
  label: string = SHADER_EDIT_LABEL,
): GraphPatch {
  return {
    baseRevision,
    operations: [{ op: "setShaderSource", nodeId, source }],
    label,
  };
}

export interface CommitShaderSourceOptions {
  readonly bus: AppCommandBus;
  readonly context: InvocationContext;
  readonly nodeId: NodeId;
  readonly source: string;
  /**
   * Revision the edit was made against. A stale value comes back as `"conflict"` rather
   * than silently rebasing (§V33) — the caller re-reads and retries.
   */
  readonly baseRevision: Revision;
  readonly label?: string;
}

export function commitShaderSource(
  options: CommitShaderSourceOptions,
): Promise<CommandResult<"graph.applyPatch">> {
  const patch = shaderSourcePatch(
    options.nodeId,
    options.source,
    options.baseRevision,
    options.label ?? SHADER_EDIT_LABEL,
  );
  return options.bus.execute("graph.applyPatch", patch, options.context);
}
