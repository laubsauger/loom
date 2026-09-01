import type { PresentationHandle, PresentationReport } from "@runtime/backend/backend-types.ts";

/**
 * What the viewer's canvas can say about itself (T739).
 *
 * ## Why this module exists at all
 *
 * The owner reports that the POPPED-OUT viewer does not paint. Nobody in this project can
 * check that claim: the browser environment here has no WebGPU, and Dawn has no DOM, so a
 * floated canvas painting is the one thing no gate can ever assert. T705 hit this wall and
 * said so rather than claiming the paint.
 *
 * So the canvas answers for itself. Everything below is readable from inside the running
 * app, in whichever window the canvas currently lives in, and it collapses to ONE console
 * line — the same move as the boot stamp (`main.tsx`), which turned "is the fix even in
 * the page you are looking at" from an argument into a fact.
 *
 * ## The fork this is FOR
 *
 * "It does not paint" is two completely different bugs wearing one symptom, and the fix
 * for one is not the fix for the other:
 *
 *   - **painting black** — blits ARE being encoded into this surface every frame and the
 *     result is black. The popout machinery works; the source, the blit or the alpha does
 *     not.
 *   - **not painting at all** — no blit reaches this surface. The canvas is inert, or has
 *     no box, or was never configured against the live device.
 *
 * `presentedFrames`/`lastPresentTime` (runtime side) separate those two, and the 1-texel
 * readback (DOM side) says what actually landed on the glass. A verdict that cannot tell
 * them apart would be the ninth reader-that-cannot-see, so `verdict` below is written to
 * name the fork explicitly and never to average across it.
 *
 * ## Why the readback is a `drawImage`, not a GPU copy
 *
 * §V7 says presenting is a blit encoded with the frame, with no readback ever — so this
 * must not touch the present path. Scaling the canvas into a 1×1 2D context is a pure
 * consumer: it costs nothing per frame (it runs on an interval, never in the loop), it
 * needs no `COPY_SRC` usage on the surface, and it reads the DISPLAY-ENCODED pixels the
 * human is looking at rather than the linear target (§V618 — the raw target lies about
 * brightness by roughly a stop and a half, and this number is meant to be read by a
 * person deciding whether their screen is black).
 */

/** A 1-texel average of what is actually on the canvas, in display-encoded sRGB. */
export interface CanvasReadback {
  /** Rec.709 luma of the whole-canvas average, 0..1. */
  readonly luma: number;
  /** Average alpha, 0..1. An opaque-configured surface that reads 0 was never composited. */
  readonly alpha: number;
}

/**
 * Averages the entire canvas into one texel.
 *
 * Returns null when the canvas cannot be sampled at all — a zero-sized backing store
 * (`drawImage` throws on it), or no 2D context. Null is reported as "unreadable" rather
 * than folded into 0.0: "I could not look" and "I looked and it was black" are the exact
 * pair this whole module exists to keep apart.
 */
