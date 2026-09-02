import { describe, expect, it } from "vitest";
import type { GraphNode } from "../../domain/types/graph.ts";
import { example } from "./helpers.ts";

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
