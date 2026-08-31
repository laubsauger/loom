import { beforeAll, describe, expect, it } from "vitest";

import type { GraphDocument } from "../../domain/types/graph.ts";
import type { StoredParameter } from "../../domain/types/parameters.ts";
import { nodeGpuHost, probeDawn } from "../../runtime/backend/vgpu/node-gpu-host.ts";
import { paritySettings } from "../fixtures/parity-graphs.ts";
import { renderHeadless } from "./render-harness.ts";

/**
 * T537 / §B111 — DOES THE PICTURE KEEP TURNING? (§V163/T259's shape.)
 *
 * The value-level gate is `src/domain/parameters/parameter-range.test.ts` (values) plus
 * `src/ui/controls/drag-math.test.ts` (the control). This file answers the question
 * neither can, and it is the question the owner actually asked: does the PICTURE keep
 * turning past the old ceiling? T259 is the precedent — the resolver returning a
 * different number was green for the whole time the screen did not change.
 *
 * The fixture is built so the OLD code could not have passed it (§V461). `abstime * 700`
 * reaches 360° at t≈0.51s, so BOTH captured frames are far past the point where the clamp
 * used to bite — under the old arithmetic both would have resolved to exactly 360° and
 * rendered BYTE-IDENTICAL images. The control case asserts exactly that, by pinning the
 * same expression by hand with `min(...)`.
 */

const ROTATE_FAST = "abstime * 700";
/** The OLD behaviour, written explicitly: the clamp the manifest used to apply for free. */
const ROTATE_PINNED = "min(abstime * 700, 360)";

/** Frames 60 and 120 are t=1.0s and t=2.0s — 700° and 1400°, both well past 360°. */
const CAPTURE = [60, 120] as const;

function rollGraph(expression: string): GraphDocument {
  const expr = {
    mode: "expression",
    bindings: { expression: { kind: "expression", source: expression } },
  } as unknown as StoredParameter;
  return {
    revision: 1,
    groups: {},
    nodes: {
      // An ASYMMETRIC source: a rotation of a symmetric field is invisible (§V461's own
      // lesson from B105). An off-centre rectangle has no rotational symmetry at all.
      src: {
        id: "src",
        type: "rectangle",
        definitionVersion: 1,
        position: { x: 0, y: 0 },
        parameters: { center: [0.28, 0.36], size: [0.5, 0.16], roundness: 0, softness: 0.02 },
      },
      roll: {
        id: "roll",
        type: "transform",
        definitionVersion: 1,
        position: { x: 200, y: 0 },
        parameters: { r: expr, aspectcorrect: true },
      },
      out: { id: "out", type: "output", definitionVersion: 1, position: { x: 400, y: 0 }, parameters: {} },
    },
    edges: {
      e1: { id: "e1", source: { nodeId: "src", portId: "out" }, target: { nodeId: "roll", portId: "input" } },
      e2: { id: "e2", source: { nodeId: "roll", portId: "out" }, target: { nodeId: "out", portId: "input" } },
    },
  };
}

async function framesFor(expression: string): Promise<readonly Uint8Array[]> {
  const result = await renderHeadless({
    host: nodeGpuHost(),
    graph: rollGraph(expression),
    settings: paritySettings(),
    frames: 121,
    capture: [...CAPTURE],
    fps: 60,
    animate: true,
  });
  return result.frames.map((frame) => frame.bytes);
}

const differingBytes = (a: Uint8Array, b: Uint8Array): number => {
  let count = 0;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) count += 1;
  return count;
};

describe("§B111 — the picture keeps turning past the declared maximum", () => {
  beforeAll(async () => {
    const available = await probeDawn();
    if (!available) throw new Error("Dawn unavailable — this verification needs a real device");
  }, 120_000);

  it("two frames BOTH past the old 360 ceiling render differently", async () => {
    const [a, b] = await framesFor(ROTATE_FAST);
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    // Non-vacuity first: a black frame differs from nothing and would pass the control
    // below for the wrong reason. Measured 4584 non-zero bytes of 16384 (§V218).
    expect((a as Uint8Array).filter((v) => v !== 0).length).toBeGreaterThan(1000);
    // Measured 3068 of 16384 bytes differ. It is still turning.
    expect(differingBytes(a as Uint8Array, b as Uint8Array)).toBeGreaterThan(1000);
  }, 240_000);

  it("CONTROL: the same expression pinned by hand renders those frames IDENTICALLY", async () => {
    // This is the old behaviour. Its passing is what proves the test above measures the
    // clamp and not some ambient clock in the shader.
    const [a, b] = await framesFor(ROTATE_PINNED);
    expect((a as Uint8Array).filter((v) => v !== 0).length).toBeGreaterThan(1000);
    expect(differingBytes(a as Uint8Array, b as Uint8Array)).toBe(0);
  }, 240_000);
});
