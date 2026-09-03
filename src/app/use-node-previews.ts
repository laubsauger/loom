import { useEffect, useRef } from "react";
import type { RefObject } from "react";
import { liveClock } from "@domain/transport/live-clock.ts";
import type { GraphDocument } from "@domain/types/graph.ts";
import type { NodeId } from "@domain/types/ids.ts";
import { SINK_TARGET_PORT } from "@compiler/index.ts";
import type { ResolvedOutput } from "@compiler/index.ts";
import type { NodeRuntimeStore } from "@editor/graph-canvas/index.ts";
import { fitInsideRegion } from "@editor/nodes/index.ts";
import type { PreviewOrbitStore, PreviewSlotBoundsStore, PreviewViewSource } from "@editor/viewer/index.ts";
import {
  DEFAULT_PREVIEW_VIEW,
  EMPTY_PREVIEW_PROGRAM,
  createPreviewSystem,
  slotScreenRect,
} from "@runtime/previews/index.ts";
import type { PreviewRequest, PreviewSystem, ViewportTransform } from "@runtime/previews/index.ts";
import type { LoomBackend } from "@runtime/backend/index.ts";
import type { NodeRegistryView } from "@nodes/registry/registry.ts";
// T532: ONE list of previewable port kinds, shared with the slot, the compiler and the
// layout model — see `previewable.ts` on why four private copies is how B65 happened.
import { previewablePort } from "@domain/graph/previewable.ts";
import { parseComponentNodeType } from "@domain/components/component-type.ts";
import { isComponentOutputBoundary } from "@nodes/definitions/index.ts";
import type { ComponentRegistryView } from "@domain/components/index.ts";

/**
 * Mounts the shared preview surface and feeds it every node's tile request (T185).
 *
 * The scheduler, the tile pool and the debug-effect programs already existed and were
 * fully tested (`src/runtime/previews/**`) with no caller anywhere in the app — the node
 * body's preview region was, and stays, an empty `<div>` until something calls
 * `previewSystem.update()`. This is that caller.
 *
 * Driven by its own `requestAnimationFrame`, deliberately separate from `backend.loop()`
 * (`use-frame-loop.ts`): `PreviewSystem.plan()` allocates and must run OUTSIDE frame
 * encoding (§V8), and a standalone tick is the documented way to get that for free —
 * `update()` is exactly "plan() then present(), outside the frame" (`system.ts`). Tile
 * CONTENT still refreshes at `previewFps`; this tick, like `backend.loop`'s own
 * scheduler, just runs at display rate to keep tile PLACEMENT in sync with pan (design
 * note §3) — cheap, because nothing here allocates when nothing about the active set
 * changed.
 *
 * §V28a: every eligible node is offered as a request every tick — visibility (on
 * screen or not) and the pin are read by the scheduler that already exists, never
 * re-decided here.
 */

const PREVIEW_TILE_CAPACITY = 48;

/**
 * T501 — how many sink slots a tick reserves for previews that have NEVER painted.
 *
 * Bounded on purpose, and the bound is the whole design. Reserving nothing is the bug
 * (a preview that needs the idle round-trip is served only with leftovers, and when
 * there are none it is starved permanently). Reserving everything would evict the
 * drawing set on the tick a paste drops forty nodes in. Eight of forty-eight drains any
 * backlog at six previews per tick — a hundred waiting previews are all materialized
 * inside seventeen ticks — while leaving five sixths of the pool to what is on screen.
 */
const FIRST_PAINT_RESERVE = 8;

