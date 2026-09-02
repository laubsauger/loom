import { describe, expect, it } from "vitest";
import { SHADER_SOURCE_PARAMETER } from "../../domain/commands/apply-patch.ts";
import { REORDER_SOURCE_OPTIONS } from "../../nodes/definitions/color.ts";
import { CHANNEL_OPTIONS } from "../../nodes/definitions/parameter-readers.ts";
import { NOISE_TYPE_OPTIONS } from "../../nodes/shaders/noise.wgsl.ts";
import { CENTRE, effectFor, example, outputFor, valueGraphRun } from "./helpers.ts";

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
