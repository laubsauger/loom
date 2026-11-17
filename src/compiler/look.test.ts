import { describe, expect, it } from "vitest";

import { compileGraph } from "./index.ts";
import { prepareFrameCompiler } from "./frame-compile.ts";
import { lookCloneId } from "./look.ts";
import type { ActiveSink, CompileRequest, CompiledGraph } from "./types.ts";
import { createNodeRegistry } from "../nodes/registry/registry.ts";
import { allNodeDefinitions } from "../nodes/definitions/index.ts";
import type { GraphDocument, GraphNode } from "../domain/types/graph.ts";
import type { FrameEvaluationInput } from "../domain/types/frame.ts";
import type { PassDescriptor } from "../runtime/backend/plan.ts";
import { DEFAULT_PREVIEW_ORBIT, type PreviewOrbit } from "../runtime/previews/orbit.ts";

/**
 * §T1732b — LOOK AROUND A RENDER WITHOUT MOVING ITS CAMERA.
 *
 * What the owner needs from it, and so what each case holds: a look moves the picture on the
 * tile and in the viewer, and NOTHING else. The Render's own output (what is exported, what
 * downstream reads) is the same plan with or without a look; the camera node is untouched; a
 * look costs nothing until it is asked for; and an identity look is the camera itself.
 */

const registry = createNodeRegistry(allNodeDefinitions).view();

