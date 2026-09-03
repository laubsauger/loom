import type { CompiledNodeDescription, NodeDefinition } from "../../domain/types/node-definition.ts";
import type { DispatchPassDescriptor, EffectPassDescriptor } from "../../runtime/backend/plan.ts";
import { RGBA_TEXTURE } from "./common-ports.ts";
import { readCompileInputs } from "./compile-context.ts";
import { scratchResourceId } from "../../compiler/resources.ts";
import { inferenceSourceIdFor } from "../../runtime/execution/inference-sources.ts";
import { MATTE_ACCURATE, MATTE_FAST, MATTE_MODELS, MATTE_RVM } from "../../runtime/models/model-catalogue.ts";
import type { ModelDescriptor } from "../../runtime/models/model-acquisition.ts";
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
 * question rather than a bug. §T957 recorded the properly-recurrent models as blocked;
 * §T1040 unblocked them, and RVM is now the third option on the Model chooser — it
 * carries its coherence in a recurrent state instead of an average over frames, so the
 * EMA's alpha became a PARAMETER in the same change, defaulted per model (0.55 for
 * MODNet, 1 — none — for RVM). It is not a free win: measured on a moving subject, RVM's
 * recurrence is 1.75x steadier than the same model run frame-by-frame, and still not as
 * steady as MODNet with the EMA on. It is a different trade, offered, not a better one.
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
/**
 * WHICH ARTEFACT this node's stored bag selects — the ONE place that decision is made.
 *
 * It used to be a `=== MATTE_FAST.id` ternary written twice, here and in the app's
 * inference seam, which was survivable while there were two options and a wrong answer
 * could only ever be "the other MODNet". With three it stops being survivable: the same
 * ternary, unchanged, silently resolves a stored `rvm-mobilenetv3` to MODNet — a document
 * that says RVM, downloads MODNet, and reports MODNet, with nothing anywhere disagreeing.
 * So there is one function, both callers use it, and an id nothing recognises falls back
 * to the default rather than to whichever branch was written last.
 */
export function matteDescriptorFor(stored: Readonly<Record<string, unknown>>): ModelDescriptor {
  const wanted = stored["model"];
  return MATTE_MODELS.find((model) => model.id === wanted) ?? MATTE_ACCURATE;
}

export function matteInputSideFor(stored: Readonly<Record<string, unknown>>): number {
  const modelId = matteDescriptorFor(stored).id;
  if (!inferenceAcceptsInputSize(modelId)) return MATTE_DEFAULT_INPUT_SIDE;
  const raw = stored["inputSide"];
  const requested = typeof raw === "number" ? raw : Number(raw);
  return MATTE_INPUT_SIDES.some((option) => option.side === requested)
    ? requested
    : MATTE_DEFAULT_INPUT_SIDE;
}

