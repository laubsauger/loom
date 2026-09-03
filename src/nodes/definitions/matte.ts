import type { CompiledNodeDescription, NodeDefinition } from "../../domain/types/node-definition.ts";
import type { DispatchPassDescriptor, EffectPassDescriptor } from "../../runtime/backend/plan.ts";
import { RGBA_TEXTURE } from "./common-ports.ts";
import { readCompileInputs } from "./compile-context.ts";
import { scratchResourceId } from "../../compiler/resources.ts";
import { inferenceSourceIdFor } from "../../runtime/execution/inference-sources.ts";
import { MATTE_ACCURATE, MATTE_FAST, MATTE_MODELS } from "../../runtime/models/model-catalogue.ts";
import { MATTE_INPUT_SIDE } from "../../runtime/models/matte-runner.ts";
import {
  inferenceAcceptsInputSize,
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
 * ⚠ THOSE TWO NUMBERS ARE NOT `session.run`, AND THE GAP IS UNEXPLAINED. Re-measured
 * 2026-09-03 on the same machine, same weights, same letterboxed 512² input, timing the
 * isolated call and nothing else: **webgpu 30 ms, wasm 3304 ms** — a factor of 22 under
 * the 658 ms recorded above. Neither warm-up (44 ms cold on a fresh shape) nor a busy GPU
 * (43 ms with a second device saturating the queue) accounts for it. So the second-scale
 * figures on this node describe an end-to-end CADENCE and something in it that is not the
 * model; the ordering "the model is the expensive part" does not survive the measurement,
 * and the remaining ~600 ms is somewhere between the readback and the publish. Kept
 * verbatim rather than deleted, because a number that cannot be reproduced is itself the
 * finding, and the input-size table below is what rules the model out.
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

/**
 * ═══════════════════════════════════════════════════════════════════════════════════
 * WHAT EACH INPUT SIZE COSTS AND WHAT IT COSTS YOU — measured (§V827, §T965's knob)
 * ═══════════════════════════════════════════════════════════════════════════════════
 *
 * The question that produced this table was "does 256² make the matte usable", on the
 * theory that a 25.9 MB model at 512² is why results land about a second apart. THE
 * MEASUREMENT SAYS THE PREMISE IS WRONG, and that is the finding rather than the knob.
 *
 * Measured 2026-09-03, Chrome on macOS (Apple GPU), MODNet FULL PRECISION, one 772x435
 * portrait through this node's own letterbox and MODNet's own (x-0.5)/0.5, isolated
 * `session.run` only, median of five warm runs after a discarded warm-up:
 *
 *   side   webgpu   wasm     coverage   centroid        vs 512 (IoU@0.5)
 *   512      30 ms  3304 ms  0.2750     (0.508, 0.685)  1.000   reference
 *   384      20 ms  1829 ms  0.2544     (0.522, 0.671)  0.908   holds
 *   320      16 ms  1220 ms  0.2624     (0.512, 0.675)  0.907   holes in the torso
 *   256      12 ms   728 ms  0.2383     (0.512, 0.662)  0.837   a hole through the chest
 *   192      10 ms   448 ms  0.2574     (0.520, 0.673)  0.903   an arm is gone
 *   128       8 ms   226 ms  0.0475     (0.493, 0.380)  0.163   collapse
 *
 * THREE THINGS THE TABLE SAYS, none of them the thing it was run to find:
 *
 *  1. 512 IS ALREADY 30 ms. On the provider `auto` reaches first, the whole model is a
 *     third of a 100 ms budget, so the input size is not what makes a matte feel late and
 *     no smaller default would fix that. Whatever spends the rest of that second is
 *     somewhere else, and shrinking this would only have hidden it.
 *  2. QUALITY FALLS OFF A CLIFF, AND IT IS NOT WHERE THE NUMBERS SAY. Coverage and
 *     centroid barely move down to 192 — 192 keeps 93% of 512's coverage and its centroid
 *     to within two texels while visibly losing an arm. Below 384 the matte punches holes
 *     through a low-contrast torso; at 128 it finds a head and nothing else. The picture
 *     is what separates these, which is why the sizes that break are labelled as breaking
 *     rather than left for someone to discover.
 *  3. §V859 DOES NOT APPLY HERE. Run time tracks input PIXELS almost exactly on the CPU
 *     path (0.5625/0.3906/0.25/0.1406/0.0625 of 512's pixels predicts 1858/1290/826/465/
 *     207 ms against 1829/1220/728/448/226 measured), the output dims track the input's,
 *     and a 512 matte resampled down to 256 is not the 256 matte (mean |Δα| 0.048). So
 *     MODNet has no fixed internal square that a bigger input would be wasted on: the
 *     detail is really computed, and really paid for.
 *
 * ⚠ ON THE CPU PATH THE SIZE IS EVERYTHING — 3.3 s against 0.73 s — which is the case
 * this control exists for. `auto` falls back to wasm on a machine with no WebGPU, and
 * that machine is the one that needs 384 or 320.
 *
 * `MATTE_INPUT_SIDE` stays 512 and stays the REFERENCE size — what MODNet's own inference
 * script resizes to, and the fallback for a stored side this model would refuse. This
 * table owns the node's DEFAULT. Two names because they answer two questions.
 */
interface MatteInputSideCost {
  readonly side: number;
  /** Median isolated `session.run`, ms, WebGPU provider. */
  readonly gpuMillis: number;
  /** Median isolated `session.run`, ms, wasm provider. */
  readonly cpuMillis: number;
  /** What the PICTURE does at this size, or absent where it holds. */
  readonly costsYou?: string;
}

/** Multiples of 32 — MODNet's reference inference resizes to one and its graph is built
 *  on one, so a size between them is not a legal input. */
const MATTE_INPUT_SIDES: readonly MatteInputSideCost[] = [
  { side: 256, gpuMillis: 12, cpuMillis: 728, costsYou: "punches a hole through a low-contrast torso" },
  { side: 320, gpuMillis: 16, cpuMillis: 1220, costsYou: "starts punching holes in a low-contrast torso" },
  { side: 384, gpuMillis: 20, cpuMillis: 1829 },
  { side: 512, gpuMillis: 30, cpuMillis: 3304 },
];

/**
 * THE SHIPPED DEFAULT, and it is the LARGEST offered — the opposite of §T976's call for
 * depth, from the same evidence read on a different model.
 *
 * §T976 defaulted depth to a quarter of its export size because a Depth node is usually
 * over a live webcam and Depth Anything costs 2.7 SECONDS a run: there, a result that
 * arrives beats a result that is better. MODNet costs 30 ms. There is no arrival to buy,
 * so the 18 ms that 256 saves is paid for with a hole through the subject's chest — and a
 * matte with a hole in it is not a cheaper matte, it is a wrong one. Smaller stays one
 * click away and stays right for the wasm fallback, where the same step is 2.6 seconds.
 */
const MATTE_DEFAULT_INPUT_SIDE = MATTE_INPUT_SIDE;

/**
 * The input side this node's stored parameters select — the ONE place the default lives.
 *
 * The app's inference seam reads a node's RAW stored bag (a parameter may be driven, and
 * the seam is outside the resolver), so a second copy of "what does absent mean" out
 * there would be a second answer. An illegal or absent value resolves to the default, and
 * so does ANY value on a model whose graph pins its own input shape.
 */
export function matteInputSideFor(stored: Readonly<Record<string, unknown>>): number {
  const modelId = stored["model"] === MATTE_FAST.id ? MATTE_FAST.id : MATTE_ACCURATE.id;
  if (!inferenceAcceptsInputSize(modelId)) return MATTE_DEFAULT_INPUT_SIDE;
  const raw = stored["inputSide"];
  const requested = typeof raw === "number" ? raw : Number(raw);
  return MATTE_INPUT_SIDES.some((option) => option.side === requested)
    ? requested
    : MATTE_DEFAULT_INPUT_SIDE;
}

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
/** One option's label: the size, then what it MEASURED, then what it costs the picture. */
function inputSideLabel(option: MatteInputSideCost): string {
  const cpu = `${(option.cpuMillis / 1000).toFixed(1)} s`;
  const damage = option.costsYou === undefined ? "" : ` — ${option.costsYou}`;
  return `${option.side} px — ${option.gpuMillis} ms on a GPU, ${cpu} on the CPU${damage}`;
}

function matteParameters(stored: Readonly<Record<string, unknown>>) {
  const modelId = stored["model"] === MATTE_FAST.id ? MATTE_FAST.id : MATTE_ACCURATE.id;
  /*
   * §T965(c) — the knob EXISTS OR DOES NOT, read from the chosen model's recorded
   * signature rather than from an assumption. Both MODNet builds leave height and width
   * symbolic today; a future matte model that pins them gets no control instead of one
   * that fails at run time.
   */
  const inputSide = inferenceAcceptsInputSize(modelId)
    ? {
        inputSide: {
          type: "enum" as const,
          label: "Input Size",
          group: "Model",
          // Structural: the preprocess buffer and its dispatch are sized from this, so it
          // is a REBUILD rather than a uniform write (§V5).
          compileTime: true,
          default: String(MATTE_DEFAULT_INPUT_SIDE),
          options: MATTE_INPUT_SIDES.map((option) => ({
            value: String(option.side),
            label: inputSideLabel(option),
          })),
          description:
            "The square the picture is resampled to before the model sees it, every " +
            "option a multiple of 32 because MODNet's graph is built on one. The times " +
            "in the labels are measured runs of the full-precision build on one portrait, " +
            "and the two columns are the point: on a GPU the whole range is 12-30 ms, so " +
            "there is nothing to buy by going smaller, while on the CPU fallback the same " +
            "step is 3.3 s against 0.7 s. What smaller costs is the subject — below 384 " +
            "the matte starts punching holes through a torso that matches its background, " +
            "and coverage does not fall when it does, so watch the picture rather than the " +
            "number. The OUTPUT is unaffected: the matte is always resampled back up to " +
            "the input image's own resolution.",
        },
      }
    : {};
  return {
    ...inputSide,
    model: inferenceModelSchema(MATTE_MODELS, {
      what:
        "Which MODNet build runs. Full precision is the reliable one and is what you " +
        "want: measured, it finds the same subject in the same place from a bright frame " +
        "down to a very dark one. The quantized build is a quarter of the download and NOT " +
        "faster, and below about a fifth brightness it collapses — a fortieth of the " +
        "coverage, in the wrong part of the frame. Pictures reach this node in linear " +
        "light, which is dimmer than it looks, so prefer full precision unless the " +
        "download is the binding constraint.",
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
    const { nodeId, inputs, outputs, parameters } = readCompileInputs(context);
    const source = inputs["input"];
    const target = outputs["out"];
    // §V585: an unwired model node compiles to nothing and downloads nothing.
    if (source === undefined || target === undefined) return { passes: [] };

    // The square the model sees, from this node's own parameters (§T965). The dispatch,
    // the uniform and the scratch buffer are all sized from the ONE value, so a stored
    // side the model would refuse cannot reach half of them.
    const inputSide = matteInputSideFor(parameters);
    const workgroups = Math.ceil(inputSide / 8);

    const preprocess: DispatchPassDescriptor = {
      kind: "dispatch",
      id: `${nodeId}:preprocess`,
      shader: letterboxPreprocessWgsl(),
      entryPoint: "main",
      workgroups: [workgroups, workgroups, 1],
      buffers: [{ binding: "modelInput", resourceId: scratchResourceId(nodeId, MATTE_INPUT_KEY) }],
      textures: [{ binding: "sourceTexture", resourceId: source.resource, sampled: "unfiltered" }],
      uniforms: { side: inputSide },
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
          capacity: inputSide * inputSide,
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
