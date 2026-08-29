import type { ShaderloomBus } from "@domain/commands/bus.ts";
import type { NodeId } from "@domain/types/ids.ts";

/**
 * Selection as a bus command (§V29, §V52).
 *
 * `mod+a` names `graph.selectAll` like every other hotkey, so it runs from the keyboard,
 * the palette, a menu or an agent through one path. It lives here rather than in
 * `src/domain/commands` because selection is NOT document state — the graph document
 * models neither selection nor hover — so there is nothing for `ctx.apply` to write and
 * no undo entry to make. The owner of the state registers the command, exactly as the
 * palette registers `ui.openCommandPalette`.
 *
 * Registration is idempotent and dispatches through a mutable holder: the bus has no
 * unregister, and React mounts more than once (StrictMode, remounts, tests).
 */
declare module "@domain/types/commands.ts" {
  interface CommandMap {
    /** Select every node in the document. Reports what it selected. */
    "graph.selectAll": { input: Record<string, never>; output: { nodeIds: NodeId[] } };
  }
}

export interface SelectionHandlers {
  selectAll(nodeIds: readonly NodeId[]): void;
}

export interface SelectionHolder {
  current: SelectionHandlers | null;
}

const holders = new WeakMap<object, SelectionHolder>();

export function selectionHolderFor(bus: ShaderloomBus): SelectionHolder {
  const existing = holders.get(bus);
  if (existing !== undefined) return existing;
  const holder: SelectionHolder = { current: null };
  holders.set(bus, holder);
  return holder;
}

export function registerSelectionCommands(bus: ShaderloomBus): SelectionHolder {
  const holder = selectionHolderFor(bus);

  if (!bus.hasCommand("graph.selectAll")) {
    bus.registerCommand({
      name: "graph.selectAll",
      description: "Select every node in the graph.",
      handler: (_input, context) => {
        const nodeIds = Object.keys(context.graph.nodes).sort();
        if (holder.current === null) {
          return {
            status: "rejected",
            revision: context.store.getRevision(),
            diagnostics: [
              {
                severity: "info",
                code: "selection.noCanvas",
                message: "No graph canvas is mounted to receive a selection.",
              },
            ],
            output: { nodeIds: [] },
          };
        }
        if (!context.dryRun) holder.current.selectAll(nodeIds);
        return { status: "applied", revision: context.store.getRevision(), output: { nodeIds } };
      },
      rejectionOutput: () => ({ nodeIds: [] }),
    });
  }

  return holder;
}
