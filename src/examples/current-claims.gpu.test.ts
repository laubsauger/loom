import { beforeAll, describe, expect, it } from "vitest";

import { nodeGpuHost, probeDawn } from "../runtime/backend/vgpu/node-gpu-host.ts";
import { toRgba8 } from "../runtime/export/image.ts";
import { BYTES_PER_PIXEL } from "../runtime/export/pixel-format.ts";
import type { GraphDocument } from "../domain/types/graph.ts";
import { renderHeadless } from "../tests/headless/render-harness.ts";
import { listExamples } from "./catalogue.ts";
import { requireExample } from "./runner.ts";
import { CURRENT_ASPECT, CURRENT_COLS, CURRENT_ROWS } from "./shaders/current.wgsl.ts";

/**
 * T741 — E42's claims, read off the QUATERNION BUFFER itself (the harness's
 * probeBuffers seam exists for exactly this: pixels cannot testify about a rotation).
 *
 * §V712 measured a look baseline reading identically to four decimals with every
 * element mis-owned; this file makes that blindness DELIBERATE and then catches it:
 * the sign-flip mutation turns every moving tile half around, the still-frame
 * instrument barely moves, and only the buffer comparison sees it.
 */

function e42() {
  const file = listExamples().find((entry) => entry.fileName === "E42-Current.loom.json");
  if (file === undefined) throw new Error("E42-Current.loom.json is not shipped");
  return requireExample(file);
}

let dawnError: string | undefined;
beforeAll(async () => {
  dawnError = (await probeDawn()).error;
}, 60_000);

const FRAME = 132;
const TILE_COUNT = CURRENT_COLS * CURRENT_ROWS;

interface Probe {
  readonly orient: Float32Array;
  readonly position: Float32Array;
  readonly meanLuma: number;
}

async function run(mutate?: (graph: GraphDocument) => void): Promise<Probe> {
  const { document } = e42();
  const graph = structuredClone(document.graph) as GraphDocument;
  mutate?.(graph);
  const result = await renderHeadless({
    host: nodeGpuHost(),
    graph,
    settings: document.settings,
    frames: FRAME + 1,
    capture: [FRAME],
    animate: true,
    outputNodeId: "out",
    probeBuffers: ["scratch:flow:orient", "scratch:flow:position"],
  });
  const errors = result.diagnostics.filter((diagnostic) => diagnostic.severity === "error");
  if (errors.length > 0) throw new Error(errors.map((d) => d.message).join("; "));
  const frame = result.frames[0];
  if (frame === undefined) throw new Error("no frame captured");
  const image = toRgba8(
    {
      width: frame.width,
      height: frame.height,
      format: frame.format,
      bytes: frame.bytes,
      rowStride: frame.width * (BYTES_PER_PIXEL[frame.format] ?? 8),
    },
    { space: result.plan.outputs.find((output) => output.nodeId === "out")?.space ?? "linear" },
  );
  let luma = 0;
  for (let at = 0; at < image.data.length; at += 4) {
    luma += 0.2126 * image.data[at]! + 0.7152 * image.data[at + 1]! + 0.0722 * image.data[at + 2]!;
  }
  const buffers = result.buffers ?? {};
  const orient = buffers["scratch:flow:orient"];
  const position = buffers["scratch:flow:position"];
  if (orient === undefined || position === undefined) throw new Error("probe buffers missing");
  return {
    orient: new Float32Array(orient),
    position: new Float32Array(position),
    meanLuma: luma / (image.data.length / 4),
  };
}

/** The orb's analytic display-space positions over the recent past (the LFO sine —
 *  the domain's own formula, §V683's discipline). */
function orbTrail(t: number): Array<{ x: number; y: number }> {
  return Array.from({ length: 10 }, (_, i) => {
    const at = t - i * 0.05;
    const cx = 0.5 + 0.33 * Math.sin(2 * Math.PI * (0.29 * at + 0));
    const cy = 0.5 + 0.3 * Math.sin(2 * Math.PI * (0.203 * at + 0.25));
    // uv (v from the top) → the kernel's display space: x = (2u−1)·ASPECT, y = 1−2v.
    return { x: (2 * cx - 1) * CURRENT_ASPECT, y: 1 - 2 * cy };
  });
}

const IDENTITY = [0, 0, 0, 1] as const;
/** Motion reaches roughly the orb's radius + the difference window's travel + one tap. */
const NEAR = 0.6;

