import type {
  CompiledNodeDescription,
  MigrationResult,
  NodeDefinition,
} from "../../domain/types/node-definition.ts";
import type { RuntimeDiagnostic } from "../../domain/types/diagnostics.ts";
import type { ColorStop } from "../../domain/types/parameters.ts";
import type { EffectPassDescriptor } from "../../runtime/backend/plan.ts";
import { RGBA_TEXTURE } from "./common-ports.ts";
import { missingCompileResource, readCompileInputs } from "./compile-context.ts";
import {
  readColor,
  readEnumIndex,
  readFlag,
  readNumber,
  readVector,
  type Params,
} from "./parameter-readers.ts";
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
 * COLOUR (§V56): all of them write LINEAR working-space values. Their colour parameters
 * are declared `space: "display"`, matching the Solid node: the number came out of a
 * colour picker, and decoding it to linear is the parameter layer's job, not something a
 * shader does invisibly. The resolver does that decode in one place (T148, B8) — and for
 * Ramp's stop LIST it does it per entry (§V196), because a container that decoded as a
 * unit, or not at all, would be B8 once per stop with only one swatch being checked.
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

/** How many stops the uniform table carries. Mirrors `MAX_STOPS` in the shader. */
export const RAMP_MAX_STOPS = 16;

const DEFAULT_RAMP_STOPS: readonly ColorStop[] = [
  { position: 0, color: BLACK },
  { position: 1, color: WHITE },
];

/**
 * Packs a stop list into the shader's flat uniform table (T270).
 *
 * Twenty `vec4f` members rather than `array<vec4f, 16>`: the plan carries uniform values
 * as FLAT number lists (`UniformValue`), and vgpu writes a WGSL array element-wise from a
 * nested list the contract cannot express. See the shader's own note. The tail past
 * `count` is padded with the last stop so a stray read is at worst the edge colour, never
 * uninitialised memory.
 */
function packStops(stops: readonly ColorStop[]): Record<string, number | readonly number[]> {
  const used = stops.slice(0, RAMP_MAX_STOPS);
  const last = used[used.length - 1] ?? { position: 1, color: WHITE };
  const uniforms: Record<string, number | readonly number[]> = { count: used.length };
  for (let index = 0; index < RAMP_MAX_STOPS; index += 1) {
    const stop = used[index] ?? last;
    uniforms[`c${index}`] = [...stop.color];
  }
  for (let group = 0; group < RAMP_MAX_STOPS / 4; group += 1) {
    uniforms[`p${group}`] = [0, 1, 2, 3].map((offset) => {
      const stop = used[group * 4 + offset] ?? last;
      return stop.position;
    });
  }
  return uniforms;
}

/** A tolerant read of the stops parameter — the document may disagree (§V10). */
function readStops(parameters: Params, key: string): readonly ColorStop[] {
  const value = parameters[key];
  if (!Array.isArray(value)) return DEFAULT_RAMP_STOPS;
  const stops = value.flatMap((entry): ColorStop[] => {
    if (typeof entry !== "object" || entry === null) return [];
    const stop = entry as { position?: unknown; color?: unknown };
    if (typeof stop.position !== "number" || !Number.isFinite(stop.position)) return [];
    if (!Array.isArray(stop.color) || stop.color.length !== 4) return [];
    const color = stop.color.filter(
      (channel): channel is number => typeof channel === "number" && Number.isFinite(channel),
    );
    if (color.length !== 4) return [];
    return [{ position: stop.position, color: color as unknown as ColorStop["color"] }];
  });
  return stops.length > 0 ? stops : DEFAULT_RAMP_STOPS;
}

/**
 * Ramp — TD's Ramp TOP (T40, T270).
 *
 * Two colours WAS this node, and two colours is the degenerate case of a gradient: every
 * palette anyone actually wants — a heat map, a duotone with a highlight, a three-stop
 * sky — was inexpressible, and the workaround (Ramp into a Lookup) needs the multi-stop
 * ramp to build the lookup with.
 *
 * The stop list is one `stops` parameter, static as a whole (§V195) with its colours
 * decoded per entry by the resolver (§V196). It compiles to a CAPPED uniform table of
 * sixteen, plus a count, with a diagnostic past it — not a LUT texture, which would add a
 * resource per Ramp for a case a small array covers, and not a silent truncation, which
 * would drop the last colours of a gradient with nothing to point at.
 */
