// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { installDomStubs } from "@ui/testing/install-dom-stubs.ts";
import { createDomainBus } from "@domain/commands/index.ts";
import { createGraphStore } from "@domain/graph/store.ts";
import { createSequentialIdFactory } from "@domain/graph/ids.ts";
import type { GraphDocument } from "@domain/types/graph.ts";
import { createTestRegistry } from "@nodes/registry/test-nodes.ts";
import type { NodeRegistry } from "@nodes/registry/registry.ts";
import {
  CanvasFixture,
  fixtureContext,
  installFlowStubs,
  nodeProps,
} from "@editor/graph-canvas/testing.tsx";
import type { NodeRuntimeStore } from "@editor/graph-canvas/node-runtime.ts";
import { NodeView } from "./node-view.tsx";
import { costTier } from "./node-timing.ts";

/**
 * The per-node timing overlay (T1010) — the owner's four requirements, each as a gate.
 *
 *   1. OUTSIDE the header, floating above the node, still attached to it.
 *   2. Absolute time AND a proportional bar, the bar ABOVE the number.
 *   3. Smoothed, because the raw sample is unreadable.
 *   4. Off by default, behind the Debug submenu.
 *
 * Plus the constraint that decides the shape of all four: §V836. The sample lands in a
 * LEAF, so switching the instrument on does not turn the graph canvas into the thing it
 * measures. That is the last block, and it counts renders.
 */

beforeAll(() => {
  installDomStubs();
  installFlowStubs();
});
afterEach(cleanup);

function graphWithTwo(): GraphDocument {
  return {
    revision: 1,
    nodes: {
      cheap: {
        id: "cheap",
        type: "test.blur",
        definitionVersion: 1,
        position: { x: 0, y: 0 },
        parameters: {},
      },
      dear: {
        id: "dear",
        type: "test.blur",
        definitionVersion: 1,
        position: { x: 0, y: 120 },
        parameters: {},
      },
    },
    edges: {},
    groups: {},
  };
}

/**
 * A registry view that COUNTS the lookups `NodeView` performs.
 *
 * §V836's gate needs to know whether the node component's body re-ran, and the DOM cannot
 * answer that: React reconciles a re-render whose output is unchanged into zero mutations,
 * so a MutationObserver reports nothing while the whole node tree re-renders ten times a
 * second — the exact cost the invariant is about, made invisible by the instrument.
 * `registry.get(node.type)` runs once per `NodeView` body, so counting it counts renders.
 */
function countingRegistry(view: ReturnType<NodeRegistry["view"]>) {
  const counter = { calls: 0 };
  const counted: ReturnType<NodeRegistry["view"]> = {
    ...view,
    get(type: string) {
      counter.calls += 1;
      return view.get(type);
    },
  };
  return { counted, counter };
}

/** Two nodes on one canvas, so a SHARE has something to be a share of. */
function mountPair() {
  const store = createGraphStore({
    ids: createSequentialIdFactory("n"),
    initialGraph: graphWithTwo(),
  });
  const { bus } = createDomainBus({ store, registry: createTestRegistry().view() });
  const { counted, counter } = countingRegistry(bus.registry);
  const { value, runtime, timingOverlay, timingScale } = fixtureContext({
    store: bus.store,
    registry: counted,
  });
  const view = render(
    <CanvasFixture value={value}>
      <NodeView {...nodeProps("cheap")} />
      <NodeView {...nodeProps("dear")} />
    </CanvasFixture>,
  );
  return { ...view, runtime, timingOverlay, timingScale, renders: counter };
}

async function publish(
  runtime: NodeRuntimeStore,
  nodeId: string,
  patch: Parameters<NodeRuntimeStore["publish"]>[1],
) {
  await act(async () => {
    runtime.publish(nodeId, patch);
    await new Promise((resolve) => setTimeout(resolve, 2));
  });
}

/** Drives the EMA to convergence so a test can assert a settled number. */
async function settle(runtime: NodeRuntimeStore, nodeId: string, gpuMs: number) {
  for (let tick = 0; tick < 30; tick += 1) await publish(runtime, nodeId, { gpuMs });
}

