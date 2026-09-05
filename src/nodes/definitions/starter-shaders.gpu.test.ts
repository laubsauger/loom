import { beforeAll, describe, expect, it } from "vitest";

import type { GraphDocument } from "../../domain/types/graph.ts";
import { nodeGpuHost as dawnGpuHost, probeDawn } from "../../runtime/backend/vgpu/node-gpu-host.ts";
import { paritySettings } from "../../tests/fixtures/parity-graphs.ts";
import { renderOnce } from "../../tests/headless/render-harness.ts";
import type { RenderedFrame } from "../../tests/headless/render-harness.ts";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════
 * §T1210 — THE STARTER'S KNOBS ARE LIVE, AND ITS FIRST FRAME IS NOT BLACK
 * ═══════════════════════════════════════════════════════════════════════════════════
 *
 * `starter-shaders.test.ts` asserts that a freshly created node HAS reflected controls.
 * That is necessary and not sufficient, and the gap is exactly the shape of the bug this
 * task exists to remove: a control can be present in the schema and reach no uniform, and a
 * default source can declare a beautiful struct and render a black frame. Both would pass
 * every plan-level assertion and be discovered by a user on first contact.
 *
 * So both halves are measured here, on Dawn, in bytes:
 *
 *  1. THE DEFAULT RENDERS SOMETHING SENSIBLE. A fresh Custom WGSL over a white solid comes
 *     back WHITE — the starter is a passthrough by arithmetic (`amount` 1, `tint` white,
 *     `PULSE_DEPTH` 0), so its first frame is its input and never a black rectangle. A fresh
 *     point kernel lights pixels.
 *  2. TURNING THE KNOB MOVES THE PICTURE. Each render is paired with a second one that
 *     differs ONLY in a reflected parameter's value, which is what a schema entry cannot
 *     testify to: if the reflected control were bound to nothing, both renders would be
 *     identical and the node would be the dead end the task is about.
 *
 * ## Why the numbers are exact rather than banded (§V147)
 *
 * The parity settings put the working space in linear with the display transform off, and
 * the format is `rgba8unorm`, so a readback IS the target's bytes. Every colour component in
 * the fixture is 0 or 1, where `srgbToLinear` is the identity — so a display-space colour
 * control introduces no decode error, and `toEqual` is used at full strength.
 */

const SIZE = 8;

let dawnError: string | undefined;

beforeAll(async () => {
  dawnError = (await probeDawn()).error;
}, 60_000);

function requireDawn(): void {
  // Dawn is required, not optional (§V147's suite rule): skipping would turn the only tests
  // that can see this failure mode into a green tick on every machine without a GPU.
  if (dawnError !== undefined) throw new Error(`Dawn did not start: ${dawnError}`);
}

/** The centre texel, so a failure names a pixel rather than a mean. */
function centre(frame: RenderedFrame): readonly number[] {
  const at = ((SIZE / 2) * SIZE + SIZE / 2) * 4;
  return [...frame.bytes.subarray(at, at + 4)];
}

/** solid(white) -> customWgsl(the shipped default source) -> output. */
function shaderGraph(parameters: Record<string, unknown>): GraphDocument {
  return {
    revision: 1,
    nodes: {
      src: { id: "src", type: "solid", definitionVersion: 1, position: { x: 0, y: 0 }, parameters: { color: [1, 1, 1, 1] } },
      // No `source`: the node resolves the shipped default, exactly as a fresh drop does.
      fx: { id: "fx", type: "customWgsl", definitionVersion: 1, position: { x: 200, y: 0 }, parameters },
      out: { id: "out", type: "output", definitionVersion: 1, position: { x: 400, y: 0 }, parameters: {} },
    },
    edges: {
      e1: { id: "e1", source: { nodeId: "src", portId: "out" }, target: { nodeId: "fx", portId: "input" } },
      e2: { id: "e2", source: { nodeId: "fx", portId: "out" }, target: { nodeId: "out", portId: "input" } },
    },
    groups: {},
  } as unknown as GraphDocument;
}

