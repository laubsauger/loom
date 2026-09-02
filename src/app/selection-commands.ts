import type { LoomBus } from "@domain/commands/bus.ts";
import type { NodeId } from "@domain/types/ids.ts";
import { commandHolder } from "@domain/commands/command-holder.ts";

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
 *
 * ## Why the canvas registers this on MORE THAN ONE bus (T969(b))
 *
 * There is one canvas and its selection is not document state — but inside a component
 * there are two BUSES. `useComponentEditing` hands the canvas and the inspector a session
 * bus over the component's internals, while the keymap, the palette and the menubar keep
 * dispatching on the root bus, because that is where the transport, the project commands
 * and everything else that keeps running lives. So `mod+a` inside `holo1` reached a root
 * bus whose holder the canvas had just vacated, and the command answered
 * `selection.noCanvas` — a rejection with an `info` severity that no surface shows, which
 * is indistinguishable from a dead key. The canvas therefore fills the holder on EVERY bus
 * that can reach it, and reports the ids it is actually holding.
 */
declare module "@domain/types/commands.ts" {
  interface CommandMap {
    /** Select every node in the document. Reports what it selected. */
    "graph.selectAll": { input: Record<string, never>; output: { nodeIds: NodeId[] } };
  }
}

export interface SelectionHandlers {
  /**
   * What the canvas is CURRENTLY SHOWING — the authority on what a select-all covers.
   *
   * T969(b): this used to be `Object.keys(context.graph.nodes)`, and that is the wrong
   * graph the moment the user walks inside a component. Diving in swaps which document the
   * canvas edits (`useComponentEditing`) while `context.graph` stays the ROOT document, so
   * a select-all inside `holo1` asked for the parent's node ids — names React Flow does not
   * hold — and nothing on screen moved. Same reasoning as `view.frameAll`'s `home()`
   * counting the nodes React Flow ACTUALLY holds rather than the ids it was handed (§V123).
   */
  nodeIds(): readonly NodeId[];
  selectAll(nodeIds: readonly NodeId[]): void;
}

export interface SelectionHolder {
  current: SelectionHandlers | null;
}

export function selectionHolderFor(bus: LoomBus): SelectionHolder {
  return commandHolder<SelectionHandlers>(bus, "graph.selectAll");
}

export function registerSelectionCommands(bus: LoomBus): SelectionHolder {
  const holder = selectionHolderFor(bus);

  if (!bus.hasCommand("graph.selectAll")) {
    bus.registerCommand({
      name: "graph.selectAll",
      description: "Select every node in the graph.",
      handler: (_input, context) => {
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
        // Sorted, so the reported set is stable for an agent reading it back; React Flow's
        // own order is a render detail and selection has no order.
        const nodeIds = [...holder.current.nodeIds()].sort();
        if (!context.dryRun) holder.current.selectAll(nodeIds);
        return { status: "applied", revision: context.store.getRevision(), output: { nodeIds } };
      },
      rejectionOutput: () => ({ nodeIds: [] }),
    });
  }

  return holder;
}
