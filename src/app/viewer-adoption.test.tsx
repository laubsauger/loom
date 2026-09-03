// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PaneContent, PaneHostProvider, PaneOutlet, adoptPaneHost } from "./pane-portal.tsx";
import { useOutputPresentation } from "./use-output-presentation.ts";
import type { PresentableCanvas, PresentationHandle } from "@runtime/backend/backend-types.ts";
import type { LoomBackend } from "@runtime/backend/index.ts";

/**
 * T739 suspect (a), as far as it can be answered without WebGPU.
 *
 * §V659 says a WebGPU canvas that was CONFIGURED and then adopted into another document
 * is permanently inert, and that the only escape is a FRESH ELEMENT. T705 shipped that
 * escape — `canvasKey` remounts the canvas on adoption — and then could not check the
 * half that matters: **is the fresh element actually born in the NEW document, and is it
 * actually handed to the runtime to be configured there?** A canvas that remounts but is
 * still created by the OPENER's document, or one that remounts and is never passed to
 * `present()` again, would look exactly like the fix working and paint exactly nothing.
 *
 * That question has no WebGPU in it. It is React, `ownerDocument` and one call, so it can
 * be asserted here even though the PAINT never can be — which is the whole point of
 * splitting it out: the unverifiable part shrinks to the smallest thing it can be.
 *
 * The child document is a real `<iframe>` rather than a bare `createHTMLDocument`,
 * because a popup has its OWN window: `use-output-presentation` reaches for
 * `canvas.ownerDocument.defaultView` to build the per-window ResizeObserver (§V658), and
 * a document with a null `defaultView` would quietly skip the branch under test.
 */

const PANE = "viewer";

function Viewer({ backend }: { backend: LoomBackend }) {
  const { canvasRef, canvasKey } = useOutputPresentation(backend, "out");
  return <canvas key={canvasKey} ref={canvasRef} data-testid="viewer-canvas" />;
}

function Harness({ backend }: { backend: LoomBackend }) {
  return (
    <PaneHostProvider>
      <PaneContent paneId={PANE}>
        <Viewer backend={backend} />
      </PaneContent>
      <PaneOutlet paneId={PANE} />
    </PaneHostProvider>
  );
}

interface Attach {
  readonly canvas: PresentableCanvas;
  disposed: boolean;
}

function fakeBackend() {
  const attaches: Attach[] = [];
  const backend = {
    status: { deviceGeneration: 1 },
    present(canvas: PresentableCanvas): PresentationHandle {
      const record: Attach = { canvas, disposed: false };
      attaches.push(record);
      return {
        id: `present-${attaches.length}`,
        outputId: "out",
        setOutput: () => {},
        dispose: () => {
          record.disposed = true;
        },
      };
    },
  } as unknown as LoomBackend;
  return { backend, attaches };
}

function currentCanvas(): HTMLCanvasElement {
  const found = document.querySelector<HTMLCanvasElement>("[data-testid='viewer-canvas']");
  if (found === null) throw new Error("the viewer canvas is not in the main document");
  return found;
}