export function readCanvasTexel(canvas: HTMLCanvasElement): CanvasReadback | null {
  if (canvas.width === 0 || canvas.height === 0) return null;
  const probe = canvas.ownerDocument.createElement("canvas");
  probe.width = 1;
  probe.height = 1;
  const ctx = probe.getContext("2d", { willReadFrequently: true });
  if (ctx === null) return null;
  try {
    ctx.clearRect(0, 0, 1, 1);
    // Scaling W×H into 1×1 is a box filter: this is the MEAN, which is the number T705
    // measured when it found a floated canvas reading 0.0 forever.
    ctx.drawImage(canvas, 0, 0, 1, 1);
    const [r = 0, g = 0, b = 0, a = 0] = ctx.getImageData(0, 0, 1, 1).data;
    return {
      luma: (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255,
      alpha: a / 255,
    };
  } catch {
    // A tainted or zero-sized source. Unreadable, not black.
    return null;
  }
}

/**
 * What the reading MEANS, in the vocabulary of the three suspects T739 names.
 *
 * Ordered by how early in the chain the thing fails, and returned as the FIRST failure
 * found: a canvas with no box has nothing useful to say about its luma.
 */
export type ViewerVerdict =
  /** No presentation handle. `backend.present()` never ran, or it refused (check for the
   *  "presentation attach refused" error above this line). */
  | "no-handle"
  /** The canvas has no laid-out box in its window. T739 suspect (b): the child document
   *  never gave the surface a size, so there is nothing to paint into. */
  | "no-css-box"
  /** The canvas has a box but its backing store collapsed to 1×1 — §V658 exactly, and
   *  T705's original symptom returning by another route. The ResizeObserver in this
   *  canvas's window is not firing. */
  | "store-collapsed"
  /** T739 suspect (a): the handle exists but no WebGPU surface was configured on this
   *  element. A fresh element in the child document that never got a context. */
  | "not-configured"
  /** The surface was configured against a device the backend has since replaced (§V23).
   *  It will never paint again and no error says so. */
  | "stale-device"
  /** Configured, but the output resolves to no source texture — nothing compiled, or the
   *  pinned output was pruned. Not a popout fault. */
  | "no-source"
  /** Everything is attached and NO blit has been encoded into this surface recently.
   *  This is "not painting at all". */
  | "not-presenting"
  /** Blits ARE landing and the glass is black. This is "painting black" — the popout
   *  machinery is fine and the picture is the bug. */
  | "presenting-black"
  /** Blits are landing and the canvas HAS picture. If the owner still sees nothing, the
   *  fault is downstream of every suspect in T739: CSS, stacking, or window compositing. */
  | "presenting"
  /** Attached and presenting, but the pixels could not be sampled. */
  | "presenting-unreadable";

export interface ViewerReading {
  /** Which window the canvas lives in right now. */
  readonly placement: "docked" | "floated";
  readonly cssWidth: number;
  readonly cssHeight: number;
  readonly storeWidth: number;
  readonly storeHeight: number;
  readonly devicePixelRatio: number;
  readonly presentation: PresentationReport | null;
  /** Milliseconds since the last encoded present; null when there has never been one. */
  readonly presentAgeMs: number | null;
  readonly readback: CanvasReadback | null;
  readonly verdict: ViewerVerdict;
}

export interface ViewerProbeInput {
  readonly canvas: HTMLCanvasElement;
  readonly handle: PresentationHandle | null;
  /** The backend's CURRENT device generation, to catch a surface that outlived its device. */
  readonly deviceGeneration: number | null;
  /** The document the app's React root lives in — anything else means the pane is floated. */
  readonly appDocument: Document;
  /** Parent-realm `performance.now()`. Passed in because the backend stamps present times
   *  in that same realm, and a child window's clock has a DIFFERENT time origin — reading
   *  `view.performance` here would silently produce a nonsense age. */
  readonly now: number;
}

/**
 * A present is "recent" if it landed within this many milliseconds.
 *
 * Generous on purpose. The frame loop can be capped well below display rate (T254's cook
 * gate skips frames outright), so a short window would call a healthy low-rate viewer
 * "not presenting" — and a false "not painting at all" sends the reader at the wrong half
 * of the fork this module exists to resolve.
 */
const RECENT_PRESENT_MS = 1000;

export function readViewer(input: ViewerProbeInput): ViewerReading {
  const { canvas, handle, deviceGeneration, appDocument, now } = input;
  const view = canvas.ownerDocument.defaultView;
  const presentation = handle?.describe?.() ?? null;
  const presentAgeMs =
    presentation === null || presentation.lastPresentTime === null
      ? null
      : now - presentation.lastPresentTime;
  const readback = readCanvasTexel(canvas);
  const base = {
    placement: (canvas.ownerDocument === appDocument ? "docked" : "floated") as "docked" | "floated",
    cssWidth: canvas.clientWidth,
    cssHeight: canvas.clientHeight,
    storeWidth: canvas.width,
    storeHeight: canvas.height,
    devicePixelRatio: view?.devicePixelRatio ?? 1,
    presentation,
    presentAgeMs,
    readback,
  };
  return { ...base, verdict: verdictOf(base, handle, deviceGeneration) };
}

function verdictOf(
  reading: Omit<ViewerReading, "verdict">,
  handle: PresentationHandle | null,
  deviceGeneration: number | null,
): ViewerVerdict {
  if (handle === null) return "no-handle";
  if (reading.cssWidth === 0 || reading.cssHeight === 0) return "no-css-box";
  // 1×1 is what §V658 produced: an observer that fired once at clientWidth 0 and never
  // again. Checked against the STORE alone, because a real box with a 1×1 store is the
  // signature regardless of what the box happens to measure.
  if (reading.storeWidth <= 1 && reading.storeHeight <= 1) return "store-collapsed";

  const p = reading.presentation;
  // No `describe` means an older or stubbed handle. Say so by refusing to guess: the
  // pixel reading is still worth something, so fall through to the readback verdicts
  // rather than inventing a runtime-side answer we do not have.
  if (p !== null) {
    if (!p.surfaceConfigured) return "not-configured";
    if (deviceGeneration !== null && p.deviceGeneration !== null && p.deviceGeneration < deviceGeneration) {
      return "stale-device";
    }
    if (!p.sourceBound) return "no-source";
    if (reading.presentAgeMs === null || reading.presentAgeMs > RECENT_PRESENT_MS) {
      return "not-presenting";
    }
  }
  if (reading.readback === null) return "presenting-unreadable";
  // Black is black: an opaque surface reading alpha 0 was never composited either, and
  // both land the reader on the same half of the fork.
  if (reading.readback.luma === 0) return "presenting-black";
  return "presenting";
}

/** One line, in the shape of the boot stamp: prefix, then facts, then the verdict. */
export function formatViewerReading(reading: ViewerReading): string {
  const p = reading.presentation;
  const box = `${reading.cssWidth}x${reading.cssHeight}css ${reading.storeWidth}x${reading.storeHeight}store dpr${reading.devicePixelRatio}`;
  const runtime =
    p === null
      ? "runtime=unavailable"
      : [
          `out=${p.outputId}`,
          `surface=${p.surfaceConfigured ? `gen${p.deviceGeneration ?? "?"}` : "unconfigured"}`,
          `blit=${p.blitReady ? "ready" : "none"}`,
          `source=${p.sourceBound ? "bound" : "none"}`,
          `presents=${p.presentedFrames}`,
          `last=${reading.presentAgeMs === null ? "never" : `${Math.round(reading.presentAgeMs)}ms`}`,
        ].join(" ");
  const pixels =
    reading.readback === null
      ? "pixels=unreadable"
      : `luma=${reading.readback.luma.toFixed(4)} alpha=${reading.readback.alpha.toFixed(2)}`;
  return `viewer[${reading.placement}]: ${box} ${runtime} ${pixels} -> ${reading.verdict}`;
}
