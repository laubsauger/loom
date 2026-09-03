import { useCallback, useEffect, useRef, useState } from "react";
import { PANE_ADOPTED_EVENT } from "./pane-portal.tsx";
import { formatViewerReading, readViewer } from "./viewer-probe.ts";
import type { ViewerReading } from "./viewer-probe.ts";
import type { PresentationHandle } from "@runtime/backend/backend-types.ts";
import type { LoomBackend } from "@runtime/backend/index.ts";

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
  /** Attach to the `<canvas>` the pane renders. A CALLBACK ref, deliberately: the
   * canvas mounts late (only once an output exists) and remounts on `canvasKey`, and
   * every per-document resource below must follow the ELEMENT, not the component —
   * an effect armed once at mount sees `null` and never arms at all. */
  readonly canvasRef: (canvas: HTMLCanvasElement | null) => void;
  /**
   * T705: key the `<canvas>` element with this. It changes ONLY when the pane crosses
   * documents (float/dock), forcing React to remount the canvas — because a WebGPU
   * canvas that was CONFIGURED and then adopted into another document is permanently
   * inert: `getContext` still answers, `configure` does not throw, and nothing ever
   * paints (measured live — a floated viewer read 0.0 mean luma at full size). A
   * canvas that reaches its new document unconfigured presents fine, so the escape is
   * a fresh element, not a re-attach. T193's "the canvas is never remounted" survives
   * with exactly this one exception, where the alternative is a dead picture.
   */
  readonly canvasKey: number;
}

