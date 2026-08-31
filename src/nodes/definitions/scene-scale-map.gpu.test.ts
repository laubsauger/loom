import { describe, expect, it } from "vitest";

import { compileGraph } from "../../compiler/index.ts";
import type { BackendCapabilities } from "../../domain/types/backend.ts";
import type { GraphDocument, GraphNode, ProjectSettings } from "../../domain/types/graph.ts";
// The sanctioned Dawn host: `src/runtime/backend/vgpu/` is the only place a `vgpu` import
// is legal (§V3), and this is that boundary's node entry point.
import { nodeGpuHost, probeDawn } from "../../runtime/backend/vgpu/node-gpu-host.ts";
import { createVgpuBackend } from "../../runtime/backend/vgpu/vgpu-backend.ts";
import { createNodeRegistry } from "../registry/registry.ts";
import { allNodeDefinitions } from "./index.ts";

/**
 * T721 — a PER-POINT SIZE on `geometry`, and the gate is shaped by §B132 rather than by
 * habit.
 *
 * §B132 is the fault this feature is most likely to repeat: points-mode `scale` was
 * carried for instances only, so a billboard fell through to a hardcoded 0.05 and the
 * Scale parameter did NOTHING — for weeks, on a shipped example, with every structural
 * test green. What made it invisible is that "the uniform holds 0.3" is also true of a
 * build that always holds 0.3. So a single reading proves nothing here either, and this
 * gate is written as §B132 says it must be: **a PAIR of scales that must differ from
 * each other, and both of which must differ from the unmapped render.**
 *
 * Two points, one attribute, two different factors. The unmapped control renders both at
 * the authored size; the mapped render must make one bigger and one smaller, and the
 * MULTIPLY semantics are asserted as arithmetic rather than as "it changed" — factor 2.0
 * on a 0.10 primitive has to cover about four times the area of factor 1.0, because area
 * goes as the square. A version that REPLACED the authored scale instead of multiplying
 * it would pass "it changed" and fail this.
 *
 * ## And the shadow, which is the half a look test would miss
 *
 * Instances are the one per-point mode that CASTS (§V610 excuses the two billboard
 * modes), so a mapped size that reached only the lit draw would paint a shadow sized by
 * the AUTHORED scale under a primitive drawn at another one. That reads as a lighting
 * bug and is really a missing binding, so the depth sweep's own binding is asserted
 * directly — there is no camera angle from which a still frame makes that claim cheaply.
 */

const SIZE = 64;

const settings: ProjectSettings = {
  outputResolution: { width: SIZE, height: SIZE },
  workingFormat: "rgba16float",
  randomSeed: 1,
  previewLongEdge: 64,
  previewFps: 30,
  limits: { maxResolution: 4096, maxDispatch: 65535, maxBufferBytes: 268_435_456, memoryBudgetBytes: 1_073_741_824 },
};

const capabilities: BackendCapabilities = {
  tier: "B",
  features: [],
  formats: ["rgba8unorm", "rgba8unorm-srgb", "rgba16float", "r32float", "depth24plus"],
  timestampQuery: false,
  limits: { maxTextureDimension2D: 8192 },
};

const registry = createNodeRegistry(allNodeDefinitions).view();

function node(id: string, type: string, parameters: GraphNode["parameters"] = {}, label?: string): GraphNode {
  return {
    id,
    type,
    definitionVersion: registry.get(type)?.version ?? 1,
    position: { x: 0, y: 0 },
    parameters,
    ...(label === undefined ? {} : { label }),
  };
}

/* TWO points, placed apart along world x so each owns its own half of the frame, and a
   `grow` factor that differs between them. Index 0 gets 2.0, index 1 gets 0.5 — one
   larger than the authored size and one smaller, so a build that ignored the attribute
   and a build that clamped it both fail. */
const ATTRIBUTES = JSON.stringify([
  { name: "position", type: "vec3f", semantic: "position", default: [0, 0, 0] },
  { name: "grow", type: "f32", default: [0] },
  { name: "wide", type: "vec4f", default: [0, 0, 0, 0] },
]);
const KERNEL = `fn process(p: Point, ctx: PointCtx) -> Point {
  var q = p;
  let left = ctx.index == 0u;
  q.position = vec3f(select(0.5, -0.5, left), 0.0, 0.0);
  q.grow = select(0.5, 2.0, left);
  /* the SAME two factors in a vector's z, so the channel path is exercised by the same
     fixture rather than by a second one that could drift from it. */
  q.wide = vec4f(0.0, 0.0, q.grow, 0.0);
  return q;
}`;