export const rampNode: NodeDefinition = {
  type: "ramp",
  version: 2,
  title: "Ramp",
  category: "generator",
  description: "Multi-stop gradient: horizontal, vertical, radial or circular. TD Ramp TOP.",
  inputs: [],
  outputs: [{ id: "out", label: "Out", type: RGBA_TEXTURE, description: "Linear-space colour." }],
  parameters: {
    type: { type: "enum", label: "Type", default: "horizontal", options: [...RAMP_TYPE_OPTIONS] },
    stops: {
      type: "stops",
      label: "Stops",
      default: DEFAULT_RAMP_STOPS,
      space: "display",
      maxStops: RAMP_MAX_STOPS,
      description:
        "Colour keys in order. The gradient interpolates between consecutive keys and holds outside the first and last.",
    },
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
  /**
   * §V10: a version-1 Ramp carries `color1`/`color2`, which version 2 has no parameter
   * for. Those two keys ARE the two-stop degenerate case, so the migration is exact —
   * nothing is guessed and nothing is lost, and a saved project opens looking identical.
   */
  migrate(oldVersion, data): MigrationResult {
    const parameters = (typeof data === "object" && data !== null ? data : {}) as Record<string, unknown>;
    if (oldVersion >= 2) return { parameters };
    const { color1, color2, ...rest } = parameters;
    const key = (value: unknown, fallback: readonly [number, number, number, number]) =>
      Array.isArray(value) && value.length === 4 && value.every((c) => typeof c === "number")
        ? (value as unknown as ColorStop["color"])
        : fallback;
    return {
      parameters: {
        ...rest,
        stops: [
          { position: 0, color: key(color1, BLACK) },
          { position: 1, color: key(color2, WHITE) },
        ],
      },
    };
  },
  compile(context): CompiledNodeDescription {
    const { nodeId, outputs, parameters } = readCompileInputs(context);
    const target = outputs["out"];
    if (target === undefined) {
      return { passes: [], diagnostics: [missingCompileResource(nodeId, 'output port "out"')] };
    }
    const stops = readStops(parameters, "stops");
    const diagnostics: RuntimeDiagnostic[] = [];
    if (stops.length > RAMP_MAX_STOPS) {
      // Reported, not truncated silently. The picture WILL be missing the tail — saying
      // which stops and how many is the difference between a limit and a mystery.
      diagnostics.push({
        severity: "warning",
        code: "ramp.stops.capped",
        message: `Ramp has ${stops.length} stops; only the first ${RAMP_MAX_STOPS} are rendered.`,
        nodeId,
        suggestion: `Remove ${stops.length - RAMP_MAX_STOPS} stop(s), or split the gradient across two Ramps.`,
      });
    }
    /**
     * The list order IS the gradient (the shader walks consecutive pairs), so a
     * non-monotonic list is not re-sorted — it renders a hard edge at that segment. That
     * is deterministic and matches what the editor shows, but it is almost never what the
     * author meant, so it is worth saying once.
     */
    const packed = stops.slice(0, RAMP_MAX_STOPS);
    const outOfOrder = packed.some((stop, index) => index > 0 && stop.position < (packed[index - 1]?.position ?? 0));
    if (outOfOrder) {
      diagnostics.push({
        severity: "warning",
        code: "ramp.stops.unordered",
        message: "Ramp's stop positions do not increase; the gradient has a hard edge where they cross.",
        nodeId,
        suggestion: "Reorder the stops, or move their positions so each is at or after the one before it.",
      });
    }
    const pass: EffectPassDescriptor = {
      kind: "effect",
      id: `${nodeId}:ramp`,
      shader: RAMP_FRAGMENT_WGSL,
      target,
      uniformBinding: "params",
      uniforms: {
        ...packStops(packed),
        rtype: readEnumIndex(parameters, "type", RAMP_TYPE_OPTIONS, "horizontal"),
        interp: readEnumIndex(parameters, "interp", RAMP_INTERP_OPTIONS, "linear"),
        phase: readNumber(parameters, "phase", 0),
        period: readNumber(parameters, "period", 1),
      },
      nodeId,
      label: "Ramp",
    };
    return diagnostics.length === 0 ? { passes: [pass] } : { passes: [pass], diagnostics };
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