export interface NodePreviewInputs {
  /**
   * T252 (§V158): where the scheduler's kept set goes, so the COMPILER materializes
   * exactly what is watched. Optional: absent means nobody is gating on previews.
   */
  readonly previewSinks?: { set(refs: ReadonlyArray<{ nodeId: string; portId: string }>): void };
  readonly backend: LoomBackend | null | undefined;
  readonly canvasRef: RefObject<HTMLCanvasElement | null>;
  readonly bounds: PreviewSlotBoundsStore;
  /**
   * T336: per-node preview LENS. `PreviewRequest.view` has been on this request since T34 and
   * every caller passed the default, so channel isolation, exposure and the tonemap were live
   * in the shader and unreachable from the product (§V220, §V255). Absent = the default view,
   * which is what a caller with no lens store means.
   */
  readonly views?: PreviewViewSource | undefined;
  /** T561: per-node inspection orbit — this PANE's store; sampled per tick like bounds. */
  readonly orbits?: PreviewOrbitStore | undefined;
  /**
   * T756: the VIEWER's interest — the node it is presenting. Treated below as a PIN, so
   * a node whose tile is hidden keeps rendering while the viewer looks at it. One
   * request assembler, one policy, one more reason to pin (§V730: never a second path).
   */
  readonly interest?: import("@editor/viewer/index.ts").PreviewInterestStore | undefined;
  /** T601: resolves a component instance's preview to an INNER node's flat output row. */
  readonly components?: ComponentRegistryView | undefined;
  /**
   * T1019 — the FLAT id prefix of the graph this pane is SHOWING. Empty/absent at the
   * root; inside a component it is the dived instance chain joined by "/" (exactly the
   * accumulation `flattenedNodeId` mints), so a canvas node "grid" three levels down
   * addresses the compiled row "c1/c2/grid". Without it every interior preview asked
   * the plan for un-prefixed ids that resolve to nothing — the owner's "everything
   * says NO SIGNAL inside a component".
   */
  readonly flatPrefix?: string | undefined;
  readonly graph: GraphDocument;
  readonly registry: NodeRegistryView;
  readonly compiledOutputs: ReadonlyArray<ResolvedOutput>;
  readonly nodeRuntime: NodeRuntimeStore;
  readonly getViewport: () => ViewportTransform;
  /**
   * React Flow's LIVE node position, never `GraphNode.position` (§V112): a drag is not
   * committed to the document until release, so the document's position is stale for
   * the entire gesture — exactly the window a preview must keep up in.
   */
  readonly getNodePosition: (nodeId: NodeId) => { readonly x: number; readonly y: number } | undefined;
  /**
   * Which DOCUMENT is open (T519, B106).
   *
   * A tile is keyed by NODE ID, and two documents share node ids the moment they share
   * node names — `out` is in every shipped example. So on a load the atlas already holds
   * a tile under the incoming document's keys, the scheduler's refresh clock says that
   * key is not due yet, and the node shows the PREVIOUS PROJECT'S pixels until something
   * makes it repaint. `PreviewSystem.reset()` has named "project load" as one of its
   * three callers since T34 and there has never been one; this is it.
   */
  readonly documentIdentity: string;
  readonly previewFps: number;
  readonly previewLongEdge: number;
}

/**
 * Every node that HAS a texture to show, and which port it lives on.
 *
 * A texture OUTPUT is the common case — the same test T182 uses to sink it. A declared
 * sink is the other one: an Output node publishes no port at all, yet it owns the render
 * target the whole graph exists to fill, materialized by the compiler under the reserved
 * `SINK_TARGET_PORT`. Excluding it left the one node whose content the user most wants to
 * see — the final picture — as the only empty body in the graph.
 *
 * `gated` says whether this node needs a preview SINK to exist at all (T252/§V158). A
 * preview-only node does: nothing else keeps it, so the scheduler's kept set is what
 * makes the compiler materialize it. A declared sink never does — §V25 keeps it
 * unconditionally — and asking for it as a preview sink would make `resolveSinks` warn
 * about a port the definition does not declare, which is true and useless.
 *
 * A sink with NOTHING CONNECTED is excluded, and that is not cosmetic. It presents no
 * image, so its compile emits no pass; the target then exists in the plan and in no
 * built program, and a tile asking for it makes the preview host report an unresolvable
 * binding on every retry — a warning per second, forever, about a node whose real
 * problem (`compiler/input-missing`) is already on screen.
 *
 * `on` is the user's switch (T353, §V297), default ON. It is reported rather than
 * filtered out because a switched-off node still has something to SAY in its body — it is
 * off, not broken — while contributing no request, no tile and no sink, which is what
 * makes OFF cost nothing. The two exclusions cannot fight: an unconnected sink drops out
 * here whatever its switch says, and an off node never reaches the request path.
 */
export interface PreviewCandidate {
  readonly nodeId: NodeId;
  readonly portId: string;
  readonly gated: boolean;
  readonly on: boolean;
}

/** Exported for the T373 coverage gate — the product path itself only calls it below. */
export function previewCandidates(
  graph: GraphDocument,
  registry: NodeRegistryView,
): ReadonlyArray<PreviewCandidate> {
  const found: PreviewCandidate[] = [];
  const fed = new Set<NodeId>();
  for (const edge of Object.values(graph.edges)) fed.add(edge.target.nodeId);
  for (const [nodeId, node] of Object.entries(graph.nodes)) {
    const definition = registry.get(node.type);
    if (definition === undefined) continue;
    // Absent means ON: an untouched node previews, so an untouched document and one
    // where somebody pressed P twice are the same document.
    const on = node.ui?.preview !== false;
    // T373 (§V85): a pointset output previews as its own splat — the compiler
    // synthesizes the target when this candidate becomes a preview sink, so the same
    // materialization dance texture nodes use (T252) covers point generators too.
    // T462 extends the same shape to scene payloads: a camera, light or material
    // output previews as its payload in a stock scene. Keyed on the port KIND through
    // the ONE shared previewability list, so every present and future producer is a
    // candidate by construction (§V316, §V319, §V437) — including geometry ("scene"
    // kind), which T532 added there after this comment first claimed it was
    // deliberately absent (T573): the geometry previews as itself, points worn as its
    // own mode with its instancing and composed material overrides.
    const port = previewablePort(definition.outputs);
    if (port !== undefined) found.push({ nodeId, portId: port.id, gated: true, on });
    else if (definition.sink === true && fed.has(nodeId)) {
      found.push({ nodeId, portId: SINK_TARGET_PORT, gated: false, on });
    }
  }
  return found;
}