const mapSlot = (attribute: string, channel?: string): GraphNode["parameters"][string] =>
  ({
    mode: "map",
    bindings: {
      static: { kind: "static", value: 0.1 },
      map: { kind: "map", attribute, ...(channel === undefined ? {} : { channel }) },
    },
  }) as GraphNode["parameters"][string];

interface Case {
  readonly mapped?: { attribute: string; channel?: string };
  readonly mode?: "instances" | "points" | "beam";
  readonly scale?: number;
  readonly shadows?: boolean;
}

function graphFor(options: Case = {}): GraphDocument {
  const scale = options.scale ?? 0.1;
  const geometry: GraphNode["parameters"] = {
    mode: options.mode ?? "instances",
    shape: "box",
    material: "chalk1",
    ...(options.mapped === undefined
      ? { scale }
      : { scale: mapSlot(options.mapped.attribute, options.mapped.channel) }),
  };
  return {
    revision: 1,
    nodes: Object.fromEntries(
      [
        node("seed", "pointGrid", { cols: 2, rows: 1, count: 2 }, "seed1"),
        node("place", "pointKernel", { capacity: 2, attributes: ATTRIBUTES, kernel: KERNEL }, "place1"),
        /* §V617: an UNLIT primitive casts no shadow, so the shadow case has to be lit —
           otherwise the sweep this test is about is correctly never emitted. */
        node("chalk", options.shadows === true ? "materialPhong" : "materialUnlit", { color: [1, 1, 1, 1] }, "chalk1"),
        node("blocks", "geometry", geometry, "blocks1"),
        node("cam", "camera", { eye: [0, 0, 4], lookAt: [0, 0, 0], ortho: true, fov: 46, near: 0.1, far: 20 }, "cam1"),
        ...(options.shadows === true
          ? [node("sun", "light", { kind: "directional", direction: [0, -1, -0.2], color: [1, 1, 1, 1], intensity: 1, shadows: true, shadowExtent: 4 }, "sun1")]
          : []),
        node(
          "shot",
          "render",
          {
            scenes: "blocks1",
            camera: "cam1",
            lights: options.shadows === true ? "sun1" : "",
            background: [0, 0, 0, 1],
          },
          "shot1",
        ),
        node("out", "output", {}, "out1"),
      ].map((entry) => [entry.id, entry]),
    ),
    edges: {
      e1: { id: "e1", source: { nodeId: "seed", portId: "out" }, target: { nodeId: "place", portId: "in" } },
      e2: { id: "e2", source: { nodeId: "place", portId: "out" }, target: { nodeId: "blocks", portId: "points" } },
      e3: { id: "e3", source: { nodeId: "shot", portId: "out" }, target: { nodeId: "out", portId: "input" } },
    },
    groups: {},
  };
}

function compile(graph: GraphDocument) {
  return compileGraph({ graph, settings, registry, capabilities });
}

