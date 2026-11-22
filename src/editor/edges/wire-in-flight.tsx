import { memo, useLayoutEffect, useRef } from "react";
import { Position, useStoreApi } from "@xyflow/react";
import type { ConnectionInProgress, ConnectionState, Transform } from "@xyflow/react";
import { parseHandleId } from "@domain/graph/edge-order.ts";
import { describePortType } from "@domain/graph/port-compat.ts";
import type { GraphDocument } from "@domain/types/graph.ts";
import type { PortDefinition } from "@domain/types/ports.ts";
import type { NodeRegistryView } from "@nodes/registry/registry.ts";
import { useGraphCanvas } from "@editor/graph-canvas/canvas-context.ts";
import { edgeFamilyColor } from "./flow.ts";
import { arcBolt, arcBranch, arcTick, polylinePath } from "./wire-arc.ts";
import { wireAnswer, wireScale } from "./wire-range.ts";
import { wirePath, wirePathFromInput } from "./wire-path.ts";
import { wireStyleStore } from "./wire-style-command.ts";
import styles from "./wire-in-flight.module.css";

/**
 * A wire while it is being dragged (T1639b): the wire itself, its round tip at the cursor,
 * and what the port under it says. The design and the reference it is built from are in
 * docs/wire-snap-design-2026-10-06.md.
 *
 *  - Out of range of anything: a white wire.
 *  - In range of a port that takes it: a ring on the port and an electric arc from the
 *    tip to it, in the colour of what the wire carries. The tip stays with the cursor.
 *    The arc means "let go here and it connects".
 *  - In range of a port that refuses it: a dashed grey ring, and after a moment what the
 *    port takes. No arc, no colour.
 *
 * ## It asks React Flow, and never measures
 *
 * Which port is in range and whether it takes the wire are `connection.toHandle` and
 * `connection.isValid` in the library's store: the closest handle within
 * `connectionRadius` (`wire-range.ts`), then the canvas's `isValidConnection`. A release
 * connects on exactly those two facts. Drawing from them, and from no distance of our own,
 * is what makes the arc and the release one statement.
 *
 * ## It renders once
 *
 * This is React Flow's `connectionLineComponent`: the library mounts it when a connection
 * starts and unmounts it when it ends, so nothing of it exists at rest. The library also
 * hands it new props on every pointer move, and the comparator below refuses all of them:
 * the elements are rendered once and `attachWireInFlight` writes their attributes from a
 * store subscription, with no selector hook (§V16; `KindLabelDriver` is the same shape).
 * The arc is redrawn 15 times a second by one `requestAnimationFrame` loop that runs only
 * while a port is sparking.
 */

type Handle = ConnectionInProgress["fromHandle"];

/** The declared port behind one of React Flow's handles, or `undefined`. */
function portOf(graph: GraphDocument, registry: NodeRegistryView, handle: Handle): PortDefinition | undefined {
  const node = graph.nodes[handle.nodeId];
  if (node === undefined || handle.id === null || handle.id === undefined) return undefined;
  // T695: a variadic input's handle id carries a slot; the port is what has a type.
  return registry.port(node.type, parseHandleId(handle.id).portId, handle.type === "source" ? "output" : "input");
}

interface WireInFlightParts {
  readonly root: SVGGElement;
  readonly wire: SVGPathElement;
  readonly tip: SVGCircleElement;
  readonly ring: SVGCircleElement;
  readonly ringGlow: SVGCircleElement;
  readonly arc: SVGPathElement;
  readonly arcGlow: SVGPathElement;
  readonly branch: SVGPathElement;
  readonly refusedRing: SVGCircleElement;
  readonly refusedWhy: SVGTextElement;
}

interface WireInFlightSource {
  getState: () => { connection: ConnectionState; transform: Transform };
  subscribe: (
    listener: (
      state: { connection: ConnectionState; transform: Transform },
      previous: { connection: ConnectionState; transform: Transform },
    ) => void,
  ) => () => void;
}

interface WireInFlightFacts {
  /** The colour of a handle's port type: a `var(--port-…)` token reference. */
  colorOf: (handle: Handle) => string;
  /**
   * Why a handle refuses, as its own type: `takes …` for an input, `sends …` for an
   * output. The wire in the hand is the other half of the sentence and the person chose it.
   */
  says: (refusing: Handle) => string;
}