describe("E42 Current — the tiles turn where the picture moves", () => {
  beforeAll(() => {
    if (dawnError !== undefined) throw new Error(`Dawn unavailable: ${dawnError}`);
  });

  /**
   * CALM MEANS IDENTITY, EXACTLY — and turned means near the subject. Every tile
   * farther than NEAR from the orb's recent analytic path holds (0,0,0,1) to the
   * float; every non-identity quaternion is unit length (a broken composition drifts
   * off the unit sphere long before it looks wrong) and sits ON the path. And the
   * turned set is a real population whose members carry a non-zero xy part — the LEAN,
   * which is the half of the composition a flat sprite angle could not express (T723's
   * whole reason to exist witnessed as algebra: spin alone would keep q.xy at zero).
   */
  it(
    "holds identity exactly off the path, and composed unit quaternions on it",
    async () => {
      const { orient, position } = await run();
      const trail = orbTrail(FRAME / 60);
      let turned = 0;
      let leaning = 0;
      for (let tile = 0; tile < TILE_COUNT; tile += 1) {
        const q = [orient[tile * 4]!, orient[tile * 4 + 1]!, orient[tile * 4 + 2]!, orient[tile * 4 + 3]!];
        const x = position[tile * 4]!;
        const y = position[tile * 4 + 1]!;
        const nearPath = trail.some((p) => Math.hypot(x - p.x, y - p.y) < NEAR);
        const isIdentity = q[0] === IDENTITY[0] && q[1] === IDENTITY[1] && q[2] === IDENTITY[2] && q[3] === IDENTITY[3];
        if (!nearPath) {
          expect(isIdentity, `tile at (${x.toFixed(2)}, ${y.toFixed(2)}) turned off-path`).toBe(true);
          continue;
        }
        if (isIdentity) continue;
        turned += 1;
        const norm = Math.hypot(q[0]!, q[1]!, q[2]!, q[3]!);
        expect(norm).toBeCloseTo(1, 4);
        if (Math.hypot(q[0]!, q[1]!) > 0.1) leaning += 1;
      }
      expect(turned).toBeGreaterThan(20); // a real turned population
      expect(leaning).toBeGreaterThan(10); // and it LEANS — the composed half is alive
    },
    300_000,
  );

  /**
   * §V712 MADE DELIBERATE. Negate the gradient in a mutated clone: every moving
   * tile's SPIN turns half around, so its quaternion lands nearly ORTHOGONAL to the
   * shipped one (⟨spin(θ), spin(θ+π)⟩ = 0), while the calm tiles agree exactly and
   * the still-frame instrument — mean display luma, the baseline's whole diet —
   * barely moves. The wrongness is total, the picture statistics are blind to it,
   * and only the buffer comparison sees. That asymmetry is the reason this claim
   * exists, and the md says so.
   */
  it(
    "sees the sign-flip the still-frame statistics cannot",
    async () => {
      const shipped = await run();
      const flipped = await run((graph) => {
        const flow = graph.nodes["flow"];
        if (flow === undefined) throw new Error("E42 has no `flow`");
        const parameters = flow.parameters as Record<string, unknown>;
        const kernel = parameters["kernel"];
        if (typeof kernel !== "string" || !kernel.includes("atan2(gy, gx)")) {
          throw new Error("the flow kernel moved — update the mutation");
        }
        parameters["kernel"] = kernel.replace("atan2(gy, gx)", "atan2(-gy, -gx)");
      });

      let moving = 0;
      let dotSum = 0;
      for (let tile = 0; tile < TILE_COUNT; tile += 1) {
        const a = shipped.orient.subarray(tile * 4, tile * 4 + 4);
        const b = flipped.orient.subarray(tile * 4, tile * 4 + 4);
        const aIdentity = a[0] === 0 && a[1] === 0 && a[2] === 0 && a[3] === 1;
        const bIdentity = b[0] === 0 && b[1] === 0 && b[2] === 0 && b[3] === 1;
        // Calm tiles agree exactly in both runs — the mutation only touches motion.
        expect(aIdentity).toBe(bIdentity);
        if (aIdentity) continue;
        moving += 1;
        dotSum += Math.abs(a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]! + a[3]! * b[3]!);
      }
      expect(moving).toBeGreaterThan(20);
      // Near-orthogonal on average: the flip is a half-turn of the spin.
      expect(dotSum / moving).toBeLessThan(0.4);

      // And the blindness, demonstrated: the still-frame statistic the baseline eats
      // moves by under 2% while every moving tile is turned half around.
      const shift = Math.abs(shipped.meanLuma - flipped.meanLuma) / Math.max(shipped.meanLuma, 1);
      expect(shift).toBeLessThan(0.02);
    },
    300_000,
  );
});
