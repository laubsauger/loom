import { describe, expect, it } from "vitest";
import type { GraphNode } from "../../domain/types/graph.ts";
import type { ParameterSlot } from "../../domain/types/parameters.ts";
import { example } from "./helpers.ts";

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