function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** A small stable number from a handle's address, so two ports' arcs are not twins. */
function seedOf(handle: Handle): number {
  const text = `${handle.nodeId} ${handle.id ?? ""}`;
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash = Math.imul(hash ^ text.charCodeAt(index), 16777619);
  }
  return hash >>> 0;
}

function place(circle: SVGCircleElement, x: number, y: number): void {
  circle.setAttribute("cx", String(Math.round(x * 100) / 100));
  circle.setAttribute("cy", String(Math.round(y * 100) / 100));
}

/**
 * Draws the wire into `parts` from `source` until the returned function is called.
 *
 * Every write is an attribute on an element this file rendered. Nothing here sets React
 * state, and nothing is written at all on a store event that changed neither the
 * connection nor the camera.
 */
function attachWireInFlight(
  parts: WireInFlightParts,
  source: WireInFlightSource,
  facts: WireInFlightFacts,
): () => void {
  const reduced = prefersReducedMotion();
  let frame = 0;
  /** The port the last draw found in range, and how it answered. */
  let target = "";
  let flip = 0;
  let tick = 0;
  /** What the arc is drawn between, kept for the redraw loop. `null` while nothing sparks. */
  let live: { tip: { x: number; y: number }; port: { x: number; y: number }; seed: number; scale: number } | null =
    null;
  let scaleWritten = Number.NaN;

  const drawArc = (): void => {
    if (live === null) return;
    const input = { from: live.tip, to: live.port, tick, seed: live.seed, scale: live.scale };
    const bolt = arcBolt(input);
    const path = polylinePath(bolt);
    parts.arc.setAttribute("d", path);
    parts.arcGlow.setAttribute("d", path);
    parts.branch.setAttribute("d", polylinePath(arcBranch(bolt, input)));
  };

  const stop = (): void => {
    if (frame !== 0) cancelAnimationFrame(frame);
    frame = 0;
  };
  const loop = (now: number): void => {
    frame = requestAnimationFrame(loop);
    const next = arcTick(now);
    if (next === tick) return;
    tick = next;
    drawArc();
  };

  const draw = (state: { connection: ConnectionState; transform: Transform }): void => {
    const connection = state.connection;
    if (!connection.inProgress) return;
    const [panX, panY, zoom] = state.transform;
    if (!(zoom > 0)) return;
    const scale = wireScale(zoom);
    if (scale !== scaleWritten) {
      scaleWritten = scale;
      // On this element alone: it holds the wire and nothing else (T1597b measured what an
      // inherited custom property costs on an ancestor of the nodes).
      parts.root.style.setProperty("--wire-k", String(Math.round(scale * 1000) / 1000));
    }

    // `pointer` is the cursor in the canvas's own pixels, whether or not the library has
    // snapped `to` onto a handle. The tip is always drawn there.
    const tip = { x: (connection.pointer.x - panX) / zoom, y: (connection.pointer.y - panY) / zoom };
    // T1820b: the person's wire style, so the wire in the hand is the one that lands. A wire
    // pulled from an input has its output end at the tip, and is written from the port held.
    const from = { x: connection.from.x, y: connection.from.y };
    const style = wireStyleStore().get();
    const wire =
      connection.fromPosition === Position.Left ? wirePathFromInput(style, [tip, from]) : wirePath(style, [from, tip]);
    parts.wire.setAttribute("d", wire);
    place(parts.tip, tip.x, tip.y);

    const to = connection.toHandle;
    const answer = wireAnswer(connection);
    const key = to === null || answer === "free" ? "" : `${answer} ${to.nodeId} ${to.id ?? ""} ${to.type}`;

    if (key !== target) {
      target = key;
      parts.root.setAttribute("data-wire-state", answer);
      // A new port: its ring and its caption arrive again (see `data-wire-flip` in the CSS).
      flip = flip === 0 ? 1 : 0;
      parts.root.setAttribute("data-wire-flip", String(flip));
      if (answer === "live") {
        // What the wire carries is its output's type (§V26). Asked of the end in the hand,
        // whichever that is: a port that takes the wire has the same kind (§V13), so the
        // two ends of a live pair cannot answer differently.
        parts.root.style.setProperty("--wire-color", facts.colorOf(connection.fromHandle));
      } else {
        parts.root.style.removeProperty("--wire-color");
      }
      if (to !== null && answer === "refused") {
        parts.refusedWhy.textContent = facts.says(to);
      }
    }

    if (to !== null && answer === "live") {
      place(parts.ring, to.x, to.y);
      place(parts.ringGlow, to.x, to.y);
      live = { tip, port: { x: to.x, y: to.y }, seed: seedOf(to), scale };
      drawArc();
      if (!reduced && frame === 0) frame = requestAnimationFrame(loop);
    } else {
      live = null;
      stop();
    }
    if (to !== null && answer === "refused") {
      place(parts.refusedRing, to.x, to.y);
      // Outside the node, above the wire's way in: the port's own label is on the other side.
      const outward = to.position === Position.Right ? 1 : -1;
      parts.refusedWhy.setAttribute("x", String(Math.round((to.x + outward * 12 * scale) * 100) / 100));
      parts.refusedWhy.setAttribute("y", String(Math.round((to.y - 9 * scale) * 100) / 100));
      parts.refusedWhy.setAttribute("text-anchor", outward === 1 ? "start" : "end");
    }
  };

  draw(source.getState());
  const unsubscribe = source.subscribe((state, previous) => {
    if (state.connection === previous.connection && state.transform === previous.transform) return;
    draw(state);
  });
  return () => {
    unsubscribe();
    stop();
  };
}

