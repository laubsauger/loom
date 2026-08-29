// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { installDomStubs } from "@ui/testing/install-dom-stubs.ts";
import { createGraphStore } from "@domain/graph/store.ts";
import { createTestRegistry } from "@nodes/registry/test-nodes.ts";
import {
  CanvasFixture,
  edgeProps,
  fixtureContext,
  installFlowStubs,
  setReducedMotion,
} from "@editor/graph-canvas/testing.tsx";
import type { NodeRuntimeStore } from "@editor/graph-canvas/node-runtime.ts";
import type { SignalEdgeData } from "@editor/graph-canvas/derive.ts";
import { SignalEdge } from "./signal-edge.tsx";

beforeAll(() => {
  installDomStubs();
  installFlowStubs();
});
beforeEach(() => setReducedMotion(false));
afterEach(cleanup);

const registry = createTestRegistry().view();

function edgeData(overrides: Partial<SignalEdgeData> = {}): SignalEdgeData {
  return { portKind: "texture2d", sourceNodeId: "source-node", inactive: false, ...overrides };
}

function renderEdge(data: SignalEdgeData) {
  const store = createGraphStore().view;
  const { value, runtime } = fixtureContext({ store, registry });
  const view = render(
    <CanvasFixture value={value}>
      <svg>
        <SignalEdge {...edgeProps("e1", data)} />
      </svg>
    </CanvasFixture>,
  );
  return { ...view, runtime };
}

/** Metrics are rate-limited (§V16); let the pending flush land before asserting. */
async function publishGpuMs(runtime: NodeRuntimeStore, nodeId: string, gpuMs: number | null) {
  await act(async () => {
    runtime.publish(nodeId, { gpuMs });
    await new Promise((resolve) => setTimeout(resolve, 1));
  });
}

describe("V26 — the edge's hue IS the source port's family colour", () => {
  it("paints the hairline with the family token, not a theme accent", () => {
    const { container } = renderEdge(edgeData({ portKind: "texture2d" }));
    const path = container.querySelector(".react-flow__edge-path");
    expect(path?.getAttribute("style")).toContain("--edge-color: var(--port-texture2d)");
  });

  it("changes hue with the port family and never hardcodes one", () => {
    const { container: textureEdge } = renderEdge(edgeData({ portKind: "texture2d" }));
    const textureStyle = textureEdge.querySelector(".react-flow__edge-path")?.getAttribute("style");
    cleanup();

    const { container: scalarEdge } = renderEdge(edgeData({ portKind: "scalar" }));
    const scalarStyle = scalarEdge.querySelector(".react-flow__edge-path")?.getAttribute("style");

    expect(textureStyle).toContain("var(--port-texture2d)");
    expect(scalarStyle).toContain("var(--port-scalar)");
    expect(scalarStyle).not.toBe(textureStyle);
    expect(scalarStyle).not.toMatch(/#[0-9a-f]{3}/i);
  });
});

describe("the signature element — flow ← real per-pass GPU ms", () => {
  it("is a static hairline while nothing has been measured", () => {
    const { container } = renderEdge(edgeData());
    expect(container.querySelector(".react-flow__edge-path")).not.toBeNull();
    expect(container.querySelector('[data-testid="edge-flow-e1"]')).toBeNull();
  });

  it("starts flowing once the source pass reports GPU time", async () => {
    const { container, runtime } = renderEdge(edgeData({ sourceNodeId: "src" }));
    await publishGpuMs(runtime, "src", 4);

    const flow = container.querySelector('[data-testid="edge-flow-e1"]');
    expect(flow).not.toBeNull();
    expect(flow?.getAttribute("data-port-kind")).toBe("texture2d");
    expect(flow?.getAttribute("style")).toContain("--edge-color: var(--port-texture2d)");
  });

  it("flows faster for a busier pass — the claim the visual makes", async () => {
    const { container, runtime } = renderEdge(edgeData({ sourceNodeId: "src" }));

    await publishGpuMs(runtime, "src", 0.2);
    const slow = container
      .querySelector<SVGPathElement>('[data-testid="edge-flow-e1"]')
      ?.style.getPropertyValue("--flow-duration");

    await publishGpuMs(runtime, "src", 12);
    const fast = container
      .querySelector<SVGPathElement>('[data-testid="edge-flow-e1"]')
      ?.style.getPropertyValue("--flow-duration");

    expect(Number.parseFloat(fast ?? "")).toBeLessThan(Number.parseFloat(slow ?? ""));
  });

  it("goes back to a hairline when the pass goes idle", async () => {
    const { container, runtime } = renderEdge(edgeData({ sourceNodeId: "src" }));
    await publishGpuMs(runtime, "src", 6);
    expect(container.querySelector('[data-testid="edge-flow-e1"]')).not.toBeNull();

    await publishGpuMs(runtime, "src", null);
    expect(container.querySelector('[data-testid="edge-flow-e1"]')).toBeNull();
  });

  it("does not flow out of a bypassed or muted pass", async () => {
    const { container, runtime } = renderEdge(
      edgeData({ sourceNodeId: "src", inactive: true }),
    );
    await publishGpuMs(runtime, "src", 12);
    expect(container.querySelector('[data-testid="edge-flow-e1"]')).toBeNull();
  });
});

describe("V19 — reduced motion turns the living edge into a static hairline", () => {
  it("renders no moving layer at all, however busy the pass is", async () => {
    setReducedMotion(true);
    const { container, runtime } = renderEdge(edgeData({ sourceNodeId: "src" }));
    await publishGpuMs(runtime, "src", 14);

    expect(container.querySelector('[data-testid="edge-flow-e1"]')).toBeNull();
    // The hue survives: the information the colour carries is not motion-dependent.
    const path = container.querySelector(".react-flow__edge-path");
    expect(path?.getAttribute("style")).toContain("--edge-color: var(--port-texture2d)");
  });
});
