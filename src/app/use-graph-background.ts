import { useEffect, useRef } from "react";
import type { RefObject } from "react";
import type { GraphDocument } from "@domain/types/graph.ts";
import type { ResolvedOutput } from "@compiler/index.ts";
import type { LoomBackend } from "@runtime/backend/index.ts";
import { liveClock } from "@domain/transport/live-clock.ts";
import {
  DEFAULT_PREVIEW_VIEW,
  EMPTY_PREVIEW_PROGRAM,
  createPreviewSystem,
} from "@runtime/previews/index.ts";
import type { PreviewRequest, PreviewSystem } from "@runtime/previews/index.ts";

/**
 * The graph BACKGROUND (T463): every node flagged `ui.background` renders behind the
 * patch — TD's network background, the way a lot of people actually work.
 *
 * It reuses more than it builds. The pane already owns a full-surface GPU canvas for
 * node previews (T185); this is the same preview system on a SECOND canvas, one
 * z-layer down — beneath the nodes, above the dot grid (`graph-canvas.tsx` renders it
 * next to React Flow's own Background, in the same negative-z stacking slot). Marking
 * a node IS watching it, so the refs join T252's preview-sink set: one materialization
 * shared with any tile or viewer already watching, zero cost when nothing is flagged.
 * Full brightness, the owner's call — TD does not dim its network background either;
 * if a dim ever returns it is CSS opacity on the canvas (per-person chrome), never a
 * touch on the pixels an export or viewer sees.
 *
 * The image letterboxes into the pane (§V118: never stretch — a background that
 * misrepresents aspect is worse than bars). SEVERAL marked nodes TILE it (T677): a
 * best-fit grid, each image letterboxed into its own cell, so they share the space
 * without one hiding another and without any of them being stretched or cropped.
 */

/**
 * Backgrounds are behind everything, so a handful is already a light show. T677 raises
 * this 4 → 8 because the cost changed with the layout: a stack of full-pane backgrounds
 * paid pane-sized rasterisation N times over, while eight TILES divide the same pane
 * between them — the total area is the pane either way, and the reason to keep a ceiling
 * at all is the per-preview bookkeeping rather than the pixels.
 */
const BACKGROUND_TILE_CAPACITY = 8;

/** Refresh a background at preview cadence — it is ambience, not the picture. */
export interface GraphBackgroundInputs {
  readonly backend: LoomBackend | null;
  readonly canvasRef: RefObject<HTMLCanvasElement | null>;
  readonly graph: GraphDocument;
  readonly compiledOutputs: ReadonlyArray<ResolvedOutput>;
  /** T252 (§V158): the same sink set the tile scheduler feeds — refs merge. */
  readonly previewSinks?: { set(refs: ReadonlyArray<{ nodeId: string; portId: string }>): void };
  readonly previewFps: number;
  readonly previewLongEdge: number;
  /** Which DOCUMENT is open — see the same field on `NodePreviewInputs` (T519, B106). */
  readonly documentIdentity: string;
}

/** The marked nodes, in document order — exported for the wiring test. */
export function graphBackgroundMarks(
  graph: GraphDocument,
  outputs: ReadonlyArray<ResolvedOutput>,
): Array<{ nodeId: string; output: ResolvedOutput | undefined }> {
  return Object.keys(graph.nodes)
    .sort()
    .filter((nodeId) => graph.nodes[nodeId]?.ui?.background === true)
    .map((nodeId) => ({
      nodeId,
      /*
       * The `pointset` exclusion is LOAD-BEARING, and it is not a refusal to draw point
       * nodes — it is what makes them draw. A pointset MARKER is not bindable (T121):
       * it is the row a point output has BEFORE a preview sink makes the compiler
       * synthesize its splat target (T373). Skipping it leaves `output` undefined, which
       * routes the mark through the not-yet-materialized branch below — the branch that
       * registers the sink that triggers the recompile that replaces the marker with a
       * real `target` row carrying `synthesis`. Take the marker instead and the tile
       * binds a resource no plan has, which is the same black background by a different
       * road. Same filter, same reason, as `use-node-previews.ts`.
       */
      output: outputs.find(
        (entry) => entry.nodeId === nodeId && entry.resourceKind !== "pointset",
      ),
    }));
}

