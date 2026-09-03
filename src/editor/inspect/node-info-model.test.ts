import { describe, expect, it } from "vitest";
import type { PassDescriptor, ResourceDescriptor } from "@runtime/backend/plan.ts";
import type { ResolvedOutput } from "@compiler/index.ts";
import { buildNodeInfo, formatDecision, resolutionDecision } from "./node-info-model.ts";
import { compiledOf, graphOf, hubWith, node, testRegistry } from "./test-support.ts";

/**
 * The node info model (T145, T146, §I.info, §V85, §V86, §V87).
 *
 * Every case here runs with no GPU, no device and no frame loop: `buildNodeInfo` is a
 * pure read over a plan, a telemetry snapshot and the document. That is not a testing
 * convenience — it IS §V85. A model that needed a live device to answer would have had to
 * collect something, and collecting is what the popup is forbidden from doing.
 */

const registry = testRegistry();

const target = (id: string, size: readonly [number, number]): ResourceDescriptor => ({
  kind: "target",
  id,
  size,
  format: "rgba16float",
});

const effect = (id: string, nodeId: string, resourceId: string): PassDescriptor => ({
  kind: "effect",
  id,
  shader: "",
  target: resourceId,
  nodeId,
});

const output = (nodeId: string, resourceId: string, size: readonly [number, number]): ResolvedOutput => ({
  nodeId,
  portId: "out",
  resourceId,
  resourceKind: "target",
  size,
  format: "rgba16float",
  space: "linear",
  temporal: false,
});

function blurPlan() {
  return compiledOf({
    passes: [effect("blur:p0", "blur", "blur:out")],
    resources: [target("blur:out", [1280, 720])],
    order: ["blur"],
    outputs: [output("blur", "blur:out", [1280, 720])],
    estimatedResourceBytes: 1280 * 720 * 8,
  });
}

