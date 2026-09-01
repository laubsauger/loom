// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PaneHostProvider } from "./pane-portal.tsx";
import { FloatingPane } from "./pane-window.tsx";
import { CHILD_FRAME_DEADLINE_MS, formatChildMount, readChildMount } from "./pane-window-trace.ts";
import type { PaneWindow } from "./pane-window.tsx";

/**
 * T774 — SILENCE MUST BE DIAGNOSABLE.
 *
 * The defect these tests exist for is not a rendering bug, it is an EVIDENCE bug. T739
 * shipped a probe that logs from the mounted pane, so when the owner reported "an empty
 * about blank screen with nothing" and pasted no `viewer[floated]:` line, that absence
 * meant four incompatible things at once: a stale tab predating the fix, a mount that
 * failed, an instrument that never shipped, or a healthy float that had not ticked yet.
 * No fix can be chosen while the evidence is ambiguous, so removing the ambiguity comes
 * first — and these tests assert the property that removes it: **every step of the float
 * prints, so the LAST line printed names the step that did not complete.**
 *
 * They would all still pass against a viewer that paints pure black, and that is correct.
 * Nobody in this project can assert a popped-out canvas paints — no WebGPU in this
 * environment, no DOM in Dawn (T739, T705). What is assertable is the layer the owner's
 * new wording moved suspicion to: document, adoption, styling, box, frames.
 */

const PANE = "viewer";

interface FakeChild extends PaneWindow {
  /** Swap the window's CURRENT document, the way a browser replacing a popup's initial
   *  `about:blank` would — T774's fourth suspect, made reproducible. */
  replaceDocument(next: Document): void;
  /** Deliver the frame the child was asked for. Never calling it is a window that renders
   *  nothing, which is the state no parent-side check can detect on its own. */
  flushFrame(): void;
  readonly view: Window;
  readonly childLines: string[];
}

function fakeChild(): FakeChild {
  const frame = document.createElement("iframe");
  document.body.appendChild(frame);
  const initial = frame.contentDocument;
  const view = frame.contentWindow;
  if (initial === null || view === null) throw new Error("no iframe realm");

  const childLines: string[] = [];
  // The child's own console, distinct from the parent's — the fan-out is only meaningful
  // if the two are actually separate sinks.
  Object.defineProperty(view, "console", {
    configurable: true,
    value: { info: (line: string) => childLines.push(line) },
  });

  const frames: (() => void)[] = [];
  Object.defineProperty(view, "requestAnimationFrame", {
    configurable: true,
    value: (callback: () => void) => frames.push(callback),
  });
  Object.defineProperty(view, "cancelAnimationFrame", { configurable: true, value: () => {} });

  let current: Document = initial;
  return {
    get document() {
      return current;
    },
    addEventListener: () => {},
    removeEventListener: () => {},
    close: () => {},
    replaceDocument: (next) => {
      current = next;
    },
    flushFrame: () => {
      for (const callback of frames.splice(0)) callback();
    },
    view,
    childLines,
  };
}

function stageOf(line: string): string | null {
  const match = /^float\[[^\]]+\] ([a-z-]+):/.exec(line);
  return match?.[1] ?? null;
}