function barWidth(nodeId: string): number {
  const bar = screen.getByTestId(`node-timing-bar-${nodeId}`);
  const raw = bar.style.getPropertyValue("--timing-share");
  return Number.parseFloat(raw.replace("%", ""));
}

describe("off by default, behind the Debug submenu", () => {
  it("draws nothing at all until the toggle is on", async () => {
    const { runtime, timingOverlay } = mountPair();
    // Not merely empty — ABSENT. A mounted overlay drawing nothing would still wake on
    // every 10 Hz sample, which is the cost §V836 measured (§V836, and the owner's "it's
    // not supposed to be there all the time").
    expect(screen.queryByTestId("node-timing-cheap")).toBeNull();
    await publish(runtime, "cheap", { gpuMs: 4 });
    expect(screen.queryByTestId("node-timing-cheap")).toBeNull();

    await act(async () => {
      timingOverlay.set(true);
    });
    expect(screen.getByTestId("node-timing-cheap")).toBeDefined();
  });
});

describe("placement — outside the header, attached to the node", () => {
  it("is a sibling of the header, not a member of it", async () => {
    const { timingOverlay, container } = mountPair();
    await act(async () => {
      timingOverlay.set(true);
    });

    const overlay = screen.getByTestId("node-timing-cheap");
    const header = container.querySelector("header");
    expect(header).not.toBeNull();
    // The owner's ask, asserted structurally: *"NOT squeezed into the header of the node,
    // but floating outside"*. Containment is the thing that was wrong, so containment is
    // what this checks — the readout must not be INSIDE the header element.
    expect(header?.contains(overlay)).toBe(false);
    // ...and it is still attached to the node rather than floating free of it.
    expect(overlay.closest("[data-testid^='node-']")).not.toBeNull();
  });

  it("puts the bar ABOVE the number, not on top of it", async () => {
    const { timingOverlay } = mountPair();
    await act(async () => {
      timingOverlay.set(true);
    });

    // *"the proportional render time bar next to it — ABOVE it, not ON TOP of it, above
    // it."* In a column, "above" is "earlier in document order", and "not on top of" is
    // "a different element". Both are asserted; a bar layered over the text would satisfy
    // neither.
    const overlay = screen.getByTestId("node-timing-cheap");
    const children = [...overlay.children];
    const bar = screen.getByTestId("node-timing-bar-cheap");
    const value = screen.getByTestId("node-timing-value-cheap");
    expect(children.indexOf(bar.parentElement as Element)).toBeLessThan(children.indexOf(value));
    expect(bar.contains(value)).toBe(false);
  });
});

describe("the number is honest before it is useful (§V86)", () => {
  it("reads an em dash, never 0.00 ms, while nothing is measured", async () => {
    // The state the whole app is in until `attachTimingSource` has a product call site
    // (T1011). A zero here would be a measurement of nothing dressed as a cheap pass.
    const { timingOverlay } = mountPair();
    await act(async () => {
      timingOverlay.set(true);
    });
    expect(screen.getByTestId("node-timing-value-cheap").textContent).toBe("—");
    expect(barWidth("cheap")).toBe(0);
  });

  it("stops showing a number when the measurement stops", async () => {
    const { runtime, timingOverlay } = mountPair();
    await act(async () => {
      timingOverlay.set(true);
    });
    await settle(runtime, "cheap", 6);
    expect(screen.getByTestId("node-timing-value-cheap").textContent).not.toBe("—");

    await publish(runtime, "cheap", { gpuMs: null });
    expect(screen.getByTestId("node-timing-value-cheap").textContent).toBe("—");
    expect(barWidth("cheap")).toBe(0);
  });
});

