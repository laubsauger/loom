import { useEffect } from "react";

import type { LoomBus } from "@domain/commands/bus.ts";
import { sharedForBus } from "@domain/commands/command-holder.ts";

/**
 * Fullscreen the viewer, as a bus command (T394, §V29, §V52, §V78, §V307).
 *
 * §V307: an openable surface is opened by a COMMAND. Filling the screen with the render
 * is the same kind of thing, so it gets the same three doors for the price of one — the
 * viewer's button, the command palette, and a REBINDABLE key that appears in the shortcut
 * editor because it is a row in the default keymap and not an `if (event.key === "f")`
 * inside a component.
 *
 * ## Why the element is published rather than passed
 *
 * Only the viewer knows which element is the picture, and the command has to run from
 * anywhere. So the surface's owner publishes it here — the same shape `transport-commands`
 * uses for the frame loop — and the registration itself is UNCONDITIONAL. §B48 is the
 * lesson being obeyed: `registerTransportCommands` sits inside an effect that returns
 * early with no GPU, so `space` and `.` are dead keys AND dead buttons on a machine with
 * no WebGPU. Nothing here is gated on a backend, a compile or an output; when there is
 * genuinely nothing to fill the screen with, the command REJECTS by name (§V288) instead
 * of quietly not existing.
 *
 * ## Which document
 *
 * `element.ownerDocument`, never the app's `document`. A floated viewer (§V97, T393) lives
 * in a child window, and fullscreening its OWN window is the useful case — a request made
 * against the wrong document targets an element that document does not contain and the
 * browser refuses it.
 */

declare module "@domain/types/commands.ts" {
  interface CommandMap {
    /**
     * Toggle, or force with `fullscreen`. The explicit form exists for the same reason
     * `transport.play` does (T292): a caller that cannot see the current state must not
     * have "make it fullscreen" mean "leave fullscreen". `target` picks WHICH surface
     * fills the screen (T551): the viewer's picture (default, T394's behaviour
     * unchanged), or the whole app shell — the owner's "use the whole screen without
     * the browser bar in the way". Session state on purpose: nothing here persists.
     */
    "view.toggleFullscreen": {
      input: { fullscreen?: boolean; target?: "viewer" | "app" };
      output: { fullscreen: boolean };
    };
  }
}

/** The element that fills the screen. Read at execute time — the viewer's ref moves. */
export type FullscreenSurface = () => HTMLElement | null;

export type FullscreenTarget = "viewer" | "app";

export interface FullscreenHolder {
  /** T394's original slot: the VIEWER surface. Named `current` for its existing callers. */
  current: FullscreenSurface | null;
  /** T551: the app shell publishes itself here. */
  app: FullscreenSurface | null;
}

export function fullscreenHolderFor(bus: LoomBus): FullscreenHolder {
  // `sharedForBus`, not `commandHolder`: this holder has TWO slots (T551 added `app`
  // beside the viewer's `current`), so the `{ current }` wrapper does not describe it.
  return sharedForBus<FullscreenHolder>(bus, "view.toggleFullscreen", () => ({
    current: null,
    app: null,
  }));
}

const NO_SURFACE = (target: FullscreenTarget) => ({
  severity: "info" as const,
  code: "view.noFullscreenSurface",
  message:
    target === "app"
      ? "The app shell has not published a fullscreen surface."
      : "The viewer is not mounted, so there is no surface to fill the screen with.",
});

const UNSUPPORTED = {
  severity: "warning" as const,
  code: "view.fullscreenUnsupported",
  message: "This browser does not offer the Fullscreen API for the viewer's surface.",
};

/**
 * Registers `view.toggleFullscreen` on `bus`, once, unconditionally.
 *
 * Idempotent across mounts (`hasCommand`), because React mounts more than once —
 * StrictMode, remounts, tests.
 */
export function registerFullscreenCommand(bus: LoomBus): FullscreenHolder {
  const holder = fullscreenHolderFor(bus);
  if (bus.hasCommand("view.toggleFullscreen")) return holder;

  bus.registerCommand({
    name: "view.toggleFullscreen",
    description: "Fill the screen with the viewer's output, or leave fullscreen.",
    handler: async (input, context) => {
      const revision = context.store.getRevision();
      const target: FullscreenTarget = input.target ?? "viewer";
      const surface = target === "app" ? holder.app : holder.current;
      const element = surface?.() ?? null;
      if (element === null) {
        return { status: "rejected", revision, diagnostics: [NO_SURFACE(target)], output: { fullscreen: false } };
      }

      // The document that actually CONTAINS the element — a floated viewer's child
      // window, not the app's (§V97, T393).
      const doc = element.ownerDocument;
      if (typeof element.requestFullscreen !== "function" || typeof doc.exitFullscreen !== "function") {
        return { status: "rejected", revision, diagnostics: [UNSUPPORTED], output: { fullscreen: false } };
      }

      const isFullscreen = doc.fullscreenElement === element;
      const want = input.fullscreen ?? !isFullscreen;
      if (context.dryRun) return { status: "validated", revision, output: { fullscreen: want } };
      if (want === isFullscreen) return { status: "applied", revision, output: { fullscreen: want } };

      try {
        if (want) await element.requestFullscreen();
        else await doc.exitFullscreen();
      } catch (error) {
        // Refused: no user activation, a permissions policy, or a window that is not
        // allowed to go fullscreen. Say which, rather than reporting a state change that
        // did not happen (§V288, §V123).
        return {
          status: "rejected",
          revision,
          diagnostics: [
            {
              severity: "error" as const,
              code: "view.fullscreenRefused",
              message: `The browser refused the fullscreen request: ${
                error instanceof Error ? error.message : String(error)
              }`,
            },
          ],
          output: { fullscreen: doc.fullscreenElement === element },
        };
      }

      return { status: "applied", revision, output: { fullscreen: want } };
    },
    rejectionOutput: () => ({ fullscreen: false }),
  });

  return holder;
}

/**
 * The viewer's half: register the command and publish the surface.
 *
 * One hook so the two cannot drift apart — a published surface with no command is a
 * button that does nothing, and a command with no surface is the §V220 shape.
 */
export function useFullscreenSurface(
  bus: LoomBus,
  surface: FullscreenSurface,
  target: FullscreenTarget = "viewer",
): void {
  useEffect(() => {
    const holder = registerFullscreenCommand(bus);
    if (target === "app") holder.app = surface;
    else holder.current = surface;
    return () => {
      // Only relinquish what is still ours: StrictMode runs mount → cleanup → mount, and
      // a cleanup that clears unconditionally would erase the newer mount's surface
      // (§V334, B51 — the same collision, one file over).
      if (target === "app") {
        if (holder.app === surface) holder.app = null;
      } else if (holder.current === surface) {
        holder.current = null;
      }
    };
  }, [bus, surface, target]);
}
