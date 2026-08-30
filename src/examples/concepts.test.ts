import { describe, expect, it } from "vitest";
import { compileGraph, CompilerDiagnosticCode } from "../compiler/index.ts";
import type { CompiledGraph } from "../compiler/index.ts";
import { SHADER_SOURCE_PARAMETER } from "../domain/commands/apply-patch.ts";
import type { GraphDocument, GraphNode, ProjectDocument } from "../domain/types/graph.ts";
import type { SelectableColorFormat } from "../domain/types/node-definition.ts";
import type { EffectPassDescriptor } from "../runtime/backend/plan.ts";
import { EXTEND_OPTIONS } from "../nodes/definitions/parameter-readers.ts";
import { NOISE_TYPE_OPTIONS } from "../nodes/shaders/noise.wgsl.ts";
import { srgbToLinear } from "../domain/parameters/resolve.ts";
import { listExamples } from "./catalogue.ts";
import { TIER_B_CAPABILITIES, exampleRegistry, messagesOf, requireExample } from "./runner.ts";

/**
 * What each example CLAIMS to demonstrate, asserted (T153-T156).
 *
 * `runner.test.ts` proves every example loads, compiles and replays — the §V89 gate. That
 * gate is deliberately blind to what an example is FOR: an example could be reduced to a
 * Solid into an Output and still sail through it. These tests are the other half. Each one
 * checks the specific claim its example's `.md` makes, so an example cannot quietly stop
 * demonstrating the thing it exists to demonstrate.
 *
 * Unlike the gate, these name their example. That is unavoidable — "E4 proves the HDR
 * format override" is a statement about E4 — and it is why the gate is kept separate and
 * generic rather than merged into here.
 */

const byName = new Map(listExamples().map((file) => [file.fileName, file]));

function example(fileName: string): { document: ProjectDocument; plan: CompiledGraph } {
  const file = byName.get(fileName);
  if (file === undefined) throw new Error(`missing example ${fileName}`);
  return requireExample(file);
}

function effectFor(plan: CompiledGraph, nodeId: string): EffectPassDescriptor {
  const pass = plan.passes.find((entry) => entry.kind === "effect" && entry.nodeId === nodeId);
  if (pass === undefined || pass.kind !== "effect") throw new Error(`no effect pass for ${nodeId}`);
  return pass;
}

function outputFor(plan: CompiledGraph, nodeId: string) {
  const output = plan.outputs.find((entry) => entry.nodeId === nodeId);
  if (output === undefined) throw new Error(`no output for ${nodeId}`);
  return output;
}

function recompile(document: ProjectDocument, graph: GraphDocument): CompiledGraph {
  return compileGraph({
    graph,
    settings: document.settings,
    registry: exampleRegistry(),
    capabilities: TIER_B_CAPABILITIES,
  });
}

/** Same graph with one node's `format` override replaced or dropped. For the control cases. */
function withFormat(
  graph: GraphDocument,
  nodeId: string,
  format: SelectableColorFormat | undefined,
): GraphDocument {
  const node = graph.nodes[nodeId];
  if (node === undefined) throw new Error(`no node ${nodeId}`);
  const { format: _dropped, ...rest } = node;
  const next: GraphNode = format === undefined ? rest : { ...rest, format: { mode: "fixed", format } };
  return { ...graph, nodes: { ...graph.nodes, [nodeId]: next } };
}

describe("E1 Feedback Echo", () => {
  const { document } = example("E1-Feedback-Echo.loom.json");

  /**
   * The fade lives on the Feedback node. At `persistence: 1` the loop is a pure delay and
   * the trail never dies — the example would render a smear that fills the frame and stays.
   */
  it("fades inside the loop rather than accumulating forever", () => {
    const echo = document.graph.nodes["echo"];
    expect(echo?.type).toBe("feedback");
    const persistence = echo?.parameters["persistence"];
    expect(typeof persistence).toBe("number");
    expect(persistence).toBeGreaterThan(0);
    expect(persistence).toBeLessThan(1);
    // Fading toward an opaque colour would tint the whole frame instead of clearing it.
    expect(echo?.parameters["clearColor"]).toEqual([0, 0, 0, 0]);
  });

  /** The loop is not a bare delay: it transforms and filters between the two ends. */
  it("transforms and filters inside the loop", () => {
    const types = ["drift", "soften", "decay"].map((id) => document.graph.nodes[id]?.type);
    expect(types).toEqual(["transform", "blur", "level"]);
  });
});

