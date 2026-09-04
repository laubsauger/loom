import type { LoomBus } from "@domain/commands/bus.ts";
import type { CommandHolder } from "@domain/commands/command-holder.ts";
import { commandHolder } from "@domain/commands/command-holder.ts";
import type { CommandStatus, InvocationContext } from "@domain/types/commands.ts";
import type { NodeId } from "@domain/types/ids.ts";

/**
 * "A node the USER just added becomes the selection" — as one command and one rule.
 *
 * ## Why a command and not a line at each add site
 *
 * There is no `node.create`: a node is added by a `{ op: "addNode" }` inside
 * `graph.applyPatch`, and eight gestures build one — the library's click and its
 * drag-drop, a wire dragged off a port and released, the node browser, the canvas menu's
 * "Add node here", paste, duplicate, and placing a component instance. Writing the
 * follow-up eight times is eight chances for the ninth to forget, and a feature that
 * selects from the library but not from paste is worse than no feature: it is
 * unpredictable. So the ADD sites say "these ids were created" and exactly one thing
 * knows what selecting means (§V78) — the mounted canvas, which fills the holder below.
 *
 * ## Selection is per-canvas view state (§V101)
 *
 * The document models no selection, and two canvases can be open on one document (§V97),
 * so this cannot be a patch and cannot live in `src/domain/commands` — there is nothing
 * for `ctx.apply` to write and no undo entry to make. Same shape and same reasoning as
 * `graph.selectAll` (`src/app/selection-commands.ts`), which is its sibling: the surface
 * that can actually perform it registers it while it is mounted.
 *
 * ## What it deliberately does NOT do
 *
 * It writes no patch, so it writes no `ui.z`. That distinction is load-bearing since
 * T1102: React Flow elevates the SELECTED node, so a freshly added node does come to the
 * front visually — but `ui.z` is the persisted, explicit stacking order and only
 * `node.bringToFront` writes it. Creation must not silently commit a stacking change to
 * the document, or `]` would be a no-op on a new node and every saved file would grow a
 * `ui.z` entry nobody asked for.
 */

declare module "@domain/types/commands.ts" {
  interface CommandMap {
    /**
     * Replace the canvas selection with these nodes. Reports what it selected — which is
     * not necessarily what was asked for, since a canvas showing a component's internals
     * does not hold the root document's ids (§V123's rule: report what happened).
     */
    "graph.selectNodes": { input: { nodeIds: NodeId[] }; output: { nodeIds: NodeId[] } };
  }
}

export const SELECT_NODES_COMMAND = "graph.selectNodes";

export interface SelectNodesHandlers {
  /**
   * REPLACES the selection, never adds to it. Every editor a user has met behaves this
   * way, and the alternative silently grows a selection that the next `delete` acts on.
   *
   * Called with the ids that were created, which may be several: one paste or one
   * duplicate of nine nodes selects all nine, because the copy is the thing the user now
   * wants to move, and selecting one of nine arbitrarily would be a guess they cannot see.
   */
  select(nodeIds: readonly NodeId[]): void;
  /** The ids this canvas is actually showing, so the report is honest (§V123). */
  nodeIds(): readonly NodeId[];
}

export type SelectNodesHolder = CommandHolder<SelectNodesHandlers>;

export function selectNodesHolderFor(bus: LoomBus): SelectNodesHolder {
  return commandHolder<SelectNodesHandlers>(bus, SELECT_NODES_COMMAND);
}

export function registerSelectNodesCommand(bus: LoomBus): SelectNodesHolder {
  const holder = selectNodesHolderFor(bus);

  if (!bus.hasCommand(SELECT_NODES_COMMAND)) {
    bus.registerCommand({
      name: SELECT_NODES_COMMAND,
      description: "Replace the canvas selection with the named nodes.",
      handler: (input, context) => {
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
        // Sorted for the same reason `graph.selectAll` sorts: React Flow's order is a
        // render detail and a selection has none, so the reported set is stable.
        const nodeIds = [...new Set(input.nodeIds)].sort();
        if (nodeIds.length === 0) {
          return {
            status: "rejected",
            revision: context.store.getRevision(),
            diagnostics: [
              {
                severity: "info",
                code: "selection.empty",
                message: "No nodes were named to select.",
              },
            ],
            output: { nodeIds: [] },
          };
        }
        if (!context.dryRun) holder.current.select(nodeIds);
        return { status: "applied", revision: context.store.getRevision(), output: { nodeIds } };
      },
      rejectionOutput: () => ({ nodeIds: [] }),
    });
  }

  return holder;
}

/**
 * The whole rule, in one place: what a command RESULT has to look like for its nodes to
 * become the selection.
 *
 * Three exclusions, and each one is structural rather than a name on a list:
 *
 *  - **An agent must not steal the selection.** The bus sees an agent's `add_node` exactly
 *    as it sees a person's drag, so "the user added a node" is a fact about the ACTOR and
 *    nothing else. Hijacking the selection of the person at the keyboard, mid-gesture,
 *    from another actor is the harm `viewportControl` was invented for (§V38,
 *    `domain/types/commands.ts`) — it costs the document nothing and costs them control of
 *    their screen. Agents reach node creation through `agent/tools/mutate.ts`, which does
 *    not call this; the check is here anyway so that a future adapter routing an agent
 *    command through a human door cannot quietly acquire the behaviour.
 *  - **Undo and redo are not "the user added a node"**, even when undoing a delete puts
 *    nodes back. They answer `HistoryCommandOutput`, which carries no `createdIds` at all —
 *    the store restores recorded entities rather than replaying an `addNode` — so they are
 *    excluded by the shape of their answer, not by a name this function would have to
 *    remember.
 *  - **Opening a project or an example creates no nodes either.** `project.open` builds a
 *    whole new runtime around the parsed document instead of patching (there is
 *    deliberately no `graph.replaceDocument`), so it too reports no `createdIds`.
 *
 * `createdIds` also carries GROUP ids minted by `addGroup`, so the ids are filtered
 * against the document's nodes — which also drops a node the same patch created and then
 * removed.
 */
export async function selectCreatedNodes(
  bus: LoomBus,
  invocation: InvocationContext,
  result: { status: CommandStatus; output: unknown } | null,
): Promise<void> {
  if (result === null || result.status !== "applied") return;
  if (invocation.actor.kind !== "human") return;
  const output = result.output as { createdIds?: Record<string, string> } | null | undefined;
  const createdIds = output?.createdIds;
  if (createdIds === undefined) return;

  const nodes = bus.store.getGraph().nodes;
  const created = Object.values(createdIds).filter(
    (id): id is NodeId => nodes[id as NodeId] !== undefined,
  );
  if (created.length === 0) return;

  // No mounted canvas has registered it — a headless bus, a test tree without a canvas,
  // the MCP server. `execute` THROWS on an unknown command, and this runs inside a
  // `.then` on every dispatched hotkey, so the miss would surface as an unhandled
  // rejection with nothing to do with the command the user actually ran.
  if (!bus.hasCommand(SELECT_NODES_COMMAND)) return;
  await bus.execute(SELECT_NODES_COMMAND, { nodeIds: created }, invocation);
}
