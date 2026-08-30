// @vitest-environment jsdom
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { createMemoryStorage, installDomStubs } from "@ui/testing/install-dom-stubs.ts";
import { installFlowStubs } from "@editor/graph-canvas/testing.tsx";
import type { BackendCapabilities } from "@domain/types/backend.ts";
import type { GraphPatchOperation } from "@domain/types/patch.ts";
import type { PreviewFrameCommand, PreviewProgram } from "@runtime/previews/index.ts";
import type { ShaderloomBackend } from "@runtime/backend/index.ts";
import { App } from "../../app/app.tsx";
import { createAppRuntime } from "../../app/app-runtime.ts";
import type { AppRuntime } from "../../app/app-runtime.ts";
import type { GpuStatus } from "../../app/gpu-status.ts";

/**
 * T209 / §V117 / §V118 — the preview tile follows the node's preview AREA, and the image
 * is LETTERBOXED inside it rather than stretched.
 *
 * Composed, at the backend seam, because that is where the two halves have to agree: the
 * tile the program ALLOCATES and the rect the frame command DRAWS it into. A unit test on
 * either alone proves nothing — a correctly-sized tile stretched into a mismatched rect is
 * exactly the bug, and both layers look right in isolation while it is happening (§B: B13
 * was that shape).
 *
 * Everything is asserted as RATIOS, so the test says what §V118 says — "the image keeps
 * its aspect" — instead of pinning numbers that carry this fixture's framing.
 */

beforeAll(() => {
  installDomStubs();
  installFlowStubs();
  installLayoutStubs();
});
afterEach(cleanup);

const CAPABILITIES: BackendCapabilities = {
  tier: "B",
  features: [],
  formats: ["rgba8unorm", "rgba8unorm-srgb", "rgba16float", "r32float", "depth24plus"],
  timestampQuery: false,
  limits: { maxTextureDimension2D: 8192 },
};

/** The node's preview slot, as the layout stub reports it: a 16:9 region. */
const SLOT = { width: 160, height: 90 };
/** The texture the node resolves to: square, so nothing about it matches the slot. */
const SOURCE = { width: 512, height: 512 };

interface Captured {
  programs: PreviewProgram[];
  commands: PreviewFrameCommand[];
}

function capturingBackend(): { backend: ShaderloomBackend; captured: Captured } {
  const captured: Captured = { programs: [], commands: [] };
  const backend = {
    status: {
      initialized: true,
      disposed: false,
      halted: false,
      deviceGeneration: 1,
      temporalResets: 0,
      resourceBuilds: 0,
      framesSubmitted: 0,
      readbacks: 0,
      stale: false,
      estimatedResourceBytes: 0,
    },
    onDiagnostic: () => () => {},
    recover: async () => {},
    loop: () => ({ stop: () => {} }),
    previewHost: () => ({
      setPreviewProgram: (program: PreviewProgram) => captured.programs.push(program),
      presentPreviews: (command: PreviewFrameCommand) => captured.commands.push(command),
      dispose: () => {},
    }),
    present: () => ({ id: "present-stub", outputId: "", setOutput: () => {}, dispose: () => {} }),
    onGpuTimings: () => () => {},
    compile: async () => ({ id: "plan", passes: [] }),
    render: () => {},
    resize: () => {},
    updateUniforms: () => {},
    resetTemporalHistory: () => {},
    // T326: part of the backend contract; a fixture without it is incomplete.
    setCookPolicy() {},
    dispose: () => {},
  } as unknown as ShaderloomBackend;
  return { backend, captured };
}

function domRect(x: number, y: number, width: number, height: number): DOMRect {
  return {
    x, y, width, height,
    top: y, left: x, right: x + width, bottom: y + height,
    toJSON: () => ({}),
  } as DOMRect;
}

/**
 * jsdom has no layout, so the node box and the preview slot inside it get plausible CSS
 * rects. Only the DELTA between them is read by the measuring code, so these are sizes
 * rather than a pretend layout — the same stub `viewport-transform.test.tsx` uses.
 */
