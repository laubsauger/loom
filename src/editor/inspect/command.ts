import type { ShaderloomBus } from "@domain/commands/bus.ts";
import type { NodeId } from "@domain/types/ids.ts";

/**
 * `ui.showNodeInfo` — the ONE command every route to the node info popup names
 * (T145, §V52, §V78, §V85).
 *
 * TouchDesigner opens this with the middle mouse button. We support that, a keymap
 * binding and a context-menu item — and all three must open the same surface, which is
 * only structurally true if all three name the same command. So the popup is not opened
 * by a handler anywhere; it is opened by executing this command, and the mouse gesture is
 * just another caller.
 *
 * It lives here rather than in `src/domain/commands` for the same reason
 * `graph.selectAll` lives in `src/app`: there is nothing for `ctx.apply` to write.
 * Popup visibility is not document state, produces no patch and makes no undo entry —
 * §V16 in fact forbids it from reaching the document at all, since what the popup shows
 * is per-frame telemetry. The command validates its target against the document and then
 * asks the mounted surface to show it.
 *
 * Registration is idempotent and dispatches through a mutable holder: the bus has no
 * unregister, and React mounts more than once (StrictMode, remounts, tests).
 */
declare module "@domain/types/commands.ts" {
  interface CommandMap {
    /**
     * Open the node info popup for one node. `nodeId` omitted means "whatever the
     * surface considers the current target" — the hovered node under the cursor, else
     * the selection — which is what a bare keypress means.
     */
    "ui.showNodeInfo": {
      input: { nodeId?: NodeId };
      output: { nodeId: NodeId | null; shown: boolean };
    };
  }
}

/** The command name. Menus and keymap entries reference THIS, never a literal. */
export const SHOW_NODE_INFO_COMMAND = "ui.showNodeInfo";

/** Where the popup should appear, in client coordinates. Absent = anchor to the node. */
export interface NodeInfoAnchor {
  readonly x: number;
  readonly y: number;
}

export interface NodeInfoHandlers {
  /**
   * Shows the popup. Returns false when the surface declined — no resolvable target,
   * which is a normal outcome for a bare keypress with nothing hovered or selected.
   */
  show(nodeId: NodeId | undefined, anchor: NodeInfoAnchor | undefined): NodeId | null;
}

export interface NodeInfoHolder {
  current: NodeInfoHandlers | null;
}

const holders = new WeakMap<object, NodeInfoHolder>();

export function nodeInfoHolderFor(bus: ShaderloomBus): NodeInfoHolder {
  const existing = holders.get(bus);
  if (existing !== undefined) return existing;
  const holder: NodeInfoHolder = { current: null };
  holders.set(bus, holder);
  return holder;
}

export function registerNodeInfoCommand(bus: ShaderloomBus): NodeInfoHolder {
  const holder = nodeInfoHolderFor(bus);
  if (bus.hasCommand(SHOW_NODE_INFO_COMMAND)) return holder;

  bus.registerCommand({
    name: SHOW_NODE_INFO_COMMAND,
    description: "Show node info — resolution, format, GPU time, pass count.",
    handler: (input, context) => {
      const revision = context.store.getRevision();
      const requested = input.nodeId;

      if (holder.current === null) {
        return {
          status: "rejected",
          revision,
          diagnostics: [
            {
              severity: "info",
              code: "inspect.noSurface",
              message: "No node info surface is mounted to show the popup.",
            },
          ],
          output: { nodeId: null, shown: false },
        };
      }

      if (requested !== undefined && context.graph.nodes[requested] === undefined) {
        return {
          status: "rejected",
          revision,
          diagnostics: [
            {
              severity: "warning",
              code: "inspect.unknownNode",
              message: `No node "${requested}" in the graph.`,
              nodeId: requested,
            },
          ],
          output: { nodeId: null, shown: false },
        };
      }

      // §V36: a dry run validates and reports without opening anything.
      if (context.dryRun) {
        return { status: "applied", revision, output: { nodeId: requested ?? null, shown: false } };
      }

      const shown = holder.current.show(requested, undefined);
      return {
        status: shown === null ? "rejected" : "applied",
        revision,
        output: { nodeId: shown, shown: shown !== null },
        ...(shown === null
          ? {
              diagnostics: [
                {
                  severity: "info" as const,
                  code: "inspect.noTarget",
                  message: "Nothing is hovered or selected, so there is no node to describe.",
                },
              ],
            }
          : {}),
      };
    },
    rejectionOutput: () => ({ nodeId: null, shown: false }),
  });

  return holder;
}
