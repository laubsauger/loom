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
 * E54 QUORUM — THE CLAIMS (T1070, REWRITTEN T1138 WHEN THE OPERATOR WAS REPLACED).
 *
 * The example's assertion is no longer "one Laplacian lays the graph out and colours it".
 * It is: THREE ARMIES DEPOSIT INTO ONE TRAIL FIELD, STEER BY IT, AND NEVER STOP TAKING
 * GROUND OFF EACH OTHER. Every claim below is one clause of that, and the load-bearing one
 * is the LAG PROFILE — because a churn number cannot tell reorganisation from a 2-cycle, and
 * T1074 shipped a candidate whose churn looked healthy and whose lag profile read
 * "12–15 flips at every odd lag, exactly 0 at +2, +4, +8, +16".
 *
 * WHERE THE CLAIMS ARE MADE. Membership and the deposit are asserted on the point buffers
 * the kernel writes, with the partition RE-DERIVED here from the same identity hash the WGSL
 * uses, so this file knows the answer without reading it out of the picture it is judging.
 * Territory is asserted on the TRAIL FIELD, captured through the real plan on Dawn, because
 * territory is a property of the ground rather than of any agent.
 *
 * ⚑ AND §V912 IS WHY THE FRONTIER CLAIM IS A PIXEL CLAIM. Nine sessions measured this file's
 * frontier as a COUNT over pairs; a count can rise 3.6x with the picture visually identical,
 * because a pair sitting where the picture already had ink adds a number and no pixel. So
 * the front is DRAWN (`front1`), and what is asserted is that cutting it changes the frame.
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

/** The trail grid's own resolution — reading the field at anything else resamples it. */
const FIELD = { width: 1280, height: 720 };
/** The trail grid, square because the agents' space is isotropic — see the kernel. */
const GRID = { width: 288, height: 288 };
/** The population, read off the shipped kernel rather than retyped. */
const AGENTS = 3000;
/** The fraction `bound1` parks all but — the half the picture draws. */
const DRAWN_SHARE = 0.5;
/**
 * SIXTY SECONDS, the horizon the owner judges this file at: 3600 frames at 60 fps. The lag
 * profile has to reach it, because "does not settle" is a claim about the long run and every
 * gate this file ever had that stopped at frame 180 passed on a file that died at second 60.
 */
const HORIZON = 3600;
/** A base frame late enough that the opening three colonies have long since met. */
const BASE = 1800;
/** Lags, in frames. Powers of two through +32 are what refutes a 2-cycle (§T1074). */
const LAGS = [1, 2, 4, 8, 16, 32, 60, 120, 240] as const;
/** Past +240 the profile is at the independence ceiling and wanders; asserted separately. */
const TAIL_LAGS = [480, 960] as const;
/** Out of 255 on the graded field: below this a texel holds no trail worth owning. */
const TRAIL_FLOOR = 10;

/*
 * THE ARMIES, RE-DERIVED — the same arithmetic the kernel's `idHash` / `foundingOf` perform,
 * in u32 semantics. `Math.imul` is not a convenience here: it is the only way to get WGSL's
 * wrapping 32-bit multiply out of JavaScript's doubles, and without it this file would
 * disagree with the shader about which agent is in which army.
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

/** 0, 1, 2 — the channel this agent deposits into, for life. */
function armyOf(id: number): number {
  const r = idRand(id, 101);
  if (r < 0.42) return 0;
  if (r < 0.76) return 1;
  return 2;
}

const ARMIES = [0, 1, 2] as const;

interface Shot {
  /** Per captured frame: the trail field as RGBA8, in capture order. */
  readonly field: ReadonlyArray<{ width: number; height: number; data: Uint8Array }>;
  /** Per slot: banner r, g, b — the one-hot army. Empty when buffers were not probed. */
  readonly banner: ReadonlyArray<readonly [number, number, number]>;
  /** Per slot: sense x, y, z, w. Empty when buffers were not probed. */
  readonly sense: ReadonlyArray<readonly [number, number, number, number]>;
}

