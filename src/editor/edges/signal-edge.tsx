import { memo, useEffect, useSyncExternalStore } from "react";
import { BaseEdge, getBezierPath } from "@xyflow/react";
import type { EdgeProps } from "@xyflow/react";
import type { NodeId } from "@domain/types/ids.ts";
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
 *  - with no timing at all — the state of every bypassed or idle pass — it is a static
 *    hairline. The animation is evidence of work, so no evidence means no animation.
 *
 * ## T1013 — THE MOTION IS OPT-IN NOW, and that is two decisions, not one
 *
 * FIRST: for the whole life of this component the middle bullet was false of the product.
 * Per-pass GPU ms never arrived — `attachTimingSource` had no product call site until
 * T1011 — so `describeFlow` saw `null` on every edge, returned `STATIC_FLOW`, and the
 * moving layer was never in the DOM at all. The docblock described a feature that had
 * never once run. It runs now.
 *
 * SECOND: seeing it run, the owner asked for a switch — *"we should also add these
 * animated cable thingies, the animated edges, to the debug menu so we can toggle it on
 * and off, and it should be probably off by default, same as the timings."* Every wire in
 * the graph moving at once is a picture that never settles; as an instrument you reach for
 * while asking where the frame is going, it is the per-node overlay's twin, and it lives in
 * the same Debug submenu.
 *
 * ## Why the flow layer is a separate component
 *
 * §V836, the same reason the timing readout left the node header. Reading `gpuMs` means
 * subscribing to the source node's runtime slice, and that subscription used to sit HERE —
 * so every edge on screen woke ten times a second, forever, for a number that was always
 * null. `EdgeFlow` owns it now and is mounted only while the toggle is on, so the resting
 * state of an edge is a path and a boolean.
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
  const { edgeGeometry, edgeFlow } = useGraphCanvas();
  const reducedMotion = useReducedMotion();
  const showFlow = useSyncExternalStore(edgeFlow.subscribe, edgeFlow.get);

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
      {showFlow && !reducedMotion ? (
        <EdgeFlow
          edgeId={id}
          sourceNodeId={(data?.sourceNodeId ?? "") as NodeId}
          path={path}
          color={color}
          portKind={data?.portKind ?? null}
          inactive={data?.inactive === true}
        />
      ) : null}
    </>
  );
});

/**
 * The moving layer, and the only thing on the canvas that reads a per-pass measurement.
 *
 * Its own component so the subscription is mounted with it and unmounted with it (§V836):
 * an edge whose flow is switched off is not a component that renders nothing, it is a
 * component that does not exist. See `SignalEdge`'s docblock.
 */
const EdgeFlow = memo(function EdgeFlow({
  edgeId,
  sourceNodeId,
  path,
  color,
  portKind,
  inactive,
}: {
  readonly edgeId: string;
  readonly sourceNodeId: NodeId;
  readonly path: string;
  readonly color: string;
  readonly portKind: string | null;
  readonly inactive: boolean;
}) {
  const { runtime } = useGraphCanvas();
  // The pass that feeds this edge is the one whose cost the edge reports. Subscribing
  // per source node keeps metric churn off every other component (§V16).
  const snapshot = useNodeRuntime(runtime, sourceNodeId);
  const flow = describeFlow(snapshot.gpuMs, { inactive });
  if (!flow.moving) return null;

  return (
    <path
      className={styles.flow}
      d={path}
      data-testid={`edge-flow-${edgeId}`}
      data-port-kind={portKind ?? "unknown"}
      strokeDasharray={`${FLOW_DASH_ON_PX} ${FLOW_DASH_PX - FLOW_DASH_ON_PX}`}
      style={cssVars({
        "--edge-color": color,
        "--flow-dash": `${FLOW_DASH_PX}px`,
        "--flow-duration": `${flow.periodSeconds.toFixed(3)}s`,
        "--flow-opacity": flow.opacity.toFixed(3),
      })}
    />
  );
});
