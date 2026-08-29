import type { NodeDefinition, CompiledNodeDescription } from "../../domain/types/node-definition.ts";
import type { EffectPassDescriptor } from "../../runtime/backend/plan.ts";
import { RGBA_TEXTURE } from "./common-ports.ts";
import { missingCompileResource, readCompileInputs } from "./compile-context.ts";
import { readColor, readEnumIndex, readFlag, readNumber, readVector } from "./parameter-readers.ts";
import {
  RECTANGLE_FRAGMENT_WGSL,
  CHECKER_FRAGMENT_WGSL,
  CIRCLE_FRAGMENT_WGSL,
  RAMP_FRAGMENT_WGSL,
  UV_FRAGMENT_WGSL,
} from "../shaders/generators.wgsl.ts";

/**
 * Source nodes: Ramp, UV, Checker, Circle (T40).
 *
 * Grouped in one module because they share one shape — no inputs, one texture output,
 * `{kind:"project"}` resolution and format, a single pass — and differ only in the field
 * they evaluate. A generator has nothing to inherit a size or a format from, which is what
 * makes `project` the right policy rather than a default nobody chose.
 *
 * COLOUR (§V56): all four write LINEAR working-space values. Their colour parameters are
 * declared `space: "display"`, matching the Solid node: the number came out of a colour
 * picker, and decoding it to linear is the parameter layer's job, not something a shader
 * does invisibly. NOTE FOR THE TRACK THAT OWNS THAT LAYER: nothing decodes a
 * `space: "display"` parameter today, so those values currently reach a linear buffer
 * unconverted. Every node in this catalogue behaves the same way, so the fix is one change
 * in the resolver rather than twenty here.
 *
 * The exception is UV, whose output is DATA: coordinates, not light.
 */

const RAMP_TYPE_OPTIONS = [
  { value: "horizontal", label: "Horizontal" },
  { value: "vertical", label: "Vertical" },
  { value: "radial", label: "Radial" },
  { value: "circular", label: "Circular" },
] as const;

const RAMP_INTERP_OPTIONS = [
  { value: "linear", label: "Linear" },
  { value: "smooth", label: "Smooth" },
  { value: "constant", label: "Constant" },
] as const;

const CIRCLE_MODE_OPTIONS = [
  { value: "fill", label: "Fill" },
  { value: "distance", label: "Signed Distance" },
] as const;

const BLACK: readonly [number, number, number, number] = [0, 0, 0, 1];
const WHITE: readonly [number, number, number, number] = [1, 1, 1, 1];
const TRANSPARENT: readonly [number, number, number, number] = [0, 0, 0, 0];

/**
 * Ramp — TD's Ramp TOP (T40).
 *
 * Two colour keys rather than TD's editable key list: no parameter type in the manifest
 * can hold a list of colour stops yet (`curve` holds scalar points). Two keys plus phase,
 * period and interpolation covers most real uses, and a genuinely multi-stop palette is
 * better built as Ramp -> Lookup than as a bespoke parameter editor.
 */
