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
    /* T918 added the WALL — an opaque backdrop draw in the same scene phase — so the beam
       draws are the ones reading the optics kernel's buffers, filtered by source. */
    const beams = sceneDraws(plan).filter((pass) =>
      buffersOf(pass).get("positions") === "scratch:optics:position",
    );
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
    expect([...tapers].sort((a, b) => a - b)).toEqual([0.02, 1]); // T941: the wedge pinches at the exit face

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
       glassB.w = the same environmentIntensity the render names (T940: 0.7, the dark room —
       gain did not move in the swap). */
    const surface = plan.passes.find(
      (pass): pass is DrawPassDescriptor =>
        pass.kind === "draw" && pass.id.includes(":glass:") && !pass.id.includes("pyramid"),
    ) as DrawPassDescriptor;
    const uniforms = uniformsOf(surface);
    expect(uniforms["glassA"]).toEqual([1.5, 0.04, 1.1, 0.03]); // T928: deeper body
    expect((uniforms["glassB"] as readonly number[])[3]).toBeCloseTo(0.7, 6);
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
  it("holds the aim STATIC with no pointer — the rest state is the shipped image (T915)", () => {
    // The owner: "static aside from user interaction". No LFO, no envelope: with a parked
    // cursor BOTH aim axes must read one value on EVERY frame. A never-moved pointer is
    // (0, 0) — near-normal incidence at the base of the face, the white-line/TIR card.
    const run = valueGraphRun(document);
    const parked: Pointer = { x: 0, y: 0, buttons: 0 };
    const aims = new Set<string>();
    for (let index = 0; index < 120; index += 1) {
      const { plan: live } = run.step(parked);
      const dispatch = live.passes.find((entry) => entry.kind === "dispatch" && entry.nodeId === "optics");
      const uniforms = (dispatch as { uniforms?: Record<string, number> }).uniforms ?? {};
      aims.add(`${Number(uniforms["value1"]).toFixed(6)}/${Number(uniforms["value3"]).toFixed(6)}`);
    }
    expect([...aims]).toEqual(["0.000000/0.000000"]);
  });

  /**
   * THE POINTER OWNS THE AIM, AND A PARKED CURSOR IS A PARKED BEAM (T915b).
   *
   * T857's envelope decayed: `hold1` rose while the cursor moved and fell when it
   * stopped, handing the aim back to a rest pose — the owner's "reset after a time".
   * It read as smoothing because it was a valueLag; it behaved as decay because its
   * input was a DERIVATIVE. The property that separates the two — and the one this gate
   * asserts, because it is the one an LFO audit can never catch — is: does the value
   * change when the input doesn't.
   *
   * So the gate is the owner's phrasing as a measurement: hold the pointer still at a
   * NON-DEFAULT position and the aim must not move, at all, for as long as we care to
   * watch. The velocity branch failed this within a second of its release constant; a
   * pure positional lag cannot fail it once settled.
   */
  it("keeps the aim exactly where the pointer left it — no decay, ever (T915b)", () => {
    const slotOf = (source: CompiledGraph, slot: string): number => {
      const dispatch = source.passes.find((entry) => entry.kind === "dispatch" && entry.nodeId === "optics");
      return ((dispatch as { uniforms?: Record<string, number> }).uniforms ?? {})[slot] as number;
    };

    // The shipped, unresolved plan: the slots' retained statics, both zero.
    expect(slotOf(plan, "value1")).toBe(0);
    expect(slotOf(plan, "value3")).toBe(0);

    // Move to a NON-DEFAULT aim and let the lag settle: both axes arrive AT the pointer —
    // x on value3 (the entry walk), y on value1 (the angle) — not near it, not biased
    // toward any rest.
    const run = valueGraphRun(document);
    const held: Pointer = { x: 0.7, y: 0.3, buttons: 0 };
    run.step({ x: 0, y: 0, buttons: 0 });
    const settled = run.hold(held, 240).plan;
    expect(slotOf(settled, "value3")).toBeCloseTo(0.7, 3);
    expect(slotOf(settled, "value1")).toBeCloseTo(0.3, 3);

    // THE GATE: five more seconds parked at that same position — the aim does not move
    // by a millionth. This is the assertion the velocity branch could never pass, and
    // the LFO audit never checked.
    const atSettle = { x: slotOf(settled, "value3"), y: slotOf(settled, "value1") };
    const later = run.hold(held, 300).plan;
    expect(slotOf(later, "value3")).toBeCloseTo(atSettle.x, 6);
    expect(slotOf(later, "value1")).toBeCloseTo(atSettle.y, 6);

    // And the lag is still a lag — partway there one frame after a jump, arrived after
    // ninety — so "no decay" was not bought by removing the smoothing.
    const shape = valueGraphRun(document);
    shape.hold({ x: 0, y: 0, buttons: 0 }, 60);
    const dragged: Pointer = { x: 1, y: 0.5, buttons: 0 };
    const oneFrame = slotOf(shape.step(dragged).plan, "value3");
    expect(oneFrame).toBeGreaterThan(0);
    expect(oneFrame).toBeLessThan(0.5);
    expect(slotOf(shape.hold(dragged, 90).plan, "value3")).toBeCloseTo(1, 3);
  });

  /**
   * THE BODY TILTS WITH THE SAME POINTER THAT AIMS THE BEAM (T928 — §T914 assessed this
   * as "zero gap" and it then went unbuilt; this gate is what keeps that from happening
   * silently again). form1's value1/value2 ride follow1 exactly as the optics' do: one
   * hand, two reads, both positional, both decay-free (T915b's property holds here by
   * construction — same lag, same axes).
   */
  it("swivels the body with the pointer, through the same lag as the aim (T928)", () => {
    const slotOf = (source: CompiledGraph, node: string, slot: string): number => {
      const dispatch = source.passes.find((entry) => entry.kind === "dispatch" && entry.nodeId === node);
      return ((dispatch as { uniforms?: Record<string, number> }).uniforms ?? {})[slot] as number;
    };
    const run = valueGraphRun(document);
    run.step({ x: 0, y: 0, buttons: 0 });
    const settled = run.hold({ x: 0.8, y: 0.25, buttons: 0 }, 240).plan;
    // T937: named tilt params. The cursor's share arrives AT the pointer (the T934 LFO
    // rides within its own +-0.05/0.03 amplitude of it) …
    expect(Math.abs(slotOf(settled, "form", "p_tiltYaw") - (0.8 * 0.44 - 0.1))).toBeLessThan(0.051);
    expect(Math.abs(slotOf(settled, "form", "p_tiltNod") - (0.25 * 0.22 - 0.05))).toBeLessThan(0.031);
    // … and the mesh and the TRACE wear the IDENTICAL pose — one expression pair, two
    // kernels, zero drift between the glass and the light (§V818 at the value level).
    expect(slotOf(settled, "form", "p_tiltYaw")).toBe(slotOf(settled, "optics", "p_tiltYaw"));
    expect(slotOf(settled, "form", "p_tiltNod")).toBe(slotOf(settled, "optics", "p_tiltNod"));
  });

  /**
   * T934 — THE DRIFT AND THE AIM ARE SEPARATE CHANNELS, and the T915b property survives
   * the body coming back to life. With the pointer PARKED: form1's drift slots genuinely
   * oscillate (the owner's passive movement — two sines at incommensurate frequencies,
   * a clock, not an RNG), while the aim does not move by a millionth. This is the gate
   * that keeps T934 from quietly undoing T915.
   */
  it("drifts the body on a clock while the parked aim holds still (T934)", () => {
    const slotOf = (source: CompiledGraph, node: string, slot: string): number => {
      const dispatch = source.passes.find((entry) => entry.kind === "dispatch" && entry.nodeId === node);
      return ((dispatch as { uniforms?: Record<string, number> }).uniforms ?? {})[slot] as number;
    };
    const run = valueGraphRun(document);
    const parked: Pointer = { x: 0.4, y: 0.35, buttons: 0 };
    run.hold(parked, 240); // settle the lag mid-frame, then watch
    const yaws = new Set<number>();
    const aims = new Set<string>();
    for (let index = 0; index < 300; index += 1) {
      const { plan: live } = run.step(parked);
      yaws.add(Number(slotOf(live, "form", "p_tiltYaw").toFixed(4)));
      aims.add(`${slotOf(live, "optics", "value1").toFixed(6)}/${slotOf(live, "optics", "value3").toFixed(6)}`);
    }
    // Five seconds of frames: the drift visited many distinct values …
    expect(yaws.size).toBeGreaterThan(20);
    // … and the aim visited exactly one.
    expect(aims.size).toBe(1);
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
    expect(kernel).toContain("let n = cauchyN(t, ctx.value2);");
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
    // T913: dense flint's real spread — the split-or-converge is Snell's, not a knob.
    expect(uniforms["value2"]).toBeCloseTo(0.03, 6);
    expect(kernelOf("optics")).toContain("ctx.value2");
    // Real crown glass is about a sixth of this, and the exaggeration is stated in the md.
    expect(uniforms["value2"]).toBeGreaterThan(0);
  });
});
