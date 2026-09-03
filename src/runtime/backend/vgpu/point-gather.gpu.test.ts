import { describe, expect, it } from "vitest";
import { pointStorageId } from "../../../nodes/definitions/point-storage.ts";
import { planRegion } from "../../../nodes/definitions/test-support.ts";

import { compileGraph } from "../../../compiler/index.ts";
import { createNodeRegistry } from "../../../nodes/registry/registry.ts";
import { allNodeDefinitions } from "../../../nodes/definitions/index.ts";
import { createVgpuBackend } from "./vgpu-backend.ts";
import { nodeGpuHost, probeDawn } from "./node-gpu-host.ts";

/**
 * T1071 — Gather, by VALUE on a real device (§V147), over the adjacency Proximity emits.
 *
 * ⚑ THE FIXTURE IS DELIBERATELY LOPSIDED (§V854), because the degenerate one cannot tell a
 * working gather from a broken one. Six points on a line at x = 0, 1, 2, 10, 11, 20 with
 * K = 2 and radius 4 gives every point a DIFFERENT neighbourhood — two links, two links,
 * two links, ONE link, ONE link, NONE — and every link a DIFFERENT strength, because
 * falloff 1 makes the weight the exact fraction 1 − d/4. A regular lattice would have made
 * "every point got the same answer" indistinguishable from "every point got the mean of
 * everything", which is precisely the bug this node could have.
 *
 * Every expected number below is DERIVED IN THIS FILE from the fixture's own geometry, not
 * read back out of the picture it is judging, and every weight is an exact binary fraction
 * (0.75, 0.5) so the sums and the degree are exact rather than nearly right.
 *
 * The two claims that carry the design:
 *
 *  1. THE ISOLATED POINT. Slot 5 has no link inside the radius, so Proximity parks both of
 *     its slots. `degree` must be EXACTLY zero (an empty sum is zero, and that is the
 *     property `bound1`-style partitions stand on) and `mean` must be the point's OWN value
 *     — not zero, which is the plausible-wrong answer that reads as black.
 *
 *  2. THE ONE-LINK POINTS. Slots 3 and 4 have exactly one neighbour, so their weighted mean
 *     must be that neighbour's value EXACTLY, whatever the weight is — the normaliser and
 *     the weight cancel. That is the claim that fails the instant the gather divides by the
 *     link COUNT instead of by the weight, and it names no tolerance at all.
 */

const SETTINGS = {
  outputResolution: { width: 64, height: 64 },
  workingFormat: "rgba8unorm",
  randomSeed: 7,
  previewLongEdge: 192,
  previewFps: 20,
  limits: { maxResolution: 4096, maxDispatch: 65535, maxBufferBytes: 268_435_456, memoryBudgetBytes: 1_073_741_824 },
} as never;

const CAPABILITIES = {
  tier: "B",
  features: [],
  formats: ["rgba8unorm", "rgba8unorm-srgb", "rgba16float", "r32float"],
  timestampQuery: false,
  limits: { maxTextureDimension2D: 8192 },
} as never;

const node = (id: string, type: string, parameters: Record<string, unknown>) =>
  ({ id, type, definitionVersion: 1, position: { x: 0, y: 0 }, parameters }) as never;
const edge = (id: string, from: [string, string], to: [string, string]) =>
  ({ id, source: { nodeId: from[0], portId: from[1] }, target: { nodeId: to[0], portId: to[1] } }) as never;

/** The fixture, and the ONLY place these numbers are written. */
const XS = [0, 1, 2, 10, 11, 20] as const;
const VALUES = XS.map((_x, slot) => slot + 1);
const RADIUS = 4;
const K = 2;

const ATTRIBUTES = JSON.stringify([
  { name: "position", type: "vec3f", semantic: "position", default: [0, 0, 0] },
  { name: "value", type: "f32", default: [0] },
]);

const PLACE_KERNEL = `fn process(p: Point, ctx: PointCtx) -> Point {
  var q = p;
  var xs = array<f32, 6>(0.0, 1.0, 2.0, 10.0, 11.0, 20.0);
  q.position = vec3f(xs[ctx.index], 0.0, 0.0);
  q.value = f32(ctx.index) + 1.0;
  return q;
}`;

/**
 * The adjacency Proximity WILL produce, derived here from the fixture's geometry alone:
 * the K nearest inside the radius, ranked by distance, ties broken by scan order — which is
 * the contract `point-proximity.gpu.test.ts` pins by value on the same device.
 */
