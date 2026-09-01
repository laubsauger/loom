import { beforeAll, describe, expect, it } from "vitest";

import { nodeGpuHost, probeDawn } from "../runtime/backend/vgpu/node-gpu-host.ts";
import { toRgba8 } from "../runtime/export/image.ts";
import { BYTES_PER_PIXEL } from "../runtime/export/pixel-format.ts";
import type { GraphDocument } from "../domain/types/graph.ts";
import { renderHeadless } from "../tests/headless/render-harness.ts";
import { listExamples } from "./catalogue.ts";
import { requireExample } from "./runner.ts";

/**
 * T749 — E43's claims. The two that matter most:
 *
 * THE IDENTITY (§V147, extended to USER WGSL for the first time): every stock node in
 * this project proves its no-op; user shader code never had to. At amount = 0 the
 * splice kernel's every read collapses to a textureLoad at the pixel's own integer
 * coordinate, so the assertion is BYTE-IDENTITY against the untouched source — not
 * closeness, identity. This claim is the pattern for every custom shader written here
 * afterwards.
 *
 * THE QUANTISATION (§V681): the glitch re-deals on a 3/s clock and is FROZEN between
 * ticks. On a pinned-static source, two frames inside one deal are byte-identical and
 * two frames across a tick differ. That is a claim about rhythm — glitch that holds
 * and slams versus glitch that wobbles — and no still frame or look baseline can see
 * it (§V712/§V717).
 */

function e43() {
  const file = listExamples().find((entry) => entry.fileName === "E43-Splice.loom.json");
  if (file === undefined) throw new Error("E43-Splice.loom.json is not shipped");
  return requireExample(file);
}

let dawnError: string | undefined;
beforeAll(async () => {
  dawnError = (await probeDawn()).error;
}, 60_000);

interface Frame {
  readonly w: number;
  readonly h: number;
  readonly d: Uint8Array | Uint8ClampedArray;
}

/** Rewire the output straight to `node` — one stage under the microscope. */
function solo(node: string): (graph: GraphDocument) => void {
  return (graph) => {
    const edges = graph.edges as Record<string, unknown>;
    delete edges["e-punch-out"];
    edges["probe"] = {
      id: "probe",
      source: { nodeId: node, portId: "out" },
      target: { nodeId: "out", portId: "input" },
    };
  };
}

function setParameter(graph: GraphDocument, id: string, key: string, value: unknown): void {
  const node = graph.nodes[id];
  if (node === undefined) throw new Error(`E43 has no \`${id}\``);
  (node.parameters as Record<string, unknown>)[key] = value;
}

/** Freeze the picture: static bed, parked orb — so cross-frame equality means the
 *  EFFECT held still, not the world. */
function staticSource(graph: GraphDocument): void {
  setParameter(graph, "bed", "speed", 0);
  setParameter(graph, "pathx", "amplitude", 0);
  setParameter(graph, "pathy", "amplitude", 0);
}

async function shoot(
  mutate: (graph: GraphDocument) => void,
  capture: ReadonlyArray<number>,
): Promise<Frame[]> {
  const { document } = e43();
  const graph = structuredClone(document.graph) as GraphDocument;
  mutate(graph);
  const result = await renderHeadless({
    host: nodeGpuHost(),
    graph,
    settings: document.settings,
    frames: Math.max(...capture) + 1,
    capture: [...capture],
    animate: true,
    outputNodeId: "out",
  });
  const errors = result.diagnostics.filter((diagnostic) => diagnostic.severity === "error");
  if (errors.length > 0) throw new Error(errors.map((d) => d.message).join("; "));
  const space = result.plan.outputs.find((output) => output.nodeId === "out")?.space ?? "linear";
  return result.frames.map((frame) => {
    const image = toRgba8(
      {
        width: frame.width,
        height: frame.height,
        format: frame.format,
        bytes: frame.bytes,
        rowStride: frame.width * (BYTES_PER_PIXEL[frame.format] ?? 8),
      },
      { space },
    );
    return { w: image.width, h: image.height, d: image.data };
  });
}