describe("E2 Reaction-Diffusion", () => {
  const { document, plan } = example("E2-Reaction-Diffusion.loom.json");

  /**
   * CustomWGSL is SINGLE-INPUT by manifest, so the simulation's only legal shape is the
   * pair itself carrying the state: `feedback.out -> customWgsl.input -> feedback.in`.
   */
  it("runs the whole simulation through the single-input CustomWGSL node", () => {
    const kernel = document.graph.nodes["kernel"];
    expect(kernel?.type).toBe("customWgsl");

    const edges = Object.values(document.graph.edges);
    const intoKernel = edges.filter((edge) => edge.target.nodeId === "kernel");
    expect(intoKernel).toHaveLength(1);
    expect(intoKernel[0]?.source).toEqual({ nodeId: "state", portId: "out" });
    expect(edges.some((e) => e.source.nodeId === "kernel" && e.target.nodeId === "state")).toBe(true);
  });

  /**
   * The kernel must not declare a uniform block. The CustomWGSL node's `compile()` sets no
   * `uniformBinding` and no `sharedBinding` (see its manifest), so a `params` block in the
   * source would be bound to nothing at all on a real device — the kernel reads its grid
   * spacing from `textureDimensions` for exactly that reason.
   */
  it("carries a kernel that matches the v1 CustomWGSL binding contract", () => {
    const pass = effectFor(plan, "kernel");
    expect(pass.uniformBinding).toBeUndefined();
    expect(pass.sharedBinding).toBeUndefined();
    expect(pass.shader.includes("var<uniform>")).toBe(false);
    expect(pass.shader).toContain("textureDimensions(inputTexture)");
    expect(pass.textures?.map((binding) => binding.binding)).toEqual(["inputTexture"]);
  });

  /** §V45: the initial state is a hash of a constant seed, not of anything ambient. */
  it("seeds its initial state deterministically", () => {
    const source = document.graph.nodes["kernel"]?.parameters[SHADER_SOURCE_PARAMETER];
    expect(typeof source).toBe("string");
    expect(String(source)).toContain("seededState");
    expect(String(source)).toContain("const SEED: u32");
    // Reset -> cleared pair -> alpha 0 -> re-seed. That is the pause/step/reset story.
    expect(String(source)).toContain("centre.a >= 0.5");
  });

  /**
   * §V51: Gray-Scott increments are around 1e-3 per step. rgba8unorm cannot represent them
   * and the simulation would freeze on the first frame, so the precision is pinned.
   */
  it("pins the simulation to the rgba16float precision path", () => {
    expect(outputFor(plan, "state").format).toBe("rgba16float");
    expect(outputFor(plan, "kernel").format).toBe("rgba16float");
    expect(outputFor(plan, "state").size).toEqual([512, 512]);
  });
});

