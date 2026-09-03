import { beforeAll, describe, expect, it } from "vitest";

import type { GraphDocument } from "../domain/types/graph.ts";
import { nodeGpuHost, probeDawn } from "../runtime/backend/vgpu/node-gpu-host.ts";
import { toRgba8 } from "../runtime/export/image.ts";
import { BYTES_PER_PIXEL } from "../runtime/export/pixel-format.ts";
import { renderHeadless } from "../tests/headless/render-harness.ts";
import { listExamples } from "./catalogue.ts";
import { requireExample } from "./runner.ts";

/**
 * E54 QUORUM — THE CLAIMS (T1070).
 *
 * The example's whole assertion is that ONE operator lays the graph out AND colours it, and
 * that neither the arrangement nor the palette is authored. A screenshot cannot tell an
 * emergent cluster from a painted one, so the claims are made where the answer actually is:
 * on the point buffers the kernel writes, through the real plan on Dawn — with the expected
 * partition DERIVED in this file from the same identity hash the WGSL uses, so nothing here
 * is a band (§V147).
 *
 * ⚠ THE HEADLINE CLAIM IS ASSERTED BOTH WAYS (§V884's rule, which exists because the
 * one-way form passes for the wrong reason). "Different start, same communities" is only
 * evidence if the start REALLY DIFFERED: a test that checked the palette matched would pass
 * just as happily if Seed did nothing at all. So the layout is asserted to have MOVED in the
 * same breath as the palette is asserted to have held.
 *
 * The pixel claims keep the buffers honest about reaching the screen — the "what differs if
 * the edge were cut" bar, taken literally on the two layers whose separation is the reason
 * the haze has a colour at all.
 */

function e54() {
  const file = listExamples().find((entry) => entry.fileName === "E54-Quorum.loom.json");
  if (file === undefined) throw new Error("E54-Quorum.loom.json is not shipped");
  return requireExample(file);
}

let dawnError: string | undefined;
beforeAll(async () => {
  dawnError = (await probeDawn()).error;
}, 60_000);

const SIZE = { width: 320, height: 180 };
/** Long enough for the descent to have settled — never frame 0, where nothing has moved yet (§V876). */
const SETTLE = 180;

/** The population and the floor, read off the shipped document rather than retyped. */
const CAPACITY = 480;
/* f32, because that is what the buffer holds: 0.45 is not representable, and comparing a
   read-back float against the DOUBLE 0.45 fails on a kernel that is behaving perfectly. */
const UNLINKED = Math.fround(0.45);
const LOOSE = 4;

/*
 * THE GRAPH, RE-DERIVED HERE — the same arithmetic the kernel's `idHash` / `communityOf`
 * perform, in u32 semantics, so this file knows which community every slot belongs to
 * WITHOUT reading it back out of the picture it is judging. That independence is the point:
 * a partition recovered from the render would agree with the render by construction.
 */
function idHash(id: number, salt: number): number {
  let h = (Math.imul(id, 2654435761) ^ Math.imul(salt, 2246822519)) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 2246822519) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 3266489917) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

function idRand(id: number, salt: number): number {
  return idHash(id, salt) / 4294967296;
}

function communityOf(id: number): number {
  const r = idRand(id, 101);
  if (r < 0.26) return 0;
  if (r < 0.46) return 1;
  if (r < 0.61) return 2;
  if (r < 0.72) return 3;
  return LOOSE;
}

const COMMUNITIES = [0, 1, 2, 3] as const;

/** Slots belonging to each community, and the unaffiliated, by identity alone. */
const MEMBERS = new Map<number, number[]>();
for (let slot = 0; slot < CAPACITY; slot += 1) {
  const community = communityOf(slot);
  const list = MEMBERS.get(community) ?? [];
  list.push(slot);
  MEMBERS.set(community, list);
}

interface Field {
  /** Per slot: x, y, z. */
  readonly position: ReadonlyArray<readonly [number, number, number]>;
  /** Per slot: r, g, b. */
  readonly tint: ReadonlyArray<readonly [number, number, number]>;
  /** Per slot: the weighted degree in the community graph. */
  readonly degree: ReadonlyArray<number>;
  readonly rgba: { width: number; height: number; data: Uint8Array };
  readonly passes: ReadonlyArray<{ id?: string; shader?: string }>;
}

