import { describe, expect, it } from "vitest";
import type { NodeDefinition } from "../domain/types/node-definition.ts";
import { compileGraph } from "./compile.ts";
import { colorSpaceForFormat } from "./color-space.ts";
import { CompilerDiagnosticCode } from "./diagnostics.ts";
import { resolveNodeFormat } from "./format.ts";
import type { FormatRequest } from "./format.ts";
import {
  createCompilerTestRegistry,
  testCapabilities,
  testEdge,
  testGraph,
  testNode,
  testSettings,
} from "./test-support.ts";
import type { BackendCapabilities } from "../domain/types/backend.ts";
import type { GraphDocument } from "../domain/types/graph.ts";

const rgba = { kind: "texture2d", sample: "float", channels: 4 } as const;

const request = (overrides: Partial<FormatRequest> = {}): FormatRequest => ({
  nodeId: "n",
  nodeType: "fx.test",
  override: undefined,
  policy: undefined,
  inputs: { byPort: {}, primaryPort: undefined },
  settings: testSettings(),
  capabilities: testCapabilities(),
  allowsDepth: false,
  ...overrides,
});

describe("resolveNodeFormat — precedence (T28, §V21)", () => {
  it("uses the project working format by default", () => {
    expect(resolveNodeFormat(request()).format).toBe("rgba16float");
  });

  it("uses a fixed policy literally", () => {
    expect(resolveNodeFormat(request({ policy: { kind: "fixed", format: "rgba8unorm" } })).format).toBe(
      "rgba8unorm",
    );
  });

  it("inherits the named input", () => {
    const outcome = resolveNodeFormat(
      request({
        policy: { kind: "inherit", input: "source" },
        inputs: { byPort: { source: "rgba8unorm" }, primaryPort: "source" },
      }),
    );
    expect(outcome.format).toBe("rgba8unorm");
  });

  it("warns and uses the working format when the named input is empty", () => {
    const outcome = resolveNodeFormat(request({ policy: { kind: "inherit", input: "source" } }));
    expect(outcome.format).toBe("rgba16float");
    expect(outcome.diagnostics.map((d) => d.code)).toContain(CompilerDiagnosticCode.formatInputMissing);
  });

  /** §V51: the instance override is the user's word and beats the manifest's. */
  it("lets an instance override beat the definition policy", () => {
    const outcome = resolveNodeFormat(
      request({
        policy: { kind: "fixed", format: "rgba16float" },
        override: { mode: "fixed", format: "rgba8unorm" },
      }),
    );
    expect(outcome.format).toBe("rgba8unorm");
    expect(outcome.source).toBe("override");
  });

  it("defers to the policy when the override is auto", () => {
    const outcome = resolveNodeFormat(
      request({ policy: { kind: "fixed", format: "r32float" }, override: { mode: "auto" } }),
    );
    expect(outcome.format).toBe("r32float");
    expect(outcome.source).toBe("policy");
  });
});

describe("resolveNodeFormat — capability validation (T75, §V12, §V51)", () => {
  const without = (format: string): BackendCapabilities => ({
    ...testCapabilities(),
    formats: testCapabilities().formats.filter((entry) => entry !== format),
  });

  it("falls back with a warning instead of throwing when the device lacks the format", () => {
    const outcome = resolveNodeFormat(
      request({ policy: { kind: "fixed", format: "rgba16float" }, capabilities: without("rgba16float") }),
    );

    expect(outcome.format).toBe("rgba8unorm");
    expect(outcome.fellBack).toBe(true);
    const warning = outcome.diagnostics.find((d) => d.code === CompilerDiagnosticCode.formatUnsupported);
    expect(warning?.severity).toBe("warning");
    // §V51: never a silent swap — the substitution changes the user's colour maths.
    expect(warning?.message).toContain("rgba16float");
    expect(warning?.message).toContain("rgba8unorm");
  });

  it("errors rather than guessing when the device reports no formats at all", () => {
    const outcome = resolveNodeFormat(
      request({
        policy: { kind: "fixed", format: "rgba16float" },
        capabilities: { ...testCapabilities(), formats: [] },
      }),
    );
    expect(outcome.diagnostics.map((d) => d.code)).toContain(CompilerDiagnosticCode.formatNoFallback);
    expect(outcome.diagnostics[0]?.severity).toBe("error");
  });

  it("rejects a depth format on a colour output", () => {
    const outcome = resolveNodeFormat(request({ policy: { kind: "fixed", format: "depth24plus" } }));

    const error = outcome.diagnostics.find((d) => d.code === CompilerDiagnosticCode.formatDepthOnColor);
    expect(error?.severity).toBe("error");
    expect(outcome.format).toBe("rgba16float");
  });

  it("allows a depth format on an output declared as a depth texture", () => {
    const outcome = resolveNodeFormat(
      request({ policy: { kind: "fixed", format: "depth24plus" }, allowsDepth: true }),
    );
    expect(outcome.format).toBe("depth24plus");
    expect(outcome.diagnostics).toEqual([]);
  });
});

