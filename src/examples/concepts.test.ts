import { describe, expect, it } from "vitest";
import { compileGraph, CompilerDiagnosticCode } from "../compiler/index.ts";
import type { CompiledGraph } from "../compiler/index.ts";
import { createValueGraphSession } from "../domain/channels/value-graph.ts";
import { sourceReferenceName } from "../domain/graph/source-references.ts";
import { SHADER_SOURCE_PARAMETER } from "../domain/commands/apply-patch.ts";
import type { FrameEvaluationInput } from "../domain/types/frame.ts";
import type { GraphDocument, GraphNode, ProjectDocument } from "../domain/types/graph.ts";
import type { SelectableColorFormat } from "../domain/types/node-definition.ts";
import type { DrawPassDescriptor, EffectPassDescriptor } from "../runtime/backend/plan.ts";
import { sharedUniformsFromFrame } from "../runtime/backend/shared-uniforms.ts";
import { CHANNEL_OPTIONS, EXTEND_OPTIONS } from "../nodes/definitions/parameter-readers.ts";
import { REORDER_SOURCE_OPTIONS } from "../nodes/definitions/color.ts";
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

interface Pointer {
  readonly x: number;
  readonly y: number;
  readonly buttons: number;
}

/**
 * A LIVE value-graph session over one example, stepped a frame at a time (§V179).
 *
 * The examples' own gate compiles with no `resolution` at all, so every driven parameter
 * there resolves to its §V108 retained value — which is correct for a structural compile
 * and proves nothing about whether the wiring WORKS. This runs the real session, hands its
 * resolver to the real compiler, and returns the plan the runtime would push.
 *
 * The session is held ACROSS steps deliberately: a Lag is stateful (§V181), so a fresh
 * session per frame would restart its trajectory and every smoothing assertion below would
 * pass against a build with no smoothing in it at all.
 */
function valueGraphRun(document: ProjectDocument) {
  const session = createValueGraphSession(exampleRegistry());
  let frameIndex = 0;

  const frameAt = (index: number): FrameEvaluationInput => ({
    timeSeconds: index / 60,
    deltaSeconds: 1 / 60,
    frameIndex: index,
    mode: "offline",
    randomSeed: document.settings.randomSeed,
  });

  return {
    /** Advance one frame at this pointer and compile at the values it produced. */
    step(pointer: Pointer): { plan: CompiledGraph; frame: FrameEvaluationInput } {
      const frame = frameAt(frameIndex);
      frameIndex += 1;
      const { resolver } = session.evaluate(document.graph, frame, { pointer: { ...pointer } });
      const plan = compileGraph({
        graph: document.graph,
        settings: document.settings,
        registry: exampleRegistry(),
        capabilities: TIER_B_CAPABILITIES,
        resolution: { frame, channels: resolver },
      });
      return { plan, frame };
    },
    /** Advance `count` frames at one pointer; the last plan is returned. */
    hold(pointer: Pointer, count: number): { plan: CompiledGraph; frame: FrameEvaluationInput } {
      let last = this.step(pointer);
      for (let index = 1; index < count; index += 1) last = this.step(pointer);
      return last;
    },
  };
}

const CENTRE: Pointer = { x: 0.5, y: 0.5, buttons: 0 };

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

  const effectIndex = (nodeId: string): number =>
    plan.passes.findIndex((pass) => pass.kind === "effect" && pass.nodeId === nodeId);

  /**
   * T388's whole claim. E2 used to be one CustomWGSL blob, a Feedback and an Output, and
   * the graph showed NOTHING about the algorithm — which is why "just an ugly shader" was
   * a literally accurate description of it. The nodes below are the algorithm, in order,
   * and each one is doing a step a reader can name.
   */
  it("shows the algorithm in the GRAPH: noise, warp, shape, simulate, colour", () => {
    const typeOf = (id: string) => document.graph.nodes[id]?.type;
    expect(typeOf("broad")).toBe("noise");
    expect(typeOf("detail")).toBe("noise");
    expect(typeOf("warp")).toBe("displace");
    expect(typeOf("shape")).toBe("level");
    expect(typeOf("state")).toBe("feedback");
    expect(typeOf("rd")).toBe("customWgsl");
    expect(typeOf("pack")).toBe("reorder");
    expect(typeOf("palette")).toBe("ramp");
    expect(typeOf("tint")).toBe("lookup");

    // Exactly ONE node is WGSL. The rest of the file has to be nodes, or the rebuild did
    // not happen: an algorithm smuggled back into a second kernel would still pass every
    // pixel test and lose the entire point.
    const custom = Object.values(document.graph.nodes).filter((node) => node.type === "customWgsl");
    expect(custom).toHaveLength(1);
  });

  /**
   * THE spatial-variation claim, and the reason the picture reads as cell structure rather
   * than as one uniform texture. A single compile-time feed/kill pair is the same chemistry
   * in every pixel; here the kernel reads its position in the (feed, kill) band from the
   * state texture's blue channel, and the graph paints that channel from two animated noise
   * fields warping each other.
   */
  it("drives feed/kill from ANIMATED NOISE, per pixel, rather than from a constant", () => {
    const source = String(document.graph.nodes["rd"]?.parameters[SHADER_SOURCE_PARAMETER]);
    // The band is constants; WHERE a pixel sits in it is a texture read.
    expect(source).toContain("const FEED_LOW");
    expect(source).toContain("const FEED_HIGH");
    expect(source).toContain("let chemistry = clamp(centre.b, 0.0, 1.0)");
    expect(source).toContain("mix(FEED_LOW, FEED_HIGH, chemistry)");
    expect(source).toContain("mix(KILL_LOW, KILL_HIGH, chemistry)");
    // …and the old uniform constants are GONE, not merely unused.
    expect(source).not.toContain("const FEED: f32");
    expect(source).not.toContain("const KILL: f32");

    // The map reaching that channel is the Reorder's whole job: blue comes from input 2
    // (the noise chain), red/green/alpha from input 1 (the kernel).
    const pack = effectFor(plan, "pack");
    const option = (value: string) => REORDER_SOURCE_OPTIONS.findIndex((entry) => entry.value === value);
    expect(pack.uniforms?.["outr"]).toBe(option("in1r"));
    expect(pack.uniforms?.["outg"]).toBe(option("in1g"));
    expect(pack.uniforms?.["outb"]).toBe(option("in2lum"));
    // Alpha stays the kernel's: it is the seeded-start flag, not a channel to reuse.
    expect(pack.uniforms?.["outa"]).toBe(option("in1a"));

    // Both noises ANIMATE. A 4D type with speed 0 is a still image (B14) and would make
    // the map — and with it the whole "evolving" claim — a fixed pattern.
    for (const id of ["broad", "detail"]) {
      const pass = effectFor(plan, id);
      expect(pass.uniforms?.["ntype"], id).toBe(
        NOISE_TYPE_OPTIONS.findIndex((option2) => option2.value === "perlin4d"),
      );
      expect(pass.uniforms?.["speed"], id).not.toBe(0);
      expect(pass.sharedBinding, id).toBe("frameU");
    }
    // And they are two DIFFERENT fields, or the warp displaces a field by itself.
    expect(effectFor(plan, "broad").uniforms?.["seed"]).not.toBe(effectFor(plan, "detail").uniforms?.["seed"]);
  });

  /**
   * T387. This is the answer to "too slow", and it is structural: before substeps existed a
   * feedback loop advanced exactly once per displayed frame, so no parameter in the product
   * could have made this evolve faster.
   */
  it("runs the simulation 20 times per displayed frame, and iterates the LOOP only", () => {
    expect(document.graph.nodes["state"]?.parameters["substeps"]).toBe(20);

    const begin = plan.passes.find((pass) => pass.kind === "loop" && pass.edge === "begin");
    expect(begin).toMatchObject({ count: 20, nodeId: "state" });

    // The region is the loop and nothing else. The noise chain is UPSTREAM of it, so it is
    // computed once and read twenty times — the map is a per-frame fact, not a per-substep
    // one, and putting it inside would cost twenty noise fields for one visible result.
    const inside = plan.passes.slice(
      plan.passes.findIndex((pass) => pass.kind === "loop" && pass.edge === "begin") + 1,
      plan.passes.findIndex((pass) => pass.kind === "loop" && pass.edge === "end"),
    );
    expect(inside.map((pass) => (pass.kind === "effect" ? pass.nodeId : pass.kind))).toEqual([
      "rd",
      "pack",
      "state",
      "swap",
    ]);

    // The Output presents the twentieth substep, not the first: its blit is after the end.
    const end = plan.passes.findIndex((pass) => pass.kind === "loop" && pass.edge === "end");
    expect(effectIndex("out")).toBeGreaterThan(end);
    expect(effectIndex("broad")).toBeLessThan(end);
  });

  /**
   * "Ugly colors" was the raw chemical channels being shown as light. V is a concentration —
   * a number around 0..0.4 — so it indexes a palette instead (E11's Ramp+Lookup pairing).
   * T389: the LFO slides every pixel along that palette together.
   */
  it("colours the concentration through a gradient, with an LFO on the ramp position", () => {
    const tint = effectFor(plan, "tint");
    const green = CHANNEL_OPTIONS.findIndex((option) => option.value === "green");
    expect(tint.uniforms?.["channel"]).toBe(green);
    // V never reaches 1, so an unscaled read would use a third of the gradient.
    expect(Number(tint.uniforms?.["scale"])).toBeGreaterThan(1);

    // The palette is a palette, not a two-colour tint (T270/E11: the fifth stop is what
    // makes a gradient a palette).
    const stops = document.graph.nodes["palette"]?.parameters["stops"];
    expect(Array.isArray(stops) ? stops.length : 0).toBeGreaterThanOrEqual(5);

    // T389: the ramp POSITION is driven, so the colour moves while the simulation does not
    // care. Asserted on the slot, because a driven parameter that resolves to its retained
    // static in every host is a parameter that looks driven and is not (§V107/§V108).
    const slot = document.graph.nodes["tint"]?.parameters["offset"];
    expect(slot).toMatchObject({ mode: "driven", bindings: { driven: { kind: "driven", channel: "lfo1" } } });
    expect(document.graph.nodes["cycle"]?.label).toBe("lfo1");
  });

  /** The LFO actually MOVES the colour — the value reaches the pass, per frame (§V147). */
  it("moves the palette position frame by frame, through the real resolver", () => {
    const run = valueGraphRun(document);
    const offsets: number[] = [];
    for (let frame = 0; frame < 30; frame += 1) {
      const { plan: framePlan } = run.step(CENTRE);
      offsets.push(Number(effectFor(framePlan, "tint").uniforms?.["offset"]));
    }
    // It is not stuck on the retained value, and it is not noise: a 0.05 Hz sine at 60fps
    // rises monotonically across the first half-second.
    expect(new Set(offsets).size).toBeGreaterThan(20);
    expect(offsets[29]!).toBeGreaterThan(offsets[0]!);
    // …and it stays inside the amplitude the document asked for, so a runaway multiply
    // cannot hide as "the colours move".
    for (const offset of offsets) expect(Math.abs(offset)).toBeLessThanOrEqual(0.06);
  });

  /**
   * The kernel must not declare a uniform block. The CustomWGSL node's `compile()` sets no
   * `uniformBinding` and no `sharedBinding` unless the source declares one, so a `params`
   * block here would be bound to nothing at all on a real device — the kernel reads its
   * grid spacing from `textureDimensions` for exactly that reason.
   */
  it("carries a kernel that matches the v1 CustomWGSL binding contract", () => {
    const pass = effectFor(plan, "rd");
    expect(pass.uniformBinding).toBeUndefined();
    expect(pass.sharedBinding).toBeUndefined();
    expect(pass.shader.includes("var<uniform>")).toBe(false);
    expect(pass.shader).toContain("textureDimensions(inputTexture)");
    expect(pass.textures?.map((binding) => binding.binding)).toEqual(["inputTexture"]);

    // Still single-input, which is WHY the chemistry map has to travel inside the state
    // texture. If this ever grows a second input, the Reorder is no longer load-bearing.
    const intoKernel = Object.values(document.graph.edges).filter((edge) => edge.target.nodeId === "rd");
    expect(intoKernel).toHaveLength(1);
    expect(intoKernel[0]?.source).toEqual({ nodeId: "state", portId: "out" });
  });

  /** §V45: the initial state is a hash of a constant seed, not of anything ambient. */
  it("seeds its initial state deterministically", () => {
    const source = String(document.graph.nodes["rd"]?.parameters[SHADER_SOURCE_PARAMETER]);
    expect(source).toContain("seededState");
    expect(source).toContain("const SEED: u32");
    // Reset -> cleared pair -> alpha 0 -> re-seed. That is the pause/step/reset story, and
    // it is why the Reorder must keep the kernel's alpha rather than writing its own.
    expect(source).toContain("centre.a >= 0.5");
  });

  /**
   * T350 (§V285): the loop closes by NAME. The recorded node is the Reorder now, not the
   * kernel — the state written back is the packed one, or the chemistry map never lands in
   * the texture the kernel reads.
   */
  it("closes the loop by reference, onto the PACKED state", () => {
    expect(document.graph.nodes["state"]?.parameters["source"]).toBe("pack1");
    expect(Object.values(document.graph.edges).some((edge) => edge.target.nodeId === "state")).toBe(false);
  });

  /**
   * §V51: Gray-Scott increments are around 1e-3 per step. rgba8unorm cannot represent them
   * and the simulation would freeze on the first frame, so the precision is pinned. The
   * chemistry coordinate rides in the same texture, so it inherits the same precision.
   */
  it("pins the simulation to the rgba16float precision path", () => {
    expect(outputFor(plan, "state").format).toBe("rgba16float");
    expect(outputFor(plan, "rd").format).toBe("rgba16float");
    expect(outputFor(plan, "pack").format).toBe("rgba16float");
    expect(outputFor(plan, "state").size).toEqual([512, 512]);
  });
});

