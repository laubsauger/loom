// @vitest-environment jsdom
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { createMemoryStorage, installDomStubs } from "@ui/testing/install-dom-stubs.ts";
import { installFlowStubs } from "@editor/graph-canvas/testing.tsx";
import type { BackendCapabilities } from "@domain/types/backend.ts";
import type { GraphPatchOperation } from "@domain/types/patch.ts";
import type { PreviewProgram } from "@runtime/previews/index.ts";
import type { ShaderloomBackend } from "@runtime/backend/index.ts";
import { App } from "../../app/app.tsx";
import { createAppRuntime } from "../../app/app-runtime.ts";
import type { AppRuntime } from "../../app/app-runtime.ts";
import type { GpuStatus } from "../../app/gpu-status.ts";

/**
 * §V142 — the camera is free (B13).
 *
 * Every preview in the graph flickered black together for a frame while panning or zooming.
 * "Together" was the diagnosis: one shared cause, not per-node trouble. The tile a preview
 * renders into was sized from its ON-SCREEN rect, which carries the graph zoom, and a tile
 * that panned off screen surrendered its slot — so a camera move changed the preview PROGRAM,
 * and installing a program rebuilds every tile in it at once.
 *
 * Deliberately at the COMPOSED level. Every layer here passed its own suite while the bug was
 * live (§B — B9 and B10 are both exactly that), so a test that proved `tileSizeFor` ignores
 * zoom in isolation would have proved nothing about the app: the viewport transform is driven
 * through the real React Flow surface, and what is counted is what the real backend seam
 * receives. The counters are the three things a camera move must not move: compiles, preview
 * surface registrations, and preview program installs (each of which reallocates tiles).
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

interface Counters {
  /** `backend.compile()` — the plan itself. The viewport is view state and must not reach it. */
  compiles: number;
  /** `backend.previewHost()` — the shared presentation surface, created once per backend. */
  surfaceRegistrations: number;
  /** `setPreviewProgram()` — each call reallocates every tile in the program (§V8). */
  programInstalls: number;
  programs: PreviewProgram[];
}

function countingBackend(): { backend: ShaderloomBackend; counters: Counters } {
  const counters: Counters = {
    compiles: 0,
    surfaceRegistrations: 0,
    programInstalls: 0,
    programs: [],
  };
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
    previewHost: () => {
      counters.surfaceRegistrations += 1;
      return {
        setPreviewProgram: (program: PreviewProgram) => {
          counters.programInstalls += 1;
          counters.programs.push(program);
        },
        presentPreviews: () => {},
        dispose: () => {},
      };
    },
    present: () => ({ id: "present-stub", outputId: "", setOutput: () => {}, dispose: () => {} }),
    onGpuTimings: () => () => {},
    compile: async () => {
      counters.compiles += 1;
      return { id: "plan", passes: [] };
    },
    render: () => {},
    resize: () => {},
    updateUniforms: () => {},
    resetTemporalHistory: () => {},
    // T326: part of the backend contract; a fixture without it is incomplete.
    setCookPolicy() {},
    dispose: () => {},
  } as unknown as ShaderloomBackend;
  return { backend, counters };
}

function domRect(x: number, y: number, width: number, height: number): DOMRect {
  return { x, y, width, height, top: y, left: x, right: x + width, bottom: y + height, toJSON: () => ({}) } as DOMRect;
}

/**
 * jsdom has no layout, and a preview slot with no size is never scheduled. The node box and
 * the slot inside it get plausible CSS-pixel rects; only the DELTA between them is read, so
 * these are sizes rather than a pretend layout.
 */
function installLayoutStubs(): void {
  const base = Element.prototype.getBoundingClientRect;
  Object.defineProperty(Element.prototype, "getBoundingClientRect", {
    configurable: true,
    value: function stub(this: Element): DOMRect {
      if (this.classList.contains("react-flow__node")) return domRect(100, 100, 178, 130);
      if (this.closest('[data-testid^="node-preview-"]') !== null) return domRect(110, 150, 160, 90);
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

/**
 * d3-zoom reads `event.view`, and jsdom's own brand check rejects the test realm's window as
 * a `MouseEvent` init member — so it is attached after construction. Without this, React
 * Flow's pan gesture does nothing and the test would pass by not moving the camera at all.
 */
function mouse(target: Element | Document, type: string, init: MouseEventInit): void {
  const doc = target instanceof Document ? target : target.ownerDocument;
  const win = doc.defaultView;
  if (win === null) throw new Error("no window");
  const event = new win.MouseEvent(type, { bubbles: true, cancelable: true, ...init });
  Object.defineProperty(event, "view", { value: win });
  target.dispatchEvent(event);
}

function transformOf(container: HTMLElement): string {
  return container.querySelector<HTMLElement>(".react-flow__viewport")?.style.transform ?? "none";
}

/** Long enough for several preview ticks — the tick runs at display rate, off its own rAF. */
async function ticks(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 120));
  });
}

