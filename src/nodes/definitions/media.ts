import type { CompiledNodeDescription, NodeDefinition } from "../../domain/types/node-definition.ts";
import type { EffectPassDescriptor } from "../../runtime/backend/plan.ts";
import { SHARED_SAMPLER_ID, scratchResourceId } from "../../compiler/resources.ts";
import { RGBA_TEXTURE } from "./common-ports.ts";
import { readCompileInputs } from "./compile-context.ts";

/**
 * Media inputs (T263, §V135, §V167): Movie File In and Webcam.
 *
 * Per the T231 shaping, a file player, a webcam and a screen capture are the SAME
 * `MediaSource` — pull-based frames on the source's own schedule. So these two nodes
 * differ only in what the APP registers behind their sourceId (T264: file decode vs
 * getUserMedia); the graph side is identical: declare an `external` scratch texture
 * (T262) and blit it to the node's output.
 *
 * The sourceId is derived from the NODE ID — stable across renames and serialization —
 * via `mediaSourceIdFor`, which is the one function the app side keys on. The external
 * texture is `rgba8unorm-srgb`: decoded video frames are display-encoded, and sampling
 * an -srgb texture decodes to the linear working space for free (§V56).
 *
 * A node whose source is not registered (file not picked yet, camera denied) shows
 * black and keeps working — the T264 half turns the denial into a diagnostic.
 */

export const MEDIA_TEXTURE_KEY = "media";

/** The media-registry key for a node — `registerMediaSource(mediaSourceIdFor(nodeId), ...)`. */
export function mediaSourceIdFor(nodeId: string): string {
  return `media:${nodeId}`;
}

const MEDIA_BLIT_WGSL = `@group(0) @binding(0) var mediaSampler: sampler;
@group(0) @binding(1) var mediaTexture: texture_2d<f32>;

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  return textureSampleLevel(mediaTexture, mediaSampler, uv, 0.0);
}`;

function compileMedia(context: unknown): CompiledNodeDescription {
  const { nodeId, outputs } = readCompileInputs(context as Parameters<typeof readCompileInputs>[0]);
  const target = outputs["out"];
  if (target === undefined) return { passes: [] };

  const pass: EffectPassDescriptor = {
    kind: "effect",
    id: `${nodeId}:media`,
    shader: MEDIA_BLIT_WGSL,
    target,
    samplers: [{ binding: "mediaSampler", resourceId: SHARED_SAMPLER_ID }],
    textures: [{ binding: "mediaTexture", resourceId: scratchResourceId(nodeId, MEDIA_TEXTURE_KEY) }],
    nodeId,
  };
  return {
    passes: [pass],
    scratch: [
      {
        key: MEDIA_TEXTURE_KEY,
        kind: "external",
        sourceId: mediaSourceIdFor(nodeId),
        format: "rgba8unorm-srgb",
      },
    ],
  };
}

export const movieFileInNode: NodeDefinition = {
  type: "movieFileIn",
  version: 1,
  title: "Movie File In",
  category: "generator",
  description: "Plays a video or still image file. Frames upload only when they change; black until a file is loaded.",
  tags: ["media", "video", "image", "file"],
  inputs: [],
  outputs: [{ id: "out", label: "Out", type: RGBA_TEXTURE }],
  parameters: {
    file: { type: "asset", label: "File", kind: "video" },
  },
  resolutionPolicy: { kind: "project" },
  compile: compileMedia,
};

export const webcamNode: NodeDefinition = {
  type: "webcam",
  version: 1,
  title: "Webcam",
  category: "generator",
  description: "A live camera. Frames arrive on the device's schedule; the last frame holds if the stream ends.",
  tags: ["media", "camera", "live", "capture"],
  inputs: [],
  outputs: [{ id: "out", label: "Out", type: RGBA_TEXTURE }],
  parameters: {},
  resolutionPolicy: { kind: "project" },
  compile: compileMedia,
};

export const mediaNodeDefinitions: readonly NodeDefinition[] = [movieFileInNode, webcamNode];
