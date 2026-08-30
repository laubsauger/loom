import type { ShaderloomBus } from "@domain/commands/bus.ts";

/**
 * `node.openViewer` — point the viewer at a node's output (T440, §V354).
 *
 * TouchDesigner's `v`. The binding has existed since T77 and named a command nobody had
 * registered, which the palette rendered as unavailable and the gate called honest — and
 * §V354 is the correction: "honest-absent" stops being honest once the SURFACE is on
 * screen. The viewer pane is right there, with a selector that does exactly this, so a
 * key that does nothing reads as a broken app rather than an unbuilt feature.
 *
 * It lives here rather than in `src/domain/commands` for the same reason
 * `graph.selectAll` does: which output is on screen is NOT document state — the graph
 * document models no such thing — so there is nothing for `ctx.apply` to write and no
 * undo entry to make. The owner of the state registers the command, through a mutable
 * holder, and the pane fills the holder while it is mounted.
 *
 * ## What it deliberately does NOT do
 *
 * It does not reveal a hidden viewer. Making a docked pane visible is the shell's
 * business (T436 is building exactly that seam), and a command that silently pinned an
 * output behind a collapsed tab would be a §V123 button that lies. When the pane is not
 * mounted the command refuses by name instead.
 */
declare module "@domain/types/commands.ts" {
  interface CommandMap {
    /**
     * Show the first output belonging to one of `nodeIds`. Reports what it pinned, so a
     * caller (and an agent) can tell which node actually reached the screen.
     */
    "node.openViewer": {
      input: { nodeIds: readonly string[] };
      output: { nodeId: string | null; portId: string | null };
    };
  }
}

export interface ViewerHandlers {
  /**
   * Pins the viewer to a node's output. Returns the port it pinned, or null when this
   * node produces no output the current plan can show — an uncompiled graph, a node with
   * no texture output, a node downstream of a compile error.
   */
  show(nodeId: string): string | null;
}

export interface ViewerHolder {
  current: ViewerHandlers | null;
}

const holders = new WeakMap<object, ViewerHolder>();

export function viewerHolderFor(bus: ShaderloomBus): ViewerHolder {
  const existing = holders.get(bus);
  if (existing !== undefined) return existing;
  const holder: ViewerHolder = { current: null };
  holders.set(bus, holder);
  return holder;
}

const NO_OUTPUT = { nodeId: null, portId: null };

/**
 * Registration is idempotent and dispatches through the holder: the bus has no
 * unregister, and React mounts more than once (StrictMode, remounts, tests).
 */
export function registerViewerCommands(bus: ShaderloomBus): ViewerHolder {
  const holder = viewerHolderFor(bus);
  if (bus.hasCommand("node.openViewer")) return holder;

  bus.registerCommand({
    name: "node.openViewer",
    description: "Show a node's output in the viewer.",
    handler: (input, context) => {
      const revision = context.store.getRevision();
      if (holder.current === null) {
        return {
          status: "rejected",
          revision,
          diagnostics: [
            {
              severity: "warning" as const,
              code: "viewer.noPane",
              message: "No viewer is on screen to show a node's output.",
              suggestion: "Open the viewer pane, then try again.",
            },
          ],
          output: NO_OUTPUT,
        };
      }

      const [nodeId] = input.nodeIds;
      if (nodeId === undefined) {
        return {
          status: "rejected",
          revision,
          diagnostics: [
            {
              severity: "info" as const,
              code: "viewer.noNode",
              message: "Select a node to show it in the viewer.",
            },
          ],
          output: NO_OUTPUT,
        };
      }

      if (context.dryRun) return { status: "validated", revision, output: NO_OUTPUT };

      const portId = holder.current.show(nodeId);
      if (portId === null) {
        // §V288: name the node and what is missing, rather than pinning nothing and
        // leaving the user to guess whether the key worked.
        return {
          status: "rejected",
          revision,
          diagnostics: [
            {
              severity: "warning" as const,
              code: "viewer.noOutput",
              message: `${nodeId} produces no output the current plan can show.`,
              suggestion:
                "Only a node with a compiled texture output can be viewed. Check the graph compiles and that this node is not downstream of an error.",
            },
          ],
          output: NO_OUTPUT,
        };
      }

      return { status: "applied", revision, output: { nodeId, portId } };
    },
    rejectionOutput: () => NO_OUTPUT,
  });

  return holder;
}
