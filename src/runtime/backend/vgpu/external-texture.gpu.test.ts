import { describe, expect, it } from "vitest";

import type { LogicalExecutionPlan } from "../../../domain/types/backend.ts";
import type { GraphDocument, GraphNode, ProjectSettings } from "../../../domain/types/graph.ts";
import type { BackendCapabilities } from "../../../domain/types/backend.ts";
import type { MediaSource, MediaSourceFrame } from "../backend-types.ts";
import { compileGraph } from "../../../compiler/compile.ts";
import { createNodeRegistry } from "../../../nodes/registry/registry.ts";
import { allNodeDefinitions, mediaSourceIdFor } from "../../../nodes/definitions/index.ts";
import { readExecutionPlan, resourceStructureKey } from "../plan.ts";
import { createVgpuBackend } from "./vgpu-backend.ts";
import { nodeGpuHost, probeDawn } from "./node-gpu-host.ts";

/**
 * T229 end to end on a REAL device: an `externalTexture` resource fed by a registered
 * media source, sampled by an effect, read back as pixels. The B9 lesson applied in
 * advance — the upload seam is proven with actual texels, not with call counts.
 *
 * §V135: the plan below carries only a sourceId. §V136 is the frame-ready contract:
 * an unchanged frameId uploads nothing, which step 3 makes observable by mutating the
 * byte buffer WITHOUT advancing the id — a re-upload would leak the mutation to the
 * screen.
 */

const SIZE = 4;

const COPY_WGSL = `@group(0) @binding(0) var mediaSampler: sampler;
@group(0) @binding(1) var mediaTexture: texture_2d<f32>;

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  return textureSampleLevel(mediaTexture, mediaSampler, uv, 0.0);
}`;

function solid(r: number, g: number, b: number): Uint8Array {
  const bytes = new Uint8Array(SIZE * SIZE * 4);
  for (let index = 0; index < bytes.length; index += 4) {
    bytes.set([r, g, b, 255], index);
  }
  return bytes;
}

/** A hand-cranked source: the test advances frames; the backend must only follow frameId. */
function crankSource(): { source: MediaSource; set(frame: MediaSourceFrame): void } {
  let current: MediaSourceFrame | undefined;
  return {
    source: { currentFrame: () => current },
    set(frame) {
      current = frame;
    },
  };
}

const PLAN: LogicalExecutionPlan = {
  resources: [
    { kind: "externalTexture", id: "media", size: [SIZE, SIZE], format: "rgba8unorm", sourceId: "vid" },
    { kind: "sampler", id: "samp", filter: "nearest" },
    { kind: "target", id: "out", size: [16, 16], format: "rgba8unorm" },
  ],
  passes: [
    {
      kind: "effect",
      id: "copy",
      shader: COPY_WGSL,
      target: "out",
      textures: [{ binding: "mediaTexture", resourceId: "media" }],
      samplers: [{ binding: "mediaSampler", resourceId: "samp" }],
    },
  ],
  diagnostics: [],
};

describe("externalTexture in the plan reader (T229, §V135)", () => {
  it("parses the descriptor, refuses one with no sourceId, and keys structure on the source", () => {
    const read = readExecutionPlan(PLAN);
    expect(read.ok).toBe(true);
    expect(read.resources.find((r) => r.id === "media")?.kind).toBe("externalTexture");

    const missingSource = readExecutionPlan({
      ...PLAN,
      resources: [{ kind: "externalTexture", id: "media", size: [4, 4], format: "rgba8unorm" }],
    });
    expect(missingSource.diagnostics.length).toBeGreaterThan(0);

    // Re-pointing a texture at a different media source is NEW contents, never a carry.
    const a = resourceStructureKey({ kind: "externalTexture", id: "m", size: [4, 4], format: "rgba8unorm", sourceId: "vid-a" });
    const b = resourceStructureKey({ kind: "externalTexture", id: "m", size: [4, 4], format: "rgba8unorm", sourceId: "vid-b" });
    expect(a).not.toBe(b);
  });
});