async function renderQuorum(options?: {
  seed?: number;
  mutate?: (graph: GraphDocument) => void;
  probe?: boolean;
}): Promise<Field> {
  const { document } = e54();
  const graph = structuredClone(document.graph) as GraphDocument;
  const mesh = graph.nodes["mesh"];
  if (mesh === undefined) throw new Error("E54 has no mesh node");
  if (options?.seed !== undefined) mesh.parameters = { ...mesh.parameters, seed: options.seed };
  options?.mutate?.(graph);
  const result = (await renderHeadless({
    host: nodeGpuHost(),
    graph,
    settings: { ...document.settings, outputResolution: SIZE },
    frames: SETTLE + 1,
    capture: [SETTLE],
    fps: 60,
    animate: true,
    ...(options?.probe === false
      ? {}
      : { probeBuffers: ["scratch:mesh:position", "scratch:mesh:tint", "scratch:mesh:degree"] }),
  } as never)) as never as {
    frames: ReadonlyArray<{ frameIndex: number; width: number; height: number; format: string; bytes: Uint8Array }>;
    plan: {
      outputs: ReadonlyArray<{ nodeId: string; space?: string }>;
      passes: ReadonlyArray<{ id?: string; shader?: string }>;
    };
    buffers?: Record<string, ArrayBuffer>;
  };

  const frame = result.frames.find((entry) => entry.frameIndex === SETTLE);
  if (frame === undefined) throw new Error(`no captured frame at ${SETTLE}`);
  const space = result.plan.outputs.find((output) => output.nodeId === "out")?.space ?? "linear";
  const image = toRgba8(
    {
      width: frame.width,
      height: frame.height,
      format: frame.format as never,
      bytes: frame.bytes,
      rowStride: frame.width * (BYTES_PER_PIXEL[frame.format as never] ?? 8),
    },
    { space } as never,
  );

  const buffers = result.buffers ?? {};
  const readVec3 = (id: string): Array<readonly [number, number, number]> => {
    const raw = buffers[id];
    if (raw === undefined) return [];
    const view = new Float32Array(raw);
    // §V72: a vec3f strides at SIXTEEN bytes, not twelve — the classic WGSL alignment trap,
    // and reading it as three floats would silently walk this whole assertion off the data.
    return Array.from({ length: CAPACITY }, (_unused, slot) => [
      view[slot * 4] ?? 0,
      view[slot * 4 + 1] ?? 0,
      view[slot * 4 + 2] ?? 0,
    ] as const);
  };
  const degreeRaw = buffers["scratch:mesh:degree"];
  const degreeView = degreeRaw === undefined ? new Float32Array(0) : new Float32Array(degreeRaw);

  return {
    position: readVec3("scratch:mesh:position"),
    tint: readVec3("scratch:mesh:tint"),
    degree: Array.from({ length: degreeView.length === 0 ? 0 : CAPACITY }, (_u, slot) => degreeView[slot] ?? 0),
    rgba: { width: image.width, height: image.height, data: image.data },
    passes: result.plan.passes,
  };
}

function meanOf(values: ReadonlyArray<readonly [number, number, number]>): readonly [number, number, number] {
  const sum = values.reduce<[number, number, number]>(
    (acc, v) => [acc[0] + v[0], acc[1] + v[1], acc[2] + v[2]],
    [0, 0, 0],
  );
  const n = Math.max(values.length, 1);
  return [sum[0] / n, sum[1] / n, sum[2] / n];
}

function distance(a: readonly [number, number, number], b: readonly [number, number, number]): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

/** The mean colour each community settled on, and the mean scatter of its members about it. */
function palette(field: Field): Array<{ mean: readonly [number, number, number]; scatter: number }> {
  return COMMUNITIES.map((community) => {
    const slots = MEMBERS.get(community) ?? [];
    const colours = slots.map((slot) => field.tint[slot] ?? ([0, 0, 0] as const));
    const mean = meanOf(colours);
    const scatter = colours.reduce((acc, c) => acc + distance(c, mean), 0) / Math.max(colours.length, 1);
    return { mean, scatter };
  });
}

/** Where each community ended up, and how wide it spread getting there. */
function layout(field: Field): Array<{ centre: readonly [number, number, number]; radius: number }> {
  return COMMUNITIES.map((community) => {
    const slots = MEMBERS.get(community) ?? [];
    const points = slots.map((slot) => field.position[slot] ?? ([0, 0, 0] as const));
    const centre = meanOf(points);
    const radius = points.reduce((acc, p) => acc + distance(p, centre), 0) / Math.max(points.length, 1);
    return { centre, radius };
  });
}