/**
 * ═══════════════════════════════════════════════════════════════════════════════════
 * RVM's OWN KNOB — `downsample_ratio`, and what each setting measured (§V827, §T1040)
 * ═══════════════════════════════════════════════════════════════════════════════════
 *
 * §V827's per-artefact half: a knob that exists only because of which weights were
 * chosen. RVM refines a full-resolution matte from a cheap encoder pass run on a
 * DOWNSAMPLE of the input, and this dial is that fraction — so unlike Input Size above,
 * it changes what the expensive half costs without changing what the output is.
 *
 * Measured 2026-09-03, this artefact, the app's own 512² letterbox, wasm on ONE THREAD,
 * median of five warm runs with the recurrent state fed back. `internal` is `512 × ratio`,
 * which is what the cost actually tracks. The thread count is stated because it is worth
 * 5x on its own (MODNet fp32 512²: 814-842 ms on one thread, 136-165 ms on eight), and an
 * isolated page gets the threads — the same artefact at ratio 1.0 measured 313 ms in a
 * cross-origin-isolated browser against the 724 ms below, so this column is the FLOOR:
 *
 *   ratio   internal    ms    state/frame   the picture
 *   0.25    128 px      61    0.38 MB       speckle in the background below the subject
 *   0.375   192 px     100    0.86 MB       clean
 *   0.5     256 px     172    1.53 MB       clean          ← default
 *   0.75    384 px     409    3.45 MB       clean
 *   1.0     512 px     724    6.13 MB       clean
 *
 * TWO THINGS THE TABLE SAYS:
 *
 *  1. THE DEFAULT IS 0.5 AND IT IS NOT THE BEST ONE. 1.0 costs 4.2x more and the pictures
 *     are indistinguishable at this input size; RVM's own guidance is that the downsampled
 *     side wants to land between 256 and 512 px, and 0.5 puts it at 256 — the bottom of
 *     the range the model was trained for, at a quarter of the price of the top.
 *  2. QUALITY BREAKS BELOW 0.375, AND COVERAGE DOES NOT SAY SO (§V864). At 0.25 the
 *     coverage reads 0.199 against 0.5's 0.164 — HIGHER, while the picture is visibly
 *     worse: the extra "coverage" is speckle in the background, which an aggregate counts
 *     as subject. The pictures are what separate these, which is why the option that
 *     breaks is labelled as breaking.
 *
 * The state size column is not decoration: it is what is held per session between frames,
 * and 6.13 MB at ratio 1.0 is the reason the recurrent tensors stay in the worker instead
 * of crossing the message boundary.
 */
interface MatteRatioCost {
  readonly ratio: number;
  /** Median isolated `session.run`, ms, wasm — the only provider RVM runs on. */
  readonly cpuMillis: number;
  /** Recurrent state carried between frames at this ratio, MB. */
  readonly stateMb: number;
  /** What the PICTURE does here, or absent where it holds. */
  readonly costsYou?: string;
}

const MATTE_RATIOS: readonly MatteRatioCost[] = [
  { ratio: 0.25, cpuMillis: 61, stateMb: 0.38, costsYou: "speckles the background below the subject" },
  { ratio: 0.375, cpuMillis: 100, stateMb: 0.86 },
  { ratio: 0.5, cpuMillis: 172, stateMb: 1.53 },
  { ratio: 0.75, cpuMillis: 409, stateMb: 3.45 },
  { ratio: 1, cpuMillis: 724, stateMb: 6.13 },
];

const MATTE_DEFAULT_RATIO = 0.5;

/**
 * The `downsample_ratio` this node asks for, or 0 for a model that has no such input.
 *
 * ZERO rather than a default when the model does not take one: the worker feeds this
 * scalar only where its plan names an input for it, so a number here for MODNet would be
 * a value that travels every frame and means nothing. It is also what keys the recurrent
 * stash, so "no ratio" has to be one stable value rather than whatever the dial was left
 * on before the model changed.
 */
export function matteRatioFor(stored: Readonly<Record<string, unknown>>): number {
  if (matteDescriptorFor(stored).id !== MATTE_RVM.id) return 0;
  const raw = stored["downsampleRatio"];
  const requested = typeof raw === "number" ? raw : Number(raw);
  return MATTE_RATIOS.some((option) => option.ratio === requested) ? requested : MATTE_DEFAULT_RATIO;
}

/**
 * The EMA blend this node asks for — and its DEFAULT is the model's, not a constant.
 *
 * §T957 hard-coded 0.55 in the worker for MODNet, which is right for MODNet and wrong for
 * RVM: averaging frames on top of a recurrent network counts the past twice. So the
 * default comes from the artefact (`MODEL_PLANS` in the worker holds the same numbers,
 * and `matte-rvm.test.ts` pins them equal) and the parameter is how a user overrides it
 * in either direction.
 */
export function matteSmoothingFor(stored: Readonly<Record<string, unknown>>): number {
  const raw = stored["smoothing"];
  const requested = typeof raw === "number" ? raw : Number(raw);
  if (Number.isFinite(requested) && requested > 0 && requested <= 1) return requested;
  return matteDescriptorFor(stored).id === MATTE_RVM.id ? 1 : 0.55;
}

