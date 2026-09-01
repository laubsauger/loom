import type { CompiledNodeDescription, NodeDefinition } from "../../domain/types/node-definition.ts";
import type { EffectPassDescriptor } from "../../runtime/backend/plan.ts";
import { SHARED_SAMPLER_ID, scratchResourceId } from "../../compiler/resources.ts";
import { MEDIA_TRANSPORT_PARAMETERS } from "../../domain/media/transport.ts";
import { RGBA_TEXTURE } from "./common-ports.ts";
import { readCompileInputs } from "./compile-context.ts";

/**
 * Media inputs (T263, §V135, §V167): Movie File In, Webcam — and Text (T243).
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
 *
 * TEXT LIVES HERE, which looks odd for a generator and is the point. A Text node's pixels
 * come from the browser rasterizing a string into a canvas, which is a CPU-supplied
 * texture arriving on its own schedule — the same seam a video frame arrives through, and
 * the reason T243 waited for T262. Its graph side is byte-for-byte the media one: declare
 * an external scratch, blit it. What differs is only what the app registers behind the
 * sourceId, which is the sentence this whole module is built around.
 *
 * WHY THE STRING IS RASTERIZED WHOLE rather than assembled from a glyph atlas: the browser
 * already does shaping, kerning, bidi, font fallback and emoji, and we have no per-glyph
 * quad path. Reimplementing text layout on the GPU to avoid one canvas would be inventing
 * a worse HarfBuzz — and TD's Text TOP is a full-frame layer with alignment rather than a
 * tight bounding box, so per-glyph granularity buys nothing this node wants.
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

/**
 * T493 — Movie File In, WITH A TRANSPORT.
 *
 * It had one parameter, `file`, and looping was hard-coded in the browser environment
 * (`video.loop = true`). There was no play, no cue, no speed, no trim: nothing a
 * TouchDesigner user reaches for. The vocabulary now comes from
 * `MEDIA_TRANSPORT_PARAMETERS`, shared verbatim with Audio File In so that learning one
 * teaches the other and neither can drift — see that module for the clock argument, which
 * is the load-bearing part of this change.
 */
export const movieFileInNode: NodeDefinition = {
  type: "movieFileIn",
  // Still version 1, deliberately (§V10): every T493 key carries a DEFAULT, so no stored
  // data changed shape. Bumping without a `migrate` would emit "nothing describes what
  // changed" on every load of every old file, which would be a warning saying something
  // false. T586 moved that default from the timeline lock to free run and did NOT bump
  // either: a document stores `playMode` only when the user set one, so a project that
  // never touched it now opens free-running — which is how media behaved before T493 as
  // well — and a project that DID choose the lock keeps it. There is nothing for a
  // `migrate` to rewrite, only a default to read differently.
  version: 1,
  title: "Movie File In",
  category: "input",
  description:
    "Plays a video or still image file, with a transport: play mode, speed, cue, trim and an at-end behaviour. Frames upload only when they change; black until a file is loaded. FREE RUN by default (T586): it keeps its own playhead, so Play and Cue Pulse drive it and a clip you just dropped in plays as soon as you press Play, whatever the timeline is doing. Lock it to the timeline and the playhead becomes TIMELINE-ANCHORED instead (§V436) — the position derives from the frame, so frame one of the clip lands on the in point, a scrub finds the same frame every time, and an offline render reproduces. Free run gives up all three of those, and a render says so by name rather than quietly handing you a take that differs from what you saw.",
  tags: ["media", "video", "image", "file", "transport"],
  inputs: [],
  outputs: [{ id: "out", label: "Out", type: RGBA_TEXTURE }],
  parameters: {
    file: { type: "asset", label: "File", kind: "video", group: "File" },
    ...MEDIA_TRANSPORT_PARAMETERS,
  },
  resolutionPolicy: { kind: "project" },
  compile: compileMedia,
};

