import type { NodeDefinition, CompiledNodeDescription } from "../../domain/types/node-definition.ts";
import type { EffectPassDescriptor } from "../../runtime/backend/plan.ts";
import { RGBA_TEXTURE } from "./common-ports.ts";
import { missingCompileResource, readCompileInputs } from "./compile-context.ts";
import { SOLID_FRAGMENT_WGSL } from "../shaders/solid.wgsl.ts";

/** Default colour: opaque black — a generator that produces nothing until dialed in. */
const DEFAULT_COLOR: readonly [number, number, number, number] = [0, 0, 0, 1];

/**
 * Solid — a colour generator (T15; TD "Constant"/"Solid TOP" family, §C node catalog
 * guideline). No inputs, one texture output, filled every frame with a single colour.
 *
 * `color` is declared `space: "display"`: the value comes straight out of a UI colour
 * picker, which shows perceptual/sRGB values, not the linear values the compositing
 * pipeline computes in. `space: "display"` tells whatever decodes the parameter (not
 * this file — that decode is a runtime/compiler concern, and §V13 forbids an implicit
 * conversion happening invisibly inside a port) that this number needs an sRGB→linear
 * decode before it lands in a texture. Marking it `"linear"` instead would claim the
 * artist is typing linear light values directly, which is not how a colour swatch works.
 *
 * `resolutionPolicy: { kind: "project" }` because a generator with no input has nowhere
 * else to inherit a size from; same reasoning gives it `formatPolicy: { kind: "project" }`.
 */
export const solidNode: NodeDefinition = {
  type: "solid",
  version: 1,
  title: "Solid",
  category: "generator",
  description: "Fills its output with a single, uniform colour.",
  inputs: [],
  outputs: [{ id: "out", label: "Out", type: RGBA_TEXTURE }],
  parameters: {
    color: {
      type: "color",
      label: "Color",
      default: DEFAULT_COLOR,
      space: "display",
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

    const colorValue = parameters["color"];
    const color = Array.isArray(colorValue) ? colorValue : DEFAULT_COLOR;

    const pass: EffectPassDescriptor = {
      kind: "effect",
      id: `${nodeId}:fill`,
      shader: SOLID_FRAGMENT_WGSL,
      target,
      uniformBinding: "params",
      uniforms: { color },
      nodeId,
      label: "Solid",
    };
    return { passes: [pass] };
  },
};