export function useOutputPresentation(
  backend: LoomBackend | null,
  outputId: string | null,
): OutputPresentation {
  const [canvasEl, setCanvasEl] = useState<HTMLCanvasElement | null>(null);
  const canvasRef = useCallback((canvas: HTMLCanvasElement | null) => setCanvasEl(canvas), []);
  const handleRef = useRef<PresentationHandle | null>(null);
  /**
   * T705: bumped when the pane's host crosses DOCUMENTS, so the presentation effect
   * below re-runs. The surface configured in the dock does not survive the canvas
   * being adopted into a floated window's document — the picture goes black with the
   * element intact — so the handle is disposed and re-attached against the canvas in
   * its new home. Rare by construction (a user float/dock), so a state tick is cheap.
   */
  const [epoch, setEpoch] = useState(0);

  // Size the drawing buffer to the laid-out box. A canvas whose backing store never
  // matches its CSS size shows a blurred or clipped image, and a zero-sized one cannot
  // be configured at all — which is why presenting waits for a real measurement.
  useEffect(() => {
    const canvas = canvasEl;
    if (canvas === null) return;

    /*
     * T705 — sizing and liveness are both per DOCUMENT, so both re-arm on adoption.
     *
     * A ResizeObserver is a per-window object: when the viewer pane floats, the dock
     * window's observer fires one final time mid-detach (clientWidth 0 → a 1×1
     * backing store → the popped-out viewer read as an empty page with the right
     * title) and then never fires again for an element living in the child document.
     * And a CONFIGURED WebGPU canvas dies outright on adoption (see `canvasKey`).
     *
     * The pane host — the one element that travels with the content through every
     * relocation (§V96) — dispatches PANE_ADOPTED_EVENT when adoption crossed
     * documents. That bumps the epoch: React remounts the canvas (fresh element in
     * the new document), THIS effect re-runs against it, and the observer it arms
     * belongs to the canvas's current window, docked or floated, either direction.
     */
    const view = canvas.ownerDocument.defaultView;
    let observer: ResizeObserver | null = null;
    if (view !== null && typeof view.ResizeObserver === "function") {
      const resize = () => {
        const ratio = view.devicePixelRatio || 1;
        const width = Math.max(1, Math.round(canvas.clientWidth * ratio));
        const height = Math.max(1, Math.round(canvas.clientHeight * ratio));
        if (canvas.width !== width) canvas.width = width;
        if (canvas.height !== height) canvas.height = height;
      };
      resize();
      observer = new view.ResizeObserver(resize);
      observer.observe(canvas);
    }

    const adopted = () => setEpoch((tick) => tick + 1);
    const host = canvas.closest("[data-pane-host]");
    host?.addEventListener(PANE_ADOPTED_EVENT, adopted);
    return () => {
      host?.removeEventListener(PANE_ADOPTED_EVENT, adopted);
      observer?.disconnect();
    };
  }, [canvasEl]);

  // Attach once a backend and an output both exist. Deliberately NOT keyed on the output
  // ITSELF: a new plan renames nothing the surface cares about, and re-attaching would
  // drop and rebuild the canvas's GPU context every recompile.
  const outputRef = useRef(outputId);
  outputRef.current = outputId;
  const hasOutput = outputId !== null;

  useEffect(() => {
    const canvas = canvasEl;
    const current = outputRef.current;
    if (backend === null || canvas === null || current === null) return;

    let handle: PresentationHandle;
    try {
      handle = backend.present(canvas, { outputId: current, label: "viewer" });
    } catch (error) {
      // A backend that is disposed, uninitialised or mid-frame refuses the attach. The
      // viewer is a window onto the render, never a reason to take the app down — but
      // a swallowed refusal is how "the viewer is black and nothing says why" ships
      // (§V469), so the reason goes to the console with its cause attached.
      console.error("viewer: presentation attach refused", error);
      return;
    }
    handleRef.current = handle;
    return () => {
      handleRef.current = null;
      handle.dispose();
    };
  }, [backend, hasOutput, canvasEl]);

  // Repoint rather than re-attach: `setOutput` exists so that pinning a different output
  // does not tear down and rebuild the canvas's GPU context (§V70).
  useEffect(() => {
    if (outputId === null) return;
    handleRef.current?.setOutput(outputId);
  }, [outputId]);

  /*
   * T739 — the canvas reports its own state.
   *
   * "The popped-out viewer does not paint" cannot be verified by anyone working on this
   * project: there is no WebGPU in our browser environment and no DOM in Dawn, so a
   * floated canvas painting is unobservable from here in both directions. Rather than
   * infer it, the running app says it — `viewer-probe.ts` explains the fork.
   *
   * WHERE IT LOGS: the parent window's console, always, because that is the devtools the
   * owner already has open and where the boot stamp lands. WHEN: on an interval only
   * while the canvas lives in ANOTHER document — the floated case, the one under
   * suspicion — so ordinary docked use stays silent. And on demand in either case
   * through a function installed on whichever window the canvas is in, so the docked
   * baseline is one call away.
   */
  useEffect(() => {
    const canvas = canvasEl;
    if (canvas === null) return;
    const view = canvas.ownerDocument.defaultView;

    const read = (): Promise<ViewerReading> =>
      readViewer({
        canvas,
        handle: handleRef.current,
        deviceGeneration: backend?.status.deviceGeneration ?? null,
        appDocument: document,
        // The parent realm's clock: the backend stamps present times with it, and a
        // child window's `performance` has its own time origin.
        now: performance.now(),
      });

    // Async since T1093: a blind `drawImage` makes the probe retry through a PNG
    // encode (§V897), so the reading is a promise and the console line lands when it
    // resolves — still one line, still on demand.
    const probe = async (): Promise<ViewerReading> => {
      const reading = await read();
      console.info(formatViewerReading(reading));
      return reading;
    };

    const floated = canvas.ownerDocument !== document;
    const holder = view as (Window & { loomViewerProbe?: () => Promise<ViewerReading> }) | null;
    if (holder !== null) holder.loomViewerProbe = probe;

    if (!floated) {
      return () => {
        if (holder?.loomViewerProbe === probe) delete holder.loomViewerProbe;
      };
    }

    console.info(
      "viewer: floated — reporting every 2s below; call loomViewerProbe() in either window for a reading now",
    );
    // The parent's timer on purpose: a child window that is throttled or mid-teardown
    // still gets reported on, and the interval dies with this effect either way.
    const timer = window.setInterval(() => void probe(), 2000);
    void probe();
    return () => {
      window.clearInterval(timer);
      if (holder?.loomViewerProbe === probe) delete holder.loomViewerProbe;
    };
  }, [backend, canvasEl]);

  return { canvasRef, canvasKey: epoch };
}
