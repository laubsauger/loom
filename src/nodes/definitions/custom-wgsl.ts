import type { NodeDefinition, CompiledNodeDescription } from "../../domain/types/node-definition.ts";
import type { EffectPassDescriptor } from "../../runtime/backend/plan.ts";
import { SHADER_SOURCE_PARAMETER } from "../../domain/commands/apply-patch.ts";
import { RGBA_TEXTURE } from "./common-ports.ts";
import { missingCompileResource, readCompileInputs } from "./compile-context.ts";
import { readNumber, readColor, readVector } from "./parameter-readers.ts";
import type { ParameterDefinition, ParameterSchema } from "../../domain/types/parameters.ts";
import {
  CUSTOM_WGSL_DEFAULT_SOURCE,
  CUSTOM_WGSL_SAMPLER_BINDING,
  CUSTOM_WGSL_SHARED_BINDING,
  CUSTOM_WGSL_TEXTURE_BINDING,
  CUSTOM_WGSL_UNIFORM_BINDING,
} from "../shaders/custom-wgsl-default.wgsl.ts";

/**
 * CustomWGSL — the user-authored fragment effect (T15, T166; §I custom WGSL node contract).
 *
 * One texture input, one texture output, resolution and format inherited from that input
 * — a filter has nowhere else sensible to get either from. Its shader text lives under
 * the conventional `source` string parameter: `SHADER_SOURCE_PARAMETER`, exported by
 * track B from `src/domain/commands/apply-patch.ts`, is the single source of truth for
 * that key name, so this manifest and the bus's `setShaderSource` patch op can never
 * drift apart. `source` is `compileTime: true` — editing it changes the shader
 * structurally and must force a rebuild, never a uniform-only update (§V5).
 *
 * WHAT A KERNEL RECEIVES (B7/T166). Four bindings, all matched by NAME:
 *
 *   `inputSampler` / `inputTexture` — the connected input.
 *   `frameU: SharedFrame`           — time, deltaTime, frameIndex, randomSeed,
 *                                     resolution, pointer, straight from
 *                                     `FrameEvaluationInput` (§V44). The ONLY clock a
 *                                     kernel can reach.
 *   `params: Params`                — this node's own parameters. `amount` today.
 *
 * Previously this node emitted neither `uniformBinding` nor `sharedBinding`, so the last
 * two arrived as nothing at all while the shipped default source cheerfully declared a
 * `Params` block for them. Both are wired now.
 *
 * DECLARED, THEN BOUND — never bound blindly. The runtime binds by name and refuses a
 * value with no matching declaration in the shader, so a kernel that does not declare
 * `params` (E2's Gray-Scott kernel is exactly that: all its constants are compile-time
 * `const`s) must not be handed one. `declaresUniformBlock` reads the source for the
 * declaration and the pass carries only what the source asked for. That check is a
 * deterministic scan of the text, not a WGSL parser: a full parse belongs with real
 * introspection — feeding a user-DECLARED struct's own fields — which is compiler work.
 */

/** Comments are stripped before scanning so a mention of `params` in prose is not a declaration. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
}

/**
 * True when the source really declares `var<uniform> <name>`. Exported for the node's own
 * tests: the claim "the default source declares nothing that is not bound" is only worth
 * making if it is checked with the same reader the compile path uses.
 */
export function declaresUniformBlock(source: string, name: string): boolean {
  return new RegExp(`var\\s*<\\s*uniform\\s*>\\s*${name}\\s*:`).test(stripComments(source));
}

/** One field of a shader's `struct Params`: its name and its WGSL type. */
interface ReflectedField {
  readonly name: string;
  readonly wgsl: string;
}

/**
 * The fields a `struct Params { … }` declares (T880, code-first reflection). A deterministic
 * scan, not a WGSL parser — enough to turn a shader's own uniform struct into node controls,
 * so a customWgsl's parameters ARE its shader's parameters (the owner's ask; §V805). A kernel
 * with no `Params` block, or one listing only `amount` (E43/E45, whose §V147 identity depends
 * on it), reflects to exactly that and no more. Exported for the node's own tests.
 */
