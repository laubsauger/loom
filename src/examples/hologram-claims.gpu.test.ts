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

    // Open the subject's zone to keep everything: the cut room must have been absent.
    const zoneOpen = await renderE47({
      probe: false,
      mutate: (graph) => {
        const zone = graph.nodes["zone"]!;
        (zone.parameters as Record<string, unknown>)["to"] = 1;
      },
    });
    const zonePixels = differingPixels(shippedImage.data, rgba(zoneOpen.frames[0]!, space).data);
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
});

/** The output's colour space for a render result — shared by the diff helpers. */
function space2(result: { plan: { outputs: ReadonlyArray<{ nodeId: string; space?: string }> } }): string {
  return result.plan.outputs.find((output) => output.nodeId === "out")?.space ?? "linear";
}
