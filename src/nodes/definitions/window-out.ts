import type { NodeDefinition, CompiledNodeDescription, NodeCompileContext, ResolutionPolicy } from "../../domain/types/node-definition.ts";
import type { EffectPassDescriptor } from "../../runtime/backend/plan.ts";
import { RGBA_TEXTURE } from "./common-ports.ts";
import { missingCompileResource, readCompileInputs } from "./compile-context.ts";
import { SINK_TAG } from "./sink.ts";
import { windowOutShader } from "../shaders/window-out.wgsl.ts";
import { TONE_MAP_OPTIONS, isToneMapOperator, sinkDisplayTransform } from "../../domain/color/display.ts";
import type { ToneMapOperator } from "../../domain/color/display.ts";

/** The type string, named once so session code never spells it (`emission-sites`). */
export const WINDOW_OUT_TYPE = "window";

const FIT_MODES = ["fit", "fill", "stretch"] as const;

/**
 * The pass of a display sink sized by its own Width × Height (§T1391b; shared with WHIP
 * Out, §T1809b): the input placed by Fit into the node's `$target`, display-encoded.
 * `key` names the pass and `label` is what timings show.
 */
export function compileFittedSink(context: NodeCompileContext, key: string, label: string): CompiledNodeDescription {
  const { nodeId, inputs, target, format, space, colorPolicy, parameters, resolution } = readCompileInputs(context);
  const source = inputs["input"];
  if (source === undefined || target === undefined) {
    const what = source === undefined ? 'input port "input"' : "its render target";
    return { passes: [], diagnostics: [missingCompileResource(nodeId, what)] };
  }
  const requested: ToneMapOperator = isToneMapOperator(parameters["toneMap"]) ? parameters["toneMap"] : "none";
  const transform = sinkDisplayTransform(colorPolicy, format, space, requested);
  const fit = FIT_MODES.indexOf(parameters["fit"] as (typeof FIT_MODES)[number]);
  const pass: EffectPassDescriptor = {
    kind: "effect",
    id: transform.toneMap === "none" ? `${nodeId}:${key}` : `${nodeId}:${key}:${transform.toneMap}`,
    shader: windowOutShader(transform),
    target,
    textures: [{ binding: "inputTexture", resourceId: source.resource }],
    samplers: [{ binding: "inputSampler", resourceId: source.sampler }],
    uniformBinding: "params",
    uniforms: { mode: fit < 0 ? 0 : fit, targetAspect: resolution[0] / resolution[1] },
    nodeId,
    label,
  };
  return { passes: [pass] };
}

/**
 * Window Out — a perform window on a chosen screen (§T1391b; TouchDesigner's Window COMP).
 *
 * The owner: *"an easier way to open a perform window … at any screen that is connected …
 * configure which screen and resolution … with a single click"*. The node is the
 * configuration (T960: everything is a node, not a device pane) and its own render target
 * is the picture the window shows, 1:1 — Width × Height, with the input placed by Fit.
 *
 * ## A display sink, not the picture
 *
 * `sink: true` with `sinkRole: "display"`: it draws into its own `$target`, but it is never
 * what the viewer presents or what render-out writes, and it is ACTIVE ONLY WHILE ITS
 * WINDOW IS OPEN (the app names it as a sink then; the owner ruled a closed window costs
 * nothing). A headless compile never opens a window, so there it renders nothing.
 *
 * ## What it shows
 *
 * The wired `input`, or — the TD Window COMP's path — the node NAMED in Source, through the
 * same by-name reference Feedback and Render use (a dashed line on the canvas). The owner
 * ruled both, so the reference declares `wire: true` (B233): with a wire AND a name the
 * wire wins and the name is dormant until the wire is taken away
 * (`domain/graph/source-references.ts`).
 *
 * ## The window's own settings
 *
 * Screen, Fullscreen and Hide cursor are read by the app when it opens the window, never by
 * the compiler: they change nothing in the plan. Screen is a display's label as the browser
 * reports it (`ScreenDetailed.label`); empty means Auto — a screen other than the editor's.
 *
 * The size is Width × Height from the node's own parameters (T151's parameter policy), so
 * "Match screen" in the inspector writes the chosen display's physical pixels here, in one
 * place; the generic per-node resolution override is not offered for this node.
 */
export const windowOutNode: NodeDefinition = {
  type: WINDOW_OUT_TYPE,
  version: 1,
  title: "Window Out",
  category: "output",
  description:
    "Shows its input in a perform window on a chosen screen, at Width × Height, placed by Fit. Open it from the inspector or with the perform key. Renders only while its window is open; never the viewer's picture.",
  sink: true,
  sinkRole: "display",
  tags: [SINK_TAG, "perform", "window", "screen", "display", "fullscreen"],
  inputs: [{ id: "input", label: "Input", type: RGBA_TEXTURE }],
  outputs: [],
  previewInput: "input",
  sourceReferences: [{ parameter: "source", input: "input", wire: true }],
  parameters: {
    source: {
      type: "string",
      label: "Source",
      default: "",
      description: "A node to show, by name, when nothing is wired into Input. A wire wins over the name.",
    },
    width: {
      type: "number",
      label: "Width",
      default: 1920,
      min: 1,
      max: 7680,
      range: "floor",
      step: 1,
      precision: 0,
      description: "The window's picture width in pixels. Match screen sets the chosen display's physical width.",
    },
    height: {
      type: "number",
      label: "Height",
      default: 1080,
      min: 1,
      max: 4320,
      range: "floor",
      step: 1,
      precision: 0,
      description: "The window's picture height in pixels. Match screen sets the chosen display's physical height.",
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
    screen: {
      type: "string",
      label: "Screen",
      default: "",
      description: "The display the window opens on, by its name. Empty: a screen other than the editor's.",
    },
    fullscreen: {
      type: "boolean",
      label: "Fullscreen",
      default: true,
      description: "Request fullscreen on opening. If the browser refuses, enter fullscreen from the window.",
    },
    hideCursor: {
      type: "boolean",
      label: "Hide cursor",
      default: true,
      description: "Hide the mouse pointer over the window.",
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
  // T151's parameter policy; structural until the frozen ResolutionPolicy union grows the
  // kind (the reader, `isParameterPolicy`, tolerates the cast).
  resolutionPolicy: { kind: "parameter", width: "width", height: "height" } as unknown as ResolutionPolicy,
  formatPolicy: { kind: "project" },
  compile: (context) => compileFittedSink(context, "window", "Window Out"),
};
