import type { CompiledNodeDescription, NodeDefinition } from "../../domain/types/node-definition.ts";
import type { EffectPassDescriptor } from "../../runtime/backend/plan.ts";
import { FEEDBACK_FRAGMENT_WGSL } from "../shaders/feedback.wgsl.ts";
import { RGBA_TEXTURE } from "./common-ports.ts";
import { missingCompileResource, readCompileInputs } from "./compile-context.ts";
import { readColor, readNumber } from "./parameter-readers.ts";

/**
 * Feedback — the explicit temporal boundary (T152, §V4, §V22). TD Feedback TOP.
 *
 * The ONLY node in the catalogue that legalises a cycle: its output carries the
 * PREVIOUS frame, so a loop like
 *
 *   Composite → Feedback → Transform → (back into) Composite
 *
 * is a legal graph — the compiler splits the temporal edge (T25), backs the output with
 * a stable ping-pong pair (T33) and swaps it after every current-frame consumer has been
 * encoded (§V22). Each frame this node writes its input into the pair's write half;
 * everyone downstream reads the half written LAST frame.
 *
 * Semantically it is a one-frame delay with an optional fade: `persistence` mixes the
 * stored image toward `clearColor` inside the loop, so trails decay without an extra
 * Level node. Resetting (the transport's reset-feedback command, a resolution or format
 * change, a shader-interface change, device loss, project load) clears the pair — the
 * `resetOn` list here is what the compiler folds into the pair's reset signature.
 *
 * History SURVIVES unrelated structural edits: the backend carries an unchanged pair's
 * textures across a recompile (§V22 via T143), which is what makes live patching around
 * a running feedback network possible at all.
 */
export const feedbackNode: NodeDefinition = {
  type: "feedback",
  version: 1,
  title: "Feedback",
  category: "temporal",
  description:
    "Outputs the previous frame of its input, making feedback loops legal. TD Feedback TOP.",
  tags: ["temporal", "delay", "trails", "loop"],
  inputs: [
    {
      id: "in",
      label: "In",
      type: RGBA_TEXTURE,
      description: "Written into the pair this frame; comes back out one frame later.",
    },
  ],
  outputs: [
    {
      id: "out",
      label: "Out",
      type: RGBA_TEXTURE,
      description: "The PREVIOUS frame's input. Safe to wire back upstream.",
    },
  ],
  parameters: {
    persistence: {
      type: "number",
      label: "Persistence",
      default: 1,
      min: 0,
      max: 1,
      description: "1 stores the input untouched; lower values fade toward Clear Color each frame.",
    },
    clearColor: {
      type: "color",
      label: "Clear Color",
      default: [0, 0, 0, 0],
      space: "display",
      description: "What the image fades toward, and what a reset clears the history to.",
    },
  },
  resolutionPolicy: { kind: "inherit", input: "in" },
  formatPolicy: { kind: "inherit", input: "in" },
  temporal: {
    outputs: ["out"],
    resetOn: ["resolution", "format", "shader-interface", "device", "load"],
  },
  // §V46: replay from frame zero with the same inputs reproduces the same history;
  // there is no checkpointing yet, so seeking requires a reset and a re-run.
  stateful: { reset: true, deterministicReplay: true, checkpoint: false, randomAccess: false },
  compile(context): CompiledNodeDescription {
    const { nodeId, outputs, inputs, parameters } = readCompileInputs(context);
    const target = outputs["out"];
    const source = inputs["in"];
    if (target === undefined || source === undefined) {
      const what = target === undefined ? 'output port "out"' : 'input port "in"';
      return { passes: [], diagnostics: [missingCompileResource(nodeId, what)] };
    }
    const pass: EffectPassDescriptor = {
      kind: "effect",
      id: `${nodeId}:feedback`,
      shader: FEEDBACK_FRAGMENT_WGSL,
      target,
      textures: [{ binding: "sourceTexture", resourceId: source.resource }],
      samplers: [{ binding: "inputSampler", resourceId: source.sampler }],
      uniformBinding: "params",
      uniforms: {
        clearColor: readColor(parameters, "clearColor", [0, 0, 0, 0]),
        persistence: readNumber(parameters, "persistence", 1),
      },
      nodeId,
      label: "Feedback",
    };
    return { passes: [pass] };
  },
};

/** The temporal group, in library order. */
export const temporalNodes: readonly NodeDefinition[] = [feedbackNode];