/**
 * T1019 — a preview aimed at a component OUT boundary resolves THROUGH it to the node
 * that actually produces the signal. The boundary flattens to a bare alias row (for a
 * pointset, a MARKER with no synthesis — §B177's measured detail: the sink `c1/out_out`
 * has nothing to draw while the synthesis lands on `c1/paint:out`), so a sink aimed at
 * the boundary registers forever and materializes never. Following the wire inside the
 * SAME graph lands on the row the compiler really mints. Bounded walk: boundaries do
 * not legally chain, but a malformed graph must not hang the preview tick.
 */
function throughOutputBoundary(
  graph: GraphDocument,
  nodeId: NodeId,
  portId: string,
): { nodeId: NodeId; portId: string } {
  let at = { nodeId, portId };
  for (let hops = 0; hops < 4; hops += 1) {
    const node = graph.nodes[at.nodeId];
    if (node === undefined || !isComponentOutputBoundary(node.type)) return at;
    const feeding = Object.values(graph.edges).find((edge) => edge.target.nodeId === at.nodeId);
    if (feeding === undefined) return at; // an unwired boundary stays itself: honest idle
    at = { nodeId: feeding.source.nodeId, portId: feeding.source.portId };
  }
  return at;
}

/**
 * T601: the inner node a component instance's preview shows, as a FLAT node id — or
 * undefined for a non-instance (or an unresolvable choice, which falls back to the
 * instance id and the ordinary not-materialized path).
 *
 * Default: the node behind the definition's FIRST output socket — post-T607 that is the
 * component's Out node, which is TD's own default. `ui.componentPreview` (the Common
 * page) may name ANY inner node instead: TD lets you view an internal operator while
 * debugging, and the choice is stated on the page rather than silently first (§V499).
 */
export function componentPreviewTarget(
  current: NodePreviewInputs,
  nodeId: NodeId,
): { nodeId: NodeId; portId: string } | undefined {
  const node = current.graph.nodes[nodeId];
  if (node === undefined || current.components === undefined) return undefined;
  const ref = parseComponentNodeType(node.type);
  if (ref === null) return undefined;
  const definition = current.components.get(ref.componentId, ref.version);
  if (definition === undefined) return undefined;
  const chosen = node.ui?.componentPreview;
  const inner =
    (typeof chosen === "string" && definition.graph.nodes[chosen as NodeId] !== undefined
      ? (chosen as NodeId)
      : undefined) ?? definition.outputs[0]?.nodeId;
  if (inner === undefined) return undefined;
  // T1019/§B177: the default target is the Out BOUNDARY, whose flattened row is a bare
  // alias (a pointset marker with no synthesis) — resolve through it to the producer.
  const innerNodeDef = definition.graph.nodes[inner];
  const produced =
    innerNodeDef === undefined
      ? { nodeId: inner, portId: "out" }
      : throughOutputBoundary(definition.graph, inner, "out");
  const innerNode = definition.graph.nodes[produced.nodeId];
  const innerDefinition = innerNode === undefined ? undefined : current.registry.get(innerNode.type);
  const port = innerDefinition === undefined ? undefined : previewablePort(innerDefinition.outputs);
  if (port === undefined) return undefined;
  // The flat id flatten mints: `${instanceId}/${innerId}` (§V82's path shape).
  return { nodeId: `${nodeId}/${produced.nodeId}` as NodeId, portId: port.id };
}

