import { Background, BackgroundVariant, useStore } from "@xyflow/react";
import { gridLevel } from "./graph-grid.ts";

/**
 * T717 — the two stacked dot layers. The level-of-detail arithmetic, and the reason this
 * is a cross-fade rather than one adaptive gap, are in `graph-grid.ts` beside its tests.
 */
export function GraphGrid() {
  /*
   * Zoom only — deliberately NOT the whole transform. §V142/B13: a camera move must cost
   * nothing, and subscribing to the transform would re-render on every frame of a PAN.
   * Selecting `transform[2]` re-renders this component when the zoom changes and never
   * when the graph is merely panned. It is also why the grid is its own component rather
   * than markup inside GraphCanvas: a zoom step re-renders these two elements instead of
   * every node on the canvas.
   */
  const zoom = useStore((state) => state.transform[2]);
  const { gap, fineGap, fineOpacity, dotSize } = gridLevel(zoom);

  return (
    <>
      <Background
        id="grid-coarse"
        variant={BackgroundVariant.Dots}
        gap={gap}
        size={dotSize}
        color="var(--graph-dot)"
      />
      <Background
        id="grid-fine"
        variant={BackgroundVariant.Dots}
        gap={fineGap}
        size={dotSize}
        color="var(--graph-dot)"
        style={{ opacity: fineOpacity }}
      />
    </>
  );
}