function floatLines(spy: ReturnType<typeof vi.spyOn>): string[] {
  return spy.mock.calls
    .map((call) => String(call[0]))
    .filter((line) => line.startsWith(`float[${PANE}]`));
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("T774 — the float traces its own mount", () => {
  it("prints every step from BEFORE the opener runs, so the last line names the gap", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const child = fakeChild();

    render(
      <PaneHostProvider>
        <FloatingPane paneId={PANE} title="viewer" onClose={() => {}} open={() => child} />
      </PaneHostProvider>,
    );

    const stages = floatLines(info).map(stageOf);
    // `requested` FIRST and unconditionally: it is emitted before the opener is called, so
    // "nothing at all in the console" can only mean the float was never requested — which
    // is the one reading the old instrument could not offer.
    expect(stages.slice(0, 4)).toEqual(["requested", "opened", "prepared", "adopted"]);
  });

  /**
   * What the trace found on its FIRST run, now a guard.
   *
   * The trace printed `body=2` for the child document under StrictMode. `window.open`
   * reuses a window by NAME (§V334, B51) and StrictMode runs mount → cleanup → mount, so
   * mount B appended a second root beside mount A's and nothing removed the first. Two
   * `height: 100%` children of a `100vh`, `overflow: hidden` body means the EMPTY one
   * fills the window and clips the live one out of view: the owner's "empty screen with
   * nothing", with the pane mounted correctly inside it the whole time — which is exactly
   * why no canvas-level probe could ever have seen it.
   *
   * StrictMode is not decoration here. A single-mount test passes against the broken code.
   */
  it("leaves exactly ONE root in the child body across StrictMode's double mount", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const child = fakeChild();
    // The browser's own semantics: a live window with that name is REUSED, never stacked.
    render(
      <StrictMode>
        <PaneHostProvider>
          <FloatingPane paneId={PANE} title="viewer" onClose={() => {}} open={() => child} />
        </PaneHostProvider>
      </StrictMode>,
    );
    // The orphan is dropped in a microtask, after the next mount has adopted the pane.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const roots = child.document.querySelectorAll("[data-pane-window-root]");
    expect(roots.length, "a second root div would clip the live pane out of the window").toBe(1);
    expect(roots[0]?.childElementCount, "the surviving root is the LIVE one").toBeGreaterThan(0);
  });

  it("says the popup was blocked instead of leaving the click looking like a no-op", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});

    render(
      <PaneHostProvider>
        <FloatingPane paneId={PANE} title="viewer" onClose={() => {}} open={() => null} />
      </PaneHostProvider>,
    );

    expect(floatLines(info).map(stageOf)).toEqual(["requested", "blocked"]);
  });

  it("reports to the CHILD's own console as well as the parent's", () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const child = fakeChild();

    render(
      <PaneHostProvider>
        <FloatingPane paneId={PANE} title="viewer" onClose={() => {}} open={() => child} />
      </PaneHostProvider>,
    );

    // If the child window is showing nothing, its console is the only one that can speak
    // for it, and it is a window the owner can open devtools on. `requested` happens
    // before there is a child, so the child's log starts at `opened`.
    expect(child.childLines.map(stageOf)).toEqual(["opened", "prepared", "adopted"]);
  });

  /**
   * The one fact the parent cannot derive.
   *
   * From the parent, a child window that mounted and renders and one that mounted and
   * never paints a single frame are indistinguishable: the DOM reads identically in both.
   * So the parent asks the child realm for one `requestAnimationFrame` and puts a deadline
   * on it in ITS OWN timer — a child that is not rendering may not be running timers
   * either, and a deadline that needs the child to fire is no deadline at all.
   */
  it("names a child that never renders a frame, rather than going quiet", async () => {
    vi.useFakeTimers();
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const child = fakeChild();

    render(
      <PaneHostProvider>
        <FloatingPane paneId={PANE} title="viewer" onClose={() => {}} open={() => child} />
      </PaneHostProvider>,
    );

    await act(async () => {
      vi.advanceTimersByTime(CHILD_FRAME_DEADLINE_MS + 10);
    });

    expect(floatLines(info).map(stageOf)).toContain("child-silent");
    expect(floatLines(info).map(stageOf)).not.toContain("child-frame");
  });

  it("confirms a child that DOES render, from the child's own frame callback", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const child = fakeChild();

    render(
      <PaneHostProvider>
        <FloatingPane paneId={PANE} title="viewer" onClose={() => {}} open={() => child} />
      </PaneHostProvider>,
    );

    await act(async () => {
      child.flushFrame();
    });

    const frame = floatLines(info).find((line) => stageOf(line) === "child-frame");
    expect(frame, "the child's frame callback did not report back").toBeDefined();
    expect(frame).toContain("frames=1");
  });

  /**
   * T774's fourth suspect, as far as it can be reproduced without a browser.
   *
   * Everything is appended to the document the opener handed back. If the browser then
   * replaces that document, every parent-side check still passes — the root is connected,
   * the host is inside it — while the window on screen shows an empty page. Only comparing
   * the window's CURRENT document against the one this mount prepared can catch it, and
   * this is the test that keeps that comparison from being deleted as redundant.
   */
  it("names a replaced child document instead of reading it as a paint fault", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const child = fakeChild();

    render(
      <PaneHostProvider>
        <FloatingPane paneId={PANE} title="viewer" onClose={() => {}} open={() => child} />
      </PaneHostProvider>,
    );

    child.replaceDocument(document.implementation.createHTMLDocument("about:blank"));
    const trace = (window as Window & { shaderloomPaneTrace?: () => unknown }).shaderloomPaneTrace;
    expect(trace, "no on-demand trace was installed on the parent window").toBeDefined();
    await act(async () => {
      trace?.();
    });

    const last = floatLines(info).at(-1) ?? "";
    expect(last).toContain("-> document-replaced");
  });
});

