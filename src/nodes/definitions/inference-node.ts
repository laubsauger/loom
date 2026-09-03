import type { EnumParameter, ParameterSchema } from "../../domain/types/parameters.ts";
import { refusalFor, type ModelDescriptor } from "../../runtime/models/model-acquisition.ts";
import { signatureFor } from "../../runtime/models/model-signatures.ts";

/**
 * §V827 — WHAT EVERY MODEL-RUNNING NODE OWES, the schema-side half, shared by
 * construction (the owner: "make it a rule that these things expose all the relevant
 * bits as we did for depth. We can't just swallow that — it will be needed anyway").
 *
 * Depth built these five obligations by hand (§T965/§T978); pose repeated depth's
 * omissions and earned §T985; the matte is the third instance and the moment the seam
 * exists. What lives here is what a SCHEMA can promise:
 *
 *   (1) the artefact and its cost, named IN the control that chooses it — the enum
 *       labels carry the measured megabytes and the licence rides the description;
 *   (4) WHERE it runs — the execution-provider request, and the ladder it resolves to;
 *   (5) the reset pulse — §T978's recovery gesture, session-scoped, weights kept.
 *
 * Obligations (2) what-actually-ran and (3) what-it-cost are MEASUREMENTS, published by
 * the inference runtime through the node-info readouts — a schema that claimed them
 * would be §T381's echo bug by construction, so they are deliberately not here.
 * (4)'s PER-ARTEFACT half — a knob that only exists because of which weights were chosen,
 * §T965's signature-driven Input Size being the worked example — stays in each node's
 * `parametersFor`, because it is per-model by nature. What moved here is the half that is
 * the SAME for every model node: which provider to ask for.
 *
 * Depth and pose still carry their own hand-built versions of (1) and (5); migrating
 * them onto this seam is the inference track's half of §V827 (their files, their
 * in-flight arc). The matte ships on the seam from day one.
 */

/** MB with one decimal, from the measured byte count — the number the consent moment shows. */
function megabytes(bytes: number): string {
  return `${(bytes / 1_048_576).toFixed(1)} MB`;
}

/**
 * (1) The model chooser: every option names its artefact AND its download, and the
 * description states the licence — the facts a user weighs at the moment of choosing.
 */
export function inferenceModelSchema(
  models: readonly ModelDescriptor[],
  options: { readonly label?: string; readonly what: string },
): EnumParameter {
  /*
   * Returns `EnumParameter`, not the `ParameterSchema[string]` union, and the narrowing
   * is what the FIRST MIGRATION needed rather than a preference (T965's depth node).
   *
   * Depth carries §V813 legacy stored values — looms shipped holding `accurate`/`fast`
   * before the chooser stored model ids — so its adoption has to EXTEND the option list
   * rather than take it whole. Through the union that read is impossible: `.options`
   * exists on one member. A seam a second adopter has to cast its way into is a seam that
   * will be forked instead of reused, which is the outcome §V827 exists to prevent.
   */
  const first = models[0];
  return {
    type: "enum",
    label: options.label ?? "Model",
    compileTime: true,
    default: first?.id ?? "",
    options: models.map((model) => ({
      value: model.id,
      label: `${model.label.replace(/ \(.*\)$/, "")} (${megabytes(model.bytes)})`,
    })),
    description:
      `${options.what} ` +
      `Downloaded once per machine on first use, with your consent — the size in each ` +
      `option is the download it commits you to. ` +
      `Licence: ${[...new Set(models.map((model) => model.license))].join(", ")}.`,
  };
}