async function shoot(options: {
  readonly capture: readonly number[];
  /** Which node's texture to read. `spread` is the trail field; `out` is the frame. */
  readonly node?: string;
  readonly mutate?: (graph: GraphDocument) => void;
  readonly buffers?: boolean;
}): Promise<Shot> {
  const { document } = e54();
  const graph = structuredClone(document.graph) as GraphDocument;
  options.mutate?.(graph);
  const node = options.node ?? "spread";
  const last = Math.max(...options.capture);
  const result = (await renderHeadless({
    host: nodeGpuHost(),
    graph,
    settings: { ...document.settings, outputResolution: options.node === undefined ? GRID : FIELD },
    frames: last + 1,
    capture: [...options.capture],
    outputNodeId: node,
    fps: 60,
    animate: true,
    ...(options.buffers === true ? { probeBuffers: [pointStorageId("mesh")] } : {}),
  } as never)) as never as {
    frames: ReadonlyArray<{ frameIndex: number; width: number; height: number; format: string; bytes: Uint8Array }>;
    plan: { outputs: ReadonlyArray<{ nodeId: string; space?: string }> };
    buffers?: Record<string, ArrayBuffer>;
  };

  const space = result.plan.outputs.find((output) => output.nodeId === node)?.space ?? "linear";
  const field = options.capture.map((at) => {
    const frame = result.frames.find((entry) => entry.frameIndex === at);
    if (frame === undefined) throw new Error(`no captured frame at ${at}`);
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
    return { width: image.width, height: image.height, data: image.data };
  });

  const packed = result.buffers?.[pointStorageId("mesh")];
  if (packed === undefined) return { field, banner: [], sense: [] };
  const meshNode = document.graph.nodes["mesh"] as unknown as { type: string; parameters: Record<string, unknown> };
  const bannerView = kernelRegionSlice(meshNode, packed, "banner").floats;
  const senseView = kernelRegionSlice(meshNode, packed, "sense").floats;
  return {
    field,
    banner: Array.from({ length: AGENTS }, (_u, slot) =>
      [bannerView[slot * 4] ?? 0, bannerView[slot * 4 + 1] ?? 0, bannerView[slot * 4 + 2] ?? 0] as const),
    sense: Array.from({ length: AGENTS }, (_u, slot) =>
      [senseView[slot * 4] ?? 0, senseView[slot * 4 + 1] ?? 0, senseView[slot * 4 + 2] ?? 0, senseView[slot * 4 + 3] ?? 0] as const),
  };
}

/** Who owns each texel: the largest channel, or −1 where the trail is below the floor. */
function ownership(image: { data: Uint8Array }): Int8Array {
  const own = new Int8Array(image.data.length / 4);
  for (let p = 0, at = 0; p < own.length; p += 1, at += 4) {
    const r = image.data[at] ?? 0;
    const g = image.data[at + 1] ?? 0;
    const b = image.data[at + 2] ?? 0;
    if (r + g + b < TRAIL_FLOOR) { own[p] = -1; continue; }
    own[p] = r >= g ? (r >= b ? 0 : 2) : (g >= b ? 1 : 2);
  }
  return own;
}

/** Of the texels ALIVE IN BOTH, what fraction changed hands. */
function changedHands(a: Int8Array, b: Int8Array): { fraction: number; both: number } {
  let both = 0;
  let flipped = 0;
  for (let p = 0; p < a.length; p += 1) {
    if ((a[p] ?? -1) < 0 || (b[p] ?? -1) < 0) continue;
    both += 1;
    if (a[p] !== b[p]) flipped += 1;
  }
  return { fraction: both === 0 ? 0 : flipped / both, both };
}

