import { describe, expect, it } from "vitest";
import { compileGraph } from "../../compiler/compile.ts";
import { effectiveMaxResolution, resolveNodeResolution } from "../../compiler/resolution.ts";
import { resolveNodeFormat } from "../../compiler/format.ts";
import {
  FILTER_WGSL,
  createCompilerTestRegistry,
  testCapabilities,
  testEdge,
  testGraph,
  testNode,
  testSettings,
} from "../../compiler/test-support.ts";
import { asCompilerContext } from "../../compiler/types.ts";
import type { GraphDocument } from "../../domain/types/graph.ts";
import type { NodeDefinition } from "../../domain/types/node-definition.ts";

/**
 * T45 gap-fill: resolution and format propagation (§V21, §V24, §V50, §V51).
 *
 * `src/compiler/resolution.test.ts` and `format.test.ts` are thorough about the shapes they
 * cover. What they never enter are four override branches, the whole of `primaryPort`
 * selection (every existing fixture has exactly one input, so "the FIRST declared connected
 * input" has never had a second one to beat), and the first-edge-wins rule on a variadic
 * port — which decides what a Composite inherits when its layers disagree, and is therefore
 * a determinism question, not a cosmetic one.
 */

const rgba = { kind: "texture2d", sample: "float", channels: 4 } as const;

/**
 * The fixture the existing suite has no equivalent of: TWO declared inputs.
 *
 * Declaration order is the author's statement of which input matters, and `compile.ts`
 * reads it literally — "the first DECLARED input that actually has something on it". With
 * one input that rule is unobservable. With `base` declared before `detail`, it is the
 * whole behaviour.
 */
const twoInputNode: NodeDefinition = {
  type: "fx.merge",
  version: 1,
  title: "Merge",
  category: "composite",
  inputs: [
    { id: "base", label: "Base", type: rgba, optional: true },
    { id: "detail", label: "Detail", type: rgba, optional: true },
  ],
  outputs: [{ id: "out", label: "Out", type: rgba }],
  parameters: {},
  // No policy at all: this exercises the `default` branch, which follows the primary input.
  compile: (raw) => {
    const context = asCompilerContext(raw);
    return {
      passes: [
        {
          shader: FILTER_WGSL,
          samplers: [{ binding: "inputSampler", resourceId: context.sampler }],
          textures: Object.values(context.inputs)
            .flat()
            .map((binding, index) => ({ binding: `tex${index}`, resourceId: binding.resourceId })),
        },
      ],
    };
  },
};

const settings = testSettings();
const capabilities = testCapabilities();
const registry = () => createCompilerTestRegistry([twoInputNode]).view();
const compile = (graph: GraphDocument, overrides: Partial<typeof settings> = {}) =>
  compileGraph({
    graph,
    settings: { ...settings, ...overrides },
    registry: registry(),
    capabilities,
  });

const sizeOf = (plan: ReturnType<typeof compile>, nodeId: string): readonly [number, number] => {
  const output = plan.outputs.find((entry) => entry.nodeId === nodeId);
  if (output === undefined) throw new Error(`no output for ${nodeId}`);
  return output.size;
};
const formatOf = (plan: ReturnType<typeof compile>, nodeId: string): string => {
  const output = plan.outputs.find((entry) => entry.nodeId === nodeId);
  if (output === undefined) throw new Error(`no output for ${nodeId}`);
  return output.format;
};

