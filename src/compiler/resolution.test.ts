import { describe, expect, it } from "vitest";
import { compileGraph } from "./compile.ts";
import { CompilerDiagnosticCode } from "./diagnostics.ts";
import { resolveNodeResolution } from "./resolution.ts";
import type { ResolutionRequest } from "./resolution.ts";
import {
  createCompilerTestRegistry,
  testCapabilities,
  testEdge,
  testGraph,
  testNode,
  testSettings,
} from "./test-support.ts";
import type { GraphDocument, GraphNode } from "../domain/types/graph.ts";

const registry = createCompilerTestRegistry().view();

const compile = (graph: GraphDocument, settings = testSettings()) =>
  compileGraph({ graph, settings, registry, capabilities: testCapabilities() });

const sizeOf = (graph: GraphDocument, nodeId: string, settings = testSettings()) =>
  compile(graph, settings).outputs.find((output) => output.nodeId === nodeId)?.size;

const request = (overrides: Partial<ResolutionRequest> = {}): ResolutionRequest => ({
  nodeId: "n",
  nodeType: "fx.test",
  override: undefined,
  policy: undefined,
  inputs: { byPort: {}, primaryPort: undefined },
  settings: testSettings(),
  ...overrides,
});

describe("resolveNodeResolution — policies (T27, §V21)", () => {
  it("uses the project resolution for a project policy", () => {
    expect(resolveNodeResolution(request({ policy: { kind: "project" } })).size).toEqual([1920, 1080]);
  });

  it("uses a fixed policy literally", () => {
    const outcome = resolveNodeResolution(request({ policy: { kind: "fixed", width: 256, height: 128 } }));
    expect(outcome.size).toEqual([256, 128]);
  });

  it("inherits the named input", () => {
    const outcome = resolveNodeResolution(
      request({
        policy: { kind: "inherit", input: "source" },
        inputs: { byPort: { source: [640, 480] }, primaryPort: "source" },
      }),
    );
    expect(outcome.size).toEqual([640, 480]);
  });

  it("scales the named input and rounds to whole pixels", () => {
    const outcome = resolveNodeResolution(
      request({
        policy: { kind: "scale", input: "source", factor: 0.5 },
        inputs: { byPort: { source: [1921, 1080] }, primaryPort: "source" },
      }),
    );
    expect(outcome.size).toEqual([961, 540]);
  });

  it("falls back to the project resolution — with a warning — when the named input is empty", () => {
    const outcome = resolveNodeResolution(request({ policy: { kind: "inherit", input: "source" } }));
    expect(outcome.size).toEqual([1920, 1080]);
    expect(outcome.diagnostics.map((d) => d.code)).toContain(
      CompilerDiagnosticCode.resolutionInputMissing,
    );
  });

  it("says so when a definition computes its own size", () => {
    const outcome = resolveNodeResolution(request({ policy: { kind: "custom" } }));
    expect(outcome.size).toEqual([1920, 1080]);
    expect(outcome.diagnostics[0]?.code).toBe(CompilerDiagnosticCode.resolutionCustom);
    expect(outcome.diagnostics[0]?.severity).toBe("info");
  });

  it("inherits the primary input when there is no policy at all", () => {
    const outcome = resolveNodeResolution(
      request({ inputs: { byPort: { source: [800, 600] }, primaryPort: "source" } }),
    );
    expect(outcome.size).toEqual([800, 600]);
    expect(outcome.source).toBe("default");
  });
});

describe("resolveNodeResolution — parameter-derived policy (T151)", () => {
  const parameterPolicy = (unit?: "pixels" | "fraction") =>
    ({ kind: "parameter", width: "outWidth", height: "outHeight", unit, input: "in" }) as unknown as NonNullable<
      ResolutionRequest["policy"]
    >;

  it("reads absolute pixel sizes from the named parameters", () => {
    const outcome = resolveNodeResolution(
      request({ policy: parameterPolicy(), parameters: { outWidth: 640, outHeight: 360 } }),
    );
    expect(outcome.size).toEqual([640, 360]);
    expect(outcome.source).toBe("policy");
    expect(outcome.diagnostics).toEqual([]);
  });

  it("scales the input by fractional parameters — the Crop case", () => {
    const outcome = resolveNodeResolution(
      request({
        policy: parameterPolicy("fraction"),
        parameters: { outWidth: 0.5, outHeight: 0.25 },
        inputs: { byPort: { in: [800, 400] }, primaryPort: "in" },
      }),
    );
    expect(outcome.size).toEqual([400, 100]);
  });

  it("falls back with a diagnostic when a named parameter is missing or non-positive", () => {
    const outcome = resolveNodeResolution(
      request({ policy: parameterPolicy(), parameters: { outWidth: 640, outHeight: -3 } }),
    );
    expect(outcome.size).toEqual([1920, 1080]);
    expect(outcome.diagnostics[0]?.code).toBe(CompilerDiagnosticCode.resolutionParameter);
    expect(outcome.diagnostics[0]?.message).toContain("outHeight");
  });
});

describe("resolveNodeResolution — instance override (T72, §V50)", () => {
  it("beats the definition's policy", () => {
    const outcome = resolveNodeResolution(
      request({
        policy: { kind: "fixed", width: 256, height: 128 },
        override: { mode: "fixed", width: 640, height: 360 },
      }),
    );
    expect(outcome.size).toEqual([640, 360]);
    expect(outcome.source).toBe("override");
  });

  it("defers to the policy when the override is auto — the untouched default", () => {
    const outcome = resolveNodeResolution(
      request({ policy: { kind: "fixed", width: 256, height: 128 }, override: { mode: "auto" } }),
    );
    expect(outcome.size).toEqual([256, 128]);
    expect(outcome.source).toBe("policy");
  });

  it("scales the primary input when the override names no port", () => {
    const outcome = resolveNodeResolution(
      request({
        override: { mode: "scale", factor: 0.25 },
        inputs: { byPort: { source: [1920, 1080] }, primaryPort: "source" },
      }),
    );
    expect(outcome.size).toEqual([480, 270]);
  });
});

