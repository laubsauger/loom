import type { NodeDefinition, CompiledNodeDescription } from "../../domain/types/node-definition.ts";
import type { EffectPassDescriptor } from "../../runtime/backend/plan.ts";
import { SHADER_SOURCE_PARAMETER } from "../../domain/commands/apply-patch.ts";
import { RGBA_TEXTURE } from "./common-ports.ts";
import { missingCompileResource, readCompileInputs } from "./compile-context.ts";
import { readNumber, readColor } from "./parameter-readers.ts";
import type { ParameterValue } from "../../domain/types/parameters.ts";
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

/**
 * The field names a `struct Params { … }` declares (T880, B). Same deterministic scan as
 * `declaresUniformBlock` — not a WGSL parser — so a shader gets EXACTLY the slots it names
 * and no more: a kernel binding only `amount` (E43/E45, whose §V147 identity depends on it)
 * is handed only `amount`, never a colour it never declared. The fixed slot vocabulary below
 * is TouchDesigner's model — generic slots the shader opts into by name, the meaningful names
 * living on a component's published parameters.
 */
export function paramsStructFields(source: string): ReadonlySet<string> {
  const match = /struct\s+Params\s*\{([^}]*)\}/.exec(stripComments(source));
  if (match === null) return new Set();
  const fields = new Set<string>();
  for (const line of (match[1] ?? "").split(/[,;\n]/)) {
    const field = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:/.exec(line);
    if (field !== null && field[1] !== undefined) fields.add(field[1]);
  }
  return fields;
}

/** A slot dims in the inspector unless the shader's own `Params` struct declares it. */
function unlessDeclared(field: string): (values: Readonly<Record<string, ParameterValue>>) => string | null {
  return (values) => {
    const source = values[SHADER_SOURCE_PARAMETER];
    const text = typeof source === "string" ? source : "";
    return paramsStructFields(text).has(field)
      ? null
      : `Add \`${field}\` to your \`struct Params\` to use this slot.`;
  };
}

/** The colour slots a shader may opt into — vec4f in the struct, an RGBA picker on the node. */
const COLOR_SLOTS = ["color1", "color2", "color3"] as const;
/** The scalar slots — f32 in the struct, a number on the node. Generic on purpose (TD's model). */
const SCALAR_SLOTS = ["scalar1", "scalar2", "scalar3", "scalar4"] as const;

export const customWgslNode: NodeDefinition = {
  type: "customWgsl",
  version: 1,
  title: "Custom WGSL",
  category: "shader",
  description: "A user-authored WGSL fragment effect (v1 contract, §I).",
  inputs: [{ id: "input", label: "Input", type: RGBA_TEXTURE }],
  outputs: [{ id: "out", label: "Out", type: RGBA_TEXTURE }],
  parameters: {
    [SHADER_SOURCE_PARAMETER]: {
      type: "code",
      language: "wgsl",
      label: "Source",
      default: CUSTOM_WGSL_DEFAULT_SOURCE,
      compileTime: true,
    },
    /**
     * The one generic scalar the contract's `Params` block carries. It has no meaning of
     * its own — the kernel decides what it scales — which is why it is `amount` and not
     * something that implies a unit. NOT `compileTime`: changing it is a uniform write,
     * not a rebuild (§V5), which is the whole reason a kernel wants a uniform at all.
     */
    amount: {
      type: "number",
      label: "Amount",
      default: 1,
      min: 0,
      max: 1,
      range: "bounded",
      description: "Reaches the kernel as `params.amount`. Whatever your shader makes of it.",
    },
    /**
     * The uniform SLOTS (T880): a fixed vocabulary a shader opts into by naming the field in
     * its own `struct Params`. Each is a normal parameter — drivable by a value node, bindable,
     * and publishable on a component's page, which is where the meaningful name ("Light Color",
     * "Orbit Speed") lives. A slot the shader does not declare is dimmed and never bound, so a
     * kernel that wants only `amount` is unchanged (§V147). TouchDesigner's Vectors pages, ours.
     */
    color1: { type: "color", label: "Color 1", default: [1, 1, 1, 1], space: "display", description: "Reaches the kernel as `params.color1` (vec4f), if declared.", inactiveWhen: unlessDeclared("color1") },
    color2: { type: "color", label: "Color 2", default: [1, 1, 1, 1], space: "display", description: "Reaches the kernel as `params.color2` (vec4f), if declared.", inactiveWhen: unlessDeclared("color2") },
    color3: { type: "color", label: "Color 3", default: [1, 1, 1, 1], space: "display", description: "Reaches the kernel as `params.color3` (vec4f), if declared.", inactiveWhen: unlessDeclared("color3") },
    scalar1: { type: "number", label: "Scalar 1", default: 0, description: "Reaches the kernel as `params.scalar1` (f32), if declared.", inactiveWhen: unlessDeclared("scalar1") },
    scalar2: { type: "number", label: "Scalar 2", default: 0, description: "Reaches the kernel as `params.scalar2` (f32), if declared.", inactiveWhen: unlessDeclared("scalar2") },
    scalar3: { type: "number", label: "Scalar 3", default: 0, description: "Reaches the kernel as `params.scalar3` (f32), if declared.", inactiveWhen: unlessDeclared("scalar3") },
    scalar4: { type: "number", label: "Scalar 4", default: 0, description: "Reaches the kernel as `params.scalar4` (f32), if declared.", inactiveWhen: unlessDeclared("scalar4") },
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

    // Bind ONLY the slots the shader's own `struct Params` declares (T880): vgpu refuses a
    // value with no matching field, and E43/E45's §V147 identity depends on `amount` being
    // the only thing bound to their kernels — so the set is read from the source, not assumed.
    const uniforms: Record<string, number | readonly number[]> = {};
    if (declaresUniformBlock(shader, CUSTOM_WGSL_UNIFORM_BINDING)) {
      const fields = paramsStructFields(shader);
      if (fields.has("amount")) uniforms["amount"] = readNumber(parameters, "amount", 1);
      for (const slot of COLOR_SLOTS) {
        if (fields.has(slot)) uniforms[slot] = readColor(parameters, slot, [1, 1, 1, 1]);
      }
      for (const slot of SCALAR_SLOTS) {
        if (fields.has(slot)) uniforms[slot] = readNumber(parameters, slot, 0);
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
