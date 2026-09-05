// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { createMemoryStorage, installDomStubs } from "@ui/testing/install-dom-stubs.ts";
import { installFlowStubs } from "@editor/graph-canvas/testing.tsx";
import { DEFAULT_BINDINGS } from "@editor/keymap/index.ts";
import { compileGraph } from "@compiler/index.ts";
import { createNodeRegistry } from "@nodes/registry/registry.ts";
import { allNodeDefinitions } from "@nodes/definitions/index.ts";
import type { BackendCapabilities } from "@domain/types/backend.ts";
import type { GraphDocument, ProjectSettings } from "@domain/types/graph.ts";
import { App } from "@/app/app.tsx";
import { createAppRuntime } from "@/app/app-runtime.ts";
import type { AppRuntime } from "@/app/app-runtime.ts";
import type { GpuStatus } from "@/app/gpu-status.ts";
import { buildPipelineView } from "./pipeline-model.ts";
import { PipelineReport } from "./pipeline-panel.tsx";
import { SHOW_PIPELINE_COMMAND, registerPipelineCommand } from "./pipeline-command.ts";

/**
 * The pipeline inspector on screen (T1188, §V307, §B179).
 *
 * `pipeline-model.test.ts` makes the claims about what the COMPILER decided; this file
 * makes the two claims that only a rendered surface can: the sentences the model derived
 * actually reach the DOM, and the command that opens the panel is registered by the
 * composed app rather than by its own test (§V220 — "built, tested, never wired" is this
 * project's dominant bug class).
 */

beforeAll(() => {
  installDomStubs();
  installFlowStubs();
});
afterEach(cleanup);

const NO_GPU: GpuStatus = { kind: "unavailable", reason: "No WebGPU in this environment." };

const settings: ProjectSettings = {
  outputResolution: { width: 256, height: 128 },
  workingFormat: "rgba16float",
  randomSeed: 1,
  previewLongEdge: 192,
  previewFps: 20,
  limits: {
    maxResolution: 4096,
    maxDispatch: 65535,
    maxBufferBytes: 268_435_456,
    memoryBudgetBytes: 1_073_741_824,
  },
};

const capabilities: BackendCapabilities = {
  tier: "B",
  features: [],
  formats: ["rgba8unorm", "rgba8unorm-srgb", "rgba16float", "r32float", "depth24plus"],
  timestampQuery: false,
  limits: { maxTextureDimension2D: 8192 },
};

const registry = createNodeRegistry(allNodeDefinitions).view();

/**
 * Solid → Blur → Output, plus an orphan branch and a value-source knob, with the Blur
 * pinned to a format the project does not use. One document, four decisions.
 */
function chainDocument(): GraphDocument {
  return {
    revision: 1,
    nodes: {
      solid: { id: "solid", type: "solid", definitionVersion: 1, position: { x: 0, y: 0 }, parameters: {}, label: "solid" },
      blur: {
        id: "blur",
        type: "blur",
        definitionVersion: 1,
        position: { x: 200, y: 0 },
        parameters: {},
        label: "blur",
        format: { mode: "fixed", format: "rgba8unorm" },
      },
      out: { id: "out", type: "output", definitionVersion: 1, position: { x: 400, y: 0 }, parameters: {}, label: "out" },
      orphan: { id: "orphan", type: "noise", definitionVersion: 1, position: { x: 0, y: 200 }, parameters: {}, label: "orphan" },
      knob: { id: "knob", type: "constant", definitionVersion: 1, position: { x: 0, y: 300 }, parameters: {}, label: "knob" },
    },
    edges: {
      e1: { id: "e1", source: { nodeId: "solid", portId: "out" }, target: { nodeId: "blur", portId: "input" } },
      e2: { id: "e2", source: { nodeId: "blur", portId: "out" }, target: { nodeId: "out", portId: "input" } },
    },
    groups: {},
  };
}

function newRuntime(): AppRuntime {
  return createAppRuntime({
    identityStorage: null,
    actor: { kind: "human", id: "tester", label: "Tester" },
  });
}

/** The whole rendered panel as one string — what a reader would actually see. */
function panelText(): string {
  return screen.getByTestId("pipeline-install").parentElement?.textContent ?? "";
}

describe("T1188 — the screen SAYS what the compiler decided", () => {
  it("renders the reachability, format and flow facts of a real plan", () => {
    const graph = chainDocument();
    const plan = compileGraph({ graph, settings, registry, capabilities });
    expect(plan.ok).toBe(true);

    render(<PipelineReport view={buildPipelineView({ installed: plan, compiled: plan, graph, registry })} />);

    // The banner first, because it decides whether anything else is worth reading.
    expect(screen.getByTestId("pipeline-install").getAttribute("data-kind")).toBe("running");

    const text = panelText();
    // §B179: two nodes are off the plan and only ONE of them is in `plan.pruned`.
    expect(plan.pruned).toEqual(["orphan"]);
    expect(text).toContain("2 of 5 nodes are NOT in the running pipeline — 1 unreachable, 1 off-plan");
    expect(text).toContain("orphan — unreachable");
    expect(text).toContain("knob — off-plan by design");
    // The format the user pinned, and the pass where it changes.
    expect(text).toContain("blur — reads rgba16float, writes rgba8unorm.");
    // And the flow itself, in encode order.
    expect(text).toContain("The flow — ");
    expect(screen.getAllByRole("row").length).toBeGreaterThan(1);
  });

});

describe("T1188 — one command, and the composed app registers it (§V307, §V78)", () => {
  it("registers `ui.showPipeline` on the composed app's bus and binds a key to it", async () => {
    const runtime = newRuntime();
    await act(async () => {
      render(
        <App runtime={runtime} storage={createMemoryStorage()} gpuProbe={() => Promise.resolve(NO_GPU)} />,
      );
    });

    expect(runtime.bus.hasCommand(SHOW_PIPELINE_COMMAND)).toBe(true);
    expect(DEFAULT_BINDINGS.some((binding) => binding.command === SHOW_PIPELINE_COMMAND)).toBe(true);
    runtime.dispose();
  });

  it("opens the panel when the command runs, with no button involved", async () => {
    const runtime = newRuntime();
    await act(async () => {
      render(
        <App runtime={runtime} storage={createMemoryStorage()} gpuProbe={() => Promise.resolve(NO_GPU)} />,
      );
    });
    expect(screen.queryByTestId("pipeline")).toBeNull();

    await act(async () => {
      await runtime.bus.execute(SHOW_PIPELINE_COMMAND, {}, runtime.invocation);
    });

    expect(screen.getByTestId("pipeline")).toBeDefined();
    runtime.dispose();
  });

  it("refuses honestly when no surface is mounted, rather than pretending", async () => {
    const runtime = newRuntime();
    registerPipelineCommand(runtime.bus);

    const result = await runtime.bus.execute(SHOW_PIPELINE_COMMAND, {}, runtime.invocation);

    expect(result.status).toBe("rejected");
    expect(result.output).toEqual({ opened: false });
    runtime.dispose();
  });
});
