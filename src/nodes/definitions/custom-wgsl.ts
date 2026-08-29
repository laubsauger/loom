import type { NodeDefinition, CompiledNodeDescription } from "../../domain/types/node-definition.ts";
import type { EffectPassDescriptor } from "../../runtime/backend/plan.ts";
import { SHADER_SOURCE_PARAMETER } from "../../domain/commands/apply-patch.ts";
import { RGBA_TEXTURE } from "./common-ports.ts";
import { missingCompileResource, readCompileInputs } from "./compile-context.ts";
import { CUSTOM_WGSL_DEFAULT_SOURCE } from "../shaders/custom-wgsl-default.wgsl.ts";

/**
 * CustomWGSL — the user-authored fragment effect (T15; §I custom WGSL node contract v1).
 *
 * One texture input, one texture output, resolution and format inherited from that input
 * — a filter has nowhere else sensible to get either from. Its shader text lives under
 * the conventional `source` string parameter: `SHADER_SOURCE_PARAMETER`, exported by
 * track B from `src/domain/commands/apply-patch.ts`, is the single source of truth for
 * that key name, so this manifest and the bus's `setShaderSource` patch op can never
 * drift apart. `source` is `compileTime: true` — editing it changes the shader
 * structurally and must force a rebuild, never a uniform-only update (§V5).
 *
 * `compile()` treats the current source as opaque, arbitrary WGSL: it only wires the
 * conventional `inputTexture`/`inputSampler` bindings the v1 contract names, and does not
 * invent a per-node uniform block for the contract's own `Params { time, amount }` — the
 * default shader's function body does not read `params` at all, so nothing needs to
 * supply it yet. Feeding real values into a user-declared uniform block (once one is
 * introspected from source) is compiler work, not this node's.
 */
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
      type: "string",
      label: "Source",
      default: CUSTOM_WGSL_DEFAULT_SOURCE,
      multiline: true,
      compileTime: true,
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
      textures: [{ binding: "inputTexture", resourceId: source.resource }],
      samplers: [{ binding: "inputSampler", resourceId: source.sampler }],
      nodeId,
      label: "Custom WGSL",
    };
    return { passes: [pass] };
  },
};
