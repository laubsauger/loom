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
import { PipelinePanel } from "./pipeline-panel.tsx";
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
  return screen.getByTestId("pipeline").textContent ?? "";
}

/** Mounts the real panel, open, on a real plan. */
function showPipeline(graph: GraphDocument) {
  const plan = compileGraph({ graph, settings, registry, capabilities });
  return {
    plan,
    ...render(
      <PipelinePanel
        open
        onOpenChange={() => {}}
        installed={plan}
        compiled={plan}
        graph={graph}
        registry={registry}
      />,
    ),
  };
}

describe("T1188 — the screen SAYS what the compiler decided", () => {
  it("renders the reachability, format and flow facts of a real plan", () => {
    const graph = chainDocument();
    const { plan } = showPipeline(graph);
    expect(plan.ok).toBe(true);

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
    expect(text).toContain("The flow");
    expect(text).toContain("passes, in encode order");
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

/**
 * A four-node point chain. §V197/T1076 publish an unmodified attribute BY REFERENCE, so
 * the next node in the chain takes over the producer's buffer pair rather than copying
 * it — one resource holding two different nodes' work inside one frame. There is no edge
 * anywhere that says so, which is the whole reason the tape draws it.
 */
function pointChain(): GraphDocument {
  return {
    revision: 1,
    nodes: {
      grid: { id: "grid", type: "pointGrid", definitionVersion: 1, position: { x: 0, y: 0 }, parameters: {}, label: "grid" },
      drift: { id: "drift", type: "pointKernel", definitionVersion: 1, position: { x: 200, y: 0 }, parameters: {}, label: "drift" },
      dots: { id: "dots", type: "renderPoints", definitionVersion: 1, position: { x: 400, y: 0 }, parameters: {}, label: "dots" },
      out: { id: "out", type: "output", definitionVersion: 1, position: { x: 600, y: 0 }, parameters: {}, label: "out" },
    },
    edges: {
      e1: { id: "e1", source: { nodeId: "grid", portId: "out" }, target: { nodeId: "drift", portId: "in" } },
      e2: { id: "e2", source: { nodeId: "drift", portId: "out" }, target: { nodeId: "dots", portId: "points" } },
      e3: { id: "e3", source: { nodeId: "dots", portId: "out" }, target: { nodeId: "out", portId: "input" } },
    },
    groups: {},
  };
}

/**
 * Solid → Cross → Output with a Feedback that names Cross as its source and substeps 4×.
 * One document, two pictures: a value that crosses the frame boundary (§V285) and a
 * body the tape rewinds over (T387).
 */
function loopDocument(): GraphDocument {
  return {
    revision: 1,
    nodes: {
      solid: { id: "solid", type: "solid", definitionVersion: 1, position: { x: 0, y: 0 }, parameters: {}, label: "solid" },
      mix: { id: "mix", type: "cross", definitionVersion: 1, position: { x: 200, y: 0 }, parameters: {}, label: "mix" },
      fb: { id: "fb", type: "feedback", definitionVersion: 1, position: { x: 200, y: 200 }, parameters: { source: "mix", substeps: 4 }, label: "fb" },
      out: { id: "out", type: "output", definitionVersion: 1, position: { x: 400, y: 0 }, parameters: {}, label: "out" },
    },
    edges: {
      e1: { id: "e1", source: { nodeId: "solid", portId: "out" }, target: { nodeId: "mix", portId: "in1" } },
      e2: { id: "e2", source: { nodeId: "fb", portId: "out" }, target: { nodeId: "mix", portId: "in2" } },
      e3: { id: "e3", source: { nodeId: "mix", portId: "out" }, target: { nodeId: "out", portId: "input" } },
    },
    groups: {},
  };
}

function panel(): HTMLElement {
  return screen.getByTestId("pipeline");
}

/**
 * THE DIAGRAM (T1188 design pass).
 *
 * A gate that counts SVG elements is vacuous — it goes green on any drawing. These
 * assert the three claims the picture makes that the node graph structurally cannot,
 * each against a document compiled for real where the claim is known in advance.
 */
describe("T1188 — the frame tape draws what the graph cannot show", () => {
  it("draws one column per pass, in encode order", () => {
    const { plan } = showPipeline(chainDocument());
    const ticks = [...panel().querySelectorAll("[data-pass]")];
    expect(ticks).toHaveLength(plan.passes.length);
    expect(ticks.map((tick) => tick.getAttribute("data-pass"))).toEqual(
      plan.passes.map((pass) => pass.id),
    );
    // Strictly left to right: the x axis IS the encode order, not a layout convenience.
    const xs = ticks.map((tick) => Number(tick.getAttribute("x")));
    expect(xs).toEqual([...xs].sort((a, b) => a - b));
    expect(new Set(xs).size).toBe(xs.length);
  });

  it("draws a REUSED resource as two segments in one lane, side by side", () => {
    const graph = pointChain();
    const { plan } = showPipeline(graph);
    expect(plan.ok).toBe(true);

    // The premise, measured: the compiler really did hand one pair to two nodes.
    const shared = "scratch:grid:@points";
    const lane = panel().querySelector(`[data-lane="${shared}"]`);
    expect(lane, `no lane for ${shared}`).not.toBeNull();

    const segments = [...(lane?.querySelectorAll("[data-segment]") ?? [])];
    expect(segments).toHaveLength(2);
    // Two DIFFERENT nodes, which is what makes it reuse rather than one long tenancy…
    expect(segments.map((rect) => rect.getAttribute("data-owner"))).toEqual(["grid", "drift"]);
    // …and they do not overlap: the storage changes hands at a point on the time axis.
    const [first, second] = segments.map((rect) => ({
      x: Number(rect.getAttribute("x")),
      w: Number(rect.getAttribute("width")),
    }));
    expect(first!.x + first!.w).toBeLessThanOrEqual(second!.x);
    // The gutter says so in words too — the picture is never the only carrier.
    expect(panel().querySelector(`[data-lane-row="${shared}"]`)?.getAttribute("data-aliased")).toBe("true");
  });

  it("draws a temporal value as a span reaching back past the start of the frame", () => {
    const graph = loopDocument();
    const { plan } = showPipeline(graph);
    expect(plan.diagnostics.filter((entry) => entry.severity === "error")).toEqual([]);

    const pair = plan.feedback[0]?.resourceId ?? "";
    expect(pair).not.toBe("");

    // The claim: the pass that READS this resource runs before the pass that writes it,
    // so the value it reads cannot have come from this frame (§V285, §V22).
    const reader = plan.passes.findIndex(
      (pass) => "textures" in pass && (pass.textures ?? []).some((binding) => binding.resourceId === pair),
    );
    const writer = plan.passes.findIndex((pass) => "target" in pass && pass.target === pair);
    expect(reader).toBeGreaterThanOrEqual(0);
    expect(reader).toBeLessThan(writer);

    // And the picture says it: a run entering the lane from x = 0, left of every column.
    const incoming = panel().querySelector(`[data-loopback-in="${pair}"]`);
    expect(incoming, "no incoming frame-boundary run on the feedback lane").not.toBeNull();
    expect(incoming?.getAttribute("d")).toMatch(/^M 0 /);
    expect(panel().querySelector(`[data-loopback-out="${pair}"]`)).not.toBeNull();

    // A plain chain has none of this, so the mark is not simply always drawn.
    cleanup();
    showPipeline(chainDocument());
    expect(panel().querySelector("[data-loopback-in]")).toBeNull();
  });

  it("brackets a substep loop and counts what it really costs per frame", () => {
    const graph = loopDocument();
    const { plan } = showPipeline(graph);

    const bracket = panel().querySelector("[data-loop]");
    expect(bracket, "no substep bracket").not.toBeNull();
    expect(panel().textContent).toContain("×4");

    // The number a pass count never gives you: 4× the loop body, once per displayed frame.
    const text = panelText();
    expect(text).toContain(`passes${plan.passes.length}`);
    expect(text).toContain("encodes / frame14");
  });

  it("marks the resource whose contents LEAVE the frame", () => {
    const { plan } = showPipeline(chainDocument());
    const presented = plan.passes.find(
      (pass) => "target" in pass && "nodeId" in pass && pass.nodeId === "out",
    );
    const target = presented !== undefined && "target" in presented ? presented.target : "";
    expect(target).not.toBe("");
    expect(panel().querySelector(`[data-terminal="${target}"]`)).not.toBeNull();
  });
});