/**
 * ═══════════════════════════════════════════════════════════════════════════════════
 * THE LEVELS, AND WHY THEY RUN HERE RATHER THAN IN THE WORKER
 * ═══════════════════════════════════════════════════════════════════════════════════
 *
 * The owner: "the smoothing and blending and temporal and whatnot, and post-processing —
 * that we at least can access with parameters. We basically have zero outside of the
 * resolution."
 *
 * These four are per-pixel and they run in the node's OWN blit pass, as uniform values on
 * a pass that already exists (§V5: a uniform change updates the buffer in place and never
 * reaches the compile key). That placement is the whole design. The model costs 30 ms on
 * a good day and seconds on a bad one; a black point that forced a re-inference to move
 * would be a control nobody could use. So the split is: MODEL, BACKEND and INPUT SIZE
 * cost a reload, SMOOTHING costs one result, and everything below is free and immediate.
 *
 * WHAT THEY ARE FOR, which is not cosmetic. §V864's finding is that a marginal matte
 * punches holes through a low-contrast torso and coverage cannot see it. Pulling the
 * white point down forces the almost-opaque to fully opaque and closes exactly those
 * holes; lifting the black point crushes the grey haze a matte leaves across a busy
 * background. On a SOFT alpha this trio is also the choke/spread gesture a keyer would
 * reach for — the edge is a ramp, and moving the levels on a ramp moves the edge.
 */
interface MattePost {
  readonly blackPoint: number;
  readonly whitePoint: number;
  readonly gamma: number;
  readonly invert: number;
}

const numberOr = (raw: unknown, fallback: number): number => {
  const value = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(value) ? value : fallback;
};

export function mattePostFor(stored: Readonly<Record<string, unknown>>): MattePost {
  const blackPoint = Math.min(0.999, Math.max(0, numberOr(stored["blackPoint"], 0)));
  return {
    blackPoint,
    // Never at or below the black point: the shader divides by the span, and a zero span
    // is a NaN matte — the failure mode §V864 says nothing downstream would notice.
    whitePoint: Math.min(1, Math.max(blackPoint + 0.001, numberOr(stored["whitePoint"], 1))),
    gamma: Math.min(8, Math.max(0.05, numberOr(stored["gamma"], 1))),
    invert: stored["invert"] === true ? 1 : 0,
  };
}

/* T959's rule holds here from birth: the result is r32float (no filtering sampler, no
   byte rounding), read nearest — a matte edge blended bilinearly would invent coverage
   between subject and background that neither owns. */