/**
 * ═══════════════════════════════════════════════════════════════════════════════════
 * (4) WHERE INFERENCE RUNS — the REQUEST, and never the answer (§T715, §T960, §B171)
 * ═══════════════════════════════════════════════════════════════════════════════════
 *
 * Depth built this by hand and the matte hard-coded `["webgpu", "wasm"]` with no control
 * at all, which is the §V437 shape §V827 exists to stop: a knob delivered site by site is
 * not delivered. The owner's words on the matte, after measuring both: "GPU is like 10
 * times faster than the WASM implementation, so let's make sure that we prefer the WebGPU
 * implementation. But yeah, obviously make it selectable."
 *
 * MEASURED 2026-09-03, MODNet at 512² in Chrome on this machine, same weights, same
 * packed input, output identical to eight significant figures: **wasm 6323 ms, webgpu
 * 658 ms** — 9.6×. That is the number the default encodes.
 *
 * Two rules bind every word here, and both are easy to break by accident:
 *
 *  - REPORT WHAT IT GOT, NEVER WHAT IT ASKED FOR. This list is a PARAMETER, so it can only
 *    ever be a request. What actually ran is measured in the worker — which walks the
 *    ladder one provider at a time for exactly this reason — and shown on the node's info
 *    readout. A readout that echoed this control would confidently print "WebGPU" while
 *    the CPU did the work, which is the state §B171 produced.
 *  - NAME THE API, NEVER THE CHIP. `Neural Engine`, `ANE`, `NPU`, `hardware-accelerated`
 *    and "the browser chose the device" are banned from every surface (§T715): WebNN
 *    defines no device enumeration and no way to observe which device was chosen, so any
 *    of those words would be a claim we cannot check.
 *
 * ⚠ THE `auto` LADDER PUTS WEBGPU FIRST, and that is the one place this deliberately
 * differs from depth's hand-built copy (which tries WebNN first). It is the owner's
 * instruction above, it is what the measurement says, and on every browser that can run
 * this today WebNN is behind a flag so the two orders resolve identically anyway. When the
 * inference track migrates depth and pose onto this seam, this is the order they take.
 */
interface BackendOption {
  readonly value: string;
  readonly label: string;
}

function machineHasWebGpu(): boolean {
  return typeof navigator !== "undefined" && (navigator as { gpu?: unknown }).gpu !== undefined;
}

function machineHasWebNn(): boolean {
  return typeof navigator !== "undefined" && (navigator as { ml?: unknown }).ml !== undefined;
}

/**
 * The options THIS page can reach, probed rather than declared.
 *
 * A stored choice is always kept in the list even when it is unreachable — dropping it
 * would silently rewrite the document to something the author did not pick — and its label
 * says so rather than pretending.
 */
function backendOptions(
  stored: unknown,
  descriptor: Pick<ModelDescriptor, "cannotRun"> | undefined,
): readonly BackendOption[] {
  const options: BackendOption[] = [
    { value: "auto", label: "Automatic — GPU if this browser has it, then CPU" },
  ];
  const offer = (value: string, name: string, reachable: boolean): void => {
    if (!reachable && stored !== value) return;
    /* T1040 — a provider the BROWSER has but this MODEL cannot use is a third state, and
       it has to read differently from "your browser hasn't got one". It stays selectable
       (§V831, and a pin is a request we honour and let fail loudly) but it says so. */
    if (descriptor !== undefined && refusalFor(descriptor, value) !== undefined) {
      options.push({ value, label: `${name} — this model cannot run on it` });
      return;
    }
    options.push({ value, label: reachable ? name : `${name} — not available in this browser` });
  };
  offer("webgpu", "WebGPU", machineHasWebGpu());
  offer("webnn", "WebNN", machineHasWebNn());
  options.push({ value: "wasm", label: "CPU (WASM)" });
  return options;
}

/**
 * (4) The chooser. `stored` is the node's own bag, so an unreachable pin stays visible.
 * `descriptor` is the CHOSEN model, so a provider it cannot run on is named as such
 * rather than offered as if it would work (§T1040).
 */
export function inferenceBackendSchema(
  stored: Readonly<Record<string, unknown>>,
  descriptor?: Pick<ModelDescriptor, "cannotRun">,
): EnumParameter {
  return {
    type: "enum",
    label: "Backend",
    group: "Model",
    default: "auto",
    options: [...backendOptions(stored["backend"], descriptor)],
    description:
      "Which execution provider to ask onnxruntime for. The list is what this browser " +
      "reports it can reach, so it differs between machines. Automatic prefers the GPU — " +
      "measured 9.6x faster than the CPU for this model on the machine this default was " +
      "set on — and falls back to the CPU when the GPU provider will not start. Pinning " +
      "one means exactly that one, and a pinned provider that cannot start fails with a " +
      "reason rather than quietly running somewhere else. What it ACTUALLY ran on is " +
      "measured after the fact and shown on the node's info popup with the time it took — " +
      "this control is the request, that readout is the answer.",
  };
}

