import { describe, expect, it } from "vitest";

import { compileGraph } from "../../../compiler/index.ts";
import { createNodeRegistry } from "../../../nodes/registry/registry.ts";
import { allNodeDefinitions, liveCountBufferId } from "../../../nodes/definitions/index.ts";
import { createVgpuBackend } from "./vgpu-backend.ts";
import { nodeGpuHost, probeDawn } from "./node-gpu-host.ts";

/**
 * T744 — the advanced kernel can READ A FIELD, so a spawn decision can read a picture.
 *
 * E41 found the gap: `pointKernelAdvanced` took no inputs at all, so "particles from a
 * video" had to recycle in a plain kernel. The fix reuses the ONE existing
 * texture-into-points path (the plain kernel's `field` input, same fieldAt, same
 * clip→uv mapping, same unwired refusal — §V349, and the T743 boundary) as a texture
 * binding, so §V588's storage budget is untouched.
 *
 * The gate is the capability's own sentence: emitters over the BRIGHT half of a field
 * spawn, emitters over the DARK half do not — asserted on the live count and on every
 * child's position, by value, after real frames.
 *
 * The stage: a ramp field, black at the left edge to white at the right. Eight
 * immortal emitters sit in a row from x = −0.875 to +0.875; each frame an emitter
 * spawns exactly when fieldAt at its own site reads bright (r > 0.5) — the right-hand
 * four. Children mark themselves with position.y = 1 and die next frame, so the
 * population is: 8 emitters + (children born last frame). Every child must sit at a
 * bright emitter's x.
 */

const FIELD_KERNEL = `fn process(p: Point, ctx: PointCtx) -> Point {
  var q = p;
  if (ctx.firstRun == 1u) {
    q.id = ctx.index;
    q.spawnCount = 0u;
    if (ctx.index >= 8u) {
      q.alive = 0u;
      return q;
    }
    q.alive = 1u;
  }
  if (q.id < 8u) {
    /* An EMITTER: pinned at its site, spawning exactly when the field is bright there. */
    let sx = -0.875 + f32(q.id) * 0.25;
    q.position = vec3f(sx, 0.0, 0.0);
    q.velocity = vec3f(0.0);
    let sample = fieldAt(vec3f(sx, 0.0, 0.0));
    q.spawnCount = select(0u, 1u, sample.r > 0.5);
    q.alive = 1u;
    return q;
  }
  /* A CHILD: arrives as its parent's copy (position = the emitter's site), marks
     itself, lives one frame. */
  if (q.position.y > 0.5) {
    q.alive = 0u;
    return q;
  }
  q.position = vec3f(q.position.x, 1.0, 0.0);
  q.alive = 1u;
  return q;
}`;

describe("the advanced kernel spawns from a field (T744, §V147-by-value)", () => {
  it("emitters over the bright half spawn; over the dark half, never", async () => {
    const probe = await probeDawn();
    if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);

    const registry = createNodeRegistry(allNodeDefinitions).view();
    const node = (id: string, type: string, parameters: Record<string, unknown>) => ({
      id,
      type,
      definitionVersion: 1,
      position: { x: 0, y: 0 },
      parameters,
    }) as never;
    const plan = compileGraph({
      graph: {
        revision: 1,
        nodes: {
          // Black at the left edge, white at the right: fieldAt's r IS "how far right".
          shade: node("shade", "ramp", { type: "horizontal", interp: "linear" }),
          sim: node("sim", "pointKernelAdvanced", { capacity: 64, seed: 7, kernel: FIELD_KERNEL }),
          draw: node("draw", "renderPoints", { count: 64, sizePixels: 4 }),
          out: node("out", "output", {}),
        },
        edges: {
          e0: { id: "e0", source: { nodeId: "shade", portId: "out" }, target: { nodeId: "sim", portId: "field" } },
          e1: { id: "e1", source: { nodeId: "sim", portId: "out" }, target: { nodeId: "draw", portId: "points" } },
          e2: { id: "e2", source: { nodeId: "draw", portId: "out" }, target: { nodeId: "out", portId: "input" } },
        },
        groups: {},
      },
      settings: {
        outputResolution: { width: 64, height: 64 },
        workingFormat: "rgba8unorm",
        randomSeed: 7,
        previewLongEdge: 192,
        previewFps: 20,
        limits: { maxResolution: 4096, maxDispatch: 65535, maxBufferBytes: 268_435_456, memoryBudgetBytes: 1_073_741_824 },
      } as never,
      registry,
      capabilities: {
        tier: "B",
        features: [],
        formats: ["rgba8unorm", "rgba8unorm-srgb", "rgba16float", "r32float"],
        timestampQuery: false,
        limits: { maxTextureDimension2D: 8192 },
      } as never,
    });
    expect(plan.diagnostics.filter((d) => d.severity === "error").map((d) => d.message)).toEqual([]);

    const backend = createVgpuBackend({ host: nodeGpuHost() });
    try {
      await backend.initialize({});
      const compiled = await backend.compile(plan);
      for (let frameIndex = 0; frameIndex < 6; frameIndex += 1) {
        backend.render(compiled, {
          frame: { timeSeconds: frameIndex / 60, deltaSeconds: 1 / 60, frameIndex, mode: "offline", randomSeed: 7 },
          pointer: { x: 0, y: 0, buttons: 0 },
          resolution: [64, 64],
        } as never);
      }

      // Steady state: 8 emitters + two generations of children from the BRIGHT four —
      // a child is processed twice (the frame after its copy-birth it marks itself,
      // the frame after that it dies), so 4 unmarked newborns + 4 marked one-frame-olds.
      const count = new Uint32Array(await backend.readBuffer(liveCountBufferId("sim")))[0];
      expect(count).toBe(16);

      // And by VALUE: every child (y = 1) sits at a bright emitter's x — the right
      // half of the ramp. A dark-side child means fieldAt read the wrong texel, the
      // wrong channel, or the wrong half of the frame; none may exist.
      const positions = new Float32Array(await backend.readBuffer("scratch:sim:position"));
      let children = 0;
      for (let index = 0; index < (count ?? 0); index += 1) {
        const x = positions[index * 4] ?? 0;
        const y = positions[index * 4 + 1] ?? 0;
        if (y > 0.5) {
          children += 1;
          expect(x, `child at x=${x.toFixed(3)} born on the dark side`).toBeGreaterThan(0);
        }
      }
      expect(children).toBe(4);
    } finally {
      backend.dispose();
    }
  }, 120_000);
});
