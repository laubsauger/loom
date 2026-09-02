import type { NodeDefinition, CompiledNodeDescription } from "../../domain/types/node-definition.ts";
import type { EffectPassDescriptor } from "../../runtime/backend/plan.ts";
import { SHADER_SOURCE_PARAMETER } from "../../domain/commands/apply-patch.ts";
import { RGBA_TEXTURE } from "./common-ports.ts";
import { missingCompileResource, readCompileInputs } from "./compile-context.ts";
import {
  declaresUniformBlock,
  paramForField,
  reflectParamsStruct,
  reflectedUniforms,
} from "./params-reflection.ts";
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

/**
 * T900: `declaresUniformBlock` and `reflectParamsStruct` MOVED to `params-reflection.ts` when
 * the point kernels came onto this same reflection (§T900's "reuse, do not fork"). They are
 * re-exported here because this node's own tests read them off the node they document, and
 * because there must be exactly ONE reflector: a second copy would be two answers to "what
 * does `lightColor: vec4f` mean?" (§V349).
 */
export { declaresUniformBlock, reflectParamsStruct } from "./params-reflection.ts";

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
    const uniforms: Record<string, number | readonly number[]> = declaresUniformBlock(
      shader,
      CUSTOM_WGSL_UNIFORM_BINDING,
    )
      ? reflectedUniforms(reflectParamsStruct(shader), parameters)
      : {};

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
