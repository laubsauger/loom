import type { CompiledNodeDescription, NodeDefinition } from "../../domain/types/node-definition.ts";
import type { EffectPassDescriptor } from "../../runtime/backend/plan.ts";
import { MAX_SUBSTEPS } from "../../runtime/backend/plan.ts";
import { FEEDBACK_FRAGMENT_WGSL } from "../shaders/feedback.wgsl.ts";
import { RGBA_TEXTURE } from "./common-ports.ts";
import { missingCompileResource, readCompileInputs } from "./compile-context.ts";
import { readColor, readFlag, readNumber } from "./parameter-readers.ts";

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
      description:
        "Fed by the SOURCE reference (T350). Legacy documents may still wire it; the editor only ever writes the reference.",
    },
  ],
  sourceReferences: [{ parameter: "source", input: "in" }],
  outputs: [
    {
      id: "out",
      label: "Out",
      type: RGBA_TEXTURE,
      description: "The PREVIOUS frame's input. Safe to wire back upstream.",
    },
  ],
  parameters: {
    /**
     * T350 (§V285): the loop is a REFERENCE, not a wire. Naming the source keeps
     * `edges` a DAG — the confusing back-edge is gone and the dashed line (T248)
     * shows the relationship instead. The compiler synthesizes the exact edge the
     * wired shape had, so every temporal mechanism downstream is unchanged.
     */
    source: {
      type: "string",
      label: "Source",
      default: "",
      compileTime: true,
      description: "Name of the node this loop records — e.g. over1. The dashed line shows the link.",
    },
    persistence: {
      type: "number",
      label: "Persistence",
      default: 1,
      min: 0,
      max: 1,
      range: "bounded",
      description: "1 stores the input untouched; lower values fade toward Clear Color each frame.",
    },
    clearColor: {
      type: "color",
      label: "Clear Color",
      default: [0, 0, 0, 0],
      space: "display",
      description: "What the image fades toward, and what a reset clears the history to.",
    },
    /**
     * §V123/T216 — the two halves of TD's Feedback TOP reset, and they are not
     * interchangeable. `reset` is a STATE: while it is on the node writes Clear Color
     * every frame, which is how you park a loop while rewiring what feeds it.
     * `resetPulse` is an EVENT: it clears the ping-pong pair once and the loop carries
     * on from empty.
     */
    reset: {
      type: "boolean",
      label: "Reset",
      default: false,
      description: "Holds the loop cleared to Clear Color for as long as it is on.",
    },
    /**
     * T387 — how many times the loop this node closes advances per DISPLAYED frame.
     *
     * 1 is what every feedback loop did before this existed: one iteration per frame, so
     * the simulation runs at the display's rate. A Gray-Scott reaction-diffusion needs
     * roughly 10-50 iterations per visible frame to evolve at a watchable speed, and until
     * this parameter existed there was no number anywhere in the product that could buy
     * them — the shipped E2 was structurally slow, not tuned wrong.
     *
     * COST IS THE POINT. 50 substeps is 50 times the loop's GPU work in the same 16 ms.
     * The per-node timing row sums every iteration's span (T163, §V86), so raising this
     * shows up as the frame time it actually costs rather than as a mysterious stutter.
     *
     * A per-frame VALUE since T425. T387 marked it compileTime with the argument that
     * the count is plan STRUCTURE — "a uniform write cannot express 'encode this
     * region 40 times'" — which was true of the encoder it shipped with: the expanded
     * pass order was precomputed once per plan. T425 changed the premise, not the
     * logic: the encoder re-expands the loop region against a live count every frame,
     * so a per-frame write CAN now express it, and the count moved out of the
     * structure key. That is what lets an audio band drive it (bass multiplying
     * iterations, clamped to MAX_SUBSTEPS at expansion, so the pattern accelerates on
     * the beat without an unbounded frame). The pair's identity never depended on it,
     * so neither dragging the slider nor the drive wipes the history you are watching.
     */
    substeps: {
      type: "number",
      label: "Substeps",
      default: 1,
      min: 1,
      max: MAX_SUBSTEPS,
      range: "bounded",
      step: 1,
      description:
        "Iterations of this loop per displayed frame. 1 is one step per frame; a reaction-diffusion wants 10-50. Costs that many times the loop's GPU work.",
    },
    resetPulse: {
      type: "pulse",
      label: "Reset Pulse",
      // §V126: scoped to THIS node's pair. An unscoped clear would wipe every other
      // feedback loop in the graph, which is the reason this command waited for
      // per-resource reset rather than shipping against the whole-backend one.
      fires: "runtime.resetFeedback",
      input: { nodeIds: ["$node"] },
      description: "Clears this loop's history once.",
    },
  },
  resolutionPolicy: { kind: "inherit", input: "in" },
  formatPolicy: { kind: "inherit", input: "in" },
  temporal: {
    outputs: ["out"],
    resetOn: ["resolution", "format", "shader-interface", "device", "load"],
    substeps: "substeps",
  },
  // §V46: replay from frame zero with the same inputs reproduces the same history;
  // there is no checkpointing yet, so seeking requires a reset and a re-run. §V123: the
  // capability this field declares now has something that triggers it (`resetPulse`).
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
        hold: readFlag(parameters, "reset", false),
      },
      nodeId,
      label: "Feedback",
    };
    return { passes: [pass] };
  },
};

/** The temporal group, in library order. */
export const temporalNodes: readonly NodeDefinition[] = [feedbackNode];