async function mountWithPreviews() {
  const runtime = newRuntime();
  await seed(runtime, [
    { op: "addNode", ref: "$solid", type: "solid", position: { x: 0, y: 0 } },
    { op: "addNode", ref: "$out", type: "output", position: { x: 240, y: 0 } },
    {
      op: "connect",
      source: { nodeId: "$solid", portId: "out" },
      target: { nodeId: "$out", portId: "input" },
    },
  ]);

  const { backend, counters } = countingBackend();
  const status: GpuStatus = { kind: "ready", capabilities: CAPABILITIES, baseline: true, backend };
  // Stable identity: a fresh function every render would restart the probe effect.
  const probe = () => Promise.resolve(status);

  const view = render(<App runtime={runtime} storage={createMemoryStorage()} gpuProbe={probe} />);
  await act(async () => {});
  await waitFor(() => {
    expect(view.container.querySelectorAll(".react-flow__node").length).toBeGreaterThan(0);
  });
  await ticks();

  const pane = view.container.querySelector(".react-flow__pane");
  if (pane === null) throw new Error("the canvas has no pan surface");
  return { runtime, view, counters, pane };
}

describe("§V142 — a camera move costs no allocation (B13)", () => {
  it("neither pan nor zoom recompiles, re-registers the surface, or reinstalls the program", async () => {
    const { view, counters, pane } = await mountWithPreviews();

    // NON-VACUITY: counting zero afterwards means nothing unless previews are actually
    // running. One tile, sized from the node's preview area (160 CSS px -> the 192 ladder
    // step) rather than from the on-screen rect, which at this zoom would be ~62.
    expect(counters.surfaceRegistrations).toBe(1);
    const installed = counters.programs[counters.programs.length - 1];
    expect(installed?.passes).toHaveLength(1);
    expect(
      installed?.resources.filter((resource) => resource.kind === "target"),
    ).toHaveLength(1);

    // T252: the preview scheduler's kept set converges via ONE recompile after the
    // first tick registers visible tiles. Settle that handshake before baselining —
    // the claim under test is that a CAMERA MOVE costs nothing, not that startup does.
    for (let settle = 0; settle < 10; settle += 1) {
      const before = counters.compiles;
      await ticks();
      if (counters.compiles === before) break;
    }

    const baseline = { ...counters };
    const framing = transformOf(view.container);

    // --- PAN: middle-drag, which is what `panOnDrag={[1]}` binds ------------------------
    await act(async () => {
      mouse(pane, "mousedown", { button: 1, buttons: 4, clientX: 500, clientY: 400 });
      for (let step = 1; step <= 20; step += 1) {
        mouse(pane.ownerDocument, "mousemove", {
          button: 1,
          buttons: 4,
          clientX: 500 - step * 15,
          clientY: 400 - step * 9,
        });
      }
      mouse(pane.ownerDocument, "mouseup", { button: 1, buttons: 0, clientX: 200, clientY: 220 });
    });
    await ticks();

    const panned = transformOf(view.container);
    // The gesture really moved the camera — otherwise this test proves nothing.
    expect(panned).not.toBe(framing);
    expect({ ...counters, programs: baseline.programs }).toEqual(baseline);

    // --- ZOOM: the wheel, across enough steps to cross several tile ladder steps --------
    await act(async () => {
      for (let step = 0; step < 12; step += 1) {
        const wheel = new (pane.ownerDocument.defaultView as Window & typeof globalThis).WheelEvent(
          "wheel",
          { bubbles: true, cancelable: true, deltaY: -40, clientX: 500, clientY: 400 },
        );
        Object.defineProperty(wheel, "view", { value: pane.ownerDocument.defaultView });
        pane.dispatchEvent(wheel);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    });
    await ticks();

    // Zoom really changed — a pan-only assertion would have passed the whole time.
    expect(transformOf(view.container)).not.toBe(panned);
    expect({ ...counters, programs: baseline.programs }).toEqual(baseline);
  }, 30_000);
});