describe("the bar is a PROPORTION, and it grows for the expensive node (§V839)", () => {
  it("gives the costlier node the longer bar", async () => {
    const { runtime, timingOverlay } = mountPair();
    await act(async () => {
      timingOverlay.set(true);
    });

    await settle(runtime, "cheap", 1);
    await settle(runtime, "dear", 9);
    // Let the shared denominator's own tick land for both.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });

    // 1 ms against 9 ms on one canvas: a tenth of the frame versus nine tenths.
    expect(barWidth("dear")).toBeGreaterThan(barWidth("cheap"));
    expect(barWidth("dear")).toBeGreaterThan(80);
    expect(barWidth("cheap")).toBeLessThan(20);
    // Absolute time is there too — the owner asked for BOTH, not one instead of the other.
    expect(screen.getByTestId("node-timing-value-dear").textContent).toMatch(/ ms$/);
  });

  it("grows the SAME node's bar when that node alone gets more expensive", async () => {
    // §V839 in its sharpest form: a share can move opposite to the cost it names when the
    // rest of the graph moves with it. This holds the other node still and makes only the
    // measured one expensive, so nothing but the named property can explain the growth.
    const { runtime, timingOverlay } = mountPair();
    await act(async () => {
      timingOverlay.set(true);
    });
    await settle(runtime, "cheap", 5);
    await settle(runtime, "dear", 5);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
    const even = barWidth("dear");

    await settle(runtime, "dear", 45);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
    expect(barWidth("dear")).toBeGreaterThan(even);
    // And the untouched node's bar SHRANK, because it is now a smaller part of a bigger
    // frame — which is the whole reason a proportional bar was asked for.
    expect(barWidth("cheap")).toBeLessThan(even);
  });

  it("colour-codes by the SAME share the length encodes, and the ramp climbs (§V839)", async () => {
    // The owner's ask — *"colour coded depending on if they take a lot or just a little,
    // so it's even easier to see at a distance"* — with §V839's direction check: the
    // expensive node must land HIGHER on the ramp, not merely on a different step.
    const { runtime, timingOverlay } = mountPair();
    await act(async () => {
      timingOverlay.set(true);
    });
    await settle(runtime, "cheap", 1);
    await settle(runtime, "dear", 19);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });

    const order: ReadonlyArray<string> = ["low", "moderate", "high", "dominant"];
    const dear = screen.getByTestId("node-timing-bar-dear").getAttribute("data-cost") ?? "";
    const cheap = screen.getByTestId("node-timing-bar-cheap").getAttribute("data-cost") ?? "";
    expect(order.indexOf(dear)).toBeGreaterThan(order.indexOf(cheap));
    expect(dear).toBe("dominant");
    expect(cheap).toBe("low");
    // And the tier the DOM shows is the tier the share implies, not a second opinion.
    expect(dear).toBe(costTier(barWidth("dear") / 100));
  });

  it("moves the SAME node up the ramp when only that node gets expensive (§V839)", async () => {
    // The direction check with the denominator's other half held still, so nothing but
    // the named property can explain the step: a share can move opposite to the cost it
    // names when the rest of the graph moves with it.
    const order: ReadonlyArray<string> = ["low", "moderate", "high", "dominant"];
    const { runtime, timingOverlay } = mountPair();
    await act(async () => {
      timingOverlay.set(true);
    });
    await settle(runtime, "cheap", 10);
    await settle(runtime, "dear", 1);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
    const before = screen.getByTestId("node-timing-bar-dear").getAttribute("data-cost") ?? "";

    await settle(runtime, "dear", 40);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
    const after = screen.getByTestId("node-timing-bar-dear").getAttribute("data-cost") ?? "";
    expect(order.indexOf(after)).toBeGreaterThan(order.indexOf(before));
  });
});

describe("readable at a distance", () => {
  it("draws a bar thick enough to survive being zoomed out", () => {
    /*
     * The owner's constraint is the whole reason the bar exists in this form: *"a little
     * bit thicker… so it's even easier to see at a distance and who's doing what."* A
     * graph is read at 30–50 % zoom while hunting for the expensive node, and React Flow
     * scales the node subtree with the viewport — so a 3px bar is one screen pixel there,
     * present in the DOM and invisible in the room. jsdom does no layout, so the authored
     * height is the honest thing to assert.
     */
    const here = dirname(fileURLToPath(import.meta.url));
    const css = readFileSync(join(here, "node-timing-overlay.module.css"), "utf8");
    const track = /\.track\s*\{([^}]*)\}/.exec(css);
    const height = /height:\s*(\d+)px/.exec(track?.[1] ?? "");
    expect(height).not.toBeNull();
    // 5px survives 40 % zoom as two device pixels. Below that the bar stops being a bar.
    expect(Number.parseInt(height?.[1] ?? "0", 10)).toBeGreaterThanOrEqual(5);
  });
});

