import type { NodeDefinition, CompiledNodeDescription } from "../../domain/types/node-definition.ts";
import type { EffectPassDescriptor } from "../../runtime/backend/plan.ts";
import { SHADER_SOURCE_PARAMETER } from "../../domain/commands/apply-patch.ts";
import { RGBA_TEXTURE } from "./common-ports.ts";
import { missingCompileResource, readCompileInputs } from "./compile-context.ts";
import { readNumber } from "./parameter-readers.ts";
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
      description: "Reaches the kernel as `params.amount`. Whatever your shader makes of it.",
    },
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

    const pass: EffectPassDescriptor = {
      kind: "effect",
      id: `${nodeId}:custom`,
      shader,
      target,
      textures: [{ binding: CUSTOM_WGSL_TEXTURE_BINDING, resourceId: source.resource }],
      samplers: [{ binding: CUSTOM_WGSL_SAMPLER_BINDING, resourceId: source.sampler }],
      ...(declaresUniformBlock(shader, CUSTOM_WGSL_UNIFORM_BINDING)
        ? {
            uniformBinding: CUSTOM_WGSL_UNIFORM_BINDING,
            uniforms: { amount: readNumber(parameters, "amount", 1) },
          }
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
