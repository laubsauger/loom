// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { createMemoryStorage, installDomStubs } from "@ui/testing/install-dom-stubs.ts";
import { installFlowStubs } from "@editor/graph-canvas/testing.tsx";
import type { BackendCapabilities, CompiledExecutionPlan } from "@domain/types/backend.ts";
import type { GraphPatchOperation } from "@domain/types/patch.ts";
import type { ShaderloomBackend } from "@runtime/backend/index.ts";
import type { PixelWindow, PreviewOutputRef, ReadbackImage } from "@runtime/previews/index.ts";
import { App } from "./app.tsx";
import { createAppRuntime } from "./app-runtime.ts";
import { AppRuntimeContext } from "./app-context.ts";
import { ViewerPane } from "./side-panes.tsx";
import { TooltipProvider } from "@ui/primitives/tooltip.tsx";
import type { AppRuntime } from "./app-runtime.ts";
import type { GpuStatus } from "./gpu-status.ts";

/**
 * T329 — T36's features, on the pane the app actually mounts (§V242, B34).
 *
 * There were two `ViewerPane`s and the app shipped the poorer one: the mounted pane owned
 * the real canvas, and the unmounted one had the output selector, the pixel readout with
 * its §V7 rate limiting and the keyboard probe cursor. Thirteenth instance of §V220 and a
 * NEW shape — an unmounted component, invisible to a factory enumeration.
 *
 * The ruling was FOLD, not switch: canvas ownership is the hard part and it already worked.
 * These tests exist so the folded features cannot quietly go missing a second time, which
 * is exactly what happened to them the first time while their own suite stayed green.
 */

beforeAll(() => {
  installDomStubs();
  installFlowStubs();
});
afterEach(cleanup);

const CAPABILITIES: BackendCapabilities = {
  tier: "B",
  features: [],
  formats: ["rgba8unorm", "rgba8unorm-srgb", "rgba16float", "r32float", "depth24plus"],
  timestampQuery: false,
  limits: { maxTextureDimension2D: 8192 },
};

const CANVAS_RECT = { left: 100, top: 50, width: 200, height: 100 };

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

/** One opaque mid-grey pixel, in the format the probe claims. */
function greyPixel(): ReadbackImage {
  const bytes = new Uint8Array([128, 128, 128, 255]);
  return { width: 1, height: 1, format: "rgba8unorm", rowStride: 4, bytes };
}

function fixture() {
  const reads: Array<{ ref: PreviewOutputRef; window: PixelWindow }> = [];
  const presented: string[] = [];
  const backend = {
    status: {
      initialized: true, disposed: false, halted: false, deviceGeneration: 1,
      temporalResets: 0, resourceBuilds: 0, framesSubmitted: 0, readbacks: 0,
      stale: false, estimatedResourceBytes: 0,
    },
    initialize: () => Promise.resolve(CAPABILITIES),
    compile: (plan: unknown) => Promise.resolve({ id: "f", logical: plan } as CompiledExecutionPlan),
    render() {}, resize() {},
    readOutput: (outputId: string, region: PixelWindow) => {
      reads.push({ ref: { nodeId: outputId, portId: "out" }, window: region });
      return Promise.resolve(greyPixel());
    },
    onDiagnostic: () => () => {},
    dispose() {},
    loop: () => ({ stop() {} }),
    updateUniforms() {}, resetTemporalHistory() {},
    recover: () => Promise.resolve(),
    present: (_canvas: unknown, options: { outputId: string }) => {
      presented.push(options.outputId);
      return {
        id: "p", outputId: options.outputId,
        setOutput(next: string) { presented.push(`setOutput:${next}`); },
        dispose() {},
      };
    },
    previewHost: () => ({ setPreviewProgram() {}, presentPreviews() {}, dispose() {} }),
    onGpuTimings: () => () => {},
    compileShader: () => Promise.resolve({ ok: false, validated: false, diagnostics: [] }),
    readBuffer: () => Promise.reject(new Error("no GPU")),
    registerMediaSource: () => () => {},
    setCookPolicy() {},
  } as unknown as ShaderloomBackend;
  return { backend, reads, presented };
}

async function mountViewer(runtime: AppRuntime, backend: ShaderloomBackend) {
  const status: GpuStatus = { kind: "ready", capabilities: CAPABILITIES, baseline: true, backend };
  await act(async () => {
    render(<App runtime={runtime} storage={createMemoryStorage()} gpuProbe={() => Promise.resolve(status)} />);
  });
  const canvas = screen.getByTestId("viewer-canvas") as HTMLCanvasElement;
  canvas.getBoundingClientRect = () =>
    ({ ...CANVAS_RECT, right: 300, bottom: 150, x: 100, y: 50, toJSON: () => "" }) as DOMRect;
  return canvas;
}

