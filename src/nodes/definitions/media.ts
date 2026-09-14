import type { CompiledNodeDescription, NodeDefinition } from "../../domain/types/node-definition.ts";
import type { ParameterValue } from "../../domain/types/parameters.ts";
import type { EffectPassDescriptor } from "../../runtime/backend/plan.ts";
import { SHARED_SAMPLER_ID, scratchResourceId } from "../../compiler/resources.ts";
import { MEDIA_TRANSPORT_PARAMETERS } from "../../domain/media/transport.ts";
import { RGBA_TEXTURE } from "./common-ports.ts";
import { readCompileInputs } from "./compile-context.ts";
import { wgsl } from "../../runtime/backend/wgsl.ts";

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

const MEDIA_BLIT_WGSL = wgsl`@group(0) @binding(0) var mediaSampler: sampler;
@group(0) @binding(1) var mediaTexture: texture_2d<f32>;

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  return textureSampleLevel(mediaTexture, mediaSampler, uv, 0.0);
}`;

export function compileMedia(context: unknown): CompiledNodeDescription {
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
    "Plays a video file, or shows a still image (PNG, JPEG, WebP, AVIF, GIF, BMP) as a one-frame stream that uploads once and holds — transparent to everything downstream, which cannot tell the two apart. EXR and Radiance .hdr are REFUSED BY NAME rather than crushed into 8 bits; they need the float texture path (T1222). A video gets the transport: play mode, speed, cue, trim and an at-end behaviour — a still has no clock, so those render inactive and say so. Frames upload only when they change; black until a file is loaded. FREE RUN by default (T586): it keeps its own playhead, so Play and Cue Pulse drive it and a clip you just dropped in plays as soon as you press Play, whatever the timeline is doing. Lock it to the timeline and the playhead becomes TIMELINE-ANCHORED instead (§V436) — the position derives from the frame, so frame one of the clip lands on the in point, a scrub finds the same frame every time, and an offline render reproduces. Free run gives up all three of those, and a render says so by name rather than quietly handing you a take that differs from what you saw.",
  tags: ["media", "video", "image", "file", "transport"],
  inputs: [],
  outputs: [{ id: "out", label: "Out", type: RGBA_TEXTURE }],
  parameters: {
    /*
     * T1223 — ONE SLOT THAT TAKES EITHER, which is how TD's Movie File In has always
     * worked. It was `kind: "video"`, so the file dialog offered `video/*` and a still
     * could not even be SELECTED while this node's description claimed it played one.
     */
    file: { type: "asset", label: "File", kind: "picture", group: "File" },
    ...MEDIA_TRANSPORT_PARAMETERS,
  },
  resolutionPolicy: { kind: "project" },
  compile: compileMedia,
};

const CAMERA_FIT_OPTIONS = [
  { value: "prefer", label: "Prefer" },
  { value: "require", label: "Require" },
] as const;

const CAMERA_FACING_OPTIONS = [
  { value: "any", label: "Any" },
  { value: "user", label: "Front (user)" },
  { value: "environment", label: "Back (environment)" },
] as const;

/** Nothing in the Capture group is asked for. The Fit control has nothing to apply to. */
function asksForNothing(values: Readonly<Record<string, ParameterValue>>): boolean {
  const asked = (key: string): boolean => {
    const value = values[key];
    return typeof value === "number" && Number.isFinite(value) && value > 0;
  };
  return !asked("width") && !asked("height") && !asked("frameRate");
}

/**
 * T1043 — THE CAMERA, WITH THE KNOBS THE BROWSER ACTUALLY HAS.
 *
 * The owner: *"the webcam node probably can have some more features, some more parameters
 * like resolution and whatnot — I think we can probably pull a few more things from there."*
 *
 * ## THE DESIGN DECISION, BEFORE THE KNOBS: these are REQUESTS, and the node says so
 *
 * `getUserMedia` constraints are a NEGOTIATION. Ask for 1920x1080 and a camera that has no
 * such mode hands you 1280x720 — successfully, silently, no error. A Resolution parameter
 * that stopped there would be a control that reads back the number you typed and is wrong
 * about the picture, which is §B172's lying readout with a different face.
 *
 * So every parameter here names, IN ITS OWN DESCRIPTION, what happens when the browser
 * declines — and the node REPORTS THE GRANT BESIDE THE REQUEST (§V827's obligation (2):
 * measured, never echoed). The grant is read per call from the live `MediaStreamTrack` and
 * rendered by the inspector's Camera section; where the browser reports nothing it reads
 * ABSENT rather than as a confident zero (§V986). `camera-request.ts` holds that split.
 *
 * The node's OUTPUT resolution already followed the grant before this row existed —
 * `copyExternalImageToTexture` asserts matching extents, so the media hook writes the size
 * the camera actually produced into the node as a `setNodeResolution` patch. That is why
 * Width/Height here cannot be the node's resolution override: the override is the ANSWER,
 * and this is the QUESTION. They are two values and the row exists because they differ.
 *
 * ## WHY NOT ASPECT RATIO, which `getUserMedia` also takes
 *
 * It fights Width and Height rather than adding to them: a request for 1280x720 already
 * states 16:9, and a request for 16:9 alongside a height of 720 is the same sentence said
 * twice in a form where the two can contradict each other. TouchDesigner's Video Device In
 * has resolution and rate, not an aspect constraint, for the same reason. The one thing
 * aspect ratio gives that W/H does not — "any width, but widescreen" — is served by asking
 * for a height alone, which this node already allows (0 = unasked, per axis).
 *
 * ## Resolution is not cosmetic here (§V859)
 *
 * A smaller capture feeding a segmentation or depth node is a REAL saving: those models
 * work at a fixed internal size and upsample, so a 1080p frame buys no detail and costs a
 * 1080p readback every frame. Asking the camera for 640x360 is the cheapest possible
 * version of that saving, because the pixels are never produced at all.
 */
