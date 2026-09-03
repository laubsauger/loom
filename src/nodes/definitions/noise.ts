import type { NodeDefinition, CompiledNodeDescription } from "../../domain/types/node-definition.ts";
import type { ParameterValue } from "../../domain/types/parameters.ts";
import type { EffectPassDescriptor } from "../../runtime/backend/plan.ts";
import { hashSeed } from "../../domain/rng/rng.ts";
import { RGBA_TEXTURE } from "./common-ports.ts";
import { missingCompileResource, readCompileInputs } from "./compile-context.ts";
import {
  DEGREES_TO_RADIANS,
  TRANSFORM_ORDER_OPTIONS,
  readEnumIndex,
  readFlag,
  readNumber,
  readVector,
} from "./parameter-readers.ts";
import { NOISE_FRAGMENT_WGSL, NOISE_TYPE_OPTIONS } from "../shaders/noise.wgsl.ts";

/**
 * Noise — the procedural field generator (T70; TD's Noise TOP).
 *
 * PARAMETER NAMES are TD's, abbreviations included (`harmon`, `rough`, `exp`, `t`, `r`,
 * `s`, `p`, `xord`, `t4d`, `s4d`). §C makes the TD TOP family the reference vocabulary for
 * the core set, and this node is the one people arrive already knowing: renaming `harmon`
 * to `harmonics` would be tidier and would also mean every TD user has to look it up.
 *
 * TYPES: perlin 2D/3D/4D, simplex 2D/3D, alligator (Worley/cellular F1) and random.
 * TD's remaining types — sparse, hermite, harmonic, randomgpu, simplex4d — are NOT in the
 * enum, deliberately: an option a user can select and that renders something unrelated is
 * worse than an option that is not there. They can be added one at a time, each with its
 * own implementation, without touching anything else here.
 *
 * TIME (§V44, §V436, T497 — corrected by T1101): our `ParameterValue` envelope is still
 * static passthrough (§V61, T106), so a TD user's habit of typing `absTime.seconds` into
 * Translate 4D has nowhere to land yet. `speed` is the temporary seam for it: the shader
 * reads the ABSOLUTE clock — `frameU.absTime`, filled from `FrameEvaluationInput` — and
 * the 4th noise dimension becomes `t4d + absTime * speed`. FREE-RUNNING, not timeline
 * time: a bounded timeline wraps at the out point, and a scrolling field that snapped
 * back there was B98's seam in the LFO (T497 moved this off `frameU.time` for the same
 * reason). No wall clock is reachable from a node (lint-enforced); offline the two
 * clocks agree until a wrap, so a fixed-step render still reproduces per frame — but a
 * LIVE seek does not rewind this field, because a seek never rewinds abstime (§T1098).
 * `speed` defaults to 0, matching TD, where a Noise TOP is a still image until you
 * animate it.
 *
 * SEED (§V45): `seed` is folded into a uint32 with the domain's `hashSeed` — the same hash
 * the CPU-side RNG uses — and the GPU derives every value from an integer hash of that
 * seed and the lattice cell. Deliberately NOT mixed with the node id: in TD, two Noise
 * TOPs with the same seed give the same image, and making identity part of the seed would
 * quietly break that. The project seed IS mixed in, inside the shader, from the shared
 * block, so re-seeding a project re-seeds every generator in it.
 *
 * NOT STATEFUL (§V46): the field is a pure function of (uv, parameters, frame time), so
 * there is no history to reset, checkpoint or replay, and no `stateful` block to declare.
 * Any frame can be rendered without rendering the one before it.
 *
 * COLOUR (§V56): the output is a LINEAR-space colour texture. The values are generated
 * in the working space directly — there is no encoded source to decode, so nothing here
 * converts anything. Alpha is always 1.
 *
 * `resolutionPolicy`/`formatPolicy` are `project`: a generator with no inputs has nothing
 * to inherit from.
 *
 * NOT IMPLEMENTED, and worth stating plainly: TD's `rord` (rotate order) has no meaning
 * here. The field is transformed in the uv plane, which has one rotation axis, so an
 * ordering of three axis rotations would be a control that changes nothing. It belongs
 * with a genuinely 3D noise transform, not with this one.
 */
