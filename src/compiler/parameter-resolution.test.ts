import { describe, expect, it } from "vitest";
import { resolveParameters, srgbToLinear } from "../domain/parameters/resolve.ts";
import type { GraphDocument, GraphNode } from "../domain/types/graph.ts";
import type { NodeId } from "../domain/types/ids.ts";
import type { NodeDefinition } from "../domain/types/node-definition.ts";
import type { EffectPassDescriptor, PassDescriptor } from "../runtime/backend/plan.ts";
import { solidNode } from "../nodes/definitions/solid.ts";
import { compileGraph } from "./compile.ts";
import {
  createCompilerTestRegistry,
  testCapabilities,
  testEdge,
  testGraph,
  testNode,
  testSettings,
} from "./test-support.ts";
import type { CompileRequest } from "./types.ts";
import { validateGraph } from "./validate.ts";

/**
 * B8 — the compiler and the inspector resolve parameters through ONE function (§V61, T168).
 *
 * The bug this file exists to keep closed: two implementations of "what is this parameter
 * worth", one in `src/editor/inspector/` and one here. T148's display→linear colour decode
 * (§V56) landed in the editor's copy only, so the inspector showed a corrected mid-grey and
 * the GPU was handed the uncorrected sRGB number and rendered it far too dark. The invariant
 * that was supposed to prevent that — §V61, one read path — had itself drifted.
 *
 * So the headline claim here is deliberately end-to-end: not "the resolver decodes", which
 * was already true and did not help, but "the value in the PLAN is decoded". The plan is
 * what reaches the GPU, and it is the only place the old bug was ever visible.
 */

const registry = createCompilerTestRegistry([solidNode]).view();

const compile = (graph: GraphDocument, overrides: Partial<CompileRequest> = {}) =>
  compileGraph({
    graph,
    settings: testSettings(),
    registry,
    capabilities: testCapabilities(),
    ...overrides,
  });

/** solid -> output. The solid's `color` is declared `space: "display"` (§V56). */
const solidGraph = (color: readonly number[]): GraphDocument =>
  testGraph(
    [testNode("solid" as NodeId, solidNode.type, { parameters: { color } }), testNode("out" as NodeId, "fx.output")],
    [testEdge("e1", ["solid" as NodeId, "out"], ["out" as NodeId, "source"])],
  );

const uniformsOf = (passes: ReadonlyArray<PassDescriptor>, nodeId: string): Record<string, unknown> => {
  const pass = passes.find(
    (candidate): candidate is EffectPassDescriptor =>
      candidate.kind === "effect" && candidate.nodeId === nodeId,
  );
  if (pass === undefined) throw new Error(`no effect pass for "${nodeId}"`);
  return (pass.uniforms ?? {}) as Record<string, unknown>;
};

describe("B8 — a display colour reaches the plan decoded", () => {
  it("puts LINEAR light in the plan for a mid-grey the user picked", () => {
    // 0.5 in sRGB is 0.214 in linear light. Before T168 the plan carried 0.5 — better
    // than twice as bright as the colour the picker had already shown correctly.
    const plan = compile(solidGraph([0.5, 0.5, 0.5, 1]));
    expect(plan.ok).toBe(true);

    const color = uniformsOf(plan.passes, "solid")["color"] as readonly number[];
    expect(color[0]).toBeCloseTo(0.2140, 4);
    expect(color[1]).toBeCloseTo(0.2140, 4);
    expect(color[2]).toBeCloseTo(0.2140, 4);
    // Alpha is coverage, never gamma-encoded, so it is passed straight through.
    expect(color[3]).toBe(1);
  });

  it("passes alpha through unchanged at a value where a decode would be obvious", () => {
    const plan = compile(solidGraph([0.25, 0.5, 0.75, 0.4]));
    const color = uniformsOf(plan.passes, "solid")["color"] as readonly number[];

    expect(color[0]).toBeCloseTo(srgbToLinear(0.25), 10);
    expect(color[1]).toBeCloseTo(srgbToLinear(0.5), 10);
    expect(color[2]).toBeCloseTo(srgbToLinear(0.75), 10);
    expect(color[3]).toBe(0.4);
  });

  it("leaves a space:\"linear\" colour alone — it is already the working space (§V56)", () => {
    const linearSolid: NodeDefinition = {
      ...solidNode,
      type: "solid.linear",
      parameters: {
        color: { type: "color", label: "Color", default: [0, 0, 0, 1], space: "linear" },
      },
    };
    const linearRegistry = createCompilerTestRegistry([linearSolid]).view();
    const graph = testGraph(
      [
        testNode("solid" as NodeId, linearSolid.type, { parameters: { color: [0.5, 0.5, 0.5, 1] } }),
        testNode("out" as NodeId, "fx.output"),
      ],
      [testEdge("e1", ["solid" as NodeId, "out"], ["out" as NodeId, "source"])],
    );

    const plan = compile(graph, { registry: linearRegistry });
    expect(uniformsOf(plan.passes, "solid")["color"]).toEqual([0.5, 0.5, 0.5, 1]);
  });
});

describe("one function, two call sites (§V61)", () => {
  /**
   * The equality this whole task is about, and the thing that will rot first: whatever a
   * future driver, envelope kind or colour rule does, the compiler and the inspector must
   * still land on the same numbers for the same node. Driving BOTH paths over one fixture
   * is the only assertion that can catch a second implementation appearing again.
   */
  const fixtures: ReadonlyArray<{ label: string; parameters: GraphNode["parameters"] }> = [
    { label: "a picked display colour", parameters: { color: [0.5, 0.25, 0.75, 0.6] } },
    { label: "an untouched node falling back to manifest defaults", parameters: {} },
    { label: "a colour the manifest refuses", parameters: { color: [1, 0] } },
    { label: "a colour stored as the wrong type entirely", parameters: { color: "#808080" } },
    { label: "black and white, the ends of the transfer curve", parameters: { color: [0, 0, 0, 1] } },
  ];

  for (const { label, parameters } of fixtures) {
    it(`agrees with the inspector's read path for ${label}`, () => {
      const node = testNode("solid" as NodeId, solidNode.type, { parameters });

      // The compiler's call site: what `NodeDefinition.compile` is handed, and therefore
      // what the plan's uniforms are built from.
      const compilerValues = validateGraph(testGraph([node]), registry).nodes.get("solid" as NodeId)
        ?.parameters;

      // The inspector's call site, through `src/editor/inspector/parameter-resolver.ts`,
      // which is now a re-export of the same function.
      const inspectorValues = resolveParameters(node, solidNode).values;

      expect(compilerValues).toEqual(inspectorValues);
    });
  }

  it("still shows the inspector the value the user picked, not the decoded one", () => {
    // The other half of the contract: identical `values`, but the per-entry value a
    // control renders stays in the space the picker works in, or the swatch would drift
    // its own number on every round trip through the document.
    const node = testNode("solid" as NodeId, solidNode.type, {
      parameters: { color: [0.5, 0.5, 0.5, 1] },
    });
    const resolved = resolveParameters(node, solidNode);

    expect(resolved.get("color")?.value).toEqual([0.5, 0.5, 0.5, 1]);
    expect(resolved.values["color"]).not.toEqual([0.5, 0.5, 0.5, 1]);
  });

  it("reports a refused value once, through the compiler's diagnostics", () => {
    const node = testNode("solid" as NodeId, solidNode.type, { parameters: { color: [1, 0] } });
    const { diagnostics } = validateGraph(testGraph([node]), registry);

    expect(diagnostics.map((diagnostic) => diagnostic.code)).toContain("parameter.type");
  });
});
