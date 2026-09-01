import { describe, expect, it } from "vitest";
import { compileGraph, CompilerDiagnosticCode } from "../compiler/index.ts";
import type { CompiledGraph } from "../compiler/index.ts";
import { createValueGraphSession } from "../domain/channels/value-graph.ts";
import { sourceReferenceName } from "../domain/graph/source-references.ts";
import { SHADER_SOURCE_PARAMETER } from "../domain/commands/apply-patch.ts";
import type { FrameEvaluationInput } from "../domain/types/frame.ts";
import type { GraphDocument, GraphNode, ProjectDocument } from "../domain/types/graph.ts";
import type { ParameterSlot } from "../domain/types/parameters.ts";
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
      // T734: the advection is INSIDE the loop, which is the whole reason it works — and
      // is also its cost, stated here so nobody has to rediscover it: twenty extra
      // displace passes per displayed frame, not one.
      "flow",
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
   * T734 / §V626 — TO BREAK A PATTERN, MOVE THE MEDIUM.
   *
   * The owner's complaint was that E2 "becomes a static field of sorts". It never literally
   * froze; the COMPOSITION died. Measured on the shipped file before this change, the tile
   * CV of a 16x16 grid of 32px tiles fell 0.695 at frame 60 to 0.137 at frame 600 and then
   * sat between 0.099 and 0.177 for the next fifty seconds — an evenly covered screen, which
   * is the second half of what the owner reported.
   *
   * §V554's corrected band says why: this kernel's regimes are dense labyrinth below 0.30,
   * open labyrinth to 0.55, a REGULAR SPOT LATTICE from 0.55 to 0.85, and dead above 0.90 —
   * and motion falls monotonically across it. A lattice is stable because its substrate is
   * stationary, so the fix is to move the substrate. Two things make that advection rather
   * than decoration, and both are asserted here because both fail silently:
   *
   *   1. The flow field is TWO CHANNELS. `mono: true` gives every texel the same offset in
   *      x and y, which translates the picture instead of shearing it. Measured: flipping
   *      that one flag costs 45% of the moved-pixel count.
   *   2. The chemistry map is repainted from the map chain AFTER the reaction, so the state
   *      moves and its parameters do not. If the map were carried along with the state, the
   *      lattice would ride its own chemistry and nothing would shear.
   */
  it("advects the STATE through a static chemistry map, rather than rotating the pattern", () => {
    // §V626's slot: between the Feedback and the kernel, and a DISPLACE, not a Transform.
    // E24 shipped a Transform here for two hundred tasks and it turned the lattice without
    // breaking it — a rotation leaves a lattice a lattice.
    expect(document.graph.nodes["flow"]?.type).toBe("displace");

    // A zero weight is a wire that renders identically and advects nothing (§V147's shape),
    // and BOTH axes have to carry it — one axis is a shear along a line, not a flow.
    const weight = effectFor(plan, "flow").uniforms?.["weight"];
    expect(Array.isArray(weight) ? weight : []).toHaveLength(2);
    for (const axis of weight as readonly number[]) expect(Math.abs(axis)).toBeGreaterThan(0);

    // The flow field is its own noise, animated, and NOT one of the map's two noises —
    // sharing one would tie the flow to the chemistry it is supposed to slide across.
    const swell = effectFor(plan, "swell");
    expect(swell.uniforms?.["speed"]).not.toBe(0);
    expect(swell.sharedBinding).toBe("frameU");
    for (const id of ["broad", "detail"]) {
      expect(effectFor(plan, id).uniforms?.["seed"], id).not.toBe(swell.uniforms?.["seed"]);
    }
    // TWO CHANNELS. `mono` collapses the field to one, and a displace driven by one channel
    // offsets every texel identically: a translation, not a flow.
    expect(swell.uniforms?.["mono"]).toBeFalsy();

    // The state goes in and the flow field displaces it; nothing else reaches this node.
    const intoFlow = Object.values(document.graph.edges).filter((edge) => edge.target.nodeId === "flow");
    expect(intoFlow.map((edge) => `${edge.source.nodeId}->${edge.target.portId}`).sort()).toEqual([
      "state->source",
      "swell->disp",
    ]);

    // And the MAP is not carried with it. The chemistry coordinate reaches blue from the
    // map chain through the Reorder, which runs AFTER the kernel, so the parameters the
    // reaction reads are a function of PLACE while the state slides across them.
    const mapIntoPack = Object.values(document.graph.edges).find(
      (edge) => edge.target.nodeId === "pack" && edge.target.portId === "in2",
    );
    expect(mapIntoPack).toBeDefined();
    const reachesFlow = (from: string, seen = new Set<string>()): boolean => {
      if (from === "flow" || from === "state") return true;
      if (seen.has(from)) return false;
      seen.add(from);
      return Object.values(document.graph.edges)
        .filter((edge) => edge.target.nodeId === from)
        .some((edge) => reachesFlow(edge.source.nodeId, seen));
    };
    expect(reachesFlow(mapIntoPack!.source.nodeId)).toBe(false);
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
    // T734: the state now reaches the kernel THROUGH the advection, so the single input is
    // `flow1` rather than `state` — still one input, still the Reorder carrying the map.
    expect(intoKernel[0]?.source).toEqual({ nodeId: "flow", portId: "out" });
    const intoFlow = Object.values(document.graph.edges).find((edge) => edge.target.nodeId === "flow" && edge.target.portId === "source");
    expect(intoFlow?.source).toEqual({ nodeId: "state", portId: "out" });
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
   * T768/§V57c flipped this control's meaning, and the flip IS the claim now. `disp`
   * declares `space: "data"`, and a data input accepts ANY source space because reading
   * bytes as data converts nothing — so encoding the displacement branch is no longer a
   * mismatch AT ALL: the raw bytes are the offsets, whatever curve shaped them, and
   * that is the user's field to shape. The old "encoded disp gets caught" behaviour was
   * a symptom of `disp` being mistyped as colour.
   */
  it("accepts an encoded displacement branch without complaint — data reads raw (§V57c)", () => {
    const encoded = recompile(document, withFormat(document.graph, "place", "rgba8unorm-srgb"));
    const mismatches = encoded.diagnostics.filter(
      (d) => d.code === CompilerDiagnosticCode.colorSpaceMismatch,
    );
    expect(mismatches).toEqual([]);
  });

  /**
   * Where the OLD control went: the mismatch is a MIXED-COLOUR-INPUTS warning, and with
   * `disp` honestly typed `data` (exempt from the mix by design), Displace has exactly
   * one colour input left — so no single-node format override in this document can
   * produce the warning any more. That is not lost coverage: the mix warning and the
   * data exemption are both pinned in `src/compiler/color-space.test.ts` ("warns on
   * mixed colour spaces", "exempts data inputs"), where a two-colour-input fixture
   * exists by construction. This document's claim is the two assertions above: one
   * space end to end, and an encoded field accepted raw.
   */

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

  /** The scene draws, in the order `shot1.scenes` lists them. */
  const sceneDraws = (source: CompiledGraph): readonly DrawPassDescriptor[] =>
    source.passes.filter(
      (entry): entry is DrawPassDescriptor => entry.kind === "draw" && entry.id.includes(":scene:"),
    );
  const buffersOf = (pass: DrawPassDescriptor): Map<string, string> =>
    new Map((pass.buffers ?? []).map((buffer) => [buffer.binding, buffer.resourceId]));
  const texturesOf = (pass: DrawPassDescriptor | EffectPassDescriptor): Map<string, string> =>
    new Map((pass.textures ?? []).map((texture) => [texture.binding, texture.resourceId]));
  const uniformsOf = (pass: DrawPassDescriptor): Record<string, readonly number[]> =>
    pass.uniforms as Record<string, readonly number[]>;
  const kernelOf = (nodeId: string): string =>
    String((document.graph.nodes[nodeId] as GraphNode).parameters["kernel"]);

  /**
   * THE MESH AND THE OPTICS READ ONE NUMBER, and nothing in the compiler checks that.
   *
   * `form1` builds the prism and `optics1` solves Snell's law against the plane its two
   * refracting faces lie in. They agree only because a rounded triangle's straight run
   * sits at d·cos(60°) + ρ from the axis, and with d = RC − 2ρ that is RC/2 for EVERY
   * corner radius — a sharp triangle's inradius, unmoved by the rounding that makes the
   * rim possible. Change RC in one kernel and the picture stays entirely plausible while
   * the beam floats beside the glass or drives through it.
   *
   * This is the DOCUMENT half of that claim; the picture half — the shaft landing on the
   * mask, neither beam inside an 8px erosion of it, the fan's rays converging on the
   * glass — is `prism.gpu.test.ts`, because §V147 is explicit that source text is not
   * evidence about a pixel. Both halves exist because the two kernels are edited by hand
   * and separately, and a constant that has to be typed twice is a constant that will be
   * typed twice differently.
   */
  it("solves the optics against the same circumradius the mesh is built from", () => {
    const circumradius = /const RC: f32 = ([\d.]+);/.exec(kernelOf("form"))?.[1];
    const inradius = /const RI: f32 = ([\d.]+);/.exec(kernelOf("optics"))?.[1];
    expect(circumradius).toBeDefined();
    expect(inradius).toBeDefined();
    expect(Number(inradius)).toBeCloseTo(Number(circumradius) / 2, 6);
  });

  /**
   * ONE SOURCE, TWO READINGS (§V471.1), traced through the plan rather than read off the
   * node names.
   *
   * `optics1` writes one pointset and two Geometries draw it, so the structure is a
   * SELECTION and not more nodes. What makes that checkable without a picture is the
   * `group_role` binding: a draw pass acquires it only because a group predicate names an
   * attribute, so it is present exactly when the split exists — and the surface draw must
   * NOT have one, because a predicate on a surface is refused by name (it would punch
   * holes in a mesh rather than select from a cloud).
   *
   * The two tapers are the reason the split is not cosmetic. 61 beams leaving the same
   * face within 0.03 of each other fuse into an opaque wedge at any taper above roughly
   * zero (T680), and a single collimated shaft must not be pinched at all.
   */
  it("splits one pointset into a pinched fan and a parallel-sided shaft", () => {
    /* T758: the prism's own draw moved to the TRANSMISSION phase (materialGlass draws
       after the opaques it samples), so the scene phase carries exactly the two beam
       draws and the body is found at its glass id. */
    const beams = sceneDraws(plan);
    expect(beams).toHaveLength(2);
    const surface = plan.passes.find(
      (pass): pass is DrawPassDescriptor =>
        pass.kind === "draw" && pass.id.includes(":glass:") && !pass.id.includes("pyramid"),
    ) as DrawPassDescriptor;
    expect(surface).toBeDefined();
    // The surface is the prism, from its own kernel, with no predicate.
    expect(buffersOf(surface).get("positions")).toBe("scratch:form:position");
    expect(buffersOf(surface).has("group_role")).toBe(false);

    for (const beam of beams) {
      const buffers = buffersOf(beam);
      // The SAME positions, and the same far end: one source.
      expect(buffers.get("positions")).toBe("scratch:optics:position");
      expect(buffers.get("endpoints")).toBe("scratch:optics:tip");
      // Selected, and coloured per point.
      expect(buffers.get("group_role")).toBe("scratch:optics:role");
      expect(buffers.get("pointColors")).toBe("scratch:optics:tint");
      // instance = [half-width, shape, TAPER, 0] (T680).
      expect(beam.uniforms).toBeDefined();
    }

    const tapers = beams.map((beam) => (uniformsOf(beam)["instance"] as readonly number[])[2] as number);
    // One parallel-sided ribbon and one pinched at its origin — sorted, so this asserts
    // the two VALUES rather than the order `scenes` happens to list them in (§V656).
    expect([...tapers].sort((a, b) => a - b)).toEqual([0.06, 1]);

    // And the predicates really are complementary halves. This one IS a source claim,
    // deliberately: whether the two draws select DIFFERENT points cannot be seen in a
    // binding, and the pixel half of it is in `prism.gpu.test.ts`.
    const sources = beams.map((beam) => beam.shader);
    expect(sources.some((source) => source.includes("p.role < 0.5"))).toBe(true);
    expect(sources.some((source) => source.includes("p.role > 0.5"))).toBe(true);
    expect(sources[0]).not.toBe(sources[1]);
  });

  /**
   * THE RIM'S WIRING — §V640's mechanism, at §V640's address.
   *
   * The invariant is specific about where the band goes: a silhouette samples the
   * equirect's HORIZON, so the rim is authored as a bright band at (0.5, 0.5). For this
   * subject that is exact rather than approximate — a normal lying in the prism's
   * cross-section plane reflects to (0, 0, −1), and the equirect mapping sends that to
   * u = 0.5, v = 0.5 — so the band's centre being anywhere else is a bug that renders as
   * a duller picture and nothing more.
   *
   * `aspectcorrect` must be FALSE on an equirect (the map is not a picture of a square),
   * and the surface draw must actually receive the map: the beams are unlit and get none,
   * which is why the environment binding appears on exactly one of the three draws.
   */
  it("wires the environment band to the equirect's horizon, and only the glass reads it", () => {
    const band = effectFor(plan, "band").uniforms as Record<string, unknown>;
    expect(band["center"]).toEqual([0.5, 0.5]);
    // aspectcorrect false resolves to an aspect of exactly 1 — no stretch on either axis.
    expect(band["aspect"]).toBe(1);

    /* T758: the reader is the GLASS draw now — its Schlick fresnel against this very
       map is the rim — and the unlit beams still get none. */
    const beamDraws = sceneDraws(plan);
    expect(beamDraws.filter((draw) => texturesOf(draw).has("environmentMap"))).toHaveLength(0);
    const glassDraw = plan.passes.find(
      (pass): pass is DrawPassDescriptor =>
        pass.kind === "draw" && pass.id.includes(":glass:") && !pass.id.includes("pyramid"),
    ) as DrawPassDescriptor;
    expect(texturesOf(glassDraw).get("environmentMap")).toBe(outputFor(plan, "studio").resourceId);
    expect(buffersOf(glassDraw).get("positions")).toBe("scratch:form:position");
  });

  /**
   * A BLACK BODY AND NO AMBIENT, which is E33's lesson (§V632/T636) rather than taste.
   *
   * Everything visible on this prism is `specular · envFresnel · environmentIntensity`,
   * and envFresnel is 0.04 head-on against 1.0 at grazing. That 25× is the entire
   * separation between the body and the outline, and it survives only while nothing else
   * is adding light: a diffuse albedo bright enough to see, or an ambient term worth the
   * name, closes the gap from below and the glass goes to grey slate.
   *
   * So the numbers are asserted as numbers (§V218). Albedo below 0.002 LINEAR — these are
   * authored in display space and the compiler decodes them, which is exactly the place a
   * "0.012 is nearly black" intuition would be wrong by a transfer curve.
   */
  it("gives the glass real optics and no light of its own (T758)", () => {
    /* The body is the T725 transmissive surface: its whole read is the sampled frame
       plus the Schlick-against-environment rim — it takes NO lights and NO ambient by
       construction (§V617's third thing), which is what the old black-albedo/zero-
       ambient discipline was approximating by hand. The optics are asserted as the
       numbers the document authors: glassA = [ior, roughness, thickness, dispersion],
       glassB.w = the same environmentIntensity the phong body used (3.2 — the rim's
       gain did not move in the swap). */
    const surface = plan.passes.find(
      (pass): pass is DrawPassDescriptor =>
        pass.kind === "draw" && pass.id.includes(":glass:") && !pass.id.includes("pyramid"),
    ) as DrawPassDescriptor;
    const uniforms = uniformsOf(surface);
    expect(uniforms["glassA"]).toEqual([1.5, 0.04, 0.8, 0.06]);
    expect((uniforms["glassB"] as readonly number[])[3]).toBeCloseTo(3.2, 6);
    expect(uniforms["light0Meta"]).toBeUndefined();
    expect(uniforms["ambientColor"]).toBeUndefined();
    // The key still lights nothing else — the beams are unlit — so its whole job stays
    // the glint the doc describes, delivered through the environment map.
  });

  /**
   * THE CLAMP BETWEEN THE LEVEL AND THE BLUR IS LOAD-BEARING, and this file is its worst
   * case.
   *
   * Level is a SIGNED pipeline: below `blacklevel` it emits negatives. The blur spreads
   * them over the whole frame and `add` then SUBTRACTS a halo from the picture. E33 and
   * E34 both blacked out entirely before they learned this, and E13 is 90% black — almost
   * every pixel here is below the threshold.
   *
   * The assertion is the ROUTING, because a `limit` node sitting beside the chain and
   * wired to nothing renders exactly like a missing one: the blur's input must be the
   * limit's output, and the limit's floor must actually be zero.
   */
  it("routes the bloom through a clamp, not straight from the level into the blur", () => {
    const blur = plan.passes.find(
      (entry): entry is EffectPassDescriptor => entry.kind === "effect" && entry.nodeId === "halo",
    );
    expect(blur).toBeDefined();
    expect(texturesOf(blur as EffectPassDescriptor).get("inputTexture")).toBe(outputFor(plan, "clip").resourceId);
    expect(texturesOf(effectFor(plan, "clip")).get("inputTexture")).toBe(outputFor(plan, "cut").resourceId);
    expect((effectFor(plan, "clip").uniforms as Record<string, number>)["low"]).toBe(0);
    // And the bloom is ADDED to the render rather than replacing it.
    const glow = effectFor(plan, "glow");
    expect(texturesOf(glow).get("frontTexture")).toBe(outputFor(plan, "shot").resourceId);
    expect(texturesOf(glow).get("backTexture0")).toBe(outputFor(plan, "halo").resourceId);
  });

  /**
   * A SQUARE WAVE THROUGH A LAG IS AN EASE, and that is why `swing1` is a square rather
   * than a sine. A sine would look smooth with `ease1` deleted and this assertion would be
   * unfalsifiable; a square takes exactly two values, so every value BETWEEN them in the
   * compiled uniforms was produced by the smoothing stage.
   *
   * The aim is what the whole example turns on — the fan's spread is a function of it — so
   * this discriminates three failures at once: no chain (one value forever), no Lag (two
   * values), and a Lag that holds instead of integrating (it never reaches either end).
   */
  it("eases the aim between the square wave's two levels instead of snapping", () => {
    const run = valueGraphRun(document);
    const parked: Pointer = { x: 0, y: 0, buttons: 0 };
    const aims = new Set<number>();
    let low = 1;
    let high = 0;
    // 0.18 Hz: a bit over five seconds a cycle, so 400 frames crosses several edges.
    for (let index = 0; index < 400; index += 1) {
      const { plan: live } = run.step(parked);
      const dispatch = live.passes.find((entry) => entry.kind === "dispatch" && entry.nodeId === "optics");
      const value = ((dispatch as { uniforms?: Record<string, number> }).uniforms ?? {})["value1"] as number;
      aims.add(Number(value.toFixed(6)));
      low = Math.min(low, value);
      high = Math.max(high, value);
    }
    expect(aims.size).toBeGreaterThan(50);
    // Both ends are actually reached, so the swing really is the full 62°..37°.
    expect(low).toBeLessThan(0.05);
    expect(high).toBeGreaterThan(0.95);
    // And nothing outside — the kernel clamps, but a slot that needed clamping would mean
    // the LFO's amplitude and offset had drifted off the parameter's own range.
    expect(low).toBeGreaterThanOrEqual(-1e-6);
    expect(high).toBeLessThanOrEqual(1 + 1e-6);
  });

  /**
   * THE POINTER ONLY EVER ADDS, and that is what makes it safe to ship on a parameter the
   * picture depends on.
   *
   * `mouse1 → follow1 → value3` is summed with the LFO INSIDE the kernel, because a value
   * graph merges channel BAGS and an LFO's channel shares no name with a pointer's `x`.
   * The consequence worth gating is the default: a pointer that has never moved reads 0,
   * so `value3` is exactly 0 and every gate in the suite sees the LFO's picture and not a
   * pointer-biased one. §V108's retained value, made true of an input that has none.
   *
   * Then the Lag's SHAPE, which is the same discrimination the old E13 made about its
   * lens: one frame after the pointer jumps, `value3` has moved and has moved only part of
   * the way; ninety frames later it has arrived.
   */
  it("adds nothing until the pointer moves, then eases in", () => {
    const value3Of = (source: CompiledGraph): number => {
      const dispatch = source.passes.find((entry) => entry.kind === "dispatch" && entry.nodeId === "optics");
      return ((dispatch as { uniforms?: Record<string, number> }).uniforms ?? {})["value3"] as number;
    };
    // The shipped, unresolved plan: no pointer anywhere, and the slot's retained value.
    expect(value3Of(plan)).toBe(0);

    const run = valueGraphRun(document);
    const parked: Pointer = { x: 0, y: 0, buttons: 0 };
    expect(value3Of(run.hold(parked, 60).plan)).toBeCloseTo(0, 6);

    const dragged: Pointer = { x: 1, y: 0.5, buttons: 0 };
    const oneFrame = value3Of(run.step(dragged).plan);
    expect(oneFrame).toBeGreaterThan(0);
    // A missing Lag lands on the pointer this frame.
    expect(oneFrame).toBeLessThan(0.5);
    expect(value3Of(run.hold(dragged, 90).plan)).toBeCloseTo(1, 3);
  });

  /**
   * HUE AND REFRACTIVE INDEX ARE ONE PARAMETER, which is the reason the spectrum is
   * ordered rather than merely colourful.
   *
   * `t` indexes the band; n = 1.50 + value2·t decides how far it bends, and the SAME `t`
   * samples `spectrum1` for its colour. Break the tie — colour the bands from anything
   * else — and the picture is a rainbow that is not a spectrum, which is the failure that
   * looks like success. The tie is a wire (the ramp reaches the kernel's `field` input,
   * so `fieldAt` is legal at all) plus one line of arithmetic, and both are checked here;
   * that red sits at the top of the fan and violet at the bottom is a claim about the
   * PICTURE and lives in `prism.gpu.test.ts`.
   */
  it("takes each band's colour and its refractive index from the same t", () => {
    const kernel = kernelOf("optics");
    expect(kernel).toContain("let n = N_RED + ctx.value2 * t;");
    expect(kernel).toContain("fieldAt(vec3f(t * 2.0 - 1.0, 0.0, 0.0))");

    // `fieldAt` compiles only when something is wired to the kernel's field input, so the
    // ramp reaching it is structural rather than decorative.
    const field = document.graph.edges;
    const wired = Object.values(field).some(
      (edge) => edge.target.nodeId === "optics" && edge.target.portId === "field" && edge.source.nodeId === "spectrum",
    );
    expect(wired).toBe(true);

    // And the ramp GOES somewhere (§V471.6): seven stops, red end to violet end, with the
    // ends genuinely opposite rather than two shades of one hue.
    const stops = (document.graph.nodes["spectrum"] as GraphNode).parameters["stops"] as ReadonlyArray<{
      position: number;
      color: readonly number[];
    }>;
    expect(stops.length).toBe(7);
    const first = stops[0] as { color: readonly number[] };
    const last = stops[stops.length - 1] as { color: readonly number[] };
    expect((first.color[0] as number)).toBeGreaterThan(first.color[2] as number);
    expect((last.color[2] as number)).toBeGreaterThan(last.color[0] as number);
  });

  /**
   * THE DISPERSIVE POWER IS A DOCUMENT PARAMETER, not a constant buried in the kernel.
   *
   * `optics1.value2` is the whole span of n across the band. It has to reach the dispatch
   * as a number for the gate that mutes it to mean anything — a mute that changed nothing
   * because the kernel had its own hard-coded span would pass and prove the opposite of
   * what it claims (§V655).
   */
  it("carries the glass's dispersive power as a live uniform the kernel reads", () => {
    const dispatch = plan.passes.find((entry) => entry.kind === "dispatch" && entry.nodeId === "optics");
    const uniforms = (dispatch as { uniforms?: Record<string, number> }).uniforms ?? {};
    expect(uniforms["value2"]).toBeCloseTo(0.085, 6);
    expect(kernelOf("optics")).toContain("ctx.value2");
    // Real crown glass is about a sixth of this, and the exaggeration is stated in the md.
    expect(uniforms["value2"]).toBeGreaterThan(0);
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
   * T734 / §V626 — AND THE WIND ADVECTS, IT DOES NOT ROTATE.
   *
   * This node shipped for a long time as a Transform with `r: 0.02`, a rigid rotation
   * applied seventeen to twenty-four times per frame depending on the bass. §V626 is that
   * a rotation TURNS a lattice and leaves it a lattice: the substrate stays stationary
   * relative to the pattern, so nothing shears. That is why E24 "gets very lame and boring
   * and evenly covers the screen very early on" — the stirring was decorative.
   *
   * Advection through the static chemistry map shears instead, and it beats the rotation at
   * every age measured: at frame 1800, motion 0.0462 to 0.0624 and live spot count 238 to
   * 907. The mutation that proves the claim is `weight: [0, 0]`, which renders a plausible
   * picture and collapses the moved-pixel count three to twelve fold.
   */
  it("advects the state rather than rotating it — the wind is a flow, not a spin", () => {
    expect(document.graph.nodes["wind"]?.type).toBe("displace");

    // Both axes carry weight, or this is a shear along a line rather than a flow.
    const weight = effectFor(plan, "wind").uniforms?.["weight"];
    expect(Array.isArray(weight) ? weight : []).toHaveLength(2);
    for (const axis of weight as readonly number[]) expect(Math.abs(axis)).toBeGreaterThan(0);

    // TWO CHANNELS in the flow field. `mono` offsets every texel identically, which is a
    // translation of the whole dish and shears nothing.
    const swell = effectFor(plan, "swell");
    expect(swell.uniforms?.["mono"]).toBeFalsy();
    expect(swell.uniforms?.["speed"]).not.toBe(0);

    // The state goes in on `source`, the flow on `disp`, and nothing else reaches it.
    const into = Object.values(document.graph.edges).filter((edge) => edge.target.nodeId === "wind");
    expect(into.map((edge) => `${edge.source.nodeId}->${edge.target.portId}`).sort()).toEqual([
      "state->source",
      "swell->disp",
    ]);
    // …and the kernel still reads the wind's output, so the slot is unchanged downstream.
    const out = Object.values(document.graph.edges).filter((edge) => edge.source.nodeId === "wind");
    expect(out.map((edge) => `${edge.target.nodeId}.${edge.target.portId}`)).toEqual(["rd.input"]);

    // The chemistry map is NOT carried along: `dish1` reaches blue through the Reorder,
    // which runs after the kernel, so the state slides across a stationary parameter field.
    const mapIntoPack = Object.values(document.graph.edges).find(
      (edge) => edge.target.nodeId === "pack" && edge.target.portId === "in2",
    );
    expect(mapIntoPack?.source.nodeId).toBe("dish");
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
    expect(driven("warpA", "weight.x")).toBe("lenswa1:low");
    expect(driven("warpB", "weight.x")).toBe("lenswb1:lowMid");
    expect(driven("warpC", "weight.x")).toBe("lenswc1:high");
    expect(driven("tint", "scale")).toBe("grade1:highMid");
    expect(driven("glow", "brightness")).toBe("bright1:level");
    // Five DIFFERENT bands: one master gain moving everything together is the thing
    // §V471.3 exists to rule out.
    const bands = new Set(
      ["lenswa1:low", "lenswb1:lowMid", "lenswc1:high", "grade1:highMid", "bright1:level"].map(
        (channel) => channel.split(":")[1],
      ),
    );
    expect(bands.size).toBe(5);
    /*
     * T738 — and the three lens weights read a FENCED value, not the bare gain+bias.
     * This is the assertion that would have failed before the fix: under real music the
     * unfenced chains ran NEGATIVE (warpc1 for 99.9% of one track), and a negative
     * displace weight inverts the lens instead of quieting it. The floor is the claim —
     * so it is asserted as a floor of exactly 0, not merely "a Limit exists".
     */
    for (const id of ["acap", "bcap", "ccap"]) {
      const fence = document.graph.nodes[id] as GraphNode;
      expect(fence.type, `${id} must fence its lens weight`).toBe("valueLimit");
      expect(fence.parameters["minimum"], `${id} must floor at zero`).toBe(0);
    }
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

/**
 * E33 Obol (T625/T624, T673, T716, T724) — a yin-yang medallion BECOMING goo and back, in
 * an ambient studio, and the first example to switch on the render's ambient occlusion.
 *
 * THE SHAPE OF THE OBJECT, because every claim below depends on it. There are two systems:
 * 1728 instanced tiles, and a mass. The tiles are the whole of the medallion — nothing is
 * behind them, which is T716. The mass is the organic blob, which is the gimmick, and it
 * GROWS from a speck into the field's own size as the morph runs, so the tiles land on a
 * surface that materialises under them. T716 read the owner's note as "the mass must go"
 * and made the goo end a blob built of cubes; T724 corrected that to "the mass must go AT
 * THE EMBLEM END".
 *
 * The claims its `.md` makes that a look pass could not hold onto.
 */
describe("E33 Obol claims", () => {
  const { document, plan } = example("E33-Obol.loom.json");
  const passes = plan.passes as ReadonlyArray<{ id: string; shader?: string; textures?: ReadonlyArray<{ binding: string }> }>;
  const tiles = () => String((document.graph.nodes["segs"] as GraphNode).parameters["kernel"]);
  const mass = () => String((document.graph.nodes["morph"] as GraphNode).parameters["kernel"]);

  /**
   * BECOMING, NOT CROSS-FADING. The claim is structural, not aesthetic: ONE kernel holds
   * BOTH configurations and mixes them per element by a locally-computed amount. A
   * cross-fade would be two renders and a blend node, and it would look like two pictures
   * at 50%. The mix and the per-element front are what make it one object.
   */
  it("blends two configurations inside one kernel, by a per-element front", () => {
    const kernel = tiles();
    expect(kernel).toContain("q.position = obolYaw(mix(emblem, goo, melt) + lift, ctx.absTime);");
    // And a yaw on the ABSOLUTE clock, so the piece is not a still frame wherever the
    // value graph is idle — which is exactly what the cook oracle renders. The claim is in
    // two halves: the helper HOLDS the sway, and the caller HANDS IT the absolute clock.
    // Asserting only the first would pass with the timeline clock wired in, which is the
    // exact bug §V437 is about.
    expect(kernel).toContain("let yaw = 0.21 * sin(t * 0.185);");
    expect(kernel).toContain("obolYaw(mix(emblem, goo, melt) + lift, ctx.absTime)");
    // The front is spatial: it is built from `order`, and `order` is built from the
    // emblem's own dividing curve. A `melt` that read only ctx.value1 would be a
    // cross-fade wearing a kernel.
    expect(kernel).toMatch(/front = clamp\(drive \* [\d.]+ - order \* [\d.]+/);
    expect(kernel).toContain("let arcTop = distance(d, vec2f(0.0, 0.5)) - 0.5;");
    // Both halves of the spike fix (see the .md): the cap, and the radius blend.
    expect(kernel).toMatch(
      /clamp\(min\(abs\(arcTop\), abs\(arcBot\)\) \/ [\d.]+, 0\.0, 1\.0\) \* [\d.]+ \+ length\(d\) \* [\d.]+/,
    );
    // The colour is read in the emblem's own DISC coordinate, never in the deformed
    // position — a tint read from `q.position` slides over the goo like a projection.
    expect(kernel).toContain("let tone = taiji(disc);");
  });

  /**
   * T673 — THE GOO IS LOBED BY CONSTRUCTION, and this is a claim about the SILHOUETTE.
   * High-frequency displacement changes surface texture and leaves the outline circular,
   * so "it is not a sphere" cannot be pinned by asserting that noise exists. What can be
   * pinned is the low-frequency term that moves the outline: a metaball with three offset
   * charges. Re-measured at T716 on the object that now exists — the TILE CLOUD, because
   * the mass whose surface T673 measured is deleted: radius CV vs angle 0.224, convexity
   * deficit 0.0795, over 12 orbit angles x 5 moments (bc681b7).
   *
   * The CORE charge is asserted separately because losing it does not look like losing a
   * feature — it tears the mesh. Without it the three lobes separate, a ray from the
   * origin misses the field entirely, and `gooRadius` falls to its 0.10 floor for whole
   * regions of the sphere.
   */
  it("builds the goo from a metaball with a core, and solves it from the outside in", () => {
    const kernel = tiles();
    expect(kernel).toContain("fn gooField(p: vec3f, t: f32) -> f32");
    // Three offset charges, and the core that keeps the form star-shaped about the origin.
    expect(kernel).toMatch(/var weights = array<f32, 3>\(/);
    expect(kernel).toMatch(/var f = [\d.]+ \/ max\(dot\(p, p\), 1e-5\);/);
    // OUTERMOST crossing, scanned inward. A bracketed bisection converges on whichever
    // crossing it traps, and a ray through three charges can cross three times — so
    // neighbouring directions land on different crossings and the surface cracks.
    expect(kernel).toContain("fn gooRadius(s: vec3f, t: f32) -> f32");
    expect(kernel).toContain("let r = top - f32(i) * step;");
  });

  /**
   * T716/T724 — THE TILE MAP IS INVERTIBLE, AND EVERY TILE KEEPS ITS STATION.
   *
   * The tiles walk a Fibonacci lattice on the disc (`rr = sqrt(u)`, `ang = i * 137.5deg`)
   * and the Fibonacci SPHERE is that same sequence read with `z = 1 - 2u`. Three things
   * fall out and all three are asserted, because each one alone passes a broken build:
   *
   *   - the two poses are built from ONE `u` and ONE `ang`, so a tile keeps its azimuth
   *     and can be FOLLOWED across the morph rather than re-dealt;
   *   - the mass INVERTS that map — it recovers the disc station of the tile arriving
   *     along its own direction `s` — so the skin appears under a tile at the moment the
   *     tile reaches it rather than on a schedule of its own (T724, the fuse);
   *   - and both kernels therefore read the SAME `meltOrder`, from the same shared text.
   *
   * §V681 is why this is a document claim and not a look pass: de-correlate the sphere
   * direction from the disc station and the still frame is PIXEL-IDENTICAL at both ends —
   * the tiles occupy the same set of positions, just not the same tiles — while every
   * cube is re-dealt in motion and the skin materialises where nothing is landing.
   */
  it("keeps the tile map invertible, so the mass can grow on the arriving tile's clock", () => {
    // THE FORWARD MAP: one `u`, one `ang`, both poses.
    const kernel = tiles();
    expect(kernel).toContain("let u = (f32(ctx.index) + 0.5) / n;");
    expect(kernel).toContain("let ang = f32(ctx.index) * 2.39996323;");
    expect(kernel).toContain("let rr = sqrt(u) * 0.930;");
    expect(kernel).toContain("let zc = 1.0 - 2.0 * u;");
    expect(kernel).toContain("let sdir = vec3f(ring * cos(ang), ring * sin(ang), zc);");

    // THE INVERSE, in the mass: z = 1 - 2u inverts to u = (1 - z)/2, and the disc radius
    // is 0.930*sqrt(u). The azimuth is carried across as the direction of s.xy. Get this
    // wrong and the surface still renders perfectly — it just grows somewhere else.
    const body = mass();
    expect(body).toContain("let station = dir2 * (0.930 * sqrt(max(0.0, (1.0 - s.z) * 0.5)));");
    expect(body).toContain("let order = meltOrder(station);");
    // The pole has no azimuth. Falling back to the disc CENTRE there would make it grow
    // first while everything around it grows last, which stands a spike on the mesh —
    // the same failure T673 paid for with the emblem's dots.
    expect(body).toMatch(/dir2 = select\(vec2f\(1\.0, 0\.0\), ax \/ max\(axLen, 1e-6\), axLen > 1e-4\)/);

    // ONE CLOCK for both systems, so the wave that lifts a tile is the wave that grows the
    // skin under it. A second channel here is two events that happen to look like one.
    const channel = (id: string, slot: string) =>
      ((document.graph.nodes[id] as GraphNode).parameters[slot] as { bindings?: { driven?: { channel?: string } } })
        ?.bindings?.driven?.channel;
    expect(channel("segs", "value1")).toBe("tide1");
    expect(channel("morph", "value1")).toBe("tide1");
    expect(channel("segs", "value2")).toBe("sheen1");
    expect(channel("morph", "value2")).toBe("sheen1");
    expect(kernel).toContain("return smoothstep(0.18, 0.82, v);");
    expect(body).toContain("return smoothstep(0.18, 0.82, v);");
  });

  /**
   * T673, restored at T724 — ONE definition of the emblem's field, read by TWO systems
   * (§V471.1/.2). This claim was retired at T716 for pinning nothing: the mass was gone,
   * there was no second kernel, and a claim with no second reader is worse than no claim.
   * T724 gives it a harder job than it had. The mass must now GROW under an arriving tile
   * at the moment that tile lands, so the two kernels have to agree about the tile's
   * station, its order in the wave AND where the goo's surface is. Two copies of that
   * arithmetic is two chances for the skin to materialise where the tiles are not — and
   * that drift would be a look bug with no failing test anywhere.
   */
  it("shares one prelude between the mass and the tiles, byte for byte", () => {
    const body = mass();
    const kernel = tiles();
    for (const shared of ["fn meltOrder(d: vec2f) -> f32", "fn gooAt(", "fn emblemTilt(", "fn meltDrive("]) {
      expect(body, `the mass is missing ${shared}`).toContain(shared);
      expect(kernel, `the tiles are missing ${shared}`).toContain(shared);
    }
    // Byte-identical, not merely both-present: a prelude edited in one place is exactly
    // the drift this claim exists to catch. Sliced at the LAST shared function rather
    // than at `fn process`, because the tiles declare one helper of their own between the
    // two (`segRand`, which the mass has no use for).
    const preludeOf = (source: string) => source.slice(0, source.indexOf("fn meltDrive("));
    expect(preludeOf(kernel)).toBe(preludeOf(body));
  });

  /**
   * T716 — THE MOSAIC COVERS THE FACE WITHOUT CLOSING INTO A DISC, and both bounds are
   * the point. With no bed behind them the tiles ARE the medallion, so the ratio of a
   * tile's edge to the lattice's own pitch is what decides whether the emblem reads as a
   * mosaic, as confetti, or as the solid disc the owner asked us to delete.
   *
   * A phyllotaxis lattice of N tiles over a face of radius 0.930 * 0.955 has a hexagonal
   * nearest-neighbour spacing of 1.0746 * sqrt(pi * r^2 / N). Shipped: 1728 tiles, pitch
   * 0.0407, tile edge 2 * 0.019 = 0.038, ratio 0.934. Past ~1.15 the tiles interpenetrate
   * and the face fuses; below ~0.6 there is more room than tile. Neither failure has a
   * red test anywhere else — both render a perfectly plausible picture.
   */
  it("keeps the tile edge inside the band where the mosaic reads", () => {
    const grid = (document.graph.nodes["segPts"] as GraphNode).parameters;
    const count = (grid["cols"] as number) * (grid["rows"] as number);
    expect(count).toBe(grid["count"] as number);
    expect((document.graph.nodes["segs"] as GraphNode).parameters["capacity"]).toBe(count);
    const faceRadius = 0.930 * 0.955;
    const pitch = 1.0746 * Math.sqrt((Math.PI * faceRadius * faceRadius) / count);
    const edge = 2 * ((document.graph.nodes["shards"] as GraphNode).parameters["scale"] as number);
    const ratio = edge / pitch;
    expect(ratio).toBeGreaterThan(0.6);
    expect(ratio).toBeLessThan(1.15);
  });

  /**
   * T673/T716, §V617 — THE TILES ARE MATTER, so they block light. An unlit geometry casts
   * no shadow in any draw mode, because a surface that ignores light cannot stop it. This
   * was worth having when the tiles sat on a bed; after T716 it is LOAD-BEARING, because
   * self-shadowing is the only thing left giving the object a body. Measured with nothing
   * else in the scene so nothing else could be casting: 22,016 pixels of the emblem frame
   * and 11,710 of the goo frame darken when the key's shadow is switched on, and BOTH go
   * to exactly 0 when the material is swapped for one that ignores light. At the goo end
   * the tiles are buried just under the skin, so the number that matters there is the
   * FULL scene's: 35,820 pixels at f484 (0592b2e).
   */
  it("draws the tiles as lit instances, so they cast and occlude", () => {
    const shards = document.graph.nodes["shards"] as GraphNode;
    expect(shards.type).toBe("geometry");
    expect(shards.parameters["mode"]).toBe("instances");
    // The material is the LIT one. `materialUnlit` here would keep the picture and
    // silently drop every shadow and every contact.
    expect(shards.parameters["material"]).toBe("oil1");
    expect((document.graph.nodes["oil"] as GraphNode).type).toBe("materialPhong");
    // The depth sweep therefore takes them: one shadow draw per casting light per
    // geometry, and the tiles' is present.
    const shadowDraws = passes.filter((pass) => pass.id.includes(":shadow:"));
    expect(shadowDraws.length).toBeGreaterThanOrEqual(3);
  });

  /**
   * §V437: AO is ONE switch on the render, and it reaches EVERY geometry that render
   * names. Asserted over both of them, because a per-geometry opt-in passes a
   * one-geometry check perfectly.
   */
  it("switches ambient occlusion on once and every geometry wears it", () => {
    expect(document.graph.nodes["shot"]?.parameters["ambientOcclusion"]).toBe(true);
    const lit = passes.filter((pass) => pass.id.includes(":scene:"));
    // THREE again since T724: the cyclorama, the mass and the instanced tiles. The count
    // is asserted rather than the set iterated blindly, because a per-geometry opt-in
    // passes a one-geometry check perfectly — and because the third one is an INSTANCED
    // draw, which is a different generator with its own copy of the AO block (T624 gates
    // it on `model !== "unlit"`, so an unlit mosaic would bind no occlusion map at all).
    expect(lit).toHaveLength(3);
    for (const pass of lit) {
      expect(pass.shader).toContain("let occlusion = textureLoad(occlusionMap");
      expect((pass.textures ?? []).map((texture) => texture.binding)).toContain("occlusionMap");
    }
    // And the three passes that produce the map run before anything reads it.
    const ids = passes.map((pass) => pass.id);
    const at = (needle: string) => ids.findIndex((id) => id.includes(needle));
    expect(at("ao:resolve")).toBeGreaterThan(at("ao:depth:clear"));
    expect(at("ao:blur")).toBeGreaterThan(at("ao:resolve"));
    expect(at("scene:0")).toBeGreaterThan(at("ao:blur"));
  });

  /**
   * §V510, which this file paid for a second time: a Level's black point is a
   * SUBTRACTION, and `add` is front + back. Without the clamp between the threshold
   * and the blur, the bloom subtracts a large negative constant from the whole frame
   * and the picture comes back black with a blown object in it — with every wire
   * correct. The clamp is the node, and its floor has to be zero.
   */
  it("clamps the bloom threshold before it is blurred and added back", () => {
    const clip = document.graph.nodes["clip"] as GraphNode;
    expect(clip.type).toBe("limit");
    expect(clip.parameters["mode"]).toBe("clamp");
    expect(clip.parameters["low"]).toBe(0);
    const edges = Object.values(document.graph.edges);
    const into = (nodeId: string) => edges.filter((edge) => edge.target.nodeId === nodeId).map((edge) => edge.source.nodeId);
    expect(into("clip")).toEqual(["cut"]);
    expect(into("halo")).toEqual(["clip"]);
  });

  /**
   * The studio's gradient is a POINT light and nothing else. Directional lights do not
   * attenuate, so a backdrop lit only by them is one flat grey — which is what the
   * first build looked like. This pins the one light whose falloff makes the pool.
   */
  it("lights the cyclorama with a falling-off point light", () => {
    expect(document.graph.nodes["crown"]?.parameters["kind"]).toBe("point");
    expect(document.graph.nodes["key"]?.parameters["kind"]).toBe("directional");
    expect(document.graph.nodes["fill"]?.parameters["kind"]).toBe("directional");
  });
});

/**
 * E34 Lidar (T672) — three claims about the round-three rework, and all three are here
 * for the same reason: each one fails INVISIBLY IN A STILL FRAME. A still says nothing
 * about whether the echoes scintillate; a beam whose taper has been lost still draws
 * beams; a light pool that has lost its identity offset still lights the ground where it
 * shines. Every one of them is a look bug with no failing test anywhere unless it is
 * pinned deliberately.
 */
describe("E34 Lidar claims", () => {
  const { document, plan } = example("E34-Lidar.loom.json");
  const nodes = document.graph.nodes as Record<string, GraphNode>;
  /**
   * A scene draw belongs to the RENDER node, not to the geometry — `shot1` emits one
   * `shot:scene:N` pass per name in its Scenes list, in list order. So the lookup goes
   * through that list, which makes "the beams are actually in the render" part of the
   * claim rather than a separate hope.
   */
  const scenes = String(nodes["shot"]?.parameters["scenes"]).split(/\s+/);
  const sceneDraw = (label: string) => {
    const index = scenes.indexOf(label);
    expect(index, `${label} is not in shot1's Scenes list`).toBeGreaterThanOrEqual(0);
    const pass = plan.passes.find((entry) => entry.kind === "draw" && entry.id.endsWith(`:scene:${String(index)}`));
    if (pass === undefined || pass.kind !== "draw") throw new Error(`no scene draw for ${label}`);
    return pass;
  };

  /**
   * THE BEAMS, AND THE TWO KNOBS THAT KEEP THEM READABLE (T680).
   *
   * `taper` is asserted at 0 because losing it does not look like losing a feature: 24
   * beams that all leave the SAME origin fuse into a solid wedge at the mast whatever
   * their number, and the picture still contains beams. `spoke` is asserted for the
   * mirror reason — with no predicate all 240 are drawn, and 240 fuse into an opaque
   * cone that hides the terrain entirely.
   *
   * The endpoint binding is the claim that this costs NO SECOND MARCH: the far end is
   * `cast1`'s own `hitPosition` pair, handed to the draw, not a re-cast.
   */
  it("draws one ray in ten as a beam off the cast's own hit, tapered to a point", () => {
    expect(nodes["rays"]?.parameters["mode"]).toBe("beam");
    expect(nodes["rays"]?.parameters["endpoint"]).toBe("hitPosition");
    expect(nodes["rays"]?.parameters["group"]).toBe("p.spoke > 0.5");
    expect(nodes["aim"]?.parameters["kernel"]).toContain("q.spoke = select(0.0, 1.0, (ctx.index % 10u) == 0u);");
    const rays = sceneDraw("rays1");
    // Six vertices an instance — the billboard branch with the axis handed in.
    expect(rays.vertexCount).toBe(6);
    // The far end arrives as a BUFFER, which is the whole "no extra ray march" claim.
    const bindings = (rays.buffers ?? []).map((buffer) => buffer.binding);
    expect(bindings).toContain("endpoints");
    // The predicate costs one storage buffer, and it is the `spoke` pair (§V588).
    expect(bindings).toContain("group_spoke");
    // instance = [scale, shapeCode, TAPER, 0]. Taper 0 pinches the shared origin to a
    // point; anything above it fuses the apex into a wedge.
    const instance = (rays.uniforms as Record<string, readonly number[]>)["instance"] ?? [];
    expect(instance[0]).toBeCloseTo(0.013, 6);
    expect(instance[2]).toBe(0);
  });

  /**
   * SAMPLE AND HOLD (T681/§V638), and this is the claim a still frame cannot make.
   *
   * The second leg's landing point is a chaotic function of azimuth, so a marker that
   * adopts a new hit on EVERY qualifying frame re-locates metres away while lit — which
   * is the scintillation, and it is invisible in any single frame. The fix is one
   * condition: re-read only while already dark. Both halves are pinned, because gating
   * only the LEVEL while the POSITION still tracks every hit restores the whole bug.
   */
  it("re-reads mark2a's echo only while it is already dark", () => {
    const kernel = String(nodes["mark2"]?.parameters["kernel"]);
    expect(kernel).toContain("let take = landed && p.wake.w < 0.06;");
    // the POSITION holds on `take`, not on `landed` — this is the half that teleports.
    expect(kernel).toContain("let pos = select(p.wake.xyz, p.hitPosition, take);");
    expect(kernel).toContain("let level = select(p.wake.w * 0.94, 1.0, take);");
  });

  /**
   * §V644 — THE IDENTITY ELEMENT IN A MULTIPLYING SLOT.
   *
   * An albedo map multiplies, so the pool must read 1.0 where nothing is lit. `poolbase1`
   * is a Level with black at −0.1 and white at 0, which is how you say ADD ONE: out =
   * 10·in + 1. Drop the offset and the ground goes BLACK everywhere the pool is not — a
   * failure that reads as "the light broke the terrain" and is really a missing identity.
   * The mapping claim rides along: the pool parks its sprites at the SAME clip
   * (X/extent, −Z/extent) `unfold1` uses, and if those two ever disagree the pool lights
   * the terrain's mirror image, which is plausible at a glance and wrong everywhere.
   */
  it("feeds the terrain's albedo a pool offset to 1.0 where it is unlit", () => {
    expect(nodes["poolbase"]?.type).toBe("level");
    expect(nodes["poolbase"]?.parameters["blacklevel"]).toBe(-0.1);
    expect(nodes["poolbase"]?.parameters["whitelevel"]).toBe(0);
    const wired = Object.values(document.graph.edges).some(
      (edge) => edge.source.nodeId === "poolbase" && edge.target.nodeId === "basalt" && edge.target.portId === "albedo",
    );
    expect(wired, "the pool must reach the terrain material's albedo").toBe(true);
    // One agreement, stated twice: the sheet and the pool park at the same clip xy.
    expect(String(nodes["unfold"]?.parameters["kernel"])).toContain("q.position = vec3f(worldX / 4.8, -worldZ / 4.8, 0.0);");
    expect(String(nodes["pool"]?.parameters["kernel"])).toContain("q.position = vec3f(p.position.x / 4.8, -p.position.z / 4.8, 0.0);");
    // and the terrain draw actually SAMPLES an albedo map, rather than the wire hanging.
    expect(sceneDraw("ground1").textures?.map((texture) => texture.binding) ?? []).toContain("albedoMap");
    // and the pool's own splat is a real renderPoints draw, selecting on the return class.
    const splat = plan.passes.find((entry) => entry.kind === "draw" && entry.nodeId === "poolmap");
    expect(splat, "poolmap1 must emit a sprite draw").toBeDefined();
    expect(nodes["poolmap"]?.parameters["blend"]).toBe("additive");
  });

  /**
   * T711 — COLOUR COHERENCE, AND WHY IT NEEDS A TEST AT ALL.
   *
   * "A ray and the mark it produces share a colour" is a claim about a WIRE, not about a
   * pixel, and a still frame with the wire broken still contains beams: they simply go
   * back to being one flat colour that has nothing to do with what they hit. Both halves
   * are pinned, because either alone restores the old picture — the tint has to be MAPPED
   * (a static tint is the flat colour again) and the material has to be the IDENTITY
   * (a coloured material multiplies the per-ray colour back into one hue).
   */
  it("gives every beam its own impact colour, through a material that is the identity", () => {
    expect(nodes["haze"]?.parameters["color"]).toEqual([1, 1, 1, 1]);
    expect(nodes["mist"]?.parameters["color"]).toEqual([0.85, 0.85, 0.85, 1]);
    for (const id of ["rays", "bounce"]) {
      const tint = nodes[id]?.parameters["tint"] as ParameterSlot;
      expect(tint?.mode, `${id} must take its colour from the point, not a constant`).toBe("map");
      expect(tint?.bindings["map"]).toEqual({ kind: "map", attribute: "tint" });
    }
    // and the beams read the KERNEL that writes that colour, not the cast directly.
    const into = (nodeId: string) =>
      Object.values(document.graph.edges).filter((edge) => edge.target.nodeId === nodeId).map((edge) => edge.source.nodeId);
    expect(into("rays")).toEqual(["sight"]);
    expect(into("bounce")).toEqual(["mark2"]);
  });

  /**
   * T711 — A RAY WITH NO RETURN IS NOT DRAWN, and this is the claim a COUNT would pass
   * while the wrong rays were dropped. So the assertion names the CONDITION and the
   * COLLAPSE TARGET rather than a number of beams.
   *
   * The condition is `slant < RANGE - 0.01` and the epsilon is not incidental: it is
   * `mark1`'s own landed test, so the beam and the box it ends on change class on the
   * SAME frame. Move it to `mark2a`'s 0.02 and a ray whose slant sits between them draws
   * a beam to an impact that is already steel, which reads as a flicker and gets
   * misdiagnosed as a rendering fault. The collapse target is `p.position` — both ends on
   * one point is a zero-AREA beam — and it has to be that rather than a dim colour,
   * because a beam is OPAQUE scene geometry: a faded beam is a black ribbon over lit
   * terrain, not an absent one (§V668).
   */
  it("collapses a no-return beam to zero area on the same frame its impact goes steel", () => {
    const sight = String(nodes["sight"]?.parameters["kernel"]);
    const mark = String(nodes["mark"]?.parameters["kernel"]);
    expect(sight).toContain("q.hitPosition = select(p.position, p.hitPosition, slant < 3.9 - 0.01);");
    // the SAME frontier the impact uses, quoted from the other kernel so the two cannot drift.
    expect(mark).toContain("slant < 3.9 - 0.01");
    // and it is the beam's own endpoint attribute that carries the collapse.
    expect(nodes["rays"]?.parameters["endpoint"]).toBe("hitPosition");
  });

  /**
   * T711 — THE BOUNCE LEG INHERITS §V638's HOLD, which is the whole reason it is
   * affordable at all. T681 measured this segment off `rebound1`'s raw verdict and
   * rejected it; hung on `mark2a` it reads from a position that HOLDS and a level that
   * fades, and the same measurement passes. Both halves of the predicate are pinned:
   * `wake.w` is where the persistence comes from, `spoke` is the every-tenth subset, and
   * losing either restores a failure that still contains bounce beams — without the hold
   * they pop with the raw verdict (7.1% green hard-flip against the held 2.2%), without
   * the subset all 240 legs draw and the basin is green spaghetti.
   *
   * And the far end is the FIRST hit, published through mark2a's own leaf `hitPosition`
   * slot: four attributes is the whole budget (§V588), so a fifth pair is not available
   * and the segment has to travel through a slot that already exists.
   *
   * WHY THIS IS ASSERTED STRUCTURALLY RATHER THAN FROM PIXELS, and it is the reason the
   * shape of this test matters more than its strictness: the hold is a property ACROSS
   * FRAMES — a marker keeping its place while lit — and every still-frame instrument we
   * own is blind to it. Delete the gate and each individual frame still looks correct;
   * only the relationship between consecutive frames breaks. Measured, not assumed: all
   * three mutations of this claim (drop `wake.w`, drop `spoke`, drop mark2a's published
   * first hit) leave `liveness.test.ts` GREEN, and so do the seven others in this file's
   * E34 set — including "draw all 240 bounce legs", which is a visibly ruined frame. A
   * green look baseline means "about the same picture", never "this example is intact"
   * (§V653). So the assertion names the CONDITION, and the flicker numbers that justify
   * it were taken from frame PAIRS with the camera frozen, never from a still.
   */
  it("hangs the bounce leg on mark2a's hold, subset by the same spoke as the primaries", () => {
    expect(nodes["bounce"]?.parameters["mode"]).toBe("beam");
    expect(nodes["bounce"]?.parameters["group"]).toBe("p.wake.w > 0.03 && p.spoke > 0.5");
    expect(String(nodes["mark2"]?.parameters["kernel"])).toContain("q.hitPosition = p.position;");
    // mark2a stays at FOUR declared attributes — the budget is the reason for the line above.
    expect(JSON.parse(String(nodes["mark2"]?.parameters["attributes"]))).toHaveLength(4);
    const bounce = sceneDraw("bounce1");
    const bindings = (bounce.buffers ?? []).map((buffer) => buffer.binding);
    expect(bindings).toContain("endpoints");
    expect(bindings).toContain("group_wake");
    expect(bindings).toContain("group_spoke");
  });

  /**
   * T711 — THE TRAIL IS SELECTIVE AND THE LOOP IS BOUNDED, and neither shows in a still.
   *
   * The threshold's position is the tuning decision: the terrain, moonlit AND lit by its
   * own impact pool, tops out at linear luma 0.102, and softness 0.10 means the smoothstep
   * runs 0.11 … 0.21, so the transition's FOOT clears the brightest ground there is. Drop
   * the threshold under 0.10 and the whole hillside smears — a failure that still contains
   * a trail. The floor is asserted rather than the threshold alone, because it is the foot
   * and not the midpoint that decides whether the ground is in.
   *
   * §V631: steady state is injection ÷ (1 − persistence), so persistence must be BELOW 1
   * — at 1.0 the loop genuinely diverges — and the gain must be positive, or §V630's
   * sign-alternating oscillator is back. Both are decidable without rendering, which is
   * why they are asserted here rather than left to a look call.
   */
  it("thresholds the trail above the lit ground and closes the loop below unity", () => {
    expect(nodes["hot"]?.type).toBe("threshold");
    expect(nodes["hot"]?.parameters["channel"]).toBe("luminance");
    const threshold = Number(nodes["hot"]?.parameters["threshold"]);
    const softness = Number(nodes["hot"]?.parameters["softness"]);
    // the FOOT of the transition, against the measured 0.102 ceiling of the lit terrain.
    expect(threshold - softness / 2).toBeGreaterThan(0.102);
    const persistence = Number(nodes["trail"]?.parameters["persistence"]);
    expect(persistence).toBeGreaterThan(0);
    expect(persistence).toBeLessThan(1);
    expect(nodes["trail"]?.parameters["source"]).toBe("smear1");
    // The loop is SELECTIVE, so it closes on a side branch and not on the finished frame:
    // `smear1` feeds glow1's stack, and glow1 is what the output shows.
    const into = (nodeId: string) =>
      Object.values(document.graph.edges).filter((edge) => edge.target.nodeId === nodeId).map((edge) => edge.source.nodeId);
    expect(into("stain").sort()).toEqual(["hot", "shot"]);
    expect(into("smear").sort()).toEqual(["stain", "trail"]);
    expect(into("glow").sort()).toEqual(["halo", "shot", "smear"]);
    expect(into("out")).toEqual(["glow"]);
  });
});

describe("E14 Self-Regulating Bloom claims", () => {
  const { document } = example("E14-Self-Regulating-Bloom.loom.json");
  const nodes = document.graph.nodes as Record<string, GraphNode>;
  const edges = Object.values(document.graph.edges);
  const into = (nodeId: string) => edges.filter((edge) => edge.target.nodeId === nodeId).map((edge) => edge.source.nodeId);

  /**
   * THE LOOP IS CLOSED, STRUCTURALLY. §V144's image → parameter → image loop is the
   * whole reason this example exists (§V615), so the gate walks it: the analyze node
   * meters the FINISHED composite (not the raw field — metering the input would
   * regulate something the viewer never sees), channelIn reads that channel by name
   * (§V129), the error chain reaches the brightness slot, and the sign along the way
   * is NEGATIVE — a positive controller here is a photograph of a white frame.
   */
  it("closes analyze → channelIn → error chain → driven brightness, with negative sign", () => {
    // Sensor on the final add, the same node the output shows.
    expect(nodes["meter"]?.type).toBe("analyze");
    expect(nodes["meter"]?.label).toBe("meter1");
    expect(into("meter")).toEqual(["glow"]);
    expect(into("out")).toEqual(["glow"]);
    // The crossing reads it back by name.
    expect(nodes["probe"]?.type).toBe("channelIn");
    expect(nodes["probe"]?.parameters["channel"]).toBe("meter1");
    // The chain: probe → neg(×−1) → err(+target) → push(×K) → lift(+base) → clampg.
    expect(into("neg")).toEqual(["probe"]);
    expect(into("err")).toEqual(["neg"]);
    expect(into("push")).toEqual(["err"]);
    expect(into("lift")).toEqual(["push"]);
    expect(into("clampg")).toEqual(["lift"]);
    expect(nodes["neg"]?.parameters["operand"]).toBe(-1);
    expect(Number(nodes["push"]?.parameters["operand"])).toBeGreaterThan(0);
    // The actuator wears the SWITCH, and the switch ships closed: in1 is the chain,
    // in2 is the bare base, and the open branch equals `lift`'s operand exactly, so
    // flipping the index changes one thing — whether the measurement pushes back.
    expect(nodes["engage"]?.label).toBe("gain1");
    expect(nodes["engage"]?.parameters["index"]).toBe(0);
    expect(into("engage").sort()).toEqual(["clampg", "rest"]);
    expect(nodes["rest"]?.parameters["value"]).toBe(nodes["lift"]?.parameters["operand"]);
    const brightness = nodes["gain"]?.parameters["brightness"] as ParameterSlot;
    expect(brightness.mode).toBe("driven");
    expect(brightness.bindings["driven"]).toEqual({ kind: "driven", channel: "gain1" });
  });

  /**
   * THE WRAP IS THE TRAP. A ramp is periodic: a NEGATIVE phase wraps the background —
   * the mask's near-zero majority — into the palette's white top end. Measured while
   * building: phase −0.02 alone lifted the settled meter from 0.51 to 0.94, positive
   * feedback that saturated early builds to a white frame within five frames. The
   * clamp's floor is the safety, so its floor being POSITIVE is gated, not trusted.
   */
  it("clamps the palette phase strictly above the wrap", () => {
    expect(nodes["swirlclamp"]?.label).toBe("swirl1");
    expect(Number(nodes["swirlclamp"]?.parameters["minimum"])).toBeGreaterThan(0);
    const phase = nodes["palette"]?.parameters["phase"] as ParameterSlot;
    expect(phase.mode).toBe("driven");
    expect(phase.bindings["driven"]).toEqual({ kind: "driven", channel: "swirl1" });
    // The retained value sits inside the clamp's window too: a host without the
    // channel must not render the wrapped picture either (§V107).
    const retained = (phase.bindings["static"] as { value?: unknown }).value;
    expect(Number(retained)).toBeGreaterThan(0);
  });

  /**
   * §V510 twice over: BOTH signed pipelines are clamped before anything spreads or
   * adds them. `gain` and `cut` are Levels whose black points emit negatives into
   * rgba16float; without these two floors the halo subtracts itself from the frame.
   */
  it("pins both clamp floors at zero, in the right places", () => {
    for (const id of ["clipbase", "clip"]) {
      expect(nodes[id]?.type).toBe("limit");
      expect(nodes[id]?.parameters["mode"]).toBe("clamp");
      expect(nodes[id]?.parameters["low"]).toBe(0);
    }
    expect(into("cut")).toEqual(["clipbase"]);
    expect(into("halo")).toEqual(["clip"]);
    // The base branch of the add comes from the CLAMPED image, not the raw level.
    expect(into("glow").sort()).toEqual(["clipbase", "tint"]);
  });

  /**
   * FRAME 0 TELLS THE TRUTH ABOUT LATENCY. The resolver answers with the last
   * COMPLETED readback (§V144) and on frame 0 there is none, so channelIn answers its
   * fallback. That fallback is pinned EQUAL to the setpoint: the error reads zero and
   * frame 0 renders at exactly the base brightness — the opening ring the viewer sees
   * afterwards is the loop taking hold one frame late, displayed rather than hidden.
   */
  it("sets the fallback to the setpoint, so frame 0 is the base picture", () => {
    expect(nodes["probe"]?.parameters["fallback"]).toBe(nodes["err"]?.parameters["operand"]);
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════════════
 * T729 — E39 ROSETTE: the polar field is arithmetic, so it is asserted as arithmetic.
 * ═══════════════════════════════════════════════════════════════════════════════════
 *
 * §V688 says a polar warp is six existing nodes rather than a missing primitive, and the
 * three details that make it correct are all NUMBERS — an aspect divisor, a black level
 * derived from a radius, an extend mode. Every one of them can be wrong while the picture
 * stays a plausible mandala: an un-corrected aspect is an ellipse, a clamped radius is
 * dead corners, `repeat` instead of `mirror` is a stair-stepped seam. The look baseline
 * catches none of that at 192x108 (§V678), so it is claimed here or nowhere.
 */
describe("E39 Rosette claims", () => {
  const { document, plan } = example("E39-Rosette.loom.json");
  const nodes = document.graph.nodes as Record<string, GraphNode>;
  const edges = Object.values(document.graph.edges);
  const ASPECT = 1280 / 720;

  /**
   * The whole point of §V688: no node in this graph knows the word "polar". Remap is fed a
   * FIELD, and the field is two generators packed by a Reorder. If `source` and `map` were
   * swapped the file would still compile and still render something round.
   */
  it("builds the uv field from two generators and hands it to Remap as the MAP, not the source", () => {
    expect(nodes["field"]?.type).toBe("reorder");
    // Red carries theta (input 1), green carries rho (input 2). Reversed, the rings and
    // the rays trade places and the figure turns inside out.
    expect(nodes["field"]?.parameters["outr"]).toBe("in1r");
    expect(nodes["field"]?.parameters["outg"]).toBe("in2r");
    const into = (target: string, port: string): string | undefined =>
      edges.find((e) => e.target.nodeId === target && e.target.portId === port)?.source.nodeId;
    expect(into("field", "in1")).toBe("angfix");
    expect(into("field", "in2")).toBe("depth");
    expect(into("warp", "map")).toBe("field");
    expect(into("warp", "source")).toBe("pick");
  });

  /**
   * §V688's first trap. `ramp(circular)` computes atan2 in UV space, so on 16:9 the rays
   * come out elliptically spaced; sampling the ramp through a transform scaled by 1/aspect
   * is exactly atan2(dv, du * aspect), the angle in PIXEL space. `aspectcorrect` must be
   * OFF or the transform re-introduces the very squash it is here to remove.
   */
  it("corrects the circular ramp's aspect by sampling it through a 1/aspect transform", () => {
    expect(nodes["ang"]?.parameters["type"]).toBe("circular");
    const scale = nodes["angfix"]?.parameters["s"] as readonly number[];
    expect(scale[0]).toBeCloseTo(1 / ASPECT, 10);
    expect(scale[1]).toBe(1);
    expect(nodes["angfix"]?.parameters["aspectcorrect"]).toBe(false);
    expect(nodes["angfix"]?.parameters["r"]).toBe(0);
  });

  /**
   * §V688's second trap, and the reason rho does not come from `ramp(radial)`: that node
   * is `clamp(length(uv - 0.5) * 2, 0, 1)`, so the corners pin flat. Circle's distance mode
   * emits `k * (rNorm - 1)` with `k = min(radius.x/aspect, radius.y)`, so the Level that
   * recovers normalised radius has EXACTLY one correct black level (§V147 — derived, not
   * toleranced). Any other value silently rescales the whole radial axis.
   */
  it("recovers unclamped radius with the black level Circle's own geometry implies", () => {
    expect(nodes["rad"]?.type).toBe("circle");
    expect(nodes["rad"]?.parameters["mode"]).toBe("distance");
    const radius = nodes["rad"]?.parameters["radius"] as readonly number[];
    const k = Math.min((radius[0] ?? 0) / ASPECT, radius[1] ?? 0);
    expect(nodes["depth"]?.parameters["blacklevel"]).toBeCloseTo(-k, 10);
    expect(nodes["depth"]?.parameters["whitelevel"]).toBe(0);
  });

  /**
   * §V688's third trap. Rho runs past 1 toward the corners; `repeat` FRACTS it, which is a
   * discontinuity and renders as a stair-stepped arc. Mirror folds, which is continuous.
   * That rho can exceed 1 at all needs the float working format.
   */
  it("folds the radial wrap instead of cutting it, in a format that can carry rho past 1", () => {
    expect(nodes["warp"]?.parameters["extend"]).toBe("mirror");
    expect(document.settings.workingFormat).toBe("rgba16float");
  });

  /**
   * §V694, as a gate rather than as a paragraph. A positive black level is a SUBTRACTION
   * and nothing clamps it in float, so the bloom that reads "keep only the highlights"
   * sends every darker pixel negative and the Add composite that consumes it comes out
   * DARKER than its other input. `haze1` must threshold with gamma, which cannot cross zero.
   */
  it("thresholds the bloom with gamma and never with a black level", () => {
    expect(nodes["haze"]?.parameters["blacklevel"]).toBe(0);
    expect(nodes["haze"]?.parameters["gamma1"] as number).toBeLessThan(1);
  });

  /**
   * §V411/§V363 and E27's exact argument: the Switch SELECTS a branch, it does not prune
   * the other, so `movieFileIn` is compiled while the understudy plays. The order is
   * load-bearing and it is asserted the way E27 asserts it — by also showing that the ids
   * would have sorted the OTHER way, so a dropped `order` would open on the video branch.
   */
  it("opens on the understudy by DECLARED order, not by how the ids happen to sort", () => {
    const inputs = edges
      .filter((e) => e.target.nodeId === "pick" && e.target.portId === "inputs")
      .map((e) => ({ from: e.source.nodeId, order: e.order }));
    expect(inputs.find((e) => e.from === "stand")?.order).toBe(0);
    expect(inputs.find((e) => e.from === "clip")?.order).toBe(1);
    expect(nodes["pick"]?.parameters["index"]).toBe(0);
    // "clip" sorts before "stand", so id order would have played the black video branch.
    expect(["stand", "clip"].slice().sort()[0]).toBe("clip");
    // And the node is genuinely in the plan, which is the gate B39 escaped.
    expect(plan.passes.some((pass) => "nodeId" in pass && pass.nodeId === "clip")).toBe(true);
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════════════
 * T729 — E40 WAKE: a file whose subject is CHANGE, claimed the way §V681 requires.
 * ═══════════════════════════════════════════════════════════════════════════════════
 *
 * Every property worth having here is a statement about the relationship BETWEEN frames —
 * that the difference is taken against a delayed frame, that only motion enters the loop,
 * that the grade happens after the accumulation. A single rendered frame is evidence about
 * a moment and not about a motion, so these are structural by necessity rather than by
 * preference.
 */
describe("E40 Wake claims", () => {
  const { document, plan } = example("E40-Wake.loom.json");
  const nodes = document.graph.nodes as Record<string, GraphNode>;
  const edges = Object.values(document.graph.edges);
  const into = (target: string, port: string): string | undefined =>
    edges.find((e) => e.target.nodeId === target && e.target.portId === port)?.source.nodeId;

  /**
   * THE claim of the example. `moved1` must difference the live frame against the CACHED
   * one; wire both inputs to the same source and it is identically zero everywhere, the
   * wake never appears, and nothing in a still frame distinguishes that from a quiet moment.
   */
  it("differences the live frame against a DELAYED one, not against itself", () => {
    expect(nodes["moved"]?.type).toBe("difference");
    expect(into("moved", "in1")).toBe("pick");
    expect(into("moved", "in2")).toBe("past");
    expect(nodes["past"]?.type).toBe("cache");
    expect(into("past", "input")).toBe("pick");
    // A ring of N holds N-1 readable frames; asking deeper is CLAMPED with a warning, and
    // the runner asserts zero diagnostics, so the tap has to fit the ring it was given.
    const frames = nodes["past"]?.parameters["frames"] as number;
    const index = nodes["past"]?.parameters["index"] as number;
    expect(index).toBeGreaterThan(1);
    expect(index).toBeLessThanOrEqual(frames - 1);
  });

  /**
   * Grading BEFORE the accumulator makes the loop sum coloured light: the head pins white
   * and the tail carries no hue. Grading after it makes the palette a map of trail AGE.
   * So the loop closes UPSTREAM of the Lookup, which inverts §V471.5 for E34's reason —
   * a loop closing on the finished frame would smear the still bed along with the wake.
   */
  it("accumulates raw motion and grades what comes OUT, so the palette axis is age", () => {
    expect(sourceReferenceName(nodes["loop"]?.type ?? "", nodes["loop"]?.parameters ?? {})).toBe("born1");
    expect(into("born", "in2")).toBe("loop");
    // born -> paint, and emphatically not paint -> born.
    expect(into("paint", "source")).toBe("born");
    expect(edges.some((e) => e.source.nodeId === "paint" && e.target.nodeId === "born")).toBe(false);
    // The graded result reaches the output; the loop's own contents never do directly.
    expect(into("lay", "in2")).toBe("paint");
    // The still bed is laid in BELOW the wake and is not inside the loop.
    expect(into("lay", "in1")).toBe("under");
    expect(into("under", "input")).toBe("pick");
  });

  /**
   * §V694 turned into something a gate can see, and §V666 is why it is stated this widely.
   *
   * The first version of this claim walked only the nodes FEEDING the accumulator, which is
   * where the compounding argument lives. It went red on `gain1` and stayed GREEN on
   * `under1` — the instance that actually mattered, because `under1` sits DOWNSTREAM of the
   * loop and feeds `lay1` directly, so its negative reached the finished frame while
   * `gain1`'s was contained by the Lookup's clamp-by-indexing. A guard that catches the
   * harmless case and misses the harmful one is worse than none, so the property is stated
   * where it is actually true: in a float working format, a positive black level is a
   * SUBTRACTION, and this graph adds things together. Range is bought with `whitelevel`,
   * `brightness` and `gamma1`, all of which are non-negative on non-negative input.
   *
   * A NEGATIVE black level is fine and stays legal — that is a lift, not a subtraction, and
   * E34's `poolbase` uses one deliberately.
   */
  it("buys range without a single subtractive offset, anywhere in the graph", () => {
    const offenders = Object.entries(nodes)
      .filter(([, node]) => node.type === "level")
      .map(([id, node]) => ({ id, black: node.parameters["blacklevel"] }))
      .filter((entry) => typeof entry.black === "number" && entry.black > 0)
      .map((entry) => `${entry.id} subtracts ${String(entry.black)}`);
    expect(offenders).toEqual([]);
    // And the loop's decay is persistence itself, which cannot go negative by construction.
    const persistence = nodes["loop"]?.parameters["persistence"] as ParameterSlot | undefined;
    expect(persistence?.mode).toBe("driven");
  });

  /**
   * §V687: an example whose subject is change has NO null state that looks like anything.
   * The performer's own motion is load-bearing — this file rendered PURE BLACK when its
   * noise was a `perlin3d`, because `speed` advances the FOURTH dimension and a 3D noise
   * has none (T518). And the subject must be a moving OBJECT with an almost-still bed
   * behind it, or the detector sees motion everywhere and nothing stands out.
   */
  it("gives the understudy real motion, from a dimension that exists", () => {
    expect(nodes["bed"]?.parameters["type"]).toBe("perlin4d");
    expect(nodes["bed"]?.parameters["speed"] as number).toBeGreaterThan(0);
    // The subject moves on two free-running LFOs; the bed only simmers.
    const orb = nodes["orb"]?.parameters ?? {};
    for (const key of ["center.x", "center.y"]) {
      const slot = orb[key] as ParameterSlot | undefined;
      expect(slot?.mode, `orb1.${key} must be driven`).toBe("driven");
    }
    expect(nodes["bed"]?.parameters["speed"] as number).toBeLessThan(
      (nodes["pathx"]?.parameters["frequency"] as number) ?? 0,
    );
    expect(plan.passes.some((pass) => "nodeId" in pass && pass.nodeId === "clip")).toBe(true);
  });
});

describe("E36 Facade claims", () => {
  const { document, plan } = example("E36-Facade.loom.json");

  const recompile = (mutate: (graph: GraphDocument) => void): CompiledGraph => {
    const graph = structuredClone(document.graph) as GraphDocument;
    mutate(graph);
    const compiled = compileGraph({
      graph,
      settings: document.settings,
      registry: exampleRegistry(),
      capabilities: TIER_B_CAPABILITIES,
    });
    expect(messagesOf(compiled.diagnostics.filter((d) => d.severity === "error"))).toEqual([]);
    return compiled;
  };

  const litPass = (compiled: CompiledGraph, id: string): DrawPassDescriptor => {
    const pass = compiled.passes.find((entry) => entry.id === id);
    if (pass === undefined || pass.kind !== "draw") throw new Error(`no lit draw ${id}`);
    return pass;
  };

  /**
   * §V681 — THE OVERLAP IS A SUM, asserted as WIRING rather than as pixels.
   *
   * The blend zone's whole claim is superposition: two projectors landing on one wall
   * contribute independently and add. The Dawn gate (projector-render.gpu.test.ts)
   * already pins the ARITHMETIC exactly — 0.4 + 0.4 lands 0.8 to the byte — so what an
   * example claim must hold is the wiring above it: referencing BOTH projectors compiles
   * to exactly the union of referencing each alone. Slot 0 of the pair must carry
   * projL's matrix and brightness untouched by projR's presence, and slot 1 must carry
   * projR's exactly as it compiles solo. The failure this catches is structural — a
   * list-order bug, an index collision, one pose contaminating the other — which renders
   * a plausible blend zone that is not the sum of anything (§V712's family: a still
   * frame, and even the baseline, would read fine).
   */
  it("compiles the two-projector wall as the exact union of each projector alone", () => {
    const both = litPass(plan, "shot#shot:scene:0");
    const onlyLeft = litPass(
      recompile((graph) => {
        (graph.nodes["shot"]!.parameters as Record<string, unknown>)["projectors"] = "projL1";
      }),
      "shot#shot:scene:0",
    );
    const onlyRight = litPass(
      recompile((graph) => {
        (graph.nodes["shot"]!.parameters as Record<string, unknown>)["projectors"] = "projR1";
      }),
      "shot#shot:scene:0",
    );
    for (const field of ["Matrix", "Pos", "Color", "Meta"]) {
      expect(both.uniforms?.[`projector0${field}`], `projector0${field}`).toEqual(
        onlyLeft.uniforms?.[`projector0${field}`],
      );
      expect(both.uniforms?.[`projector1${field}`], `projector1${field}`).toEqual(
        onlyRight.uniforms?.[`projector0${field}`],
      );
    }
    // And each solo compile carries no phantom second slot.
    expect(litPass(recompile((graph) => {
      (graph.nodes["shot"]!.parameters as Record<string, unknown>)["projectors"] = "projL1";
    }), "shot#shot:scene:0").uniforms?.["projector1Matrix"]).toBeUndefined();
  });

  /**
   * §V681 — THE OCCLUSION TRACKS THE POSE, or it is a baked shadow.
   *
   * The cornice fingers are re-derived from the projector's pose every compile: the
   * depth sweep renders the scene from the projector's own frustum, and the lit read
   * compares through THE SAME matrix. Move the projector and both must move together —
   * a baked shadow (the depth matrix frozen while the lit matrix moves, or vice versa)
   * renders plausible fingers that stop corresponding to the throw, and no still frame
   * can tell (§V712/§V717: the baseline reads identically). So the claim is the
   * correspondence itself: after moving projL's eye in the DOCUMENT, the sweep's
   * lightViewProjection and the lit draw's projector0Matrix are equal to each other and
   * both differ from the shipped pose's matrix.
   */
  it("re-derives the occlusion sweep from the moved pose — depth and lit read one matrix", () => {
    const movedEye = [-1.1, 1.7, 6] as const;
    const moved = recompile((graph) => {
      (graph.nodes["projL"]!.parameters as Record<string, unknown>)["eye"] = [...movedEye];
    });
    const sweepOf = (compiled: CompiledGraph): ReadonlyArray<number> => {
      const pass = compiled.passes.find(
        (entry) => entry.kind === "draw" && entry.id.startsWith("shot#shot:projector:0:") && !entry.id.endsWith(":clear"),
      );
      if (pass === undefined || pass.kind !== "draw") throw new Error("no projector depth sweep");
      return pass.uniforms?.["lightViewProjection"] as ReadonlyArray<number>;
    };
    const shippedSweep = sweepOf(plan);
    const movedSweep = sweepOf(moved);
    const movedLit = litPass(moved, "shot#shot:scene:0").uniforms?.["projector0Matrix"] as ReadonlyArray<number>;

    // The pose moved, so the frustum moved — against the shipped matrix, not a constant.
    expect(movedSweep).not.toEqual(shippedSweep);
    // And the depth pass and the lit read share ONE derivation: element-for-element equal.
    expect(movedLit).toEqual(movedSweep);
    // The un-moved projector's slot is untouched by its neighbour's move.
    expect(litPass(moved, "shot#shot:scene:0").uniforms?.["projector1Matrix"]).toEqual(
      litPass(plan, "shot#shot:scene:0").uniforms?.["projector1Matrix"],
    );
  });
});
