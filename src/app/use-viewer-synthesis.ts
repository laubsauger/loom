import { useEffect, useRef } from "react";
import type { RefObject } from "react";
import type { ResolvedOutput } from "@compiler/index.ts";
import type { LoomBackend } from "@runtime/backend/index.ts";
import { liveClock } from "@domain/transport/live-clock.ts";
import { DEFAULT_PREVIEW_VIEW, createPreviewSystem } from "@runtime/previews/index.ts";
import type { PreviewRequest, PreviewSystem } from "@runtime/previews/index.ts";
import type { PreviewOrbitStore } from "@editor/viewer/index.ts";

/**
 * §B220 — THE VIEWER'S SECOND PRESENTATION PATH, for the rows the first one cannot reach.
 *
 * ## The defect, and why the one-line version of it is wrong
 *
 * Selecting a camera, light, geometry, material or pointset node in the viewer presented
 * NOTHING. The obvious diagnosis is that `presentationSource` (`vgpu-backend.ts`) looks only
 * in the main program while these rows are preview-owned — and making it search the preview
 * resources too would have found an EMPTY SET and changed nothing. Measured: `vgpu-backend.ts`
 * contains no `previewProgram`, no `previewResources` and no `synthesis`, not one occurrence.
 * The target is not somewhere the backend fails to look. IT DOES NOT EXIST IN THE BACKEND'S
 * WORLD AT ALL.
 *
 * The compiler says so itself (`compile.ts`, T563): "the target and these passes belong to the
 * PREVIEW PROGRAM — the main plan carries neither." So this is not a bug one level below
 * §T1311b's seam; IT IS THAT SEAM — two presentation paths that share the verb `present` and
 * meet nowhere — surfacing as a symptom a user can see.
 *
 * ## What this does instead
 *
 * The path that already renders these rows is the preview system, and it renders them for the
 * node tiles every day. So the viewer joins that path rather than teaching the backend a
 * second one: a `previewHost` on the viewer's own surface, a preview system of capacity one,
 * and a single request covering the whole surface carrying the row's `synthesis`.
 *
 * ⚑ IT IS A SECOND CANVAS, AND THAT IS FORCED RATHER THAN CHOSEN. `useOutputPresentation`
 * claims the viewer's canvas through `backend.present`, and `previewHost` would claim the same
 * WebGPU context. One canvas cannot have two owners, and switching owners on a live canvas is
 * the kind of thing that works until a device loss. The graph background already solved this
 * exact problem the same way (`use-graph-background.ts`, a second canvas one z-layer down), so
 * this is the established shape rather than a new one.
 *
 * ⚑ AND THE SINK IS THE HALF THAT IS EASY TO FORGET. A synthesis row only EXISTS when a
 * preview sink watches the output (§V309 — "off costs nothing: no pass, no target, no bytes").
 * The viewer must therefore ask for it before it can present it, which is why `ViewerPane`
 * registers its selection as a sink and not merely as `interest`. Wiring this hook without
 * that leaves `output.synthesis` permanently undefined and the hook permanently idle — a
 * §V998 half-fix that looks complete from the display side.
 */
export interface ViewerSynthesisInputs {
  readonly backend: LoomBackend | null;
  readonly canvasRef: RefObject<HTMLCanvasElement | null>;
  /**
   * The selected row, when it is one the main program cannot present. Null switches the hook
   * off entirely — no host, no system, no rAF — so an ordinary texture output pays nothing.
   */
  readonly output: ResolvedOutput | null;
  readonly previewFps: number;
  readonly previewLongEdge: number;
  /** Reset on a document boundary, exactly as the other preview consumers do (B143). */
  readonly documentIdentity: string;
  /** The same store the tiles orbit with, so the viewer's gesture reaches this surface. */
  readonly orbits?: PreviewOrbitStore | undefined;
}


/** `exactOptionalPropertyTypes`: an absent orbit must be an ABSENT KEY, never `undefined`. */
function orbitOf(
  current: ViewerSynthesisInputs,
  nodeId: string,
): { orbit?: NonNullable<ReturnType<PreviewOrbitStore["get"]>> } {
  const orbit = current.orbits?.get(nodeId);
  return orbit === undefined ? {} : { orbit };
}

export function useViewerSynthesis(inputs: ViewerSynthesisInputs): void {
  const inputsRef = useRef(inputs);
  inputsRef.current = inputs;
  /* Identity rather than value: the effect re-runs when the hook switches on or off, or when
     the selection moves to a different row, and NOT on every frame's fps/size jitter. */
  const key = inputs.output === null ? null : `${inputs.output.nodeId}:${inputs.output.portId}`;
  const active = inputs.backend !== null && key !== null;

  useEffect(() => {
    if (!active) return;
    const canvas = inputs.canvasRef.current;
    const backend = inputs.backend;
    if (backend === null || canvas === null) return;

    const host = backend.previewHost(canvas);
    const system: PreviewSystem = createPreviewSystem({ host, capacity: 1 });
    /* Refresh cadence only, and seedless for the reason `use-graph-background.ts` records at
       length: this clock reaches no shader. The seed arrives through the main program's shared
       block, which this host binds and only `backend.render()` writes. */
    const clock = liveClock();
    let lastDeviceGeneration = backend.status.deviceGeneration;
    let lastDocumentIdentity = inputsRef.current.documentIdentity;
    let frameHandle = 0;

    const step = (): void => {
      const current = inputsRef.current;
      const output = current.output;
      if (output === null) return;

      /* A device loss or a new document invalidates every tile this system holds. Both are
         the same answer — drop everything and let the next frame rebuild — and both must be
         checked here rather than in a React effect, because neither re-renders (B143, §V23). */
      if (backend.status.deviceGeneration !== lastDeviceGeneration) {
        lastDeviceGeneration = backend.status.deviceGeneration;
        system.reset();
      }
      if (current.documentIdentity !== lastDocumentIdentity) {
        lastDocumentIdentity = current.documentIdentity;
        system.reset();
      }

      const rect = canvas.getBoundingClientRect();
      const width = Math.max(1, Math.round(rect.width));
      const height = Math.max(1, Math.round(rect.height));
      const surface = { x: 0, y: 0, width, height };
      const devicePixelRatio = typeof window === "undefined" ? 1 : window.devicePixelRatio || 1;

      const request: PreviewRequest = {
        ref: { nodeId: output.nodeId, portId: output.portId },
        source: {
          resourceId: output.resourceId,
          size: output.size,
          format: output.format,
          space: output.space,
        },
        // The whole surface: this is the viewer, not a tile in a grid.
        rect: surface,
        area: { width, height },
        visible: true,
        /* Pinned for the same reason the background is: the viewer is showing this row on
           purpose, and there is no scrolling or occlusion here for visibility to gate. */
        pinned: true,
        collapsed: false,
        occluded: false,
        view: DEFAULT_PREVIEW_VIEW,
        fps: current.previewFps,
        ...(orbitOf(current, output.nodeId)),
        ...(output.synthesis === undefined ? {} : { synthesis: output.synthesis }),
      };

      system.update({
        requests: [request],
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
    frameHandle = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(frameHandle);
      system.reset();
      host.dispose();
    };
    // `inputs` is read through `inputsRef` inside the loop; only these change the SYSTEM.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, key, inputs.backend, inputs.canvasRef]);
}