export const rampNode: NodeDefinition = {
  type: "ramp",
  version: 1,
  title: "Ramp",
  category: "generator",
  description: "Two-key gradient: horizontal, vertical, radial or circular. TD Ramp TOP.",
  inputs: [],
  outputs: [{ id: "out", label: "Out", type: RGBA_TEXTURE, description: "Linear-space colour." }],
  parameters: {
    type: { type: "enum", label: "Type", default: "horizontal", options: [...RAMP_TYPE_OPTIONS] },
    color1: { type: "color", label: "Color 1", default: BLACK, space: "display" },
    color2: { type: "color", label: "Color 2", default: WHITE, space: "display" },
    interp: {
      type: "enum",
      label: "Interpolation",
      default: "linear",
      options: [...RAMP_INTERP_OPTIONS],
    },
    phase: { type: "number", label: "Phase", default: 0, min: -1, max: 1 },
    period: {
      type: "number",
      label: "Period",
      default: 1,
      min: 0.01,
      max: 16,
      description: "How many times the ramp repeats across its axis.",
    },
  },
  resolutionPolicy: { kind: "project" },
  formatPolicy: { kind: "project" },
  compile(context): CompiledNodeDescription {
    const { nodeId, outputs, parameters } = readCompileInputs(context);
    const target = outputs["out"];
    if (target === undefined) {
      return { passes: [], diagnostics: [missingCompileResource(nodeId, 'output port "out"')] };
    }
    const pass: EffectPassDescriptor = {
      kind: "effect",
      id: `${nodeId}:ramp`,
      shader: RAMP_FRAGMENT_WGSL,
      target,
      uniformBinding: "params",
      uniforms: {
        color1: readColor(parameters, "color1", BLACK),
        color2: readColor(parameters, "color2", WHITE),
        rtype: readEnumIndex(parameters, "type", RAMP_TYPE_OPTIONS, "horizontal"),
        interp: readEnumIndex(parameters, "interp", RAMP_INTERP_OPTIONS, "linear"),
        phase: readNumber(parameters, "phase", 0),
        period: readNumber(parameters, "period", 1),
      },
      nodeId,
      label: "Ramp",
    };
    return { passes: [pass] };
  },
};

/**
 * UV — the identity coordinate field (T40).
 *
 * Its output is DATA (§V56, §V57): red is u, green is v. Nothing may colour-convert it,
 * and once `texture2d.space` exists (T83) this port must be declared `space: "data"` —
 * it is the clearest case in the catalogue, which is why it is worth having as a node
 * rather than as an implicit coordinate inside Displace.
 */
export const uvNode: NodeDefinition = {
  type: "uv",
  version: 1,
  title: "UV",
  category: "generator",
  description: "Texture coordinates as data: red = u, green = v. Feeds Displace and Lookup.",
  inputs: [],
  outputs: [
    {
      id: "out",
      label: "Out",
      type: RGBA_TEXTURE,
      description: "DATA, not colour: red = u, green = v. Never colour-convert this (§V56).",
    },
  ],
  parameters: {
    flipv: {
      type: "boolean",
      label: "Flip V",
      default: false,
      description: "Puts v = 0 at the bottom, for consumers that expect an OpenGL-style origin.",
    },
  },
  resolutionPolicy: { kind: "project" },
  formatPolicy: { kind: "project" },
  compile(context): CompiledNodeDescription {
    const { nodeId, outputs, parameters } = readCompileInputs(context);
    const target = outputs["out"];
    if (target === undefined) {
      return { passes: [], diagnostics: [missingCompileResource(nodeId, 'output port "out"')] };
    }
    const pass: EffectPassDescriptor = {
      kind: "effect",
      id: `${nodeId}:uv`,
      shader: UV_FRAGMENT_WGSL,
      target,
      uniformBinding: "params",
      uniforms: { flipv: readFlag(parameters, "flipv", false) },
      nodeId,
      label: "UV",
    };
    return { passes: [pass] };
  },
};

/** Checker — TD's Checker TOP (T40). `size` is checks across, not pixels per check. */
export const checkerNode: NodeDefinition = {
  type: "checker",
  version: 1,
  title: "Checker",
  category: "generator",
  description: "Two-colour checkerboard. TD Checker TOP.",
  inputs: [],
  outputs: [{ id: "out", label: "Out", type: RGBA_TEXTURE, description: "Linear-space colour." }],
  parameters: {
    size: {
      type: "vector",
      size: 2,
      label: "Size",
      default: [8, 8],
      min: 0.5,
      max: 256,
      description: "Checks across and down.",
    },
    offset: { type: "vector", size: 2, label: "Offset", default: [0, 0] },
    color1: { type: "color", label: "Color 1", default: BLACK, space: "display" },
    color2: { type: "color", label: "Color 2", default: WHITE, space: "display" },
  },
  resolutionPolicy: { kind: "project" },
  formatPolicy: { kind: "project" },
  compile(context): CompiledNodeDescription {
    const { nodeId, outputs, parameters } = readCompileInputs(context);
    const target = outputs["out"];
    if (target === undefined) {
      return { passes: [], diagnostics: [missingCompileResource(nodeId, 'output port "out"')] };
    }
    const pass: EffectPassDescriptor = {
      kind: "effect",
      id: `${nodeId}:checker`,
      shader: CHECKER_FRAGMENT_WGSL,
      target,
      uniformBinding: "params",
      uniforms: {
        color1: readColor(parameters, "color1", BLACK),
        color2: readColor(parameters, "color2", WHITE),
        size: readVector(parameters, "size", [8, 8]),
        offset: readVector(parameters, "offset", [0, 0]),
      },
      nodeId,
      label: "Checker",
    };
    return { passes: [pass] };
  },
};

