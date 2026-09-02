import type { CompiledNodeDescription, NodeDefinition } from "../../domain/types/node-definition.ts";
import type { DispatchPassDescriptor, EffectPassDescriptor } from "../../runtime/backend/plan.ts";
import { RGBA_TEXTURE } from "./common-ports.ts";
import { readCompileInputs } from "./compile-context.ts";
import { scratchResourceId } from "../../compiler/resources.ts";
import { inferenceSourceIdFor } from "../../runtime/execution/inference-sources.ts";
import { MATTE_ACCURATE, MATTE_FAST, MATTE_MODELS } from "../../runtime/models/model-catalogue.ts";
import { MATTE_INPUT_SIDE } from "../../runtime/models/matte-runner.ts";
import { inferenceModelSchema, inferenceResetSchema, letterboxPreprocessWgsl } from "./inference-node.ts";

/**
 * Matte — a person MATTE from a single image, inferred (T957).
 *
 * MODNet running in the browser: a soft alpha that is high where the subject is and
 * zero where they are not. NAMING, on purpose and everywhere: this node produces a
 * matte; the compositing `mask` node — a different thing — APPLIES one. A matte is what
 * you feed a mask, and the two words never trade places in any copy (§T957).
 *
 * ## §T715, exactly as depth and pose hold it
 *
 * The node always exists, always publishes its output, and a document loads and renders
 * without the model. The neutral output is ZERO everywhere — "nobody is here" — so a
 * masked composite simply shows none of the subject layer. The no-model state and the
 * empty-frame state are the same picture, which is pose's own precedent.
 *
 * ## §T384: late, at its own rate, smoothed with a stated cost
 *
 * Results arrive when the model finishes, not per frame; live playback shows the most
 * recent matte and reports its age. MODNet is per-frame and its edges flicker, so the
 * worker applies a temporal EMA to the matte (T957): stability bought with a few frames
 * of edge lag on a fast-moving subject. The properly-recurrent models that fix this
 * without lag are blocked (§T981; RVM is GPL besides).
 *
 * ## §V827, on the seam from day one
 *
 * The model chooser names each artefact's measured download and licence in the control
 * itself; the reset pulse is §T978's, session-scoped, weights kept. What-ran and
 * what-it-cost are published by the runtime's readouts, never echoed from here.
 */

export const MATTE_INPUT_KEY = "modelInput";
export const MATTE_RESULT_KEY = "modelResult";

const WORKGROUPS = Math.ceil(MATTE_INPUT_SIDE / 8);

/* T959's rule holds here from birth: the result is r32float (no filtering sampler, no
   byte rounding), read nearest — a matte edge blended bilinearly would invent coverage
   between subject and background that neither owns. */
const MATTE_BLIT_WGSL = `@group(0) @binding(1) var matteTexture: texture_2d<f32>;

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let dims = vec2f(textureDimensions(matteTexture, 0));
  let texel = vec2i(clamp(uv, vec2f(0.0), vec2f(1.0)) * (dims - vec2f(1.0)));
  let value = textureLoad(matteTexture, texel, 0).r;
  /* Every channel carries the matte, alpha included: the compositing mask can read any
     of its channel options and premultiplied consumers get the same answer. */
  return vec4f(value, value, value, value);
}`;

export const matteNode: NodeDefinition = {
  type: "matte",
  version: 1,
  title: "Matte",
  category: "generator",
  description:
    "Extracts a person MATTE — a soft alpha, high on the subject, zero elsewhere — using MODNet running in the browser. Feed it to the compositing Mask node's mask input to cut a subject out (the Mask node applies a matte; this node makes one). The model downloads once per machine on first use, with your consent; until then the node publishes zero everywhere — 'nobody is here' — and the document still renders. Results arrive at the model's own rate; the matte is temporally smoothed in the worker, which steadies flickering edges at the cost of a few frames of lag on fast motion.",
  tags: ["matte", "matting", "segmentation", "person", "ml", "inference", "alpha"],
  inputs: [{ id: "input", label: "Input", type: RGBA_TEXTURE }],
  outputs: [{ id: "out", label: "Out", type: RGBA_TEXTURE }],
  parameters: {
    model: inferenceModelSchema(MATTE_MODELS, {
      what: "Which MODNet build runs: full precision, or the quantized quarter-size trade.",
    }),
    reset: inferenceResetSchema(),
  },
  resolutionPolicy: { kind: "inherit", input: "input" },
  compile(context): CompiledNodeDescription {
    const { nodeId, inputs, outputs } = readCompileInputs(context);
    const source = inputs["input"];
    const target = outputs["out"];
    // §V585: an unwired model node compiles to nothing and downloads nothing.
    if (source === undefined || target === undefined) return { passes: [] };

    const preprocess: DispatchPassDescriptor = {
      kind: "dispatch",
      id: `${nodeId}:preprocess`,
      shader: letterboxPreprocessWgsl(),
      entryPoint: "main",
      workgroups: [WORKGROUPS, WORKGROUPS, 1],
      buffers: [{ binding: "modelInput", resourceId: scratchResourceId(nodeId, MATTE_INPUT_KEY) }],
      textures: [{ binding: "sourceTexture", resourceId: source.resource, sampled: "unfiltered" }],
      uniforms: { side: MATTE_INPUT_SIDE },
      uniformBinding: "params",
      nodeId,
    };

    const blit: EffectPassDescriptor = {
      kind: "effect",
      id: `${nodeId}:result`,
      shader: MATTE_BLIT_WGSL,
      target,
      textures: [
        { binding: "matteTexture", resourceId: scratchResourceId(nodeId, MATTE_RESULT_KEY), sampled: "unfiltered" },
      ],
      nodeId,
    };

    return {
      passes: [preprocess, blit],
      scratch: [
        {
          key: MATTE_INPUT_KEY,
          kind: "buffer",
          stride: 16,
          capacity: MATTE_INPUT_SIDE * MATTE_INPUT_SIDE,
        },
        {
          key: MATTE_RESULT_KEY,
          kind: "external",
          sourceId: inferenceSourceIdFor(nodeId),
          // A matte is a measurement, and a FLOAT one (T959 from birth): no transfer
          // function, no byte rounding between the model and the composite.
          format: "r32float",
        },
      ],
    };
  },
};

export { MATTE_ACCURATE, MATTE_FAST };
