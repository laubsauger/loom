// @vitest-environment jsdom
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { installDomStubs } from "@ui/testing/install-dom-stubs.ts";
import { alice, contextFor, createHarness, patch } from "@domain/commands/test-support.ts";
import { GraphCanvas } from "./graph-canvas.tsx";
import { createNodeRuntimeStore } from "./node-runtime.ts";
import { annotationHueKey, minimapNodeColor, minimapSizeOf } from "./minimap-model.ts";
import { TOGGLE_MINIMAP_COMMAND, minimapStore } from "./minimap-command.ts";
import { installFlowStubs } from "./testing.tsx";
import type { GraphNode } from "@domain/types/graph.ts";
import { allNodeDefinitions } from "@nodes/definitions/index.ts";
import { createNodeRegistry } from "@nodes/registry/registry.ts";

/**
 * The overview map on the real canvas (T1257).
 *
 * What a person sees: a map in the corner with one box per node in that node's family
 * colour, which the `o` key (and the menu row, and an agent) can take away and bring
 * back through ONE command — on this canvas's bus and on every door bus it was handed,
 * because the keymap dispatches on the root bus inside a component dive (T1195).
 */

beforeAll(() => {
  installDomStubs();
  installFlowStubs();
});
beforeEach(() => {
  minimapStore().set(true);
});
afterEach(cleanup);

const invocation = contextFor(alice);
const MAP = '[data-testid="rf__minimap"]';

async function mountCanvas() {
  const { bus } = createHarness("m");
  const { bus: door } = createHarness("door");
  const runtime = createNodeRuntimeStore({ intervalMs: 0 });
  const seeded = await bus.execute(
    "graph.applyPatch",
    patch(bus.store.getRevision(), [
      { op: "addNode", ref: "$a", type: "test.solid", position: { x: 0, y: 0 } },
      { op: "addNode", ref: "$b", type: "test.blur", position: { x: 300, y: 0 } },
    ]),
    invocation,
  );
  const ids = {
    a: seeded.output.createdIds["$a"] as string,
    b: seeded.output.createdIds["$b"] as string,
  };
  const view = render(<GraphCanvas bus={bus} doorBuses={[door]} invocation={invocation} runtime={runtime} />);
  return { ...view, bus, door, ids };
}

describe("the overview map is on the canvas", () => {
  it("draws one box per node in the family colour of its primary output", async () => {
    const { container } = await mountCanvas();
    const map = await waitFor(() => {
      const found = container.querySelector(MAP);
      if (found === null) throw new Error("no map");
      return found;
    });
    await waitFor(() => {
      expect(map.querySelectorAll(".react-flow__minimap-node")).toHaveLength(2);
    });
    // Both test nodes emit rgba — the texture family's token, the same one their
    // outgoing wire carries (§V26). A literal here would be the one colour on the
    // canvas that ignores the theme (§V17).
    for (const box of map.querySelectorAll<SVGRectElement>(".react-flow__minimap-node")) {
      expect(box.style.fill).toBe("var(--port-texture2d)");
    }
    // The visible viewport is drawn as a cut-out mask, not as a second box.
    expect(map.querySelector(".react-flow__minimap-mask")).not.toBeNull();
  });

  it("lives OUTSIDE React Flow's stacking context, so preview tiles cannot cover it", async () => {
    const { container } = await mountCanvas();
    const map = await waitFor(() => {
      const found = container.querySelector(MAP);
      if (found === null) throw new Error("no map");
      return found;
    });
    // Portalled: the map is a descendant of the canvas wrapper but NOT of `.react-flow`,
    // whose inline `z-index: 0` would pin it under the pane's preview surface.
    expect(map.closest('[data-testid="graph-canvas"]')).not.toBeNull();
    expect(map.closest(".react-flow")).toBeNull();
  });
});

describe("the map's size is the CSS variable, handed to React Flow as numbers", () => {
  it("reads --minimap-width/--minimap-height off the host, so the size is tuned in CSS", () => {
    // React Flow computes its viewBox and its drag scale from `style.width`, so the size
    // the stylesheet declares must be the size the arithmetic sees — the same number.
    const host = document.createElement("div");
    host.style.setProperty("--minimap-width", "120px");
    host.style.setProperty("--minimap-height", "84px");
    document.body.appendChild(host);
    try {
      expect(minimapSizeOf(host)).toEqual({ width: 120, height: 84 });
    } finally {
      host.remove();
    }
  });

  it("sizes the SVG from the host's variables, not from React Flow's 200×150 default", async () => {
    const { container } = await mountCanvas();
    const svg = await waitFor(() => {
      const found = container.querySelector<SVGSVGElement>(`${MAP} svg`);
      if (found === null) throw new Error("no map svg");
      return found;
    });
    const host = svg.closest<HTMLElement>('[data-testid="graph-canvas"] > div:not(.react-flow)');
    if (host === null) throw new Error("no minimap host");
    const size = minimapSizeOf(host);
    expect(Number(svg.getAttribute("width"))).toBe(size.width);
    expect(Number(svg.getAttribute("height"))).toBe(size.height);
    expect(size.width).toBeLessThan(200);
  });
});

describe("view.toggleMinimap is the one door (§V29)", () => {
  it("hides the map through the command and brings it back — on the door bus too", async () => {
    const { container, bus, door } = await mountCanvas();
    await waitFor(() => {
      expect(container.querySelector(MAP)).not.toBeNull();
    });

    await act(async () => {
      await bus.execute(TOGGLE_MINIMAP_COMMAND, {}, invocation);
    });
    expect(container.querySelector(MAP)).toBeNull();

    // The keymap dispatches on the ROOT bus, which inside a dive is not the canvas's own
    // bus (T1195) — the door bus must reach the same map.
    await act(async () => {
      await door.execute(TOGGLE_MINIMAP_COMMAND, {}, invocation);
    });
    await waitFor(() => {
      expect(container.querySelector(MAP)).not.toBeNull();
    });
  });
});

describe("T1262 — an annotation shows on the map in its own hue", () => {
  const note = (id: string, color?: string): GraphNode => ({
    id,
    type: "annotate",
    definitionVersion: 1,
    position: { x: 0, y: 0 },
    parameters: color === undefined ? {} : { color },
  });

  it("paints the named category token, not the sink tone a portless definition would get", () => {
    const definition = createNodeRegistry(allNodeDefinitions).view().get("annotate");
    expect(definition).toBeDefined();
    expect(minimapNodeColor(definition)).toBe("var(--text-dim)");
    expect(minimapNodeColor(definition, "points")).toBe("var(--category-points)");
    expect(minimapNodeColor(definition, "filter")).toBe("var(--category-filter)");
  });

  it("keys every annotation's hue, with the default and the fallback the canvas paints", () => {
    const noise: GraphNode = { id: "noise", type: "noise", definitionVersion: 1, position: { x: 0, y: 0 }, parameters: {} };
    expect(annotationHueKey({ noise })).toBe("");
    expect(
      annotationHueKey({ noise, a: note("a", "points"), b: note("b"), c: note("c", "#ff0000") }),
    ).toBe("a=points;b=utility;c=utility;");
    // A primitive, so the subscription only wakes when a hue actually moves.
    expect(annotationHueKey({ a: note("a", "points") })).toBe(annotationHueKey({ a: note("a", "points") }));
  });
});