describe("§V50 — override modes with no existing coverage", () => {
  const base = {
    nodeId: "n",
    nodeType: "fx.test",
    policy: { kind: "fixed", width: 100, height: 50 } as const,
    settings,
  };

  /**
   * `mode: "input"` — "take the size of whatever is plugged in here".
   *
   * Two of the seven override branches (`input`, `project`) are entered by no test in the
   * suite. They are also the two a user reaches first in the inspector's dropdown, so a
   * regression in either is a regression in the common case.
   */
  it("resolution override 'input' reads the named port and beats the policy", () => {
    const outcome = resolveNodeResolution({
      ...base,
      override: { mode: "input", input: "detail" },
      inputs: { byPort: { base: [800, 600], detail: [320, 240] }, primaryPort: "base" },
    });
    expect(outcome.source).toBe("override");
    expect(outcome.size).toEqual([320, 240]);
    expect(outcome.diagnostics).toEqual([]);
  });

  it("resolution override 'input' with no port named falls back to the primary input", () => {
    const outcome = resolveNodeResolution({
      ...base,
      override: { mode: "input" },
      inputs: { byPort: { base: [800, 600], detail: [320, 240] }, primaryPort: "base" },
    });
    expect(outcome.size).toEqual([800, 600]);
  });

  it("resolution override 'project' ignores both the policy and the inputs", () => {
    const outcome = resolveNodeResolution({
      ...base,
      override: { mode: "project" },
      inputs: { byPort: { base: [320, 240] }, primaryPort: "base" },
    });
    expect(outcome.source).toBe("override");
    expect(outcome.size).toEqual([1920, 1080]);
  });

  /**
   * `fit` and `limit` on a DISCONNECTED input.
   *
   * Both compute an aspect-preserving scale from the input size — and when nothing is
   * connected, `inputSize()` hands them the PROJECT size plus a warning. So the maths runs
   * against a base the user never chose, and the only signal that happened is the
   * diagnostic. Silently producing a plausible-looking size from a fallback base is exactly
   * the kind of thing that gets debugged for an hour.
   */
  it("'fit' with nothing connected warns and fits the project size instead", () => {
    const outcome = resolveNodeResolution({
      ...base,
      override: { mode: "fit", width: 512, height: 512 },
      inputs: { byPort: {}, primaryPort: undefined },
    });
    // 1920x1080 fitted into 512x512 keeps 16:9 -> 512x288.
    expect(outcome.size).toEqual([512, 288]);
    expect(outcome.diagnostics).toHaveLength(1);
    expect(outcome.diagnostics[0]!.severity).toBe("warning");
    expect(outcome.diagnostics[0]!.message).toContain("(primary)");
  });

  it("'limit' with nothing connected warns rather than silently limiting a guess", () => {
    const outcome = resolveNodeResolution({
      ...base,
      override: { mode: "limit", width: 4000, height: 4000 },
      inputs: { byPort: {}, primaryPort: undefined },
    });
    // The project size is already inside the box, so `limit` only shrinks — it does not grow.
    expect(outcome.size).toEqual([1920, 1080]);
    expect(outcome.diagnostics.map((d) => d.severity)).toEqual(["warning"]);
  });

  /**
   * Clamping deliberately does NOT preserve aspect, unlike `fit` and `limit`.
   *
   * This is the surprising half of §V24 and it is nowhere written down as a test. A user
   * whose 8192x512 plate silently becomes 1024x512 sees a stretched image, and the
   * distinction between "clamped" (per-axis, hard cap) and "limited" (aspect-preserving,
   * user-chosen) is the explanation. Pinned so a well-meaning change to make them agree is
   * a decision rather than an accident.
   */
  it("clamping caps each axis independently and does not preserve aspect", () => {
    const outcome = resolveNodeResolution({
      ...base,
      override: { mode: "fixed", width: 8192, height: 512 },
      inputs: { byPort: {}, primaryPort: undefined },
      settings: testSettings({ limits: { ...settings.limits, maxResolution: 1024 } }),
    });
    expect(outcome.size).toEqual([1024, 512]);
    expect(outcome.clamped).toBe(true);
    expect(outcome.diagnostics.map((d) => d.severity)).toEqual(["warning"]);
  });
});