/** A second window with a real `defaultView`, standing in for the popped-out one. */
function childWindow(): { root: HTMLElement; doc: Document } {
  const frame = document.createElement("iframe");
  document.body.appendChild(frame);
  const doc = frame.contentDocument;
  if (doc === null) throw new Error("no iframe document");
  const root = doc.createElement("div");
  doc.body.appendChild(root);
  return { root, doc };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe("floating a LIVE viewer — the order that broke it (T705, T739)", () => {
  it("remounts the canvas INTO the child document, not merely remounts it", () => {
    const { backend } = fakeBackend();
    render(<Harness backend={backend} />);
    const before = currentCanvas();
    expect(before.ownerDocument).toBe(document);

    const child = childWindow();
    const host = before.closest("[data-pane-host]");
    if (host === null) throw new Error("the canvas is not inside a pane host");
    act(() => adoptPaneHost(child.root, host as HTMLElement));

    const after = child.doc.querySelector<HTMLCanvasElement>("[data-testid='viewer-canvas']");
    expect(after).not.toBeNull();
    // A fresh ELEMENT is §V659's only escape: the same node carried across would keep
    // answering `getContext` and never paint again, with no error to read.
    expect(after).not.toBe(before);
    // ...and it must have ended up in the child, not been remounted back into the dock.
    //
    // Being honest about what this second assertion is worth: `appendChild` across
    // documents runs the ADOPT algorithm, which rewrites `ownerDocument` for the whole
    // moved subtree — so the stale canvas would report the child document too. It is the
    // IDENTITY check above that proves freshness; this one only proves the fresh element
    // landed in the right window. Together they are the pair §V659 needs.
    expect(after?.ownerDocument).toBe(child.doc);
  });

  it("hands the NEW element to the runtime, so it can be configured where it now lives", () => {
    const { backend, attaches } = fakeBackend();
    render(<Harness backend={backend} />);
    const before = currentCanvas();
    expect(attaches).toHaveLength(1);
    expect(attaches[0]?.canvas).toBe(before);

    const child = childWindow();
    act(() => adoptPaneHost(child.root, before.closest("[data-pane-host]") as HTMLElement));

    // This is suspect (a) in one assertion. A remount that did not re-attach would leave
    // the runtime blitting into the discarded element for ever — the picture would be
    // "not painting at all" while every other signal looked healthy.
    expect(attaches).toHaveLength(2);
    expect(attaches[1]?.canvas).toBe(
      child.doc.querySelector<HTMLCanvasElement>("[data-testid='viewer-canvas']"),
    );
    expect(attaches[1]?.canvas).not.toBe(before);
    // The old surface has to go, or two presentations fight over one output and the
    // dead one keeps a GPU context alive on a detached element.
    expect(attaches[0]?.disposed).toBe(true);
    expect(attaches[1]?.disposed).toBe(false);
  });

  it("docking back re-attaches into the ORIGINAL document, same escape in reverse", () => {
    const { backend, attaches } = fakeBackend();
    render(<Harness backend={backend} />);
    const host = currentCanvas().closest("[data-pane-host]") as HTMLElement;
    const child = childWindow();
    act(() => adoptPaneHost(child.root, host));

    const dock = document.createElement("div");
    document.body.appendChild(dock);
    act(() => adoptPaneHost(dock, host));

    const docked = currentCanvas();
    expect(docked.ownerDocument).toBe(document);
    expect(attaches).toHaveLength(3);
    expect(attaches[2]?.canvas).toBe(docked);
    expect(attaches[1]?.disposed).toBe(true);
  });

  it("says so in the console the moment the viewer is floated (T739)", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const { backend } = fakeBackend();
    render(<Harness backend={backend} />);
    // Docked is SILENT: an instrument that spams normal use gets muted, and then it is
    // not an instrument.
    expect(info.mock.calls.flat().join("\n")).not.toContain("viewer[");

    const child = childWindow();
    act(() => adoptPaneHost(child.root, currentCanvas().closest("[data-pane-host]") as HTMLElement));
    // The reading is async since T1093 (a blind read retries through a PNG encode), so
    // the console line lands a microtask after the float, not inside it.
    await act(async () => {});

    const said = info.mock.calls.flat().join("\n");
    expect(said).toContain("viewer[floated]");
    // The verdict is the line's payload — without it the owner is reading numbers and
    // guessing, which is the state T739 exists to end.
    expect(said).toMatch(/-> (no-handle|no-css-box|store-collapsed|not-configured|stale-device|no-source|not-presenting|presenting-black|presenting|presenting-unreadable)/);
  });

  it("exposes an on-demand reading on the window the canvas is actually in", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const { backend } = fakeBackend();
    render(<Harness backend={backend} />);
    const child = childWindow();
    const frameWindow = (document.querySelector("iframe") as HTMLIFrameElement | null)
      ?.contentWindow as (Window & { loomViewerProbe?: () => Promise<unknown> }) | null;
    act(() => adoptPaneHost(child.root, currentCanvas().closest("[data-pane-host]") as HTMLElement));

    // The owner will have the POPUP's devtools open as often as the parent's, so the
    // function has to be callable from there too. Async since T1093; devtools prints
    // the resolved reading, and the console line still arrives either way.
    expect(typeof frameWindow?.loomViewerProbe).toBe("function");
    await expect(frameWindow?.loomViewerProbe?.()).resolves.toMatchObject({
      placement: "floated",
    });
  });
});