describe("smoothing reaches the pixels", () => {
  it("does not print the raw sample the instant it arrives", async () => {
    const { runtime, timingOverlay } = mountPair();
    await act(async () => {
      timingOverlay.set(true);
    });
    await settle(runtime, "cheap", 4);
    const before = screen.getByTestId("node-timing-value-cheap").textContent ?? "";

    // One violent sample. A raw readout would show `40.0 ms`; a smoothed one moves a
    // quarter of the way there, which is the difference between a number you can read and
    // one that flickers.
    await publish(runtime, "cheap", { gpuMs: 40 });
    const after = screen.getByTestId("node-timing-value-cheap").textContent ?? "";
    expect(after).not.toBe(before);
    expect(after).not.toBe("40.0 ms");
    expect(Number.parseFloat(after)).toBeGreaterThan(Number.parseFloat(before));
    expect(Number.parseFloat(after)).toBeLessThan(20);
  });
});

/**
 * §V836 — THE TRAP THIS FEATURE WAS MOST LIKELY TO FALL INTO.
 *
 * Measured today: the inspector's live sampling committed its entire panel subtree at
 * 3.89–8.28 ms per commit, and at 10 Hz that is ~8 % of the main thread. An overlay on
 * every node repeats that N times over, and an instrument that costs what it measures is
 * worse than no instrument.
 *
 * So the gate is a render count, not a shape: with the overlay on, a `gpuMs` sample may
 * re-render the overlay leaf and must NOT re-render the node that hosts it. The node also
 * re-measures every one of its handles when it renders (`useHandleBoundsInSync`), so a
 * node render here is not one wasted commit, it is a forced layout per socket.
 */
describe("§V836 — one sample repaints one label, not the canvas", () => {
  it("re-renders the overlay and not the node when only a number moved", async () => {
    const { runtime, timingOverlay, renders } = mountPair();
    await act(async () => {
      timingOverlay.set(true);
    });
    // Mount is allowed to render; what must not repeat is the sampling.
    expect(renders.calls).toBeGreaterThan(0);
    renders.calls = 0;

    for (const gpuMs of [1, 2, 3, 4, 5, 6, 7, 8]) {
      await publish(runtime, "cheap", { gpuMs });
      await publish(runtime, "dear", { gpuMs: gpuMs * 2 });
    }

    // The samples really landed — otherwise a zero would prove nothing (§V844's lesson: a
    // gate that cannot fail is not a gate).
    expect(screen.getByTestId("node-timing-value-cheap").textContent).toMatch(/ ms$/);
    expect(screen.getByTestId("node-timing-value-dear").textContent).toMatch(/ ms$/);
    // Sixteen samples, and neither node component re-ran. Each of those renders would also
    // have re-measured every handle on the node (`useHandleBoundsInSync`), so this is a
    // forced layout per socket per sample, not one wasted commit.
    expect(renders.calls).toBe(0);
  });

  it("still repaints the node when something STRUCTURAL moves", async () => {
    // The other half, and the reason the gate above is not satisfiable by simply never
    // rendering: an error appearing must reach the node at once (§V16 caps how often
    // NUMBERS repaint; it never asked us to sit on a diagnostic).
    const { runtime, timingOverlay, container } = mountPair();
    await act(async () => {
      timingOverlay.set(true);
    });
    const node = container.querySelector("[data-testid^='node-']");
    expect(node?.getAttribute("data-status")).toBe("idle");

    await publish(runtime, "cheap", { status: "error", errorCount: 1, message: "boom" });
    expect(container.querySelector("[data-testid^='node-']")?.getAttribute("data-status")).toBe(
      "error",
    );
  });
});