/** §V118: letterbox the output inside the surface, centred — never stretched. */
export function backgroundRect(
  surface: { width: number; height: number },
  size: readonly [number, number],
): { x: number; y: number; width: number; height: number } {
  const scale = Math.min(surface.width / Math.max(size[0], 1), surface.height / Math.max(size[1], 1));
  const width = size[0] * scale;
  const height = size[1] * scale;
  return { x: (surface.width - width) / 2, y: (surface.height - height) / 2, width, height };
}

/**
 * T677 — SEVERAL marked nodes TILE the pane instead of stacking on top of each other.
 * The owner's ask, verbatim: "tile them to have them share the space thats there without
 * changing their aspect or cropping things. just like TD does it".
 *
 * BEST-FIT GRID, not a fixed column count, and that is the whole design decision. For
 * each possible row count the column count follows (`ceil(n / rows)`), the tile width is
 * whichever of the pane's two constraints binds — `min(W / cols, (H / rows) · aspect)` —
 * and the layout that makes the tile BIGGEST wins. A fixed column count is what produces
 * the small-tiles-with-large-margins result people recognise as wrong: two items in a
 * wide pane want one row, four want two, and no constant serves both.
 *
 * Aspect and cropping are handled by construction rather than by care. The grid is sized
 * from the items' aspect, so in the ordinary case the cell and the image are the same
 * shape and there is no residue at all; and each image is then LETTERBOXED into its own
 * cell through `backgroundRect`, so an item whose aspect differs — a per-node resolution
 * override (§V50) is enough to do it — gets bars rather than a stretch or a crop. There
 * is no code path here that can scale the two axes differently.
 *
 * The MEDIAN aspect picks the grid, not the first item's: one node with an override
 * should not choose the layout for the rest. A short final row is centred against the
 * rows above it, which is what "shares the space" looks like when n is not a multiple of
 * the column count.
 *
 * n = 1 returns exactly what `backgroundRect` returned before this existed — the same
 * call, not an equivalent one — so a single background is untouched (§V309).
 */
export function backgroundTiles(
  surface: { width: number; height: number },
  sizes: ReadonlyArray<readonly [number, number]>,
): Array<{ x: number; y: number; width: number; height: number }> {
  const count = sizes.length;
  if (count === 0) return [];
  if (count === 1) return [backgroundRect(surface, sizes[0]!)];

  const aspects = sizes.map((size) => Math.max(size[0], 1) / Math.max(size[1], 1)).sort((a, b) => a - b);
  const aspect = aspects[(aspects.length - 1) >> 1] ?? 1;

  let best = { rows: 1, columns: count, tileWidth: -1 };
  for (let rows = 1; rows <= count; rows += 1) {
    const columns = Math.ceil(count / rows);
    const tileWidth = Math.min(surface.width / columns, (surface.height / rows) * aspect);
    if (tileWidth > best.tileWidth) best = { rows, columns, tileWidth };
  }

  const { rows, columns, tileWidth } = best;
  const tileHeight = tileWidth / aspect;
  const originY = (surface.height - rows * tileHeight) / 2;
  return sizes.map((size, index) => {
    const row = Math.floor(index / columns);
    const column = index - row * columns;
    const inThisRow = Math.min(columns, count - row * columns);
    const originX = (surface.width - inThisRow * tileWidth) / 2;
    const cell = { width: tileWidth, height: tileHeight };
    const inner = backgroundRect(cell, size);
    return {
      x: originX + column * tileWidth + inner.x,
      y: originY + row * tileHeight + inner.y,
      width: inner.width,
      height: inner.height,
    };
  });
}