describe("E3 Animated Noise Field", () => {
  const { document, plan } = example("E3-Animated-Noise-Field.loom.json");

  /**
   * §V44: time reaches the shader through the shared frame block and nowhere else. The
   * pass binding it is the observable end of the `FrameEvaluationInput` contract — no node
   * can reach a clock (lint-enforced), so this binding IS how the field animates.
   */
  it("drives the fourth noise dimension from the frame block, not a clock", () => {
    const pass = effectFor(plan, "field");
    expect(pass.sharedBinding).toBe("frameU");
    expect(pass.shader).toContain("struct SharedFrame");
    expect(pass.shader).toContain("frameU.time");

    const perlin4d = NOISE_TYPE_OPTIONS.findIndex((option) => option.value === "perlin4d");
    expect(pass.uniforms?.["ntype"]).toBe(perlin4d);
    // speed 0 is a still image (TD's default). An animated example must not ship one.
    expect(pass.uniforms?.["speed"]).not.toBe(0);
  });

  /** §V6: one output, two consumers, one pass — and both consumers read the same texture. */
  it("renders the fanned-out noise exactly once", () => {
    const noisePasses = plan.passes.filter((pass) => pass.kind === "effect" && pass.nodeId === "field");
    expect(noisePasses).toHaveLength(1);

    const consumers = Object.values(document.graph.edges).filter(
      (edge) => edge.source.nodeId === "field",
    );
    expect(consumers).toHaveLength(2);

    const fieldResource = outputFor(plan, "field").resourceId;
    const shape = effectFor(plan, "shape");
    const warp = effectFor(plan, "warp");
    expect(shape.textures?.some((binding) => binding.resourceId === fieldResource)).toBe(true);
    expect(warp.textures?.some((binding) => binding.resourceId === fieldResource)).toBe(true);
  });
});

describe("E4 Bloom", () => {
  const { document, plan } = example("E4-Bloom.loom.json");

  /**
   * §V51: the per-node override is what keeps over-range highlights alive. The project is
   * 8-bit on purpose — without the overrides the first target clips and the bloom flattens.
   */
  it("carries the bloom branch at rgba16float over an 8-bit project", () => {
    expect(document.settings.workingFormat).toBe("rgba8unorm");
    expect(outputFor(plan, "source").format).toBe("rgba8unorm");
    for (const nodeId of ["hot", "bright", "glow", "combine"]) {
      expect(outputFor(plan, nodeId).format, nodeId).toBe("rgba16float");
    }
  });

  /**
   * The control case. Without it, the assertion above would also pass on a build where the
   * override was ignored and everything happened to be rgba16float for some other reason.
   */
  it("collapses to the project format when the overrides are removed", () => {
    let graph = document.graph;
    for (const nodeId of ["hot", "bright", "glow", "combine"]) {
      graph = withFormat(graph, nodeId, undefined);
    }
    const plain = recompile(document, graph);

    expect(messagesOf(plain.diagnostics)).toEqual([]);
    for (const nodeId of ["hot", "bright", "glow", "combine"]) {
      expect(plain.outputs.find((o) => o.nodeId === nodeId)?.format, nodeId).toBe("rgba8unorm");
    }
  });

  /** Two branches converge on one Add, and the shared half is computed once (§V6). */
  it("converges two branches that share one computed source", () => {
    expect(plan.passes.filter((p) => p.kind === "effect" && p.nodeId === "hot")).toHaveLength(1);

    const combine = effectFor(plan, "combine");
    const bound = (combine.textures ?? []).map((binding) => binding.resourceId);
    expect(bound).toHaveLength(2);
    expect(new Set(bound).size).toBe(2);
    expect(bound).toContain(outputFor(plan, "glow").resourceId);
    expect(bound).toContain(outputFor(plan, "hot").resourceId);
  });
});

describe("E5 Kaleidoscope", () => {
  const { document, plan } = example("E5-Kaleidoscope.loom.json");

  /** §V50: a per-node resolution override, inherited by the whole chain below it. */
  it("runs the chain at an overridden resolution, not the project's", () => {
    expect(document.settings.outputResolution).toEqual({ width: 1280, height: 720 });
    for (const nodeId of ["source", "fold", "facets", "spin"]) {
      expect(outputFor(plan, nodeId).size, nodeId).toEqual([2048, 2048]);
    }
  });

  /**
   * The extend modes are the example. They are invisible in the middle of the frame and
   * decide everything at the edges, which is where a kaleidoscope lives.
   */
  it("uses three different edge behaviours across the chain", () => {
    const index = (value: string) => EXTEND_OPTIONS.findIndex((option) => option.value === value);

    expect(effectFor(plan, "fold").uniforms?.["extend"]).toBe(index("mirror"));
    expect(effectFor(plan, "spin").uniforms?.["extend"]).toBe(index("repeat"));
    // Tile does its own mirroring rather than going through `extend`.
    expect(effectFor(plan, "facets").uniforms?.["mirror"]).toEqual([1, 1]);
    expect(index("mirror")).not.toBe(index("repeat"));
  });
});