export function reflectParamsStruct(source: string): readonly ReflectedField[] {
  const match = /struct\s+Params\s*\{([^}]*)\}/.exec(stripComments(source));
  if (match === null) return [];
  const fields: ReflectedField[] = [];
  for (const line of (match[1] ?? "").split(/[,;\n]/)) {
    const field = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:\s*([A-Za-z0-9_]+)/.exec(line);
    if (field?.[1] !== undefined && field[2] !== undefined) fields.push({ name: field[1], wgsl: field[2] });
  }
  return fields;
}

/** A field whose NAME reads as colour intent gets an RGBA picker; every other vector stays one. */
function looksLikeColour(name: string): boolean {
  return /colou?r|tint|rgb|albedo|emissi/i.test(name);
}

/** A readable label from a camelCase / snake_case field name. */
function labelOf(name: string): string {
  const spaced = name.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/**
 * The node control a struct field maps to (T880). f32 → a number; vec2/3/4 → a vector, or an
 * RGBA picker when the NAME reads as a colour (the vec3f/vec4f fork the orchestrator flagged —
 * resolved by the author's own naming, never a guess from the bare type). Matrices, arrays and
 * textures are not v1 controls and reflect to nothing.
 */
function paramForField(field: ReflectedField): ParameterDefinition | undefined {
  const label = labelOf(field.name);
  const description = `Reaches the kernel as \`params.${field.name}\` (${field.wgsl}).`;
  // `amount` keeps its historical 0..1 slider so E43/E45 read exactly as they always have.
  if (field.name === "amount" && field.wgsl === "f32") {
    return { type: "number", label: "Amount", default: 1, min: 0, max: 1, range: "bounded", description: "Reaches the kernel as `params.amount`. Whatever your shader makes of it." };
  }
  switch (field.wgsl) {
    case "f32":
      return { type: "number", label, default: 0, description };
    case "i32":
    case "u32":
      return { type: "number", label, default: 0, step: 1, description };
    case "vec2f":
      return { type: "vector", size: 2, label, default: [0, 0], description };
    case "vec3f":
      return looksLikeColour(field.name)
        ? { type: "color", label, default: [1, 1, 1, 1], space: "display", description }
        : { type: "vector", size: 3, label, default: [0, 0, 0], description };
    case "vec4f":
      return looksLikeColour(field.name)
        ? { type: "color", label, default: [1, 1, 1, 1], space: "display", description }
        : { type: "vector", size: 4, label, default: [0, 0, 0, 0], description };
    default:
      return undefined;
  }
}

/** The always-present source editor — shared by the static fallback schema and the reflected one. */
const SOURCE_PARAM: ParameterDefinition = {
  type: "code",
  language: "wgsl",
  label: "Source",
  default: CUSTOM_WGSL_DEFAULT_SOURCE,
  compileTime: true,
};

/** The schema a customWgsl node carries, reflected from its own `source` (T880). */
function reflectedSchema(source: string): ParameterSchema {
  const schema: ParameterSchema = { [SHADER_SOURCE_PARAMETER]: SOURCE_PARAM };
  if (declaresUniformBlock(source, CUSTOM_WGSL_UNIFORM_BINDING)) {
    for (const field of reflectParamsStruct(source)) {
      const param = paramForField(field);
      if (param !== undefined) schema[field.name] = param;
    }
  }
  return schema;
}

export const customWgslNode: NodeDefinition = {
  type: "customWgsl",
  version: 1,
  title: "Custom WGSL",
  category: "shader",
  description: "A user-authored WGSL fragment effect (v1 contract, §I).",
  inputs: [{ id: "input", label: "Input", type: RGBA_TEXTURE }],
  outputs: [{ id: "out", label: "Out", type: RGBA_TEXTURE }],
  /**
   * The STATIC fallback (T880): what a fresh drop and the type-only contexts (palette, help)
   * see — the source editor and the historical `amount`. A placed node's real controls come
   * from `parametersFor` below, reflected from its own shader.
   */
  parameters: {
    [SHADER_SOURCE_PARAMETER]: SOURCE_PARAM,
    amount: {
      type: "number",
      label: "Amount",
      default: 1,
      min: 0,
      max: 1,
      range: "bounded",
      description: "Reaches the kernel as `params.amount`. Whatever your shader makes of it.",
    },
  },
  /**
   * PER-INSTANCE reflection (T880, §V805): the node's controls ARE its shader's `struct
   * Params`. Declare `orbitSpeed: f32` or `lightColor: vec4f` and the knob appears — named,
   * typed, drivable and publishable — so a shader stops being a one-scalar black box. The
   * static schema above stays the fallback where there is no stored source to read.
   */
  parametersFor(stored) {
    const raw = stored[SHADER_SOURCE_PARAMETER];
    return reflectedSchema(typeof raw === "string" ? raw : CUSTOM_WGSL_DEFAULT_SOURCE);
  },
  resolutionPolicy: { kind: "inherit", input: "input" },
  formatPolicy: { kind: "inherit", input: "input" },
  compile(context): CompiledNodeDescription {
    const { nodeId, outputs, inputs, parameters } = readCompileInputs(context);
    const target = outputs["out"];
    const source = inputs["input"];
    if (target === undefined || source === undefined) {
      const what = target === undefined ? 'output port "out"' : 'input port "input"';
      return { passes: [], diagnostics: [missingCompileResource(nodeId, what)] };
    }

    const sourceValue = parameters[SHADER_SOURCE_PARAMETER];
    const shader = typeof sourceValue === "string" ? sourceValue : CUSTOM_WGSL_DEFAULT_SOURCE;

    // Bind EXACTLY the fields the shader's own `struct Params` declares (T880), each shaped to
    // its WGSL type. vgpu refuses a value with no matching field, and E43/E45's §V147 identity
    // depends on `amount` being the only thing bound to their kernels — so the set is read from
    // the source, never assumed. The values come from `parameters`, resolved against the SAME
    // reflected schema (the compiler resolves through `parametersFor`), so a driven or bound
    // control lands here.
    const uniforms: Record<string, number | readonly number[]> = {};
    if (declaresUniformBlock(shader, CUSTOM_WGSL_UNIFORM_BINDING)) {
      for (const field of reflectParamsStruct(shader)) {
        const param = paramForField(field);
        if (param === undefined) continue;
        if (param.type === "number") {
          uniforms[field.name] = readNumber(parameters, field.name, typeof param.default === "number" ? param.default : 0);
        } else if (param.type === "color") {
          const rgba = readColor(parameters, field.name, [1, 1, 1, 1]);
          // vec3f colour takes rgb; vec4f takes rgba — matched to the declared type.
          uniforms[field.name] = field.wgsl === "vec3f" ? [rgba[0] ?? 0, rgba[1] ?? 0, rgba[2] ?? 0] : rgba;
        } else if (param.type === "vector") {
          const size = field.wgsl === "vec2f" ? 2 : field.wgsl === "vec3f" ? 3 : 4;
          uniforms[field.name] = readVector(parameters, field.name, new Array<number>(size).fill(0));
        }
      }
    }

    const pass: EffectPassDescriptor = {
      kind: "effect",
      id: `${nodeId}:custom`,
      shader,
      target,
      textures: [{ binding: CUSTOM_WGSL_TEXTURE_BINDING, resourceId: source.resource }],
      samplers: [{ binding: CUSTOM_WGSL_SAMPLER_BINDING, resourceId: source.sampler }],
      ...(Object.keys(uniforms).length > 0
        ? { uniformBinding: CUSTOM_WGSL_UNIFORM_BINDING, uniforms }
        : {}),
      ...(declaresUniformBlock(shader, CUSTOM_WGSL_SHARED_BINDING)
        ? { sharedBinding: CUSTOM_WGSL_SHARED_BINDING }
        : {}),
      nodeId,
      label: "Custom WGSL",
    };
    return { passes: [pass] };
  },
};