/** Each army's share of the living ground. */
function territory(own: Int8Array): [number, number, number] {
  const count = [0, 0, 0];
  let live = 0;
  for (let p = 0; p < own.length; p += 1) {
    const o = own[p] ?? -1;
    if (o < 0) continue;
    live += 1;
    count[o] = (count[o] ?? 0) + 1;
  }
  return [count[0]! / Math.max(live, 1), count[1]! / Math.max(live, 1), count[2]! / Math.max(live, 1)];
}

function liveTexels(own: Int8Array): number {
  let live = 0;
  for (let p = 0; p < own.length; p += 1) if ((own[p] ?? -1) >= 0) live += 1;
  return live;
}

/** Fraction of live texels where the runner-up channel is at least half the leader. */
function contestedFraction(image: { data: Uint8Array }): number {
  let live = 0;
  let contested = 0;
  for (let at = 0; at < image.data.length; at += 4) {
    const c = [image.data[at] ?? 0, image.data[at + 1] ?? 0, image.data[at + 2] ?? 0].sort((x, y) => y - x);
    if (c[0]! + c[1]! + c[2]! < TRAIL_FLOOR) continue;
    live += 1;
    if (c[1]! >= 0.5 * c[0]!) contested += 1;
  }
  return live === 0 ? 0 : contested / live;
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

/** Detach a driven slot and hold the parameter at a constant. */
function pin(graph: GraphDocument, nodeId: string, key: string, value: number): void {
  const node = graph.nodes[nodeId];
  if (node === undefined) throw new Error(`no node "${nodeId}"`);
  if (node.parameters?.[key] === undefined) throw new Error(`no parameter "${key}" on "${nodeId}"`);
  node.parameters = { ...node.parameters, [key]: value };
}

function differingPixels(a: { data: Uint8Array }, b: { data: Uint8Array }): number {
  let differing = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    if (a.data[i] !== b.data[i] || a.data[i + 1] !== b.data[i + 1] || a.data[i + 2] !== b.data[i + 2]) differing += 1;
  }
  return differing;
}