describe("E6 Displacement Stack", () => {
  const { document, plan } = example("E6-Displacement-Stack.loom.json");

  /**
   * §V56/§V57: the displacement branch is never colour-converted. Every node in it inherits
   * its format from its input, so the branch holds one space from Noise to Displace and the
   * numbers that arrive at `disp` are the numbers Noise produced.
   */
  it("keeps one space across the whole displacement stack", () => {
    for (const nodeId of ["field", "shape", "place"]) {
      expect(outputFor(plan, nodeId).space, nodeId).toBe("linear");
    }
    expect(outputFor(plan, "plate").space).toBe("linear");
    expect(outputFor(plan, "warp").space).toBe("linear");

    const mismatches = plan.diagnostics.filter(
      (d) => d.code === CompilerDiagnosticCode.colorSpaceMismatch,
    );
    expect(mismatches).toEqual([]);
  });

  /**
   * The control case, and the reason the assertion above is not vacuous: encoding the
   * displacement branch DOES get caught, by name, with the conversion node to insert. §V57
   * is explicit that the compiler never silently converts.
   */
  it("reports a mismatch when the displacement branch is encoded", () => {
    const encoded = recompile(document, withFormat(document.graph, "place", "rgba8unorm-srgb"));
    const mismatches = encoded.diagnostics.filter(
      (d) => d.code === CompilerDiagnosticCode.colorSpaceMismatch,
    );

    expect(mismatches).toHaveLength(1);
    expect(mismatches[0]?.nodeId).toBe("warp");
    expect(mismatches[0]?.message).toContain("encoded");
    // Named, never fixed behind the user's back.
    expect(mismatches[0]?.suggestion).toContain("conversion");
  });

  /**
   * The `data` flag, which the shipped example deliberately does not use.
   *
   * §V56 says a texture carrying non-colour data is flagged `data` and bypasses every
   * conversion, and the compiler derives that flag from the format — `r32float` is the only
   * format in the catalogue that produces it. This is what that would look like, and it is
   * compile-only: the plan binds ONE shared LINEAR sampler to every texture, and r32float
   * is not filterable on a baseline Tier B device (it needs the optional
   * `float32-filterable` feature), so an example built this way would not render. The
   * shipped file takes the renderable path; the discipline is proven here instead.
   */
  it("flags an r32float displacement field as data, exempt from conversion", () => {
    const asData = recompile(document, withFormat(document.graph, "field", "r32float"));

    expect(asData.outputs.find((o) => o.nodeId === "field")?.space).toBe("data");
    // Inherited down the branch, so the whole stack stays data...
    expect(asData.outputs.find((o) => o.nodeId === "place")?.space).toBe("data");
    // ...and a data input beside a colour one is normal, not a mismatch.
    expect(
      asData.diagnostics.filter((d) => d.code === CompilerDiagnosticCode.colorSpaceMismatch),
    ).toEqual([]);
    // The displaced image itself is still colour: Displace inherits from `source`.
    expect(asData.outputs.find((o) => o.nodeId === "warp")?.space).toBe("linear");
  });
});

