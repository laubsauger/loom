import { memo, useMemo } from "react";
import { ViewportPortal, useNodes, useStore as useFlowStore } from "@xyflow/react";
import type { ParameterDependency } from "@domain/graph/parameter-dependencies.ts";
import { MIN_NODE_SIZE } from "@domain/types/graph.ts";
import {
  REFERENCE_KIND_COLOR,
  arrowPoints,
  referenceLinesOf,
  screenScale,
  segmentBetween,
  segmentsBounds,
} from "./reference-geometry.ts";
import type { Rect } from "./reference-geometry.ts";
import styles from "./reference-lines.module.css";

/**
 * Reference lines (T248, §V151, §V153) — "who talks to whom" when there is no wire.
 *
 * Two relationships have always been real and invisible: a parameter reading another
 * node through `op('blur1').par.size`, and a parameter DRIVEN by a value node's channel.
 * A Mouse moving a blur with nothing drawn between them is the network lying by omission
 * — TouchDesigner draws both for exactly this reason.
 *
 * ## Derived, never stored (§V151)
 *
 * These lines are not React Flow edges and are deliberately not in the `edges` array.
 * That is the invariant made structural rather than promised: an entry in `edges` is
 * selectable, deletable and a drop target, and `onEdgesChange` would hand a "removed"
 * reference line straight to `graph.disconnect` — a gesture with no meaning, since the
 * dependency lives in a PARAMETER. Delete the line and what would happen to the
 * expression? The question has no answer, so the line is a picture and nothing else:
 * no pointer events, no selection, no id in any document.
 *
 * The lines therefore render inside `<ViewportPortal>`, which puts them in FLOW
 * coordinates — they pan and zoom with the graph without any transform of our own.
 *
 * ## Straight, dashed, and readable at every zoom
 *
 * Data edges are curved, saturated, and hued by port family (§V26). A reference is
 * straight, dashed and grey, so the two never read as the same kind of thing even at a
 * glance. The dash pattern, the stroke width and the arrowhead are divided by the live
 * ZOOM, which keeps them constant in SCREEN pixels: a 6px dash at zoom 0.2 would
 * otherwise render at 1.2px and the line would read as solid, which is the same as not
 * having drawn a dashed line at all.
 *
 * A node scrolled out of view is not special-cased. The line is drawn in flow space to
 * where the node actually is, so panning away takes the line with it; we never synthesise
 * a stub at the viewport edge, because a stub points at nothing and invites being clicked.
 */

/**
 * Tighter and lighter than a data edge, and all four scale with zoom (T391).
 *
 * A data edge at rest is `stroke-width: 1.25` at opacity 0.45 (`signal-edge.module.css`).
 *
 * A reference line is subordinate by SHAPE — thinner, and dashed — NOT by being washed
 * out. The first pass took it to 0.75/0.3, fainter than a data edge on both axes at once,
 * and the owner could not see it. Dashes also cut the ink roughly in half (3 on, 3.5 off),
 * so equal legibility needs MORE contrast per pixel than a solid edge, not less.
 * A reference must read as subordinate to that at every zoom, which is why the arrowhead
 * goes through `screenScale` exactly as the dash does: a fixed-size arrow on a thinning
 * line is what makes a line look wrong at one zoom and fine at another.
 */
const DASH_PX = 3;
const GAP_PX = 3.5;
const STROKE_PX = 0.95;
const ARROW_PX = 4.5;

export interface ReferenceLinesProps {
  /** Already resolved against the document — see `parameterDependencies` (§V154). */
  dependencies: readonly ParameterDependency[];
}

export const ReferenceLines = memo(function ReferenceLines({ dependencies }: ReferenceLinesProps) {
  // Every node, because a line's endpoints move with a DRAG and the drag is view state
  // that never reaches the document until it commits (§V15). Reading the flow's own
  // node array is what makes the line follow the node under the cursor.
  const nodes = useNodes();
  const zoom = useFlowStore((state) => state.transform[2]);

  const rects = useMemo(() => {
    const map = new Map<string, Rect>();
    for (const node of nodes) {
      map.set(node.id, {
        x: node.position.x,
        y: node.position.y,
        // Unmeasured (first frame, and every jsdom test) falls back to the floor rather
        // than to zero: a zero-sized rect puts both endpoints at the node's corner.
        width: node.measured?.width ?? node.width ?? MIN_NODE_SIZE.width,
        height: node.measured?.height ?? node.height ?? MIN_NODE_SIZE.height,
      });
    }
    return map;
  }, [nodes]);

  const lines = useMemo(() => referenceLinesOf(dependencies), [dependencies]);
  if (lines.length === 0) return null;

  const scale = screenScale(zoom);

  /**
   * The segments, resolved BEFORE the box — because the box is measured from them (B47).
   *
   * This used to be computed inside the JSX and the `<svg>` was zero-sized with
   * `overflow: visible`. An outermost `<svg>` with a zero-width or zero-height viewport
   * renders nothing at all, so every line was in the DOM and none of them was ever
   * painted. The layer now spans exactly what it draws.
   */
  const drawn = lines.flatMap((line) => {
    const from = rects.get(line.source);
    const to = rects.get(line.target);
    if (from === undefined || to === undefined) return [];
    const segment = segmentBetween(from, to);
    if (segment === null) return [];
    return [{ line, segment }];
  });
  // The arrowhead sits back from the endpoint and spreads across the line; the stroke
  // straddles its path. Both overhang the raw endpoints, and both scale with zoom.
  const box = segmentsBounds(
    drawn.map(({ segment }) => segment),
    (ARROW_PX + STROKE_PX) * scale,
  );
  if (box === null) return null;

  return (
    <ViewportPortal>
      {/*
        `pointer-events: none` is INLINE rather than in the stylesheet because it is not a
        style — it is §V151 ("never a drop target") holding at runtime. The box spans the
        whole span of the lines, so without it it would swallow clicks meant for the nodes
        underneath. Inline, it is one source of truth and a testable fact.
      */}
      <svg
        className={styles.layer}
        /*
          Placed AND sized from the content, with a `viewBox` in the same coordinates, so
          the children go on carrying raw flow numbers while the element itself has a real
          viewport. Inline rather than in the stylesheet because it is derived per render.
        */
        style={{
          pointerEvents: "none",
          left: box.x,
          top: box.y,
          width: box.width,
          height: box.height,
        }}
        viewBox={`${box.x} ${box.y} ${box.width} ${box.height}`}
        data-testid="reference-lines"
        aria-hidden
      >
        {drawn.map(({ line, segment }) => {
          const color = REFERENCE_KIND_COLOR[line.kind];
          return (
            <g
              key={line.key}
              data-testid={`reference-line-${line.source}-${line.target}`}
              data-kind={line.kind}
              data-parameters={line.parameterKeys.join(",")}
            >
              <title>{`${line.kind === "driven" ? "drives" : "referenced by"}: ${line.parameterKeys.join(", ")}`}</title>
              <line
                className={styles.line}
                x1={segment.x1}
                y1={segment.y1}
                x2={segment.x2}
                y2={segment.y2}
                stroke={color}
                strokeWidth={STROKE_PX * scale}
                strokeDasharray={`${DASH_PX * scale} ${GAP_PX * scale}`}
              />
              <polygon
                className={styles.arrow}
                points={arrowPoints(segment, ARROW_PX * scale)}
                fill={color}
              />
            </g>
          );
        })}
      </svg>
    </ViewportPortal>
  );
});