export const webcamNode: NodeDefinition = {
  type: "webcam",
  version: 1,
  title: "Webcam",
  category: "input",
  description: "A live camera. Frames arrive on the device's schedule; the last frame holds if the stream ends.",
  tags: ["media", "camera", "live", "capture"],
  inputs: [],
  outputs: [{ id: "out", label: "Out", type: RGBA_TEXTURE }],
  parameters: {
    /**
     * T810 — which camera, mirroring the microphone's `device` (T434) so the two read
     * as one convention. Empty string is the system default; the inspector's picker
     * writes an exact `deviceId`. The open path retries bare when the exact device has
     * vanished (unplugged between sessions), and says so — never bricks the node.
     */
    device: {
      type: "string",
      label: "Device",
      default: "",
      description:
        "Camera device id, from the inspector's device picker. Empty = the system default. Device names are hidden by the browser until camera access is granted.",
    },
  },
  resolutionPolicy: { kind: "project" },
  compile: compileMedia,
};

const TEXT_ALIGN_OPTIONS = [
  { value: "left", label: "Left" },
  { value: "center", label: "Center" },
  { value: "right", label: "Right" },
] as const;

const TEXT_VALIGN_OPTIONS = [
  { value: "top", label: "Top" },
  { value: "middle", label: "Middle" },
  { value: "bottom", label: "Bottom" },
] as const;

const TEXT_WHITE: readonly [number, number, number, number] = [1, 1, 1, 1];
const TEXT_TRANSPARENT: readonly [number, number, number, number] = [0, 0, 0, 0];

/**
 * Text — a string as a texture (T243). TD's Text TOP.
 *
 * NONE OF THESE PARAMETERS IS A UNIFORM, which is the thing to understand about this node.
 * They describe what the CPU rasterizes; the pass is a blit of the result. So changing the
 * string is not a §V5 uniform write — it is a new frame from the source, exactly as a video
 * advancing is, and it uploads only when something actually changed (§V136).
 *
 * COLOUR (§V56): the two colours are `space: "display"` like every other picker-driven
 * parameter, and the app reads them in THAT space (`ResolvedParameter.value`) because a
 * canvas paints in sRGB. The decode to the linear working space happens exactly once, in
 * hardware, when the shader samples the `rgba8unorm-srgb` external texture. No curve is
 * applied in JS, and none is applied in WGSL.
 *
 * SIZE IS IN PIXELS OF THE OUTPUT, so a Text node resized to a different resolution
 * rescales its text the way a Blur's radius rescales — the same trade, stated in the same
 * place. The rasterizer draws at the node's RESOLVED size (T312), never the project's:
 * `copyExternalImageToTexture` asserts matching extents, so a per-node override that the
 * canvas did not know about would fail the upload rather than scale.
 */
export const textNode: NodeDefinition = {
  type: "text",
  version: 1,
  // A generator, not an input: it makes pixels from parameters and is reproducible from
  // the document alone. The browser's font stack is the one thing it does not carry — a
  // missing family falls back rather than failing, which is why this is not "input".
  category: "generator",
  title: "Text",
  description:
    "Draws a string, laid out by the browser and uploaded as a texture. Font size is in output pixels.",
  tags: ["text", "type", "generator"],
  inputs: [],
  outputs: [{ id: "out", label: "Out", type: RGBA_TEXTURE, description: "Linear-space colour." }],
  parameters: {
    // Defaults to the word "Text": a freshly dropped node has to show that it works.
    // Blank would be indistinguishable from a node that failed to rasterize.
    text: { type: "string", label: "Text", default: "Text", multiline: true },
    font: {
      type: "string",
      label: "Font",
      default: "sans-serif",
      description: "Any CSS family. Generic families always resolve; a missing one falls back.",
    },
    size: { type: "number", label: "Size", default: 96, min: 1, max: 1024, range: "floor", unit: "px" },
    color: { type: "color", label: "Color", default: TEXT_WHITE, space: "display" },
    bgcolor: {
      type: "color",
      label: "Background",
      default: TEXT_TRANSPARENT,
      space: "display",
      description: "Transparent by default, so text composites over what is underneath.",
    },
    align: { type: "enum", label: "Align", default: "center", options: [...TEXT_ALIGN_OPTIONS] },
    valign: {
      type: "enum",
      label: "Vertical Align",
      default: "middle",
      options: [...TEXT_VALIGN_OPTIONS],
    },
    linespacing: {
      type: "number",
      label: "Line Spacing",
      default: 1.2,
      min: 0.1,
      max: 8,
      range: "floor",
      description: "Multiple of the font size between lines.",
    },
  },
  resolutionPolicy: { kind: "project" },
  compile: compileMedia,
};

export const mediaNodeDefinitions: readonly NodeDefinition[] = [
  movieFileInNode,
  webcamNode,
  textNode,
];