function expectedLinks(): Array<Array<{ slot: number; weight: number }>> {
  return XS.map((x, index) => {
    const candidates = XS.map((other, slot) => ({ slot, distance: Math.abs(other - x) }))
      .filter((entry) => entry.slot !== index && entry.distance <= RADIUS)
      .sort((a, b) => a.distance - b.distance || a.slot - b.slot)
      .slice(0, K);
    return candidates.map((entry) => ({ slot: entry.slot, weight: 1 - entry.distance / RADIUS }));
  });
}

const LINKS = expectedLinks();

async function gather(parameters: Record<string, unknown>, outputName: string): Promise<number[]> {
  const registry = createNodeRegistry(allNodeDefinitions).view();
  const plan = compileGraph({
    graph: {
      revision: 1,
      nodes: {
        src: node("src", "pointKernel", { capacity: XS.length, seed: 7, attributes: ATTRIBUTES, kernel: PLACE_KERNEL }),
        prox: node("prox", "pointProximity", { neighbors: K, radius: RADIUS, falloff: 1 }),
        gath: node("gath", "pointGather", { output: outputName, ...parameters }),
        draw: node("draw", "renderPoints", { sizePixels: 4 }),
        out: node("out", "output", {}),
      },
      edges: {
        // Feed-forward, no cycle: the kernel feeds the adjacency AND the gather's points,
        // so the links and the population they address come from one producer.
        e0: edge("e0", ["src", "out"], ["prox", "points"]),
        e1: edge("e1", ["src", "out"], ["gath", "points"]),
        e2: edge("e2", ["prox", "out"], ["gath", "links"]),
        e3: edge("e3", ["gath", "out"], ["draw", "points"]),
        e4: edge("e4", ["draw", "out"], ["out", "input"]),
      },
      groups: {},
    },
    settings: SETTINGS,
    registry,
    capabilities: CAPABILITIES,
  });
  // §V883: a plan that compiled is not the same as a plan that compiled what you meant.
  expect(plan.diagnostics.filter((d) => d.severity === "error").map((d) => d.message)).toEqual([]);
  expect(plan.passes.length).toBeGreaterThan(0);

  const backend = createVgpuBackend({ host: nodeGpuHost() });
  try {
    await backend.initialize({});
    const compiled = await backend.compile(plan);
    for (let frameIndex = 0; frameIndex < 2; frameIndex += 1) {
      backend.render(compiled, {
        frame: { timeSeconds: frameIndex / 60, deltaSeconds: 1 / 60, frameIndex, mode: "offline", randomSeed: 7 },
        pointer: { x: 0, y: 0, buttons: 0 },
        resolution: [64, 64],
      } as never);
    }
    /* T1076: a gather owns ONE attribute, so its packed buffer IS that region — the
       offset comes off the plan's own `out_value` binding rather than an assumption. */
    const region = planRegion(plan.passes, "gath", "out_value");
    const raw = await backend.readBuffer(pointStorageId("gath"));
    return [...new Float32Array(raw, region.offset, region.bytes / 4)].slice(0, XS.length);
  } finally {
    backend.dispose();
  }
}