/** pointKernel(the shipped default kernel) -> renderPoints -> output. */
function kernelGraph(parameters: Record<string, unknown>): GraphDocument {
  return {
    revision: 1,
    nodes: {
      // No `kernel`: the node resolves the shipped default, exactly as a fresh drop does.
      sim: { id: "sim", type: "pointKernel", definitionVersion: 1, position: { x: 0, y: 0 }, parameters: { capacity: 256, seed: 7, ...parameters } },
      draw: { id: "draw", type: "renderPoints", definitionVersion: 1, position: { x: 200, y: 0 }, parameters: { count: 256, sizePixels: 6 } },
      out: { id: "out", type: "output", definitionVersion: 1, position: { x: 400, y: 0 }, parameters: {} },
    },
    edges: {
      e1: { id: "e1", source: { nodeId: "sim", portId: "out" }, target: { nodeId: "draw", portId: "points" } },
      e2: { id: "e2", source: { nodeId: "draw", portId: "out" }, target: { nodeId: "out", portId: "input" } },
    },
    groups: {},
  } as unknown as GraphDocument;
}

describe("§T1210 — the fresh Custom WGSL", () => {
  it("renders its input, not black, with nothing set at all", async () => {
    requireDawn();
    const frame = await renderOnce({
      host: dawnGpuHost(),
      graph: shaderGraph({}),
      settings: paritySettings({ size: SIZE }),
    });
    expect(frame.format).toBe("rgba8unorm");
    // White in, white out: `amount` resolves to 1, `tint` to the `@default 1` its own struct
    // declares, and the pulse depth is 0. A default that drew black would teach the wrong
    // thing on first contact, and this is the assertion that would see it.
    expect(centre(frame)).toEqual([255, 255, 255, 255]);
  }, 120_000);

  it("moves the picture when the REFLECTED colour is turned — the knob reaches the shader", async () => {
    requireDawn();
    const frame = await renderOnce({
      host: dawnGpuHost(),
      // `tint` exists ONLY because the default source declares `tint: vec3f` and reflection
      // made a control out of it. Setting it here goes through the same resolve path the
      // inspector writes to, so a control bound to no uniform renders white and fails.
      graph: shaderGraph({ tint: [0, 1, 0, 1] }),
      settings: paritySettings({ size: SIZE }),
    });
    expect(centre(frame)).toEqual([0, 255, 0, 255]);
  }, 120_000);
});

describe("§T1210 — the fresh point kernel", () => {
  /** Lit texels after `frames` steps of the shipped default kernel. */
  async function litAfter(parameters: Record<string, unknown>): Promise<{ lit: number; bytes: Uint8Array }> {
    const frame = await renderOnce({
      host: dawnGpuHost(),
      graph: kernelGraph(parameters),
      settings: paritySettings({ size: 64 }),
      frames: 120,
    });
    // Counted on a COLOUR channel, not on alpha: the target is opaque everywhere, so an
    // alpha count is 4096 for a full frame and for an empty one alike — a metric that
    // cannot distinguish the two pictures it is being asked about (§V854).
    let lit = 0;
    for (let index = 0; index < frame.bytes.byteLength; index += 4) {
      if ((frame.bytes[index] ?? 0) > 0) lit += 1;
    }
    return { lit, bytes: frame.bytes };
  }

  it("draws points out of the box, and the reflected knobs move them", async () => {
    requireDawn();
    const shipped = await litAfter({});

    // NOT BLACK. The kernel that ships draws at two seconds in, which is the half of this a
    // schema assertion cannot reach and the half a user meets first.
    expect(shipped.lit).toBeGreaterThan(0);

    /* THE CLAIM `jitter` AND `gravity` EXIST FOR, one knob at a time, with the render's only
       other difference being that ONE reflected value. If a control reached no uniform the
       two pictures would be byte-identical — the dead end this task is about, and the thing
       a schema entry cannot testify to. Compared as BYTES rather than as a lit count: the
       shipped kernel starts every point at the origin, so the cloud is a clump that MOVES
       rather than a field that thins, and a count is the wrong instrument for that. */
    for (const cut of [{ jitter: 0 }, { gravity: 0 }]) {
      const turned = await litAfter(cut);
      expect(turned.bytes, `${JSON.stringify(cut)} rendered the shipped picture`).not.toEqual(
        shipped.bytes,
      );
    }
  }, 120_000);
});