describe("format propagation through a graph", () => {
  const registry = createCompilerTestRegistry().view();
  const compile = (graph: GraphDocument, capabilities = testCapabilities()) =>
    compileGraph({ graph, settings: testSettings(), registry, capabilities });

  const chain = (): GraphDocument =>
    testGraph(
      [
        testNode("plate", "fx.plate"),
        testNode("blur", "fx.blur"),
        testNode("out", "fx.output"),
      ],
      [
        testEdge("e1", ["plate", "out"], ["blur", "source"]),
        testEdge("e2", ["blur", "out"], ["out", "source"]),
      ],
    );

  it("inherits a producer's format down the chain", () => {
    const plan = compile(chain());
    const formatOf = (nodeId: string) =>
      plan.outputs.find((output) => output.nodeId === nodeId)?.format;

    expect(formatOf("plate")).toBe("rgba16float");
    expect(formatOf("blur")).toBe("rgba16float");
  });

  it("honours a per-node override and propagates it downstream", () => {
    const graph = chain();
    const plate = graph.nodes["plate"];
    if (plate !== undefined) plate.format = { mode: "fixed", format: "rgba8unorm" };

    const plan = compile(graph);
    expect(plan.outputs.find((output) => output.nodeId === "plate")?.format).toBe("rgba8unorm");
    expect(plan.outputs.find((output) => output.nodeId === "blur")?.format).toBe("rgba8unorm");
  });

  it("still produces a usable plan when the device forces a fallback", () => {
    const capabilities: BackendCapabilities = {
      ...testCapabilities(),
      formats: testCapabilities().formats.filter((format) => format !== "rgba16float"),
    };
    const plan = compile(chain(), capabilities);

    expect(plan.ok).toBe(true);
    const sized = plan.resources.filter(
      (resource): resource is Extract<typeof resource, { format: string }> =>
        resource.kind === "target" || resource.kind === "pingPong",
    );
    expect(sized.some((resource) => resource.format === "rgba16float")).toBe(false);
    expect(plan.diagnostics.map((d) => d.code)).toContain(CompilerDiagnosticCode.formatUnsupported);
  });
});

describe("colour space rides alongside format (doc §16.2)", () => {
  it("derives the space a format implies", () => {
    expect(colorSpaceForFormat("rgba16float")).toBe("linear");
    expect(colorSpaceForFormat("rgba8unorm-srgb")).toBe("encoded");
    expect(colorSpaceForFormat("r32float")).toBe("data");
  });

  it("propagates the space with the format and reports a mix without converting", () => {
    const encoded: NodeDefinition = {
      type: "fx.encoded",
      version: 1,
      title: "Encoded source",
      category: "generator",
      inputs: [],
      outputs: [{ id: "out", label: "Out", type: rgba }],
      parameters: {},
      resolutionPolicy: { kind: "project" },
      formatPolicy: { kind: "fixed", format: "rgba8unorm-srgb" },
      compile: () => ({ passes: [{ shader: "@fragment fn fs() {}" }] }),
    };
    const registry = createCompilerTestRegistry([encoded]).view();

    const graph = testGraph(
      [
        testNode("lin", "fx.generator"),
        testNode("enc", "fx.encoded"),
        testNode("comp", "fx.composite"),
        testNode("out", "fx.output"),
      ],
      [
        testEdge("e1", ["lin", "out"], ["comp", "layers"]),
        testEdge("e2", ["enc", "out"], ["comp", "layers"]),
        testEdge("e3", ["comp", "out"], ["out", "source"]),
      ],
    );
    const plan = compileGraph({
      graph,
      settings: testSettings(),
      registry,
      capabilities: testCapabilities(),
    });

    expect(plan.outputs.find((output) => output.nodeId === "enc")?.space).toBe("encoded");
    expect(plan.outputs.find((output) => output.nodeId === "lin")?.space).toBe("linear");
    const mismatch = plan.diagnostics.find((d) => d.code === CompilerDiagnosticCode.colorSpaceMismatch);
    expect(mismatch?.nodeId).toBe("comp");
    expect(mismatch?.suggestion).toMatch(/conversion node/i);
    // A mismatch is reported, never silently fixed: the plan still renders.
    expect(plan.ok).toBe(true);
  });
});