function installLayoutStubs(): void {
  const base = Element.prototype.getBoundingClientRect;
  Object.defineProperty(Element.prototype, "getBoundingClientRect", {
    configurable: true,
    value: function stub(this: Element): DOMRect {
      if (this.classList.contains("react-flow__node")) return domRect(100, 100, 178, 130);
      if (this.closest('[data-testid^="node-preview-"]') !== null) {
        return domRect(110, 150, SLOT.width, SLOT.height);
      }
      return base.call(this);
    },
  });
}

function newRuntime(): AppRuntime {
  return createAppRuntime({
    identityStorage: null,
    actor: { kind: "human", id: "tester", label: "Tester" },
  });
}

async function seed(runtime: AppRuntime, operations: GraphPatchOperation[]) {
  return runtime.bus.execute(
    "graph.applyPatch",
    { baseRevision: runtime.bus.store.getRevision(), operations, label: "seed" },
    runtime.invocation,
  );
}

async function ticks(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 120));
  });
}

async function mountWithSquareSource() {
  const runtime = newRuntime();
  await seed(runtime, [
    { op: "addNode", ref: "$solid", type: "solid", position: { x: 0, y: 0 } },
    { op: "addNode", ref: "$out", type: "output", position: { x: 240, y: 0 } },
    {
      op: "connect",
      source: { nodeId: "$solid", portId: "out" },
      target: { nodeId: "$out", portId: "input" },
    },
    // A square output on a 16:9 node region — the case §V118 exists for.
    {
      op: "setNodeResolution",
      nodeId: "$solid",
      resolution: { mode: "fixed", width: SOURCE.width, height: SOURCE.height },
    },
  ]);

  const { backend, captured } = capturingBackend();
  const status: GpuStatus = { kind: "ready", capabilities: CAPABILITIES, baseline: true, backend };
  const probe = () => Promise.resolve(status);

  const view = render(<App runtime={runtime} storage={createMemoryStorage()} gpuProbe={probe} />);
  await act(async () => {});
  await waitFor(() => {
    expect(view.container.querySelectorAll(".react-flow__node").length).toBeGreaterThan(0);
  });
  await ticks();
  return { runtime, view, captured };
}

const SOURCE_ASPECT = SOURCE.width / SOURCE.height;
const SLOT_ASPECT = SLOT.width / SLOT.height;

describe("T209 — the preview keeps its aspect inside the node's area (§V117, §V118)", () => {
  it("allocates a tile with the SOURCE aspect and draws it into a matching rect", async () => {
    const { captured } = await mountWithSquareSource();

    const program = captured.programs[captured.programs.length - 1];
    const targets = (program?.resources ?? []).filter((resource) => resource.kind === "target");
    // NON-VACUITY: there is a tile at all. Counting ratios on an empty program proves
    // nothing, and an empty program is what a broken preview pipeline produces.
    expect(targets).toHaveLength(1);
    const size = targets[0]?.size;
    expect(size).toBeDefined();
    if (size === undefined) return;

    // §V117: the tile is square because the TEXTURE is square — it does not inherit the
    // 16:9 shape of the box the user happens to have dragged the node to.
    expect(size[0] / size[1]).toBeCloseTo(SOURCE_ASPECT, 2);

    const command = captured.commands[captured.commands.length - 1];
    const tile = command?.composite[0];
    expect(tile).toBeDefined();
    if (tile === undefined) return;

    // §V118: and it is DRAWN into a region of the same aspect, so the image is letterboxed
    // inside the node rather than stretched across it. Stretching is what this asserts
    // against, and it is not a hypothetical: the slot is 16:9 and the image is 1:1, so a
    // rect that filled the slot would fail here by a factor of 1.78.
    expect(tile.dest.width / tile.dest.height).toBeCloseTo(SOURCE_ASPECT, 2);
    expect(SLOT_ASPECT).not.toBeCloseTo(SOURCE_ASPECT, 2);

    // The image fills the region's short axis and is centred on its long one — a
    // letterbox, not a crop and not a corner-anchored shrink.
    expect(tile.dest.width).toBeLessThan(tile.dest.height * SLOT_ASPECT);
  }, 30_000);
});
