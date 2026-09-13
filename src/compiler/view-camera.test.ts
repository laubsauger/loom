import { describe, expect, it } from "vitest";

import { compileGraph } from "./index.ts";
import { viewportPortId, viewportResourceId, targetResourceId } from "./resources.ts";
import { createNodeRegistry } from "../nodes/registry/registry.ts";
import { allNodeDefinitions } from "../nodes/definitions/index.ts";
import {
  VIEW_CAMERA_FIELD_NAMES,
  viewCameraDeclaration,
  viewCameraHome,
  viewCameraUniforms,
} from "../domain/geometry/view-camera.ts";
import type { GraphDocument } from "../domain/types/graph.ts";
import type { ResolvedOutput } from "./types.ts";

/**
 * §T1311b(a) — THE VIEW-CAMERA CONTRACT, end to end through the real compiler.
 *
 * What is being defended, in the order it can break:
 *
 *  1. a shader that DECLARES the contract gets a VIEWPORT — a second pass into a second
 *     target, with `viewOverride` at 1 — and a row that publishes its home framing;
 *  2. a shader that declares NOTHING gets none of it, silently, because most of the
 *     catalogue is 2D and a 2D piece has no camera to fly;
 *  3. a shader that declares HALF of it is told, by name, which halves are missing —
 *     the §V288 case, where the author meant to opt in and nothing would have said why
 *     the viewer offered no viewport;
 *  4. ⚑ the AUTHORED pass is byte-identical whether a viewport exists or not. That is the
 *     view-only ruling, and it is a property of the plan rather than a promise: the
 *     override has nowhere to write except a target nothing reads;
 *  5. ⚑ the viewport does NOT EXIST without an editor watching — no pass, no target, no
 *     row — so an export, a thumbnail build and every claims run are untouched.
 */

const registry = createNodeRegistry(allNodeDefinitions).view();

