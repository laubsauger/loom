import { useEffect, useRef } from "react";
import type { RefObject } from "react";
import type { PresentationHandle } from "@runtime/backend/backend-types.ts";
import type { ShaderloomBackend } from "@runtime/backend/index.ts";

/**
 * A presentation surface, handed to the runtime (T87/T161, §V64, §V70).
 *
 * §V64: the surface is handed IN and the runtime owns the presentation — React never
 * encodes GPU work and never owns the swap chain. This hook is the whole of the app side:
 * a canvas element, a size that tracks the box it is laid out in, and one
 * `PresentationHandle` that is repointed rather than recreated when the output changes.
 *
 * ## Why it can be this small
 *
 * §V70 allows N surfaces per compiled output, and the handle survives plan recompiles and
 * device loss — the backend re-establishes every retained presentation on rebuild. So the
 * hook has nothing to re-do on a compile, and nothing to re-do when the pane MOVES:
 * because the canvas element is never remounted (T193), the presentation the viewer
 * opened in the dock is still the live one after the pane is dragged to another zone or
 * floated into its own window. That is what §V64's "opening or closing a pane must not
 * stall the output" looks like from this side, and it is the same machinery multi-window
 * perform mode (T110) needs.
 *
 * ## §V16
 *
 * No state, no per-frame React. The canvas is resized by a `ResizeObserver` writing
 * `width`/`height` directly on the element; the runtime blits into it every frame without
 * this module hearing about it.
 */

export interface OutputPresentation {
  /** Attach to the `<canvas>` the pane renders. */
  readonly canvasRef: RefObject<HTMLCanvasElement | null>;
}

export function useOutputPresentation(
  backend: ShaderloomBackend | null,
  outputId: string | null,
): OutputPresentation {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const handleRef = useRef<PresentationHandle | null>(null);

  // Size the drawing buffer to the laid-out box. A canvas whose backing store never
  // matches its CSS size shows a blurred or clipped image, and a zero-sized one cannot
  // be configured at all — which is why presenting waits for a real measurement.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;
    const view = canvas.ownerDocument.defaultView;
    if (view === null || typeof view.ResizeObserver !== "function") return;

    const resize = () => {
      const ratio = view.devicePixelRatio || 1;
      const width = Math.max(1, Math.round(canvas.clientWidth * ratio));
      const height = Math.max(1, Math.round(canvas.clientHeight * ratio));
      if (canvas.width !== width) canvas.width = width;
      if (canvas.height !== height) canvas.height = height;
    };

    resize();
    const observer = new view.ResizeObserver(resize);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, []);

  // Attach once a backend and an output both exist. Deliberately NOT keyed on the output
  // ITSELF: a new plan renames nothing the surface cares about, and re-attaching would
  // drop and rebuild the canvas's GPU context every recompile.
  const outputRef = useRef(outputId);
  outputRef.current = outputId;
  const hasOutput = outputId !== null;

  useEffect(() => {
    const canvas = canvasRef.current;
    const current = outputRef.current;
    if (backend === null || canvas === null || current === null) return;

    let handle: PresentationHandle;
    try {
      handle = backend.present(canvas, { outputId: current, label: "viewer" });
    } catch {
      // A backend that is disposed, uninitialised or mid-frame refuses the attach. The
      // viewer is a window onto the render, never a reason to take the app down; the
      // backend has already reported the reason on its own diagnostic channel.
      return;
    }
    handleRef.current = handle;
    return () => {
      handleRef.current = null;
      handle.dispose();
    };
  }, [backend, hasOutput]);

  // Repoint rather than re-attach: `setOutput` exists so that pinning a different output
  // does not tear down and rebuild the canvas's GPU context (§V70).
  useEffect(() => {
    if (outputId === null) return;
    handleRef.current?.setOutput(outputId);
  }, [outputId]);

  return { canvasRef };
}