describe("§V24/§V12 — effectiveMaxResolution", () => {
  /** Exported, and until now only ever reached indirectly through one direction. */
  it("uses the project limit when no capabilities are known at all", () => {
    expect(effectiveMaxResolution(settings, undefined)).toBe(4096);
  });

  it("uses the project limit when the device reports a nonsense zero", () => {
    expect(
      effectiveMaxResolution(settings, { ...capabilities, limits: { maxTextureDimension2D: 0 } }),
    ).toBe(4096);
  });

  /**
   * The project cap wins when it is the smaller of the two. Only the device-wins direction
   * was covered, and "the smaller of a budget and physics" needs both directions to mean
   * anything — a `Math.max` typo passes the one-sided test.
   */
  it("takes the project budget when it is below what the device can do", () => {
    expect(
      effectiveMaxResolution(settings, { ...capabilities, limits: { maxTextureDimension2D: 16384 } }),
    ).toBe(4096);
  });

  it("takes the device limit when it is below the project budget", () => {
    expect(
      effectiveMaxResolution(settings, { ...capabilities, limits: { maxTextureDimension2D: 2048 } }),
    ).toBe(2048);
  });
});

describe("§V51 — format override modes with no existing coverage", () => {
  const base = {
    nodeId: "n",
    nodeType: "fx.test",
    policy: { kind: "fixed", format: "r32float" } as const,
    settings,
    capabilities,
    allowsDepth: false,
  };

  it("format override 'input' reads the named port and beats the policy", () => {
    const outcome = resolveNodeFormat({
      ...base,
      override: { mode: "input", input: "detail" },
      inputs: { byPort: { base: "rgba16float", detail: "rgba8unorm" }, primaryPort: "base" },
    });
    expect(outcome.source).toBe("override");
    expect(outcome.format).toBe("rgba8unorm");
    expect(outcome.fellBack).toBe(false);
  });

  it("format override 'input' with no port named falls back to the primary input", () => {
    const outcome = resolveNodeFormat({
      ...base,
      override: { mode: "input" },
      inputs: { byPort: { base: "rgba8unorm-srgb" }, primaryPort: "base" },
    });
    expect(outcome.format).toBe("rgba8unorm-srgb");
  });

  it("format override 'project' ignores both the policy and the inputs", () => {
    const outcome = resolveNodeFormat({
      ...base,
      override: { mode: "project" },
      inputs: { byPort: { base: "rgba8unorm" }, primaryPort: "base" },
    });
    expect(outcome.source).toBe("override");
    expect(outcome.format).toBe(settings.workingFormat);
  });

  /**
   * The SECOND entry in a fallback chain.
   *
   * Only `rgba16float -> rgba8unorm` (first choice) was ever tested. When the device has
   * neither the request nor its first fallback, the chain has to keep walking — and a
   * `[0]` where a `.find()` belongs would pass every existing assertion and then hand the
   * backend a format the device cannot allocate.
   */
  it("walks past an unsupported first fallback to the second", () => {
    const outcome = resolveNodeFormat({
      ...base,
      override: { mode: "fixed", format: "rgba16float" },
      inputs: { byPort: {}, primaryPort: undefined },
      // Chain for rgba16float is [rgba8unorm, rgba8unorm-srgb]; only the second exists here.
      capabilities: testCapabilities(["rgba8unorm-srgb", "depth24plus"]),
    });
    expect(outcome.requested).toBe("rgba16float");
    expect(outcome.format).toBe("rgba8unorm-srgb");
    expect(outcome.fellBack).toBe(true);
    expect(outcome.diagnostics.map((d) => d.severity)).toEqual(["warning"]);
  });
});

