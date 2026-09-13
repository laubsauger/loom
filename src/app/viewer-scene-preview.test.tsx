// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { installDomStubs } from "@ui/testing/install-dom-stubs.ts";
import { TooltipProvider } from "@ui/primitives/tooltip.tsx";
import { createAppRuntime } from "./app-runtime.ts";
import { AppRuntimeContext } from "./app-context.ts";
import { ViewerPane } from "./side-panes.tsx";
import type { AppRuntime } from "./app-runtime.ts";
import type { GraphPatchOperation } from "@domain/types/patch.ts";
import type { CompiledGraph } from "@compiler/index.ts";
import type { LoomBackend } from "@runtime/backend/index.ts";

/**
 * §B220 — SELECTING A SCENE NODE IN THE VIEWER HAS TO SHOW SOMETHING.
 *
 * A camera, light, geometry, material or pointset node has NO MAIN-PROGRAM TARGET, ever. Its
 * picture is synthesised by the preview system, which is why it draws fine on a node tile and
 * drew NOTHING in the viewer: `backend.present` binds main-program targets and the row is not
 * one. Two presentation paths sharing the verb `present` and meeting nowhere.
 *
 * ⚑ THIS FILE MOUNTS `ViewerPane` ALONE, AND THAT IS THE POINT RATHER THAN A CONVENIENCE.
 * The graph pane is not rendered here — so this is the graph-pane-CLOSED case by construction.
 * It matters because the viewer's `interest` store is consumed by `useNodePreviews`, which
 * runs in the GRAPH PANE ONLY: before this fix, a viewer selection reached the preview system
 * only when somebody happened to have the other pane open. A fix that passed with the graph
 * pane mounted and failed without it would be a §V998 half-fix wearing a green test.
 *
 * ⚑ WHAT IS ASSERTED IS THE ASK AND THE SURFACE, NOT THE PIXELS. jsdom has no GPU, so the
 * honest claim here is that the viewer (1) ASKS for the synthesis — registering a preview
 * sink is the only way the row comes to exist at all (§V309: "off costs nothing — no pass, no
 * target, no bytes") — and (2) mounts the surface that path draws on. Both were absent before
 * this fix, and either one missing puts the picture back to black.
 */

beforeAll(() => {
  installDomStubs();
});
afterEach(cleanup);

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

const COMMON = {
  resourceKind: "target",
  size: [960, 540],
  format: "rgba8unorm",
  space: "linear",
  temporal: false,
} as const;

/**
 * The row a scene payload compiles to once a sink watches it: its passes and target belong to
 * the PREVIEW program, which is exactly why `synthesis` is present and the main program has
 * nothing to bind.
 */
function sceneOutputs(nodeId: string): CompiledGraph["outputs"] {
  return [
    {
      nodeId,
      portId: "out",
      resourceId: `scenePreview:${nodeId}:out`,
      ...COMMON,
      synthesis: {
        kind: "camera",
        depth: true,
        passes: [{ id: `${nodeId}#scenePreview:out` }],
        orbit: { eye: [0, 0, -4], lookAt: [0, 0, 0] },
      },
    },
  ] as unknown as CompiledGraph["outputs"];
}

/** An ordinary texture row: a main-program target, no synthesis. The control. */
function textureOutputs(nodeId: string): CompiledGraph["outputs"] {
  return [
    { nodeId, portId: "out", resourceId: `target:${nodeId}:out`, ...COMMON },
  ] as unknown as CompiledGraph["outputs"];
}

function recordingBackend() {
  const hosted: HTMLCanvasElement[] = [];
  return {
    hosted,
    backend: {
      updateUniforms() {},
      present: () => ({ id: "p", outputId: "x", setOutput() {}, dispose() {} }),
      previewHost: (canvas: HTMLCanvasElement) => {
        hosted.push(canvas);
        return {
          build: () => ({}),
          refresh() {},
          composite() {},
          dispose() {},
        };
      },
      status: { deviceGeneration: 1 },
      onDiagnostic: () => () => {},
    } as unknown as LoomBackend,
  };
}

async function mount(kind: "scene" | "texture") {
  vi.stubGlobal("requestAnimationFrame", () => 1);
  vi.stubGlobal("cancelAnimationFrame", () => {});
  const runtime = newRuntime();
  await seed(runtime, [
    { op: "addNode", ref: "$cam", type: "camera", position: { x: 0, y: 0 } },
  ]);
  const graph = runtime.bus.store.getGraph();
  const nodeId = Object.keys(graph.nodes)[0]!;
  const { backend, hosted } = recordingBackend();
  const sinkRefs: Array<ReadonlyArray<{ nodeId: string; portId: string }>> = [];
  const compiled = {
    outputs: kind === "scene" ? sceneOutputs(nodeId) : textureOutputs(nodeId),
    diagnostics: [],
  } as unknown as CompiledGraph;
  render(
    <TooltipProvider>
      <AppRuntimeContext.Provider value={runtime}>
        <ViewerPane
          compiled={compiled}
          graph={graph}
          backend={backend}
          previewSinks={{ set: (refs) => sinkRefs.push(refs) }}
        />
      </AppRuntimeContext.Provider>
    </TooltipProvider>,
  );
  const select = screen.getByTestId("viewer-output-select") as HTMLSelectElement;
  await act(async () => {
    fireEvent.change(select, { target: { value: `${nodeId}:out` } });
  });
  return { runtime, nodeId, sinkRefs, hosted };
}

describe("§B220 — the viewer presents a scene node", () => {
  it("ASKS for the synthesis, with no graph pane anywhere", async () => {
    const { runtime, nodeId, sinkRefs } = await mount("scene");
    /* The sink is what MAKES the row exist. Before this fix the viewer published only
       `interest`, which is a pin on a tile the graph pane had already built — so with no
       graph pane there was nothing to pin and nothing was ever synthesised. */
    const asked = sinkRefs.flat().some((ref) => ref.nodeId === nodeId && ref.portId === "out");
    expect(asked, "the viewer must register its selection as a preview sink").toBe(true);
    runtime.dispose();
  });

  it("mounts the surface the preview path draws on", async () => {
    const { runtime } = await mount("scene");
    /* A synthesis row cannot be presented through `backend.present`, so the viewer puts up
       the preview system's own surface. Its absence is the black picture, exactly. */
    expect(screen.queryByTestId("viewer-synthesis-canvas")).not.toBeNull();
    // And the pane is a working pane, not an error state.
    expect(screen.getByTestId("viewer-picture")).not.toBeNull();
    runtime.dispose();
  });

  it("⚑ leaves an ordinary texture output on the path it already had", async () => {
    const { runtime } = await mount("texture");
    /* The control, and the assertion that keeps this fix from becoming a regression: a row
       WITH a main-program target must still present through `backend.present`. If the second
       surface appeared here it would mean every output had been rerouted through the preview
       system — a much larger change wearing this bug's clothes. */
    expect(screen.queryByTestId("viewer-synthesis-canvas")).toBeNull();
    expect(screen.getByTestId("viewer-canvas")).not.toBeNull();
    runtime.dispose();
  });
});
