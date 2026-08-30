import type { NodeDefinition, CompiledNodeDescription } from "../../domain/types/node-definition.ts";
import type { EffectPassDescriptor } from "../../runtime/backend/plan.ts";
import { MAX_TEXTURE_INPUTS, RGBA_TEXTURE } from "./common-ports.ts";
import { missingCompileResource, readCompileInputs } from "./compile-context.ts";
import { readNumber } from "./parameter-readers.ts";
import { switchFragmentWgsl } from "../shaders/switch.wgsl.ts";

/**
 * Which input the index selects, resolved on the CPU (T235).
 *
 * FLOOR, then wrap into range. Floor rather than round because the index is normally
 * DRIVEN by something that ramps — an LFO, a timer, a frame count — and flooring gives each
 * input an equal share of the ramp, where rounding gives the first and last a half share.
 *
 * WRAP rather than clamp, which is the one real argument in this node. Everything that
 * generates a rising number runs past the end, and clamping turns "cycle through my
 * sources" — the reason people reach for a Switch — into "stop on the last one", fixable
 * only by typing a modulo into every expression. Wrapping is also recoverable in the other
 * direction: someone who wants clamping clamps upstream, where the value graph's Limit
 * already lives. Negative indices wrap too, so -1 is the last input.
 *
 * Resolved HERE rather than in WGSL because a scalar crossing to the GPU is free (§V183)
 * while a second definition of "what does index 9 of 3 mean" is not: on the CPU it is
 * testable without a device, and the shader stays a switch with nothing to get wrong.
 */
export function resolveSwitchIndex(raw: number, count: number): number {
  if (count <= 0) return 0;
  const floored = Math.floor(Number.isFinite(raw) ? raw : 0);
  return ((floored % count) + count) % count;
}

/**
 * Switch — show one of N inputs (T235). TD's Switch TOP.
 *
 * The first node built on the variadic mechanism from scratch, so unlike Composite it has
 * ONE port and no compatibility to carry: every input is a peer, and their order — which
 * the user sets (§V131, T225) — is what the index counts through.
 *
 * THE INDEX IS A UNIFORM, deliberately the opposite choice from Composite's `operation`
 * (§V141). An operation changes approximately never, so specialising the shader per
 * operation is the right trade. An index is the thing you ANIMATE; recompiling on every
 * change would make the node's entire purpose its slowest path. Changing it is a uniform
 * write on the §V5 fast path, and a driven index costs nothing per frame.
 *
 * RESOLUTION AND FORMAT COME FROM THE FIRST INPUT, not the selected one. They are resolved
 * at compile time (§V21) and the index moves per frame, so "the selected input's size" is
 * not a size the plan can have. Switching between differently-shaped sources therefore
 * resamples them into the first one's shape — and since T225 made the order explicit,
 * WHICH input that is, is something the user chooses rather than an accident of wiring.
 */
export const switchNode: NodeDefinition = {
  type: "switch",
  version: 1,
  title: "Switch",
  category: "utility",
  description:
    "Shows one of its inputs, chosen by index. Drive the index to cut between sources. TD Switch TOP.",
  inputs: [
    {
      id: "inputs",
      label: "Inputs",
      type: RGBA_TEXTURE,
      variadic: true,
      description: "Counted in the order you arrange them. The first one sets the output's shape.",
    },
  ],
  outputs: [{ id: "out", label: "Out", type: RGBA_TEXTURE }],
  parameters: {
    index: {
      type: "number",
      label: "Index",
      default: 0,
      // NO min or max, on purpose. Out-of-range is the normal case here — a driven index
      // ramps past the end — and the node's answer is to wrap it. A declared range would
      // REJECT a static 9 (§V66 validates against it) while an expression producing 9
      // wrapped happily: two answers to one question, and the static one would be the
      // surprising half. §V107 says a mode users cannot trust everywhere is worse than no
      // mode; the same holds for a value.
      description: "Which input to show, 0-based. Out of range wraps, so -1 is the last.",
    },
  },
  resolutionPolicy: { kind: "inherit", input: "inputs" },
  formatPolicy: { kind: "inherit", input: "inputs" },
  compile(context): CompiledNodeDescription {
    const { nodeId, outputs, inputEdges, parameters } = readCompileInputs(context);
    const target = outputs["out"];
    const sources = inputEdges["inputs"] ?? [];
    const first = sources[0];
    if (target === undefined || first === undefined) {
      const what = target === undefined ? 'output port "out"' : 'input port "inputs"';
      return { passes: [], diagnostics: [missingCompileResource(nodeId, what)] };
    }
    if (sources.length > MAX_TEXTURE_INPUTS) {
      return {
        passes: [],
        diagnostics: [
          {
            severity: "error",
            code: "node.compile.tooManyInputs",
            message: `Node "${nodeId}" has ${sources.length} inputs; ${MAX_TEXTURE_INPUTS} is the most one Switch binds.`,
            nodeId,
            suggestion: "Feed the extra sources through a second Switch and select between the two.",
          },
        ],
      };
    }

    const pass: EffectPassDescriptor = {
      kind: "effect",
      // The input COUNT is part of the id: the shader has one branch per input, so a
      // fourth source is a different program, never a carry-over of the old one (§V62b).
      id: `${nodeId}:switch:${sources.length}`,
      shader: switchFragmentWgsl(sources.length),
      target,
      textures: sources.map((source, index) => ({
        binding: `inputTexture${index}`,
        resourceId: source.resource,
      })),
      samplers: [{ binding: "inputSampler", resourceId: first.sampler }],
      uniformBinding: "params",
      uniforms: {
        index: resolveSwitchIndex(readNumber(parameters, "index", 0), sources.length),
      },
      nodeId,
      label: "Switch",
    };
    return { passes: [pass] };
  },
};