/** solid → output, plus a second texture node so the selector has a real choice. */
async function seedTwoOutputs(runtime: AppRuntime): Promise<void> {
  await act(async () => {
    const result = await seed(runtime, [
      { op: "addNode", ref: "$solid", type: "solid", position: { x: 0, y: 0 } },
      { op: "addNode", ref: "$out", type: "output", position: { x: 240, y: 0 } },
      { op: "addNode", ref: "$noise", type: "noise", position: { x: 0, y: 200 } },
      {
        op: "connect",
        source: { nodeId: "$solid", portId: "out" },
        target: { nodeId: "$out", portId: "input" },
      },
    ]);
    expect(result.status).toBe("applied");
  });
}

describe("T329 — the mounted viewer inspects pixels (T36, §V7, §V48)", () => {
  it("reads the pixel under the cursor, at the image coordinate the rect implies", async () => {
    const runtime = newRuntime();
    await seedTwoOutputs(runtime);
    const gpu = fixture();
    const canvas = await mountViewer(runtime, gpu.backend);

    // Halfway across, three quarters down, of a 1280x720 output.
    await act(async () => {
      fireEvent.pointerMove(canvas, { clientX: 200, clientY: 125, buttons: 0 });
    });
    await waitFor(() => expect(gpu.reads.length).toBeGreaterThan(0));

    const window = gpu.reads[0]?.window;
    expect(window?.width).toBe(1);
    expect(window?.height).toBe(1);
    expect(window?.x).toBe(640);
    // v DOWN, the same convention the pointer publishes (§V236): three quarters down a
    // 720-line image is 540, not 180.
    expect(window?.y).toBe(540);

    await waitFor(() => {
      expect(screen.getByTestId("viewer-readout").textContent).toContain("640, 540");
    });
    runtime.dispose();
  });

  it("rate-limits the readback, so a moving cursor cannot become a frame grab (§V7)", async () => {
    const runtime = newRuntime();
    await seedTwoOutputs(runtime);
    const gpu = fixture();
    const canvas = await mountViewer(runtime, gpu.backend);

    await act(async () => {
      for (let step = 0; step < 30; step += 1) {
        fireEvent.pointerMove(canvas, { clientX: 110 + step, clientY: 60, buttons: 0 });
      }
    });
    await waitFor(() => expect(gpu.reads.length).toBeGreaterThan(0));
    // Thirty moves inside one interval coalesce. The number that matters is "far fewer
    // than the moves", not an exact count — the limiter is a clock, not a counter.
    expect(gpu.reads.length).toBeLessThan(5);
    runtime.dispose();
  });

  it("walks the probe cursor with the arrow keys, with no pointer at all (§V19)", async () => {
    const runtime = newRuntime();
    await seedTwoOutputs(runtime);
    const gpu = fixture();
    const canvas = await mountViewer(runtime, gpu.backend);

    // No pointer event has happened: the cursor starts at the image's centre.
    await act(async () => {
      fireEvent.keyDown(canvas, { key: "ArrowRight" });
    });
    await waitFor(() => {
      expect(screen.getByTestId("viewer-readout").textContent).toContain("641, 360");
    });

    // Shift is the coarse step, which is the only way to cross a 1280px image by hand.
    await act(async () => {
      fireEvent.keyDown(canvas, { key: "ArrowDown", shiftKey: true });
    });
    await waitFor(() => {
      expect(screen.getByTestId("viewer-readout").textContent).toContain("641, 370");
    });
    runtime.dispose();
  });

  it("REPOINTS rather than re-attaching when the output changes (§V70)", async () => {
    const runtime = newRuntime();
    await seedTwoOutputs(runtime);
    const gpu = fixture();
    await mountViewer(runtime, gpu.backend);

    const attachesBefore = gpu.presented.filter((entry) => !entry.startsWith("setOutput:")).length;
    const select = screen.getByTestId("viewer-output-select") as HTMLSelectElement;
    const other = [...select.options].map((option) => option.value).find((value) => value !== select.value);
    expect(other).toBeDefined();

    await act(async () => {
      fireEvent.change(select, { target: { value: other } });
    });

    // `setOutput` exists so pinning a different output does not tear down and rebuild the
    // canvas's GPU context. A re-attach here would drop the surface every time the user
    // looked at a different node.
    expect(gpu.presented.some((entry) => entry.startsWith("setOutput:"))).toBe(true);
    expect(gpu.presented.filter((entry) => !entry.startsWith("setOutput:")).length).toBe(attachesBefore);
    runtime.dispose();
  });
});

/**
 * T440/§V354 — `v` puts the selected node on this pane.
 *
 * The happy path lives HERE rather than in `hotkey-reachability.test.tsx` for one
 * environmental reason, stated rather than worked around: `useGraphCompile` needs GPU
 * capabilities, so a GPU-less mount has no `compiled.outputs` and the viewer has nothing
 * to pin. This file already mounts the composed `App` against a fixture backend with a
 * real plan, so it is the only place the assertion can be about a PICTURE.
 *
 * The other half — that pressing `v` at the canvas reaches this command at all, and
 * refuses by name when the node has no output — is asserted at the composed surface in
 * `hotkey-reachability.test.tsx`. Neither half is worth much alone.
 */