/**
 * The ladder a stored choice means, in the order the worker will try it.
 *
 * A PINNED choice is exactly one provider and no fallback: a picker whose selection is
 * silently overridden has removed the choice by hiding it. A pinned provider that cannot
 * start therefore FAILS, loudly, with the reason on the node — which is §V469, and is what
 * the user asked for by pinning.
 */
export function inferenceProvidersFor(
  stored: Readonly<Record<string, unknown>>,
  descriptor?: Pick<ModelDescriptor, "cannotRun">,
): readonly string[] {
  const choice = stored["backend"];
  if (typeof choice === "string" && choice !== "auto" && choice.length > 0) return [choice];
  const ladder: string[] = [];
  if (machineHasWebGpu()) ladder.push("webgpu");
  if (machineHasWebNn()) ladder.push("webnn");
  ladder.push("wasm");
  /*
   * T1040 — DROP A RUNG THE ARTEFACT IS MEASURED NOT TO RUN ON, and only from `auto`.
   *
   * The ladder walk reports the provider that CREATED a session, which is honest for
   * every model that fails at create. A model that creates and then throws on every run
   * would make `auto` report that provider — from a real session, not an echo — and never
   * produce a frame. Removing the rung is what a preference list is FOR; a PIN is a
   * different thing and is left alone above, to fail loudly with the runtime's own words,
   * because a picker whose selection is silently overridden has removed the choice by
   * hiding it.
   *
   * RVM was the case this was built for and is no longer an example of it: T1084 clears
   * the `ceil_mode` attribute its WebGPU session used to throw on, in memory, and its
   * `cannotRun` row is gone. No artefact carries one today. The mechanism stays because
   * the failure mode is a property of provider ladders rather than of that one model —
   * and its live twin is `WeightPatch.requiredFor`, which drops the same rung from inside
   * the worker when a patch cannot be applied on a particular machine.
   */
  if (descriptor === undefined) return ladder;
  return ladder.filter((provider) => refusalFor(descriptor, provider) === undefined);
}

/**
 * (5) §T978's recovery gesture, word for word in scope: resets the SESSION — worker,
 * provider ladder, published result, any run in flight — and never the cached weights.
 */
export function inferenceResetSchema(): ParameterSchema[string] {
  return {
    type: "pulse",
    label: "Reset",
    group: "Model",
    fires: "runtime.resetInference",
    input: { nodeIds: ["$node"] },
    description:
      "Restarts inference from a clean state: the worker thread, the model session, the " +
      "execution-provider ladder, the published result and any run in flight. The node " +
      "goes back to publishing its neutral output and computes a fresh first result. " +
      "THE DOWNLOADED MODEL IS KEPT — this never re-downloads, and never spends anything. " +
      "The thread is shared, so any other model node in the document restarts with it.",
  } as ParameterSchema[string];
}

/**
 * WHETHER THIS MODEL'S GRAPH WILL ACCEPT AN INPUT SIZE AT ALL (§T965(c)).
 *
 * Read from the recorded signature's trailing spatial axes: symbolic names ("height",
 * "width") mean the exporter left them free; literal digits mean the graph is pinned and
 * anything else is refused by the session. A model with no recorded signature is treated
 * as PINNED, which is the safe direction to be wrong in — it offers no knob rather than
 * one that fails at run time.
 *
 * §T965 wrote this rule inside `depth.ts`; the matte is the second node to need it, and
 * an Input Size that exists or does not is exactly the "computed from the weights" claim
 * §V827 makes, so it belongs on the seam rather than in two files. `depth.ts` delegates
 * here so the two cannot drift into different answers about the same signature table.
 */
export function inferenceAcceptsInputSize(modelId: string): boolean {
  const signature = signatureFor(modelId);
  if (signature === undefined) return false;
  const spatial = signature.input.shape.slice(-2);
  return spatial.length === 2 && spatial.every((axis) => !Number.isFinite(Number(axis)));
}