describe("resolveNodeResolution — limits (§V24)", () => {
  it("clamps to the project limit and warns when it actually clamps", () => {
    const settings = testSettings({
      limits: { ...testSettings().limits, maxResolution: 1024 },
    });
    const outcome = resolveNodeResolution(
      request({ policy: { kind: "fixed", width: 8192, height: 512 }, settings }),
    );

    expect(outcome.size).toEqual([1024, 512]);
    expect(outcome.clamped).toBe(true);
    const warning = outcome.diagnostics.find(
      (d) => d.code === CompilerDiagnosticCode.resolutionClamped,
    );
    expect(warning?.severity).toBe("warning");
    expect(warning?.message).toContain("1024x512");
  });

  it("does not warn when nothing was clamped", () => {
    const outcome = resolveNodeResolution(request({ policy: { kind: "fixed", width: 64, height: 64 } }));
    expect(outcome.clamped).toBe(false);
    expect(outcome.diagnostics).toEqual([]);
  });

  it("never exceeds what the device reports it can allocate (§V12)", () => {
    const outcome = resolveNodeResolution(
      request({
        policy: { kind: "fixed", width: 4096, height: 4096 },
        capabilities: { ...testCapabilities(), limits: { maxTextureDimension2D: 2048 } },
      }),
    );
    expect(outcome.size).toEqual([2048, 2048]);
    expect(outcome.clamped).toBe(true);
  });

  it("never resolves to zero", () => {
    const outcome = resolveNodeResolution(
      request({
        override: { mode: "scale", factor: 0.001 },
        inputs: { byPort: { source: [16, 16] }, primaryPort: "source" },
      }),
    );
    expect(outcome.size).toEqual([1, 1]);
  });
});

describe("resolution propagation through a graph (§V21)", () => {
  const chain = (blurOverrides: Partial<GraphNode> = {}): GraphDocument =>
    testGraph(
      [
        testNode("gen", "fx.generator"),
        testNode("half", "fx.half"),
        testNode("blur", "fx.blur", blurOverrides),
        testNode("out", "fx.output"),
      ],
      [
        testEdge("e1", ["gen", "out"], ["half", "source"]),
        testEdge("e2", ["half", "out"], ["blur", "source"]),
        testEdge("e3", ["blur", "out"], ["out", "source"]),
      ],
    );

  it("carries project -> scale -> inherit down the chain", () => {
    const graph = chain();
    expect(sizeOf(graph, "gen")).toEqual([1920, 1080]);
    expect(sizeOf(graph, "half")).toEqual([960, 540]);
    expect(sizeOf(graph, "blur")).toEqual([960, 540]);
    // The output node's own policy is `project`, so it re-expands.
    expect(sizeOf(graph, "out")).toEqual([1920, 1080]);
  });

  it("lets an instance override interrupt inheritance and propagate downstream", () => {
    const graph = chain({ resolution: { mode: "fixed", width: 512, height: 512 } });
    expect(sizeOf(graph, "half")).toEqual([960, 540]);
    expect(sizeOf(graph, "blur")).toEqual([512, 512]);
  });

  it("resizes with the project resolution rather than per frame", () => {
    const graph = chain();
    const resized = testSettings({ outputResolution: { width: 800, height: 400 } });
    expect(sizeOf(graph, "half", resized)).toEqual([400, 200]);
  });

  it("reports the clamp against the node it happened on", () => {
    const graph = chain({ resolution: { mode: "fixed", width: 9000, height: 9000 } });
    const plan = compile(graph);
    const warning = plan.diagnostics.find((d) => d.code === CompilerDiagnosticCode.resolutionClamped);
    expect(warning?.nodeId).toBe("blur");
    expect(plan.outputs.find((output) => output.nodeId === "blur")?.size).toEqual([4096, 4096]);
  });
});

/**
 * TD "Fit Resolution" / "Limit Resolution" (§V50). Both preserve aspect. The property
 * that separates them: fit scales in BOTH directions, limit only ever shrinks.
 */
describe("resolveNodeResolution — fit and limit overrides", () => {
  const withInput = (size: readonly [number, number], override: ResolutionRequest["override"]) =>
    resolveNodeResolution(
      request({ override, inputs: { byPort: { in: size }, primaryPort: "in" } }),
    );

  it("fit scales an oversized input down into the box", () => {
    expect(withInput([2000, 1000], { mode: "fit", width: 512, height: 512 }).size).toEqual([512, 256]);
  });

  it("fit scales a small input UP to the box", () => {
    expect(withInput([200, 100], { mode: "fit", width: 800, height: 800 }).size).toEqual([800, 400]);
  });

  it("limit shrinks an oversized input", () => {
    expect(withInput([2000, 1000], { mode: "limit", width: 512, height: 512 }).size).toEqual([512, 256]);
  });

  it("limit leaves an input already inside the box alone", () => {
    expect(withInput([200, 100], { mode: "limit", width: 800, height: 800 }).size).toEqual([200, 100]);
  });

  it("both report the override as the source", () => {
    expect(withInput([2000, 1000], { mode: "fit", width: 512, height: 512 }).source).toBe("override");
    expect(withInput([2000, 1000], { mode: "limit", width: 512, height: 512 }).source).toBe("override");
  });
});