export const WireInFlight = memo(
  function WireInFlight() {
    const api = useStoreApi();
    const { store, registry } = useGraphCanvas();
    const root = useRef<SVGGElement | null>(null);
    const wire = useRef<SVGPathElement | null>(null);
    const tip = useRef<SVGCircleElement | null>(null);
    const ring = useRef<SVGCircleElement | null>(null);
    const ringGlow = useRef<SVGCircleElement | null>(null);
    const arc = useRef<SVGPathElement | null>(null);
    const arcGlow = useRef<SVGPathElement | null>(null);
    const branch = useRef<SVGPathElement | null>(null);
    const refusedRing = useRef<SVGCircleElement | null>(null);
    const refusedWhy = useRef<SVGTextElement | null>(null);

    // Layout phase, so the wire is under the cursor in the first frame it exists.
    useLayoutEffect(() => {
      const parts = {
        root: root.current,
        wire: wire.current,
        tip: tip.current,
        ring: ring.current,
        ringGlow: ringGlow.current,
        arc: arc.current,
        arcGlow: arcGlow.current,
        branch: branch.current,
        refusedRing: refusedRing.current,
        refusedWhy: refusedWhy.current,
      };
      if (Object.values(parts).some((part) => part === null)) return;
      return attachWireInFlight(parts as WireInFlightParts, api, {
        colorOf: (handle) => edgeFamilyColor(portOf(store.getGraph(), registry, handle)?.type.kind),
        says: (refusing) => {
          const port = portOf(store.getGraph(), registry, refusing);
          if (port === undefined) return "";
          // The Connections panel's words for the same refusal (`connect-drop.ts`).
          return `${refusing.type === "target" ? "takes" : "sends"} ${describePortType(port.type)}`;
        },
      });
    }, [api, store, registry]);

    return (
      <g ref={root} className={styles.wireInFlight} data-testid="wire-in-flight" data-wire-state="free">
        <path ref={wire} className={styles.wire} data-testid="wire-line" />
        <g className={styles.live}>
          <circle ref={ringGlow} className={styles.ringGlow} />
          <circle ref={ring} className={styles.ring} data-testid="wire-ring" />
          <path ref={arcGlow} className={styles.arcGlow} />
          <path ref={branch} className={styles.branch} data-testid="wire-arc-branch" />
          <path ref={arc} className={styles.arc} data-testid="wire-arc" />
        </g>
        <g className={styles.refused}>
          <circle ref={refusedRing} className={styles.refusedRing} data-testid="wire-refused" />
          <text ref={refusedWhy} className={styles.refusedWhy} data-testid="wire-refused-why" />
        </g>
        <circle ref={tip} className={styles.tip} data-testid="wire-tip" />
      </g>
    );
  },
  // Never again after the first render: see the docblock. The props React Flow sends are
  // the same facts the store subscription reads.
  () => true,
);
