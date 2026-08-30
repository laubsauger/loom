import type { ShaderloomBus } from "@domain/commands/bus.ts";
import type { NodeId } from "@domain/types/ids.ts";

/**
 * `ui.beginRename` — the ONE way the inline name editor opens (T415, B60, §V307, §V342).
 *
 * ## The bug this exists for
 *
 * `node.rename` was registered on the bus, bound to `n` in the default keymap, and listed
 * in the node context menu as "Rename…" — an ellipsis promising a prompt. Every one of
 * those is a real, working, tested part. And no `.tsx` file in the tree referenced the
 * command, because nothing anywhere COLLECTED A NAME: the keystroke fired with `nodeIds`
 * and no `label`, and the menu item fired with `nodeId` and no `label`. A user could not
 * rename a node at all.
 *
 * §V342 is the general form: registration proves nothing about invocability. A command
 * that takes an argument the user must supply is only as reachable as the SURFACE that
 * supplies it, and until that surface exists the command is furniture.
 *
 * ## Why a second command rather than a second rename
 *
 * `node.rename` stays exactly as it is — one rename implementation, one patch, one undo
 * group, one place where §V128's reference rewrite happens (§V61, §V29). What was missing
 * was not a mutation, it was an OPENING. So `n` and the menu item name this command, which
 * opens the editor on a node's title; the editor is what eventually executes `node.rename`
 * with the label the user typed.
 *
 * §V307's shape, and for §V307's reason: the keystroke, the menu row and an agent asking
 * to put a node's name in edit mode are three doors onto one route.
 *
 * Like `ui.toggleReferenceLines`, it lives beside its surface rather than in
 * `src/domain/commands`: there is nothing for `ctx.apply` to write. WHICH node's title is
 * currently an input box is not document state — it produces no patch, opens no undo group
 * and reaches no `.loom.json`.
 */
declare module "@domain/types/commands.ts" {
  interface CommandMap {
    /**
     * Put a node's title into edit mode in place. `nodeIds` so the keymap's
     * `inputFrom: { from: "selection", as: "nodeIds" }` resolves against it unchanged;
     * renaming is single-target, so the FIRST id is the subject and the binding's
     * `when: hasSingleSelection` is what keeps that from being a silent choice.
     */
    "ui.beginRename": {
      input: { nodeIds: readonly NodeId[] };
      output: { editing: NodeId | null };
    };
  }
}

export const BEGIN_RENAME_COMMAND = "ui.beginRename";

export interface RenameSessionStore {
  /** The node whose title is being edited, or `null`. At most one, ever. */
  get(): NodeId | null;
  begin(nodeId: NodeId): void;
  /** Ends the session, but only if `nodeId` still owns it — a stale blur closes nothing. */
  end(nodeId: NodeId): void;
  subscribe(listener: () => void): () => void;
}

export function createRenameSessionStore(): RenameSessionStore {
  let editing: NodeId | null = null;
  const listeners = new Set<() => void>();
  const notify = (): void => {
    for (const listener of [...listeners]) listener();
  };
  return {
    get: () => editing,
    begin: (nodeId) => {
      if (editing === nodeId) return;
      editing = nodeId;
      notify();
    },
    end: (nodeId) => {
      // Guarded on ownership: the editor's own blur handler fires while a NEW session is
      // already opening (click node A's title while editing node B), and an unguarded end
      // would close the one that just opened.
      if (editing !== nodeId) return;
      editing = null;
      notify();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/**
 * One store per bus — the bus is the per-document identity, so two canvases showing the
 * same document (the floated graph pane, §V97) agree about which title is being edited
 * instead of opening two editors on one node.
 */
const stores = new WeakMap<object, RenameSessionStore>();

export function renameSessionStoreFor(bus: ShaderloomBus): RenameSessionStore {
  const existing = stores.get(bus);
  if (existing !== undefined) return existing;
  const store = createRenameSessionStore();
  stores.set(bus, store);
  return store;
}

/**
 * Idempotent, like every other editor-side registration: the bus has no unregister, and
 * React mounts more than once (StrictMode, remounts, tests).
 */
export function registerRenameSessionCommand(bus: ShaderloomBus): RenameSessionStore {
  const store = renameSessionStoreFor(bus);
  if (bus.hasCommand(BEGIN_RENAME_COMMAND)) return store;

  bus.registerCommand({
    name: BEGIN_RENAME_COMMAND,
    description: "Edit a node's name in place, on its title (§V29, T415).",
    handler: (input, context) => {
      const revision = context.store.getRevision();
      const nodeId = input.nodeIds[0];
      if (nodeId === undefined) {
        return {
          status: "rejected" as const,
          revision,
          diagnostics: [
            {
              severity: "info" as const,
              code: "rename.noTarget",
              message: "Select a node to rename it.",
            },
          ],
          output: { editing: store.get() },
        };
      }
      // Named, not silent: renaming a node that is not in the document would otherwise
      // open an editor on nothing at all (§V288).
      if (context.store.getGraph().nodes[nodeId] === undefined) {
        return {
          status: "rejected" as const,
          revision,
          diagnostics: [
            {
              severity: "warning" as const,
              code: "rename.unknownNode",
              message: `There is no node "${nodeId}" to rename.`,
            },
          ],
          output: { editing: store.get() },
        };
      }
      // §V36 — a dry run answers what WOULD happen and opens nothing.
      if (context.dryRun) {
        return { status: "validated" as const, revision, output: { editing: nodeId } };
      }
      store.begin(nodeId);
      return { status: "applied" as const, revision, output: { editing: nodeId } };
    },
    rejectionOutput: () => ({ editing: store.get() }),
  });

  return store;
}