describe("Gather over an adjacency, by value (T1071)", () => {
  it("DEGREE is the total link weight — exactly zero for the point nothing reaches", async () => {
    const probe = await probeDawn();
    if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);

    const measured = await gather({ reduce: "degree", weight: "strength" }, "degree");
    const expected = LINKS.map((links) => links.reduce((total, link) => total + link.weight, 0));
    // 1.25, 1.5, 1.25, 0.75, 0.75, 0 — a different degree for a differently connected
    // point, which is the whole reason the fixture is lopsided.
    expect(new Set(expected).size, "the fixture must give at least three distinct degrees").toBeGreaterThanOrEqual(3);
    measured.forEach((value, slot) => {
      expect(value, `slot ${slot} degree`).toBeCloseTo(expected[slot]!, 6);
    });
    // EXACT, and it can be: the isolated point's links are all parked, so nothing is added
    // to the accumulator and the store is the zero it was initialised with. A gather that
    // counted a parked link — or read its strength instead of its address — lands above it.
    expect(measured[5], "slot 5 is reached by nothing and its degree must be exactly 0").toBe(0);
  });

  it("SUM weights each neighbour's value by its own link strength", async () => {
    const probe = await probeDawn();
    if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);

    const measured = await gather({ reduce: "sum", attribute: "value", weight: "strength" }, "gathered");
    const expected = LINKS.map((links) =>
      links.reduce((total, link) => total + link.weight * VALUES[link.slot]!, 0),
    );
    measured.forEach((value, slot) => {
      expect(value, `slot ${slot} weighted sum`).toBeCloseTo(expected[slot]!, 5);
    });
    expect(measured[5], "an empty sum is exactly zero").toBe(0);
  });

  it("MEAN over ONE neighbour is that neighbour's value EXACTLY — the weight cancels", async () => {
    const probe = await probeDawn();
    if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);

    const measured = await gather({ reduce: "mean", attribute: "value", weight: "strength" }, "gathered");
    // Slots 3 and 4 are a pair nothing else reaches: one link each, weight 0.75. A mean
    // divided by the WEIGHT gives the neighbour's value bit for bit; a mean divided by the
    // link COUNT gives 0.75 × it, and this is the assertion that tells them apart.
    expect(LINKS[3]!.length, "slot 3 must have exactly one neighbour for this claim").toBe(1);
    expect(measured[3], "slot 3's neighbourhood is slot 4 alone").toBe(VALUES[4]!);
    expect(measured[4], "slot 4's neighbourhood is slot 3 alone").toBe(VALUES[3]!);

    const expected = LINKS.map((links, slot) => {
      const weight = links.reduce((total, link) => total + link.weight, 0);
      if (links.length === 0) return VALUES[slot]!;
      return links.reduce((total, link) => total + link.weight * VALUES[link.slot]!, 0) / weight;
    });
    measured.forEach((value, slot) => {
      expect(value, `slot ${slot} weighted mean`).toBeCloseTo(expected[slot]!, 5);
    });
    // A POINT WITH NO NEIGHBOURS IS ITS OWN NEIGHBOURHOOD. Exact, and deliberately not
    // zero: zero is the plausible-wrong answer that reads as black on any colour gather.
    expect(measured[5], "slot 5 has no neighbours and must keep its own value").toBe(VALUES[5]!);
  });

  it("the WEIGHT knob is a real choice: uniform and strength disagree where the distances do", async () => {
    const probe = await probeDawn();
    if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);

    const uniform = await gather({ reduce: "mean", attribute: "value", weight: "uniform" }, "gathered");
    const expected = LINKS.map((links, slot) =>
      links.length === 0
        ? VALUES[slot]!
        : links.reduce((total, link) => total + VALUES[link.slot]!, 0) / links.length,
    );
    uniform.forEach((value, slot) => {
      expect(value, `slot ${slot} unweighted mean`).toBeCloseTo(expected[slot]!, 5);
    });
    // Slot 0's two neighbours sit at DIFFERENT distances (1 and 2), so the two weightings
    // must give different answers — 2.5 counting each once, 2.4 weighting by strength. If
    // these ever agreed, Weight would be an inert control (§V880).
    const weighted = await gather({ reduce: "mean", attribute: "value", weight: "strength" }, "gathered");
    expect(uniform[0]).not.toBe(weighted[0]);
    expect(uniform[0]).toBeCloseTo(2.5, 6);
    // And where the distances are equal the two MUST agree — slot 1's neighbours are both
    // at distance 1, so weighting cannot change its mean. That is the other half of the
    // claim: the knob moves what it should and nothing else (§V884).
    expect(uniform[1]).toBeCloseTo(weighted[1]!, 6);
  });

  it("MIN and MAX are over the links that EXIST, and an isolated point is its own bound", async () => {
    const probe = await probeDawn();
    if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);

    const low = await gather({ reduce: "min", attribute: "value" }, "gathered");
    const high = await gather({ reduce: "max", attribute: "value" }, "gathered");
    LINKS.forEach((links, slot) => {
      const neighbourValues = links.map((link) => VALUES[link.slot]!);
      // Exact on every slot: min and max return a value that EXISTS in the buffer, so
      // there is nothing to round. A parked link folded into the reduction would drag the
      // min to the source's own value and this would fail on slots 3, 4 and 0.
      expect(low[slot], `slot ${slot} min`).toBe(
        neighbourValues.length === 0 ? VALUES[slot]! : Math.min(...neighbourValues),
      );
      expect(high[slot], `slot ${slot} max`).toBe(
        neighbourValues.length === 0 ? VALUES[slot]! : Math.max(...neighbourValues),
      );
    });
  });

  it("THE COMPUTED EDGES ARE THE DRAWN EDGES: the gather's answer is the sum over exactly the visible links", async () => {
    const probe = await probeDawn();
    if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);

    // The point of the whole exercise. Read the link set BACK — the same buffers the beam
    // renderer draws from — and rebuild the degree from the links that would actually be
    // VISIBLE (non-zero alpha). If the gather were using its own predicate, or reading a
    // stride it derived differently, these two numbers would part company.
    const registry = createNodeRegistry(allNodeDefinitions).view();
    const plan = compileGraph({
      graph: {
        revision: 1,
        nodes: {
          src: node("src", "pointKernel", {
            capacity: XS.length,
            seed: 7,
            attributes: ATTRIBUTES,
            kernel: PLACE_KERNEL,
          }),
          prox: node("prox", "pointProximity", { neighbors: K, radius: RADIUS, falloff: 1 }),
          gath: node("gath", "pointGather", { reduce: "degree", weight: "strength", output: "degree" }),
          draw: node("draw", "renderPoints", { sizePixels: 4 }),
          out: node("out", "output", {}),
        },
        edges: {
          e0: edge("e0", ["src", "out"], ["prox", "points"]),
          e1: edge("e1", ["src", "out"], ["gath", "points"]),
          e2: edge("e2", ["prox", "out"], ["gath", "links"]),
          e3: edge("e3", ["gath", "out"], ["draw", "points"]),
          e4: edge("e4", ["draw", "out"], ["out", "input"]),
        },
        groups: {},
      },
      settings: SETTINGS,
      registry,
      capabilities: CAPABILITIES,
    });
    expect(plan.diagnostics.filter((d) => d.severity === "error").map((d) => d.message)).toEqual([]);

    const backend = createVgpuBackend({ host: nodeGpuHost() });
    try {
      await backend.initialize({});
      const compiled = await backend.compile(plan);
      for (let frameIndex = 0; frameIndex < 2; frameIndex += 1) {
        backend.render(compiled, {
          frame: { timeSeconds: frameIndex / 60, deltaSeconds: 1 / 60, frameIndex, mode: "offline", randomSeed: 7 },
          pointer: { x: 0, y: 0, buttons: 0 },
          resolution: [64, 64],
        } as never);
      }
      /* T1076: the link attributes are regions of the proximity node's packed buffer and
         the degree is a region of the gather's — offsets from the plan's own bindings. */
      const linkPacked = await backend.readBuffer(pointStorageId("prox"));
      const link = (binding: string) => planRegion(plan.passes, "prox", binding);
      const tintRegion = link("out_tint");
      const tipRegion = link("out_tip");
      const neighborRegion = link("out_neighbor");
      const tints = new Float32Array(linkPacked, tintRegion.offset, tintRegion.bytes / 4);
      const tips = new Float32Array(linkPacked, tipRegion.offset, tipRegion.bytes / 4);
      const neighbors = new Uint32Array(linkPacked, neighborRegion.offset, neighborRegion.bytes / 4);
      const degreeRegion = planRegion(plan.passes, "gath", "out_value");
      const degreePacked = await backend.readBuffer(pointStorageId("gath"));
      const measured = [
        ...new Float32Array(degreePacked, degreeRegion.offset, degreeRegion.bytes / 4),
      ].slice(0, XS.length);

      let drawn = 0;
      const fromDrawnLinks = XS.map((_x, slot) => {
        let total = 0;
        for (let s = 0; s < K; s += 1) {
          const link = slot * K + s;
          const alpha = tints[link * 4 + 3] ?? 0;
          if (neighbors[link] === slot) continue; // parked: not drawn, not counted
          drawn += 1;
          // The beam's far end and the slot the gather followed must be the SAME point —
          // the identity that makes "the picture shows the operator's own edges" true
          // rather than a coincidence of two scans agreeing.
          expect(tips[link * 4], `link ${link}: tip must be the position of slot ${neighbors[link]}`).toBeCloseTo(
            XS[neighbors[link]!]!,
            5,
          );
          total += alpha;
        }
        return total;
      });
      expect(drawn, "the fixture must actually draw some links").toBe(LINKS.flat().length);
      measured.forEach((value, slot) => {
        expect(value, `slot ${slot}: gathered degree vs the sum over the DRAWN links`).toBeCloseTo(
          fromDrawnLinks[slot]!,
          6,
        );
      });
    } finally {
      backend.dispose();
    }
  });
});