const MATTE_BLIT_WGSL = `struct MatteParams {
  blackPoint: f32,
  whitePoint: f32,
  gamma: f32,
  invert: f32,
};

@group(0) @binding(0) var<uniform> params: MatteParams;
@group(0) @binding(1) var matteTexture: texture_2d<f32>;

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let dims = vec2f(textureDimensions(matteTexture, 0));
  let texel = vec2i(clamp(uv, vec2f(0.0), vec2f(1.0)) * (dims - vec2f(1.0)));
  var value = textureLoad(matteTexture, texel, 0).r;
  /* LEVELS, on the alpha ramp: remap [black, white] onto [0,1], then bend it. The span is
     floored by the resolver, not here — a zero span is a NaN matte and nothing downstream
     would notice (§V864), so it is refused where the number is read rather than patched
     where it is used. */
  let span = params.whitePoint - params.blackPoint;
  value = clamp((value - params.blackPoint) / span, 0.0, 1.0);
  value = pow(value, params.gamma);
  value = mix(value, 1.0 - value, params.invert);
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

/** One ratio option: the fraction, what it MEASURED, and what it costs the picture. */
function ratioLabel(option: MatteRatioCost): string {
  const damage = option.costsYou === undefined ? "" : ` — ${option.costsYou}`;
  return `${option.ratio} — ${option.cpuMillis} ms, ${option.stateMb} MB of state${damage}`;
}

function matteParameters(stored: Readonly<Record<string, unknown>>) {
  const descriptor = matteDescriptorFor(stored);
  const modelId = descriptor.id;
  /*
   * §T965(c)/§V827 again, on RVM's own dial: the knob EXISTS OR DOES NOT, decided by
   * which artefact is loaded rather than shown greyed out for the models that have no
   * such input. MODNet declares one input and no scalars; offering it a downsample ratio
   * would be a control that does nothing, which is the §V146 shape this rule exists for.
   */
  const downsampleRatio =
    modelId === MATTE_RVM.id
      ? {
          downsampleRatio: {
            type: "enum" as const,
            label: "Detail Ratio",
            group: "Model",
            // Per-RUN, not structural: the worker feeds it as a scalar tensor and drops
            // the recurrent stash when it moves. No rebuild, no reload, one frame of
            // temporal coherence lost.
            default: String(MATTE_DEFAULT_RATIO),
            options: MATTE_RATIOS.map((option) => ({
              value: String(option.ratio),
              label: ratioLabel(option),
            })),
            description:
              "The fraction of the input square RVM's encoder actually runs on before it " +
              "refines the matte back up to full resolution — this model's own cost dial, " +
              "and the one that matters, because the time tracks this rather than the " +
              "output size. The times in the labels are measured runs of this artefact on " +
              "one portrait at the default 512 px input, on the CPU — the only provider RVM " +
              "runs on — with ONE wasm thread, which is the floor: a cross-origin-isolated " +
              "page gets several threads and measured about 2.3x faster. RVM's own guidance " +
              "is that the downsampled side wants " +
              "to land between 256 and 512 px, so 0.5 sits at the bottom of the trained " +
              "range at a quarter of 1.0's cost and looks the same; 0.25 falls below it and " +
              "starts speckling the background, which raises the coverage reading while " +
              "making the picture worse, so watch the matte rather than the number. Moving " +
              "this resizes the recurrent state and restarts it, costing one frame.",
          },
        }
      : {};
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
    ...downsampleRatio,
    model: inferenceModelSchema(MATTE_MODELS, {
      what:
        "Which matting model runs, and the three are different in kind rather than in " +
        "degree. MODNet full precision is the reliable default: measured, it finds the " +
        "same subject in the same place from a bright frame down to a very dark one, and " +
        "it is the only one of the three the GPU provider can execute at all, measured at 30 ms there. " +
        "MODNet quantized is a quarter of the download and NOT faster, and below about a " +
        "fifth brightness it collapses to a fortieth of the coverage in the wrong part of " +
        "the frame — pictures reach this node in linear light, which is dimmer than it " +
        "looks, so prefer full precision unless the download is the binding constraint. " +
        "Robust Video Matting is the one built for VIDEO: it carries what it saw last " +
        "frame in a recurrent state, which measured 1.75x steadier than the same model " +
        "run frame-by-frame, and it needs no temporal smoothing of its own. It is not the " +
        "fast one — the GPU provider cannot execute it at all, so the CPU is its floor: 172 ms " +
        "on a single wasm thread against MODNet's 30 ms on the GPU provider — and its " +
        "weights are " +
        "GPL-3.0, downloaded by your " +
        "browser rather than shipped with the app.",
    }),
    /*
     * §T957's constant, promoted to a knob because the right value is per MODEL (§T1040)
     * and the owner asked for the temporal controls by name. The default comes from the
     * chosen artefact, so switching model moves it without the user touching it.
     */
    smoothing: {
      type: "number" as const,
      label: "Smoothing",
      group: "Temporal",
      default: matteSmoothingFor({ model: modelId }),
      min: 0.05,
      max: 1,
      // §B111: these ARE limits, not slider travel — `mattePostFor`/`matteSmoothingFor`
      // clamp to them, so a value outside is refused rather than merely off-slider.
      range: "bounded" as const,
      step: 0.05,
      description:
        "How much of each new result is taken, averaged with the last one in the worker: " +
        "1 takes the new matte whole and does no smoothing at all, and lower values trade " +
        "responsiveness for steadier edges. It defaults per model, and that default is the " +
        "point — MODNet is a still-image matter whose edges flicker frame to frame, so it " +
        "gets 0.55, while Robust Video Matting already carries the past in its recurrent " +
        "state and gets 1, because averaging frames on top of a recurrent network counts " +
        "the same history twice. MIND THE UNIT: this blends once per RESULT, not once per " +
        "frame, and a result can be a second apart on a slow provider — at 0.55 that makes " +
        "each published matte 45% of a picture that old, which on a moving subject is a " +
        "ghost rather than a soft edge. Changing it costs one result, never a reload.",
    },
    /*
     * The levels trio and its switch — the node's post-processing, all four in the blit
     * pass that already exists, all four free to move. See `mattePostFor` for why here
     * rather than in the worker.
     */
    blackPoint: {
      type: "number" as const,
      label: "Black Point",
      group: "Matte",
      default: 0,
      min: 0,
      max: 0.999,
      // §B111: these ARE limits, not slider travel — `mattePostFor`/`matteSmoothingFor`
      // clamp to them, so a value outside is refused rather than merely off-slider.
      range: "bounded" as const,
      step: 0.01,
      description:
        "Alpha at or below this is forced to fully transparent, which is how you clear the " +
        "grey haze a matte leaves across a busy background. On a soft edge this is also the " +
        "choke: the edge is a ramp, so lifting its floor pulls the matte in. Free and " +
        "immediate — it is a uniform on the node's own pass and never re-runs the model.",
    },
    whitePoint: {
      type: "number" as const,
      label: "White Point",
      group: "Matte",
      default: 1,
      min: 0.001,
      max: 1,
      // §B111: these ARE limits, not slider travel — `mattePostFor`/`matteSmoothingFor`
      // clamp to them, so a value outside is refused rather than merely off-slider.
      range: "bounded" as const,
      step: 0.01,
      description:
        "Alpha at or above this is forced to fully opaque, which is the direct remedy for " +
        "the holes a smaller Input Size punches through a low-contrast torso — those holes " +
        "are almost-opaque rather than transparent, and coverage cannot see them, so this " +
        "is the control that closes them. Always kept above the black point; the two " +
        "together are the matte's contrast.",
    },
    gamma: {
      type: "number" as const,
      label: "Gamma",
      group: "Matte",
      default: 1,
      min: 0.05,
      max: 8,
      // §B111: these ARE limits, not slider travel — `mattePostFor`/`matteSmoothingFor`
      // clamp to them, so a value outside is refused rather than merely off-slider.
      range: "bounded" as const,
      step: 0.05,
      description:
        "Bends the alpha ramp between the black and white points without moving either: " +
        "below 1 pushes the soft edge toward opaque and spreads the matte, above 1 pushes " +
        "it toward transparent and tightens it. This is the fine adjustment for edge " +
        "softness once the two points have set the range.",
    },
    invert: {
      type: "boolean" as const,
      label: "Invert",
      group: "Matte",
      default: false,
      description:
        "Publishes the complement — opaque where the subject is not — which is what a " +
        "background replacement wants about as often as the subject itself. Applied last, " +
        "after the levels, so the points still mean what they say about the subject.",
    },
    backend: inferenceBackendSchema(stored, descriptor),
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

    /* The levels ride as UNIFORM VALUES on the pass that already existed — §V5's other
       half: values only, updated in place, never in the compile key. That is what makes
       them free to move on a node whose model can cost a second a frame. */
    const post = mattePostFor(parameters);
    const blit: EffectPassDescriptor = {
      kind: "effect",
      id: `${nodeId}:result`,
      shader: MATTE_BLIT_WGSL,
      target,
      textures: [
        { binding: "matteTexture", resourceId: scratchResourceId(nodeId, MATTE_RESULT_KEY), sampled: "unfiltered" },
      ],
      uniforms: {
        blackPoint: post.blackPoint,
        whitePoint: post.whitePoint,
        gamma: post.gamma,
        invert: post.invert,
      },
      uniformBinding: "params",
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

export { MATTE_ACCURATE, MATTE_FAST, MATTE_RVM };
