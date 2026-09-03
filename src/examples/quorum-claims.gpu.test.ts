import { beforeAll, describe, expect, it } from "vitest";
import { pointStorageId } from "../nodes/definitions/point-storage.ts";
import { kernelRegionSlice } from "../nodes/definitions/test-support.ts";

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
/**
 * T1074 — the two ends of E54's own Coupling envelope, in frames, at the shipped 116 bpm
 * (one bar = 124.1 frames, so `cstep1`'s four-bar hold steps at 497).
 *
 * RESTED is the last frame of the opening phrase, where Coupling still sits on its
 * retained 0.449; STRUCK is deep inside the first struck phrase, Coupling eased to 0.95.
 * Both are past the layout's own relaxation, so what is compared is two settled states
 * rather than two points on one transient.
 */
const RESTED = 480;
const STRUCK = 900;
/**
 * T1074 — SIXTY SECONDS, which is the horizon the owner actually judges this file at and
 * roughly four times any gate that existed. 3600 frames at the shipped 60 fps.
 */
const HORIZON = 3600;

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
  /** The frame to stop and read at. Defaults to SETTLE; the strike claims pass their own. */
  at?: number;
}): Promise<Field> {
  const { document } = e54();
  const graph = structuredClone(document.graph) as GraphDocument;
  const mesh = graph.nodes["mesh"];
  if (mesh === undefined) throw new Error("E54 has no mesh node");
  if (options?.seed !== undefined) mesh.parameters = { ...mesh.parameters, seed: options.seed };
  options?.mutate?.(graph);
  const at = options?.at ?? SETTLE;
  const result = (await renderHeadless({
    host: nodeGpuHost(),
    graph,
    settings: { ...document.settings, outputResolution: SIZE },
    frames: at + 1,
    capture: [at],
    fps: 60,
    animate: true,
    ...(options?.probe === false
      ? {}
      // T1076: ONE probe of the mesh kernel's packed buffer; regions sliced below.
      : { probeBuffers: [pointStorageId("mesh")] }),
  } as never)) as never as {
    frames: ReadonlyArray<{ frameIndex: number; width: number; height: number; format: string; bytes: Uint8Array }>;
    plan: {
      outputs: ReadonlyArray<{ nodeId: string; space?: string }>;
      passes: ReadonlyArray<{ id?: string; shader?: string }>;
    };
    buffers?: Record<string, ArrayBuffer>;
  };

  const frame = result.frames.find((entry) => entry.frameIndex === at);
  if (frame === undefined) throw new Error(`no captured frame at ${at}`);
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
  const packed = buffers[pointStorageId("mesh")];
  const meshNode = document.graph.nodes["mesh"] as unknown as {
    type: string;
    parameters: Record<string, unknown>;
  };
  // T1076: every attribute is a region of the mesh kernel's packed buffer, sliced by the
  // schema that kernel declares — one probe, three attributes.
  const attribute = (name: string): Float32Array =>
    packed === undefined ? new Float32Array(0) : kernelRegionSlice(meshNode, packed, name).floats;
  const readVec3 = (name: string): Array<readonly [number, number, number]> => {
    const view = attribute(name);
    if (view.length === 0) return [];
    // §V72: a vec3f strides at SIXTEEN bytes, not twelve — the classic WGSL alignment trap,
    // and reading it as three floats would silently walk this whole assertion off the data.
    return Array.from({ length: CAPACITY }, (_unused, slot) => [
      view[slot * 4] ?? 0,
      view[slot * 4 + 1] ?? 0,
      view[slot * 4 + 2] ?? 0,
    ] as const);
  };
  const degreeView = attribute("degree");

  return {
    position: readVec3("position"),
    tint: readVec3("tint"),
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

  /**
   * ⚑ T1074 — THE STRIKE, GATED WHERE IT ACTUALLY HAPPENS.
   *
   * Every claim above stops at frame 180 and E54's first strike lands at 497, so the whole
   * suite — plus the cook oracle's 80 frames and the thumbnail's single capture — passed a
   * document whose four-bar envelope drove the layout step clean past its own stability
   * limit the moment it fired. The owner's report was "looks okay at first and then
   * suddenly starts to freak out on the first pull-in, and just ends up jittering around
   * like crazy". §V876: pin where the motion has ACCUMULATED, not at frame 0.
   *
   * MEASURED, unclamped, through this same harness on Dawn — mean displacement per point
   * per frame / assembly radius:
   *
   *     frame  180 (rest, coupling 0.449)   0.066 / 0.72
   *     frame  480 (rest, last frame)       0.086 / 0.69
   *     frame  700 (strike, coupling 0.94)  0.562 / 1.83
   *     frame 1200 (strike, coupling 0.95)  0.680 / 2.37
   *
   * With the kernel's Courant bound: 0.003 / 0.76 and 0.0005 / 0.63 respectively — settled
   * at both ends of the envelope.
   *
   * THE TWO CLAIMS ARE A SET (§V884), because either alone passes for the wrong reason. A
   * bound on the motion passes trivially for a kernel that never moves at all; a claim that
   * the strike CHANGES the picture passes just as happily for the explosion. So the strike
   * is asserted to have done something AND to have stayed bounded doing it.
   */
  it(
    "THE STRIKE IS SURVIVABLE: after the four-bar envelope fires, the assembly is still bounded and still moving as one",
    async () => {
      // Frame 900 sits ~400 frames past the first strike (497), with Coupling eased to its
      // 0.95 ceiling — the state every existing gate stopped short of.
      const struck = await renderQuorum({ at: STRUCK });
      const next = await renderQuorum({ at: STRUCK + 1 });

      // ONE — THE COURANT BOUND, which is the kernel's own stated invariant rather than a
      // number chosen to pass: no point may travel further in a frame than 3 % of `reach`,
      // and `reach` is itself bounded above by reach1's own arithmetic (0.85 + 0.3 x the
      // high-band envelope, which cannot exceed 1). So the derived ceiling is exact.
      const travelled = struck.position.map((p, slot) => distance(p, next.position[slot] ?? [0, 0, 0]));
      const worst = Math.max(...travelled);
      const ceiling = (0.85 + 0.3) * 0.03;
      expect(
        worst,
        `a point moved ${worst.toFixed(4)} in one frame at the strike, past the kernel's own ${ceiling.toFixed(4)} Courant bound — the layout step is running past its stability limit`,
      ).toBeLessThan(ceiling);

      // TWO — AND IT IS STILL ONE ASSEMBLY. 1.75 is the kernel's own soft safety radius,
      // quoted from the same source; unclamped this reaches 2.37 and the field is off the
      // frame. Nothing here is a tolerance band: both numbers are read off the kernel.
      const centre = meanOf(struck.position);
      const radius = Math.max(...struck.position.map((p) => distance(p, centre)));
      expect(
        radius,
        `the assembly reached ${radius.toFixed(3)} after the strike, past its own 1.75 safety radius — it has been blown off the frame`,
      ).toBeLessThan(1.75);

      // THREE — AND THE STRIKE ACTUALLY DID SOMETHING, or the two bounds above are just
      // measuring a still life. Comparative and derived, no bound named: raising Coupling
      // tightens each community about its own centre, so every community must be narrower
      // at the strike than at rest. Cut the clag1 -> mesh drive and this is an equality.
      const rested = await renderQuorum({ at: RESTED });
      const wideAtRest = layout(rested).map((entry) => entry.radius);
      const tightAtStrike = layout(struck).map((entry) => entry.radius);
      for (const community of COMMUNITIES) {
        const before = wideAtRest[community] ?? 0;
        const after = tightAtStrike[community] ?? 0;
        expect(
          after,
          `community ${community} measured ${after.toFixed(4)} wide at the strike against ${before.toFixed(4)} at rest — Coupling's envelope is not reaching the layout`,
        ).toBeLessThan(before);
      }
    },
    900_000,
  );

  /**
   * ⚑ T1074 — THE MINUTE, and what it does and does not claim.
   *
   * The strike gate above reaches 15 s. The owner's bar is a MINUTE, and a 15-second gate
   * cannot see something that dies at 60 — so this one goes to 3600 frames.
   *
   * WHAT IS NOT CLAIMED, stated first so nobody reads it in: this example CONVERGES. Mean
   * displacement is 0.0008/frame at the minute mark against 0.0006 at fifteen seconds — it
   * is a settling field, not a perpetual one, and asserting "still moving" here would be a
   * false claim about a real behaviour. The measured reason is recorded in the document:
   * `reach` weights ONE operator that is read twice, so nothing can keep the layout stirred
   * without stirring the colour by the same amount, and the palette margin goes negative
   * before the extra motion becomes visible.
   *
   * WHAT IS CLAIMED is the three ways a minute can go wrong that fifteen seconds cannot see:
   * a slow instability, a slow colour collapse, and a picture that has simply STOPPED
   * responding to its own envelope. The third is the live one — Coupling comes off its 0.95
   * ceiling during the third phrase, and a converged layout still has to widen when it does.
   */
  it(
    "AT SIXTY SECONDS it is still bounded, still resolved, and still answering the phrase",
    async () => {
      const late = await renderQuorum({ at: HORIZON });

      // ONE — no slow instability. The kernel's own safety radius again, not a new number.
      const centre = meanOf(late.position);
      const radius = Math.max(...late.position.map((p) => distance(p, centre)));
      expect(
        radius,
        `after a minute the assembly reached ${radius.toFixed(3)}, past its own 1.75 safety radius`,
      ).toBeLessThan(1.75);

      // TWO — no slow colour collapse. The same inequality the headline claim makes at 180,
      // asserted again four hundred frames after the colour could have quietly greyed out.
      const entries = palette(late);
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
          `after a minute community ${community} scatters ${own.scatter.toFixed(4)} against a nearest gap of ${nearest.toFixed(4)} — the palette has decayed`,
        ).toBeLessThan(nearest);
      }

      // THREE — AND IT IS STILL AN INSTRUMENT AT THE MINUTE MARK, asked the only way that
      // actually answers it: WHAT DIFFERS IF THE EDGE WERE CUT. The same frame rendered with
      // Coupling pinned to the retained static the drive would have replaced (§V108) must be
      // a DIFFERENT layout — if the phrase lane had gone dead by 3600, the two would agree.
      //
      // An earlier form of this compared the minute against the strike and asserted the
      // assembly had widened. It passed with the drive CUT, because the layout goes on
      // relaxing outward on its own — it was measuring slow relaxation and calling it the
      // envelope (§V870: a gate nobody has watched fail is not a gate).
      const cut = await renderQuorum({
        at: HORIZON,
        mutate: (graph) => {
          const mesh = graph.nodes["mesh"];
          if (mesh === undefined) throw new Error("no mesh");
          mesh.parameters = { ...mesh.parameters, coupling: 0.85 };
        },
      });
      const spread = (field: Field): number => {
        const entries2 = layout(field);
        const gaps = COMMUNITIES.flatMap((a) =>
          COMMUNITIES.filter((b) => b > a).map((b) =>
            distance(entries2[a]?.centre ?? [0, 0, 0], entries2[b]?.centre ?? [0, 0, 0]),
          ),
        );
        return gaps.reduce((sum, gap) => sum + gap, 0) / gaps.length;
      };
      // The scale is the SYSTEM'S OWN, not a number chosen here: by the minute mark the
      // field is settling at a measured rate per frame, and a drive whose removal moved the
      // layout by less than one frame of that settling would be indistinguishable from the
      // drift. So the cut has to matter more than a frame does. (It matters ~65x more, which
      // is the margin, not the claim.)
      const nextLate = await renderQuorum({ at: HORIZON + 1 });
      const settling =
        late.position.reduce((sum, p, slot) => sum + distance(p, nextLate.position[slot] ?? [0, 0, 0]), 0) /
        late.position.length;
      const moved = Math.abs(spread(late) - spread(cut));
      expect(
        moved,
        `at sixty seconds the driven layout sits ${spread(late).toFixed(3)} apart and the Coupling-cut one ${spread(cut).toFixed(3)} — a difference of ${moved.toFixed(5)}, against ${settling.toFixed(5)} of settling in a single frame. The phrase lane has stopped reaching the picture.`,
      ).toBeGreaterThan(settling);
    },
    900_000,
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
      // T1076: the neighbour's position comes through the packed READ half's accessor.
      expect(pass?.shader).toContain("n.position = pointLoad_position(slot);");
    },
    240_000,
  );
});
