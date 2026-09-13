import type { LoomBus } from "@domain/commands/bus.ts";
import { commandHolder } from "@domain/commands/command-holder.ts";
import { FLY_AXES, isFlyAxis } from "@editor/viewer/orbit-gestures.ts";
import type { FlyAxis } from "@editor/viewer/orbit-gestures.ts";

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
    /** T380: return the viewer's inspection camera to the baked framing. */
    "viewer.cameraHome": { input: Record<string, never>; output: { framed: boolean } };
    /** T379/T380: frame the viewer's camera on the MEASURED content bounds. */
    "viewer.frameContent": { input: Record<string, never>; output: { framed: boolean } };
    /**
     * §T1311b(b): move the viewer's inspection camera ONE STEP in a direction, in the
     * camera's own frame. `w`/`a`/`s`/`d`/`e`/`q` name this through the keymap and the
     * pane integrates a HELD key into continuous motion; a single invocation — from the
     * palette, from an agent, from a keyboard whose auto-repeat never arrives — is one
     * step of the same arithmetic (`flyStepFor`), never a second formula.
     *
     * View-only, like everything else the viewer's camera touches: it reaches a uniform
     * on a pass nothing downstream reads, and there is no path from it to the document.
     */
    "viewer.fly": { input: { direction: string }; output: { moved: boolean } };
  }
}

export interface ViewerHandlers {
  /**
   * Pins the viewer to a node's output. Returns the port it pinned, or null when this
   * node produces no output the current plan can show — an uncompiled graph, a node with
   * no texture output, a node downstream of a compile error.
   */
  show(nodeId: string): string | null;
  /** T380: home the inspection camera. False = nothing orbitable is selected. */
  cameraHome(): boolean;
  /** T379: frame the camera on measured content. Resolves false when there is nothing
   *  to measure (not orbitable, no backend, no position buffer). */
  frameContent(): Promise<boolean>;
  /** §T1311b(b): one fly step. False = nothing with a camera is on screen to fly. */
  fly(direction: FlyAxis): boolean;
}

export interface ViewerHolder {
  current: ViewerHandlers | null;
}

export function viewerHolderFor(bus: LoomBus): ViewerHolder {
  return commandHolder<ViewerHandlers>(bus, "node.openViewer");
}

const NO_OUTPUT = { nodeId: null, portId: null };

/**
 * §V349 — ONE sentence for "this output has no camera", written once and read by both the
 * command's refusal and the pane's disabled control. The alternative is a tooltip that
 * says one thing and a diagnostic that says another about the same fact, which is how a
 * user learns to trust neither.
 *
 * A `customWgsl` output has its OWN sentence for this, and it is not a variant of this one:
 * `viewCameraAbsentReason()` explains the opt-in a shader author can act on. The pane picks
 * between them; neither invents a third.
 */
export const VIEWER_NO_CAMERA_MESSAGE = "The viewer is not showing an orbitable 3D preview.";
export const VIEWER_NO_CAMERA_SUGGESTION =
  "Select a geometry, points or material preview in the viewer first.";

/**
 * Registration is idempotent and dispatches through the holder: the bus has no
 * unregister, and React mounts more than once (StrictMode, remounts, tests).
 */
export function registerViewerCommands(bus: LoomBus): ViewerHolder {
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

  /* T380 — the camera binds go THROUGH the keymap (§V78/§V307: rebindable, visible in
     the shortcut editor), which needs real commands. The orbit STORE still holds no bus
     (§V527); these handlers reach INTO it from the pane, never the reverse. */
  const cameraRefusal = (revision: number) => ({
    status: "rejected" as const,
    revision,
    diagnostics: [
      {
        severity: "info" as const,
        code: "viewer.noOrbit",
        message: VIEWER_NO_CAMERA_MESSAGE,
        suggestion: VIEWER_NO_CAMERA_SUGGESTION,
      },
    ],
    output: { framed: false },
  });
  bus.registerCommand({
    name: "viewer.cameraHome",
    description: "Return the viewer's inspection camera to its baked framing.",
    handler: (_input, context) => {
      const revision = context.store.getRevision();
      if (holder.current === null) return cameraRefusal(revision);
      if (context.dryRun) return { status: "validated", revision, output: { framed: false } };
      const framed = holder.current.cameraHome();
      return framed
        ? { status: "applied", revision, output: { framed } }
        : cameraRefusal(revision);
    },
    rejectionOutput: () => ({ framed: false }),
  });
  bus.registerCommand({
    name: "viewer.frameContent",
    description: "Frame the viewer's inspection camera on the content's measured bounds.",
    handler: async (_input, context) => {
      const revision = context.store.getRevision();
      if (holder.current === null) return cameraRefusal(revision);
      if (context.dryRun) return { status: "validated", revision, output: { framed: false } };
      const framed = await holder.current.frameContent();
      return framed
        ? { status: "applied", revision, output: { framed } }
        : cameraRefusal(revision);
    },
    rejectionOutput: () => ({ framed: false }),
  });

  /*
   * §T1311b(b) — FLY. A separate command from the two above because it is a separate
   * INTERACTION: `cameraHome` and `frameContent` put the camera somewhere the graph
   * chose, and this one moves it somewhere the user chose, through a scene the orbit
   * cannot leave (§V-orbit: distance clamps to [0.2, 5]×, so no orbit value ever puts
   * the eye past its own target).
   *
   * It takes a NAMED direction and refuses an unnamed one rather than picking a default
   * (§V986): "fly" with no direction is not a movement anybody measured.
   */
  const flyRefusal = (revision: number, diagnostic: { code: string; message: string; suggestion: string }) => ({
    status: "rejected" as const,
    revision,
    diagnostics: [{ severity: "info" as const, ...diagnostic }],
    output: { moved: false },
  });
  bus.registerCommand({
    name: "viewer.fly",
    description: "Move the viewer's inspection camera one step in a direction.",
    handler: (input, context) => {
      const revision = context.store.getRevision();
      if (!isFlyAxis(input.direction)) {
        return flyRefusal(revision, {
          code: "viewer.flyDirection",
          message: `"${String(input.direction)}" is not a direction the viewer camera can fly.`,
          suggestion: `Name one of ${FLY_AXES.join(", ")}.`,
        });
      }
      if (holder.current === null) {
        return flyRefusal(revision, {
          code: "viewer.noOrbit",
          message: VIEWER_NO_CAMERA_MESSAGE,
          suggestion: VIEWER_NO_CAMERA_SUGGESTION,
        });
      }
      if (context.dryRun) return { status: "validated", revision, output: { moved: false } };
      const moved = holder.current.fly(input.direction);
      return moved
        ? { status: "applied", revision, output: { moved } }
        : flyRefusal(revision, {
            code: "viewer.noOrbit",
            message: VIEWER_NO_CAMERA_MESSAGE,
            suggestion: VIEWER_NO_CAMERA_SUGGESTION,
          });
    },
    rejectionOutput: () => ({ moved: false }),
  });

  return holder;
}