function differingPixels(a: Frame, b: Frame): number {
  let n = 0;
  for (let at = 0; at < a.d.length; at += 4) {
    if (a.d[at] !== b.d[at] || a.d[at + 1] !== b.d[at + 1] || a.d[at + 2] !== b.d[at + 2]) n += 1;
  }
  return n;
}

describe("E43 Splice — the custom shader proves its no-op, and its rhythm", () => {
  beforeAll(() => {
    if (dawnError !== undefined) throw new Error(`Dawn unavailable: ${dawnError}`);
  });

  it(
    "amount = 0 is a BYTE-IDENTICAL passthrough — §V147 on user WGSL, for the first time",
    async () => {
      const [source] = await shoot(solo("pick"), [90]);
      const [passed] = await shoot(
        (graph) => {
          solo("splice")(graph);
          setParameter(graph, "splice", "amount", 0);
        },
        [90],
      );
      expect(differingPixels(source!, passed!)).toBe(0);
    },
    300_000,
  );

  it(
    "the glitch is QUANTISED: frozen inside a deal, re-dealt across the tick",
    async () => {
      // Deals tick at 3/s on the absolute clock: frames 90..99 share deal 4
      // (floor(1.5·3) = floor(1.65·3) = 4); frame 102 is deal 5. The source is pinned
      // static so any change IS the effect's.
      const [a, b, c] = await shoot(
        (graph) => {
          solo("splice")(graph);
          staticSource(graph);
          setParameter(graph, "splice", "amount", 0.6);
        },
        [90, 96, 102],
      );
      expect(differingPixels(a!, b!)).toBe(0); // held — rhythm, not wobble
      expect(differingPixels(a!, c!)).toBeGreaterThan(3000); // and then it SLAMS
    },
    300_000,
  );

  it(
    "the mirror fold is pixel-exact symmetry about its axis — its first example proves it",
    async () => {
      // Un-rotated, un-glitched: pure fold. Every pixel must equal its reflection
      // across x = 0.5 exactly — the fold samples the SAME texel for both.
      const [frame] = await shoot(
        (graph) => {
          solo("fold")(graph);
          staticSource(graph);
          setParameter(graph, "splice", "amount", 0);
          setParameter(graph, "fold", "rotate", 0);
          setParameter(graph, "spin", "amplitude", 0);
          setParameter(graph, "spin", "offset", 0);
        },
        [60],
      );
      const f = frame!;
      let asymmetric = 0;
      for (let y = 0; y < f.h; y += 7) {
        for (let x = 0; x < Math.floor(f.w / 2); x += 5) {
          const left = (y * f.w + x) * 4;
          const right = (y * f.w + (f.w - 1 - x)) * 4;
          if (f.d[left] !== f.d[right] || f.d[left + 1] !== f.d[right + 1] || f.d[left + 2] !== f.d[right + 2]) {
            asymmetric += 1;
          }
        }
      }
      expect(asymmetric).toBe(0);
    },
    300_000,
  );

  it(
    "the echo answers the KICK: silence is byte-quiet, the beat is not (T701's rest maths)",
    async () => {
      // The low-band chain subtracts the T701 rest before driving the composite's
      // opacity, so SILENCE — the §V361 cut, pattern amount 0, every band exactly at
      // its rest — contributes clamped zero and the full graph is byte-identical to
      // one with the echo chain severed. (Between kicks at 122 bpm the low band never
      // actually reaches its rest — measured: 194k differing pixels at the pre-kick
      // frame — so "quiet" must be real silence, not a gap in the pattern.) On the
      // beat the echo must land across a real share of the frame.
      const echoOff = (graph: GraphDocument): void => setParameter(graph, "emul", "operand", 0);
      const silence = (graph: GraphDocument): void => setParameter(graph, "beat", "amount", 0);
      const [silentOn] = await shoot(silence, [120]);
      const [silentOff] = await shoot((graph) => {
        silence(graph);
        echoOff(graph);
      }, [120]);
      expect(differingPixels(silentOn!, silentOff!)).toBe(0);

      const [kickOn] = await shoot(() => undefined, [120]);
      const [kickOff] = await shoot(echoOff, [120]);
      expect(differingPixels(kickOn!, kickOff!)).toBeGreaterThan(20000);
    },
    300_000,
  );
});