/**
 * Circle — TD's Circle TOP, plus a signed-distance mode (T40).
 *
 * COLOUR (§V56/§V57), and the one place in this catalogue where a PARAMETER changes what
 * the output means: in `fill` mode the output is linear colour; in `distance` mode the red
 * channel carries a signed distance in uv units (negative inside), which is DATA and must
 * never be colour-converted. When `texture2d.space` lands, this port cannot be given one
 * static space — either the space is derived per-parameter-value, or the distance mode
 * becomes its own node. Flagged rather than quietly picked, because either answer changes
 * the port contract.
 *
 * Distance mode wants a float format: with `rgba8unorm` the negative half of the field
 * clips to zero. The project working format (`rgba16float`) is what `{kind:"project"}`
 * gives it, so the default is right; a per-node format override to an 8-bit format is the
 * user's to make, and the loss is visible immediately.
 */
export const circleNode: NodeDefinition = {
  type: "circle",
  version: 1,
  title: "Circle",
  category: "generator",
  description: "Anti-aliased ellipse, or its signed distance field. TD Circle TOP.",
  inputs: [],
  outputs: [
    {
      id: "out",
      label: "Out",
      type: RGBA_TEXTURE,
      description:
        "Linear colour in Fill mode; DATA (signed distance in red, uv units) in Signed Distance mode.",
    },
  ],
  parameters: {
    mode: { type: "enum", label: "Mode", default: "fill", options: [...CIRCLE_MODE_OPTIONS] },
    center: { type: "vector", size: 2, label: "Center", default: [0.5, 0.5], min: -2, max: 3 },
    radius: { type: "vector", size: 2, label: "Radius", default: [0.25, 0.25], min: 0, max: 4 },
    softness: {
      type: "number",
      label: "Softness",
      default: 0.005,
      min: 0,
      max: 1,
      description: "Width of the edge gradient, in uv units. Fill mode only.",
    },
    fillcolor: { type: "color", label: "Fill Color", default: WHITE, space: "display" },
    bgcolor: { type: "color", label: "Background", default: TRANSPARENT, space: "display" },
    aspectcorrect: {
      type: "boolean",
      label: "Aspect Correct",
      default: true,
      description: "Keeps a circle circular on a non-square output.",
    },
  },
  resolutionPolicy: { kind: "project" },
  formatPolicy: { kind: "project" },
  compile(context): CompiledNodeDescription {
    const { nodeId, outputs, parameters, resolution } = readCompileInputs(context);
    const target = outputs["out"];
    if (target === undefined) {
      return { passes: [], diagnostics: [missingCompileResource(nodeId, 'output port "out"')] };
    }
    const aspect = readFlag(parameters, "aspectcorrect", true) === 1 ? resolution[0] / resolution[1] : 1;
    const pass: EffectPassDescriptor = {
      kind: "effect",
      id: `${nodeId}:circle`,
      shader: CIRCLE_FRAGMENT_WGSL,
      target,
      uniformBinding: "params",
      uniforms: {
        fillcolor: readColor(parameters, "fillcolor", WHITE),
        bgcolor: readColor(parameters, "bgcolor", TRANSPARENT),
        center: readVector(parameters, "center", [0.5, 0.5]),
        radius: readVector(parameters, "radius", [0.25, 0.25]),
        softness: readNumber(parameters, "softness", 0.005),
        aspect,
        mode: readEnumIndex(parameters, "mode", CIRCLE_MODE_OPTIONS, "fill"),
      },
      nodeId,
      label: "Circle",
    };
    return { passes: [pass] };
  },
};

