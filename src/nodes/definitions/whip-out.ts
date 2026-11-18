import type { NodeDefinition, ResolutionPolicy } from "../../domain/types/node-definition.ts";
import { RGBA_TEXTURE } from "./common-ports.ts";
import { SINK_TAG } from "./sink.ts";
import { compileFittedSink } from "./window-out.ts";
import { TONE_MAP_OPTIONS } from "../../domain/color/display.ts";

/**
 * The H.264 profiles a WHIP Out can ask for, with the `profile-level-id` prefix that names
 * each in a browser's codec list.
 */
export const WHIP_PROFILES = [
  { value: "constrained-baseline", label: "Constrained Baseline", id: "42e0" },
  { value: "baseline", label: "Baseline", id: "4200" },
  { value: "main", label: "Main", id: "4d00" },
  { value: "high", label: "High", id: "6400" },
] as const;

/**
 * The default profile: High. Chromium on a Mac encodes it in hardware (9 ms a frame at 1080p against
 * 20 ms in software for Constrained Baseline), and MediaMTX and the studio's players took it (T1815b).
 */
export const WHIP_DEFAULT_PROFILE = "high" satisfies (typeof WHIP_PROFILES)[number]["value"];

/** The type string, named once so session code never spells it (`emission-sites`). */
export const WHIP_OUT_TYPE = "whipOut";

/**
 * WHIP Out — a live video output over WebRTC (§T1809b; design
 * `docs/whip-out-design-2026-11-17.md`; TouchDesigner's Video Stream Out TOP).
 *
 * The node is the configuration and its own render target is the picture that is encoded,
 * at exactly Width × Height: the encoded size is a contract with the receiver, so it does
 * not follow an upstream resolution, a window or a device pixel ratio.
 *
 * ## A display sink that emits
 *
 * `sinkRole: "display"` like Window Out: it draws into its own `$target`, is never the
 * viewer's picture, and is ACTIVE ONLY WHILE THE APP NAMES IT, which the pump
 * (`src/app/use-whip-outputs.ts`) does only while the node is publishing. A headless
 * compile, a take and `pnpm render` never name it, so there it renders nothing.
 *
 * `sideEffect: "emits"` like Syphon/NDI Out: its pixels leave the process. Nothing here
 * sends anything (§T949); Server, Stream path, Frame rate, Bitrate, H.264 profile, Key
 * frame every, Audio and Publish are read by the pump and change nothing in the plan.
 *
 * No password or token is a parameter: a parameter is saved. The pump refuses a login in
 * the Server URL and holds a bearer token as session state.
 */
export const whipOutNode: NodeDefinition = {
  type: WHIP_OUT_TYPE,
  version: 1,
  title: "WHIP Out",
  category: "output",
  description:
    "Publishes its input as live H.264 video over WebRTC to a WHIP server such as MediaMTX, at Width × Height and Frame rate. Needs no helper. Sends only in a live session, while Publish is on and Server is set; freezes while the Loom tab is hidden and no perform window is showing. Never the viewer's picture.",
  sink: true,
  sinkRole: "display",
  sideEffect: "emits",
  tags: [SINK_TAG, "whip", "webrtc", "stream", "video", "network", "mediamtx"],
  inputs: [{ id: "input", label: "Input", type: RGBA_TEXTURE }],
  outputs: [],
  previewInput: "input",
  parameters: {
    enabled: { type: "boolean", label: "Publish", default: true },
    server: {
      type: "string",
      label: "Server",
      default: "",
      description:
        "The WHIP server, for example http://127.0.0.1:8889. Empty sends nothing. A login or a query string in the URL is refused: enter a token in the Stream section instead, where it is not saved.",
    },
    path: {
      type: "string",
      label: "Stream path",
      default: "loom",
      description: "The stream's name on the server. The endpoint is Server/Stream path/whip.",
    },
    width: {
      type: "number",
      label: "Width",
      default: 1920,
      min: 16,
      max: 7680,
      range: "floor",
      step: 2,
      precision: 0,
      description: "The encoded width in pixels. Must be even.",
    },
    height: {
      type: "number",
      label: "Height",
      default: 1080,
      min: 16,
      max: 4320,
      range: "floor",
      step: 2,
      precision: 0,
      description: "The encoded height in pixels. Must be even.",
    },
    fit: {
      type: "enum",
      label: "Fit",
      default: "fit",
      options: [
        { value: "fit", label: "Fit (letterbox)" },
        { value: "fill", label: "Fill (crop)" },
        { value: "stretch", label: "Stretch" },
      ],
      description: "Where the input lands when its aspect differs from Width × Height.",
    },
    frameRate: {
      type: "number",
      label: "Frame rate",
      default: 30,
      min: 1,
      max: 60,
      step: 1,
      precision: 0,
      description: "Frames per second captured for the stream. Loom itself may render faster.",
    },
    bitrate: {
      type: "number",
      label: "Bitrate (kbit/s)",
      default: 16000,
      min: 100,
      max: 50000,
      step: 100,
      precision: 0,
      description: "The most the video may use. When the picture needs more, the encoder keeps the frame rate and sends a smaller size (the Stream section shows the size sent). A key frame is about ten times a frame: at a low bitrate each one arrives late and the picture stutters (measured at 1080p: 190 to 250 ms late at 5000, none at 16000).",
    },
    profile: {
      type: "enum",
      label: "H.264 profile",
      default: WHIP_DEFAULT_PROFILE,
      options: WHIP_PROFILES.map(({ value, label }) => ({ value, label })),
      description:
        "The profile that is sent, and no other: a browser or a server without it refuses the stream and the node says so. None of them sends B-frames. Constrained Baseline is the most widely decoded. On a Mac, Chromium encodes it in software (measured: 20 ms a frame at 1080p, 8 fps beside a busy render) and Baseline and High in hardware (9 ms).",
    },
    keyInterval: {
      type: "number",
      label: "Key frame every (s)",
      default: 0,
      min: 0,
      max: 10,
      step: 0.5,
      precision: 1,
      description: "0 sends a full picture only when the server asks (MediaMTX asks about every 2 s, and when a receiver joins). Above 0, one is sent at least this often as well: a receiver recovers sooner, and each one costs about ten frames of data, which shows as a stutter at a low bitrate.",
    },
    audio: {
      type: "boolean",
      label: "Audio",
      default: false,
      description: "Adds Loom's own sound (what it sends to the speakers) to the stream as Opus.",
    },
    toneMap: {
      type: "enum",
      label: "Tone map",
      default: "none",
      options: [...TONE_MAP_OPTIONS],
      compileTime: true,
      description: "Rolls HDR values off instead of clipping them, as on Output.",
    },
  },
  // As Window Out: sized by its own parameters (T151's parameter policy).
  resolutionPolicy: { kind: "parameter", width: "width", height: "height" } as unknown as ResolutionPolicy,
  formatPolicy: { kind: "project" },
  compile: (context) => compileFittedSink(context, "whip", "WHIP Out"),
};