/**
 * The T974 letterbox preprocess, parameterised only by its buffer binding — the WGSL
 * every image-input model node shares, so the aspect rule cannot be re-derived wrong.
 * `occOf` in depth-runner.ts is this formula's float64 twin.
 *
 * ═══════════════════════════════════════════════════════════════════════════════════
 * T1091 — THIS WRITES LINEAR LIGHT, AND IT STAYS THAT WAY. MEASURED, NOT ASSUMED.
 * ═══════════════════════════════════════════════════════════════════════════════════
 *
 * The premise first, because it was a default nobody chose rather than a decision:
 * `media.ts` declares its source texture `rgba8unorm-srgb` and `color-space.ts` records
 * that an `-srgb` format IS the encoding, so the `textureLoad` below returns DECODED,
 * linear values and every image-input model in this app is fed linear light. These models
 * were trained on display-referred camera frames. Nobody had examined the mismatch.
 *
 * It is not a subtle one. The decode is exact and so is its size: a display-referred 0.5
 * arrives as ((0.5 + 0.055) / 1.055)^2.4 = 0.21404, which is 1.224 stops down, and a
 * display 0.25 arrives as 0.05088, which is 2.297 stops down. §V618's "~1.5 stops" is the
 * right order for a midtone and UNDERSTATES the shadows. So the question deserved a
 * measurement rather than a paragraph of reasoning either way.
 *
 * WHAT WAS MEASURED (2026-09-03 at `1d7af6a`, §V641; seven frames, all four matte models,
 * both feeds; ONNX under onnxruntime-web wasm, MediaPipe under system Chrome).
 * Four frames of real 720² footage from one room, plus a dark indoor portrait, a bright
 * outdoor frame with three partly occluded subjects, and a high-key beach frame — chosen
 * because one portrait is how this project has produced confident wrong answers before.
 * Each frame letterboxed by THIS shader's formula into two squares: `linear` (the feed
 * that ships) and `display` (the untouched source bytes, which ARE the display-referred
 * original, so the comparison needs no round trip through a curve and back). Coverage is
 * `matteCoverage`'s definition — the mean of the published alpha.
 *
 *   model            IoU(linear,display)  mean |Δα|        max |Δcoverage|
 *   MATTE_ACCURATE   0.899 – 0.997 †      0.0013 – 0.0164  0.0099
 *   MATTE_RVM        0.922 – 0.990        0.0016 – 0.0114  0.0038
 *   MediaPipe        0.864 – 0.991        0.0030 – 0.0133  0.0086
 *   MATTE_FAST       0.278 – 0.695 ‡      0.0164 – 0.1735  0.1674
 *
 *   † the two-kids frame is excluded from the first three rows and is quoted below; it is
 *     a frame all four models handle badly under EITHER feed.
 *   ‡ every frame, including the easy ones. Not one reached 0.70.
 *
 * SO THE ANSWER IS NOT "DISPLAY-REFERRED IS BETTER". Three of the four models barely
 * notice the transfer, which is a result about the MODELS: MODNet full precision was
 * already recorded flat across a 14x exposure range (§V857), and RVM and MediaPipe join it
 * here. The one model that is transformed is the QUANTIZED build, and §V857 already says
 * why in terms that have nothing to do with a transfer function — a quantized model has a
 * NARROWER VALID INPUT DOMAIN, MATTE_FAST collapses below about 0.2 mean input, and the
 * linear feed measures 0.10 – 0.56 mean on these frames while the display feed measures
 * 0.26 – 0.73. What rescues it is BRIGHTNESS, not the curve's shape, and any lift would do.
 *
 * AND THE ENCODE HAS ITS OWN COST, ON THE DEFAULT MODEL. On all four clip frames the
 * display feed makes MATTE_ACCURATE claim a salmon-coloured armchair cushion as a person
 * (+0.0099 coverage, the whole of that row's max). That was READ OFF THE PICTURE, not
 * inferred from the delta — the disagreeing texels were drawn back onto the frame, and
 * they land on one object. RVM and MediaPipe differ from themselves on the same frames by
 * a few edge texels and nothing else. (The sweep harness was scratch and is not committed;
 * what survives it is this table and the guard below.)
 *
 * ONE MORE THING THE SWEEP TURNED UP, UNASKED, AND IT POINTS THE SAME WAY. MediaPipe's
 * rung quantises this buffer to 8 bit on the way to its canvas (`matteTexelsToRgba`), and
 * on linear values that is not free: the linear feed occupies 183 of the 256 code levels
 * against the display feed's 256, and crushes 2.0 – 5.3% of channel samples to zero on the
 * indoor frames. It costs that model nothing measurable — IoU 0.864 – 0.991 all the same,
 * which is a further reading on how little these networks care what we hand them.
 *
 * The one instrument that does not privilege a model — how much the four AGREE WITH EACH
 * OTHER inside each feed, mean pairwise IoU over the six pairs — says display 0.781 against
 * linear 0.604, up on all seven frames. But that aggregate is MATTE_FAST's collapse
 * showing through: over the other three the same number is 0.874 against 0.849, and it
 * moves the WRONG WAY on three of the four realistic clip frames (−0.026, −0.033, −0.039;
 * the fourth is +0.006) while helping on the two hard ones (two-kids +0.175, beach +0.083).
 *
 * ⚑ RULING: NO TRANSFER IS APPLIED HERE, and it is now a measured choice rather than a
 * silence. Three reasons, in the order they carry weight:
 *
 *   1. It is not materially better. Six of seven frames, three of four models, IoU ≥ 0.86
 *      and mean |Δα| ≤ 0.017 — and on the most representative footage it costs the DEFAULT
 *      model a false positive it does not currently have.
 *   2. The model it does move is moved by LEVEL, not by transfer (§V857). Putting a
 *      colour-management step in the feed to correct a quantization domain would be a fix
 *      whose stated justification does not survive its own model being replaced — and it
 *      does not even work: MATTE_FAST under the display feed is still holed and fragmented
 *      on the clip frames, merely less so.
 *   3. This is the seam DEPTH, POSE and PERSON-MASK share. Encoding here changes four node
 *      types on evidence gathered from one; encoding in the matte packers alone makes the
 *      matte path treat a picture differently from the depth path, which is §T1088's
 *      "input treatment depends on which thing is selected" hazard one level up.
 *
 * WHAT THIS DOES NOT SAY. It does not say MATTE_FAST is fine — it is feed-broken and the
 * node's own copy and `model-catalogue.ts` both name that, which is the mitigation on
 * record. It does not clear depth or pose, which were not measured. And it leaves a real
 * option unbuilt rather than unnamed: a level normalisation derived from the frame, which
 * would address §V857's domain directly and is a different change from this one.
 *
 * `matte-feed.test.ts` is the guard: every matte model's packing must stay the same
 * function of this buffer up to its own documented affine normalisation, so a transfer
 * added for one of them fails there instead of shipping.
 */