/**
 * §V731 — the payload is the VERDICT, and verdicts carry PRECEDENCE.
 *
 * Fields alone let a reader pick whichever story they arrived with. These pin the ORDER,
 * because each of these states has a downstream symptom that would send the reader at the
 * wrong layer: an unstyled child also has a collapsed box, and a document that was thrown
 * away also has a detached root.
 */
describe("T774 — verdict precedence", () => {
  function scene(options: { readonly width?: number; readonly background?: string } = {}) {
    const frame = document.createElement("iframe");
    document.body.appendChild(frame);
    const doc = frame.contentDocument;
    if (doc === null) throw new Error("no iframe document");
    doc.body.style.background = options.background ?? "rgb(16, 16, 20)";
    const root = doc.createElement("div");
    root.dataset["paneWindowRoot"] = PANE;
    const host = doc.createElement("div");
    root.appendChild(host);
    doc.body.appendChild(root);
    // jsdom has no layout, so the box is stated rather than measured. The property under
    // test is the ORDER of the verdicts, which does not need a real layout engine.
    for (const key of ["clientWidth", "clientHeight"] as const) {
      Object.defineProperty(root, key, { configurable: true, value: options.width ?? 800 });
    }
    return { doc, root, host, child: { document: doc } };
  }

  it("blames the missing stylesheet before the collapsed box it causes", () => {
    const { child, doc, root, host } = scene({ width: 0, background: "rgba(0, 0, 0, 0)" });
    const reading = readChildMount({ child, prepared: doc, root, host, childFrames: 1, ageMs: 10 });
    expect(reading.verdict).toBe("unstyled");
  });

  it("blames the replaced document before anything measured inside it", () => {
    const { doc, root, host } = scene();
    const other = document.implementation.createHTMLDocument("replaced");
    const reading = readChildMount({
      child: { document: other },
      prepared: doc,
      root,
      host,
      childFrames: 1,
      ageMs: 10,
    });
    expect(reading.verdict).toBe("document-replaced");
  });

  it("refuses to call a mount healthy when it could not ask for frames", () => {
    const { child, doc, root, host } = scene();
    const reading = readChildMount({
      child,
      prepared: doc,
      root,
      host,
      childFrames: null,
      ageMs: 10_000,
    });
    // §V469: "I could not ask" is not folded into "I asked and it was fine".
    expect(reading.verdict).toBe("mounted-unverified");
    expect(formatChildMount(PANE, "alive", reading)).toContain("frames=unavailable");
  });

  it("waits out the deadline before calling a frameless child broken", () => {
    const { child, doc, root, host } = scene();
    const early = readChildMount({ child, prepared: doc, root, host, childFrames: 0, ageMs: 10 });
    const late = readChildMount({
      child,
      prepared: doc,
      root,
      host,
      childFrames: 0,
      ageMs: CHILD_FRAME_DEADLINE_MS + 1,
    });
    expect(early.verdict).toBe("awaiting-frame");
    expect(late.verdict).toBe("not-rendering");
  });

  /**
   * The fault the trace found on its first run, kept from coming back.
   *
   * A second root div is not a cosmetic leak. Both roots are `height: 100%` children of a
   * `100vh`, `overflow: hidden` body, so an EMPTY one appended first fills the window and
   * clips the live pane out of view — the window shows nothing while every canvas-level
   * check passes. That is why this outranks `unstyled` and `no-box`: those are what a
   * reader would otherwise be sent to chase.
   */
  it("blames a second root div before the blank window it produces", () => {
    const { child, doc, root, host } = scene();
    const orphan = doc.createElement("div");
    orphan.dataset["paneWindowRoot"] = PANE;
    doc.body.insertBefore(orphan, root);
    const reading = readChildMount({ child, prepared: doc, root, host, childFrames: 1, ageMs: 10 });
    expect(reading.verdict).toBe("roots-stacked");
    expect(formatChildMount(PANE, "alive", reading)).toContain("roots=2");
  });

  it("calls a present, styled, sized, rendering child mounted", () => {
    const { child, doc, root, host } = scene();
    const reading = readChildMount({ child, prepared: doc, root, host, childFrames: 3, ageMs: 50 });
    expect(reading.verdict).toBe("mounted");
    // The line the owner pastes. Every field that decided the verdict is in it, so a
    // reader can check the reasoning rather than take the word for it.
    expect(formatChildMount(PANE, "alive", reading)).toMatch(
      /^float\[viewer] alive: url=\S+ ready=\S+ realm=yes doc=ours head=\d+ body=\d+ root=800x800 host=in bg=\S+ canvas=0 roots=1 frames=3 age=50ms -> mounted$/,
    );
  });
});