export function useGraphBackground(inputs: GraphBackgroundInputs): void {
  const inputsRef = useRef(inputs);
  inputsRef.current = inputs;
  /** The live tick body, for the T634 hidden-page resync below. Null while not mounted. */
  const stepRef = useRef<(() => void) | null>(null);
  /** The live document-boundary body, for the B143 effect below. Null while not mounted. */
  const boundaryRef = useRef<((identity: string) => void) | null>(null);

  useEffect(() => {
    const canvas = inputs.canvasRef.current;
    const backend = inputs.backend;
    if (backend === null || canvas === null) return;

    const host = backend.previewHost(canvas);
    const system: PreviewSystem = createPreviewSystem({ host, capacity: BACKGROUND_TILE_CAPACITY });
    /**
     * T742 — and this one deliberately does NOT opt into `presenting` (T740, §V724).
     *
     * Not an oversight, and written down so it does not get "fixed": the node previews
     * next door DO opt in, because a preview and the viewer show the same node at the
     * same moment and a throttled machine would otherwise draw it at two different
     * times. The background has no such neighbour. It is AMBIENT — there is nothing on
     * screen to compare its rate against and nobody times it — so the fixed step is both
     * correct and the cheaper of the two, and the default (§V662's safe direction) is
     * already the right answer.
     *
     * T1104 — and it is deliberately SEEDLESS too, which is the other thing that looks like
     * a bug here. This clock is REFRESH CADENCE ONLY and reaches no shader: its frame is
     * read exactly twice, at `previews/system.ts:111` and `previews/schedule.ts:300`, and
     * only for `timeSeconds`; `PreviewFrameCommand` carries neither time nor seed. The seed
     * arrives instead through the MAIN PROGRAM'S SHARED BLOCK, which this host binds
     * (`vgpu-backend.ts:1380`) and only `backend.render()` writes — so the background
     * already draws at the document's seed, and passing one in here would change no pixel.
     * Traced three times now; the trace lives in §T1104.
     */
    const clock = liveClock();
    let lastDeviceGeneration = backend.status.deviceGeneration;
    let lastDocumentIdentity = inputsRef.current.documentIdentity;
    let frameHandle = 0;

    /**
     * T519/B106 — the background tile is keyed by node id like every other preview.
     *
     * B143 — and so is the program the BACKEND still has installed, which `system.reset()`
     * does not touch. The incoming main plan installs first (`backend.compile` resolves on
     * a microtask, the next rAF is a display frame away), so without this push the closed
     * document's program is rebuilt against it and reports one true
     * `backend/unknown-resource` per background tile the new document has no node for. Same
     * boundary, same rule, same fix as `use-node-previews.ts` — see the long note there.
     */
    const crossDocumentBoundary = (identity: string): void => {
      if (identity === lastDocumentIdentity) return;
      lastDocumentIdentity = identity;
      host.setPreviewProgram(EMPTY_PREVIEW_PROGRAM);
      system.reset();
    };

    const step = (): void => {
      if (backend.status.deviceGeneration !== lastDeviceGeneration) {
        lastDeviceGeneration = backend.status.deviceGeneration;
        system.reset();
      }

      const current = inputsRef.current;
      // The commit-time effect below normally gets here first; this is the same call, for
      // the case where it did not (a load that never re-rendered this pane).
      crossDocumentBoundary(current.documentIdentity);
      const marks = graphBackgroundMarks(current.graph, current.compiledOutputs);
      // Marking IS watching (T252): the refs keep their nodes materialized. The sink
      // store merges callers, so this coexists with the tile scheduler's own set.
      if (marks.length > 0) {
        current.previewSinks?.set(
          marks
            .map((mark) => mark.output)
            .filter((output): output is ResolvedOutput => output !== undefined)
            .map((output) => ({ nodeId: output.nodeId, portId: output.portId }))
            .concat(
              // Not yet materialized: register by the node's first port anyway — the
              // sink is what triggers the recompile that materializes it (T252).
              marks
                .filter((mark) => mark.output === undefined)
                .map((mark) => ({ nodeId: mark.nodeId, portId: "out" })),
            ),
        );
      }

      const rect = canvas.getBoundingClientRect();
      const surface = { x: 0, y: 0, width: rect.width, height: rect.height };
      const devicePixelRatio = typeof window === "undefined" ? 1 : window.devicePixelRatio || 1;

      // T677: the DRAWN backgrounds are the materialized ones, so the grid is sized on
      // those alone — a marked node still waiting on its recompile must not hold a cell
      // open and shrink everything else for a frame.
      const drawn = marks
        .map((mark) => mark.output)
        .filter((output): output is ResolvedOutput => output !== undefined);
      const tiles = backgroundTiles(surface, drawn.map((output) => output.size));

      const requests: PreviewRequest[] = [];
      for (const [index, output] of drawn.entries()) {
        requests.push({
          ref: { nodeId: output.nodeId, portId: output.portId },
          source: {
            resourceId: output.resourceId,
            size: output.size,
            format: output.format,
            space: output.space,
          },
          rect: tiles[index]!,
          area: { width: Math.round(surface.width), height: Math.round(surface.height) },
          visible: true,
          // A background is deliberately always on while marked — scrolling the graph
          // never scrolls it away, so there is nothing for visibility to gate.
          pinned: true,
          collapsed: false,
          occluded: false,
          view: DEFAULT_PREVIEW_VIEW,
          fps: current.previewFps,
          /*
           * T563/§V521 — a SYNTHESIZED background draws itself, and this is the only
           * thing that lets it.
           *
           * A pointset (and a camera, light, geometry, material or projector) has no
           * texture anywhere in it: the compiler hands the row a `synthesis` block, and
           * the PREVIEW PROGRAM — not the main plan — owns the target those passes
           * render into, sized to the granted tile. Drop it here and the lens pass below
           * samples a resource that exists in neither the plan nor the program: one true
           * `backend/unknown-resource` per marked node, and a background that stays black
           * while every texture node beside it works. That is exactly what the owner met
           * on the laser path and the point generators.
           *
           * The tile keeps the SOURCE's aspect (`tileSizeFor` derives it from
           * `source.size`, which T663 already nominates at the project's shape), so the
           * splat is drawn at the same aspect it is letterboxed into (§V118) and the pane
           * being square, wide or tall cannot stretch it. Nothing new is decided here:
           * this is the same spread `use-node-previews.ts` has carried since T563 — the
           * background was the one caller that never got it.
           */
          ...(output.synthesis === undefined ? {} : { synthesis: output.synthesis }),
        });
      }

      system.update({
        requests,
        frame: clock.next(),
        surface,
        devicePixelRatio,
        previewFps: current.previewFps,
        previewLongEdge: current.previewLongEdge,
      });
    };

    const tick = (): void => {
      frameHandle = requestAnimationFrame(tick);
      step();
    };
    // T634 (T620's audit): the rAF loop is the cadence, not the only door — Chrome
    // suspends rAF for a hidden or occluded window while edits and recompiles keep
    // running, and this hook maintains preview sinks (marking IS watching, T252) and a
    // preview program, both of which must follow the document. See use-node-previews.
    stepRef.current = step;
    boundaryRef.current = crossDocumentBoundary;
    frameHandle = requestAnimationFrame(tick);
    return () => {
      stepRef.current = null;
      boundaryRef.current = null;
      cancelAnimationFrame(frameHandle);
      host.dispose();
    };
    // The ref carries per-tick inputs; the effect re-runs only for a new surface/backend.
  }, [inputs.backend, inputs.canvasRef]);

  // One resync step per landed plan while the page is hidden — rAF covers the visible
  // case one frame later anyway (see the gate's rationale in use-node-previews.ts).
  useEffect(() => {
    if (typeof document !== "undefined" && document.visibilityState === "hidden") {
      stepRef.current?.();
    }
    // The graph too, not just the plan: a mark is ui state, and a ui-only edit moves
    // the document without moving the compiled outputs.
  }, [inputs.compiledOutputs, inputs.graph]);

  // B143 — the document boundary at COMMIT time, before the incoming main plan installs.
  // Unconditional, unlike the hidden-page gate above: this is not a step, so it moves no
  // cadence state. Rationale in full in `use-node-previews.ts`.
  useEffect(() => {
    boundaryRef.current?.(inputs.documentIdentity);
  }, [inputs.documentIdentity]);
}
