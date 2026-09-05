import { beforeAll, describe, expect, it } from "vitest";
import { pointStorageId } from "../nodes/definitions/point-storage.ts";
import { pointRegionSlice } from "../nodes/definitions/test-support.ts";

import type { GraphDocument } from "../domain/types/graph.ts";
import { nodeGpuHost, probeDawn } from "../runtime/backend/vgpu/node-gpu-host.ts";
import { toRgba8 } from "../runtime/export/image.ts";
import { BYTES_PER_PIXEL } from "../runtime/export/pixel-format.ts";
import { renderHeadless } from "../tests/headless/render-harness.ts";
import { listExamples } from "./catalogue.ts";
import { requireExample } from "./runner.ts";

/**
 * T1076: the DepthPoints component's point schema and capacity — the layout its `paint`
 * kernel allocates, and therefore the one a probe must slice by. Mirrored from
 * `starter-components.ts`; the byte-identity gate on the generated component keeps the
 * two honest.
 */
const DEPTH_POINT_SCHEMA = [
  { name: "position", type: "vec3f" as const },
  { name: "tint", type: "vec4f" as const },
  { name: "depthN", type: "f32" as const },
];
const DEPTH_POINT_CAPACITY = 36864;

/**
 * E47 HOLOGRAM — THE CLAIMS (T956, then T983/§T979).
 *
 * The v2 picture is two clouds split by ONE range: `zone1` keeps the subject's near
 * band of depthN, `wall1` keeps the backdrop instance's complement of the same range.
 * A screenshot cannot tell an exact partition from a plausible one, so the split is
 * asserted on the point buffers through the REAL flattened component plan — the
 * expectation for every slot DERIVED from the read-back inputs (§V147: no bands).
 *
 * The pixel claims keep the buffers honest about reaching the screen: cutting the wall
 * out of the render's scene list, or opening the subject's zone to keep everything,
 * must each change the picture — the "what differs if the edge were cut" bar, taken
 * literally.
 *
 * Everything runs on the shipped default switches (synthetic performer, understudy
 * depth), which is the point of the understudy: the claims are deterministic and no
 * model download is involved.
 */

function e47() {
  const file = listExamples().find((entry) => entry.fileName === "E47-Hologram.loom.json");
  if (file === undefined) throw new Error("E47-Hologram.loom.json is not shipped");
  return requireExample(file);
}

let dawnError: string | undefined;
beforeAll(async () => {
  dawnError = (await probeDawn()).error;
}, 60_000);

const SUBJECT_RANGE = [0, 0.13] as const;
const SIZE = { width: 320, height: 180 };

async function renderE47(options?: { mutate?: (graph: GraphDocument) => void; probe?: boolean }) {
  const { document, result } = e47();
  const graph = structuredClone(document.graph) as GraphDocument;
  options?.mutate?.(graph);
  return renderHeadless({
    host: nodeGpuHost(),
    graph,
    settings: { ...document.settings, outputResolution: SIZE },
    frames: 2,
    capture: [1],
    animate: true,
    components: result.components,
    // A mutant that unlists the wall PRUNES its branch, so probes only ride the
    // shipped graph — asking a pruned plan for holo2's buffers is a loud unknown.
    ...(options?.probe === false
      ? {}
      : {
          /* T1076: ONE probe per NODE — every attribute is a region of that node's
             packed buffer, sliced below by the schema the node declares. */
          probeBuffers: [
            pointStorageId("holo/paint"),
            pointStorageId("zone"),
            pointStorageId("holo2/paint"),
            pointStorageId("wall"),
          ],
        }),
  } as never);
}

const PARKED_Z = -1.0e6;

/** Per-slot: kept slots carry the input's own bytes, dropped ones the park spot. */
function assertSelection(
  positions: Float32Array,
  depthN: Float32Array,
  output: Float32Array,
  keep: (d: number) => boolean,
  who: string,
): { kept: number; dropped: number } {
  const slots = Math.floor(depthN.length);
  let kept = 0;
  let dropped = 0;
  for (let slot = 0; slot < slots; slot += 1) {
    const base = slot * 4; // vec3f strides at 16 bytes
    if (keep(depthN[slot]!)) {
      expect(output[base], `${who} slot ${slot} x`).toBe(positions[base]!);
      expect(output[base + 1], `${who} slot ${slot} y`).toBe(positions[base + 1]!);
      expect(output[base + 2], `${who} slot ${slot} z`).toBe(positions[base + 2]!);
      kept += 1;
    } else {
      expect(output[base + 2], `${who} slot ${slot} parked z`).toBe(PARKED_Z);
      dropped += 1;
    }
  }
  return { kept, dropped };
}