export function useNodePreviews(inputs: NodePreviewInputs): void {
  const inputsRef = useRef(inputs);
  inputsRef.current = inputs;
  /** The live tick body, for the T620 resync effect below. Null while not mounted. */
  const stepRef = useRef<(() => void) | null>(null);
  /** The live document-boundary body, for the B143 effect below. Null while not mounted. */
  const boundaryRef = useRef<((identity: string) => void) | null>(null);

  useEffect(() => {
    const canvas = inputs.canvasRef.current;
    const backend = inputs.backend;
    if (backend === null || backend === undefined || canvas === null) return;

    const host = backend.previewHost(canvas);
    const system: PreviewSystem = createPreviewSystem({ host, capacity: PREVIEW_TILE_CAPACITY });
    /**
     * T742/T740 — a preview IS a presentation, so its clock tracks real time (§V724).
     *
     * The deciding fact is what sits beside it: a node preview and the viewer draw THE
     * SAME NODE, and the thing a viewer can check is the RATE. This clock has its own
     * origin (zero at mount, not the document timeline), so the two were never equal —
     * but under the fixed step a browser throttling rAF to 30 Hz ran the preview at HALF
     * the viewer's rate, and a constant offset that grows without bound is a different
     * thing from an offset. One node, animating at two speeds, on the same screen.
     *
     * The hidden-window case does NOT distinguish the two, and it is worth saying so
     * because it looks like it should: the viewer's scheduler is rAF as well (vgpu's
     * `loop`, "raf" by default, and nothing in this app asks for "timer"), so BOTH park
     * together and both resume clamped to `maxDeltaSeconds`. The one asymmetry is T620's
     * door below, which steps this clock while rAF is parked — and that step is now worth
     * the measured time rather than a fixed 1/60, bounded by the same quarter-second.
     *
     * `() => true` rather than a running flag, and that IS the honest answer: unlike the
     * frame loop this clock has no seek, no step button and no render take (T433) — the
     * ONE `clock.next()` below is the rAF cadence, and the T620 convergence step that
     * shares it wants the current time for the same reason. Nothing here can be stepped
     * deterministically, so there is nothing to opt out.
     *
     * What this does NOT fix, stated rather than implied: this loop has no paced gate, so
     * on a display FASTER than 60 Hz the preview still runs fast, exactly as it did
     * before. The catch-up floors at one frame per tick (a fast display is a scheduler
     * problem, `createPacedGate`), so that case is unchanged, not newly broken.
     */
    const clock = liveClock({ presenting: () => true });
    /**
     * T501: preview keys that have ever had a materialized output — i.e. that have had
     * their chance. Membership is what retires a first-paint reservation; it is NOT
     * "has drawn", because a preview the scheduler suspends by budget has still been
     * given its turn and must not hold a reserved slot forever.
     */
    const everMaterialized = new Set<string>();
    let lastDeviceGeneration = backend.status.deviceGeneration;
    // T519: the load boundary, watched the same way the device boundary is — inside the
    // tick, so a load costs a comparison and never a teardown of the host.
    let lastDocumentIdentity = inputsRef.current.documentIdentity;
    let frameHandle = 0;

    /**
     * T519/B106 — a DIFFERENT DOCUMENT is open. Every tile and every refresh clock in here
     * is keyed by node id, and those ids belong to the project that just closed.
     *
     * B143 — and so does the program the BACKEND still has installed, which is a separate
     * thing from the state this system holds. `system.reset()` empties the atlas and nulls
     * the signature, so the next tick re-pushes; it does not touch the host. That gap is a
     * window, and the main plan gets there first: `backend.compile` resolves and re-points
     * every preview host (`refreshPreviewExternals`) on a microtask, while the next rAF is
     * a whole frame away. So the closed document's program is rebuilt against the incoming
     * document's plan and reports one true `backend/unknown-resource` per tile whose node
     * the new document does not have — thirty-nine of forty-eight for E24 → E2, which then
     * sit in the problems pane for good.
     *
     * Uninstalling here closes the window from the side that can actually be closed: the
     * push is SYNCHRONOUS at the boundary, so there is no stale program for the incoming
     * plan to be measured against. Nothing is suppressed — the diagnostics were right, and
     * the fix is to stop making them true.
     *
     * Called from the tick AND from a commit-time effect, sharing this one closure so the
     * comparison happens once whichever door the boundary arrives through. Not the whole
     * `step()`: that advances the preview clock and cadence state between display frames,
     * which is the perturbation T620 documents below.
     */
    const crossDocumentBoundary = (identity: string): void => {
      if (identity === lastDocumentIdentity) return;
      lastDocumentIdentity = identity;
      host.setPreviewProgram(EMPTY_PREVIEW_PROGRAM);
      system.reset();
      // T501's first-paint reservations are keyed by preview key too, so they belong
      // to the document that just closed.
      everMaterialized.clear();
    };

    const step = (): void => {
      // §V23 — a device rebuild invalidates cadence state (refresh clocks, tile keys)
      // that the backend cannot know about; the backend's own rebuild is separate and
      // already happens beneath `previewHost`/`present`.
      if (backend.status.deviceGeneration !== lastDeviceGeneration) {
        lastDeviceGeneration = backend.status.deviceGeneration;
        system.reset();
      }

      const current = inputsRef.current;
      // The commit-time effect below normally gets here first; this is the same call, for
      // the case where it did not (a load that never re-rendered this pane).
      crossDocumentBoundary(current.documentIdentity);

      const rect = canvas.getBoundingClientRect();
      const surface = { x: 0, y: 0, width: rect.width, height: rect.height };
      const viewport = current.getViewport();
      const devicePixelRatio = typeof window === "undefined" ? 1 : window.devicePixelRatio || 1;

      const candidates = previewCandidates(current.graph, current.registry);
      // Nodes the compiler already keeps on its own, so they must not be asked for as
      // preview sinks (see `previewCandidates`).
      const ungated = new Set<string>(
        candidates.filter((candidate) => !candidate.gated).map((candidate) => candidate.nodeId),
      );
      /*
       * T1019 — the pane's flat prefix: inside a component, the canvas shows INNER ids
       * while the plan holds FLATTENED ones. Every plan-facing lookup below goes
       * through `flatOf`; every publish stays on the CANVAS ref, because that is the
       * id the node on screen reads its state under. Conflating the two was both this
       * bug (interior previews asking the plan for ids it never minted) and §B177's
       * (instance idle state published under the flat id no canvas node listens to).
       */
      const prefix = current.flatPrefix ?? "";
      const flatOf = (id: string): NodeId => (prefix === "" ? id : `${prefix}/${id}`) as NodeId;
      const requests: PreviewRequest[] = [];
      const idle: Array<{ ref: { nodeId: NodeId; portId: string }; sink: { nodeId: NodeId; portId: string } }> = [];
      /** Canvas ref key -> the FLAT sink its preview actually needs materialized (T601/T1019). */
      const flatSinkOf = new Map<string, { nodeId: NodeId; portId: string }>();
      /** T501: on-screen area travels, so the idle queue is ordered by the SAME rule the
       *  scheduler ranks tiles by (largest on screen first) rather than by map order. */
      const visibleIdle: Array<{
        ref: { nodeId: NodeId; portId: string };
        sink: { nodeId: NodeId; portId: string };
        area: number;
      }> = [];
      /** Switched off (§V297): reported to the body, and nowhere else. */
      const off: Array<{ nodeId: NodeId; portId: string }> = [];
      // §V100/T197 — a slot that is not live still shows what the compiler resolved for
      // it, never a blank box, so this is looked up regardless of live/suspended/idle.
      // T527: keyed `${nodeId}:${portId}`, because that is the only safe key for a
      // materialized output (`ResolvedOutput`'s own docblock) — one node can emit several.
      // Keyed by node alone, a two-output node reported whichever row landed LAST under
      // both ports, so the slot's stated size and format belonged to a port nobody asked for.
      const facts = new Map<string, { width: number; height: number; format: string }>();
      for (const output of current.compiledOutputs) {
        facts.set(`${output.nodeId}:${output.portId}`, {
          width: output.size[0],
          height: output.size[1],
          format: output.format,
        });
      }

      for (const { nodeId, portId, on } of candidates) {
        // §V297 — OFF is not "hidden". No request means no tile, nothing scheduled and no
        // preview sink, so the compiler prunes the node and it costs nothing at all.
        if (!on) {
          off.push({ nodeId, portId });
          continue;
        }
        // A pointset MARKER is not bindable — it is the row a watched point output has
        // BEFORE the compiler synthesizes its preview target (T373). Skipping it routes
        // the node through the idle path below, which registers the sink that makes the
        // recompile materialize the real target — the same dance as an unmaterialized
        // texture (T252).
        /*
         * T601: a component instance has NO output row of its own — flatten replaced it
         * — so its preview is an INNER node's row, addressed by the flat id. The inner
         * node defaults to the node behind the FIRST output socket (the Out node, post
         * T607), and the Common page can point it at ANY inner node (`ui.componentPreview`)
         * — TD's debug-view idiom. The sink pushed back to the compiler uses the same
         * flat id, so the chosen node is what materializes (§V487: all four sites agree).
         */
        const previewTarget = componentPreviewTarget(current, nodeId);
        // T1019: BOTH halves go through the pane's prefix — an instance's inner target,
        // a plain node, and an Out boundary (resolved through to its producer, §B177's
        // shape seen from the inside) all live under the dived chain in the plan.
        const canvasSink =
          previewTarget ?? throughOutputBoundary(current.graph, nodeId, portId);
        const sinkNodeId = flatOf(canvasSink.nodeId);
        const sinkPortId = canvasSink.portId;
        if (sinkNodeId !== nodeId || sinkPortId !== portId) {
          // Keyed by ref's node AND port (T527's lesson): one node can carry two
          // previewable outputs, and a node-scoped map would hand both the last sink.
          flatSinkOf.set(`${nodeId}:${portId}`, { nodeId: sinkNodeId, portId: sinkPortId });
        }
        // T527: an output's identity is PORT-scoped, never node-scoped — the row this
        // slot wants is exactly `sinkNodeId:sinkPortId`. Matching on the node alone took
        // whichever row happened to come first and then bound the tile under THAT row's
        // `output.portId`, so a node with two previewable outputs previewed the wrong
        // one. `compiledOutputs` carries no ordering guarantee, so the port is the match.
        const output = current.compiledOutputs.find(
          (entry) =>
            entry.nodeId === sinkNodeId &&
            entry.portId === sinkPortId &&
            entry.resourceKind !== "pointset",
        );
        // §V111: the offset within the node (never re-measured mid-drag). §V112: the
        // node's LIVE position, read fresh every tick — the two combine into the slot's
        // current graph-space box without a single DOM measurement this frame.
        const offset = current.bounds.get(nodeId);
        const position = current.getNodePosition(nodeId);
        if (output === undefined || offset === undefined || position === undefined) {
          /* T756: the tile is hidden (no measured slot) but the VIEWER is presenting
             this node — without a request its target goes stale and the viewer shows a
             frozen picture nobody can explain. The interest is a PIN through the one
             existing path: same request shape, `pinned: true` (the scheduler's
             keep-alive that already bypasses visibility), an off-surface rect so the
             tile composites nowhere, and the area budgeted like any tile. The preview
             SWITCH still wins: an `on: false` node never reaches this branch (§V297 —
             off means off), so interest revives hidden tiles, never disabled ones. */
          if (
            output !== undefined &&
            current.interest !== undefined &&
            (current.interest.get() === nodeId || current.interest.get() === sinkNodeId)
          ) {
            everMaterialized.add(`${nodeId}:${portId}`);
            const longEdge = Math.max(output.size[0], output.size[1], 1);
            const areaScale = Math.min(1, current.previewLongEdge / longEdge);
            requests.push({
              ref: { nodeId, portId: output.portId },
              source: {
                resourceId: output.resourceId,
                size: output.size,
                format: output.format,
                space: output.space,
              },
              rect: { x: -100000, y: -100000, width: 1, height: 1 },
              area: {
                width: Math.max(1, Math.round(output.size[0] * areaScale)),
                height: Math.max(1, Math.round(output.size[1] * areaScale)),
              },
              visible: false,
              pinned: true,
              collapsed: false,
              occluded: false,
              view: current.views?.viewFor(nodeId) ?? DEFAULT_PREVIEW_VIEW,
              fps: current.previewFps,
              ...(output.synthesis === undefined ? {} : { synthesis: output.synthesis }),
              ...(() => {
                const orbit = current.orbits?.get(nodeId);
                return orbit === undefined ? {} : { orbit };
              })(),
            });
            continue;
          }
          // T252: a visible slot with NO materialized output cannot render yet, but it
          // must still register as a preview sink or it never will — the sink triggers
          // the recompile that materializes it, and the next tick fills the tile.
          if (offset !== undefined && position !== undefined) {
            const box = {
              x: position.x + offset.x,
              y: position.y + offset.y,
              width: offset.width,
              height: offset.height,
            };
            const screen = slotScreenRect(box, viewport);
            const onScreen =
              screen.x < surface.width && screen.y < surface.height && screen.x + screen.width > 0 && screen.y + screen.height > 0;
            if (
              !ungated.has(nodeId) &&
              (onScreen || current.graph.nodes[nodeId]?.ui?.previewPinned === true)
            ) {
              visibleIdle.push({
                ref: { nodeId, portId },
                sink: { nodeId: sinkNodeId, portId: sinkPortId },
                area: Math.max(0, screen.width) * Math.max(0, screen.height),
              });
            }
          }
          idle.push({ ref: { nodeId, portId }, sink: { nodeId: sinkNodeId, portId: sinkPortId } });
          continue;
        }
        // T501: this node HAS a materialized output, so it is a request from here on and
        // competes under the scheduler's stated policy. That is what retires its claim on
        // a first-paint slot — the claim is "has never had a chance", not "is not drawing".
        everMaterialized.add(`${nodeId}:${portId}`);
        const node = current.graph.nodes[nodeId];
        // §V118 — LETTERBOX inside the node's preview area, never stretch to fill it.
        // The area is whatever the user dragged the node to (§V116); the texture's aspect
        // is whatever the graph resolved (§V21), and the two are unrelated. Since T208
        // made the area arbitrary this is no longer a corner case: a stretched preview
        // misrepresents the image on precisely the node someone enlarged to look at it.
        const fitted = fitInsideRegion(offset, output.size);
        const box = {
          x: position.x + offset.x + fitted.x,
          y: position.y + offset.y + fitted.y,
          width: fitted.width,
          height: fitted.height,
        };
        requests.push({
          ref: { nodeId, portId: output.portId },
          // T375 (§V57): `space` travels with the texture. `output` is the compiler's
          // ResolvedOutput, which already carries it — the preview shader is told what it
          // is looking at rather than assuming linear (B47).
          source: {
            resourceId: output.resourceId,
            size: output.size,
            format: output.format,
            space: output.space,
          },
          rect: slotScreenRect(box, viewport),
          // §V142 — where the tile is DRAWN carries the camera; how big the tile is
          // ALLOCATED must not. This is the fitted region measured inside the node's own
          // box, so it is the node's preview area at any zoom (§V117) — and, because it
          // is the LETTERBOXED region, the tile carries the pixels actually shown rather
          // than paying for bars nobody renders.
          area: { width: fitted.width, height: fitted.height },
          visible: true,
          // The PIN (§V28b, T353) — keep the tile alive while the node is scrolled off
          // screen. Not the switch; the switch decided we are here at all.
          pinned: node?.ui?.previewPinned === true,
          collapsed: false,
          occluded: false,
          // §V255/§V70a — the lens lives HERE, on the preview path, and nowhere near the
          // present blit, which stays a raw copy.
          view: current.views?.viewFor(nodeId) ?? DEFAULT_PREVIEW_VIEW,
          fps: current.previewFps,
          // T563: a synthesized preview's draw passes travel with the request — the
          // preview program owns their target and runs them on the preview cadence.
          ...(output.synthesis === undefined ? {} : { synthesis: output.synthesis }),
          // T561: this pane's inspection orbit, when the user has set one.
          ...(() => {
            const orbit = current.orbits?.get(nodeId);
            return orbit === undefined ? {} : { orbit };
          })(),
        });
      }

      const result = system.update({
        requests,
        frame: clock.next(),
        surface,
        devicePixelRatio,
        previewFps: current.previewFps,
        previewLongEdge: current.previewLongEdge,
      });

      // T252: the compiler's preview-sink set = what the scheduler KEEPS, plus the
      // visible slots waiting on materialization (capped so the sink set cannot outrun
      // the tile budget the scheduler enforces).
      const activeSinks = result.schedule.active
        .filter((entry) => !ungated.has(entry.ref.nodeId as string))
        .map((entry) => {
          // T601/T1019: the tile stays keyed to the CANVAS node, but the SINK names
          // the flat plan row — that is what the compiler can materialize.
          const flat = flatSinkOf.get(`${entry.ref.nodeId}:${entry.ref.portId}`);
          return flat === undefined
            ? { nodeId: entry.ref.nodeId as string, portId: entry.ref.portId }
            : { nodeId: flat.nodeId as string, portId: flat.portId };
        });

      /*
       * T501 — FIRST PAINT IS RESERVED, exactly the way §V454 reserves a base.
       *
       * The sink set holds `capacity` refs. It used to be filled with every preview that
       * was ALREADY drawing and then, with whatever was left over, the previews waiting to
       * materialize. Measured on 44 texture nodes + 8 point generators, all on screen and
       * all inside the tile budget: 44/44 textures painted on tick 2, 4/8 point generators
       * painted on tick 2 and the other 4 NEVER painted — not late, never, deterministically,
       * because the leftover was zero on every subsequent tick and the same four lost it.
       *
       * Point/camera/light/material previews take the whole of that damage, and not by
       * anyone's decision: a texture node materializes the moment it is a sink and never
       * re-enters the idle queue, while a synthesized preview does not EXIST until its sink
       * triggers the synthesis — so the idle queue is the only door it has.
       *
       * So the pool is spent in §V454's order: previews that have never had a chance are
       * RESERVED first, then the drawing set spends the rest. The reservation is bounded
       * (`FIRST_PAINT_RESERVE` of the pool) so a burst cannot evict the whole screen, and
       * it is self-cancelling — a preview leaves the queue the moment it materializes,
       * after which the scheduler's stated policy decides whether it draws or reports
       * `suspended`. Both are answers; black-and-silent was not.
       */
      visibleIdle.sort((a, b) => b.area - a.area);
      // First-paint bookkeeping runs on the CANVAS ref (that is what `everMaterialized`
      // records); what goes to the COMPILER is each entry's flat sink (T1019).
      const unpainted = visibleIdle.filter(
        (entry) => !everMaterialized.has(`${entry.ref.nodeId}:${entry.ref.portId}`),
      );
      const reserved = unpainted.slice(0, Math.min(FIRST_PAINT_RESERVE, system.capacity));
      const room = Math.max(0, system.capacity - reserved.length);
      const drawing = activeSinks.slice(0, room);
      const returning = visibleIdle
        .filter((entry) => !reserved.includes(entry))
        .slice(0, Math.max(0, room - drawing.length));
      const asSink = (entry: { sink: { nodeId: NodeId; portId: string } }) => ({
        nodeId: entry.sink.nodeId as string,
        portId: entry.sink.portId,
      });
      current.previewSinks?.set([
        ...reserved.map(asSink),
        ...drawing,
        ...returning.map(asSink),
      ]);

      // Keys that left the graph entirely forget they ever painted; a node that is merely
      // suspended or scrolled away does NOT (§V455 — what a suspended thing reports must
      // not change because the active policy did).
      const candidateKeys = new Set(candidates.map(({ nodeId, portId }) => `${nodeId}:${portId}`));
      for (const key of [...everMaterialized]) {
        if (!candidateKeys.has(key)) everMaterialized.delete(key);
      }

      // T1019 — the state PUBLISHES under the CANVAS ref (the id the node on screen
      // reads), while the FACTS come from the flat plan row the sink resolved to. The
      // old idle loop published under the sink id, which no canvas node listens to —
      // inside a component that was every node, and on an instance it was §B177.
      const factsFor = (ref: { nodeId: string; portId: string }) =>
        facts.get(
          (() => {
            const flat = flatSinkOf.get(`${ref.nodeId}:${ref.portId}`);
            return flat === undefined ? `${ref.nodeId}:${ref.portId}` : `${flat.nodeId}:${flat.portId}`;
          })(),
        );
      for (const entry of result.schedule.active) {
        const found = factsFor(entry.ref);
        current.nodeRuntime.publish(entry.ref.nodeId, {
          preview: {
            output: entry.ref,
            state: { kind: "live" },
            ...(found === undefined ? {} : { facts: found }),
          },
        });
      }
      for (const entry of result.schedule.suspended) {
        const found = factsFor(entry.ref);
        current.nodeRuntime.publish(entry.ref.nodeId, {
          preview: {
            output: entry.ref,
            state: { kind: "suspended", reason: entry.reason },
            ...(found === undefined ? {} : { facts: found }),
          },
        });
      }
      for (const { ref } of idle) {
        const found = factsFor(ref);
        current.nodeRuntime.publish(ref.nodeId, {
          preview: {
            output: ref,
            state: { kind: "idle" },
            ...(found === undefined ? {} : { facts: found }),
          },
        });
      }
      // §V91/§V100 — a switched-off preview names its state rather than going blank, and
      // still shows what the compiler resolved when the node renders for something else.
      // Off with no facts is the honest picture of a node that is now costing nothing.
      for (const { nodeId, portId } of off) {
        const found = factsFor({ nodeId, portId });
        current.nodeRuntime.publish(nodeId, {
          preview: {
            output: { nodeId, portId },
            state: { kind: "off" },
            ...(found === undefined ? {} : { facts: found }),
          },
        });
      }
    };

    const tick = (): void => {
      frameHandle = requestAnimationFrame(tick);
      step();
    };
    /*
     * T620: the rAF loop is the CADENCE, not the only door. Chrome suspends
     * requestAnimationFrame entirely for a hidden or occluded window, and the frame
     * driver, document edits and recompiles all keep running underneath — measured on a
     * plain solid → feedback doc driven through an occluded tab: the sink store and the
     * preview program froze at their last visible state, every structural recompile then
     * diverged from the frozen program, and the preview host warned
     * `binds unknown texture "pingpong:…"` on every retry, once a second, forever. The
     * compile effect below runs ONE step whenever the compiled outputs change, so the
     * program and the sink set converge with the plan even while rAF is parked.
     */
    stepRef.current = step;
    boundaryRef.current = crossDocumentBoundary;
    frameHandle = requestAnimationFrame(tick);

    return () => {
      stepRef.current = null;
      boundaryRef.current = null;
      cancelAnimationFrame(frameHandle);
      system.reset();
      host.dispose();
    };
    // Re-mounted only when the backend instance changes; the `<canvas>` this reads is
    // unconditionally rendered by the caller, so its ref is already attached by the time
    // this effect runs even on the very first mount. Everything else this tick reads is
    // picked up live through `inputsRef` above rather than through the dependency array.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inputs.backend]);

  /*
   * T620's other half: a new plan landed while rAF is parked. Gated on the page being
   * HIDDEN, and both halves of the gate are load-bearing: when the page is visible the
   * next rAF tick picks the plan up anyway, and an extra mid-frame step would advance
   * the preview clock and cadence state between display frames — which is exactly the
   * perturbation that starved T501's reservation dance when this ran unconditionally
   * (four of fifty-two previews never painted). When the page is hidden — a background
   * tab, or a fully occluded window, which Chrome also reports as hidden — this is the
   * ONLY thing keeping the preview program and the sink set in step with the document.
   */
  useEffect(() => {
    if (typeof document !== "undefined" && document.visibilityState === "hidden") {
      stepRef.current?.();
    }
    // The graph too, not just the plan: preview candidates read ui state (the P toggle,
    // the pin), and a ui-only edit moves the document without moving the compiled
    // outputs.
  }, [inputs.compiledOutputs, inputs.graph]);

  /*
   * B143 — the document boundary at COMMIT time, which is the only time early enough.
   *
   * A load schedules `backend.compile` from an effect in the same commit as this one and
   * installs the new main plan when that promise resolves, on a microtask; the preview
   * tick's next rAF is a display frame later. So the boundary must be crossed while the
   * commit is still running, or the closed document's program is what the incoming plan
   * finds installed — see `crossDocumentBoundary` above for what that costs.
   *
   * This runs unconditionally rather than under T620's hidden-page gate because it is not
   * a step: it pushes an empty program and drops per-document state, and touches neither
   * the preview clock nor the cadence state that gate exists to protect.
   */
  useEffect(() => {
    boundaryRef.current?.(inputs.documentIdentity);
  }, [inputs.documentIdentity]);
}