/** Removes the one edge between two nodes, so a claim can ask what it was contributing. */
function cutEdge(graph: GraphDocument, source: string, target: string): void {
  const found = Object.entries(graph.edges).find(
    ([, value]) => value.source.nodeId === source && value.target.nodeId === target,
  );
  if (found === undefined) throw new Error(`no ${source} to ${target} edge`);
  const { [found[0]]: _removed, ...rest } = graph.edges;
  graph.edges = rest;
}

function differingPixels(a: Field, b: Field): number {
  let differing = 0;
  for (let i = 0; i < a.rgba.data.length; i += 4) {
    if (
      a.rgba.data[i] !== b.rgba.data[i] ||
      a.rgba.data[i + 1] !== b.rgba.data[i + 1] ||
      a.rgba.data[i + 2] !== b.rgba.data[i + 2]
    ) {
      differing += 1;
    }
  }
  return differing;
}

describe("E54 Quorum — the operator does both jobs (T1070)", () => {
  it("Dawn is available, or this suite says so rather than skipping", () => {
    expect(dawnError, dawnError ?? "").toBeUndefined();
  });

  it(
    "THE COMMUNITIES ARE RESOLVED: every community's colour scatter is smaller than the gap to its nearest neighbour",
    async () => {
      const field = await renderQuorum();
      const entries = palette(field);
      // The definition of a resolved clustering, not a threshold on one: members agree with
      // each other by MORE than the communities differ. Diffusion 0 (the knob's own zero)
      // leaves the seed noise in place and this inequality reverses, which is the mutation
      // the red-verify pass used.
      for (const community of COMMUNITIES) {
        const own = entries[community];
        if (own === undefined) throw new Error(`community ${community} missing`);
        const nearest = Math.min(
          ...COMMUNITIES.filter((other) => other !== community).map((other) =>
            distance(own.mean, entries[other]?.mean ?? [0, 0, 0]),
          ),
        );
        expect(
          own.scatter,
          `community ${community}: members scatter ${own.scatter.toFixed(4)} about their own colour but the nearest other community is only ${nearest.toFixed(4)} away — the communities have not resolved`,
        ).toBeLessThan(nearest);
      }
    },
    240_000,
  );

  it(
    "THE COLOUR IS FOUND, NOT PAINTED: a different Seed starts the same graph elsewhere and it settles into the SAME palette",
    async () => {
      const a = await renderQuorum({ seed: 54 });
      const b = await renderQuorum({ seed: 907 });

      // ONE: the start really differed. Without this the claim below passes for a graph
      // whose Seed does nothing at all (§V884 — assert both sides, or assert nothing).
      const layoutA = layout(a);
      const layoutB = layout(b);
      const moved = COMMUNITIES.filter((community) => {
        const one = layoutA[community];
        const two = layoutB[community];
        if (one === undefined || two === undefined) return false;
        // A relocation, not a jitter: the centre has to have moved further than the cluster
        // is wide. A seed-independent layout would move it by exactly zero.
        return distance(one.centre, two.centre) > Math.max(one.radius, two.radius);
      });
      expect(
        moved.length,
        `changing Seed relocated ${moved.length} of ${COMMUNITIES.length} communities by more than their own width — the two runs did not really start differently`,
      ).toBeGreaterThanOrEqual(2);

      // TWO: and the palette held. THE CLAIM IS AN ARGMIN, NOT A DISTANCE — each community's
      // settled colour at the other seed is nearer to ITS OWN colour here than to any other
      // community's. That is exactly "the same communities in the same colours", it names no
      // bound, and it is what fails the moment the colour starts following the start: a
      // palette that reshuffles cannot match itself community for community.
      //
      // (An earlier form of this claim compared the four communities' RANK on each channel.
      // It failed honestly, and the failure was the test's fault rather than the example's:
      // two communities settle close enough on one channel that their ORDER can swap while
      // every colour is still where it belongs. A rank is a global statement about four
      // numbers; the property being claimed is per community.)
      const paletteA = palette(a);
      const paletteB = palette(b);
      for (const community of COMMUNITIES) {
        const own = paletteA[community]?.mean ?? ([0, 0, 0] as const);
        const settled = paletteB[community]?.mean ?? ([0, 0, 0] as const);
        const nearest = [...COMMUNITIES].sort(
          (x, y) =>
            distance(settled, paletteA[x]?.mean ?? [0, 0, 0]) - distance(settled, paletteA[y]?.mean ?? [0, 0, 0]),
        )[0];
        expect(
          nearest,
          `community ${community} came back at ${settled.map((v) => v.toFixed(3)).join(", ")}, which is nearer community ${String(nearest)}'s colour (${(paletteA[nearest as number]?.mean ?? [0, 0, 0]).map((v) => v.toFixed(3)).join(", ")}) than its own (${own.map((v) => v.toFixed(3)).join(", ")}) — the palette is following the start, not the graph`,
        ).toBe(community as number);
      }
    },
    480_000,
  );

  it(
    "THE DEGREE IS MEASURED, NOT AUTHORED: the unaffiliated sit EXACTLY on the floor and every community carries hubs above it",
    async () => {
      const field = await renderQuorum();
      const loose = MEMBERS.get(LOOSE) ?? [];
      expect(loose.length, "the block model must actually leave some points unaffiliated").toBeGreaterThan(100);
      for (const slot of loose) {
        // EXACT float equality, and it can be: a point with no community bond adds nothing
        // to the accumulator, so the kernel stores the floor bit for bit. `bound1` splits
        // the graph on this same number, which is why neither of them is a knob.
        expect(field.degree[slot], `slot ${slot} is unaffiliated but carries degree ${String(field.degree[slot])}`).toBe(
          UNLINKED,
        );
      }
      for (const community of COMMUNITIES) {
        const slots = MEMBERS.get(community) ?? [];
        const top = Math.max(...slots.map((slot) => field.degree[slot] ?? 0));
        expect(top, `community ${community} produced no node above the unlinked floor`).toBeGreaterThan(UNLINKED);
      }
    },
    240_000,
  );

  it(
    "CONTRAST 0 IS ONE BLOB: with the background tie weighing what a bond does, the operator cannot see the blocks",
    async () => {
      const shipped = await renderQuorum();
      const flat = await renderQuorum({
        mutate: (graph) => {
          const mesh = graph.nodes["mesh"];
          if (mesh === undefined) throw new Error("no mesh");
          mesh.parameters = { ...mesh.parameters, contrast: 0 };
        },
      });
      const separation = (field: Field): number => {
        const entries = layout(field);
        return Math.min(
          ...COMMUNITIES.flatMap((a) =>
            COMMUNITIES.filter((b) => b > a).map((b) =>
              distance(entries[a]?.centre ?? [0, 0, 0], entries[b]?.centre ?? [0, 0, 0]),
            ),
          ),
        );
      };
      // Comparative and derived: at contrast 0 every pair weighs the same, so the descent has
      // one minimum and the four centroids must sit on top of each other. No bound is named.
      expect(
        separation(flat),
        `contrast 0 still separated the communities by ${separation(flat).toFixed(4)} against the shipped ${separation(shipped).toFixed(4)} — the knob's zero is not the zero it claims`,
      ).toBeLessThan(separation(shipped));
      // And a blob is a different picture, so the knob is reachable from the screen too.
      expect(differingPixels(shipped, flat)).toBeGreaterThan(0);
    },
    480_000,
  );

  it(
    "BOTH LAYERS REACH THE SCREEN: cutting the web, and cutting the haze, each change the frame",
    async () => {
      const shipped = await renderQuorum({ probe: false });
      const noWeb = await renderQuorum({
        probe: false,
        mutate: (graph) => {
          // The filaments ride `sum1`'s variadic Behind port beside the bed; pulling that
          // one edge is literally "what differs if this edge were cut". (Emptying `webs1`'s
          // scene list instead is refused at compile — a Render with no geometry named is an
          // error, not a dark layer.)
          cutEdge(graph, "thread", "sum");
        },
      });
      const noHaze = await renderQuorum({
        probe: false,
        mutate: (graph) => {
          cutEdge(graph, "bed", "sum");
        },
      });
      expect(differingPixels(shipped, noWeb), "cutting thread1 changed nothing — the web is not drawing").toBeGreaterThan(0);
      expect(differingPixels(shipped, noHaze), "cutting bed1 changed nothing — the haze is not compositing").toBeGreaterThan(0);
    },
    480_000,
  );

  it(
    "the shipped kernel really does read its neighbours — T1070's accessor is in the compiled module",
    async () => {
      const { document } = e54();
      expect(document.graph.nodes["mesh"]?.type).toBe("pointKernel");
      const field = await renderQuorum({ probe: false });
      const pass = field.passes.find((entry) => entry.id === "mesh#mesh:kernel");
      expect(pass, "the mesh kernel emitted no pass").toBeDefined();
      // Not decoration: if this example ever loses the neighbour read it stops being a
      // Laplacian and becomes 480 independent points — and every claim above would still
      // have SOMETHING to measure, which is exactly how a silent regression survives.
      expect(pass?.shader).toContain("fn pointAt(slot: u32) -> Point {");
      expect(pass?.shader).toContain("n.position = in_position[slot];");
    },
    240_000,
  );
});
