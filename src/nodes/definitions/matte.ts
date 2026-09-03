import type { CompiledNodeDescription, NodeDefinition } from "../../domain/types/node-definition.ts";
import type { DispatchPassDescriptor, EffectPassDescriptor } from "../../runtime/backend/plan.ts";
import { RGBA_TEXTURE } from "./common-ports.ts";
import { readCompileInputs } from "./compile-context.ts";
import { scratchResourceId } from "../../compiler/resources.ts";
import { inferenceSourceIdFor } from "../../runtime/execution/inference-sources.ts";
import { MATTE_ACCURATE, MATTE_FAST, MATTE_MODELS } from "../../runtime/models/model-catalogue.ts";
import { MATTE_INPUT_SIDE } from "../../runtime/models/matte-runner.ts";
import {
  inferenceBackendSchema,
  inferenceModelSchema,
  inferenceResetSchema,
  letterboxPreprocessWgsl,
} from "./inference-node.ts";

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
 * worker applies a temporal EMA to the matte (T957): stability bought with edge lag on a
 * moving subject. MEASURED in the app 2026-09-03, quantized MODNet on the WebGPU provider
 * at 1280x720: 997-1606 ms per inference, 19-25 frames behind. So the lag the EMA adds is
 * a SECOND, not "a few frames" — see `smoothMatte` for why that number is a design
 * question rather than a bug. The properly-recurrent models that fix this without lag are
 * blocked (§T981; RVM is GPL besides).
 *
 * ## §V827, on the seam from day one
 *
 * The model chooser names each artefact's measured download and licence in the control
 * itself; the Backend chooser names the providers THIS browser can reach and defaults to
 * trying the GPU first (measured 2026-09-03: wasm 6323 ms, webgpu 658 ms for the same
 * input and a byte-identical matte); the reset pulse is §T978's, session-scoped, weights
 * kept. What-ran and what-it-cost are published by the runtime's readouts, never echoed
 * from here.
 *
 * ## §V288 — AND IT SAYS HOW MUCH IT FOUND
 *
 * This node's neutral output is ALSO a legitimate answer: zero everywhere means "no
 * model" and "nobody is in frame", so a working matte over an empty room is
 * pixel-for-pixel a broken one. Every diagnosis this node has attracted has been that
 * confusion, in both directions. So each result is measured — the fraction of the frame it
 * claims — and published on `<name>:coverage`, with a one-line notice while it is zero.
 * The measurement lives in `matteCoverage`; the reason it has to exist lives there too.
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

/**
 * The node's own schema, from its stored bag — §V827's (1), (4) and (5) in one place.
 *
 * A function rather than a literal because the Backend chooser is DYNAMIC: it names what
 * this browser reports it can reach, and keeps an unreachable stored pin in the list
 * rather than silently rewriting the document to something the author did not pick.
 */
function matteParameters(stored: Readonly<Record<string, unknown>>) {
  return {
    model: inferenceModelSchema(MATTE_MODELS, {
      what: "Which MODNet build runs: full precision, or the quantized quarter-size trade.",
    }),
    backend: inferenceBackendSchema(stored),
    reset: inferenceResetSchema(),
  };
}

export const matteNode: NodeDefinition = {
  type: "matte",
  version: 1,
  title: "Matte",
  category: "generator",
  description:
    "Extracts a person MATTE — a soft alpha, high on the subject, zero elsewhere — using MODNet running in the browser. Feed it to the compositing Mask node's mask input to cut a subject out (the Mask node applies a matte; this node makes one). The model downloads once per machine on first use, with your consent; until then the node publishes zero everywhere — 'nobody is here' — and the document still renders. Results arrive at the model's own rate — around one per second on a GPU provider at 1280x720 — and the matte is temporally smoothed in the worker, which steadies flickering edges at the cost of about a second of lag on fast motion. How much of the frame the current result claims is published on the node's `coverage` channel — zero there means the model ran and found nobody, which is not the same as the model being unavailable.",
  tags: ["matte", "matting", "segmentation", "person", "ml", "inference", "alpha"],
  inputs: [{ id: "input", label: "Input", type: RGBA_TEXTURE }],
  outputs: [{ id: "out", label: "Out", type: RGBA_TEXTURE }],
  parameters: matteParameters({}),
  /**
   * PER-INSTANCE, because the Backend list is what THIS browser reports it can reach and a
   * stored pin has to stay visible even when it cannot (§T960's dynamic enum). A static
   * table would offer WebGPU on a machine that has none, which is a control that lies.
   */
  parametersFor(stored) {
    return matteParameters(stored);
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