describe("the TD field set (§I.info)", () => {
  it("fills every field the popup shows from a plan and a span", () => {
    const plan = blurPlan();
    const { hub } = hubWith(plan, { "blur:p0": 1.25 });
    hub.noteFrame(7);

    const info = buildNodeInfo({
      nodeId: "blur",
      graph: graphOf([node("blur", "test.blur", { label: "Soft Blur" })]),
      registry,
      compiled: plan,
      telemetry: hub,
    });

    expect(info.label).toBe("Soft Blur");
    expect(info.typeTitle).toBe("Blur");
    // TOP class: width/height, aspect, pixelFormat, gpuMemory, curPass.
    expect(info.output?.resolution).toEqual([1280, 720]);
    expect(info.output?.aspect).toBeCloseTo(1280 / 720);
    expect(info.output?.format).toBe("rgba16float");
    expect(info.output?.space).toBe("linear");
    expect(info.estimatedBytes).toBe(1280 * 720 * 8);
    expect(info.timing.total.passCount).toBe(1);
    // Info CHOP: cook_time, total_cooks, cooked_this_frame, cook_frame.
    expect(info.timing.own.gpuMs).toBeCloseTo(1.25);
    expect(info.framesRendered).toBe(1);
    expect(info.renderedThisFrame).toBe(true);
    expect(info.lastRenderedFrame).toBe(7);
    hub.dispose();
  });

  it("falls back to the definition title when the node was never renamed", () => {
    const plan = blurPlan();
    const info = buildNodeInfo({
      nodeId: "blur",
      graph: graphOf([node("blur", "test.blur")]),
      registry,
      compiled: plan,
      telemetry: null,
    });
    expect(info.label).toBe("Blur");
  });

  it("reports bypass, mute and prune from the document and the plan", () => {
    const plan = compiledOf({ pruned: ["blur"] });
    const info = buildNodeInfo({
      nodeId: "blur",
      graph: graphOf([node("blur", "test.blur", { ui: { bypassed: true, muted: true } })]),
      registry,
      compiled: plan,
      runtime: {
        status: "warning",
        gpuMs: null,
        resultAgeFrames: null,
        inferenceBackend: null,
        inferenceMs: null,
        inferenceIsolated: null,
        message: "shader compile failed; showing the last valid plan",
        errorCount: 0,
        warningCount: 2,
        agent: null,
        preview: null,
      },
      telemetry: null,
    });

    expect(info.bypassed).toBe(true);
    expect(info.muted).toBe(true);
    expect(info.pruned).toBe(true);
    expect(info.warningCount).toBe(2);
    expect(info.message).toContain("last valid plan");
  });

  /**
   * B36/§V269 — `outputStale` is a PROGRAM-level fact, supplied by the caller.
   *
   * It used to come from a per-node runtime field that nothing ever published, so the
   * popup rendered a state it could never be in. The field is gone; this is what replaced
   * it, and the assertion is that the answer tracks the BACKEND rather than the node.
   */
  it("reports the output as stale only when the backend says the program is retained", () => {
    const request = {
      nodeId: "blur",
      graph: graphOf([node("blur", "test.blur")]),
      registry,
      compiled: compiledOf({}),
      telemetry: null,
    } as const;

    expect(buildNodeInfo({ ...request }).outputStale).toBe(false);
    expect(buildNodeInfo({ ...request, outputStale: true }).outputStale).toBe(true);
  });

  it("names a flattened node by its source path, not its namespaced id (§V82)", () => {
    const plan = compiledOf({
      passes: [effect("p0", "dreamy1/blur2", "r0")],
      resources: [target("r0", [64, 64])],
      order: ["dreamy1/blur2"],
      sources: [
        {
          nodeId: "dreamy1/blur2",
          path: ["dreamy1"],
          internalNodeId: "blur2",
          sourcePath: "Main / DreamyFeedback_1 / Blur_2",
        },
      ],
    });
    const { hub } = hubWith(plan);
    const info = buildNodeInfo({
      nodeId: "dreamy1/blur2",
      graph: graphOf([node("dreamy1/blur2", "test.blur")]),
      registry,
      compiled: plan,
      telemetry: hub,
    });
    expect(info.sourcePath).toBe("Main / DreamyFeedback_1 / Blur_2");
    hub.dispose();
  });
});

describe("§V86 — an unmeasurable timing reads unavailable, never zero", () => {
  it("reads unavailable with no device timestamp query", () => {
    const plan = blurPlan();
    const { hub } = hubWith(plan, {}, { timestampQuery: false });
    const info = buildNodeInfo({
      nodeId: "blur",
      graph: graphOf([node("blur", "test.blur")]),
      registry,
      compiled: plan,
      telemetry: hub,
    });

    expect(info.timingAvailable).toBe(false);
    expect(info.timing.own.availability).toBe("unavailable");
    expect(info.timing.own.gpuMs).toBeNull();
    // The structural facts survive: only the duration is missing.
    expect(info.timing.own.passCount).toBe(1);
    expect(info.output?.resolution).toEqual([1280, 720]);
    hub.dispose();
  });

  it("reads unavailable when no telemetry is attached at all", () => {
    const plan = blurPlan();
    const info = buildNodeInfo({
      nodeId: "blur",
      graph: graphOf([node("blur", "test.blur")]),
      registry,
      compiled: plan,
      telemetry: null,
    });
    expect(info.timing.total.gpuMs).toBeNull();
    expect(info.timing.total.availability).toBe("unavailable");
  });
});

