import { memo, useEffect } from "react";
import { BaseEdge, getBezierPath } from "@xyflow/react";
import type { EdgeProps } from "@xyflow/react";
import { cx } from "@ui/cx.ts";
import { useReducedMotion } from "@ui/hooks/use-reduced-motion.ts";
import { useGraphCanvas, useNodeRuntime } from "@editor/graph-canvas/canvas-context.ts";
import { cssVars } from "@editor/graph-canvas/css-vars.ts";
import type { LoomEdge } from "@editor/graph-canvas/derive.ts";
import { FLOW_DASH_ON_PX, FLOW_DASH_PX, describeFlow, edgeFamilyColor } from "./flow.ts";
import styles from "./signal-edge.module.css";

/**
 * The signature element (§C, T19): an edge is a living signal.
 *
 * Three things are true of every edge on screen, and each of them is load-bearing:
 *
 *  - its hue is the source port's family colour, from the port tokens (§V26). Not a
 *    theme accent, not a per-edge choice — you read the type of a connection off its
 *    colour without selecting anything.
 *  - its dashes travel at a speed and opacity taken from the source pass's real GPU
 *    milliseconds. A blur eating half the frame budget visibly races; a cheap copy
 *    crawls. That mapping lives in `flow.ts` and is unit tested.
 *  - with no timing at all — the state the app is in until T41 lands real timestamp
 *    spans, and the state of every bypassed or idle pass — it is a static hairline.
 *    The animation is evidence of work, so no evidence means no animation.
 *
 * Under `prefers-reduced-motion` the moving layer is not rendered at all (§V19). The
 * hairline still carries the hue, so no information is lost with motion switched off.
 */
export const SignalEdge = memo(function SignalEdge({
  id,
  data,
  style,
  selected,
  sourceX,
  sourceY,
  sourcePosition,
  targetX,
  targetY,
  targetPosition,
  markerEnd,
  interactionWidth,
}: EdgeProps<LoomEdge>) {
  const { runtime, edgeGeometry } = useGraphCanvas();
  const reducedMotion = useReducedMotion();
  // The pass that feeds this edge is the one whose cost the edge reports. Subscribing
  // per source node keeps metric churn off every other component (§V16).
  const snapshot = useNodeRuntime(runtime, data?.sourceNodeId ?? "");

  const [path] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });

  /**
   * §V14b/§V14c — publish the path THIS edge drew, so the canvas can hit-test a drop
   * against the wire the user is actually looking at (`edge-geometry.ts`). Re-published
   * whenever the endpoints move, which includes every frame of a node drag, and cleared
   * on unmount so a deleted edge stops being a target the moment it stops being drawn.
   */
  useEffect(() => {
    edgeGeometry.publish(id, path);
    return () => edgeGeometry.clear(id);
  }, [edgeGeometry, id, path]);

  const color = edgeFamilyColor(data?.portKind);
  const flow = describeFlow(snapshot.gpuMs, { inactive: data?.inactive === true });
  const animate = flow.moving && !reducedMotion;

  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        className={cx(styles.base, selected === true && styles.selected)}
        style={{ ...style, ...cssVars({ "--edge-color": color }) }}
        {...(markerEnd === undefined ? {} : { markerEnd })}
        interactionWidth={interactionWidth ?? 18}
      />
      {animate ? (
        <path
          className={styles.flow}
          d={path}
          data-testid={`edge-flow-${id}`}
          data-port-kind={data?.portKind ?? "unknown"}
          strokeDasharray={`${FLOW_DASH_ON_PX} ${FLOW_DASH_PX - FLOW_DASH_ON_PX}`}
          style={cssVars({
            "--edge-color": color,
            "--flow-dash": `${FLOW_DASH_PX}px`,
            "--flow-duration": `${flow.periodSeconds.toFixed(3)}s`,
            "--flow-opacity": flow.opacity.toFixed(3),
          })}
        />
      ) : null}
    </>
  );
});
