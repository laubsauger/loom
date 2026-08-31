import { flattenComponents } from "@compiler/index.ts";
import type { FlattenedGraph } from "@compiler/index.ts";
import type { ComponentRegistry } from "@domain/components/index.ts";
import type { GraphStoreView } from "@domain/graph/index.ts";
import type { NodeRegistryView } from "@nodes/registry/registry.ts";

/**
 * THE flattened document, memoized on `(document revision, catalogue revision)` (T615,
 * §V529, §V437).
 *
 * ## Why this object exists at all
 *
 * Every per-frame CPU walk in this app used to read `bus.store.getGraph()` — the
 * UN-FLATTENED document — so nothing inside a component instance existed as far as the
 * CPU was concerned. Measured on ten instances of a component holding an LFO, a Lag and a
 * Math: the value graph published exactly one channel (the root LFO's), the driven blur
 * inside every instance read `undefined`, and with the animation living only inside the
 * component `hasAnimatedParameters` answered false — so `compile.animate` was null and a
 * component-internal EXPRESSION was equally dead. A component whose only animation is
 * internal was frozen.
 *
 * The fix is not six call sites patched one at a time (§V437's shape: site N+1 is always
 * wrong). It is this: ONE flattened graph, produced here, handed to everything that runs
 * per frame — so the raw document is not reachable from a frame path to be got wrong.
 * `frame-path-flattening.test.ts` is the declare-or-fail gate that keeps it that way.
 *
 * ## Why flattening rather than a component-aware walk
 *
 * Flattening already does every hard part, and each one is load-bearing:
 *
 *  - **per-instance state is free.** Flat ids are `c1/wob` and `c2/wob`, and the value
 *    graph keys state BY NODE ID — so two instances of one Lag cannot share a trajectory
 *    (§V79 by construction, not by care).
 *  - **name references are already rewritten per level.** B41's `withUniqueNames` renames
 *    instance 2's `wob` to `wob1` AND rewrites the driven binding that reads it, so
 *    `c2/blur.size` arrives reading `channel: "wob1"`. This is the single reason the flat
 *    route works at all.
 *  - **§V82 survives.** `sources` maps `c1/wob` to its authored path, which is what pulse
 *    dispatch and Analyze telemetry need to name the node a user can navigate to.
 *
 * A component-aware recursion would re-implement all three in a second place and agree
 * with the first by inspection (§V109).
 *
 * ## Why the memo is not optional
 *
 * §V529: `flattenComponents` is a PURE function of the document, and it costs 5–7× the
 * value graph it feeds (measured here at 5.1× on the ten-instance scenario). Running it
 * per frame is what makes the correct version SLOWER than the broken one — measured on
 * that scenario: 536 µs/frame broken, 762 µs/frame flattened naively per frame, 292
 * µs/frame flattened once per revision. Correctness and the memo ship together, because
 * shipping the first while intending the second is how a perf complaint gets attributed
 * to a correctness fix.
 *
 * ## The two keys
 *
 * The DOCUMENT (compared by object identity — the store hands out a new object per
 * revision and the same one otherwise, which is what `useSyncExternalStore` already
 * relies on) and the CATALOGUE revision, counted here off the component registry's own
 * notifications. §V210(c): editing a component's internal graph changes what flattening
 * produces for every host while the host document is untouched — same nodes, same edges,
 * same revision — so a document-only key would keep serving yesterday's internals.
 *
 * ## What it deliberately does NOT do
 *
 * No clock, no frame, no per-subtree time. `sources.get(flatId).path` is kept intact and
 * the value graph still evaluates from a frame ARGUMENT rather than a module global —
 * those two properties are the whole hook T616 hangs component-local time off, and this
 * task's job is to not regress them.
 */
export interface FlattenedGraphSource {
  /**
   * The flattened document for the store's CURRENT revision.
   *
   * Reads the store itself rather than taking a graph, on purpose: this is the one
   * declared per-frame read of the raw document in the whole app, and taking an argument
   * would put the choice of which document to flatten back at every call site.
   */
  current(): FlattenedGraph;
  dispose(): void;
}

export interface FlattenedGraphSourceInputs {
  readonly store: GraphStoreView;
  /** The component-AWARE node view, so a component nested in a component resolves. */
  readonly registry: NodeRegistryView;
  readonly components: Pick<ComponentRegistry, "view" | "subscribe">;
}

export function createFlattenedGraphSource(
  inputs: FlattenedGraphSourceInputs,
): FlattenedGraphSource {
  const { store, registry, components } = inputs;
  let catalogue = 0;
  const unsubscribe = components.subscribe(() => {
    catalogue += 1;
  });

  let cached: { graph: unknown; catalogue: number; flattened: FlattenedGraph } | null = null;

  return {
    current(): FlattenedGraph {
      // §V464(c): the ONE declared read of the un-flattened document on a frame path.
      // Everything downstream of here sees `flattened.graph`.
      const graph = store.getGraph();
      const hit = cached;
      if (hit !== null && hit.graph === graph && hit.catalogue === catalogue) return hit.flattened;
      const flattened = flattenComponents({ graph, registry, components: components.view() });
      cached = { graph, catalogue, flattened };
      return flattened;
    },
    dispose() {
      unsubscribe();
      cached = null;
    },
  };
}