describe("§V87 — a component reports own / children / total", () => {
  const componentType = "component:dreamy@2";

  const plan = compiledOf({
    passes: [
      effect("tint:p0", "dreamy1/tint1", "r1"),
      effect("blurA:p0", "dreamy1/inner1/blurA", "r2"),
      effect("blurB:p0", "dreamy1/inner1/blurB", "r3"),
      effect("outside:p0", "solid1", "r4"),
    ],
    resources: [
      target("r1", [64, 64]),
      target("r2", [64, 64]),
      target("r3", [64, 64]),
      target("r4", [64, 64]),
    ],
    order: ["solid1", "dreamy1/tint1", "dreamy1/inner1/blurA", "dreamy1/inner1/blurB"],
    sources: [
      {
        nodeId: "dreamy1/tint1",
        path: ["dreamy1"],
        internalNodeId: "tint1",
        sourcePath: "Main / Dreamy_1 / Tint_1",
      },
      {
        nodeId: "dreamy1/inner1/blurA",
        path: ["dreamy1", "dreamy1/inner1"],
        internalNodeId: "blurA",
        sourcePath: "Main / Dreamy_1 / Inner_1 / Blur_A",
      },
      {
        nodeId: "dreamy1/inner1/blurB",
        path: ["dreamy1", "dreamy1/inner1"],
        internalNodeId: "blurB",
        sourcePath: "Main / Dreamy_1 / Inner_1 / Blur_B",
      },
    ],
  });

  const spans = { "tint:p0": 1, "blurA:p0": 2, "blurB:p0": 3, "outside:p0": 40 };

  it("splits the instance's cost, two levels deep, and excludes the rest of the graph", () => {
    const { hub } = hubWith(plan, spans);
    const info = buildNodeInfo({
      nodeId: "dreamy1",
      graph: graphOf([node("dreamy1", componentType)]),
      registry,
      compiled: plan,
      telemetry: hub,
    });

    expect(info.isComponent).toBe(true);
    expect(info.componentId).toBe("dreamy");
    expect(info.componentVersion).toBe(2);
    expect(info.timing.own.gpuMs).toBeCloseTo(1);
    expect(info.timing.children.gpuMs).toBeCloseTo(5);
    expect(info.timing.total.gpuMs).toBeCloseTo(6);
    expect(info.timing.total.passCount).toBe(3);
    expect(info.timing.total.nodeCount).toBe(3);
    // The 40 ms spent outside the component is emphatically not this component's cost.
    expect(info.timing.total.gpuMs).not.toBeCloseTo(46);
    hub.dispose();
  });

  it("does not report only the instance's own pass — the whole point of §V87", () => {
    const { hub } = hubWith(plan, spans);
    const info = buildNodeInfo({
      nodeId: "dreamy1",
      graph: graphOf([node("dreamy1", componentType)]),
      registry,
      compiled: plan,
      telemetry: hub,
    });
    // A flattened instance has NO pass of its own. Reading "own" as the answer would
    // report 1 ms for a component that actually costs 6.
    expect(info.timing.total.gpuMs).toBeGreaterThan(info.timing.own.gpuMs ?? 0);
    hub.dispose();
  });

  it("gives a plain node no children at all", () => {
    const { hub } = hubWith(plan, spans);
    const info = buildNodeInfo({
      nodeId: "solid1",
      graph: graphOf([node("solid1", "test.solid")]),
      registry,
      compiled: plan,
      telemetry: hub,
    });
    expect(info.isComponent).toBe(false);
    expect(info.timing.children.passCount).toBe(0);
    expect(info.timing.total.gpuMs).toBeCloseTo(40);
    hub.dispose();
  });
});

