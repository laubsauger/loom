import { describe, expect, it } from "vitest";

import { compileGraph } from "../../../compiler/index.ts";
import { createNodeRegistry } from "../../../nodes/registry/registry.ts";
import { allNodeDefinitions } from "../../../nodes/definitions/index.ts";
import { createVgpuBackend } from "./vgpu-backend.ts";
import { nodeGpuHost, probeDawn } from "./node-gpu-host.ts";

/**
 * T819 — Proximity, by VALUE on a real device (§V147).
 *
 * The fixture is a LINE, because a line makes every distance a hand-checkable integer:
 * five points at x = −2, −1, 0, 1, 2 (spacing exactly 1, exactly representable). Every
 * link's position, tip and tint is asserted — the neighbour SELECTION, the
 * distance-rank ORDER within the K slots, the §V788 zero-length collapse of absent
 * links, and the falloff curve are all claims about exact numbers, not about "some
 * lines appeared".
 *
 * The counted case is the one an eyeball can never check: a live count smaller than
 * capacity must both shrink the CANDIDATE set (no link may reach a dead point) and park
 * every link whose SOURCE is dead. The discriminating slot is the survivor at x = 0,
 * whose right-hand neighbour exists in the buffer but not in the living set.
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

interface Link {
  readonly x: number;
  readonly tipX: number;
  readonly alpha: number;
  /** T1071: WHO the neighbour is, not just where — the source slot for an absent link. */
  readonly neighbor: number;
}

