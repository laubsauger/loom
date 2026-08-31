import { describe, expect, it } from "vitest";

import { compileGraph } from "../../compiler/index.ts";
import { createNodeRegistry } from "../registry/registry.ts";
import { allNodeDefinitions } from "./index.ts";
import { backdropWgsl } from "../shaders/scene-render.wgsl.ts";
import type { GraphDocument, GraphNode } from "../../domain/types/graph.ts";

/**
 * T659 — the environment is DRAWN, and only when asked.
 *
 * The defect this closes: `sampleEnvironment` was read by the reflection and the five
 * irradiance taps and by nothing else, so a wired environment was light with no picture
 * and the visible sky was always the Background colour. The owner found it by looking at
 * E34 and asking whether the sky band was taking at all.
 *
 * What this file stops, in the order the mistakes would cost:
 *
 *  (a) THE SWITCH DEFAULTING ON. Three shipped scenes wire an environment purely as
 *      light; a default-on background would change all three skies in one commit. The
 *      gate is that the emitted backdrop with the switch absent is BYTE-IDENTICAL to
 *      the shader text that shipped before this task, pinned as a literal here so the
 *      claim cannot rot into "whatever the generator currently emits" (§V461).
 *  (b) A SHADER AND A BINDING DISAGREEING. A backdrop that declares `environmentMap`
 *      with no texture bound, or a texture bound to the colour backdrop that never
 *      declared one, is a device-time pipeline error and nothing earlier catches it.
 *  (c) THE RAY BASIS DRIFTING FROM THE BILLBOARD BASIS. Both are built from the same
 *      eye/lookAt; if they ever stop agreeing, the sky and the point sprites disagree
 *      about which way is right and only a look pass would find it. Asserted against
 *      hand-computed numbers for a camera whose basis is arithmetic, not opinion.
 *  (d) SILENCE when the switch is on and nothing is wired.
 */

const registry = createNodeRegistry(allNodeDefinitions).view();