const SETTINGS = {
  outputResolution: { width: 64, height: 64 },
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

/** A marcher that opts in: the four fields, and a ray built from them behind the flag. */
const MARCHER_WGSL = `
struct Params {
  viewEye: vec3f,     // @default [0, 1.5, -4]
  viewTarget: vec3f,  // @default [0, 1, 0]
  viewFov: f32,       // @default 1.05
  viewOverride: f32,  // @default 0
  spin: f32,          // @default 0.25
}
@group(0) @binding(3) var<uniform> params: Params;
@fragment fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  var eye = vec3f(0.0, 1.0, -3.0);
  var dir = normalize(vec3f(uv - 0.5, 1.0));
  if (params.viewOverride > 0.5) {
    eye = params.viewEye;
    let f = normalize(params.viewTarget - params.viewEye);
    let r = normalize(cross(vec3f(0.0, 1.0, 0.0), f));
    let u = cross(f, r);
    let focal = 1.0 / tan(max(params.viewFov, 0.05) * 0.5);
    dir = normalize((r * (uv.x - 0.5)) + (u * (0.5 - uv.y)) + (f * focal));
  }
  return vec4f(eye + dir * params.spin, 1.0);
}
`;

/** The same shader with `viewTarget` deleted — the half-declared case. */
const HALF_WGSL = MARCHER_WGSL.replace("  viewTarget: vec3f,  // @default [0, 1, 0]\n", "");

/**
 * The three NUMBERS without the FLAG — the half-declaration that would otherwise reach the
 * GPU as an error rather than as a diagnostic. The runtime binds by name and refuses a value
 * the struct does not declare, so a viewport compiled for this shader would carry a
 * `viewOverride: 1` with nowhere to land.
 */
const FLAGLESS_WGSL = MARCHER_WGSL.replace("  viewOverride: f32,  // @default 0\n", "");

/** A shader with no camera at all: the ordinary 2D case, which must stay silent. */
const FLAT_WGSL = `
struct Params {
  amount: f32, // @default 1
}
@group(0) @binding(3) var<uniform> params: Params;
@fragment fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  return vec4f(uv, params.amount, 1.0);
}
`;

function graphWith(source: string): GraphDocument {
  return {
    revision: 1,
    nodes: {
      src: { id: "src", type: "solid", definitionVersion: 1, position: { x: 0, y: 0 }, parameters: {} },
      shade: {
        id: "shade",
        type: "customWgsl",
        definitionVersion: 1,
        position: { x: 100, y: 0 },
        parameters: { source },
      },
      /* A declared sink, so the marcher renders whether or not anything is PREVIEWING it —
         which is what lets the tests below separate "the node draws" from "an editor is
         watching it", the two states the viewport's existence turns on. */
      out: { id: "out", type: "output", definitionVersion: 1, position: { x: 200, y: 0 }, parameters: {} },
    },
    edges: {
      e1: { id: "e1", source: { nodeId: "src", portId: "out" }, target: { nodeId: "shade", portId: "input" } },
      e2: { id: "e2", source: { nodeId: "shade", portId: "out" }, target: { nodeId: "out", portId: "input" } },
    },
    groups: {},
  } as never;
}

function compileWithSinks(graph: GraphDocument, sinks: Array<{ nodeId: string; portId: string }>) {
  return compileGraph({
    graph,
    settings: SETTINGS,
    registry,
    capabilities: CAPABILITIES,
    sinks: sinks.map((sink) => ({ ...sink, kind: "preview" as const })),
  } as never);
}

const rowFor = (outputs: ReadonlyArray<ResolvedOutput>, nodeId: string, portId: string) =>
  outputs.find((output) => output.nodeId === nodeId && output.portId === portId);

const passFor = (compiled: { passes: ReadonlyArray<unknown> }, id: string) =>
  (compiled.passes as ReadonlyArray<Record<string, unknown>>).find((pass) => pass["id"] === id);

const WATCHED = [{ nodeId: "shade", portId: "out" }];
const VIEW_PASS = "shade#viewport:out";

describe("the contract, read off a shader's declared fields", () => {
  it("names every missing field when a shader declares only some — the §V288 case", () => {
    const declaration = viewCameraDeclaration([
      { name: "viewEye", wgsl: "vec3f" },
      { name: "viewFov", wgsl: "f32" },
    ]);
    expect(declaration.kind).toBe("partial");
    if (declaration.kind !== "partial") throw new Error("unreachable");
    expect(declaration.missing).toEqual(["viewTarget", "viewOverride"]);
    expect(declaration.reason).toContain("viewTarget");
    expect(declaration.reason).toContain("viewOverride");
  });

  it("refuses a field of the wrong WGSL type by name, rather than binding a wrong-shaped uniform", () => {
    const declaration = viewCameraDeclaration(
      VIEW_CAMERA_FIELD_NAMES.map((name) => ({ name, wgsl: name === "viewEye" ? "vec4f" : name === "viewTarget" ? "vec3f" : "f32" })),
    );
    expect(declaration.kind).toBe("partial");
    if (declaration.kind !== "partial") throw new Error("unreachable");
    expect(declaration.mistyped).toEqual([{ name: "viewEye", wgsl: "vec4f", expected: "vec3f" }]);
  });

  it("reads ABSENT, never a default, for a home framing that cannot be measured (§V986)", () => {
    // A degenerate eye/target pair has no direction to orbit around; a zero fov is not a
    // camera. Both must read as "no viewport", not as a substituted stock rig.
    const flag = { viewOverride: 0 };
    expect(viewCameraHome({ ...flag, viewEye: [0, 0, 0], viewTarget: [0, 0, 0], viewFov: 1 })).toBeUndefined();
    expect(viewCameraHome({ ...flag, viewEye: [0, 0, 4], viewTarget: [0, 0, 0], viewFov: 0 })).toBeUndefined();
    expect(viewCameraHome({ ...flag, viewEye: [0, 0, 4], viewTarget: [0, 0, 0] })).toBeUndefined();
    // A vec4f where the contract says vec3f: a value of the wrong SHAPE, not a value to
    // take the first three components of.
    expect(viewCameraHome({ ...flag, viewEye: [0, 0, 4, 0], viewTarget: [0, 0, 0], viewFov: 1.05 })).toBeUndefined();
    // And the FLAG itself, without which the viewport pass would bind a name the struct
    // does not declare — an error at the device instead of a diagnostic at the node.
    expect(viewCameraHome({ viewEye: [0, 0, 4], viewTarget: [0, 0, 0], viewFov: 1.05 })).toBeUndefined();
    expect(viewCameraHome({ ...flag, viewEye: [0, 0, 4], viewTarget: [0, 0, 0], viewFov: 1.05 })).toEqual({
      eye: [0, 0, 4],
      lookAt: [0, 0, 0],
      fovY: 1.05,
    });
  });

  it("writes an eye, a target and an angle — and NO viewProjection, because a marcher has no vertices", () => {
    const values = viewCameraUniforms({ eye: [1, 2, 3], lookAt: [0, 1, 0] }, 0.8);
    expect(values).toEqual({ viewEye: [1, 2, 3], viewTarget: [0, 1, 0], viewFov: 0.8, viewOverride: 1 });
    expect(Object.keys(values)).not.toContain("viewProjection");
  });
});

describe("a shader that opts in gets a viewport", () => {
  it("publishes a row whose home framing is the AUTHOR's stored numbers, not an invented rig", () => {
    const compiled = compileWithSinks(graphWith(MARCHER_WGSL), WATCHED) as never as {
      outputs: ReadonlyArray<ResolvedOutput>; passes: ReadonlyArray<unknown>; resources: ReadonlyArray<Record<string, unknown>>;
    };
    const row = rowFor(compiled.outputs, "shade", viewportPortId("out"));
    expect(row?.viewCamera).toEqual({
      passId: VIEW_PASS,
      eye: [0, 1.5, -4],
      lookAt: [0, 1, 0],
      fovY: 1.05,
      aspect: 1,
    });
    expect(row?.resourceId).toBe(viewportResourceId("shade" as never, "out" as never));
    expect(compiled.resources.some((resource) => resource["id"] === row?.resourceId)).toBe(true);
  });

  it("compiles the viewport pass with the override ON and the authored pass with it OFF", () => {
    const compiled = compileWithSinks(graphWith(MARCHER_WGSL), WATCHED) as never as {
      passes: ReadonlyArray<unknown>;
    };
    const viewport = passFor(compiled, VIEW_PASS);
    const authored = passFor(compiled, "shade#shade:custom");
    expect((viewport?.["uniforms"] as Record<string, unknown>)["viewOverride"]).toBe(1);
    expect((authored?.["uniforms"] as Record<string, unknown>)["viewOverride"]).toBe(0);
    // Both run the SAME shader: a viewport that re-rendered something else would be a
    // picture of a different piece (§V-preview — a preview must not lie about what it shows).
    expect(viewport?.["shader"]).toBe(authored?.["shader"]);
    expect(viewport?.["target"]).toBe(viewportResourceId("shade" as never, "out" as never));
    expect(authored?.["target"]).toBe(targetResourceId("shade" as never, "out" as never));
  });

  it("⚑ leaves the AUTHORED pass byte-identical — the view-only ruling, as a property of the plan", () => {
    /*
     * The defect this is against: a camera override that reached the node's own pass would
     * change what is exported, thumbnailed, claimed and consumed downstream, in every
     * session where somebody had dragged in the viewer. The override cannot do that because
     * it has nowhere to write — so the test is an EQUALITY between a plan with a viewport
     * and one without, on the pass the rest of the system reads.
     */
    const watched = compileWithSinks(graphWith(MARCHER_WGSL), WATCHED) as never as { passes: ReadonlyArray<unknown> };
    const unwatched = compileWithSinks(graphWith(MARCHER_WGSL), []) as never as { passes: ReadonlyArray<unknown> };
    expect(passFor(watched, "shade#shade:custom")).toBeDefined();
    expect(passFor(watched, "shade#shade:custom")).toEqual(passFor(unwatched, "shade#shade:custom"));
  });

  it("⚑ does not exist at all without an editor watching — no pass, no target, no row", () => {
    const compiled = compileWithSinks(graphWith(MARCHER_WGSL), []) as never as {
      outputs: ReadonlyArray<ResolvedOutput>; passes: ReadonlyArray<unknown>; resources: ReadonlyArray<Record<string, unknown>>;
    };
    expect(passFor(compiled, VIEW_PASS)).toBeUndefined();
    expect(compiled.resources.some((resource) => resource["id"] === viewportResourceId("shade" as never, "out" as never))).toBe(false);
    expect(rowFor(compiled.outputs, "shade", viewportPortId("out"))).toBeUndefined();
  });
});

describe("a shader that does not opt in", () => {
  it("gets no viewport and no diagnostic — a 2D piece has no camera to fly", () => {
    const compiled = compileWithSinks(graphWith(FLAT_WGSL), WATCHED) as never as {
      outputs: ReadonlyArray<ResolvedOutput>; diagnostics: ReadonlyArray<{ code: string }>;
    };
    expect(rowFor(compiled.outputs, "shade", viewportPortId("out"))).toBeUndefined();
    expect(compiled.diagnostics.some((diagnostic) => diagnostic.code === "node.customWgsl.viewCamera")).toBe(false);
  });

  it("builds NO viewport for a shader with the numbers but no flag, which would bind a uniform it has no field for", () => {
    const compiled = compileWithSinks(graphWith(FLAGLESS_WGSL), WATCHED) as never as {
      ok: boolean;
      outputs: ReadonlyArray<ResolvedOutput>;
      passes: ReadonlyArray<unknown>;
      diagnostics: ReadonlyArray<{ code: string; message: string }>;
    };
    expect(rowFor(compiled.outputs, "shade", viewportPortId("out"))).toBeUndefined();
    expect(passFor(compiled, VIEW_PASS)).toBeUndefined();
    // And it is told why, rather than left to wonder where its viewport went.
    expect(
      compiled.diagnostics.find((diagnostic) => diagnostic.code === "node.customWgsl.viewCamera")?.message,
    ).toContain("viewOverride");
    expect(compiled.ok).toBe(true);
  });

  it("is told BY NAME when it declared half a camera, and still renders its picture", () => {
    const compiled = compileWithSinks(graphWith(HALF_WGSL), WATCHED) as never as {
      ok: boolean;
      outputs: ReadonlyArray<ResolvedOutput>;
      passes: ReadonlyArray<unknown>;
      diagnostics: ReadonlyArray<{ code: string; severity: string; message: string }>;
    };
    const refusal = compiled.diagnostics.find((diagnostic) => diagnostic.code === "node.customWgsl.viewCamera");
    expect(refusal?.severity).toBe("warning");
    expect(refusal?.message).toContain("viewTarget");
    // Loud, but never destructive: the piece still compiles and still draws.
    expect(compiled.ok).toBe(true);
    expect(passFor(compiled, "shade#shade:custom")).toBeDefined();
    expect(rowFor(compiled.outputs, "shade", viewportPortId("out"))).toBeUndefined();
  });
});
