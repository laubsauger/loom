// v16-allow-command-bus: registers `ui.toggleReferenceLines`, which makes no patch and opens
// no undo group — whether a line is DRAWN is not something the document knows about.
import type { ShaderloomBus } from "@domain/commands/bus.ts";
import { sharedForBus } from "@domain/commands/command-holder.ts";

/**
 * `ui.toggleReferenceLines` — the ONE way the reference lines turn on and off (T248, §V153).
 *
 * §V153 exists because a network with many references becomes unreadable if every
 * relationship is drawn all the time; TouchDesigner ships the toggle for that reason and
 * not as a preference. So the toggle is a real control, and like `ui.showNodeInfo` it is a
 * COMMAND rather than a handler: the menu item, the keybinding a keymap adds later and an
 * agent asking to see the dependencies all name this, so all three cannot drift (§V78).
 *
 * It lives in the editor rather than `src/domain/commands` for the reason spelled out on
 * `ui.showNodeInfo`: there is nothing for `ctx.apply` to write. Whether lines are drawn is
 * a property of a LOOK at the graph, not of the graph — it changes no pixel the project
 * renders, belongs in no `.loom.json`, and putting it on the undo stack would mean Cmd+Z
 * after a glance undoes the glance instead of the edit.
 *
 * Session-scoped for the same reason a preview lens is (§V255): it does not survive a
 * reload, and it should not. Reopening a project into a state you cannot remember choosing
 * is how a view setting becomes a bug report about missing lines.
 */
declare module "@domain/types/commands.ts" {
  interface CommandMap {
    /**
     * Show or hide the derived reference/driven lines. `show` omitted FLIPS, which is what
     * a keypress or a menu item means; passing it explicitly is for a caller that wants a
     * known state rather than the opposite of whatever it happens to be.
     */
    "ui.toggleReferenceLines": {
      input: { show?: boolean };
      output: { shown: boolean };
    };
  }
}

export const TOGGLE_REFERENCE_LINES_COMMAND = "ui.toggleReferenceLines";

export interface ReferenceLinesStore {
  get(): boolean;
  set(shown: boolean): boolean;
  toggle(): boolean;
  subscribe(listener: () => void): () => void;
}

/**
 * Drawn by DEFAULT.
 *
 * The relationship is invisible without the line, and a feature that has to be discovered
 * before it can reveal something you did not know was there is a feature nobody turns on.
 * §V153's toggle is the escape hatch for a dense network, which is the case where the user
 * already knows the lines exist — because they are looking at too many of them.
 */
export const REFERENCE_LINES_DEFAULT = true;

export function createReferenceLinesStore(): ReferenceLinesStore {
  let shown = REFERENCE_LINES_DEFAULT;
  const listeners = new Set<() => void>();
  const notify = (): void => {
    for (const listener of [...listeners]) listener();
  };
  return {
    get: () => shown,
    set: (next) => {
      if (next !== shown) {
        shown = next;
        notify();
      }
      return shown;
    },
    toggle: () => {
      shown = !shown;
      notify();
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
export function referenceLinesStoreFor(bus: ShaderloomBus): ReferenceLinesStore {
  /*
   * STATE HELD: one boolean — whether reference lines are drawn — and the listeners
   * watching it. The smallest state of the four, and the one where a lost subscriber is
   * least visible: the toggle would report the new value while no canvas repainted.
   */
  return sharedForBus<ReferenceLinesStore>(
    bus,
    TOGGLE_REFERENCE_LINES_COMMAND,
    createReferenceLinesStore,
  );
}

/**
 * Idempotent, like every other editor-side registration: the bus has no unregister, and
 * React mounts more than once (StrictMode, remounts, tests).
 */
export function registerReferenceLinesCommand(bus: ShaderloomBus): ReferenceLinesStore {
  const store = referenceLinesStoreFor(bus);
  if (bus.hasCommand(TOGGLE_REFERENCE_LINES_COMMAND)) return store;

  bus.registerCommand({
    name: TOGGLE_REFERENCE_LINES_COMMAND,
    description: "Show or hide reference lines — which parameters read which nodes (§V153).",
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
