// v16-allow-command-bus: registers `ui.toggleEdgeFlow`, which makes no patch and opens no
// undo group — whether a wire is ANIMATED is not something the document knows about.
import type { LoomBus } from "@domain/commands/bus.ts";
import { sharedForBus } from "@domain/commands/command-holder.ts";

/**
 * `ui.toggleEdgeFlow` — the flow-dash animation becomes a DEBUG VIEW (T1013, T1010).
 *
 * ## Why the signature element got a switch
 *
 * `flow.ts` has always claimed the animation means something: *"edge = living signal.
 * flow-dash animation, hue = source port family, speed & opacity <- real per-pass GPU ms.
 * idle pass -> static hairline."* It could not have meant that, because per-pass GPU ms
 * never reached the app — `attachTimingSource` had no product call site until T1011 — so
 * `describeFlow(null)` returned `STATIC_FLOW` and the moving layer was never rendered at
 * all. The claim was true of the code and false of the product.
 *
 * With T1011's fix the mapping is finally real, and the owner's verdict on seeing it is
 * what shaped this: *"we should also add these animated cable thingies, the animated
 * edges, to the debug menu so we can toggle it on and off, and it should be probably off
 * by default, same as the timings."* An always-on animation on every wire is a graph that
 * is never at rest; as something you switch on to ask "where is the frame going", it is
 * the same instrument the per-node overlay is, and it belongs in the same submenu.
 *
 * ## Off means the edge holds no subscription
 *
 * §V836's rule, restated for the edge layer. `SignalEdge` used to subscribe every edge on
 * screen to its SOURCE NODE's runtime slice so it could ask for `gpuMs` — a per-edge 10 Hz
 * wake-up on a channel that had nothing to say. The subscription moved into `EdgeFlow`,
 * which is mounted only while this store reads true, so the default costs one boolean per
 * edge instead of one sample.
 *
 * Session-scoped and off by default, for `ui.toggleTimingOverlay`'s reasons.
 */
declare module "@domain/types/commands.ts" {
  interface CommandMap {
    /**
     * Show or hide the animated flow dashes on edges. `show` omitted FLIPS, which is what a
     * menu row or a keypress means.
     */
    "ui.toggleEdgeFlow": {
      input: { show?: boolean };
      output: { shown: boolean };
    };
  }
}

export const TOGGLE_EDGE_FLOW_COMMAND = "ui.toggleEdgeFlow";

export interface EdgeFlowStore {
  get(): boolean;
  set(shown: boolean): boolean;
  subscribe(listener: () => void): () => void;
}

/** §V19's neighbour: motion is opt-in here, not merely suppressible. */
export const EDGE_FLOW_DEFAULT = false;

export function createEdgeFlowStore(): EdgeFlowStore {
  let shown = EDGE_FLOW_DEFAULT;
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

/** One store per bus — two canvases on one document must agree (§V97). */
export function edgeFlowStoreFor(bus: LoomBus): EdgeFlowStore {
  return sharedForBus<EdgeFlowStore>(bus, TOGGLE_EDGE_FLOW_COMMAND, createEdgeFlowStore);
}

/** Idempotent: the bus has no unregister, and React mounts more than once. */
export function registerEdgeFlowCommand(bus: LoomBus): EdgeFlowStore {
  const store = edgeFlowStoreFor(bus);
  if (bus.hasCommand(TOGGLE_EDGE_FLOW_COMMAND)) return store;

  bus.registerCommand({
    name: TOGGLE_EDGE_FLOW_COMMAND,
    description:
      "Show or hide the animated flow dashes on edges — speed and opacity from real per-pass GPU ms (T1013).",
    handler: (input, context) => {
      const next = input.show ?? !store.get();
      // §V36 — a dry run answers what WOULD happen and changes nothing.
      if (context.dryRun) return { status: "validated", output: { shown: next } };
      return { status: "applied", output: { shown: store.set(next) } };
    },
    rejectionOutput: () => ({ shown: store.get() }),
  });

  return store;
}