/**
 * §V146 / B14 — the noise types that actually HAVE a fourth dimension.
 *
 * `baseNoise` switches on the type and samples `q.xy` for the 2D ones, `q.xyz` for the
 * 3D ones, and the whole `vec4` only for Perlin 4D and Random. `w` is where `t4d`, `s4d`
 * and `Time Speed` live, so on every other type the shader discards them — silently, and
 * `perlin2d` is the DEFAULT. A user who adds a Noise, sets Time Speed and presses play
 * gets a still image having done everything right; the reason has to be visible on the
 * control rather than left for them to deduce.
 */
const FOUR_DIMENSIONAL = new Set(["perlin4d", "random"]);

function fourthDimensionMissing(values: Readonly<Record<string, ParameterValue>>): string | null {
  const type = values["type"];
  if (typeof type !== "string" || FOUR_DIMENSIONAL.has(type)) return null;
  return "This noise type samples a 2D or 3D slice, which has no fourth dimension to move along. Choose Perlin 4D or Random to use it.";
}

export const noiseNode: NodeDefinition = {
  type: "noise",
  version: 1,
  title: "Noise",
  category: "generator",
  description:
    "Procedural noise field: perlin/simplex/cellular/random, fractal harmonics, 4D time evolution. TD Noise TOP parameter names.",
  inputs: [],
  outputs: [
    {
      id: "out",
      label: "Out",
      type: RGBA_TEXTURE,
      description: "Linear-space colour. Alpha is 1; monochrome unless `mono` is off.",
    },
  ],
  parameters: {
    type: {
      type: "enum",
      label: "Type",
      default: "perlin2d",
      options: [...NOISE_TYPE_OPTIONS],
      group: "Noise",
    },
    seed: {
      type: "number",
      label: "Seed",
      default: 1,
      step: 1,
      group: "Noise",
      description: "Same seed, same field — on any GPU, in any run (§V45).",
    },
    period: {
      type: "number",
      label: "Period",
      default: 0.25,
      min: 0.001,
      max: 100,
      range: "floor",
      scale: "log",
      group: "Noise",
      description:
        "Feature size, in fractions of the image. Defaults smaller than TD's 1.0 because the field is sampled over the unit uv square rather than TD's world units.",
    },
    harmon: {
      type: "number",
      label: "Harmonics",
      default: 3,
      min: 0,
      max: 8,
      range: "bounded",
      step: 1,
      group: "Noise",
      description: "Extra octaves layered on the base frequency.",
    },
    spread: {
      type: "number",
      label: "Harmonic Spread",
      default: 2,
      min: 1,
      max: 8,
      range: "floor",
      group: "Noise",
      description: "Frequency multiplier per harmonic (lacunarity).",
    },
    gain: {
      type: "number",
      label: "Harmonic Gain",
      default: 0.5,
      min: 0,
      max: 1,
      range: "bounded",
      group: "Noise",
      description: "Amplitude multiplier per harmonic (persistence).",
    },
    rough: {
      type: "number",
      label: "Roughness",
      default: 0.5,
      min: 0,
      max: 2,
      range: "floor",
      group: "Noise",
      description: "Spectral slope on top of the gain: 0 is pure gain decay, 1 adds a further 1/f falloff.",
    },
    exp: {
      type: "number",
      label: "Exponent",
      default: 1,
      min: 0.01,
      max: 8,
      range: "floor",
      group: "Output",
      description: "Contrast shaping: value = sign(n) * |n| ^ exp.",
    },
    amp: {
      type: "number",
      label: "Amplitude",
      default: 1,
      min: -4,
      max: 4,
      range: "soft",
      group: "Output",
    },
    offset: {
      type: "number",
      label: "Offset",
      default: 0,
      min: -2,
      max: 2,
      range: "soft",
      group: "Output",
    },
    mono: {
      type: "boolean",
      label: "Monochrome",
      default: true,
      group: "Output",
      description: "Off gives three decorrelated fields, one per channel.",
    },
    aspectcorrect: {
      type: "boolean",
      label: "Aspect Correct",
      default: true,
      group: "Output",
      description: "Keeps features square on a non-square output.",
    },
    t: {
      type: "vector",
      size: 3,
      label: "Translate",
      default: [0, 0, 0],
      group: "Transform",
      description: "z drives the third dimension of the 3D and 4D types.",
    },
    r: {
      type: "number",
      label: "Rotate",
      default: 0,
      min: -360,
      max: 360,
      range: "cyclic",
      unit: "degrees",
      group: "Transform",
      description: "Rotation of the field in the uv plane — the only axis a 2D slice has.",
    },
    s: {
      type: "vector",
      size: 3,
      label: "Scale",
      default: [1, 1, 1],
      group: "Transform",
    },
    p: {
      type: "vector",
      size: 3,
      label: "Pivot",
      default: [0, 0, 0],
      group: "Transform",
    },
    xord: {
      type: "enum",
      label: "Transform Order",
      default: "srt",
      options: [...TRANSFORM_ORDER_OPTIONS],
      group: "Transform",
    },
    t4d: {
      type: "number",
      label: "Translate 4D",
      default: 0,
      group: "Transform",
      description: "Position along the fourth dimension. Only the 4D types read it.",
      inactiveWhen: fourthDimensionMissing,
    },
    s4d: {
      type: "number",
      label: "Scale 4D",
      default: 1,
      group: "Transform",
      inactiveWhen: fourthDimensionMissing,
    },
    speed: {
      type: "number",
      label: "Time Speed",
      default: 0,
      min: -10,
      max: 10,
      range: "soft",
      unit: "hz",
      group: "Transform",
      description:
        "Not a TD parameter. Advances Translate 4D from FrameEvaluationInput until parameter expressions can bind time themselves (§V61).",
      inactiveWhen: fourthDimensionMissing,
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

    const aspectCorrect = readFlag(parameters, "aspectcorrect", true) === 1;
    // Compile-time, not per-frame (§V21): the size is already resolved by the time
    // compile() runs, and a resize re-runs the compiler.
    const aspect = aspectCorrect ? resolution[0] / resolution[1] : 1;

    const pass: EffectPassDescriptor = {
      kind: "effect",
      id: `${nodeId}:noise`,
      shader: NOISE_FRAGMENT_WGSL,
      target,
      uniformBinding: "params",
      sharedBinding: "frameU",
      uniforms: {
        seed: hashSeed(readNumber(parameters, "seed", 1)),
        ntype: readEnumIndex(parameters, "type", NOISE_TYPE_OPTIONS, "perlin2d"),
        period: readNumber(parameters, "period", 0.25),
        harmon: readNumber(parameters, "harmon", 3),
        spread: readNumber(parameters, "spread", 2),
        gain: readNumber(parameters, "gain", 0.5),
        rough: readNumber(parameters, "rough", 0.5),
        expo: readNumber(parameters, "exp", 1),
        amp: readNumber(parameters, "amp", 1),
        offset: readNumber(parameters, "offset", 0),
        mono: readFlag(parameters, "mono", true),
        aspect,
        rot: readNumber(parameters, "r", 0) * DEGREES_TO_RADIANS,
        xord: readEnumIndex(parameters, "xord", TRANSFORM_ORDER_OPTIONS, "srt"),
        speed: readNumber(parameters, "speed", 0),
        t4d: readNumber(parameters, "t4d", 0),
        s4d: readNumber(parameters, "s4d", 1),
        t: readVector(parameters, "t", [0, 0, 0]),
        s: readVector(parameters, "s", [1, 1, 1]),
        piv: readVector(parameters, "p", [0, 0, 0]),
      },
      nodeId,
      label: "Noise",
    };
    return { passes: [pass] };
  },
};