describe("E54 Quorum — three slime molds and one piece of ground (T1138)", () => {
  it("Dawn is available, or this suite says so rather than skipping", () => {
    expect(dawnError, dawnError ?? "").toBeUndefined();
  });

  it(
    "IT DOES NOT SETTLE: territory turnover is MONOTONE in the lag out to the sixty-second horizon, and the plateau is the shares' own Simpson index",
    { timeout: 300_000 },
    async () => {
      expect(dawnError, dawnError ?? "").toBeUndefined();
      const capture = [BASE, ...LAGS.map((lag) => BASE + lag), ...TAIL_LAGS.map((lag) => BASE + lag)];
      const shot = await shoot({ capture });
      const owners = shot.field.map(ownership);
      const base = owners[0];
      if (base === undefined) throw new Error("no base frame");

      const profile = LAGS.map((lag, index) => ({ lag, ...changedHands(base, owners[index + 1]!) }));
      const tail = TAIL_LAGS.map((lag, index) => ({ lag, ...changedHands(base, owners[LAGS.length + 1 + index]!) }));
      const label = [...profile, ...tail].map((row) => `+${row.lag} ${(100 * row.fraction).toFixed(1)}%`).join("  ");

      /* (a) EVERY LAG THROUGH +240 SEES MORE TURNOVER THAN THE ONE BEFORE IT. That single
         shape is what separates the three things a churn number cannot tell apart:
           settled      — every entry ~0;
           a 2-cycle    — odd lags flicker, EVEN lags read exactly 0 (T1074 measured one);
           reorganising — monotone, which is this.
         Measured on the shipped bytes from f1800: 1.9 / 3.7 / 7.0 / 13.4 / 20.8 / 26.5 /
         33.8 / 43.2 / 57.2 %. The former operator's own number at every one of these lags
         was 0 of 350 membership changes, from f180 to f3600. */
      for (let index = 1; index < profile.length; index += 1) {
        const previous = profile[index - 1]!;
        const current = profile[index]!;
        expect(
          current.fraction,
          `turnover fell from +${previous.lag} to +${current.lag} — the profile is not monotone: ${label}`,
        ).toBeGreaterThan(previous.fraction);
      }

      /* (b) AND IT IS NOT FLICKER, said the way §T1074 learned to say it: a 2-cycle reads
         EXACTLY ZERO at every even lag. Here the even lags are the larger entries. */
      for (const even of [2, 4, 8, 16, 32] as const) {
        const row = profile.find((entry) => entry.lag === even)!;
        expect(row.fraction, `+${even} is a 2-cycle's zero, not reorganisation: ${label}`).toBeGreaterThan(0.02);
      }

      /* (c) THE CEILING IS DERIVED, NOT CHOSEN (§V147). If ownership at a long lag were
         statistically INDEPENDENT of ownership at the base, the fraction that changed hands
         would be exactly 1 − Σpᵢ², the Simpson index of the shares themselves — so the
         profile CANNOT climb past that, and past +240 it stops climbing and wanders around
         it instead. Asserting more monotonicity there would be asserting a system exceed its
         own ceiling. What is asserted is that the tail STAYS decorrelated rather than
         recohering, which is what a system falling back toward a fixed point would do. */
      const simpson = (shares: readonly [number, number, number]): number =>
        1 - shares.reduce((total, p) => total + p * p, 0);
      const independent = simpson(territory(base));
      const longest = profile[profile.length - 1]!;
      expect(longest.fraction, `turnover cannot exceed independence ${independent.toFixed(3)}: ${label}`).toBeLessThan(independent + 0.05);
      for (const row of tail) {
        expect(
          row.fraction,
          `at +${row.lag} the picture has RE-COHERED toward where it was — that is a system falling back to a fixed point: ${label}`,
        ).toBeGreaterThan(0.55 * independent);
        expect(row.fraction, `turnover cannot exceed independence ${independent.toFixed(3)}: ${label}`).toBeLessThan(independent + 0.05);
      }
    },
  );

  it(
    "NO ARMY IS EVER WIPED OUT: all three hold ground at every quarter of the minute, and the lead changes hands",
    { timeout: 300_000 },
    async () => {
      expect(dawnError, dawnError ?? "").toBeUndefined();
      const marks = [900, 1800, 2700, HORIZON];
      const shot = await shoot({ capture: marks });
      const shares = shot.field.map((image) => territory(ownership(image)));
      const label = shares.map((s, i) => `f${marks[i]} ${s.map((v) => (100 * v).toFixed(0)).join("/")}`).join("  ");

      /* T1074 measured a label-propagation variant reaching MONOPOLY — [350, 0, 0, 0] by
         frame 2100 — and T1119 measured envoy conquest annihilating the smaller party. The
         reason neither can happen here is structural rather than tuned: membership is fixed,
         so an army can lose all its ground and still be walking on it. */
      for (const [index, share] of shares.entries()) {
        for (const army of ARMIES) {
          expect(share[army], `army ${army} was wiped out at f${marks[index]}: ${label}`).toBeGreaterThan(0.12);
        }
      }

      /* And the ground genuinely moves: the LEADER is not the same army at every mark. */
      const leaders = shares.map((share) => share.indexOf(Math.max(...share)));
      expect(new Set(leaders).size, `one army led at every mark — the ground is not moving: ${label}`).toBeGreaterThan(1);
    },
  );

  it(
    "THE ARMIES ARE THE ONLY AUTHORED THING, AND MEMBERSHIP NEVER CHANGES: every agent's banner is its founding one-hot, exactly, a minute in",
    { timeout: 300_000 },
    async () => {
      expect(dawnError, dawnError ?? "").toBeUndefined();
      const shot = await shoot({ capture: [HORIZON], buffers: true });
      expect(shot.banner.length, "no packed point buffer came back").toBe(AGENTS);

      /* EXACT, not a band (§V147): `banner` is written once at firstRun and never touched,
         so after 3600 frames every component is still exactly 1 or exactly 0 — which is what
         makes a trail ONE clean colour and territory the only thing an army can lose. A
         converting agent (allegiance on the simplex) was built and cut; this is the
         assertion that says the cut held. */
      const counted = [0, 0, 0];
      for (let slot = 0; slot < AGENTS; slot += 1) {
        const banner = shot.banner[slot]!;
        const army = armyOf(slot);
        for (const channel of ARMIES) {
          expect(
            banner[channel],
            `slot ${slot} is army ${army} but its banner reads ${banner.join(", ")} at f${HORIZON}`,
          ).toBe(channel === army ? 1 : 0);
        }
        counted[army] = (counted[army] ?? 0) + 1;
      }

      /* §V854's lopsided block model, asserted as the count it actually produces rather than
         as the nominal 42/34/24 — a hash is not a uniform draw and pretending otherwise is
         how a partition claim quietly becomes a tolerance. */
      expect(counted.reduce((a, b) => a + b, 0)).toBe(AGENTS);
      for (const army of ARMIES) expect(counted[army]).toBeGreaterThan(0.2 * AGENTS);
      expect(counted[0], "army 0 is the largest, by construction").toBeGreaterThan(counted[1]!);
      expect(counted[1], "army 1 is the middle one, by construction").toBeGreaterThan(counted[2]!);
    },
  );

  it(
    "THE TRAIL IS THE MECHANISM: hold the deposit at zero and the field is EXACTLY empty; cut the sensing and the kernel refuses by name",
    { timeout: 300_000 },
    async () => {
      expect(dawnError, dawnError ?? "").toBeUndefined();

      /* (a) NOTHING ON SCREEN IS PAINTED. `trail1` clears to (0,0,0,0) and the only thing
         that ever adds to it is `sow1` through `mix1`'s front, so with that front held at
         zero the field is not "dim" or "mostly dark" — it is EXACTLY zero at every texel, at
         a frame where the shipped file is a full network. That is the whole loop asserted in
         one comparison. (Held at zero rather than unwired because Composite's `in2` is a
         REQUIRED port: cutting it is a document that does not compile, which would assert
         something about the compiler instead of about this file.) */
      const cut = await shoot({ capture: [600], mutate: (graph) => pin(graph, "mix", "opacity", 0) });
      const cutField = cut.field[0]!;
      let peak = 0;
      for (let at = 0; at < cutField.data.length; at += 4) {
        peak = Math.max(peak, cutField.data[at] ?? 0, cutField.data[at + 1] ?? 0, cutField.data[at + 2] ?? 0);
      }
      expect(peak, "with the deposit held at zero, some texel still holds trail").toBe(0);

      const whole = await shoot({ capture: [600] });
      expect(liveTexels(ownership(whole.field[0]!)), "the shipped file has no trail at f600").toBeGreaterThan(20_000);

      /* (b) AND THE SENSING IS NOT OPTIONAL — refused BY NAME rather than degrading to a
         random walk that would still render something plausible (§V288/T477). This is the
         legitimate case the guard could swallow, exercised: the kernel calls `fieldAt`, so a
         document with the field edge missing must not compile at all. */
      const { document } = e54();
      const graph = structuredClone(document.graph) as GraphDocument;
      cutEdge(graph, "spread", "mesh");
      await expect(
        renderHeadless({
          host: nodeGpuHost(),
          graph,
          settings: { ...document.settings, outputResolution: GRID },
          frames: 2,
          capture: [1],
          outputNodeId: "out",
          fps: 60,
          animate: true,
        } as never),
      ).rejects.toThrow(/fieldAt/);
    },
  );

  it(
    "ENVOY IS A PICTURE AND NOT A NUANCE: pinned at its clamp's two bounds the front is half again as wide and the trail nearly twice as long",
    { timeout: 300_000 },
    async () => {
      expect(dawnError, dawnError ?? "").toBeUndefined();
      /* §T1079's bar taken literally — what differs if the edge were cut. The lane is
         DETACHED and held at each end of its own limiter, so this compares the two pictures
         the shipped envelope actually walks between rather than two arbitrary settings. */
      const keep = await shoot({ capture: [BASE], mutate: (graph) => pin(graph, "mesh", "envoy", -0.55) });
      const meet = await shoot({ capture: [BASE], mutate: (graph) => pin(graph, "mesh", "envoy", -0.05) });

      const keepContested = contestedFraction(keep.field[0]!);
      const meetContested = contestedFraction(meet.field[0]!);
      const keepLive = liveTexels(ownership(keep.field[0]!));
      const meetLive = liveTexels(ownership(meet.field[0]!));
      const label =
        `floor: ${keepLive} live, ${(100 * keepContested).toFixed(1)}% contested; ` +
        `ceiling: ${meetLive} live, ${(100 * meetContested).toFixed(1)}% contested`;

      /* Measured on the shipped bytes at f1800: 100 653 live and 20.8 % contested at the
         floor against 42 357 and 13.4 % at the ceiling. Hard avoidance keeps three separate
         networks that interleave finely; weak avoidance lets the armies share cables, which
         is FEWER cables. Both bounds are a picture — which is why neither end of this lane
         is silence (§V903), and it is the thing the former file's disturbance gate could not
         say about its own floor. */
      expect(keepContested, `envoy does not change the front: ${label}`).toBeGreaterThan(1.3 * meetContested);
      expect(keepLive, `envoy does not change how much trail there is: ${label}`).toBeGreaterThan(1.2 * meetLive);
    },
  );

  it(
    "THE DEPOSIT IS BOUNDED ON PURPOSE: additive clips several times as much of the trail as alpha, and a clipped trail has no gradient left in it",
    { timeout: 300_000 },
    async () => {
      expect(dawnError, dawnError ?? "").toBeUndefined();
      /* A trail answers "is this path walked", which is BOUNDED — twenty agents standing
         together cannot leave twenty times the scent. Additive they do, and the consequence
         is mechanical rather than cosmetic: a saturated texel has NO GRADIENT, so the three
         sensors of every agent crossing a busy trunk read the same number and the steering
         rule has nothing to answer.

         ⚠ AND THE CLAIM IS WHAT WAS MEASURED, NOT WHAT WAS EXPECTED, TWICE. The first form
         of this test asserted that additive COLLAPSES the network, on the strength of an
         observation made at a different decay and deposit; measured against the shipped
         bytes that is false — additive carries MORE live trail, just blown out. The second
         form asserted alpha clips EXACTLY ZERO texels, which was true at one deposit setting
         and stopped being true at the shipped one. What survives both corrections is the
         RATIO, which is the thing the blend mode actually controls. */
      const shipped = await shoot({ capture: [BASE] });
      const additive = await shoot({
        capture: [BASE],
        mutate: (graph) => {
          const sow = graph.nodes["sow"];
          if (sow === undefined) throw new Error("no sow node");
          sow.parameters = { ...sow.parameters, blend: "additive" };
        },
      });
      const clipped = (image: { data: Uint8Array }): number => {
        let count = 0;
        for (let at = 0; at < image.data.length; at += 4) {
          if (Math.max(image.data[at] ?? 0, image.data[at + 1] ?? 0, image.data[at + 2] ?? 0) >= 250) count += 1;
        }
        return count;
      };
      const shippedClipped = clipped(shipped.field[0]!);
      const additiveClipped = clipped(additive.field[0]!);
      expect(
        additiveClipped,
        `additive did not blow the trail out: alpha ${shippedClipped} clipped texels, additive ${additiveClipped}`,
      ).toBeGreaterThan(2 * shippedClipped);
    },
  );

  it(
    "THE WEB IS A NETWORK THAT KEEPS REARRANGING: it covers the frame, and the links it draws decorrelate steadily with the lag",
    { timeout: 300_000 },
    async () => {
      expect(dawnError, dawnError ?? "").toBeUndefined();
      /* ⚑ THE CLAIM THE OWNER ACTUALLY MADE, ASSERTED AS PIXELS. The first cut of this
         rework kept the trail physics and drew the agents as bare particles; he said
         "we don't see these networks that are disintegrating and integrating — the different
         units are like tiny specks now", and he was right: a trail rendered as its own
         agents has no relationships in it to watch. So `web1` draws the links, and what is
         asserted is that they are THERE and that they KEEP CHANGING.

         `webs1` is the link layer alone — no nodes, no haze, no glow — so this measures the
         web and nothing else. Jaccard over lit pixels: how much of the union of two frames'
         webs is in both. A settled web holds near 1 at every lag; a re-drawn one falls. */
      const lags = [0, 8, 60, 240] as const;
      const shot = await shoot({ capture: lags.map((lag) => BASE + lag), node: "webs" });
      const lit = shot.field.map((image) => {
        const on = new Uint8Array(image.data.length / 4);
        let count = 0;
        for (let p = 0, at = 0; p < on.length; p += 1, at += 4) {
          if (Math.max(image.data[at] ?? 0, image.data[at + 1] ?? 0, image.data[at + 2] ?? 0) >= 24) { on[p] = 1; count += 1; }
        }
        return { on, count };
      });
      const base = lit[0]!;

      /* THE WEB EXISTS AND IT SPANS THE FRAME. Not "some links were drawn": the beams are
         thin, so this is a floor on ink rather than on area — but a web that had collapsed to
         a few bead chains, which is what every count below about six hundred drawn nodes
         produced, does not reach it. */
      expect(base.count, `the drawn web covers only ${base.count} pixels — that is not a network`).toBeGreaterThan(6_000);

      const jaccard = lit.slice(1).map((later, index) => {
        let both = 0;
        let either = 0;
        for (let p = 0; p < base.on.length; p += 1) {
          const a = base.on[p] === 1;
          const b = later.on[p] === 1;
          if (a || b) either += 1;
          if (a && b) both += 1;
        }
        return { lag: lags[index + 1]!, overlap: either === 0 ? 0 : both / either };
      });
      const label = jaccard.map((row) => `+${row.lag} ${(100 * row.overlap).toFixed(1)}%`).join("  ");

      /* AND IT KEEPS BREAKING. Each longer lag shares LESS of its web with the base than the
         one before — links form and break continuously rather than settling into a fixed
         adjacency, which is exactly what the former operator's web did (T1074: 0 of 350
         membership changes and a frontier of 0 from f900 on). By four seconds almost none of
         the web is the same web. */
      for (let index = 1; index < jaccard.length; index += 1) {
        expect(
          jaccard[index]!.overlap,
          `the web at +${jaccard[index]!.lag} shares MORE with the base than at +${jaccard[index - 1]!.lag} — it is settling: ${label}`,
        ).toBeLessThan(jaccard[index - 1]!.overlap);
      }
      expect(
        jaccard[jaccard.length - 1]!.overlap,
        `four seconds on, ${(100 * jaccard[jaccard.length - 1]!.overlap).toFixed(1)} % of the web is unchanged — that is a settled adjacency: ${label}`,
      ).toBeLessThan(0.2);
    },
  );

  it(
    "THE FRONTIER IS DRAWN, NOT COUNTED (§V912): the contested caste is a minority of the population and cutting it changes the frame",
    { timeout: 300_000 },
    async () => {
      expect(dawnError, dawnError ?? "").toBeUndefined();
      const shot = await shoot({ capture: [BASE], node: "out", buffers: true });
      expect(shot.sense.length, "no packed point buffer came back").toBe(AGENTS);

      /* The caste `front1` draws is `p.sense.y > 0.45` — agents where less than 55 % of the
         trail underneath is their own army's. It has to be a MINORITY or it is not a front
         line, it is the whole population; and it has to be non-empty or the layer is a
         decoration that never fires (§V471.8's failure shape). */
      let caste = 0;
      let drawn = 0;
      for (let slot = 0; slot < AGENTS; slot += 1) {
        if (shot.sense[slot]![2] > DRAWN_SHARE) continue; // parked by bound1, never drawn
        drawn += 1;
        if (shot.sense[slot]![1] > 0.45) caste += 1;
      }
      const share = caste / Math.max(drawn, 1);
      expect(share, `the contested caste is empty at f${BASE}`).toBeGreaterThan(0.02);
      expect(share, `the contested caste is the whole population at f${BASE} — that is not a front`).toBeLessThan(0.6);

      /* And it reaches the screen. A count over pairs can triple with the picture unchanged;
         a layer that is drawn cannot, and this is the difference stated as pixels. */
      /* Dropped from `nodes1`'s scene list rather than unwired — Render names its scenes by
         string, so this is the document saying "do not draw that layer" in its own terms. */
      const without = await shoot({
        capture: [BASE],
        node: "out",
        mutate: (graph) => {
          const render = graph.nodes["nodes"];
          if (render === undefined) throw new Error("no nodes render");
          if (render.parameters?.["scenes"] !== "dots1 frontdots1") throw new Error("nodes1 no longer draws frontdots1");
          render.parameters = { ...render.parameters, scenes: "dots1" };
        },
      });
      const differing = differingPixels(shot.field[0]!, without.field[0]!);
      expect(
        differing,
        `silencing frontdots1 changed ${differing} of ${FIELD.width * FIELD.height} pixels — the frontier layer is not on screen`,
      ).toBeGreaterThan(0.02 * FIELD.width * FIELD.height);
    },
  );

  it(
    "THE CENTRE IS NOT A VACUUM: the middle of the frame holds as much trail as the ring around it, which is the complaint this rework answers",
    { timeout: 300_000 },
    async () => {
      expect(dawnError, dawnError ?? "").toBeUndefined();
      /* THE OWNER'S OWN WORDS ABOUT THE FORMER FILE: "the centre area between the clusters
         acts like a vacuum that no one can enter". It was true and it was structural —
         §T1079's background tie plus Coulomb push plus recentre puts equal clusters ON A
         SHELL, and §T1133 found the strike was tangential so nothing was ever aimed through
         the middle. Here there is no shell and no aim: agents follow gradients, and a
         gradient runs wherever a trail does.

         Measured as DENSITY PER TEXEL so the two regions are comparable despite the annulus
         having four times the area — the mistake a raw count would make. */
      const marks = [900, BASE, 2700, HORIZON];
      const shot = await shoot({ capture: marks });
      for (const [index, image] of shot.field.entries()) {
        const own = ownership(image);
        let inner = 0;
        let innerLive = 0;
        let outer = 0;
        let outerLive = 0;
        for (let y = 0; y < image.height; y += 1) {
          for (let x = 0; x < image.width; x += 1) {
            /* Distance from the middle in HALF-HEIGHTS, the same unit the kernel's own rim
               fence is stated in, so "the centre" here means what it means in the WGSL. */
            const dx = (x / image.width - 0.5) * 2 * (image.width / image.height);
            const dy = (y / image.height - 0.5) * 2;
            const radius = Math.hypot(dx, dy);
            if (radius > 0.95) continue;
            const live = (own[y * image.width + x] ?? -1) >= 0 ? 1 : 0;
            if (radius < 0.4) { inner += 1; innerLive += live; } else { outer += 1; outerLive += live; }
          }
        }
        const innerDensity = innerLive / Math.max(inner, 1);
        const outerDensity = outerLive / Math.max(outer, 1);
        expect(
          innerDensity,
          `at f${marks[index]} the centre holds ${(100 * innerDensity).toFixed(1)} % live trail against the ring's ${(100 * outerDensity).toFixed(1)} % — the middle is emptying again`,
        ).toBeGreaterThan(0.75 * outerDensity);
      }
    },
  );
});