describe("E8 Slit Scan", () => {
  const { plan } = example("E8-Slit-Scan.loom.json");

  /**
   * T321's claim: per-pixel time needs the WHOLE history as one binding. If the scan
   * pass ever degrades to a fixed tap — one moment for every pixel — this example
   * still renders and stops being a slit-scan.
   */
  it("binds the ring as a whole-array texture, not a fixed tap", () => {
    const scan = plan.passes.find(
      (pass) => pass.kind === "effect" && pass.id.endsWith(":scan"),
    ) as EffectPassDescriptor;
    const history = scan.textures?.find((binding) => binding.binding === "history");
    expect(history?.array).toBe(true);
    expect(history?.tap).toBeUndefined();
  });

  /**
   * §V228 and the row's own words: 8 frames is a smear, the EFFECT wants depth. A
   * shallow ring here would demonstrate nothing the Cache does not.
   */
  it("carries real temporal depth", () => {
    const ring = plan.resources.find((resource) => resource.kind === "ring") as { frames: number };
    expect(ring.frames).toBe(48);
  });
});

describe("E9 Particle Fountain", () => {
  const { document, plan } = example("E9-Particle-Fountain.loom.json");

  /**
   * T322/T323's claim: the population CHANGES COUNT on the GPU. If the spawn tail or
   * the counted indirect draw regress, this graph still compiles — and the fountain
   * freezes at frame zero's census. The pass roster and the indirect draw are the
   * structural halves of "it keeps flowing".
   */
  it("compiles the full lifecycle: kernel, scans, scatter, spawn tail, hook", () => {
    const ids = plan.passes
      .filter((pass) => "nodeId" in pass && pass.nodeId === "sim")
      .map((pass) => (pass as { id: string }).id.split(":").pop());
    for (const stage of ["kernel", "scanLocal", "scanBlocks", "spawnScanLocal", "spawnScanBlocks", "spawnIdentity", "spawnFinalize", "spawnHook"]) {
      expect(ids, stage).toContain(stage);
    }
  });

  it("draws INDIRECTLY off the GPU-resident live count", () => {
    const draw = plan.passes.find((pass) => pass.kind === "draw") as {
      instances: number | { indirect: string };
    };
    expect(typeof draw.instances).toBe("object");
  });

  /**
   * The document half of the claim: births come from the HOOK, so each child launches
   * on its own pointRand(id) draw — delete the hook and the fountain becomes a single
   * column of identical copies.
   */
  it("ships a spawn hook", () => {
    const sim = document.graph.nodes["sim"] as GraphNode;
    expect(String(sim.parameters["spawn"])).toContain("fn spawn(");
  });
});

describe("E10 Instanced Torus", () => {
  const { document, plan } = example("E10-Instanced-Torus.loom.json");

  /**
   * T296/T299's claim: the renderer binds the GENERATOR'S pair by edge payload — no
   * naming convention, no copy. The draw's position buffer must be the torus's own
   * scratch pair, and the primitive is real 3D (36 vertices, depth-attached target).
   */
  it("wears the generator's positions by payload, as depth-tested boxes", () => {
    const draw = plan.passes.find((pass) => pass.kind === "draw") as {
      vertexCount?: number;
      buffers?: ReadonlyArray<{ resourceId: string }>;
      target: string;
    };
    expect(draw.vertexCount).toBe(36);
    expect(draw.buffers?.[0]?.resourceId).toBe("scratch:points:position");
    const target = plan.resources.find((resource) => resource.id === draw.target);
    expect((target as { depth?: boolean }).depth).toBe(true);
  });

  /**
   * E7's mechanism on one COMPONENT of a compound (§V113): rotate.y is driven while
   * its siblings stay static, so the formation spins with no recompile anywhere.
   */
  it("drives rotate.y through a component slot", () => {
    const draw = document.graph.nodes["draw"] as GraphNode;
    const slot = draw.parameters["rotate.y"] as { mode?: string; bindings?: { driven?: { channel?: string } } };
    expect(slot.mode).toBe("driven");
    expect(slot.bindings?.driven?.channel).toBe("lfo1");
  });
});

