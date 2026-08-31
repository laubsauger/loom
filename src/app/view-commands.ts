import type { ShaderloomBus } from "@domain/commands/bus.ts";
import { commandHolder } from "@domain/commands/command-holder.ts";

/**
 * `view.frameAll` / `view.frameSelected` — TouchDesigner's `F` and `f` (T430, §V354).
 *
 * Both were bound in `defaults.ts` from T77 and sat in `PLANNED_COMMANDS`, so the palette
 * called them unavailable and the two keys did nothing. §V354 is why that stopped being
 * honest: the canvas whose camera they move is the largest thing on the screen. A key
 * that does nothing while the surface it acts on is right there reads as a broken app
 * rather than an unbuilt feature.
 *
 * Framing is view state, not document state, so — like `graph.selectAll` and
 * `node.openViewer` — the command lives beside its surface with nothing for `ctx.apply`
 * to write, and the canvas fills a holder while it is mounted. A camera move must not
 * make an undo entry: §V34 groups an EDIT, and Cmd+Z after a glance has to undo the edit
 * before it, not the glance.
 *
 * ## `H` is OURS, and says so
 *
 * `view.home` is "back to a known SCALE": 1:1 zoom, centred on the content. That is this
 * app's definition, chosen rather than transcribed — §I read it from TouchDesigner as
 * "default view", which could equally have meant fit-all, and fit-all would have made `H`
 * a duplicate of `F`. Stating it as ours is the point: a binding table that presents a
 * guess as a transcription is the thing nobody can later correct with confidence.
 *
 * It is deliberately the one thing `fitView` cannot give you. Fit chooses whatever zoom
 * makes the content fill the window, so at a glance you cannot tell a small graph from a
 * large one; 1:1 is the scale at which node sizes mean something again.
 *
 * `view.homeSelected` (`h`) and `view.overview` (`o`) are UNBOUND, not implemented here.
 * "Home selected" is meaningless beside a `H` that is about scale rather than extent, and
 * TD's overview is a separate PANE this app does not have, so there is no meaning to
 * transcribe. Un-teaching a key that was given a wrong meaning costs far more than an
 * absent binding (§V354's reasoning, applied the other way round).
 */
declare module "@domain/types/commands.ts" {
  interface CommandMap {
    /** Fit every node in the graph. Reports how many it framed. */
    "view.frameAll": { input: Record<string, never>; output: { framed: number } };
    /** Fit the given nodes. Reports how many of them the canvas actually holds. */
    "view.frameSelected": { input: { nodeIds: readonly string[] }; output: { framed: number } };
    /** Back to 1:1 zoom, centred on the content. Reports how many nodes it centred on. */
    "view.home": { input: Record<string, never>; output: { framed: number } };
  }
}

export interface ViewHandlers {
  /**
   * Frames `nodeIds`, or the whole graph when null. Returns how many nodes were framed —
   * NOT how many were asked for, so a stale id reports honestly rather than claiming a
   * move that did not happen (§V123).
   */
  frame(nodeIds: readonly string[] | null): number;
  /** 1:1 zoom centred on the content. Returns the number of nodes it centred on. */
  home(): number;
}

export interface ViewHolder {
  current: ViewHandlers | null;
}

export function viewHolderFor(bus: ShaderloomBus): ViewHolder {
  return commandHolder<ViewHandlers>(bus, "view.frameAll");
}

const NO_CANVAS = {
  severity: "warning" as const,
  code: "view.noCanvas",
  message: "No graph canvas is mounted, so there is no camera to move.",
};

/** Idempotent: the bus has no unregister, and React mounts more than once. */
export function registerViewCommands(bus: ShaderloomBus): ViewHolder {
  const holder = viewHolderFor(bus);
  if (bus.hasCommand("view.frameAll")) return holder;

  bus.registerCommand({
    name: "view.frameAll",
    description: "Fit every node in the graph into the view.",
    handler: (_input, context) => {
      const revision = context.store.getRevision();
      if (holder.current === null) {
        return { status: "rejected", revision, diagnostics: [NO_CANVAS], output: { framed: 0 } };
      }
      if (context.dryRun) return { status: "validated", revision, output: { framed: 0 } };
      const framed = holder.current.frame(null);
      if (framed === 0) {
        // §V288: an empty canvas is a real answer, and a silent no-op looks like a dead
        // key — which is the whole reason this command now exists.
        return {
          status: "rejected",
          revision,
          diagnostics: [
            {
              severity: "info" as const,
              code: "view.nothingToFrame",
              message: "The graph is empty, so there is nothing to frame.",
            },
          ],
          output: { framed: 0 },
        };
      }
      return { status: "applied", revision, output: { framed } };
    },
    rejectionOutput: () => ({ framed: 0 }),
  });

  bus.registerCommand({
    name: "view.frameSelected",
    description: "Fit the selected nodes into the view.",
    handler: (input, context) => {
      const revision = context.store.getRevision();
      if (holder.current === null) {
        return { status: "rejected", revision, diagnostics: [NO_CANVAS], output: { framed: 0 } };
      }
      if (context.dryRun) return { status: "validated", revision, output: { framed: 0 } };
      const framed = holder.current.frame(input.nodeIds);
      if (framed === 0) {
        return {
          status: "rejected",
          revision,
          diagnostics: [
            {
              severity: "warning" as const,
              code: "view.nothingToFrame",
              message:
                input.nodeIds.length === 0
                  ? "Nothing is selected, so there is nothing to frame."
                  : `The canvas holds none of ${[...input.nodeIds].sort().join(", ")}.`,
            },
          ],
          output: { framed: 0 },
        };
      }
      return { status: "applied", revision, output: { framed } };
    },
    rejectionOutput: () => ({ framed: 0 }),
  });

  bus.registerCommand({
    name: "view.home",
    description: "Return the view to 1:1 zoom, centred on the graph.",
    handler: (_input, context) => {
      const revision = context.store.getRevision();
      if (holder.current === null) {
        return { status: "rejected", revision, diagnostics: [NO_CANVAS], output: { framed: 0 } };
      }
      if (context.dryRun) return { status: "validated", revision, output: { framed: 0 } };
      const framed = holder.current.home();
      if (framed === 0) {
        return {
          status: "rejected",
          revision,
          diagnostics: [
            {
              severity: "info" as const,
              code: "view.nothingToFrame",
              message: "The graph is empty, so there is nothing to centre on.",
            },
          ],
          output: { framed: 0 },
        };
      }
      return { status: "applied", revision, output: { framed } };
    },
    rejectionOutput: () => ({ framed: 0 }),
  });

  return holder;
}
