import type { CompiledNodeDescription, NodeDefinition } from "../../domain/types/node-definition.ts";
import type { DispatchPassDescriptor, EffectPassDescriptor } from "../../runtime/backend/plan.ts";
import { RGBA_TEXTURE } from "./common-ports.ts";
import { readCompileInputs } from "./compile-context.ts";
import { scratchResourceId } from "../../compiler/resources.ts";
import { inferenceSourceIdFor } from "../../runtime/execution/inference-sources.ts";
import { letterboxPreprocessWgsl } from "./inference-node.ts";

/**
 * Person Mask (T1029) — person segmentation through the OS's own Vision framework,
 * reached over the device bridge. The Matte node's sibling with the opposite trade:
 *
 *   Matte       downloaded weights, runs IN the page (worker + onnxruntime), works
 *               everywhere, and its bytes are hash-verified (§V858).
 *   PersonMask  ZERO download, ZERO weights, zero provenance question — an OS API has
 *               no bytes to verify — but it needs the local helper on macOS, and its
 *               model is whatever the OS shipped, so two machines may cut differently.
 *
 * Measured (Apple Silicon, warm, helper-side): 20–35 ms a frame at 640×360, with a
 * one-time ~2 s model load inside the first request. The in-page matte on WebGPU is
 * ~30 ms at 512² — so the argument for this node is never speed; it is the semantic
 * ("a person", the OS's own class), the empty download bar, and §V858.
 *
 * ## The same seam as every model node, deliberately
 *
 * compile() emits the SAME two-pass shape as Depth/Matte (§T736's registry claim):
 * a preprocess dispatch resamples the source into a scratch buffer the CPU half reads
 * back, and the result arrives as an external texture through the media registry. The
 * CPU half (`use-vision-bridge.ts`) rides `createInferenceSources` — the fill policies,
 * staleness ages, rate limit and coverage channel all apply unchanged; only the runner
 * differs (a bridge round trip instead of a worker message).
 *
 * ## Degrade rule (§T715), by mechanism per path
 *
 * No helper attached, a non-mac helper, no Xcode toolchain: the runner refuses with the
 * DOOR'S OWN SENTENCE, the seam serves the identity fallback (zero everywhere), and the
 * node reports the refusal through the same failure surface every model node uses. A
 * document using this node loads and renders anywhere; only the mask goes neutral.
 * Headless renders, takes and gates never construct the hook, so nothing is ever asked.
 */

export const PERSON_MASK_INPUT_KEY = "modelInput";
export const PERSON_MASK_RESULT_KEY = "modelResult";
/** The square the preprocess resamples to and the picture Vision is shown. Vision
 *  resamples internally anyway (~512 long side), so one fixed size keeps the readback
 *  budget constant and needs no parameter. */
export const PERSON_MASK_INPUT_SIDE = 512;

const PERSON_MASK_BLIT_WGSL = `struct MaskParams { invert: f32 };

@group(0) @binding(0) var<uniform> params: MaskParams;
@group(0) @binding(1) var maskTexture: texture_2d<f32>;

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let dims = vec2f(textureDimensions(maskTexture, 0));
  let texel = vec2i(clamp(uv, vec2f(0.0), vec2f(1.0)) * (dims - vec2f(1.0)));
  var value = textureLoad(maskTexture, texel, 0).r;
  value = mix(value, 1.0 - value, params.invert);
  /* Every channel carries the mask, alpha included — the Matte node's own convention,
     so a downstream compositor treats the two interchangeably. */
  return vec4f(value, value, value, value);
}`;

export const personMaskNode: NodeDefinition = {
  type: "personMask",
  version: 1,
  title: "Person Mask",
  category: "generator",
  description:
    "Person segmentation through the operating system's own Vision framework — no model download, no weights, nothing to verify. Needs the local helper (pnpm mcp:serve) on macOS; anywhere else the node stays neutral (zero mask, nobody) and says why. The OS supplies the model, so the cut may differ between machines and OS versions — for a hash-pinned, reproducible matte use the Matte node instead. White where the person is; every channel carries the mask.",
  tags: ["segmentation", "person", "mask", "vision", "matte", "device", "alpha"],
  inputs: [{ id: "input", label: "Input", type: RGBA_TEXTURE }],
  outputs: [{ id: "out", label: "Out", type: RGBA_TEXTURE }],
  parameters: {
    rateLimit: {
      type: "number",
      label: "Min interval (s)",
      default: 0.1,
      min: 0,
      max: 5,
      range: "bounded",
      step: 0.05,
      description:
        "Shortest gap between two segmentations, in timeline seconds. 0 runs as fast as results return. Each frame crosses the bridge (~1 MB), so the cap is a bandwidth dial as much as a CPU one.",
    },
    invert: {
      type: "boolean",
      label: "Invert",
      default: false,
      description: "Black where the person is — a background mask instead of a person mask.",
    },
  },
  /** The mask follows the input's shape, exactly as Matte's does. */
  resolutionPolicy: { kind: "inherit", input: "input" },
  compile(context): CompiledNodeDescription {
    const { nodeId, inputs, outputs, parameters } = readCompileInputs(context);
    const source = inputs["input"];
    const target = outputs["out"];
    // §V585: an unwired node compiles to nothing and asks the helper for nothing.
    if (source === undefined || target === undefined) return { passes: [] };

    const side = PERSON_MASK_INPUT_SIDE;
    const workgroups = Math.ceil(side / 8);

    const preprocess: DispatchPassDescriptor = {
      kind: "dispatch",
      id: `${nodeId}:preprocess`,
      shader: letterboxPreprocessWgsl(),
      entryPoint: "main",
      workgroups: [workgroups, workgroups, 1],
      buffers: [{ binding: "modelInput", resourceId: scratchResourceId(nodeId, PERSON_MASK_INPUT_KEY) }],
      textures: [{ binding: "sourceTexture", resourceId: source.resource, sampled: "unfiltered" }],
      uniforms: { side },
      uniformBinding: "params",
      nodeId,
    };

    const blit: EffectPassDescriptor = {
      kind: "effect",
      id: `${nodeId}:result`,
      shader: PERSON_MASK_BLIT_WGSL,
      target,
      textures: [
        { binding: "maskTexture", resourceId: scratchResourceId(nodeId, PERSON_MASK_RESULT_KEY), sampled: "unfiltered" },
      ],
      uniforms: { invert: parameters["invert"] === true ? 1 : 0 },
      uniformBinding: "params",
      nodeId,
    };

    return {
      passes: [preprocess, blit],
      scratch: [
        {
          key: PERSON_MASK_INPUT_KEY,
          kind: "buffer",
          stride: 16,
          capacity: side * side,
        },
        {
          key: PERSON_MASK_RESULT_KEY,
          kind: "external",
          sourceId: inferenceSourceIdFor(nodeId),
          // A mask is a measurement: float, linear, single channel — Matte's reasoning
          // (T959) inherited verbatim.
          format: "r32float",
        },
      ],
    };
  },
};