describe("which override or policy decided the value", () => {
  it("names the override when the instance sets one", () => {
    expect(resolutionDecision({ mode: "fixed", width: 512, height: 512 }, undefined)).toEqual({
      source: "override",
      detail: "override · fixed 512x512",
    });
    expect(formatDecision({ mode: "fixed", format: "rgba8unorm" }, undefined)).toEqual({
      source: "override",
      detail: "override · rgba8unorm",
    });
  });

  it("treats an explicit 'auto' override as no override at all", () => {
    // "auto" is the untouched state; it must defer to the definition, not shadow it.
    expect(resolutionDecision({ mode: "auto" }, { kind: "project" }).source).toBe("policy");
    expect(formatDecision({ mode: "auto" }, { kind: "project" }).source).toBe("policy");
  });

  it("falls through to the definition policy, then to inheriting the input", () => {
    expect(resolutionDecision(undefined, { kind: "scale", input: "source", factor: 0.5 })).toEqual({
      source: "policy",
      detail: "node policy · scale",
    });
    expect(resolutionDecision(undefined, undefined).source).toBe("default");
    expect(formatDecision(undefined, undefined).source).toBe("default");
  });

  it("reads the decision off the real node and definition", () => {
    const plan = blurPlan();
    const info = buildNodeInfo({
      nodeId: "blur",
      graph: graphOf([
        node("blur", "test.blur", { resolution: { mode: "scale", factor: 0.5 } }),
      ]),
      registry,
      compiled: plan,
      telemetry: null,
    });
    expect(info.resolutionDecision.source).toBe("override");
    expect(info.resolutionDecision.detail).toContain("0.5x input");
  });
});

describe("a node that materializes nothing", () => {
  it("reports no output rather than inventing a resolution", () => {
    const info = buildNodeInfo({
      nodeId: "blur",
      graph: graphOf([node("blur", "test.blur")]),
      registry,
      compiled: compiledOf(),
      telemetry: null,
    });
    expect(info.output).toBeNull();
    expect(info.outputs).toEqual([]);
    expect(info.estimatedBytes).toBe(0);
  });

  it("survives a node that is not in the document at all", () => {
    const info = buildNodeInfo({
      nodeId: "ghost",
      graph: graphOf([]),
      registry,
      compiled: null,
      telemetry: null,
    });
    expect(info.nodeId).toBe("ghost");
    expect(info.label).toBe("ghost");
    expect(info.output).toBeNull();
  });
});

/** Both channels coalesce behind a timer, so a flush is one macrotask away. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 1));
  await new Promise((resolve) => setTimeout(resolve, 1));
}

describe("§V16 — the metrics pipe reaches the UI without the document", () => {
  it("feeds the canvas's existing per-node channel rather than a second one", async () => {
    const { createNodeRuntimeStore } = await import("@editor/graph-canvas/index.ts");
    const { createTelemetryHub, telemetryPlan } = await import("@runtime/telemetry/index.ts");
    const { fakeTiming } = await import("./test-support.ts");

    // The graph canvas's NodeRuntimeStore IS the sink. If this stopped type-checking or
    // stopped delivering, telemetry would have grown a second per-node channel — which is
    // exactly the duplication §V16's "one out-of-document channel" is there to prevent.
    const store = createNodeRuntimeStore({ intervalMs: 0 });
    const timing = fakeTiming(true);
    const hub = createTelemetryHub({ intervalMs: 0, sink: store });
    hub.attachTimingSource(timing);

    const plan = blurPlan();
    hub.setPlan(telemetryPlan(plan));
    timing.emit({ "blur:p0": 2.5 });
    await settle();

    expect(store.get("blur").gpuMs).toBeCloseTo(2.5);
    hub.dispose();
    store.dispose();
  });

  it("publishes null, not 0, into that channel when timing is unavailable (§V86)", async () => {
    const { createNodeRuntimeStore } = await import("@editor/graph-canvas/index.ts");
    const { createTelemetryHub, telemetryPlan } = await import("@runtime/telemetry/index.ts");
    const { fakeTiming } = await import("./test-support.ts");

    const store = createNodeRuntimeStore({ intervalMs: 0 });
    const hub = createTelemetryHub({ intervalMs: 0, sink: store });
    hub.attachTimingSource(fakeTiming(false));
    hub.setPlan(telemetryPlan(blurPlan()));
    await settle();

    // A 0 here would render as a hairline-thin "this pass is free" edge on the canvas.
    expect(store.get("blur").gpuMs).toBeNull();
    hub.dispose();
    store.dispose();
  });
});