describe("E3 Animated Noise Field", () => {
  const { document, plan } = example("E3-Animated-Noise-Field.loom.json");

  /**
   * §V44: time reaches the shader through the shared frame block and nowhere else. The
   * pass binding it is the observable end of the `FrameEvaluationInput` contract — no node
   * can reach a clock (lint-enforced), so this binding IS how the field animates.
   *
   * §V436/T497: and it is the ABSOLUTE member. This example is the one whose entire point is
   * a field that scrolls, and on `frameU.time` it snapped back to its frame-zero slice at
   * every lap — invisible in a screenshot, invisible in a still render, visible the moment
   * anyone bounded the piece and let it play.
   */
  it("drives the fourth noise dimension from the frame block, not a clock", () => {
    const pass = effectFor(plan, "field");
    expect(pass.sharedBinding).toBe("frameU");
    expect(pass.shader).toContain("struct SharedFrame");
    expect(pass.shader).toContain("frameU.absTime");
    expect(pass.shader).not.toContain("frameU.time");

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

  /** Every node the file overrides to rgba16float, named once and used by both directions. */
  const HDR_NODES = ["hot", "floor", "bright", "glow", "tint", "combine"] as const;

  /**
   * §V51: the per-node override is what keeps over-range highlights alive. The project is
   * 8-bit on purpose — without the overrides the first target clips and the bloom flattens.
   */
  it("carries the bloom branch at rgba16float over an 8-bit project", () => {
    expect(document.settings.workingFormat).toBe("rgba8unorm");
    expect(outputFor(plan, "source").format).toBe("rgba8unorm");
    for (const nodeId of HDR_NODES) {
      expect(outputFor(plan, nodeId).format, nodeId).toBe("rgba16float");
    }
  });

  /**
   * The control case. Without it, the assertion above would also pass on a build where the
   * override was ignored and everything happened to be rgba16float for some other reason.
   *
   * T518 note: the list has to be EVERY overridden node, not a memorable subset. `combine`
   * inherits its format from `in1` — which is `tint` — so leaving one node's override in
   * place while stripping the others would let the format propagate back down the chain
   * and the control case would pass while proving nothing.
   */
  it("collapses to the project format when the overrides are removed", () => {
    let graph = document.graph;
    for (const nodeId of HDR_NODES) {
      graph = withFormat(graph, nodeId, undefined);
    }
    const plain = recompile(document, graph);

    expect(messagesOf(plain.diagnostics)).toEqual([]);
    for (const nodeId of HDR_NODES) {
      expect(plain.outputs.find((o) => o.nodeId === nodeId)?.format, nodeId).toBe("rgba8unorm");
    }
  });

  /**
   * T518 — THE CLAMP IS LOAD-BEARING, and this is the assertion that says so.
   *
   * A Level's black point is a subtraction, so everything under it becomes NEGATIVE. An
   * 8-bit target clamps those away for free; an rgba16float target — which §V51's override
   * is here to give us — keeps them. `add` is `front + back`, so without a clamp the
   * composite SUBTRACTS the glow wherever the base is dark, which is everywhere the glow
   * is visible. Measured on Dawn before the fix: the composite's 90th-percentile luma was
   * 0.004 while the glow layer feeding it measured 0.771 — an add that came out darker
   * than its own input, with every structural assertion green (§V361).
   */
  it("clamps the level's negative floor before the composite", () => {
    expect(document.graph.nodes["floor"]?.type).toBe("limit");
    expect(document.graph.nodes["floor"]?.parameters["mode"]).toBe("clamp");
    expect(document.graph.nodes["floor"]?.parameters["low"]).toBe(0);
    // ...and it sits BETWEEN the level and both consumers, not off to one side.
    const from = (id: string) =>
      Object.values(document.graph.edges)
        .filter((e) => e.source.nodeId === id)
        .map((e) => e.target.nodeId)
        .sort();
    expect(from("hot")).toEqual(["floor"]);
    expect(from("floor")).toEqual(["bright", "combine"]);
  });

  /**
   * The threshold sits ABOVE 1.0 — where an 8-bit target would have clipped — so what it
   * isolates is exactly what the format override bought. At the shipped-before 0.9 it was
   * isolating values an rgba8unorm target could have represented perfectly well, which is
   * why deleting the overrides used to dim the example rather than break it.
   */
  it("thresholds above the 8-bit ceiling, so only over-range values pass", () => {
    const bright = document.graph.nodes["bright"];
    const threshold = bright?.parameters["threshold"] as number;
    const softness = bright?.parameters["softness"] as number;
    expect(threshold).toBeGreaterThan(1);
    // The softness band must not reach down far enough to let a CLIPPED 1.0 through.
    expect(threshold - softness / 2).toBeGreaterThan(1 - 0.05);
  });

  /** Two branches converge on one Add, and the shared half is computed once (§V6). */
  it("converges two branches that share one computed source", () => {
    expect(plan.passes.filter((p) => p.kind === "effect" && p.nodeId === "hot")).toHaveLength(1);
    expect(plan.passes.filter((p) => p.kind === "effect" && p.nodeId === "floor")).toHaveLength(1);

    const combine = effectFor(plan, "combine");
    const bound = (combine.textures ?? []).map((binding) => binding.resourceId);
    expect(bound).toHaveLength(2);
    expect(new Set(bound).size).toBe(2);
    expect(bound).toContain(outputFor(plan, "tint").resourceId);
    expect(bound).toContain(outputFor(plan, "floor").resourceId);
  });

  /**
   * §V147/T402 — the source has a TIME AXIS. This is not a style note: `speed` advances
   * the field's FOURTH dimension, so on a 2D noise type there is no parameter anywhere in
   * the product that could make this file move, and it shipped that way (measured mean
   * |Δ| of exactly 0.00 between every pair of captured frames). A type check is the only
   * assertion that can distinguish "static because nobody set a speed" from "static
   * because it structurally cannot move".
   */
  it("animates on a noise type that HAS a fourth dimension", () => {
    const source = document.graph.nodes["source"];
    expect(source?.parameters["type"]).toBe("perlin4d");
    expect(source?.parameters["speed"]).not.toBe(0);
    // Off the 4D lattice plane, where the field's amplitude collapses and frame 0 would
    // be systematically flatter than every frame after it (a thumbnail is frame 0).
    expect(source?.parameters["t4d"]).not.toBe(0);
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

describe("E9 Ember", () => {
  const { document, plan } = example("E9-Ember.loom.json");

  /**
   * T322/T323's claim: the population CHANGES COUNT on the GPU. If the spawn tail or
   * the counted indirect draw regress, this graph still compiles — and the fire
   * freezes at frame zero's census. The pass roster and the indirect draw are the
   * structural halves of "it keeps burning".
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
   * on its own pointRand(id) draw — delete the hook and the fire becomes sixteen
   * columns of identical copies.
   */
  it("ships a spawn hook", () => {
    const sim = document.graph.nodes["sim"] as GraphNode;
    expect(String(sim.parameters["spawn"])).toContain("fn spawn(");
  });

  /**
   * T579, and the reason this example exists in its current form. `ctx.frameIndex == 0`
   * means BOTH "my buffers were cleared" and "the timeline lapped", which is why the
   * file that used to live here re-seeded at every loop (§V495). `ctx.firstRun` means
   * only the first. A regression to the old sentinel would still compile, still render,
   * and quietly bring the owner's complaint back — so the guard is asserted by name.
   */
  it("seeds on ctx.firstRun, and names the wrapping clock nowhere", () => {
    const sim = document.graph.nodes["sim"] as GraphNode;
    const kernel = String(sim.parameters["kernel"]);
    const code = kernel.replace(/\/\*[\s\S]*?\*\//g, " ");
    expect(code).toContain("ctx.firstRun == 1u");
    expect(code).not.toContain("ctx.frameIndex");
    expect(code).not.toContain("ctx.time");
  });

  /**
   * §V471.1 — ONE cloud, THREE readings, and the split is the LIFECYCLE. Three draws
   * that had drifted onto three different pointsets, or onto one predicate, would still
   * render a fire; what they would stop doing is giving every ember a black-body
   * gradient out of SELECTION. So this asserts both halves: one producer, three
   * distinct predicates.
   */
  it("reads ONE cloud THREE ways, split by group predicate on heat", () => {
    const draws = ["bed", "body", "spark"].map((id) => document.graph.nodes[id] as GraphNode);
    const sources = Object.values(document.graph.edges)
      .filter((edge) => ["bed", "body", "spark"].includes(edge.target.nodeId))
      .map((edge) => edge.source.nodeId);
    expect(new Set(sources)).toEqual(new Set(["sim"]));
    const groups = draws.map((node) => String(node.parameters["group"]));
    expect(new Set(groups).size).toBe(3);
    // §V471.2: every predicate reads the attribute the KERNEL wrote, not a position.
    for (const group of groups) expect(group).toContain("p.velocity.z");
    // Three different colours and three different sizes, or the split reads as one draw.
    expect(new Set(draws.map((node) => JSON.stringify(node.parameters["color"]))).size).toBe(3);
    expect(new Set(draws.map((node) => node.parameters["sizePixels"])).size).toBe(3);
  });

  /**
   * The BINDING BUDGET is the reason heat rides in a velocity component rather than in
   * an attribute of its own: a lifecycle kernel spends 2·(n−1)+2 storage buffers for n
   * attributes including flags, and baseline WebGPU guarantees 8. A future editor adding
   * `heat` as a fifth attribute would bust that limit SILENTLY, so the default schema is
   * asserted rather than assumed.
   */
  it("stays inside the 8-storage-buffer budget by carrying heat in velocity.z", () => {
    const sim = document.graph.nodes["sim"] as GraphNode;
    expect(String(sim.parameters["attributes"] ?? "")).toBe("");
    const kernel = plan.passes.find(
      (pass) => "id" in pass && String((pass as { id: string }).id).endsWith(":kernel"),
    ) as { buffers?: ReadonlyArray<unknown> };
    expect((kernel.buffers ?? []).length).toBeLessThanOrEqual(8);
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
   * its siblings stay static, so each box tumbles about its own centre with no recompile
   * anywhere. NOT the formation — §V198 composes `rotate` inside the translate to the
   * point, so the ring never moves (B43; the doc claimed otherwise until T366).
   *
   * This asserts the SLOT in the document, which is all a plan-level test can see: it
   * would still pass if the resolver silently ignored the drive and the boxes sat still.
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

describe("E12 Fluid", () => {
  const { document, plan } = example("E12-Fluid.loom.json");

  const ADVECT = "advect";
  const STIR = "stir";

  /**
   * The claim that separates this file from E2: a fluid has TWO states.
   *
   * E2's whole simulation lives in one ping-pong pair, because a chemistry generates its
   * pattern where the pattern is. A fluid CARRIES one — the velocity field is a state, the
   * dye is a state, and the only connection between them is that one is the coordinate the
   * other is sampled at. Collapse this to one loop and it stops being a fluid; it renders
   * fine and it is E2 with different constants.
   */
  it("keeps the velocity and the dye as two separate temporal states", () => {
    const pairs = plan.feedback.map((entry) => entry.nodeId).sort();
    expect(pairs).toEqual(["dye", "velocity"]);

    const advect = effectFor(plan, ADVECT);
    const bound = new Map((advect.textures ?? []).map((t) => [t.binding, t.resourceId]));
    // The DYE is the image being moved; the VELOCITY is the field moving it. Swapped, the
    // dye becomes a coordinate field and the picture is still a picture.
    expect(bound.get("inputTexture")).toBe(outputFor(plan, "dye").resourceId);
    expect(bound.get("displaceTexture")).toBe(outputFor(plan, STIR).resourceId);
  });

  /**
   * THE SIGN. Semi-Lagrangian advection samples UPSTREAM: the dye arriving here came from
   * `uv - v`. A positive weight samples downstream instead — the unstable forward scheme —
   * and the difference is not a crash or a black frame, it is a fluid that still flows and
   * blows itself apart over a minute. This is the parameter that dies first, so it is the
   * one that is pinned rather than the presence of the Displace node.
   *
   * `offset` is [0, 0] for the same reason: the field is SIGNED, so zero means "no motion".
   * At the 0.5 default the whole frame would slide diagonally for ever.
   */
  it("advects backward, against a signed velocity field", () => {
    const uniforms = effectFor(plan, ADVECT).uniforms as Record<string, readonly number[]>;
    const weight = uniforms["weight"] as readonly number[];

    expect(weight).toHaveLength(2);
    expect(weight[0]).toBeLessThan(0);
    expect(weight[1]).toBeLessThan(0);
    expect(uniforms["offset"]).toEqual([0, 0]);
  });

  /**
   * §V6, and the reason the velocity is not one frame stale: the kernel's output is the
   * texture that closes the velocity loop AND the field the dye is displaced by, rendered
   * once. Reading `vel1.out` instead would work and would put the dye a frame behind the
   * flow carrying it — invisible in a still, wrong in motion.
   */
  it("steers the dye with THIS frame's velocity, computed once", () => {
    const kernelPasses = plan.passes.filter((pass) => pass.kind === "effect" && pass.nodeId === STIR);
    expect(kernelPasses).toHaveLength(1);

    // T350 (§V285): the loop's back half is a NAME, so `edges` carries only the forward
    // consumer and the reference carries the other. Both halves are asserted, because it
    // is the PAIR of them that means "this frame's velocity, in both places".
    const wired = Object.values(document.graph.edges).filter((edge) => edge.source.nodeId === STIR);
    expect(wired.map((edge) => edge.target.nodeId).sort()).toEqual([ADVECT]);

    const velocity = document.graph.nodes["velocity"] as GraphNode;
    expect(sourceReferenceName(velocity.type, velocity.parameters)).toBe("stir1");
    expect(document.graph.nodes[STIR]?.label).toBe("stir1");
    // And the dye loop closes the same way, on the composite that injects the ink.
    const dye = document.graph.nodes["dye"] as GraphNode;
    expect(sourceReferenceName(dye.type, dye.parameters)).toBe("inject1");
  });

  /**
   * §V44/§V182: the stirring force reaches the shader through the shared frame block, which
   * is the only channel a kernel has to anything outside itself. The BINDING is the claim —
   * the node emits `sharedBinding` only because the source declares the block, so a kernel
   * that stopped reading the pointer would stop being handed one.
   */
  it("stirs from the shared frame block's pointer, not from a clock or a listener", () => {
    const stir = effectFor(plan, STIR);
    expect(stir.sharedBinding).toBe("frameU");
    expect(stir.shader).toContain("frameU.pointer");
    // The kernel has its own uniform too, so the stir strength is a live knob (§V5).
    expect(stir.uniformBinding).toBe("params");
  });

  /**
   * §V182 END TO END, and the assertion this example exists to make.
   *
   * The shader's vortex and the CPU's ink blob are two readers of ONE pointer. Here they
   * are compared at the same frame: the value the Mouse node published into `ink1.center`
   * and the value the shared uniform block carries into `frameU.pointer` must be the same
   * numbers, in the same order, with v the same way up.
   *
   * BEING EXACT ABOUT WHAT THIS CATCHES. Both halves are handed the same pointer struct
   * here, so this cannot prove the VIEWER publishes one — that is the publisher's own test.
   * What it proves is that neither reader transforms it on the way through: a Mouse node
   * that flipped v "for TD parity", or clamped, or reported pixels, would agree with
   * nothing and the ink would sit somewhere the vortex is not. That is the failure §V182
   * describes, and it is invisible in any test that looks at one half.
   */
  it("puts the ink in the eye of the vortex: one pointer, two readers", () => {
    const pointer: Pointer = { x: 0.32, y: 0.71, buttons: 1 };
    const { plan: live, frame } = valueGraphRun(document).hold(pointer, 3);

    expect(messagesOf(live.diagnostics)).toEqual([]);
    const centre = (effectFor(live, "ink").uniforms as Record<string, readonly number[]>)["center"];
    expect(centre).toEqual([pointer.x, pointer.y]);

    const shared = sharedUniformsFromFrame({
      frame,
      pointer,
      resolution: [document.settings.outputResolution.width, document.settings.outputResolution.height],
    });
    expect(shared.pointer.slice(0, 2)).toEqual([...(centre as readonly number[])]);
  });

  /**
   * The control case for the one above: with no pointer attached the blob is not merely
   * wrong, it is the retained centre (§V108). Without this, "the centre equals the pointer"
   * would also pass on a build where the centre happened to be 0.5 and the pointer was too.
   */
  it("falls back to the retained centre when nothing is driving it", () => {
    const centre = (effectFor(plan, "ink").uniforms as Record<string, readonly number[]>)["center"];
    expect(centre).toEqual([0.5, 0.5]);
    expect(centre).not.toEqual([0.32, 0.71]);
  });
});

describe("E13 Prism", () => {
  const { document, plan } = example("E13-Prism.loom.json");

  const drawFor = (source: CompiledGraph, nodeId: string): DrawPassDescriptor => {
    const pass = source.passes.find((entry) => entry.kind === "draw" && entry.nodeId === nodeId);
    if (pass === undefined || pass.kind !== "draw") throw new Error(`no draw pass for ${nodeId}`);
    return pass;
  };
  const reorderChannel = (source: CompiledGraph, nodeId: string, key: string): number =>
    (effectFor(source, nodeId).uniforms as Record<string, number>)[key] as number;

  /**
   * DISPERSION, traced through the plan rather than read off the node names.
   *
   * Three refractions and two Reorders is the whole trick, and the Reorders are where it
   * silently stops working: leave `fuse1.outg` at its `in1g` default and every pass still
   * runs, the picture is still a refracted scene, and it is the RED path three times over
   * with no colour separation anywhere. So the claim is followed end to end — which
   * resource each output channel actually comes from — and each path must be a different
   * one.
   */
  it("assembles one channel from each of three refractions", () => {
    const index = (value: string) =>
      ["in1r", "in1g", "in1b", "in1a", "in1lum", "in2r", "in2g", "in2b", "in2a", "in2lum", "one", "zero"].indexOf(value);

    const fuse = effectFor(plan, "fuse");
    const prism = effectFor(plan, "prism");
    const bound = (pass: EffectPassDescriptor) =>
      new Map((pass.textures ?? []).map((texture) => [texture.binding, texture.resourceId]));

    // fuse takes red from in1 and green from in2 ...
    expect(reorderChannel(plan, "fuse", "outr")).toBe(index("in1r"));
    expect(reorderChannel(plan, "fuse", "outg")).toBe(index("in2g"));
    expect(bound(fuse).get("inputTexture")).toBe(outputFor(plan, "bendR").resourceId);
    expect(bound(fuse).get("input2Texture")).toBe(outputFor(plan, "bendG").resourceId);

    // ... and prism keeps those two and takes blue from the third.
    expect(reorderChannel(plan, "prism", "outr")).toBe(index("in1r"));
    expect(reorderChannel(plan, "prism", "outg")).toBe(index("in1g"));
    expect(reorderChannel(plan, "prism", "outb")).toBe(index("in2b"));
    expect(bound(prism).get("inputTexture")).toBe(outputFor(plan, "fuse").resourceId);
    expect(bound(prism).get("input2Texture")).toBe(outputFor(plan, "bendB").resourceId);
  });

  /**
   * The three indices are DIFFERENT and ORDERED. Equal weights compile, render, and produce
   * a refracted scene with no spectrum in it — the failure that looks like success. Blue
   * furthest is the physics; reversed, the fringe reverses and stays plausible.
   */
  it("refracts blue furthest and red least, from one shared source", () => {
    const weightOf = (nodeId: string): number =>
      ((effectFor(plan, nodeId).uniforms as Record<string, readonly number[]>)["weight"] as readonly number[])[0] as number;

    const red = weightOf("bendR");
    const green = weightOf("bendG");
    const blue = weightOf("bendB");
    expect(Math.abs(blue)).toBeGreaterThan(Math.abs(green));
    expect(Math.abs(green)).toBeGreaterThan(Math.abs(red));

    // §V6: one scene and one normal field, each rendered once, sampled by all three.
    const scene = outputFor(plan, "field").resourceId;
    const normals = outputFor(plan, "normals").resourceId;
    for (const nodeId of ["bendR", "bendG", "bendB"]) {
      const bound = new Map((effectFor(plan, nodeId).textures ?? []).map((t) => [t.binding, t.resourceId]));
      expect(bound.get("inputTexture"), nodeId).toBe(scene);
      expect(bound.get("displaceTexture"), nodeId).toBe(normals);
    }
    expect(plan.passes.filter((p) => p.kind === "effect" && p.nodeId === "field")).toHaveLength(1);
  });

  /**
   * T364, and the reason there is a spectrum to bend at all.
   *
   * `color` maps the whole compound onto the kernel's `tint` and `sizePixels` maps onto
   * `pscale`, and with BOTH mapped the sprite pass's params struct would be empty — WGSL
   * refuses an empty struct, so the uniform block DISAPPEARS. That absence is the
   * observable fact: a regression to the static colour restores the block and paints 2400
   * identical sprites, which still renders and disperses into grey.
   */
  it("draws 2400 sprites with no uniform block, because both colour and size are mapped", () => {
    const draw = drawFor(plan, "sparks");
    expect(draw.uniformBinding).toBeUndefined();
    expect(draw.uniforms).toBeUndefined();

    const sparks = document.graph.nodes["sparks"] as GraphNode;
    const colorSlot = sparks.parameters["color"] as { mode?: string; bindings?: { map?: { attribute?: string } } };
    const sizeSlot = sparks.parameters["sizePixels"] as { mode?: string; bindings?: { map?: { attribute?: string } } };
    expect(colorSlot.mode).toBe("map");
    expect(colorSlot.bindings?.map?.attribute).toBe("tint");
    expect(sizeSlot.mode).toBe("map");
    expect(sizeSlot.bindings?.map?.attribute).toBe("pscale");

    // The attribute has to EXIST on the incoming pointset, and be vec4f: the head map
    // refuses anything else by name. The kernel has to write it, or every sprite is black.
    const swarm = document.graph.nodes["swarm"] as GraphNode;
    const attributes = JSON.parse(String(swarm.parameters["attributes"])) as ReadonlyArray<{
      name: string;
      type: string;
      qualifier?: string;
    }>;
    const tint = attributes.find((entry) => entry.name === "tint");
    expect(tint?.type).toBe("vec4f");
    // §V313/T287: a colour attribute says so, so a colour-space op would convert it and a
    // spatial transform would leave it alone.
    expect(tint?.qualifier).toBe("color");
    expect(String(swarm.parameters["kernel"])).toContain("q.tint =");
    expect(String(swarm.parameters["kernel"])).toContain("q.pscale =");
  });

  /**
   * The control case. Force `color` back to a static value and the uniform block comes
   * back — which is what proves the absence above is caused by the map rather than by some
   * unrelated property of a draw pass.
   */
  it("gets its uniform block back the moment the colour stops being mapped", () => {
    const sparks = document.graph.nodes["sparks"] as GraphNode;
    const staticColour: GraphNode = {
      ...sparks,
      parameters: { ...sparks.parameters, color: [1, 1, 1, 1] },
    };
    const plain = recompile(document, {
      ...document.graph,
      nodes: { ...document.graph.nodes, sparks: staticColour },
    });

    expect(messagesOf(plain.diagnostics)).toEqual([]);
    const draw = plain.passes.find((pass) => pass.kind === "draw" && pass.nodeId === "sparks");
    expect(draw?.kind === "draw" ? draw.uniformBinding : undefined).toBe("params");
  });

  /**
   * THE LAG IS THE POINT, not the wire.
   *
   * `mouse1 → follow1(Lag) → lens1.center` is the owner's canonical chain, and a test that
   * only checked the centre eventually equals the pointer would pass with the Lag deleted.
   * So the assertion is the SHAPE of the approach: one frame after the pointer jumps the
   * lens has moved, and has moved only part of the way; many frames later it has arrived.
   *
   * That discriminates three things at once — no chain (never moves), no Lag (arrives on
   * the first frame), and a Lag that holds instead of integrating (never arrives).
   */
  it("eases the lens toward the pointer instead of snapping to it", () => {
    const run = valueGraphRun(document);
    const target: Pointer = { x: 0.18, y: 0.82, buttons: 0 };

    // Settle on the centre first, so the jump is a jump.
    const settled = run.hold(CENTRE, 60);
    const centreOf = (source: CompiledGraph): readonly number[] =>
      (effectFor(source, "lens").uniforms as Record<string, readonly number[]>)["center"] as readonly number[];
    expect(centreOf(settled.plan)).toEqual([0.5, 0.5]);

    const oneFrame = centreOf(run.step(target).plan);
    // Moved...
    expect(oneFrame[0]).toBeLessThan(0.5);
    expect(oneFrame[1]).toBeGreaterThan(0.5);
    // ...but nowhere near arrived. A missing Lag lands on the pointer this frame.
    expect(oneFrame[0]).toBeGreaterThan(0.4);
    expect(oneFrame[1]).toBeLessThan(0.6);

    const arrived = centreOf(run.hold(target, 90).plan);
    expect(arrived[0]).toBeCloseTo(target.x, 3);
    expect(arrived[1]).toBeCloseTo(target.y, 3);
  });

  /**
   * A SQUARE WAVE THROUGH A LAG IS AN EASE, and that is the whole reason the LFO is a
   * square rather than a sine here. A sine would look smooth with the Lag removed and this
   * assertion would be unfalsifiable; a square takes exactly two values, so every value
   * BETWEEN them in the compiled uniforms was produced by the smoothing stage.
   */
  it("eases the lens radius between the square wave's two levels", () => {
    const run = valueGraphRun(document);
    const radii = new Set<number>();
    // 0.22 Hz: a bit over four seconds a cycle, so 300 frames crosses both edges.
    for (let index = 0; index < 300; index += 1) {
      const { plan: live } = run.step(CENTRE);
      const radius = (effectFor(live, "lens").uniforms as Record<string, readonly number[]>)["radius"] as readonly number[];
      expect(radius[0]).toBe(radius[1]);
      radii.add(Number((radius[0] as number).toFixed(6)));
    }

    // Two values would mean the Lag is not in the path at all.
    expect(radii.size).toBeGreaterThan(50);
    // And every one of them lies inside the wave's own range: the LFO's amplitude and
    // offset are chosen so the manifest never has to clamp (a clamp is a warning, and the
    // gate treats a warning as a failure).
    for (const radius of radii) {
      expect(radius).toBeGreaterThanOrEqual(0.18 - 1e-6);
      expect(radius).toBeLessThanOrEqual(0.46 + 1e-6);
    }
  });

  /**
   * THE ROLL KEEPS GOING, and after T537/T565 there is no `%` doing it.
   *
   * This test used to assert the opposite character: `r` was clamped to ±360 by its
   * manifest and `clampToDeclared` read that as a hard limit on every resolved value, so
   * `abstime * 7` alone pinned the roll at 360 degrees after 51 seconds and raised the
   * out-of-range diagnostic the gate treats as a failure. E13 carried `% 360` as a
   * user-level workaround for exactly that (§B111). T537 split the two ideas the manifest
   * had conflated — a slider's RANGE is not a value CLAMP — and `r` now declares
   * `range: "cyclic"`, which `numericRangeOf` answers with no limit at all.
   *
   * So the assertion is the UNWRAPPED angle: a hundred seconds in the resolver must hand
   * the shader 700 degrees, not 360 (the old clamp) and not 340 (the old modulo). All
   * three render the same picture, which is precisely why only an exact-value assertion
   * can tell them apart — a look test here would pass on the bug (§V147).
   */
  it("keeps rolling past 360 degrees, with no wrap and no clamp", () => {
    const seconds = 100;
    const late = compileGraph({
      graph: document.graph,
      settings: document.settings,
      registry: exampleRegistry(),
      capabilities: TIER_B_CAPABILITIES,
      resolution: {
        frame: {
          timeSeconds: seconds,
          deltaSeconds: 1 / 60,
          frameIndex: seconds * 60,
          mode: "offline",
          randomSeed: document.settings.randomSeed,
        },
      },
    });

    // A clamp is a diagnostic, and the example gate treats any diagnostic as a failure.
    expect(messagesOf(late.diagnostics)).toEqual([]);

    const degrees = seconds * 7;
    expect(degrees).toBeGreaterThan(360);
    const rot = (effectFor(late, "roll").uniforms as Record<string, number>)["rot"] as number;
    expect(rot).toBeCloseTo((degrees * Math.PI) / 180, 10);
    // Neither of the two answers this test accepted before T565.
    expect(rot).not.toBeCloseTo((360 * Math.PI) / 180, 6);
    expect(rot).not.toBeCloseTo(((degrees % 360) * Math.PI) / 180, 6);
    // ...and it IS the same pose, which is why dropping the workaround changes no picture.
    expect((rot - ((degrees % 360) * Math.PI) / 180) % (2 * Math.PI)).toBeCloseTo(0, 10);

    const slot = (document.graph.nodes["roll"] as GraphNode).parameters["r"] as {
      mode?: string;
      bindings?: { expression?: { source?: string } };
    };
    expect(slot.mode).toBe("expression");
    expect(slot.bindings?.expression?.source).toBe("abstime * 7");
  });
});

describe("E16 Murmuration", () => {
  const { document, plan } = example("E16-Murmuration.loom.json");

  /**
   * T401/B57's claim, in the shipped file: processors CHAIN. Each kernel binds its
   * immediate upstream's position pair; the renderer draws the LAST kernel's. Before
   * T401 the second link could not exist.
   */
  it("chains sphere -> flock -> part -> birds by pair bindings", () => {
    const dispatchFor = (nodeId: string) =>
      plan.passes.find((pass) => pass.kind === "dispatch" && pass.nodeId === nodeId) as {
        buffers?: ReadonlyArray<{ binding: string; resourceId: string }>;
      };
    const bindingOf = (nodeId: string, name: string) =>
      dispatchFor(nodeId).buffers?.find((buffer) => buffer.binding === name);
    expect(bindingOf("flock", "in_position")?.resourceId).toBe("scratch:sphere:position");
    expect(bindingOf("flock", "out_position")?.resourceId).toBe("scratch:flock:position");
    expect(bindingOf("part", "in_position")?.resourceId).toBe("scratch:flock:position");
    const draw = plan.passes.find((pass) => pass.kind === "draw") as {
      buffers?: ReadonlyArray<{ resourceId: string }>;
    };
    expect(draw.buffers?.[0]?.resourceId).toBe("scratch:part:position");
  });

  /**
   * The kernel's OWN state is what makes a processor still a simulation (§V197): offset
   * and velocity are not carried by the sphere, so they bind the flock's own pairs.
   */
  it("keeps offset and velocity as the flock's own persistent pairs", () => {
    const dispatch = plan.passes.find((pass) => pass.kind === "dispatch" && pass.nodeId === "flock") as {
      buffers?: ReadonlyArray<{ binding: string; resourceId: string }>;
    };
    for (const name of ["offset", "velocity"]) {
      expect(
        dispatch.buffers?.find((buffer) => buffer.binding === `in_${name}`)?.resourceId,
        name,
      ).toBe(`scratch:flock:${name}`);
    }
  });

  /**
   * §V197's narrowing, live: `part` declares only position, so the colour the renderer
   * maps is the FLOCK's tint pair, two nodes upstream — one buffer, zero copies.
   */
  it("maps colour from the flock's tint ACROSS the part kernel, by reference", () => {
    const draw = plan.passes.find((pass) => pass.kind === "draw") as {
      buffers?: ReadonlyArray<{ binding: string; resourceId: string }>;
      uniforms?: Record<string, unknown>;
    };
    expect(draw.buffers?.some((buffer) => buffer.resourceId === "scratch:flock:tint")).toBe(true);
    // Mapped means OUT of the uniform block (T364).
    expect(draw.uniforms?.["color"]).toBeUndefined();
  });

  /** T333: the stray cull is a draw-time predicate over the typed edge, in the shader. */
  it("culls strays with the group predicate at draw time", () => {
    const draw = plan.passes.find((pass) => pass.kind === "draw") as { shader: string };
    expect(draw.shader).toContain("groupMatch");
    expect(draw.shader).toContain("length(p.position) < 1.7");
    const group = (document.graph.nodes["birds"] as GraphNode).parameters["group"];
    expect(group).toBe("length(p.position) < 1.7");
  });
});

describe("E20 Gooeyball", () => {
  const { document, plan } = example("E20-Gooeyball.loom.json");

  /**
   * T417's crossing, link by link: grid positions into the ball kernel, ball positions
   * into the bridge, the bridge's sample INTO the goo kernel from upstream (T401), goo
   * positions into the surface. One buffer per attribute, zero copies.
   */
  it("chains grid -> ball -> bridge -> goo -> surface by pair bindings", () => {
    const buffersOf = (nodeId: string, kind: "dispatch" | "draw") =>
      (plan.passes.find((pass) => pass.kind === kind && (pass as { nodeId?: string }).nodeId === nodeId) as {
        buffers?: ReadonlyArray<{ binding: string; resourceId: string }>;
      }).buffers;
    const binding = (nodeId: string, kind: "dispatch" | "draw", name: string) =>
      buffersOf(nodeId, kind)?.find((buffer) => buffer.binding === name)?.resourceId;

    expect(binding("ball", "dispatch", "in_position")).toBe("scratch:sheet:position");
    expect(binding("bridge", "dispatch", "in_position")).toBe("scratch:ball:position");
    expect(binding("goo", "dispatch", "in_position")).toBe("scratch:ball:position");
    // The 2D->3D crossing itself: the goo kernel reads the BRIDGE's sample pair.
    expect(binding("goo", "dispatch", "in_sample")).toBe("scratch:bridge:sample");
    // And the surface draws the goo's positions.
    const draw = plan.passes.find(
      (pass) => pass.kind === "draw" && (pass as { id: string }).id.includes(":scene:"),
    ) as { buffers?: ReadonlyArray<{ resourceId: string }> };
    expect(draw.buffers?.some((buffer) => buffer.resourceId === "scratch:goo:position")).toBe(true);
  });

  /**
   * The seam is a CLAIM (T302): the topology node moves no point — it emits no pass at
   * all — and the surface's uniforms carry the wrap it authored.
   */
  it("closes the ring with a topology claim, not geometry", () => {
    expect(plan.passes.some((pass) => (pass as { nodeId?: string }).nodeId === "claim")).toBe(false);
    // T429: the surface now draws through the scene Render, whose grid uniform packs
    // cols/rows/wrapU/wrapV — the wrap still arrives from the claim, third slot.
    const draw = plan.passes.find(
      (pass) => pass.kind === "draw" && (pass as { id: string }).id.includes(":scene:"),
    ) as {
      uniforms?: Record<string, unknown>;
    };
    const grid = draw.uniforms?.["grid"] as number[];
    expect(grid[2]).toBe(1); // wrapU: the seam cell
    expect(grid[3]).toBe(0);
  });

  /**
   * T429, the owner's complaint answered where tests can see it: the SAME field that
   * displaces the ball paints it — the palette-looked-up noise is the material's albedo
   * map, the raw noise its roughness map, and both arrive on the render's draw as bound
   * textures. One field, three uses.
   */
  it("paints the ball with the displacement field: albedo and roughness maps bound", () => {
    const draw = plan.passes.find(
      (pass) => pass.kind === "draw" && (pass as { id: string }).id.includes(":scene:"),
    ) as {
      textures?: ReadonlyArray<{ binding: string; resourceId: string }>;
      shader: string;
    };
    expect(draw.textures?.some((t) => t.binding === "albedoMap" && t.resourceId === "target:paint:out")).toBe(true);
    expect(draw.textures?.some((t) => t.binding === "roughnessMap" && t.resourceId === "target:wobble:out")).toBe(true);
    expect(draw.shader).toContain("albedoMap");
    // TWO lights reached the shader, one of them the orbiting fill.
    expect(draw.shader).toContain("light1Meta");
    const fill = document.graph.nodes["fill"] as GraphNode;
    const slot = fill.parameters["position.x"] as { mode?: string; bindings?: { driven?: { channel?: string } } };
    expect(slot.mode).toBe("driven");
    expect(slot.bindings?.driven?.channel).toBe("orbitx1");
  });

  /** B14's lesson, pinned again: animated goo needs a 4D noise with speed set. */
  it("drives the goo from a noise that actually moves", () => {
    const noise = document.graph.nodes["wobble"] as GraphNode;
    expect(noise.parameters["type"]).toBe("perlin4d");
    expect(noise.parameters["speed"]).not.toBe(0);
  });

  /** The displacement is radial IN THE SHADER SOURCE the document ships. */
  it("displaces along the normal — normalize(position) — by the centred sample", () => {
    const goo = document.graph.nodes["goo"] as GraphNode;
    const kernel = goo.parameters["kernel"] as string;
    expect(kernel).toContain("normalize(p.position)");
    expect(kernel).toContain("p.sample.r - 0.5");
  });

  /**
   * B85 closed, in the shipped bytes: the ball kernel takes the grid off the EDGE.
   *
   * The bug was five copies of one number — `cols: 64` on the grid, `cols: 64` on the
   * topology claim, and `64u` twice inside the WGSL — so turning the visible knob left the
   * kernel parametrising a grid it was no longer running over. Silent, and still a
   * picture. The assertion is therefore about ABSENCE: no dimension may appear in the
   * kernel text at all, because a literal is what the knob cannot reach (§V349).
   */
  it("reads the grid from ctx.dim instead of retyping it (T472, B85)", () => {
    const ball = document.graph.nodes["ball"] as GraphNode;
    const kernel = ball.parameters["kernel"] as string;
    const body = kernel.replace(/\/\*[\s\S]*?\*\//g, ""); // the comment may say 64u; the CODE may not
    expect(body).toContain("ctx.dim.cols");
    expect(body).toContain("ctx.dim.rows");
    expect(body).toContain("ctx.dim.i");
    expect(body).toContain("ctx.dim.j");

    // The knob it now follows is the one the user can see, on the node upstream — and
    // ITS value is what may not appear in the shader, which is B85 stated exactly.
    const sheet = document.graph.nodes["sheet"] as GraphNode;
    expect(sheet.parameters["cols"]).toBe(64);
    expect(sheet.parameters["rows"]).toBe(64);
    expect(body, "a dimension typed into the kernel is B85 coming back").not.toContain(
      String(sheet.parameters["cols"]),
    );
    // The generated module is where the 64 lives now — written once, by the compiler,
    // from the topology string the grid published.
    const ballPass = plan.passes.find(
      (pass) => pass.kind === "dispatch" && (pass as { nodeId?: string }).nodeId === "ball",
    ) as { shader: string };
    expect(ballPass.shader).toContain("PointDim(64u, 64u, index % 64u, index / 64u)");
  });
});

describe("E24 Audio Reaction-Diffusion", () => {
  const { document, plan } = example("E24-Audio-Reaction-Diffusion.loom.json");

  /**
   * T425's headline: substeps is DRIVEN, capped twice. The document binds the channel,
   * the plan carries a loop REGION whose count is the retained base (channels resolve
   * live, not at compile), and the graph-side fence sits exactly on [1, 34].
   */
  it("drives substeps from the bass, through a hard fence, into a live loop region", () => {
    const state = document.graph.nodes["state"] as GraphNode;
    const slot = state.parameters["substeps"] as { mode?: string; bindings?: { driven?: { channel?: string } } };
    expect(slot.mode).toBe("driven");
    expect(slot.bindings?.driven?.channel).toBe("steps1:low");
    const begin = plan.passes.find((pass) => pass.kind === "loop" && pass.edge === "begin") as {
      count?: number;
    };
    expect(begin).toBeDefined();
    expect(begin.count).toBe(14); // the retained base — silence's iteration rate
    const cap = document.graph.nodes["scap"] as GraphNode;
    expect(cap.parameters["minimum"]).toBe(1);
    expect(cap.parameters["maximum"]).toBe(34);
  });

  /**
   * The tutorial's safe-bounds warning, as assertions: the white point is driven, and
   * its fence keeps the chemistry inside the band where the pattern SURVIVES — dead
   * Gray-Scott is a fixed point silence cannot revive.
   */
  it("range-maps audio into the chemistry with bounds the pattern survives", () => {
    const shape = document.graph.nodes["shape"] as GraphNode;
    const slot = shape.parameters["whitelevel"] as { mode?: string; bindings?: { driven?: { channel?: string } } };
    expect(slot.mode).toBe("driven");
    expect(slot.bindings?.driven?.channel).toBe("wlevel1:lowMid");
    const fence = document.graph.nodes["wcap"] as GraphNode;
    // T562 moved the fence WITH the window it guards: `shape1`'s Level was refitted to the
    // warped field's measured spread (0.451..0.543 rather than 0.235..0.72), so the old
    // 0.62..0.80 would no longer be a safety bound — it would be the whole picture. The
    // assertion is that the fence still BRACKETS the retained white point closely, which is
    // the property, rather than the two literals it used to be.
    const retained = ((document.graph.nodes["shape"] as GraphNode).parameters["whitelevel"] as {
      bindings?: { static?: { value?: number } };
    }).bindings?.static?.value;
    expect(retained).toBe(0.543);
    expect(fence.parameters["minimum"]).toBe(0.528);
    expect(fence.parameters["maximum"]).toBe(0.566);
  });

  /**
   * T562 — THE CHEMISTRY MAP IS A FIELD, and the failure it shipped with was that the
   * field was nearly a CONSTANT: `broad1` ran at period 0.62 with two octaves, one feature
   * bigger than the frame, and `detail1` only warped it. Several octaves at a smaller
   * period is what gives the picture regions, so it is asserted rather than left to be
   * quietly retuned back.
   */
  it("gives the chemistry map more than one spatial scale, or every region runs the same chemistry", () => {
    const broad = document.graph.nodes["broad"] as GraphNode;
    expect(broad.parameters["harmon"]).toBeGreaterThanOrEqual(3);
    expect(broad.parameters["period"]).toBeLessThanOrEqual(0.35);
    // And the window is fitted to the field rather than three times wider than it: a Level
    // whose span dwarfs its input's spread is moving DC, not making contrast.
    const shape = document.graph.nodes["shape"] as GraphNode;
    const black = shape.parameters["blacklevel"] as number;
    const white = ((shape.parameters["whitelevel"] as { bindings?: { static?: { value?: number } } })
      .bindings?.static?.value) as number;
    expect(white - black).toBeLessThan(0.15);
  });

  /** The RGB delay is TIME: three ring taps at three depths, braided one channel each. */
  it("builds the RGB delay from three cache taps, not per-channel scaling", () => {
    const taps = plan.passes
      .filter((pass) => pass.kind === "effect" && String((pass as { id: string }).id).includes("cache-read"))
      .map((pass) => ((pass as { uniforms?: { tap?: number } }).uniforms?.tap ?? 0));
    // T560 shortened the spread from 2/5/9. A delay line LONGER than a transient turns
    // that transient into pure primaries: once a beat seeds new structure, a blob appears
    // and is consumed within a frame or two, and at a spread of seven each channel caught
    // that flash alone. Three depths, braided one channel each, is the concept; the depths
    // are scaled to the fastest thing in the picture.
    expect([...taps].sort((a, b) => a - b)).toEqual([2, 4, 7]);
    const rings = plan.resources.filter((resource) => resource.kind === "ring") as ReadonlyArray<{
      frames: number;
    }>;
    expect(rings.map((ring) => ring.frames).sort((a, b) => a - b)).toEqual([4, 5, 8]);
  });

  /** The wind is INSIDE the loop region, so substeps multiply the stirring. */
  it("stirs inside the loop: the wind pass sits between the loop markers", () => {
    const ids = plan.passes.map((pass) => (pass as { id: string }).id);
    const begin = ids.findIndex((id) => id.endsWith("#loop:begin"));
    const end = ids.findIndex((id) => id.endsWith("#loop:end"));
    const windIndex = ids.findIndex((id) => id.startsWith("wind#"));
    expect(begin).toBeGreaterThanOrEqual(0);
    expect(windIndex).toBeGreaterThan(begin);
    expect(windIndex).toBeLessThan(end);
  });

  /**
   * T560 — THE TRIGGER SEEDS THE PLATE, AND NOTHING LAGS IT. The shipped file put `trig1`'s
   * one-frame pulse through a `valueLag` of 0.35 s, and a one-pole smoother answers a
   * single-frame impulse with `1 - exp(-dt/tau)` — 0.047 at 60fps — so the palette scale it
   * drove travelled 2.4000..2.4535 on a hit. §V481(b) from the other side. The pulse now
   * reaches the Threshold's CUT raw: shut at 2.0 (nothing in a 0..1 field reaches it), open
   * on the frame the hit lands, screened into the simulation state as a seed the reaction
   * then grows. The assertion is the ABSENCE of a smoother on that path, because that is
   * the thing that was wrong.
   */
  it("seeds the plate from the raw trigger, with nothing smoothing the pulse", () => {
    expect((document.graph.nodes["trig"] as GraphNode).type).toBe("valueTrigger");
    const gate = document.graph.nodes["gate"] as GraphNode;
    expect(gate.type).toBe("threshold");
    const slot = gate.parameters["threshold"] as {
      mode?: string;
      bindings?: { driven?: { channel?: string }; static?: { value?: number } };
    };
    expect(slot.bindings?.driven?.channel).toBe("seedcut1:onsetCount");
    expect(slot.bindings?.static?.value).toBe(2); // shut, and shut is exactly zero mask
    // trig1 -> seedamt -> seedcut -> the gate: every hop is arithmetic, none is stateful.
    const path = ["seedamt", "seedcut"].map((id) => (document.graph.nodes[id] as GraphNode).type);
    expect(path).toEqual(["valueMath", "valueMath"]);
    expect(document.graph.nodes["kick"]).toBeUndefined();
    // And the seed is SCREENED into the state, not added: screen takes U and V to 1 where
    // the mask is, which is the kernel's own seededState, and leaves them untouched at 0.
    expect((document.graph.nodes["inject"] as GraphNode).type).toBe("screen");
  });

  /**
   * T560 — FIVE FAST PATHS BESIDE THE SLOW ONE, off a SECOND Lag. The whole diagnosis in
   * one assertion: every audio path used to run through the reaction, which integrates a
   * beat away. These five are one-frame responses, one band each (§V471.3), and the Lag
   * they hang off has to be the fast one or they are back on the integrator.
   */
  it("drives five one-frame properties off a fast lag, one band each", () => {
    const snap = document.graph.nodes["snap"] as GraphNode;
    expect(snap.type).toBe("valueLag");
    expect(snap.parameters["lag"]).toBeLessThan(0.06);
    expect((document.graph.nodes["env"] as GraphNode).parameters["lag"]).toBeGreaterThan(0.1);
    const driven = (nodeId: string, key: string): string | undefined =>
      ((document.graph.nodes[nodeId] as GraphNode).parameters[key] as {
        bindings?: { driven?: { channel?: string } };
      }).bindings?.driven?.channel;
    expect(driven("warpA", "weight.x")).toBe("lena1:low");
    expect(driven("warpB", "weight.x")).toBe("lenb1:lowMid");
    expect(driven("warpC", "weight.x")).toBe("lenc1:high");
    expect(driven("tint", "scale")).toBe("grade1:highMid");
    expect(driven("glow", "brightness")).toBe("bright1:level");
    // Five DIFFERENT bands: one master gain moving everything together is the thing
    // §V471.3 exists to rule out.
    const bands = new Set(
      ["lena1:low", "lenb1:lowMid", "lenc1:high", "grade1:highMid", "bright1:level"].map(
        (channel) => channel.split(":")[1],
      ),
    );
    expect(bands.size).toBe(5);
  });

  /**
   * B74/§V363: the flagship demonstrates ITSELF. Assets are session-only, so no example
   * can ship a bound track — the music node must be the deterministic pattern, or the
   * first-open experience is an LFO breathing over a doc line nobody reads.
   */
  it("ships the synthetic pattern as its source, so it plays on first open", () => {
    const music = document.graph.nodes["music"] as GraphNode;
    expect(music.type).toBe("audioPattern");
    expect(music.label).toBe("music1"); // the swap contract: replace the node, keep the label
  });
});

describe("E25 Stage", () => {
  const { document, plan } = example("E25-Stage.loom.json");

  /**
   * T444's whole claim, as one assertion: scene A's RENDER is scene B's MATERIAL — the
   * virtual screen is a texture edge into an albedo slot, and camera B films it.
   */
  it("puts render A's picture on scene B's screen: the virtual-screen wire", () => {
    const draws = plan.passes.filter((pass) => pass.kind === "draw") as ReadonlyArray<{
      nodeId?: string;
      textures?: ReadonlyArray<{ binding: string; resourceId: string }>;
    }>;
    const screenDraw = draws.find(
      (draw) => draw.nodeId === "shotB" && draw.textures?.some((t) => t.binding === "albedoMap"),
    );
    expect(screenDraw?.textures?.some((t) => t.resourceId === "target:shotA:out")).toBe(true);
  });

  it("renders A before B — the stage cannot film a picture that has not happened", () => {
    const order = plan.passes.map((pass) => (pass as { nodeId?: string }).nodeId ?? "");
    expect(order.indexOf("shotA")).toBeLessThan(order.indexOf("shotB"));
  });

  /** Everything driven: both camera orbits and the breathing key are VALUE slots. */
  it("drives both cameras and a light — the whole stage animates as uniforms (§V5)", () => {
    const drivenChannel = (nodeId: string, key: string): string | undefined => {
      const stored = (document.graph.nodes[nodeId] as GraphNode).parameters[key] as {
        bindings?: { driven?: { channel?: string } };
      };
      return stored?.bindings?.driven?.channel;
    };
    expect(drivenChannel("camA", "eye.x")).toBe("orbax1");
    expect(drivenChannel("camB", "eye.x")).toBe("orbbx1");
    expect(drivenChannel("keyB", "intensity")).toBe("breathe1");
  });

  /** Scene B is a MULTI-OBJECT scene: the screen and the floor, in list order. */
  it("draws two named geometries in scene B, screen first", () => {
    const scenes = (document.graph.nodes["shotB"] as GraphNode).parameters["scenes"];
    expect(scenes).toBe("screen1 floor1");
    const bDraws = plan.passes.filter(
      (pass) =>
        pass.kind === "draw" &&
        (pass as { nodeId?: string }).nodeId === "shotB" &&
        (pass as { id: string }).id.includes(":scene:"),
    );
    expect(bDraws).toHaveLength(2);
  });
});


describe("E26 Interference", () => {
  const { document, plan } = example("E26-Interference.loom.json");

  /**
   * §V6, and here it is not a footnote: the ring field is generated ONCE and read TWICE,
   * and the difference between those two readings IS the picture. If the fan-out were ever
   * compiled as two independent chains the image would be identical — and it would cost
   * twice as much and stop being a demonstration of anything.
   */
  it("generates the ring field once and consumes it twice", () => {
    const wrapPasses = plan.passes.filter((pass) => (pass as { nodeId?: string }).nodeId === "wrap");
    expect(wrapPasses).toHaveLength(1);

    const textures = (nodeId: string): ReadonlyArray<string> =>
      (effectFor(plan, nodeId).textures ?? []).map((entry) => entry.resourceId);

    const ringField = outputFor(plan, "wrap").resourceId;
    // One consumer reads it straight; the other reads it through the Transform.
    expect(textures("beat")).toContain(ringField);
    expect(textures("warp")).toContain(ringField);
    // ...and the Transform's own output is the OTHER half of the difference, so `beat`
    // is comparing the field against a moved copy of itself rather than against anything
    // new (which is the whole claim).
    expect(textures("beat")).toContain(outputFor(plan, "warp").resourceId);
  });

  /**
   * The value lives in RED all the way down — Circle's `distance` mode writes the signed
   * distance to red and leaves green and blue at zero. A Lookup left on its `luminance`
   * default would index the palette at 0.2126x the beat: a picture, dimmer, with the
   * contrast gone and every wire still correct.
   */
  it("indexes the palette on red, not on luminance", () => {
    const red = CHANNEL_OPTIONS.findIndex((option) => option.value === "red");
    expect(effectFor(plan, "tint").uniforms?.["channel"]).toBe(red);
    expect(red).not.toBe(CHANNEL_OPTIONS.findIndex((option) => option.value === "luminance"));
  });

  /**
   * ZIGZAG, not loop, and it is the anti-aliasing rather than a preference. A sawtooth has
   * a discontinuity on every ring; at an ~18px pitch those edges crawl under the drift.
   * The triangle wave is continuous, so the fine structure resolves instead of shimmering.
   * `clamp` — the parameter's own default — produces NO rings at all, which is the failure
   * this pins: a graph that compiles, renders, and shows a smooth gradient.
   */
  it("folds the distance field with a continuous triangle wave", () => {
    // LIMIT_MODE_OPTIONS is local to color.ts; the order is clamp, loop, zigzag, quantize.
    expect(effectFor(plan, "wrap").uniforms?.["mode"]).toBe(2);
    expect(effectFor(plan, "wrap").uniforms?.["low"]).toBe(0);
    expect(effectFor(plan, "wrap").uniforms?.["high"]).toBe(1);
  });

  /**
   * WHY THE SECOND COPY IS OFFSET AND SCALED AND NEVER ROTATED. Concentric rings are
   * rotationally symmetric about their own centre, so a rotation would leave the two
   * readings IDENTICAL and the difference exactly zero — a black frame with every wire
   * connected. What breaks the symmetry is the scale (concentric beats) and the drift
   * (hyperbolic fringes), so both are asserted present and the rotation is asserted absent.
   */
  it("breaks the ring symmetry by scale and offset, never by rotation", () => {
    const warp = document.graph.nodes["warp"] as GraphNode;
    expect(warp.parameters["r"]).toBe(0);
    expect(warp.parameters["s"]).toEqual([1.16, 1.16]);
    const channel = (key: string): string | undefined =>
      (warp.parameters[key] as { bindings?: { driven?: { channel?: string } } })?.bindings?.driven
        ?.channel;
    expect(channel("t.x")).toBe("driftx1");
    expect(channel("t.y")).toBe("drifty1");
  });

  /**
   * T402 at the value graph: the two drifts run at INCOMMENSURATE rates, so the offset
   * traces a Lissajous figure that does not close. Equal rates would draw a closed ellipse
   * and the piece would loop every twenty seconds — still animated, and much smaller.
   * (The pixel-level motion claim is in `examples.gpu.test.ts`; §V147 is explicit that this
   * one is not evidence for it.)
   */
  it("drifts on two rates that do not close", () => {
    const rate = (nodeId: string) => (document.graph.nodes[nodeId] as GraphNode).parameters["frequency"];
    expect(rate("driftx")).toBe(0.05);
    expect(rate("drifty")).toBe(0.031);
    expect(rate("driftx")).not.toBe(rate("drifty"));

    // ...and the values actually move, through the real session rather than the retained
    // half: a channel that stopped publishing resolves to 0 forever and every assertion
    // above still passes.
    const run = valueGraphRun(document);
    const seen = new Set<number>();
    for (let index = 0; index < 120; index += 1) {
      const { plan: framePlan } = run.step(CENTRE);
      const translate = effectFor(framePlan, "warp").uniforms?.["t"] as readonly number[] | undefined;
      seen.add(translate?.[1] ?? 0);
    }
    expect(seen.size).toBeGreaterThan(60);
  });
});

describe("E27 Relief", () => {
  const { document, plan } = example("E27-Relief.loom.json");

  /**
   * THE UNDERSTUDY PATTERN (§V411), and this is the assertion that matters most in the
   * file. §V363 says a demo must demonstrate itself; B39 says an unexampled node ships
   * dead. A Switch satisfies both at once — but ONLY if the synthetic branch is the one
   * the index selects, and a variadic port's order is a property of the EDGES (§V131).
   *
   * Left to the id tiebreak, "e-cam-pick" sorts before "e-sum-pick" and this file opens on
   * a black camera: the exact null state §V363 exists to prevent, chosen by spelling. It
   * did, while this example was being built.
   */
  it("opens on the synthetic performer, by declared edge order and not by alphabet", () => {
    expect(document.graph.nodes["pick"]?.parameters["index"]).toBe(0);
    const intoSwitch = Object.values(document.graph.edges).filter(
      (candidate) => candidate.target.nodeId === "pick",
    );
    expect(intoSwitch).toHaveLength(2);
    const bySource = new Map(intoSwitch.map((candidate) => [candidate.source.nodeId, candidate.order]));
    expect(bySource.get("sum")).toBe(0);
    expect(bySource.get("cam")).toBe(1);
    // ...and the ids really would have sorted the other way, so the order is load-bearing
    // rather than decorative.
    const byId = [...intoSwitch].sort((a, b) => a.id.localeCompare(b.id));
    expect(byId[0]?.source.nodeId).toBe("cam");
  });

  /**
   * ...AND THE CAMERA IS STILL COMPILED. A Switch picks a RESOURCE; it does not prune the
   * branch it did not pick, so `webcam`'s pass is in the plan and its shader is built by
   * `examples.gpu.test.ts` on a real device. That is the integration gate §V362 names as
   * the only one we have, and it is the one B39 escaped for months.
   */
  it("keeps the webcam in the plan, bound to the switch, while the understudy plays", () => {
    expect(Object.values(document.graph.nodes).some((entry) => entry.type === "webcam")).toBe(true);
    const webcamResource = outputFor(plan, "cam").resourceId;
    const bound = (effectFor(plan, "pick").textures ?? []).map((entry) => entry.resourceId);
    expect(bound).toContain(webcamResource);
    expect(bound).toContain(outputFor(plan, "sum").resourceId);
  });

  /**
   * T478: per-point colour reaches the SCENE. The geometry's tint is in map mode on the
   * bridged `sample`, so the material's base colour is multiplied per point — which is how
   * a scene-pipeline draw gets thousands of colours without an albedo map and without a uv
   * mapping. Before T478 this example had to choose between lighting and per-point colour.
   */
  it("colours the instances per point through the geometry's tint map", () => {
    const stored = (document.graph.nodes["body"] as GraphNode).parameters["tint"] as {
      mode?: string;
      bindings?: { map?: { attribute?: string } };
    };
    expect(stored.mode).toBe("map");
    expect(stored.bindings?.map?.attribute).toBe("sample");
  });

  /**
   * UNLIT, and no lights at all. A phosphor has no diffuse response; the colour is the
   * sample and nothing shades it. A lit material here would multiply the palette by a
   * lambert term and the panel would go dark at its edges — plausible, and wrong.
   */
  it("draws an unlit phosphor with no light list", () => {
    expect(document.graph.nodes["phosphor"]?.type).toBe("materialUnlit");
    expect(document.graph.nodes["shot"]?.parameters["lights"]).toBe("");
  });

  /**
   * THE QUAD MUST BE SMALLER THAN THE GAP. The sheet is 2 x 1.7778 world units wide across
   * 480 columns, so the point spacing is ~0.0074; a quad half-extent at or above half of
   * that closes every gap and the scan lines fuse into one solid slab. The first build ran
   * 0.0075 and rendered exactly that — a flat sheet, every wire correct.
   */
  it("keeps the instance quad under half the point spacing", () => {
    const spacing = (2 * 1.7778) / 480;
    const scale = document.graph.nodes["body"]?.parameters["scale"] as number;
    expect(scale).toBeLessThan(spacing / 2);
    expect(scale).toBeGreaterThan(0);
  });
});
