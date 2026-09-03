import { memo, useEffect, useRef, useSyncExternalStore } from "react";
import type { NodeId } from "@domain/types/ids.ts";
import { useGraphCanvas, useNodeRuntime } from "@editor/graph-canvas/canvas-context.ts";
import { cssVars } from "@editor/graph-canvas/css-vars.ts";
import { formatGpuMs } from "@editor/edges/flow.ts";
import { costTier, smoothGpuMs, timingShare } from "./node-timing.ts";
import styles from "./node-timing-overlay.module.css";

/**
 * The per-node timing overlay (T1010) — THE LEAF, and being a leaf is the design.
 *
 * ## §V836, which is measured and not theoretical
 *
 * The inspector's live sampling was measured today at 3.89–8.28 ms per commit because one
 * 10 Hz sample re-rendered an entire panel subtree; at 10 Hz that is ~8 % of the main
 * thread spent redrawing text that did not change. An overlay on EVERY node repeats that
 * mistake N times over — and an instrument that costs what it measures reports its own
 * weight back to you, which is worse than no instrument.
 *
 * So the sample lands here and nowhere above here. This component owns:
 *
 *  - its own `useNodeRuntime` subscription, for its node id only;
 *  - its own smoothing accumulator;
 *  - its own subscription to the graph-wide denominator.
 *
 * `NodeView` renders `<NodeTimingOverlay nodeId>` and reads NONE of those. It subscribes
 * to the structural half of the runtime snapshot (`useNodeStructuralState`), which does
 * not carry `gpuMs`, so a timing tick repaints two spans and stops. That is the whole
 * §V836 lesson expressed as a component boundary, and `node-timing-overlay.test.tsx`
 * asserts it by counting `NodeView` renders while the numbers move.
 *
 * ## Why it is mounted conditionally rather than returning null
 *
 * A mounted component that renders nothing still holds its subscription and still wakes on
 * every tick. Off has to mean UNMOUNTED, so `NodeView` decides — reading the toggle store,
 * which changes when a person picks a menu row and at no other time.
 *
 * ## §V86 at the pixel
 *
 * `formatGpuMs(null)` is an em dash. A node whose pass reported nothing shows that dash
 * and an empty bar; it never shows `0.00 ms`, which would be a measurement of nothing
 * dressed as a cheap pass. Until `attachTimingSource` has a live product call site (T1011)
 * that is every node, and the overlay saying so plainly is the correct behaviour, not a
 * placeholder — it lights up on its own the moment real spans arrive.
 */
export const NodeTimingOverlay = memo(function NodeTimingOverlay({
  nodeId,
}: {
  readonly nodeId: NodeId;
}) {
  const { runtime, timingScale } = useGraphCanvas();
  const snapshot = useNodeRuntime(runtime, nodeId);
  const raw = snapshot.gpuMs;

  /**
   * The smoothing accumulator, advanced ONCE PER DISTINCT SAMPLE.
   *
   * Kept in a ref and advanced during render on purpose: the alternative — an effect that
   * writes state — commits twice for every tick, which doubles the very cost §V836 is
   * about. The `raw` guard is what makes it safe to do here: a second invocation with the
   * same sample (StrictMode's double render, a re-render from the denominator moving)
   * sees the sample it already folded in and changes nothing, so the value is a pure
   * function of the samples seen, not of how many times React called this function.
   */
  const accumulator = useRef<{ raw: number | null; smoothed: number | null }>({
    raw: null,
    smoothed: null,
  });
  if (accumulator.current.raw !== raw) {
    accumulator.current = { raw, smoothed: smoothGpuMs(accumulator.current.smoothed, raw) };
  }
  const smoothed = accumulator.current.smoothed;

  // The denominator. Reported after commit, never during render: `report` notifies other
  // overlays, and notifying a store while React is rendering is how a tearing bug starts.
  useEffect(() => {
    timingScale.report(nodeId, smoothed);
  }, [timingScale, nodeId, smoothed]);
  useEffect(() => () => timingScale.forget(nodeId), [timingScale, nodeId]);

  const total = useSyncExternalStore(timingScale.subscribe, timingScale.total, timingScale.total);
  const share = timingShare(smoothed, total);
  const percent = Math.round(share * 100);

  return (
    <div className={styles.overlay} data-testid={`node-timing-${nodeId}`}>
      <div
        className={styles.track}
        role="img"
        aria-label={
          smoothed === null
            ? "GPU time share: not measured"
            : `GPU time share: ${String(percent)}% of the graph (${costTier(share)})`
        }
      >
        <div
          className={styles.fill}
          data-testid={`node-timing-bar-${nodeId}`}
          data-cost={costTier(share)}
          style={cssVars({ "--timing-share": `${share * 100}%` })}
        />
      </div>
      <span
        className={styles.value}
        data-testid={`node-timing-value-${nodeId}`}
        title="GPU time for this pass, smoothed"
      >
        {formatGpuMs(smoothed)}
      </span>
    </div>
  );
});