describe("media node end to end on Dawn (T262/T263, §V167)", () => {
  it("Movie File In: registered bytes come out of the node's output as pixels", async () => {
    const probe = await probeDawn();
    if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);

    const settings: ProjectSettings = {
      outputResolution: { width: 16, height: 16 },
      workingFormat: "rgba16float",
      randomSeed: 1,
      previewLongEdge: 192,
      previewFps: 20,
      limits: { maxResolution: 4096, maxDispatch: 65535, maxBufferBytes: 268_435_456, memoryBudgetBytes: 1_073_741_824 },
    };
    const capabilities: BackendCapabilities = {
      tier: "B",
      features: [],
      formats: ["rgba8unorm", "rgba8unorm-srgb", "rgba16float", "r32float", "depth24plus"],
      timestampQuery: false,
      limits: { maxTextureDimension2D: 8192 },
    };
    const node = (id: string, type: string, extra: Partial<GraphNode> = {}): GraphNode =>
      ({ id, type, definitionVersion: 1, position: { x: 0, y: 0 }, parameters: {}, ...extra }) as GraphNode;
    const graph: GraphDocument = {
      revision: 1,
      nodes: {
        movie: node("movie", "movieFileIn", {
          // rgba8unorm output so the readback bytes compare directly.
          format: { mode: "fixed", format: "rgba8unorm" },
        }),
        sink: node("sink", "output"),
      },
      edges: {
        e0: { id: "e0", source: { nodeId: "movie", portId: "out" }, target: { nodeId: "sink", portId: "input" } },
      },
      groups: {},
    } as unknown as GraphDocument;

    const registry = createNodeRegistry(allNodeDefinitions).view();
    const plan = compileGraph({ graph, settings, registry, capabilities });
    expect(plan.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    // §V167 made concrete: a catalogue node DECLARED the external texture.
    expect(plan.resources.some((r) => r["kind"] === "externalTexture" && r["sourceId"] === mediaSourceIdFor("movie"))).toBe(true);

    const backend = createVgpuBackend({ host: nodeGpuHost() });
    try {
      await backend.initialize({});
      const compiled = await backend.compile(plan);
      const frame = (frameIndex: number) => ({
        frame: { timeSeconds: 0, deltaSeconds: 1 / 60, frameIndex, mode: "offline" as const, randomSeed: 1 },
        pointer: { x: 0, y: 0, buttons: 0 },
        resolution: [16, 16] as [number, number],
      });

      // Fully red, sRGB bytes. The external texture is -srgb: sampling decodes, and the
      // node's blit re-encodes into its rgba8unorm-... no: the target is UNORM, values
      // land linear-encoded-as-stored. Pure red survives both exactly (1.0 either way).
      const red = new Uint8Array(16 * 16 * 4);
      for (let i = 0; i < red.length; i += 4) red.set([255, 0, 0, 255], i);
      backend.registerMediaSource(mediaSourceIdFor("movie"), {
        currentFrame: () => ({ frameId: 1, bytes: red }),
      });
      backend.render(compiled, frame(0));

      const image = await backend.readOutput("target:movie:out");
      const centre = (8 * 16 + 8) * 4;
      expect([...image.bytes.slice(centre, centre + 4)]).toEqual([255, 0, 0, 255]);
    } finally {
      backend.dispose();
    }
  });
});

describe("externalTexture through the backend on Dawn (T229)", () => {
  it("uploads on frame-ready, skips unchanged frames, keeps contents after the source ends", async () => {
    const probe = await probeDawn();
    if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);

    const backend = createVgpuBackend({ host: nodeGpuHost() });
    const errors: string[] = [];
    backend.onDiagnostic((d) => {
      if (d.severity === "error") errors.push(`${d.code}: ${d.message}`);
    });
    const frameAt = (frameIndex: number) => ({
      frame: { timeSeconds: 0, deltaSeconds: 1 / 60, frameIndex, mode: "offline" as const, randomSeed: 7 },
      pointer: { x: 0, y: 0, buttons: 0 },
      resolution: [16, 16] as [number, number],
    });
    const centre = async (): Promise<readonly number[]> => {
      const image = await backend.readOutput("out");
      const offset = (8 * 16 + 8) * 4;
      return [...image.bytes.slice(offset, offset + 4)];
    };

    try {
      await backend.initialize({});
      const compiled = await backend.compile(PLAN);

      // No source registered yet: renders, and the texture is its cleared black.
      backend.render(compiled, frameAt(0));
      expect(await centre()).toEqual([0, 0, 0, 0]);

      // Registration order is free (T229): the source arrives after the compile.
      const crank = crankSource();
      const unregister = backend.registerMediaSource("vid", crank.source);

      // Frame 1: red uploads.
      crank.set({ frameId: 1, bytes: solid(255, 0, 0) });
      backend.render(compiled, frameAt(1));
      expect(await centre()).toEqual([255, 0, 0, 255]);

      // Same frameId, mutated bytes: NOTHING uploads (§V136) — still red, not blue.
      crank.set({ frameId: 1, bytes: solid(0, 0, 255) });
      backend.render(compiled, frameAt(2));
      expect(await centre()).toEqual([255, 0, 0, 255]);

      // Advancing the id uploads the new frame.
      crank.set({ frameId: 2, bytes: solid(0, 255, 0) });
      backend.render(compiled, frameAt(3));
      expect(await centre()).toEqual([0, 255, 0, 255]);

      // A live source can vanish without ceremony (T231): the texture keeps its last
      // contents rather than blanking.
      unregister();
      backend.render(compiled, frameAt(4));
      expect(await centre()).toEqual([0, 255, 0, 255]);

      // T143 carry: an unchanged structure key keeps the texture AND its pixels across
      // a recompile — the paused video frame survives an unrelated edit.
      const recompiled = await backend.compile({ ...PLAN });
      backend.render(recompiled, frameAt(5));
      expect(await centre()).toEqual([0, 255, 0, 255]);

      expect(errors).toEqual([]);
    } finally {
      backend.dispose();
    }
  });
});