export function letterboxPreprocessWgsl(): string {
  return `struct PreprocessParams { side: f32 };

@group(0) @binding(0) var<uniform> params: PreprocessParams;
@group(0) @binding(1) var sourceTexture: texture_2d<f32>;
@group(0) @binding(2) var<storage, read_write> modelInput: array<vec4f>;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let side = u32(params.side);
  if (gid.x >= side || gid.y >= side) { return; }
  let dims = vec2i(textureDimensions(sourceTexture, 0));
  let uv = (vec2f(f32(gid.x), f32(gid.y)) + 0.5) / params.side;
  /* T974 — LETTERBOX, not squeeze: uniform scale, centred, edges replicated. The model
     sees real perspective and the read-back samples only the occupied band. */
  let dimsF = vec2f(dims);
  let aspect = dimsF.x / max(dimsF.y, 1.0);
  let occ = select(vec2f(aspect, 1.0), vec2f(1.0, 1.0 / aspect), aspect >= 1.0);
  let sourceUv = (uv - vec2f(0.5)) / occ + vec2f(0.5);
  let texel = clamp(vec2i(sourceUv * dimsF), vec2i(0), dims - vec2i(1));
  modelInput[gid.y * side + gid.x] = textureLoad(sourceTexture, texel, 0);
}`;
}