describe("E11 Gradient Remap", () => {
  const { document, plan } = example("E11-Gradient-Remap.loom.json");

  const storedStops = (): ReadonlyArray<{ position: number; color: readonly number[] }> => {
    const palette = document.graph.nodes["palette"] as GraphNode;
    return palette.parameters["stops"] as ReadonlyArray<{ position: number; color: readonly number[] }>;
  };
  const rampUniforms = (): Record<string, unknown> =>
    effectFor(plan, "palette").uniforms as Record<string, unknown>;

  /**
   * The example's reason to exist. Ramp into Lookup is THE way to recolour an image, and
   * with two stops it is a tinted greyscale — the pairing is worth very little until the
   * gradient is a palette. A file that drifted back to two stops would still compile,
   * still render, and stop demonstrating the capability it was built for.
   */
  it("recolours through a MULTI-STOP palette, not the two-colour degenerate case", () => {
    const stops = storedStops();
    expect(stops.length).toBeGreaterThan(2);
    // The count reaching the shader is the same count the document holds: a stop dropped
    // between the two is a colour the image silently loses.
    expect(rampUniforms()["count"]).toBe(stops.length);
  });

  /**
   * §V196, and the reason this example doubles as multi-stop Ramp's regression test.
   *
   * The stops are stored in DISPLAY space because that is what a picker hands over, and
   * the resolver decodes EVERY ENTRY on the way to the shader. The loop is the point: a
   * decode applied to entry zero and skipped for the rest is the failure §V196 names,
   * and it is invisible to anyone who checks one swatch and assumes the rest.
   */
  it("decodes EVERY stop to linear, not just the first", () => {
    const uniforms = rampUniforms();
    storedStops().forEach((stop, index) => {
      const packed = uniforms[`c${index}`] as readonly number[];
      expect(packed, `stop ${index}`).toHaveLength(4);
      for (const channel of [0, 1, 2]) {
        expect(packed[channel], `stop ${index} channel ${channel}`).toBeCloseTo(
          srgbToLinear(stop.color[channel] as number),
          10,
        );
      }
      // Alpha is coverage, not light: decoding it would make a half-transparent stop
      // compose differently from the number the author typed.
      expect(packed[3], `stop ${index} alpha`).toBe(stop.color[3]);
    });
  });

  /**
   * The absence of the plausible wrong answer, which is the half a "does it decode"
   * assertion misses: a SKIPPED decode leaves a number that is still a colour, still in
   * range, and still renders a gradient — just a washed-out one. Checked on a MIDDLE
   * stop, because that is the entry a per-entry bug reaches and a first-entry check does
   * not.
   */
  it("does not ship a MIDDLE stop undecoded", () => {
    const index = 2;
    const stored = storedStops()[index]?.color as readonly number[];
    const packed = rampUniforms()[`c${index}`] as readonly number[];
    // Every colour channel of this stop moved. If any of them still equals the stored
    // display value, that entry went through raw.
    for (const channel of [0, 1, 2]) {
      expect(packed[channel], `channel ${channel} is still display-space`).not.toBeCloseTo(
        stored[channel] as number,
        6,
      );
    }
  });

  /**
   * The two inputs are NOT interchangeable (the Lookup manifest's most opinionated line):
   * the source is the image whose shape survives, the lookup is the palette whose space
   * the output inherits. Swapped, this renders a palette-shaped image — so which resource
   * lands on which binding is a claim worth pinning.
   */
  it("indexes the NOISE through the RAMP, and not the other way round", () => {
    const remap = effectFor(plan, "remap");
    const bindings = new Map(
      (remap.textures ?? []).map((texture) => [texture.binding, texture.resourceId]),
    );
    const noiseOut = outputFor(plan, "field").resourceId;
    const rampOut = outputFor(plan, "palette").resourceId;

    expect(bindings.get("inputTexture")).toBe(noiseOut);
    expect(bindings.get("lookupTexture")).toBe(rampOut);
  });

  /**
   * Brightness is the index. Reading a single primary instead would put the palette in
   * the wrong places on a coloured source, and the picture would still look deliberate.
   */
  it("reads the source's LUMINANCE as the position along the gradient", () => {
    expect(effectFor(plan, "remap").uniforms?.["channel"]).toBe(0);
    expect(document.graph.nodes["remap"]?.parameters["channel"]).toBe("luminance");
  });
});