function rgba(frame: { width: number; height: number; format: string; bytes: Uint8Array }, space: string) {
  return toRgba8(
    {
      width: frame.width,
      height: frame.height,
      format: frame.format,
      bytes: frame.bytes,
      rowStride: frame.width * (BYTES_PER_PIXEL[frame.format as keyof typeof BYTES_PER_PIXEL] ?? 8),
    } as never,
    { space } as never,
  );
}

function differingPixels(a: Uint8ClampedArray | Uint8Array, b: Uint8ClampedArray | Uint8Array): number {
  let differ = 0;
  for (let at = 0; at < a.length; at += 4) {
    if (a[at] !== b[at] || a[at + 1] !== b[at + 1] || a[at + 2] !== b[at + 2]) differ += 1;
  }
  return differ;
}

describe("E47 Hologram — the zone and the wall (T983, §T979)", () => {
  it("one range, two instances: the subject keeps INSIDE it, the wall keeps OUTSIDE it, exactly", async () => {
    if (dawnError !== undefined) throw new Error(`Dawn unavailable: ${dawnError}`);
    const result = await renderE47();
    const buffers = (result as { buffers?: Record<string, ArrayBuffer> }).buffers ?? {};
    /* T1076: a probe is one node's packed buffer; the attribute is a region of it. The
       DepthPoints component's cloud declares position/tint/depthN, and a Range owns only
       the position it writes — so each slice needs the OWNING node's schema. */
    const raw = (id: string): ArrayBuffer => {
      const found = buffers[id];
      expect(found, `no probe for ${id}`).toBeDefined();
      return found!;
    };
    const cloud = (nodeId: string, attribute: string): Float32Array =>
      pointRegionSlice(raw(pointStorageId(nodeId)), DEPTH_POINT_SCHEMA, DEPTH_POINT_CAPACITY, attribute).floats;
    const ranged = (nodeId: string): Float32Array =>
      pointRegionSlice(
        raw(pointStorageId(nodeId)),
        [{ name: "position", type: "vec3f" }],
        DEPTH_POINT_CAPACITY,
        "position",
      ).floats;

    const [lo, hi] = SUBJECT_RANGE;
    // The subject's zone: EVERY slot of the flattened component's cloud, the
    // expectation derived from its own depthN — including carve's parked spares,
    // whose default depthN rides through the same rule rather than a special case.
    const subject = assertSelection(
      cloud("holo/paint", "position"),
      cloud("holo/paint", "depthN"),
      ranged("zone"),
      (d) => d >= lo && d <= hi,
      "subject",
    );
    // The wall keeps the COMPLEMENT of the same range on its own cloud (§T979: the
    // backdrop is everything outside the subject's slab — two instances, one operator).
    const wall = assertSelection(
      cloud("holo2/paint", "position"),
      cloud("holo2/paint", "depthN"),
      ranged("wall"),
      (d) => !(d >= lo && d <= hi),
      "wall",
    );
    // Both cuts must actually bite on the shipped understudy — an all-kept zone or an
    // all-parked wall would pass every per-slot line above while claiming nothing.
    expect(subject.kept).toBeGreaterThan(100);
    expect(subject.dropped).toBeGreaterThan(100);
    expect(wall.kept).toBeGreaterThan(100);
    expect(wall.dropped).toBeGreaterThan(100);
  }, 240_000);

  it("both clouds reach the screen: unlisting the wall or opening the zone changes the picture", async () => {
    if (dawnError !== undefined) throw new Error(`Dawn unavailable: ${dawnError}`);
    const shipped = await renderE47();
    const space = shipped.plan.outputs.find((output) => output.nodeId === "out")?.space ?? "linear";
    const shippedImage = rgba(shipped.frames[0]!, space);

    // Cut the wall's draw out of the scene list: §T979's layer must have been visible.
    const withoutWall = await renderE47({
      probe: false,
      mutate: (graph) => {
        const shot = graph.nodes["shot"]!;
        (shot.parameters as Record<string, unknown>)["scenes"] = "dots1";
      },
    });
    const wallPixels = differingPixels(shippedImage.data, rgba(withoutWall.frames[0]!, space).data);
    expect(wallPixels).toBeGreaterThan(500);

    /* Open the subject's zone to keep everything: the parked room must have been absent.
       B189 — AND THIS ONE HAS TO OPEN THE CUT TOO, for a reason worth stating rather
       than working around. Both operators key off the SAME depth map, and once the cut
       is calibrated to actually close (B189: threshold 0.8 over a map whose bed sits at
       0.60–0.65) it zeroes the light of every point at depthN > 0.112 — which is INSIDE
       the zone's own 0.13 boundary. So on the shipped graph the zone parks points that
       already carry no light, and opening it changes not one pixel: a matte is
       monotonic in depth, so any cut that removes the background necessarily subsumes a
       looser geometric one. Held open with the cut open, the zone's selection is the
       only thing left varying and the render diff is again its own. The per-slot claim
       above is what proves the selection itself, on the shipped numbers. */
    const openCut = (graph: GraphDocument) => {
      Object.assign(graph.nodes["cut"]!.parameters as Record<string, unknown>, {
        threshold: 0,
        feather: 0,
        invert: 0,
      });
    };
    const zoneShut = await renderE47({ probe: false, mutate: openCut });
    const zoneOpen = await renderE47({
      probe: false,
      mutate: (graph) => {
        openCut(graph);
        const zone = graph.nodes["zone"]!;
        (zone.parameters as Record<string, unknown>)["to"] = 1;
      },
    });
    const zonePixels = differingPixels(
      rgba(zoneShut.frames[0]!, space).data,
      rgba(zoneOpen.frames[0]!, space).data,
    );
    expect(zonePixels).toBeGreaterThan(500);
  }, 240_000);

  /**
   * §T977 — THE FRAMEBUFFER RED. The cut only works because the paint kernel honours
   * the colour map's alpha as premultiplied coverage; before that fix the kernel wrote
   * tint alpha as a literal 1.0 and a matte was invisible through this chain BY
   * CONSTRUCTION — wired in name only, the §T715 family. Under that original defect
   * both renders below are the SAME picture and this test fails (red-verified by
   * restoring the literal), so the next kernel edit that re-discards alpha reds
   * instead of shipping a silently dead cut.
   *
   * B189 — AND IT IS NOT ENOUGH, which is the row's whole lesson. This test drives the
   * matte to its two EXTREMES, and both extremes worked throughout a defect in which the
   * SHIPPED cut removed nothing: the shipped threshold sat below the whole range of the
   * map it read, so the matte's floor was coverage ~0.65 and not one point was ever cut.
   * A claim about the extremes cannot see a mis-calibrated middle. The cohort test below
   * is the one that can.
   */
  it("the cut carries light: fully open vs fully closed changes the subject's picture", async () => {
    if (dawnError !== undefined) throw new Error(`Dawn unavailable: ${dawnError}`);
    const cutAt = (invert: number) => (graph: GraphDocument) => {
      const cut = graph.nodes["cut"]!;
      Object.assign(cut.parameters as Record<string, unknown>, { threshold: 0, feather: 0, invert });
    };
    // threshold 0, feather 0: the matte is a step at 0 — every luma passes, so invert 0
    // is coverage 1 everywhere (fully open) and invert 1 is coverage 0 (fully closed).
    const open = await renderE47({ probe: false, mutate: cutAt(0) });
    const closed = await renderE47({ probe: false, mutate: cutAt(1) });
    const cutPixels = differingPixels(rgba(open.frames[0]!, space2(open)).data, rgba(closed.frames[0]!, space2(closed)).data);
    expect(cutPixels).toBeGreaterThan(500);
  }, 240_000);

  /**
   * B189 — THE SHIPPED CUT ACTUALLY CUTS, asserted on the two cohorts a background
   * removal is made of.
   *
   * The owner's report was "the DepthCut is not doing a background removal", and he was
   * right: with threshold 0.6 / feather 0.12 the matte window [0.5, 0.7] sat entirely
   * BELOW the understudy depth map's range — measured [0.555, 1.0], 84% of the frame
   * packed into [0.60, 0.65] — so every background point kept ~65% of its light and
   * EXACTLY ZERO of the cloud's 25600 live points was ever fully cut. The picture was a
   * 2.3% dim, indistinguishable from no cut at all, and every gate was green.
   *
   * So the claim here is the one a viewer makes: the background is GONE and the subject
   * is UNTOUCHED. Both numbers are exact, not banded (§V147) — `smoothstep` returns
   * literal 0 below its low edge and literal 1 above its high edge, the mask multiplies
   * the source's alpha by that, and the paint kernel's `clamp` lands the product on
   * literal 0 or literal 1 (even where the additive source's alpha reads 2, the case
   * the §V833 test below owns) — so a cut point publishes tint.a === 0 and a kept point
   * tint.a === 1 with no rounding in between. Only the two cohort SIZES are floors, and
   * they are far from the measured
   * 23092 / 1509: the failure this catches moves them to 0 and 2234.
   *
   * Red-verified by restoring threshold 0.6 / feather 0.1 in the document: the cut
   * cohort goes to zero and the first expectation reds.
   */
  it("the shipped cut removes the background from the points: one cohort at coverage 0, one at 1", async () => {
    if (dawnError !== undefined) throw new Error(`Dawn unavailable: ${dawnError}`);
    const { document } = e47();
    /* The live cloud is the published `resolution` knob squared — derived from the
       document, so re-tuning density moves this with it. Slots past it are the
       generator's spares, which the carve kernel parks and the paint kernel zeroes;
       they are tint.a === 0 for a reason that has nothing to do with the cut. */
    const grid = Number((document.graph.nodes["holo"]!.parameters as Record<string, unknown>)["resolution"]);
    const live = grid * grid;
    expect(live).toBeLessThanOrEqual(DEPTH_POINT_CAPACITY);

    const result = await renderE47();
    const raw = (result as { buffers?: Record<string, ArrayBuffer> }).buffers?.[pointStorageId("holo/paint")];
    expect(raw, "no tint probe").toBeDefined();
    const tint = pointRegionSlice(raw!, DEPTH_POINT_SCHEMA, DEPTH_POINT_CAPACITY, "tint").floats;

    let cut = 0;
    let kept = 0;
    let partial = 0;
    for (let slot = 0; slot < live; slot += 1) {
      const alpha = tint[slot * 4 + 3]!;
      if (alpha === 0) cut += 1;
      else if (alpha === 1) kept += 1;
      else partial += 1;
    }
    // The background is gone: most of the frame is bed, and the bed publishes no light.
    expect(cut, "points fully cut").toBeGreaterThan(20_000);
    // The subject is untouched: the orb's core keeps its colour at full coverage.
    expect(kept, "points fully kept").toBeGreaterThan(1_000);
    // And the edge is still SOFT — a hard step would mean `feather` stopped mattering.
    expect(partial, "points on the feathered rim").toBeGreaterThan(100);
    expect(cut + kept + partial).toBe(live);
  }, 240_000);

  /**
   * §V833's clamp, pinned on the live case: E47's colour map reaches the paint kernel
   * through the mask, whose output alpha is source.a × coverage — and source.a is an
   * ADDITIVE composite's sum, measured at 2 where the orb crosses the opaque bed.
   * Coverage is [0, 1] by meaning, not by storage; without the kernel's clamp those
   * slots publish tint.a = 2 (and doubled rgb), which is exactly the fixture a simple
   * test would not contain. Removing the clamp reds here.
   */
  it("published tint alpha is coverage: never above 1, even where the composite's alpha reads 2", async () => {
    if (dawnError !== undefined) throw new Error(`Dawn unavailable: ${dawnError}`);
    const result = await renderE47();
    const raw = (result as { buffers?: Record<string, ArrayBuffer> }).buffers?.[pointStorageId("holo/paint")];
    expect(raw, "no tint probe").toBeDefined();
    // T1076: `tint` is the SECOND region of the cloud's packed buffer, after `position`.
    const tint = pointRegionSlice(raw!, DEPTH_POINT_SCHEMA, DEPTH_POINT_CAPACITY, "tint").floats;
    let atOne = 0;
    for (let slot = 0; slot < tint.length / 4; slot += 1) {
      const alpha = tint[slot * 4 + 3]!;
      expect(alpha, `slot ${slot} alpha`).toBeGreaterThanOrEqual(0);
      expect(alpha, `slot ${slot} alpha`).toBeLessThanOrEqual(1);
      if (alpha === 1) atOne += 1;
    }
    // The bound must actually be exercised: a fully-cut frame would satisfy <= 1
    // vacuously. Full coverage survives on a real cohort (the subject's bright core).
    expect(atOne).toBeGreaterThan(100);
  }, 240_000);

  /**
   * T1201 — THE PALETTE IS A HEAT MAP, WHICH MEANS ITS COLOUR IS A FUNCTION OF DEPTH.
   *
   * The owner's ask was aesthetic ("Relief's heat map pattern … Hologram is just blue and
   * kind of boring"), and an aesthetic ask has an exact claim under it: a palette read
   * through a `lookup` KEYED ON THE DEPTH MAP makes a mote's colour a monotone function
   * of its distance. A palette lifted from E27 WITHOUT its key would tint every mote the
   * same and look, in a screenshot, like a colour change — which is §V920's failure mode
   * (E55 shipped `brightness: 0` copied from a document that drove it) pointed at hue
   * instead of at brightness. So the assertion is not "the picture is colourful": it is
   * that colour ORDERS BY DEPTH, and that it stops doing so the moment the key is cut.
   *
   * WHY RED, and why it is exact rather than a band. `paint` publishes
   * `tint = vec4f(colour.rgb * gain * cover, cover)`, so `tint.r / tint.a` recovers
   * `palette.r * gain` for any lit mote — coverage divides out, which is what lets the
   * cut's own cohorts stay out of this. `palette1`'s red is non-decreasing across all six
   * stops (0.004, 0.02, 0.08, 0.86, 1, 1) and `coat1`'s index is non-increasing in depth
   * (brighter map = nearer = higher index), so composed, red must be NON-INCREASING in
   * depthN. That is a property of the two, not a measurement of the picture.
   *
   * Measured on the shipped frame: 2508 lit motes, 370 distinct reds, span 0.349, and the
   * per-octile means run 0.5500 0.5500 0.5500 0.5500 0.5297 0.4074 0.3173 0.2211 near to
   * far — the four flat octiles are the orb's core, where the understudy map CLIPS at 1.0
   * and the carve clamps the same sample, so a flat colour there agrees with a flat depth.
   *
   * THE MUTANT IS THE COPY-WITHOUT-THE-KEY. `coat1.scale = 0` leaves the ramp, the braid,
   * the cut and every cohort exactly where they are and only stops the lookup READING the
   * map: measured, the span collapses to exactly 0 and all 2508 motes publish one red. So
   * this test cannot be satisfied by a prettier static tint, which is the whole point.
   */
  it("the subject's colour is its depth: red falls monotonically with depthN, and flattens when the key is cut", async () => {
    if (dawnError !== undefined) throw new Error(`Dawn unavailable: ${dawnError}`);

    /** Lit motes as (depth, un-premultiplied red, coverage), near to far. */
    const litByDepth = (result: unknown): ReadonlyArray<{ depth: number; red: number; cover: number }> => {
      const raw = (result as { buffers?: Record<string, ArrayBuffer> }).buffers?.[pointStorageId("holo/paint")];
      expect(raw, "no tint probe").toBeDefined();
      const tint = pointRegionSlice(raw!, DEPTH_POINT_SCHEMA, DEPTH_POINT_CAPACITY, "tint").floats;
      const depthN = pointRegionSlice(raw!, DEPTH_POINT_SCHEMA, DEPTH_POINT_CAPACITY, "depthN").floats;
      const lit: { depth: number; red: number; cover: number }[] = [];
      for (let slot = 0; slot < tint.length / 4; slot += 1) {
        const alpha = tint[slot * 4 + 3]!;
        if (alpha === 0) continue;
        lit.push({ depth: depthN[slot]!, red: tint[slot * 4]! / alpha, cover: alpha });
      }
      return lit.sort((a, b) => a.depth - b.depth);
    };
    /** Reds of the FULLY covered motes, undivided — so equality here is f32-exact. */
    const opaqueReds = (lit: ReadonlyArray<{ red: number; cover: number }>): Set<number> =>
      new Set(lit.filter((point) => point.cover === 1).map((point) => point.red));
    /** Mean red per depth octile, near to far. */
    const octiles = (lit: ReadonlyArray<{ red: number }>): number[] => {
      const means: number[] = [];
      for (let k = 0; k < 8; k += 1) {
        const from = Math.floor((k * lit.length) / 8);
        const to = Math.floor(((k + 1) * lit.length) / 8);
        const slice = lit.slice(from, to);
        means.push(slice.reduce((total, point) => total + point.red, 0) / slice.length);
      }
      return means;
    };

    const shipped = litByDepth(await renderE47());
    // The frame has to contain a subject at all, or every ordering below is vacuous.
    expect(shipped.length).toBeGreaterThan(1_000);

    /* The one allowance in this test, and it is DERIVED rather than a band (§V147). The
       octile means are computed from `tint.r / tint.a`, and the numerator was rounded to
       f32 in the shader BEFORE the division — so one texel read at two coverages comes
       back as two doubles differing by an f32 ulp at magnitude ~0.55, which is 6e-8. Four
       of the eight octiles are the orb's clipped core and carry ONE texel between them,
       so without this the ordering assertion would be reading round-off. It is three
       orders of magnitude below the smallest real step the shipped picture has (0.02 —
       octile 3 to 4), and the red-verify below drives the real steps to zero. */
    const F32_ROUNDING = 1e-6;
    const shippedOctiles = octiles(shipped);
    // NON-INCREASING with depth, every step — the composition of two monotone functions,
    // so this is exact and any inversion is a real break in the mapping.
    for (let k = 1; k < shippedOctiles.length; k += 1) {
      expect(shippedOctiles[k]!, `octile ${k} against ${k - 1}`).toBeLessThanOrEqual(
        shippedOctiles[k - 1]! + F32_ROUNDING,
      );
    }
    // And it must actually DESCEND, not merely fail to rise: the far half is where the
    // map has range left after the orb's clipped core, and it spends most of the ramp.
    expect(shippedOctiles[7]!).toBeLessThan(shippedOctiles[3]! * 0.6);

    const reds = shipped.map((point) => point.red);
    const span = Math.max(...reds) - Math.min(...reds);
    // Measured 0.349 across a 0.55 gain — i.e. the lit cloud spends 63% of the palette's
    // red travel. A floor well under it; the mutant below puts it at 0.
    expect(span).toBeGreaterThan(0.25);
    // 68 distinct reds among the fully covered motes alone (measured), so the mutant's
    // "exactly one" below is a real collapse rather than a cohort that never varied.
    expect(opaqueReds(shipped).size).toBeGreaterThan(10);

    /* THE PALETTE WITHOUT ITS KEY (§V920). `scale: 0` makes the index the offset alone,
       so every mote reads one texel of the same ramp: same nodes, same wires, same
       cohorts, no heat map. `offset: 0.8` keeps it LIT — a mutant that also went black
       would be caught by brightness and would not test the ordering. */
    const flat = litByDepth(
      await renderE47({
        mutate: (graph) => {
          Object.assign(graph.nodes["coat"]!.parameters as Record<string, unknown>, { scale: 0, offset: 0.8 });
        },
      }),
    );
    // The cut is untouched by the mutant, so the two runs light the SAME motes — which is
    // what makes the comparison about colour and nothing else.
    expect(flat.length).toBe(shipped.length);
    /* EXACTLY ONE RED, exactly (§V147) — asserted on the FULLY COVERED motes and on
       `tint.r` undivided, because that is where the equality is f32-exact. A mote at
       partial coverage carries `red * gain * cover` and dividing the coverage back out
       rounds, so the 999 rim motes read one texel as ~400 neighbouring floats: real
       arithmetic noise, not a second colour, and asserting through it would have made
       this an epsilon band instead of an identity. Measured: 68 distinct here shipped,
       1 with the key cut. */
    expect(opaqueReds(flat).size).toBe(1);
  }, 240_000);
});

/** The output's colour space for a render result — shared by the diff helpers. */
function space2(result: { plan: { outputs: ReadonlyArray<{ nodeId: string; space?: string }> } }): string {
  return result.plan.outputs.find((output) => output.nodeId === "out")?.space ?? "linear";
}
