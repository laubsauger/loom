// v16-allow-command-bus: registers `ui.toggleTimingOverlay`, which makes no patch and opens
// no undo group — whether a debug readout is DRAWN is not something the document knows about.
import type { LoomBus } from "@domain/commands/bus.ts";
import { sharedForBus } from "@domain/commands/command-holder.ts";

/**
 * `ui.toggleTimingOverlay` — the ONE way the per-node timing overlay turns on and off
 * (T1010).
 *
 * A COMMAND rather than a handler, for the reason `ui.toggleReferenceLines` is one: the
 * Debug submenu row, a keybinding a keymap adds later and an agent asking to see where the
 * frame is going all name this, so all three cannot drift (§V78).
 *
 * It lives beside its surface rather than in `src/domain/commands` because there is
 * nothing for `ctx.apply` to write. GPU milliseconds are not document state, they belong
 * in no `.loom.json`, and putting the readout on the undo stack would mean ⌘Z after a look
 * undoes the look instead of the edit (§V16, §V153's argument).
 *
 * ## OFF by default, and session-scoped
 *
 * The owner's words: *"it's not supposed to be there all the time. I want to turn it off
 * and on."* This is the opposite call from `nodeTypeLabelStore`, which persists to
 * `localStorage` and defaults ON — a type label is identification the reader always wants,
 * whereas an instrument is something you reach for while you are diagnosing and put down
 * afterwards. Session-scoped for the same reason `ui.toggleReferenceLines` is: reopening a
 * project into a debug state you cannot remember choosing is how a view setting becomes a
 * bug report about clutter.
 */
declare module "@domain/types/commands.ts" {
  interface CommandMap {
    /**
     * Show or hide the per-node GPU timing overlay. `show` omitted FLIPS, which is what a
     * menu row or a keypress means; passing it explicitly is for a caller that wants a
     * known state rather than the opposite of whatever it happens to be.
     */
    "ui.toggleTimingOverlay": {
      input: { show?: boolean };
      output: { shown: boolean };
    };
  }
}

export const TOGGLE_TIMING_OVERLAY_COMMAND = "ui.toggleTimingOverlay";

export interface TimingOverlayStore {
  get(): boolean;
  set(shown: boolean): boolean;
  subscribe(listener: () => void): () => void;
}

/** §V836's reason as much as the owner's: an instrument nobody asked for still costs. */
export const TIMING_OVERLAY_DEFAULT = false;

export function createTimingOverlayStore(): TimingOverlayStore {
  let shown = TIMING_OVERLAY_DEFAULT;
  const listeners = new Set<() => void>();
  return {
    get: () => shown,
    set: (next) => {
      if (next !== shown) {
        shown = next;
        for (const listener of [...listeners]) listener();
      }
      return shown;
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/**
 * One store per bus — the bus is the per-document identity, and two canvases showing the
 * same document (the floated graph pane, §V97) must agree about what they are drawing.
 */
export function timingOverlayStoreFor(bus: LoomBus): TimingOverlayStore {
  return sharedForBus<TimingOverlayStore>(
    bus,
    TOGGLE_TIMING_OVERLAY_COMMAND,
    createTimingOverlayStore,
  );
}

/**
 * Idempotent, like every other editor-side registration: the bus has no unregister, and
 * React mounts more than once (StrictMode, remounts, tests).
 */
export function registerTimingOverlayCommand(bus: LoomBus): TimingOverlayStore {
  const store = timingOverlayStoreFor(bus);
  if (bus.hasCommand(TOGGLE_TIMING_OVERLAY_COMMAND)) return store;

  bus.registerCommand({
    name: TOGGLE_TIMING_OVERLAY_COMMAND,
    description:
      "Show or hide the per-node GPU timing overlay — absolute ms and each node's share of the frame (T1010).",
    handler: (input, context) => {
      const next = input.show ?? !store.get();
      // §V36 — a dry run answers what WOULD happen and changes nothing, so a caller can
      // read the state back without setting it.
      if (context.dryRun) return { status: "validated", output: { shown: next } };
      return { status: "applied", output: { shown: store.set(next) } };
    },
    rejectionOutput: () => ({ shown: store.get() }),
  });

  return store;
}