async function renderLinks(
  sourceNode: unknown,
  proximity: Record<string, unknown>,
  frames = 1,
): Promise<Link[]> {
  const registry = createNodeRegistry(allNodeDefinitions).view();
  const plan = compileGraph({
    graph: {
      revision: 1,
      nodes: {
        src: sourceNode as never,
        prox: node("prox", "pointProximity", proximity),
        draw: node("draw", "renderPoints", { sizePixels: 4 }),
        out: node("out", "output", {}),
      },
      edges: {
        e0: edge("e0", ["src", "out"], ["prox", "points"]),
        e1: edge("e1", ["prox", "out"], ["draw", "points"]),
        e2: edge("e2", ["draw", "out"], ["out", "input"]),
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
    for (let frameIndex = 0; frameIndex < frames; frameIndex += 1) {
      backend.render(compiled, {
        frame: { timeSeconds: frameIndex / 60, deltaSeconds: 1 / 60, frameIndex, mode: "offline", randomSeed: 7 },
        pointer: { x: 0, y: 0, buttons: 0 },
        resolution: [64, 64],
      } as never);
    }
    const positions = new Float32Array(await backend.readBuffer("scratch:prox:position"));
    const tips = new Float32Array(await backend.readBuffer("scratch:prox:tip"));
    const tints = new Float32Array(await backend.readBuffer("scratch:prox:tint"));
    const neighbors = new Uint32Array(await backend.readBuffer("scratch:prox:neighbor"));
    const links: Link[] = [];
    // vec3f is 16-byte aligned (§V720): 4 floats per element, x in lane 0.
    for (let at = 0; at * 4 < positions.length; at += 1) {
      links.push({
        x: positions[at * 4] ?? Number.NaN,
        tipX: tips[at * 4] ?? Number.NaN,
        alpha: tints[at * 4 + 3] ?? Number.NaN,
        // u32 strides at 4 bytes, so the link index IS the element index here.
        neighbor: neighbors[at] ?? Number.NaN,
      });
    }
    return links;
  } finally {
    backend.dispose();
  }
}

const line = node("src", "pointLine", { shape: "line", count: 5, sizeX: 4 });

describe("Proximity links, by value (T819)", () => {
  it("selects the exact K nearest on a line, ranks by distance, and parks the absent (§V788)", async () => {
    const probe = await probeDawn();
    if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);

    // radius 1.5 reaches the adjacent point (d = 1) and not the next (d = 2).
    const links = await renderLinks(line, { neighbors: 2, radius: 1.5, falloff: 0 });
    expect(links).toHaveLength(10);

    // The line runs x = −2 … 2 in slot order, so the SLOT expected in each link is a fact
    // about the fixture rather than a reading of the answer: slot = tip x + 2.
    const expected: Array<[number, number, number, number]> = [
      // [source x, tip x, alpha, neighbour slot] — two slots per point, scan-order ties,
      // parked = self in BOTH senses (tip == position, neighbour == the source's own slot).
      [-2, -1, 1, 1], [-2, -2, 0, 0],
      [-1, -2, 1, 0], [-1, 0, 1, 2],
      [0, -1, 1, 1], [0, 1, 1, 3],
      [1, 0, 1, 2], [1, 2, 1, 4],
      [2, 1, 1, 3], [2, 2, 0, 4],
    ];
    expected.forEach(([x, tipX, alpha, neighbor], at) => {
      const link = links[at]!;
      expect(link.x, `link ${at} source`).toBeCloseTo(x, 5);
      expect(link.tipX, `link ${at} tip`).toBeCloseTo(tipX, 5);
      expect(link.alpha, `link ${at} alpha`).toBeCloseTo(alpha, 5);
      // T1071: exact, not close — a slot is an integer address (§V73) and "nearly slot 3"
      // is not a thing. This is the claim that turns a picture of a graph into the graph.
      expect(link.neighbor, `link ${at} neighbour slot`).toBe(neighbor);
    });

    // AND THE SLOT AGREES WITH THE TIP, link for link — the property every gather stands
    // on. If these two ever disagreed, a consumer following the slot would weight the
    // right neighbour's attribute by the wrong link, silently.
    for (const [at, link] of links.entries()) {
      expect(link.tipX, `link ${at}: tip must be the position of slot ${link.neighbor}`).toBeCloseTo(
        link.neighbor - 2,
        5,
      );
    }
  });

  it("ranks two found neighbours by distance and fades by the falloff curve", async () => {
    const probe = await probeDawn();
    if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);

    // radius 2.5 reaches two neighbours from an endpoint: d = 1 then d = 2. Slot order
    // must be distance rank, and falloff 1 makes alpha the linear fade 1 − d/r.
    const links = await renderLinks(line, { neighbors: 2, radius: 2.5, falloff: 1 });
    const first = links[0]!;
    const second = links[1]!;
    expect(first.tipX).toBeCloseTo(-1, 5);
    expect(first.alpha).toBeCloseTo(1 - 1 / 2.5, 5);
    expect(second.tipX).toBeCloseTo(0, 5);
    expect(second.alpha).toBeCloseTo(1 - 2 / 2.5, 5);
  });

  it("a radius below the spacing parks EVERY link — the §V147 identity of the web", async () => {
    const probe = await probeDawn();
    if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);

    const links = await renderLinks(line, { neighbors: 2, radius: 0.5, falloff: 1 });
    for (const [at, link] of links.entries()) {
      expect(link.tipX, `link ${at} must be zero-length`).toBeCloseTo(link.x, 6);
      expect(link.alpha, `link ${at} must be invisible`).toBeCloseTo(0, 6);
      // T1071: and it must address ITSELF — an absent link's slot is the SOURCE's, which
      // is what makes `neighbor != index` an exact presence test and keeps every address a
      // gather can follow inside the buffer. Two links per point, so slot = at / 2.
      expect(link.neighbor, `link ${at} must address its own source slot`).toBe(Math.floor(at / 2));
    }
  });

  it("a counted upstream shrinks the candidate set AND parks dead sources", async () => {
    const probe = await probeDawn();
    if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);

    // Five slots, three survivors at x = −2, −1, 0; indices 3 and 4 die on first run.
    const kernel = `fn process(p: Point, ctx: PointCtx) -> Point {
  var q = p;
  q.position = vec3f(f32(ctx.index) - 2.0, 0.0, 0.0);
  q.alive = select(0u, 1u, ctx.index < 3u);
  return q;
}`;
    const sim = node("src", "pointKernelAdvanced", { capacity: 5, seed: 7, kernel });
    const links = await renderLinks(sim, { neighbors: 2, radius: 1.5, falloff: 0 }, 2);
    expect(links).toHaveLength(10);

    // The discriminating slot: the survivor at x = 0 has a right-hand neighbour IN THE
    // BUFFER (x = 1, the dead tail) but not in the living set — an uncounted scan links
    // it, a counted scan must not.
    expect(links[4]!.tipX).toBeCloseTo(-1, 5); // 0 → −1, its one living neighbour
    expect(links[5]!.tipX).toBeCloseTo(links[5]!.x, 5); // parked, never 0 → 1
    expect(links[5]!.alpha).toBeCloseTo(0, 6);
    // And every link whose source is in the dead tail is parked.
    for (const at of [6, 7, 8, 9]) {
      expect(links[at]!.tipX, `dead-tail link ${at}`).toBeCloseTo(links[at]!.x, 5);
      expect(links[at]!.alpha, `dead-tail link ${at}`).toBeCloseTo(0, 6);
    }
  });
});