describe("§V21 — primary input selection with more than one input", () => {
  /**
   * "First DECLARED input that has something on it" — with `base` declared first.
   *
   * Every fixture in the compiler suite has exactly one input, so this rule has never had
   * a chance to be wrong. Swap it to "first CONNECTED in edge order" and nothing in the
   * existing suite fails, while every multi-input node in the real catalogue (Displace,
   * Lookup, Mask, Over) starts inheriting from the wrong side.
   */
  it("inherits from the first declared input when both are connected", () => {
    const graph = testGraph(
      [
        testNode("big", "fx.plate"), // fixed 256x128
        testNode("small", "fx.half"),
        testNode("src", "fx.generator"),
        testNode("merge", "fx.merge"),
        testNode("out", "fx.output"),
      ],
      [
        testEdge("s", ["src", "out"], ["small", "source"]),
        // Edge ids chosen so that "detail" sorts FIRST: if selection followed edge order
        // rather than declaration order, `detail` would win and this test would fail.
        testEdge("a-detail", ["small", "out"], ["merge", "detail"]),
        testEdge("z-base", ["big", "out"], ["merge", "base"]),
        testEdge("present", ["merge", "out"], ["out", "source"]),
      ],
    );

    const plan = compile(graph);
    expect(plan.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(sizeOf(plan, "big")).toEqual([256, 128]);
    expect(sizeOf(plan, "small")).toEqual([960, 540]);
    // `base` is declared first, so `base` wins — regardless of edge id ordering.
    expect(sizeOf(plan, "merge")).toEqual([256, 128]);
  });

  /**
   * ...and it skips a declared-but-unconnected input rather than resolving to nothing.
   *
   * The rule is "first declared input that ACTUALLY HAS SOMETHING on it". Drop the second
   * half and a node with an optional first input silently falls back to the project size.
   */
  it("skips an unconnected first input and inherits from the second", () => {
    const graph = testGraph(
      [testNode("plate", "fx.plate"), testNode("merge", "fx.merge"), testNode("out", "fx.output")],
      [
        testEdge("d", ["plate", "out"], ["merge", "detail"]),
        testEdge("present", ["merge", "out"], ["out", "source"]),
      ],
    );

    const plan = compile(graph);
    expect(plan.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(sizeOf(plan, "merge")).toEqual([256, 128]);
    expect(formatOf(plan, "merge")).toBe("rgba16float");
  });
});

describe("§V21 — a variadic port whose layers disagree", () => {
  /**
   * First-edge-wins, by EDGE ID.
   *
   * `compile.ts` walks incoming edges and keeps the first size it sees per port; the edge
   * list is sorted by edge id. So a Composite with a 256x128 layer and a 960x540 layer
   * takes whichever edge id sorts first — a real, load-bearing determinism rule that no
   * test states, because every existing composite fixture feeds equal-sized layers.
   *
   * This is not an endorsement. "Whichever edge id sorts first" is a defensible choice
   * ONLY because it is deterministic; if the product later wants "largest layer wins" or a
   * diagnostic on disagreement, this test is the thing that has to change on purpose.
   */
  it("takes the size and format of the lowest-sorting incoming edge", () => {
    const build = (firstId: string, secondId: string): GraphDocument =>
      testGraph(
        [
          testNode("plate", "fx.plate"), // 256x128, rgba16float
          testNode("gen", "fx.generator"), // project size, project format
          testNode("comp", "fx.composite"),
          testNode("out", "fx.output"),
        ],
        [
          testEdge(firstId, ["plate", "out"], ["comp", "layers"]),
          testEdge(secondId, ["gen", "out"], ["comp", "layers"]),
          testEdge("z-present", ["comp", "out"], ["out", "source"]),
        ],
      );

    const plateFirst = compile(build("a-plate", "b-gen"));
    expect(plateFirst.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(sizeOf(plateFirst, "comp")).toEqual([256, 128]);

    // Same graph, same nodes, only the edge IDS swapped: the result must follow the ids.
    const genFirst = compile(build("b-plate", "a-gen"));
    expect(sizeOf(genFirst, "comp")).toEqual([1920, 1080]);

    // Whatever it picks, it must pick the same thing every time.
    expect(sizeOf(compile(build("a-plate", "b-gen")), "comp")).toEqual(
      sizeOf(plateFirst, "comp"),
    );
  });
});