export const webcamNode: NodeDefinition = {
  type: "webcam",
  // Still version 1, deliberately (§V10), on T810's precedent and for T493's reason: every
  // T1043 key carries a DEFAULT, and the defaults are the exact negotiation this node
  // already made (`video: true`, no size, no rate, no facing). No stored document changed
  // shape and none renders differently, so a `migrate` would have nothing to rewrite and a
  // bump without one would emit "nothing describes what changed" on every old file.
  version: 1,
  title: "Webcam",
  category: "input",
  description:
    "A live camera. Frames arrive on the device's schedule; the last frame holds if the stream ends. The Capture parameters ASK the camera for a size, a rate and a facing — they are requests, not settings, and the inspector's Camera section reports what the camera actually granted beside what was asked for. The node's output resolution always follows what ARRIVED.",
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
    width: {
      type: "number",
      label: "Width",
      group: "Capture",
      default: 0,
      min: 0,
      max: 7680,
      step: 1,
      range: "floor",
      unit: "px",
      description:
        "Capture width to ASK the camera for. 0 asks for nothing and takes whatever the camera offers, which is what this node did before it had this parameter. IT IS A REQUEST: on Prefer the browser substitutes its nearest mode and the camera still opens, so you may well get a different number — the Camera section reports the granted size beside this one, and the node's output resolution follows the GRANT. On Require a camera with no such mode refuses to open and the node says which constraint it could not meet. Changing this re-opens the camera.",
    },
    height: {
      type: "number",
      label: "Height",
      group: "Capture",
      default: 0,
      min: 0,
      max: 4320,
      step: 1,
      range: "floor",
      unit: "px",
      description:
        "Capture height to ASK the camera for, on the same terms as Width: 0 asks for nothing, Prefer lets the browser substitute, Require refuses a camera that cannot do it. Asking for a height alone — height 720, width 0 — is how you ask for a size without pinning the aspect. Changing this re-opens the camera.",
    },
    frameRate: {
      type: "number",
      label: "Frame Rate",
      group: "Capture",
      default: 0,
      min: 0,
      max: 240,
      step: 1,
      range: "floor",
      unit: "hz",
      description:
        "Frames per second to ASK the camera for. 0 asks for nothing. A request like Width and Height: Prefer takes the nearest mode the camera has, Require refuses to open one that has no such mode. The rate that actually arrived is reported in the Camera section — and where the browser reports no rate at all it says so rather than showing a number it does not have. Changing this re-opens the camera.",
    },
    facing: {
      type: "enum",
      label: "Facing",
      group: "Capture",
      default: "any",
      options: [...CAMERA_FACING_OPTIONS],
      description:
        "Which camera to prefer where the device has more than one — the front or the back camera of a phone or tablet. ALWAYS asked as a preference, never a requirement, even under Require: most desktop webcams report no facing mode at all, so an exact request would refuse to open the only camera on the machine. A camera that reports no facing is reported as unknown rather than guessed at. Changing this re-opens the camera.",
      inactiveWhen: (values) =>
        typeof values["device"] === "string" && values["device"].trim() !== ""
          ? "A specific camera is chosen in Device, so the facing preference does not apply — the device decides which camera this is."
          : null,
    },
    fit: {
      type: "enum",
      label: "Fit",
      group: "Capture",
      default: "prefer",
      options: [...CAMERA_FIT_OPTIONS],
      description:
        "What a request this camera cannot meet should mean. PREFER asks with `ideal`: the browser picks its nearest mode, the camera always opens, and the Camera section reports what actually arrived beside what was asked for. REQUIRE asks with `exact`: a camera with no matching mode REFUSES TO OPEN — the node stays black and names the constraint it could not meet, which is the only thing that makes requiring different from preferring. Facing is always a preference either way.",
      inactiveWhen: (values) =>
        asksForNothing(values)
          ? "Width, Height and Frame Rate are all 0, so nothing is being requested and there is nothing to prefer or require."
          : null,
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