const SETTINGS = {
  outputResolution: { width: 64, height: 32 },
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

/**
 * The backdrop as it shipped before T659, verbatim. A generated string compared against
 * its own generator proves nothing; this is the text a scene rendered yesterday.
 */
const BACKDROP_BEFORE_T659 = `struct Backdrop { color: vec4f };
@group(0) @binding(0) var<uniform> backdrop: Backdrop;
@vertex
fn vs(@builtin(vertex_index) v: u32) -> @builtin(position) vec4f {
  var corners = array<vec2f, 6>(
    vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(-1.0, 1.0),
    vec2f(-1.0, 1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0),
  );
  return vec4f(corners[v], 0.999, 1.0);
}
@fragment
fn fs() -> @location(0) vec4f { return backdrop.color; }`;

function node(id: string, type: string, parameters: Record<string, unknown> = {}, label?: string): GraphNode {
  return {
    id,
    type,
    definitionVersion: 1,
    position: { x: 0, y: 0 },
    parameters,
    ...(label === undefined ? {} : { label }),
  } as never;
}

/**
 * A camera at (0, 0, 4) looking at the origin: forward is exactly (0, 0, −1), so the
 * basis is (right, up, forward) = (+x, +y, −z) and every number below is arithmetic.
 */
function scene(renderParams: Record<string, unknown>, options: { wireEnvironment?: boolean } = {}): GraphDocument {
  const wired = options.wireEnvironment !== false;
  return {
    revision: 1,
    nodes: Object.fromEntries(
      [
        node("grid", "pointGrid", { cols: 8, rows: 8 }, "grid1"),
        node("geo", "geometry", { mode: "surface" }, "geo1"),
        node("cam", "camera", { eye: [0, 0, 4], lookAt: [0, 0, 0], fov: 90, near: 0.1, far: 100 }, "cam1"),
        node("sky", "solid", { color: [1, 0, 0, 1] }, "sky1"),
        node("shot", "render", { scenes: "geo1", camera: "cam1", lights: "", ...renderParams }, "shot1"),
        node("out", "output", {}, "out1"),
      ].map((entry) => [entry.id, entry]),
    ),
    edges: {
      e1: { id: "e1", source: { nodeId: "grid", portId: "out" }, target: { nodeId: "geo", portId: "points" } },
      e2: { id: "e2", source: { nodeId: "shot", portId: "out" }, target: { nodeId: "out", portId: "input" } },
      ...(wired
        ? { e3: { id: "e3", source: { nodeId: "sky", portId: "out" }, target: { nodeId: "shot", portId: "environment" } } }
        : {}),
    },
    groups: {},
  } as never;
}

type Pass = {
  id: string;
  shader?: string;
  textures?: ReadonlyArray<{ binding: string; resourceId: string }>;
  uniforms?: Record<string, ReadonlyArray<number>>;
};

function backdropOf(graph: GraphDocument): { pass: Pass; warnings: ReadonlyArray<string> } {
  const plan = compileGraph({ graph, settings: SETTINGS, registry, capabilities: CAPABILITIES });
  expect(plan.diagnostics.filter((diagnostic) => diagnostic.severity === "error")).toEqual([]);
  const pass = (plan.passes as unknown as Pass[]).find((entry) => entry.id.endsWith("shot:backdrop"));
  expect(pass).toBeDefined();
  return {
    pass: pass as Pass,
    warnings: plan.diagnostics.filter((d) => d.severity === "warning").map((d) => d.code),
  };
}

describe("T659: a wired environment can be DRAWN, and does not draw itself uninvited", () => {
  it("off — the backdrop is the pre-T659 shader to the byte, with no texture and no ray uniforms", () => {
    // Wired but not shown: exactly the state every shipped environment scene is in.
    const { pass, warnings } = backdropOf(scene({}));
    expect(pass.shader).toBe(BACKDROP_BEFORE_T659);
    expect(pass.textures ?? []).toEqual([]);
    expect(Object.keys(pass.uniforms ?? {})).toEqual(["color"]);
    // (The lightless scene raises `node.scene.unlit` and always did; what must be
    // absent is any word about the environment.)
    expect(warnings).not.toContain("node.scene.environment");
    // And the generator's own default is that same text, so nothing has to remember to
    // pass `{ environment: false }`.
    expect(backdropWgsl()).toBe(BACKDROP_BEFORE_T659);
  });

  it("on — the same equirect fetch the reflection uses, bound to the wired resource", () => {
    const { pass } = backdropOf(scene({ showEnvironment: true }));
    expect(pass.shader).toContain("@group(0) @binding(1) var environmentMap: texture_2d<f32>;");
    expect(pass.shader).toContain("fn sampleEnvironment(direction: vec3f) -> vec3f {");
    // The one fetch, not a second copy of the equirect arithmetic (§V349).
    expect(pass.shader).toContain("atan2(direction.x, -direction.z) / 6.2831853 + 0.5");
    // Depth is still the backdrop's: behind everything, and it does not own the frame.
    expect(pass.shader).toContain("vec4f(corners[v], 0.999, 1.0)");
    const bound = (pass.textures ?? []).find((texture) => texture.binding === "environmentMap");
    expect(bound?.resourceId).toBe("target:sky:out");
  });

  it("the ray basis is the camera's own, and the half-extents are the frustum's", () => {
    const { pass } = backdropOf(scene({ showEnvironment: true, environmentIntensity: 2.5 }));
    const uniforms = pass.uniforms ?? {};
    // fov 90 → tan(45°) = 1; the target is 64×32 → aspect 2. Forward is −z exactly.
    expect(uniforms["forward"]?.slice(0, 3)).toEqual([0, 0, -1]);
    // 1e-12, not 1e-15: tan(π/4) is 1.9999999999999998 × the aspect, and pinning the
    // float's last bit would fail on the first refactor of the angle arithmetic.
    expect(uniforms["right"]?.[0]).toBeCloseTo(2, 12);
    expect(uniforms["right"]?.[1]).toBeCloseTo(0, 12);
    expect(uniforms["right"]?.[2]).toBeCloseTo(0, 12);
    expect(uniforms["up"]?.[0]).toBeCloseTo(0, 12);
    expect(uniforms["up"]?.[1]).toBeCloseTo(1, 12);
    expect(uniforms["up"]?.[2]).toBeCloseTo(0, 12);
    // One environment: the intensity that scales the reflection scales the sky, or a
    // surface reflects something brighter than the thing it reflects.
    expect(uniforms["forward"]?.[3]).toBeCloseTo(2.5, 6);
  });

  it("an ORTHOGRAPHIC camera hands in a zero basis — parallel rays see one direction", () => {
    const { pass } = backdropOf(scene({ showEnvironment: true }));
    expect(pass.uniforms?.["right"]?.[0]).toBeCloseTo(2, 12);
    const ortho = compileGraph({
      graph: (() => {
        const graph = scene({ showEnvironment: true }) as unknown as {
          nodes: Record<string, { parameters: Record<string, unknown> }>;
        };
        graph.nodes["cam"]!.parameters["ortho"] = true;
        return graph as unknown as GraphDocument;
      })(),
      settings: SETTINGS,
      registry,
      capabilities: CAPABILITIES,
    });
    const pass2 = (ortho.passes as unknown as Pass[]).find((entry) => entry.id.endsWith("shot:backdrop"));
    for (const axis of [0, 1, 2]) {
      expect(pass2?.uniforms?.["right"]?.[axis]).toBeCloseTo(0, 12);
      expect(pass2?.uniforms?.["up"]?.[axis]).toBeCloseTo(0, 12);
    }
    expect(pass2?.uniforms?.["forward"]?.slice(0, 3)).toEqual([0, 0, -1]);
  });

  it("on with nothing wired SAYS SO, and falls back to the colour backdrop rather than to black", () => {
    const { pass, warnings } = backdropOf(scene({ showEnvironment: true }, { wireEnvironment: false }));
    expect(warnings).toContain("node.scene.environment");
    expect(pass.shader).toBe(BACKDROP_BEFORE_T659);
    expect(pass.textures ?? []).toEqual([]);
  });

  it("every material model sees it — a background is a picture, not a shading term", () => {
    // The reflection is phong-only (lambert and unlit ignore an environment, stated on
    // the input). The BACKGROUND is not a material term, so the default lambert scene
    // above already proves it; this pins the unlit case, the furthest from phong.
    const graph = scene({ showEnvironment: true }) as unknown as {
      nodes: Record<string, { id: string; type: string; parameters: Record<string, unknown> }>;
    };
    graph.nodes["mat"] = node("mat", "materialUnlit", {}, "mat1") as never;
    graph.nodes["geo"]!.parameters["material"] = "mat1";
    const { pass } = backdropOf(graph as unknown as GraphDocument);
    expect(pass.shader).toContain("fn sampleEnvironment(direction: vec3f) -> vec3f {");
  });
});
