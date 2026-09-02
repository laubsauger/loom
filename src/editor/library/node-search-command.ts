import type { LoomBus } from "@domain/commands/bus.ts";
import { commandHolder } from "@domain/commands/command-holder.ts";

/**
 * `ui.openNodeSearch` — the ONE command every route to the node browser names
 * (T709, §V52, §V78, §V307).
 *
 * TouchDesigner opens its OP Create dialog on a network double-click and ComfyUI does the
 * same, so the gesture is expected and we had no binding for it. The node library pane and
 * the right-click "Add node" submenu already existed: this was a missing ENTRY POINT, not
 * a missing feature. So the double-click does not open anything itself — it executes this
 * command, exactly as the `tab` binding and the canvas menu's "Search nodes…" row do, and
 * all three land on one surface because all three name one command.
 *
 * The command was already DATA before it was code: `defaults.ts` has bound it to `tab`
 * and `schemas.ts` has listed it on the canvas menu since T524, both rendering as
 * "unavailable" because nothing had registered it. Promoting it is therefore a deletion
 * from `PLANNED_COMMANDS` plus this registration — the menu row and the keybinding go
 * live on their own, and the palette flips the entry from unavailable to runnable.
 *
 * POSITION IS IN GRAPH COORDINATES, and it is the whole point of the row. A browser that
 * opens somewhere other than the cursor, or drops its node at a default spot, is a worse
 * outcome than no gesture at all — the user then has to find the node and move it. The
 * caller projects the cursor once (`screenToFlowPosition`) and this input carries the
 * result; the surface projects it back for anchoring. One source of truth, so "opens at
 * the cursor" and "places at the cursor" cannot disagree.
 *
 * Omitted position means "the caller had no cursor" — a bare `tab` press — and the
 * surface picks the viewport centre. It is not an error.
 *
 * Lives here rather than in `src/domain/commands` for the same reason `ui.showNodeInfo`
 * does: there is nothing for `ctx.apply` to write. Opening a browser is not document
 * state and makes no undo entry. The node it later creates is a separate
 * `graph.applyPatch`, which is the one that undoes.
 *
 * Registration is idempotent and dispatches through a mutable holder: the bus has no
 * unregister, and React mounts more than once (StrictMode, remounts, tests).
 */
declare module "@domain/types/commands.ts" {
  interface CommandMap {
    /**
     * Open the node browser. `position` is in GRAPH coordinates and is both where the
     * browser appears and where the node it creates lands; omitted means the caller had
     * no cursor, and the surface chooses the viewport centre.
     */
    "ui.openNodeSearch": {
      input: { position?: { x: number; y: number } };
      output: { opened: boolean; position: { x: number; y: number } | null };
    };
  }
}

/** The command name. Menus, the keymap and the gesture reference THIS, never a literal. */
export const OPEN_NODE_SEARCH_COMMAND = "ui.openNodeSearch";

/** Where the browser opens and where its node lands, in GRAPH coordinates. */
export interface NodeSearchPosition {
  readonly x: number;
  readonly y: number;
}

export interface NodeSearchHandlers {
  /**
   * Opens the browser. Returns the position it settled on — the one passed in, or the
   * surface's own viewport centre when the caller had none — so the command can report
   * WHERE it opened rather than merely that it did.
   */
  open(position: NodeSearchPosition | undefined): NodeSearchPosition | null;
}

export interface NodeSearchHolder {
  current: NodeSearchHandlers | null;
}

/**
 * PAGE-GLOBAL, not module-local — and this is the whole of T709's second report.
 *
 * A module-level `WeakMap` here made the browser die on any HMR update to this file:
 * re-executing the module minted a second map and a second, empty holder, while the
 * handler already on the bus kept reading the first. The surface wrote itself into the new
 * one, the command read `null` from the old one, and refused — silently, all three doors
 * at once, until a hard reload. Measured in Chromium against a real dev server: open
 * before the update, dead after it, empty console. `command-holder.ts` carries the
 * mechanism and §V483's precedent.
 */
export function nodeSearchHolderFor(bus: LoomBus): NodeSearchHolder {
  return commandHolder<NodeSearchHandlers>(bus, OPEN_NODE_SEARCH_COMMAND);
}

export function registerNodeSearchCommand(bus: LoomBus): NodeSearchHolder {
  const holder = nodeSearchHolderFor(bus);
  if (bus.hasCommand(OPEN_NODE_SEARCH_COMMAND)) return holder;

  bus.registerCommand({
    name: OPEN_NODE_SEARCH_COMMAND,
    description: "Search the node catalogue and add one at the cursor.",
    handler: (input, context) => {
      const revision = context.store.getRevision();

      if (holder.current === null) {
        return {
          status: "rejected",
          revision,
          diagnostics: [
            {
              severity: "info",
              code: "library.noSurface",
              message: "No graph canvas is mounted to open the node browser on.",
            },
          ],
          output: { opened: false, position: null },
        };
      }

      /*
       * §V66 — a pane that has not been laid out yet has zoom 0, and `screenToFlowPosition`
       * then returns NaN. A NaN here would reach `addNode` as the node's position and be
       * written to the document, where it survives a save and breaks the load. Refusing is
       * the honest outcome: the caller's cursor genuinely did not project.
       */
      const requested = input.position;
      if (
        requested !== undefined &&
        !(Number.isFinite(requested.x) && Number.isFinite(requested.y))
      ) {
        return {
          status: "rejected",
          revision,
          diagnostics: [
            {
              severity: "warning",
              code: "library.badPosition",
              message: "The cursor did not project into graph coordinates.",
            },
          ],
          output: { opened: false, position: null },
        };
      }

      // §V36: a dry run validates and reports without opening anything.
      if (context.dryRun) {
        return { status: "applied", revision, output: { opened: false, position: null } };
      }

      const opened = holder.current.open(requested);
      return {
        status: opened === null ? "rejected" : "applied",
        revision,
        output: { opened: opened !== null, position: opened },
        ...(opened === null
          ? {
              diagnostics: [
                {
                  severity: "info" as const,
                  code: "library.notOpened",
                  message: "The graph canvas declined to open the node browser.",
                },
              ],
            }
          : {}),
      };
    },
    rejectionOutput: () => ({ opened: false, position: null }),
  });

  return holder;
}
