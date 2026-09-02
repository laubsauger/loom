import { describe, expect, it } from "vitest";
import type { CompiledGraph } from "../../compiler/index.ts";
import type { GraphNode } from "../../domain/types/graph.ts";
import type { DrawPassDescriptor, EffectPassDescriptor } from "../../runtime/backend/plan.ts";
import { effectFor, example, outputFor, valueGraphRun } from "./helpers.ts";
import type { Pointer } from "./helpers.ts";

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
