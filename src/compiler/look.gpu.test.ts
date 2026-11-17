import { describe, expect, it } from "vitest";

import { compileGraph } from "./index.ts";
import { prepareFrameCompiler } from "./frame-compile.ts";
import type { ActiveSink, CompiledGraph } from "./types.ts";
import { createNodeRegistry } from "../nodes/registry/registry.ts";
import { allNodeDefinitions } from "../nodes/definitions/index.ts";
import { createVgpuBackend } from "../runtime/backend/vgpu/vgpu-backend.ts";
import { nodeGpuHost, probeDawn } from "../runtime/backend/vgpu/node-gpu-host.ts";
import type { GraphDocument, GraphNode } from "../domain/types/graph.ts";
import type { FrameEvaluationInput } from "../domain/types/frame.ts";
import { DEFAULT_PREVIEW_ORBIT, type PreviewOrbit } from "../runtime/previews/orbit.ts";

/**
 * §T1732b — A LOOK MOVES THE PICTURE ON THE TILE AND NOTHING ELSE, on the real GPU.
 *
 * The headless half (`look.test.ts`) holds that the plan's own passes are unchanged. This
 * holds what a user and an export would actually read: the Render's own output is the same
 * bytes with a look on as with none (the clone shares no target and no scratch with it), the
 * look's picture is a different picture once the look has moved, and an identity look is the
 * camera's own picture, byte for byte.
 */

const registry = createNodeRegistry(allNodeDefinitions).view();

const CAPABILITIES = {
  tier: "B" as const,
  features: [],
  formats: ["rgba8unorm", "rgba8unorm-srgb", "rgba16float", "r32float"] as const,
  timestampQuery: false,
  limits: { maxTextureDimension2D: 8192 },
};

const SETTINGS = {
  outputResolution: { width: 128, height: 72 },
  workingFormat: "rgba8unorm" as const,
  randomSeed: 7,
  previewLongEdge: 192,
  previewFps: 20,
  limits: { maxResolution: 4096, maxDispatch: 65535, maxBufferBytes: 268_435_456, memoryBudgetBytes: 1_073_741_824 },
};

const frameAt = (frameIndex: number): FrameEvaluationInput => ({
  timeSeconds: frameIndex / 60,
  deltaSeconds: 1 / 60,
  frameIndex,
  mode: "offline",
  randomSeed: 7,
});

/** A grid of boxes lit by a sun, framed by a camera that looks at them off-axis, with shadows on. */
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
  add("grid", "pointGrid", { cols: 6, rows: 6 });
  add("geo", "geometry", { mode: "instances", scale: 0.12 });
  add("cam", "camera", { eye: [0.4, 1.2, 2.6], lookAt: [0, 0, 0] });
  add("sun", "light", { shadows: true });
  add("render", "render");
  wire("grid", "geo", "points");
  wire("geo", "render", "scenes");
  wire("cam", "render", "camera");
  wire("sun", "render", "lights");
  return { revision: 1, nodes: Object.fromEntries(nodes.map((node) => [node.id, node])), edges, groups: {} } as never;
}

const SEEN: ActiveSink[] = [{ nodeId: "render", portId: "out", kind: "preview" }];

/** Two frames of `plan` on Dawn, then the bytes of each named resource. */
async function draw(plan: CompiledGraph, read: readonly string[]): Promise<Uint8Array[]> {
  expect(plan.diagnostics.filter((d) => d.severity === "error").map((d) => d.message)).toEqual([]);
  const backend = createVgpuBackend({ host: nodeGpuHost() });
  const errors: string[] = [];
  backend.onDiagnostic((d) => {
    if (d.severity === "error") errors.push(`${d.code}: ${d.message}`);
  });
  try {
    await backend.initialize({});
    const compiled = await backend.compile(plan);
    for (let frameIndex = 0; frameIndex < 2; frameIndex += 1) {
      backend.render(compiled, {
        frame: frameAt(frameIndex),
        pointer: { x: 0, y: 0, buttons: 0 },
        resolution: [SETTINGS.outputResolution.width, SETTINGS.outputResolution.height],
      });
    }
    expect(errors).toEqual([]);
    const images: Uint8Array[] = [];
    for (const resourceId of read) images.push((await backend.readOutput(resourceId)).bytes as Uint8Array);
    return images;
  } finally {
    backend.dispose();
  }
}

const differing = (a: Uint8Array, b: Uint8Array): number => {
  let count = 0;
  for (let index = 0; index < a.length; index += 1) if (a[index] !== b[index]) count += 1;
  return count;
};

/** The plan a frame of the app would install with a look at `orbit` standing. */
function lookingAt(orbit: PreviewOrbit): CompiledGraph {
  const frames = prepareFrameCompiler({
    graph: shot(),
    settings: SETTINGS,
    registry,
    capabilities: CAPABILITIES,
    sinks: [...SEEN, { nodeId: "render", kind: "look", orbit: () => orbit }],
  } as never);
  const plan = frames.compileFrame({ frame: frameAt(1) });
  if (plan === null) throw new Error(`the frame path refused a look: ${String(frames.reason)}`);
  return plan;
}

describe("§T1732b a look on Dawn", () => {
  it("leaves the Render's own output byte-identical, and draws the moved camera into its own picture", async () => {
    const probe = await probeDawn();
    if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);

    const plain = compileGraph({ graph: shot(), settings: SETTINGS, registry, capabilities: CAPABILITIES, sinks: SEEN } as never);
    const own = plain.outputs.find((output) => output.nodeId === "render" && output.portId === "out");
    if (own === undefined) throw new Error("the Render has no row");
    const [reference] = await draw(plain, [own.resourceId]);

    const looked = lookingAt({ ...DEFAULT_PREVIEW_ORBIT, azimuth: 0.7, elevation: 0.25 });
    const row = looked.outputs.find((output) => output.nodeId === "render" && output.portId === "out");
    const picture = row?.look?.picture;
    if (row === undefined || picture === undefined) throw new Error("the look drew no picture");
    expect(row.resourceId).toBe(own.resourceId);
    const [real, look] = await draw(looked, [row.resourceId, picture.resourceId]);

    // What export and every downstream node read: the same bytes, look or no look.
    expect(differing(real as Uint8Array, reference as Uint8Array)).toBe(0);
    // The look is a different picture: the boxes seen from elsewhere.
    expect(differing(look as Uint8Array, reference as Uint8Array)).toBeGreaterThan((reference as Uint8Array).length / 50);
  });

  it("an identity look is the camera's own picture, byte for byte", async () => {
    const probe = await probeDawn();
    if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);
    const looked = lookingAt(DEFAULT_PREVIEW_ORBIT);
    const row = looked.outputs.find((output) => output.nodeId === "render" && output.portId === "out");
    const picture = row?.look?.picture;
    if (row === undefined || picture === undefined) throw new Error("the look drew no picture");
    const [real, look] = await draw(looked, [row.resourceId, picture.resourceId]);
    expect(differing(look as Uint8Array, real as Uint8Array)).toBe(0);
  });
});