/** The source group, in library order. */
/**
 * Rectangle — Circle's sibling (T242). TD's Rectangle TOP.
 *
 * Same parameter vocabulary, same two modes, same aspect handling as Circle, so the two read
 * as one family. `roundness` is the one addition, and it costs nothing: offsetting a signed
 * distance field inflates the shape in every direction, and an inflated box is a rounded box.
 */
export const rectangleNode: NodeDefinition = {
  type: "rectangle",
  version: 1,
  title: "Rectangle",
  category: "generator",
  description: "Anti-aliased rounded rectangle, or its signed distance field. TD Rectangle TOP.",
  inputs: [],
  outputs: [
    {
      id: "out",
      label: "Out",
      type: RGBA_TEXTURE,
      description:
        "Linear colour in Fill mode; DATA (signed distance in red, uv units) in Signed Distance mode.",
    },
  ],
  parameters: {
    mode: { type: "enum", label: "Mode", default: "fill", options: [...CIRCLE_MODE_OPTIONS] },
    center: { type: "vector", size: 2, label: "Center", default: [0.5, 0.5], min: -2, max: 3 },
    size: { type: "vector", size: 2, label: "Size", default: [0.25, 0.25], min: 0, max: 4 },
    roundness: {
      type: "number",
      label: "Roundness",
      default: 0,
      min: 0,
      max: 1,
      description: "Corner radius in uv units. At half the smaller extent a square is a circle.",
    },
    softness: {
      type: "number",
      label: "Softness",
      default: 0.005,
      min: 0,
      max: 1,
      description: "Width of the edge gradient, in uv units. Fill mode only.",
    },
    fillcolor: { type: "color", label: "Fill Color", default: WHITE, space: "display" },
    bgcolor: { type: "color", label: "Background", default: TRANSPARENT, space: "display" },
    aspectcorrect: {
      type: "boolean",
      label: "Aspect Correct",
      default: true,
      description: "Keeps a square square on a non-square output.",
    },
  },
  resolutionPolicy: { kind: "project" },
  formatPolicy: { kind: "project" },
  compile(context): CompiledNodeDescription {
    const { nodeId, outputs, parameters, resolution } = readCompileInputs(context);
    const target = outputs["out"];
    if (target === undefined) {
      return { passes: [], diagnostics: [missingCompileResource(nodeId, 'output port "out"')] };
    }
    const aspect =
      readFlag(parameters, "aspectcorrect", true) === 1 ? resolution[0] / resolution[1] : 1;
    const pass: EffectPassDescriptor = {
      kind: "effect",
      id: `${nodeId}:rectangle`,
      shader: RECTANGLE_FRAGMENT_WGSL,
      target,
      uniformBinding: "params",
      uniforms: {
        fillcolor: readColor(parameters, "fillcolor", WHITE),
        bgcolor: readColor(parameters, "bgcolor", TRANSPARENT),
        center: readVector(parameters, "center", [0.5, 0.5]),
        size: readVector(parameters, "size", [0.25, 0.25]),
        roundness: readNumber(parameters, "roundness", 0),
        softness: readNumber(parameters, "softness", 0.005),
        aspect,
        mode: readEnumIndex(parameters, "mode", CIRCLE_MODE_OPTIONS, "fill"),
      },
      nodeId,
      label: "Rectangle",
    };
    return { passes: [pass] };
  },
};

export const generatorNodes: readonly NodeDefinition[] = [
  rampNode,
  uvNode,
  checkerNode,
  circleNode,
  rectangleNode,
];