const SETTINGS = {
  outputResolution: { width: 64, height: 36 },
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

const frameAt = (frameIndex: number): FrameEvaluationInput => ({
  timeSeconds: frameIndex / 60,
  deltaSeconds: 1 / 60,
  frameIndex,
  mode: "offline",
  randomSeed: 7,
});

/** Points, a geometry of them, a camera and a sun, framed by one Render. */
function shot(): GraphDocument {
  const nodes: GraphNode[] = [];
  const edges: Record<string, unknown> = {};
  const add = (id: string, type: string, parameters: Record<string, unknown> = {}): void => {
    nodes.push({ id, type, definitionVersion: registry.get(type)?.version ?? 1, position: { x: 0, y: 0 }, parameters } as never);
  };
  const wire = (from: string, to: string, port: string): void => {
    const id = `e${String(Object.keys(edges).length)}`;
    edges[id] = { id, source: { nodeId: from, portId: "out" }, target: { nodeId: to, portId: port } };
  };
  add("grid", "pointGrid");
  add("geo", "geometry", { mode: "instances" });
  add("cam", "camera", { eye: [0, 1, 4], lookAt: [0, 0, 0] });
  add("sun", "light");
  add("render", "render");
  wire("grid", "geo", "points");
  wire("geo", "render", "scenes");
  wire("cam", "render", "camera");
  wire("sun", "render", "lights");
  return { revision: 1, nodes: Object.fromEntries(nodes.map((node) => [node.id, node])), edges, groups: {} } as never;
}

const CLONE = lookCloneId("render");
const SEEN: ActiveSink[] = [
  { nodeId: "render", portId: "out", kind: "preview" },
  { nodeId: "cam", portId: "out", kind: "preview" },
];
const looking = (orbit: () => PreviewOrbit | undefined): ActiveSink[] => [...SEEN, { nodeId: "render", kind: "look", orbit }];
const request = (sinks: ActiveSink[], graph = shot()): CompileRequest =>
  ({ graph, settings: SETTINGS, registry, capabilities: CAPABILITIES, sinks }) as never;

const ownerOf = (pass: PassDescriptor): string | undefined => ("nodeId" in pass ? pass.nodeId : undefined);
const passesOf = (compiled: CompiledGraph, nodeId: string): PassDescriptor[] => compiled.passes.filter((pass) => ownerOf(pass) === nodeId);
/** A pass's id with its node's id taken out (a pass id spells it twice): the clone's pass for a Render pass has the same key. */
const keyOf = (pass: PassDescriptor, nodeId: string): string => pass.id.replaceAll(nodeId, "$");
const uniformsOf = (pass: PassDescriptor): unknown => ("uniforms" in pass ? pass.uniforms : undefined);

const AROUND: PreviewOrbit = { ...DEFAULT_PREVIEW_ORBIT, azimuth: 0.6, elevation: 0.2, distance: 0.7 };

describe("§T1732b look clones", () => {
  it("with no look asked for, the plan carries no clone, and the Render's picture still says whose look it is", () => {
    const compiled = compileGraph(request(SEEN));
    expect(compiled.ok).toBe(true);
    expect(passesOf(compiled, CLONE)).toEqual([]);
    const render = compiled.outputs.find((output) => output.nodeId === "render" && output.portId === "out");
    const camera = compiled.outputs.find((output) => output.nodeId === "cam");
    // Both rows show the Render's picture, so both answer to the Render's look...
    expect(render?.look).toEqual({ renderer: "render", basis: { eye: [0, 1, 4], lookAt: [0, 0, 0] } });
    expect(camera?.look).toEqual(render?.look);
    // ...and neither has a look picture to show until one is asked for.
    expect(render?.look?.picture).toBeUndefined();
  });

  it("asked for, the Render is drawn twice, and its own passes, resources and row are the plan without a look", () => {
    const without = compileGraph(request(SEEN));
    const withLook = compileGraph(request(looking(() => AROUND)));
    expect(withLook.ok).toBe(true);
    // The real output: the very passes and resources it had, in order. This is what export,
    // thumbnails and every downstream node read, so a look must not reach it.
    expect(withLook.passes.filter((pass) => ownerOf(pass) !== CLONE)).toEqual(without.passes);
    const added = withLook.resources.filter((resource) => !without.resources.some((other) => other.id === resource.id));
    expect(withLook.resources.filter((resource) => !added.includes(resource))).toEqual(without.resources);
    // The clone draws every pass the Render draws, into its own target.
    const clone = passesOf(withLook, CLONE);
    expect(clone.map((pass) => keyOf(pass, CLONE))).toEqual(passesOf(without, "render").map((pass) => keyOf(pass, "render")));
    const render = withLook.outputs.find((output) => output.nodeId === "render" && output.portId === "out");
    const before = without.outputs.find((output) => output.nodeId === "render" && output.portId === "out");
    expect(render?.resourceId).toBe(before?.resourceId);
    const picture = render?.look?.picture;
    expect(picture).toBeDefined();
    expect(picture?.resourceId).not.toBe(render?.resourceId);
    expect(added.map((resource) => resource.id)).toContain(picture?.resourceId);
    // The camera's tile borrows the Render's picture, so it shows the same look.
    const camera = withLook.outputs.find((output) => output.nodeId === "cam");
    expect(camera?.look?.picture).toEqual(picture);
    // The clone is nobody's node: no row, no diagnostic, never reported pruned, and the
    // camera still frames exactly one Render (T546), so its tile is not demoted to the stock scene.
    expect(withLook.outputs.some((output) => output.nodeId === CLONE)).toBe(false);
    expect(withLook.diagnostics.filter((diagnostic) => diagnostic.nodeId === CLONE)).toEqual([]);
    expect(withLook.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(without.diagnostics.map((diagnostic) => diagnostic.code));
    expect(withLook.pruned).toEqual(without.pruned);
  });

  it("a structural compile draws the clone through the camera itself; a look is read at a frame", () => {
    const compiled = compileGraph(request(looking(() => AROUND)));
    const render = new Map(passesOf(compiled, "render").map((pass) => [keyOf(pass, "render"), uniformsOf(pass)]));
    for (const pass of passesOf(compiled, CLONE)) expect(uniformsOf(pass)).toEqual(render.get(keyOf(pass, CLONE)));
  });

  it("at a frame, the clone moves with its look and the Render stays on its camera, even with nothing animated", () => {
    let orbit: PreviewOrbit | undefined = AROUND;
    const frames = prepareFrameCompiler(request(looking(() => orbit)));
    expect(frames.uniformOnly).toBe(true);
    const moved = frames.compileFrame({ frame: frameAt(1) });
    expect(moved).not.toBeNull();
    if (moved === null) return;
    // The Render's own passes are the base's, untouched by the look.
    expect(passesOf(moved, "render")).toEqual(passesOf(frames.base, "render"));
    const render = new Map(passesOf(moved, "render").map((pass) => [keyOf(pass, "render"), uniformsOf(pass)]));
    const differs = passesOf(moved, CLONE).filter((pass) => JSON.stringify(uniformsOf(pass)) !== JSON.stringify(render.get(keyOf(pass, CLONE))));
    // The lit draw at least: it is drawn through the moved eye.
    expect(differs.length).toBeGreaterThan(0);

    // Home again: the identity look is the camera itself, float for float.
    orbit = undefined;
    const home = frames.compileFrame({ frame: frameAt(2) });
    expect(home).not.toBeNull();
    for (const pass of passesOf(home as CompiledGraph, CLONE)) expect(uniformsOf(pass)).toEqual(render.get(keyOf(pass, CLONE)));
  });

  it("a look at a Render nothing keeps draws nothing", () => {
    const compiled = compileGraph(request([{ nodeId: "cam", portId: "out", kind: "preview" }, { nodeId: "render", kind: "look", orbit: () => AROUND }]));
    expect(passesOf(compiled, CLONE)).toEqual([]);
    expect(compiled.outputs.find((output) => output.nodeId === "render")).toBeUndefined();
  });
});