describe("T440/§V354 — `v` shows the selected node in the viewer", () => {
  it("pins the viewer to the node the key acted on, not to the declared sink", async () => {
    const runtime = newRuntime();
    await seedTwoOutputs(runtime);
    const gpu = fixture();
    await mountViewer(runtime, gpu.backend);

    const select = screen.getByTestId("viewer-output-select") as HTMLSelectElement;
    // The default is the DECLARED sink. `v` has to move it somewhere else, or this
    // passes on a viewer that ignored the key entirely.
    const sinkValue = select.value;
    const noise = [...document.querySelectorAll<HTMLElement>(".react-flow__node")].find(
      (element) => (element.textContent ?? "").startsWith("noise1"),
    );
    expect(noise, "expected the seeded Noise node to render").toBeDefined();
    if (noise === undefined) return;
    const noiseId = noise.getAttribute("data-id") ?? "";

    await act(async () => {
      fireEvent.pointerDown(noise, { button: 0, isPrimary: true });
      fireEvent.click(noise);
    });
    // Pressed where a user leaves focus, not on a element the test chose (§V351).
    await act(async () => {
      fireEvent.keyDown(document.activeElement ?? document.body, { key: "v" });
    });

    await waitFor(() => {
      expect(
        (screen.getByTestId("viewer-output-select") as HTMLSelectElement).value,
        "`v` did not move the viewer onto the selected node",
      ).toContain(noiseId);
    });
    expect(select.value).not.toBe(sinkValue);

    // Same §V70 promise the selector makes: repoint, never re-attach.
    expect(gpu.presented.some((entry) => entry.startsWith("setOutput:"))).toBe(true);
    runtime.dispose();
  });
});

describe("T622 — the OUTPUT selector speaks node names, not resource ids", () => {
  it("options show the node's label; the value stays the raw key that pinning uses", async () => {
    const runtime = newRuntime();
    await seedTwoOutputs(runtime);
    const gpu = fixture();
    await mountViewer(runtime, gpu.backend);

    const graph = runtime.bus.store.getGraph();
    const solidId = Object.keys(graph.nodes).find((id) => graph.nodes[id]?.type === "solid") ?? "";
    const label = graph.nodes[solidId]?.label ?? "";
    expect(label).not.toBe("");
    expect(label).not.toBe(solidId); // the premise: ids are opaque, labels are human

    const select = screen.getByTestId("viewer-output-select") as HTMLSelectElement;
    const option = [...select.options].find((entry) => entry.value === `${solidId}:out`);
    expect(option).toBeDefined();
    // The row READS as the name the user sees on the node...
    expect(option?.textContent).toContain(`${label}:out`);
    expect(option?.textContent).not.toContain(solidId);
    // ...while the VALUE keys on the stable id, so pinning survives a rename (§V128).
    expect(option?.value).toBe(`${solidId}:out`);
  });
});

describe("a preview-off node gets a sentence, not a blank pane (T763)", () => {
  it("names the switch when the selected node has preview disabled", async () => {
    const runtime = createAppRuntime({
      identityStorage: null,
      actor: { kind: "human", id: "tester", label: "Tester" },
    });
    await runtime.bus.execute(
      "graph.applyPatch",
      {
        baseRevision: runtime.bus.store.getRevision(),
        operations: [
          { op: "addNode", ref: "$noise", type: "noise", position: { x: 0, y: 0 } },
        ],
        label: "seed",
      },
      runtime.invocation,
    );
    const nodeId = Object.keys(runtime.bus.store.getGraph().nodes)[0]!;
    await runtime.bus.execute(
      "graph.applyPatch",
      {
        baseRevision: runtime.bus.store.getRevision(),
        operations: [{ op: "setNodeUi", nodeId, ui: { preview: false } }],
        label: "preview off",
      },
      runtime.invocation,
    );
    const graph = runtime.bus.store.getGraph();
    const compiled = {
      outputs: [
        {
          nodeId,
          portId: "out",
          resourceId: `target:${nodeId}:out`,
          resourceKind: "target",
          size: [64, 64],
          format: "rgba8unorm",
          space: "linear",
          temporal: false,
        },
      ],
      diagnostics: [],
    };
    render(
      <TooltipProvider>
        <AppRuntimeContext.Provider value={runtime}>
          <ViewerPane compiled={compiled as never} graph={graph} backend={null} pointer={null} probe={undefined} />
        </AppRuntimeContext.Provider>
      </TooltipProvider>,
    );
    // Point the viewer at the node the way a user does (v — node.openViewer).
    await act(async () => {
      await runtime.bus.execute("node.openViewer", { nodeIds: [nodeId] }, runtime.invocation);
    });
    // The selector still lists the output; the surface explains instead of blanking.
    expect(await screen.findByTestId("viewer-preview-off")).toBeTruthy();
    runtime.dispose();
  });
});
