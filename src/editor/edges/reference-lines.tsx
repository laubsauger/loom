import { memo, useMemo } from "react";
import { ViewportPortal, useNodes, useStore as useFlowStore } from "@xyflow/react";
import type { ParameterDependency, ParameterDependencyKind } from "@domain/graph/parameter-dependencies.ts";
import type { NodeId } from "@domain/types/ids.ts";
import { MIN_NODE_SIZE } from "@domain/types/graph.ts";
import { arrowPoints, screenScale, segmentBetween } from "./reference-geometry.ts";
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

/** §V26-adjacent: a reference is not a port family, so neither line borrows a port hue. */
const KIND_COLOR: Record<ParameterDependencyKind, string> = {
  // The CHOP wire's own token: a driven parameter IS a value-graph relationship.
  driven: "var(--port-value)",
  // An expression reference belongs to no family; quiet grey, clearly not a signal.
  reference: "var(--text-dim)",
  // T350: the feedback loop the user used to WIRE — the temporal family's own hue,
  // because this line is the loop.
  feedback: "var(--port-texture2d)",
};

const DASH_PX = 6;
const GAP_PX = 5;
const STROKE_PX = 1.25;
const ARROW_PX = 7;

/** One line to draw: a node pair, a kind, and every parameter that put it there. */
interface ReferenceLine {
  readonly key: string;
  readonly source: NodeId;
  readonly target: NodeId;
  readonly kind: ParameterDependencyKind;
  readonly parameterKeys: readonly string[];
}

/**
 * Dependencies collapsed to lines.
 *
 * Six parameters of one node driven by the same LFO is ONE relationship drawn once, with
 * all six named in the tooltip. Six identical lines stacked on each other would look like
 * one line anyway while costing six times as much to draw.
 */
export function referenceLinesOf(dependencies: readonly ParameterDependency[]): ReferenceLine[] {
  const byPair = new Map<string, { line: ReferenceLine; keys: string[] }>();
  for (const dependency of dependencies) {
    // The ARROW follows the data: the node being read is the source, the node whose
    // parameter reads it is the target, which is the same direction a wire would run.
    const source = dependency.to;
    const target = dependency.from;
    const key = `${source}|${target}|${dependency.kind}`;
    const existing = byPair.get(key);
    if (existing === undefined) {
      byPair.set(key, {
        line: { key, source, target, kind: dependency.kind, parameterKeys: [] },
        keys: [dependency.parameterKey],
      });
      continue;
    }
    if (!existing.keys.includes(dependency.parameterKey)) existing.keys.push(dependency.parameterKey);
  }
  return [...byPair.values()]
    .map(({ line, keys }) => ({ ...line, parameterKeys: keys }))
    .sort((a, b) => a.key.localeCompare(b.key));
}

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

  return (
    <ViewportPortal>
      {/*
        `pointer-events: none` is INLINE rather than in the stylesheet because it is not a
        style — it is §V151 ("never a drop target") holding at runtime. The children are
        painted outside this zero-sized box, so without it they would swallow clicks meant
        for the node underneath. Inline, it is one source of truth and a testable fact.
      */}
      <svg
        className={styles.layer}
        style={{ pointerEvents: "none" }}
        data-testid="reference-lines"
        aria-hidden
      >
        {lines.flatMap((line) => {
          const from = rects.get(line.source);
          const to = rects.get(line.target);
          if (from === undefined || to === undefined) return [];
          const segment = segmentBetween(from, to);
          if (segment === null) return [];
          const color = KIND_COLOR[line.kind];
          return [
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
            </g>,
          ];
        })}
      </svg>
    </ViewportPortal>
  );
});