/** Luma per pixel of the rendered frame, row-major (rgba16float, decoded). */
async function renderLuma(graph: GraphDocument): Promise<Float32Array> {
  const backend = createVgpuBackend({ host: nodeGpuHost() });
  try {
    await backend.initialize({});
    const plan = compile(graph);
    expect(plan.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    const compiled = await backend.compile(plan);
    backend.render(compiled, {
      frame: { timeSeconds: 0, deltaSeconds: 1 / 60, frameIndex: 0, mode: "offline", randomSeed: 1 },
      pointer: { x: 0, y: 0, buttons: 0 },
      resolution: [SIZE, SIZE],
    });
    const image = await backend.readOutput(plan.outputs[0]?.resourceId ?? "");
    const view = new DataView(image.bytes.buffer, image.bytes.byteOffset, image.bytes.byteLength);
    const out = new Float32Array(image.width * image.height);
    for (let y = 0; y < image.height; y += 1) {
      for (let x = 0; x < image.width; x += 1) {
        out[y * image.width + x] = halfFloat(view.getUint16(y * image.rowStride + x * 8, true));
      }
    }
    return out;
  } finally {
    backend.dispose();
  }
}

function halfFloat(bits: number): number {
  const sign = bits & 0x8000 ? -1 : 1;
  const exponent = (bits >> 10) & 0x1f;
  const fraction = bits & 0x3ff;
  if (exponent === 0) return sign * fraction * 2 ** -24;
  if (exponent === 31) return fraction === 0 ? sign * Infinity : Number.NaN;
  return sign * (fraction + 1024) * 2 ** (exponent - 25);
}

/** Lit pixels in the LEFT half and the RIGHT half — one primitive owns each. */
function halves(luma: Float32Array): { left: number; right: number } {
  let left = 0;
  let right = 0;
  for (let y = 0; y < SIZE; y += 1) {
    for (let x = 0; x < SIZE; x += 1) {
      if ((luma[y * SIZE + x] as number) > 0.05) {
        if (x < SIZE / 2) left += 1;
        else right += 1;
      }
    }
  }
  return { left, right };
}

describe("T721: a mapped scale sizes each instance, on a real device", () => {
  it("makes one primitive bigger and one smaller, and both differ from the unmapped render", async () => {
    // Required, never skipped: skipping turns the one test that can see §B132's fault
    // into a green tick on every machine without a GPU.
    const probe = await probeDawn();
    if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);

    const control = halves(await renderLuma(graphFor()));
    const mapped = halves(await renderLuma(graphFor({ mapped: { attribute: "grow" } })));

    // The control renders both at the authored 0.1 — symmetric, and lit at all.
    expect(control.left).toBeGreaterThan(0);
    expect(Math.abs(control.left - control.right)).toBeLessThan(control.left * 0.25);

    // §B132's pair: the two mapped sizes differ from EACH OTHER...
    expect(mapped.left).toBeGreaterThan(mapped.right * 2);
    // ...and BOTH differ from the unmapped render, which is the half that catches a
    // factor dropped on the floor. Without it, "the two differ" is also true of a build
    // that ignores the map and renders two different authored sizes.
    expect(mapped.left).toBeGreaterThan(control.left * 1.5);
    expect(mapped.right).toBeLessThan(control.right * 0.75);

    /* MULTIPLY, as arithmetic rather than as "it changed": factor 2.0 against factor 0.5
       is 4× the linear size and therefore ~16× the area. A build that REPLACED the
       authored scale with the attribute would give 2.0/0.5 = 4× the area instead, and a
       build that ADDED it something else again. Generous bounds — this is a 64px frame
       and coverage is quantised — but they exclude both wrong operators. */
    expect(mapped.left / Math.max(1, mapped.right)).toBeGreaterThan(8);
  }, 120_000);

  it("takes one channel of a float vector, and refuses the vector without one", async () => {
    const probe = await probeDawn();
    if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);

    // The SAME two factors, reached through `wide.z` — same picture, different path.
    const byChannel = halves(await renderLuma(graphFor({ mapped: { attribute: "wide", channel: "z" } })));
    expect(byChannel.left).toBeGreaterThan(byChannel.right * 2);

    // §V288: a vector with no channel is not a size, and it says so rather than picking
    // one — "size from `wide`" is not a statement until it names a component.
    const refused = compile(graphFor({ mapped: { attribute: "wide" } })).diagnostics;
    expect(refused.some((d) => d.severity === "error" && /needs a channel/.test(d.message))).toBe(true);
  }, 120_000);

  it("sizes the DEPTH SWEEP by the same attribute, so the shadow is not cast by another shape", () => {
    const plan = compile(graphFor({ mapped: { attribute: "grow" }, shadows: true }));
    expect(plan.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    const draws = plan.passes.filter((pass) => pass.kind === "draw");
    const bindingsOf = (pass: (typeof draws)[number]) =>
      ((pass as { buffers?: ReadonlyArray<{ binding: string }> }).buffers ?? []).map((buffer) => buffer.binding);
    // The lit draw and the shadow sweep are separate passes and BOTH have to carry it.
    /* The shadow phase emits a far-plate CLEAR before the sweep and it binds nothing, so
       the sweep is the shadow draw that reads `positions`. Matching on the id alone would
       find the plate and assert about a pass that has no geometry in it. */
    const shadow = draws.find((pass) => pass.id.includes(":shadow:") && bindingsOf(pass).includes("positions"));
    const lit = draws.find((pass) => pass.id.includes(":scene:"));
    expect(shadow, "a casting light must emit a depth sweep").toBeDefined();
    expect(lit, "the geometry must emit a lit draw").toBeDefined();
    expect(bindingsOf(shadow as (typeof draws)[number])).toContain("pointScales");
    expect(bindingsOf(lit as (typeof draws)[number])).toContain("pointScales");
  });

  it("refuses a mapped scale on a SURFACE by name, rather than drawing the retained static", () => {
    const graph = graphFor({ mapped: { attribute: "grow" }, mode: "instances" });
    (graph.nodes["blocks"] as GraphNode).parameters = {
      ...(graph.nodes["blocks"] as GraphNode).parameters,
      mode: "surface",
    };
    const errors = compile(graph).diagnostics.filter((d) => d.severity === "error");
    expect(errors.some((d) => /no per-point size/.test(d.message))).toBe(true);
  });
});
