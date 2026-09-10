import { Profiler } from "react";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { EMPTY_READBACK_BUDGET, emptyNodeTelemetry } from "@runtime/telemetry/index.ts";
import type { TelemetrySnapshot, TelemetrySource } from "@runtime/telemetry/index.ts";
import { installDomStubs } from "@ui/testing/install-dom-stubs.ts";
import { PerformancePanel } from "./performance-panel.tsx";

/**
 * T1239 — the performance pane renders for the eyes on it, and only for those.
 *
 * Every dock pane stays mounted while hidden (§V96). Before T1239 this pane re-rendered
 * its whole table on every hub tick whether or not its tab was showing — on E24 that was
 * most of the idle commits per second. These tests pin the two halves of the fix and the
 * invariant that bounds it:
 *
 *  - a HIDDEN pane does not commit on a hub tick;
 *  - a VISIBLE pane does not commit on a tick that moved no number it shows (§V939);
 *  - a pane that becomes visible again shows the hub's CURRENT numbers on its first
 *    paint, without waiting for the next tick (§V86 — a stale number is worse than none).
 *
 * jsdom has no `Element.checkVisibility`, so the test installs one that answers the way
 * Chromium does for the case at hand: `display:none` on the element or any ancestor.
 */

/** A hub stand-in driven by hand: `tick(over)` replaces the snapshot and notifies. */
function fakeSource(initial: TelemetrySnapshot) {
  let current = initial;
  const listeners = new Set<() => void>();
  const source: TelemetrySource = {
    snapshot: () => current,
    nodeTelemetry: (nodeId) => emptyNodeTelemetry(nodeId, "unavailable"),
    nodeTiming: () => {
      throw new Error("not read by the panel");
    },
    componentTiming: () => {
      throw new Error("not read by the panel");
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return {
    source,
    tick(over: Partial<TelemetrySnapshot>): void {
      current = { ...current, ...over };
      act(() => {
        for (const listener of [...listeners]) listener();
      });
    },
  };
}

const plan: TelemetrySnapshot["plan"] = {
  categories: new Map([["blur", "filter"]]),
  readback: EMPTY_READBACK_BUDGET,
  passes: [{ id: "blur:p0", kind: "effect", nodeId: "blur", label: null }],
  sources: [],
  resourceCount: 3,
  estimatedResourceBytes: 2048,
  memoryBudgetBytes: null,
  nodeCount: 4,
  prunedCount: 1,
};

const build: TelemetrySnapshot["build"] = {
  resourcesCreated: 1,
  resourcesReused: 6,
  effectsBuilt: 2,
  effectsReused: 3,
};

function snapshot(frameMs: number, framesRendered: number): TelemetrySnapshot {
  return {
    timingAvailable: true,
    timingUnavailableReason: null,
    plan,
    build,
    readback: EMPTY_READBACK_BUDGET,
    cpuTimingAvailable: false,
    nodes: [
      {
        nodeId: "blur",
        sourcePath: "Main / Blur_1",
        label: null,
        category: "filter",
        passCount: 1,
        cpu: { availability: "unavailable", ms: null },
        gpu: { availability: "measured", ms: frameMs },
      },
    ],
    categories: [
      {
        category: "filter",
        nodeCount: 1,
        passCount: 1,
        cpu: { availability: "unavailable", ms: null },
        gpu: { availability: "measured", ms: frameMs },
      },
    ],
    framesRendered,
    lastFrameIndex: framesRendered - 1,
    frame: { availability: "measured", gpuMs: frameMs, passCount: 1, nodeCount: 1 },
    passes: [
      {
        passId: "blur:p0",
        kind: "effect",
        nodeId: "blur",
        sourcePath: "Main / Blur_1",
        label: null,
        availability: "measured",
        gpuMs: frameMs,
      },
    ],
    overBudget: false,
  };
}

function mount(source: TelemetrySource) {
  let commits = 0;
  const pane = document.createElement("div");
  document.body.append(pane);
  render(
    <Profiler
      id="performance"
      onRender={() => {
        commits += 1;
      }}
    >
      <PerformancePanel telemetry={source} />
    </Profiler>,
    { container: pane },
  );
  return {
    pane,
    commits: () => commits,
    hide: () => {
      act(() => {
        pane.style.display = "none";
      });
    },
    show: () => {
      act(() => {
        pane.style.display = "";
      });
    },
  };
}

const frames = () => screen.getByText("frames").nextElementSibling?.textContent;

function hiddenByDisplay(element: Element): boolean {
  for (let node: Element | null = element; node !== null; node = node.parentElement) {
    if (node instanceof HTMLElement && node.style.display === "none") return true;
  }
  return false;
}

beforeAll(() => {
  installDomStubs();
  if (typeof Element.prototype.checkVisibility !== "function") {
    Element.prototype.checkVisibility = function (this: Element) {
      return !hiddenByDisplay(this);
    };
  }
});

afterEach(cleanup);

describe("PerformancePanel renders for the eyes on it (T1239)", () => {
  it("does not commit on a hub tick while hidden, and paints the current numbers on show (§V86)", async () => {
    const hub = fakeSource(snapshot(3.5, 120));
    const view = mount(hub.source);
    expect(frames()).toBe("120");
    const shown = view.commits();

    view.hide();
    hub.tick(snapshot(4.25, 121));
    hub.tick(snapshot(4.5, 122));
    expect(view.commits()).toBe(shown);
    expect(frames()).toBe("120");

    view.show();
    // The ancestor observer fires as a microtask, before the frame that shows the pane
    // paints — the first paint carries 122, not the 120 the pane was hidden with.
    await waitFor(() => expect(frames()).toBe("122"));
    expect(screen.getAllByText("4.500 ms").length).toBeGreaterThan(0);
    expect(view.commits()).toBe(shown + 1);
  });

  it("does not commit on a tick that moved no number it shows (§V939)", () => {
    const hub = fakeSource(snapshot(3.5, 120));
    const view = mount(hub.source);
    const shown = view.commits();

    hub.tick(snapshot(3.5, 120));
    expect(view.commits()).toBe(shown);

    hub.tick(snapshot(3.5, 121));
    expect(view.commits()).toBe(shown + 1);
    expect(frames()).toBe("121");
  });

  it("keeps following the hub while visible", () => {
    const hub = fakeSource(snapshot(3.5, 120));
    mount(hub.source);
    hub.tick(snapshot(4.25, 121));
    expect(frames()).toBe("121");
    expect(screen.getAllByText("4.250 ms").length).toBeGreaterThan(0);
  });
});
