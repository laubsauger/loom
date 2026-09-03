import type { CompiledNodeDescription, NodeDefinition } from "../../domain/types/node-definition.ts";
import type { ParameterSchema } from "../../domain/types/parameters.ts";
import type { DispatchPassDescriptor, EffectPassDescriptor } from "../../runtime/backend/plan.ts";
import { inferenceSourceIdFor } from "../../runtime/execution/inference-sources.ts";
import { scratchResourceId } from "../../compiler/resources.ts";
import type { ModelDescriptor } from "../../runtime/models/model-acquisition.ts";
import { DEPTH_ACCURATE, DEPTH_LIVE, DEPTH_MODELS, measuredOn } from "../../runtime/models/model-catalogue.ts";
import { signatureFor } from "../../runtime/models/model-signatures.ts";
import {
  inferenceAcceptsInputSize,
  inferenceModelSchema,
  inferenceResetSchema,
  letterboxPreprocessWgsl,
} from "./inference-node.ts";
import { RGBA_TEXTURE } from "./common-ports.ts";
import { readCompileInputs } from "./compile-context.ts";

/**
 * Depth — a monocular depth map, inferred (T385, T715, §V585, §V586).
 *
 * ## It is analyze's input half and webcam's output half, in one node
 *
 * `compileGraph` is synchronous and pure, so nothing here awaits. The GPU work is two
 * ordinary passes and the model runs outside the plan entirely:
 *
 *   IN   `depth:preprocess` resamples the source into an ordinary scratch BUFFER at the
 *        model's input size. `createInferenceSources` reads it with `backend.readBuffer`
 *        between frames — analyze's §V48 route, just bigger.
 *   OUT  the result arrives as an `external` texture through the media registry, blitted
 *        to the output port — webcam's route exactly.
 *
 * No new resource kind and no new GPU→CPU route, which is §V585's whole claim.
 *
 * ## What it publishes before the model exists, and why that is the point
 *
 * A 94 MB model is not downloaded because a node was placed, so a fresh Depth node has no
 * result and renders its IDENTITY FALLBACK: flat mid-grey. That is not a placeholder
 * colour picked to look neutral — `displace` defines 0.5 as "no displacement" already
 * (`filters.ts:173`), so a Depth feeding a Displace on a machine with no model composes
 * to a no-op and the document renders as though the node were not there.
 *
 * That is the owner's constraint made structural: an unavailable model degrades the RATE,
 * never the CONTRACT. The node always exists, always publishes RGBA, and a document using
 * it opens anywhere. What it must never be is SILENT about it — the acquisition state is
 * a problems-pane row and the staleness is on the telemetry channel, because one is a
 * persistent decision and the other changes every frame.
 *
 * ## Not a sink
 *
 * §V585: unlike Analyze, this has a real texture output, so ordinary pruning applies. An
 * unwired Depth node compiles to no passes, declares no resources and downloads nothing.
 */

/**
 * Depth Anything V2 is a ViT with a patch size of 14, and 518 = 37 x 14 is the size it
 * was exported at — the DEFAULT, and the fallback wherever a node has no stored choice.
 *
 * T965 corrects the note that used to sit here ("not a tunable"). It is one, and the
 * evidence is in the shipped weights rather than in an opinion: `MODEL_SIGNATURES` — read
 * out of the real `.onnx` by `extract-model-signatures.ts`, never typed — records the
 * input shape as `["batch_size", "3", "height", "width"]`. Height and width are SYMBOLIC,
 * so the graph accepts any input the patch grid divides. MoveNet's row in the same table
 * reads `["batch_size", "192", "192", "4"]`, literal, and a node on a model like that must
 * not offer the knob at all. `parametersFor` reads that difference rather than assuming
 * either answer, which is the whole of §T965(c): the schema is computed from the model.
 */
export const DEPTH_INPUT_SIDE = 518;
export const DEPTH_INPUT_KEY = "modelInput";
export const DEPTH_RESULT_KEY = "modelResult";

/** Depth Anything V2's ViT patch size. Every legal input side is a multiple of it. */
const PATCH = 14;

/**
 * The sides offered, all multiples of the patch size, bracketing the export size.
 *
 * Not a free number field: 500 is not a legal input and a text box invites one. The work
 * scales with the SQUARE of this, which is the fact the labels carry.
 */
const INPUT_SIDES = [19 * PATCH, 28 * PATCH, DEPTH_INPUT_SIDE, 46 * PATCH] as const;

/**
 * THE SHIPPED DEFAULT, and it is NOT the export size (T976, owner).
 *
 * 266 is 19 patches — **four times fewer pixels than 518** — and it is the right default
 * for the case a Depth node is usually in: a live webcam, where a result that arrives is
 * worth more than a result that is better. 518 stays exactly one click away and stays
 * right for a still. The trade is visible at the moment of choosing rather than buried
 * here, because every option prints its own measured cost.
 *
 * `DEPTH_INPUT_SIDE` remains 518 and remains the EXPORT size: it is what the graph was
 * traced at, what the signature table records, and the fallback whenever a stored side is
 * one this model would refuse. Two constants because they answer two questions.
 */
const DEPTH_DEFAULT_INPUT_SIDE = 19 * PATCH;

/**
 * ═══════════════════════════════════════════════════════════════════════════════════
 * WHAT THIS NODE KNOWS ABOUT EACH MODEL (§T965(b), §T965(c))
 * ═══════════════════════════════════════════════════════════════════════════════════
 *
 * The stored value is `accurate` | `fast` and always will be — shipped documents hold
 * those strings, so they are PARSED FOREVER (§V813). What changes is that they stop being
 * the LABEL: the owner's complaint was that `fast` / `accurate` hides both which model it
 * is and what it costs, and a 94 MB download has to say 94 MB at the moment of choosing,
 * not in a notice afterwards. So the label is composed from the catalogue's own
 * `descriptor.label` and `descriptor.bytes` and cannot drift from what is downloaded.
 *
 * `cpuMillisAt518` is the MEASURED per-run cost recorded in `model-catalogue.ts` (§T753,
 * 2026-09-01, CPU path). It is here because it is the number the resolution and rate-limit
 * controls are choices ABOUT — and because it is the fact that makes `fast` honest: the
 * 4-bit variant is 1.44x SLOWER, not faster, and a parameter surface that let someone pick
 * it for speed would be repeating the mistake its own docblock records.
 */
interface DepthModelChoice {
  /** The stored enum value. */
  readonly value: string;
  readonly descriptor: ModelDescriptor;
  /** Measured on the CPU path at 518x518, ms (§T753). */
  readonly cpuMillisAt518: number;
}

const DEPTH_MODEL_CHOICES: readonly DepthModelChoice[] = [
  { value: "accurate", descriptor: DEPTH_ACCURATE, cpuMillisAt518: 2670 },
  { value: "fast", descriptor: DEPTH_LIVE, cpuMillisAt518: 3833 },
];

const DEFAULT_CHOICE: DepthModelChoice = DEPTH_MODEL_CHOICES[0] as DepthModelChoice;

/**
 * The model a node's stored parameters select, in EITHER spelling.
 *
 * `accurate`/`fast` are what every loom written before §V827's chooser holds; the model
 * id is what a new choice writes. Both resolve here and always will (§V813).
 *
 * ⚠ This read matched only the legacy value for one commit of the migration, which meant
 * a NEW choice of the 4-bit variant resolved to the 94 MB one — the chooser stored an id
 * nothing could read back, so picking the cheap model downloaded the expensive one. The
 * options list and the parser are two halves of one contract and both have to move.
 *
 * Unknown or absent resolves to the default.
 */
export function depthModelChoiceFor(stored: Readonly<Record<string, unknown>>): DepthModelChoice {
  const raw = stored["model"];
  return (
    DEPTH_MODEL_CHOICES.find(
      (choice) => choice.value === raw || choice.descriptor.id === raw,
    ) ?? DEFAULT_CHOICE
  );
}

/**
 * Seconds a run of this model measured at 518, as a sentence fragment.
 *
 * §V899/§T1095 — THE MACHINE TRAVELS WITH THE NUMBER. This fragment is the only place
 * depth's copy states a cost, and it reaches three parameter descriptions, so naming the
 * measuring machine here is what stops all three of them reading as a claim about every
 * machine. `inference-node.test.ts` gates it.
 */
function measuredCost(choice: DepthModelChoice): string {
  return `${(choice.cpuMillisAt518 / 1000).toFixed(1)} s per run on the CPU path at ${DEPTH_INPUT_SIDE} px, ${measuredOn("2026-09-01")}`;
}

/**
 * Whether this model's graph will accept an input size at all.
 *
 * Read from the recorded signature's trailing spatial axes: symbolic names ("height",
 * "width") mean the exporter left them free; literal digits mean the graph is pinned and
 * anything else is refused by the session. A model with no recorded signature is treated
 * as pinned, which is the safe direction to be wrong in — it offers no knob rather than
 * offering one that fails at run time.
 */
function acceptsInputSize(modelId: string): boolean {
  /* The rule itself moved to the §V827 seam when the matte became its second reader —
     two copies of "is this graph symbolic" is two places for the same signature table to
     be answered differently. The reasoning stays above; the implementation is shared. */
  return inferenceAcceptsInputSize(modelId);
}

/**
 * The side a PINNED model declares, or `undefined` when it leaves the size free.
 *
 * The other half of `acceptsInputSize`, and the reason it is not the same function
 * inverted: a model with a fixed graph does not fall back to OUR default, it falls back to
 * ITS OWN — feeding 266 to a graph that declares 192 is refused by the session, and the
 * degrade rule says an unavailable choice degrades the rate, never the contract.
 */
function pinnedInputSide(modelId: string): number | undefined {
  const signature = signatureFor(modelId);
  if (signature === undefined) return undefined;
  const spatial = signature.input.shape.slice(-2);
  const height = Number(spatial[0]);
  return Number.isFinite(height) && height > 0 ? height : undefined;
}

/**
 * WHERE INFERENCE CAN RUN, MEASURED ON THIS MACHINE (§T960's dynamic enum, §T715).
 *
 * The owner asked to see and pick the backend. Two rules bind the wording, and both are
 * easy to break by accident:
 *
 *  - REPORT WHAT IT GOT, NEVER WHAT IT ASKED FOR. This list is the REQUEST — it is a
 *    parameter, so it can only ever be a request. What actually ran is measured in the
 *    worker (`inference-worker-core.ts` walks the ladder one provider at a time) and shown
 *    on the node's runtime channel beside its result age. The two must not be confused:
 *    a readout that echoed this control would confidently print "WebGPU" while the CPU
 *    did the work, which is exactly the state §B171 produced.
 *  - NAME THE API, NEVER THE CHIP. `Neural Engine`, `ANE`, `NPU`, `hardware-accelerated`
 *    and "the browser chose the device" are banned from every surface (§T715): the WebNN
 *    specification deliberately defines no device enumeration and no way to observe which
 *    device was chosen, so any of those words would be a claim we cannot check.
 *
 * The options are what THIS page can reach, probed rather than declared: `navigator.gpu`
 * for the WebGPU execution provider, `navigator.ml` for WebNN. A stored choice is always
 * kept in the list even when it is unreachable — dropping it would silently rewrite the
 * document to something the author did not pick — and says so in its own label.
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

function backendOptions(stored: unknown): readonly BackendOption[] {
  const options: BackendOption[] = [
    { value: "auto", label: "Automatic — best available, then CPU" },
  ];
  const offer = (value: string, name: string, reachable: boolean): void => {
    if (!reachable && stored !== value) return;
    options.push({ value, label: reachable ? name : `${name} — not available in this browser` });
  };
  offer("webnn", "WebNN", machineHasWebNn());
  offer("webgpu", "WebGPU", machineHasWebGpu());
  options.push({ value: "wasm", label: "CPU (WASM)" });
  return options;
}

/**
 * The ladder a stored backend choice means, in the order the worker will try it.
 *
 * `auto` is the §T715 ladder narrowed to what this machine reports. A PINNED choice is
 * exactly one provider and no fallback: a picker whose selection is silently overridden
 * has removed the choice by hiding it, which is the failure `DEPTH_PROVIDERS`' own
 * docblock exists to prevent. A pinned provider that cannot start therefore FAILS, loudly,
 * with the reason on the node — which is §V469 and is what the user asked for by pinning.
 */
export function depthProvidersFor(stored: Readonly<Record<string, unknown>>): readonly string[] {
  const choice = stored["backend"];
  if (typeof choice === "string" && choice !== "auto" && choice.length > 0) return [choice];
  const ladder: string[] = [];
  if (machineHasWebNn()) ladder.push("webnn");
  if (machineHasWebGpu()) ladder.push("webgpu");
  ladder.push("wasm");
  return ladder;
}

/** How this node wants to be RUN — everything the app's inference seam reads off it. */
export interface DepthNodeSettings {
  readonly modelId: string;
  /** The side the preprocess resamples to and the model is fed at. */
  readonly inputSide: number;
  /** Execution providers to try, in order. */
  readonly providers: readonly string[];
  /** Shortest gap between two runs, in TIMELINE seconds. 0 is no cap (§T384). */
  readonly minIntervalSeconds: number;
  /** Stop after the first result and keep publishing it (§T384's freshness policy). */
  readonly hold: boolean;
}

function storedNumber(stored: Readonly<Record<string, unknown>>, key: string): number | undefined {
  const raw = stored[key];
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "string" && raw.trim() !== "" && Number.isFinite(Number(raw))) return Number(raw);
  return undefined;
}

/**
 * The node's stored parameters, read as run settings — the ONE place defaults live.
 *
 * The app's inference seam reads a node's RAW stored bag (a parameter may be driven, and
 * the seam is outside the resolver), so a second copy of "what does absent mean" out there
 * would be a second answer. Every default below is the one the schema declares.
 */
export function depthSettingsFor(stored: Readonly<Record<string, unknown>>): DepthNodeSettings {
  const choice = depthModelChoiceFor(stored);
  const requested = storedNumber(stored, "inputSide");
  const legal =
    acceptsInputSize(choice.descriptor.id) &&
    requested !== undefined &&
    INPUT_SIDES.includes(requested as (typeof INPUT_SIDES)[number]);
  const rateLimit = storedNumber(stored, "rateLimit") ?? 0;
  // A pinned graph gets ITS OWN declared side; a free one gets the stored choice when the
  // model would accept it, and the shipped default when it would not.
  const fallback = pinnedInputSide(choice.descriptor.id) ?? DEPTH_DEFAULT_INPUT_SIDE;
  return {
    modelId: choice.descriptor.id,
    inputSide: legal && requested !== undefined ? requested : fallback,
    providers: depthProvidersFor(stored),
    minIntervalSeconds: rateLimit > 0 ? 1 / rateLimit : 0,
    hold: stored["refresh"] === "held",
  };
}

/**
 * THE NODE'S SCHEMA, COMPUTED FROM ITS CHOSEN MODEL (§T965(c), §T960).
 *
 * Third adopter of `NodeDefinition.parametersFor(stored)` after `customWgsl` (§T880) and
 * the point kernels (§T900), and the first one where the state read is not a shader but a
 * MODEL. §T960 ruled why it has to be this and not a Depth pane in the inspector: a device
 * whose UI is a hard-coded pane is a device that cannot be a plugin, and N devices become N
 * app-level edits nobody can remove. So the node's parameters are the whole interface.
 *
 * WHAT ACTUALLY VARIES WITH THE MODEL, and it is not decoration:
 *
 *  - `inputSide` EXISTS OR DOES NOT. Present when the chosen model's recorded signature
 *    leaves height and width symbolic, absent when the graph pins them. That is a
 *    structural difference read from the weights, not a union of every model's knobs
 *    behind `inactiveWhen` — which §T965 rules out by name.
 *  - Its cost sentence and the rate limit's are the CHOSEN model's own measurement, so
 *    picking the 4-bit variant changes what the resolution control tells you it costs
 *    (3.8 s per run against 2.7 s) rather than leaving a number that belongs to the other
 *    model standing under it.
 *  - `model`'s own description names the chosen descriptor's size and licence.
 */
/**
 * §V813 — PARSE FOREVER, EMIT NEVER, and the migration is where it bites.
 *
 * The seam's chooser stores a MODEL ID; every loom shipped before it stores `accurate` or
 * `fast` — E44 Sounding and E47 Hologram both hold `"model": "accurate"` on disk right
 * now. Those strings stay legal for good, and a document holding one is never rewritten:
 * a save emits what was stored. Only a NEW choice writes an id.
 *
 * ⚠ THEY ARE KEPT IN `options`, NOT MERELY PARSED, and that is the load-bearing half. An
 * enum whose stored value is absent from its own option list resolves to the DEFAULT, so
 * a document that had chosen the 4-bit variant would silently switch to the 94 MB one the
 * moment it was opened — a download the author never asked for, from a migration that
 * looked complete.
 */
const LEGACY_MODEL_VALUES: ReadonlyArray<{ value: string; choice: DepthModelChoice }> =
  DEPTH_MODEL_CHOICES.map((choice) => ({ value: choice.value, choice }));

function modelParameter(
  choice: DepthModelChoice,
  stored: Readonly<Record<string, unknown>>,
): ParameterSchema[string] {
  const base = inferenceModelSchema(DEPTH_MODELS, {
    what:
      `Which weights to use — currently ${choice.descriptor.label}, ${measuredCost(choice)}. ` +
      `Both produce a depth map and differ in download size and detail. The 4-bit variant ` +
      `is a fifth of the bytes and is NOT faster: unpacking 4-bit weights costs more than ` +
      `the memory it saves, so pick it to save the download, never to save time.`,
  });
  /*
   * The legacy row is offered ONLY to the document that is standing on it, and it wears
   * the SAME label as its modern twin plus a marker.
   *
   * Two mistakes were live in the built app before this: the list showed four rows where
   * there are two models, and the legacy pair carried `formatBytes` (94 MB) against the
   * seam's `megabytes` (94.5 MB) — so one model appeared twice at two different sizes,
   * which reads as two different downloads. A migration shim must be INVISIBLE to everyone
   * it is not migrating; §V827's dynamic-enum shape (the backend picker keeps an
   * unreachable option only while it is the stored one) is the same answer.
   */
  const legacy = LEGACY_MODEL_VALUES.filter((entry) => entry.value === stored["model"]).map(
    (entry) => {
      const twin = base.options.find((option) => option.value === entry.choice.descriptor.id);
      return { value: entry.value, label: `${twin?.label ?? entry.choice.descriptor.label} — as saved` };
    },
  );
  return { ...base, group: "Model", options: [...base.options, ...legacy] };
}

function depthParameters(stored: Readonly<Record<string, unknown>>): ParameterSchema {
  const choice = depthModelChoiceFor(stored);
  const schema: Record<string, ParameterSchema[string]> = {
    /*
     * §V827's OBLIGATION (1), now SHARED rather than hand-built (T957's seam).
     *
     * This node built the chooser by hand in §T965 and the matte repeated the shape; the
     * seam is where the third instance turned it into one function. What it adds that the
     * hand-built version did not have is the LICENCE, and it belongs beside the size for
     * the same reason the size does: a 94 MB artefact under an unstated licence is a
     * decision made with half the information.
     *
     * The per-model sentence stays this node's — the seam takes `what`, composed from the
     * CHOSEN model's own measurement, so §T753's "smaller is 1.44x SLOWER" is stated
     * exactly where someone is about to pick the smaller one.
     */
    model: modelParameter(choice, stored),
    backend: {
      type: "enum",
      label: "Backend",
      group: "Model",
      default: "auto",
      options: backendOptions(stored["backend"]),
      description:
        "Which execution provider to ask onnxruntime for. The list is what this browser " +
        "reports it can reach, so it differs between machines. Automatic tries the best " +
        "available and falls back to the CPU; pinning one means exactly that one, and a " +
        "pinned provider that cannot start fails with a reason rather than quietly running " +
        "somewhere else. What it ACTUALLY ran on is measured after the fact and shown on " +
        "the node's info popup with the time it took — this control is the request, that " +
        "readout is the answer.",
    },
  };

  if (acceptsInputSize(choice.descriptor.id)) {
    schema["inputSide"] = {
      type: "enum",
      label: "Input Size",
      group: "Model",
      // Structural: the preprocess buffer and its dispatch are sized from this, so it is a
      // REBUILD rather than a uniform write (§V5).
      compileTime: true,
      default: String(DEPTH_DEFAULT_INPUT_SIDE),
      options: INPUT_SIDES.map((side) => ({
        value: String(side),
        label:
          side === DEPTH_INPUT_SIDE
            ? `${side} px — the size it was exported at`
            : `${side} px — ${((side / DEPTH_INPUT_SIDE) ** 2).toFixed(2)}x the work`,
      })),
      description:
        `The square the picture is resampled to before the model sees it. Every option is a ` +
        `multiple of the ${PATCH}-pixel patch this network is built on, because anything else ` +
        `is refused by the graph. ${choice.descriptor.label} measured ${measuredCost(choice)}, ` +
        `and the cost scales with the SQUARE of this — halving it is roughly a quarter of the ` +
        `work. The OUTPUT is unaffected: the depth map is always resampled back up to the ` +
        `input image's own resolution.`,
    };
  }

  /*
   * §V827's OBLIGATION (5), now SHARED (T957's seam).
   *
   * §T978 built this pulse here, word for word, and the matte copied the words. Two
   * copies of a SCOPE STATEMENT is the thing to be afraid of: the sentence that matters
   * is "THE DOWNLOADED MODEL IS KEPT", and a second copy is a place for it to drift into
   * saying something else. One function, one promise.
   *
   * The case it recovers is not hypothetical — §B171's own arc produced one: a failed
   * session load stayed cached as a rejected promise, so no retry could ever succeed.
   * That instance is fixed; a download, a worker, a session and a provider ladder are
   * four things that can wedge, and "reload the tab" recovers none of them.
   */
  schema["reset"] = inferenceResetSchema();

  schema["refresh"] = {
    type: "enum",
    label: "Refresh",
    group: "Freshness",
    default: "continuous",
    options: [
      { value: "continuous", label: "Keep up — re-run as results land" },
      { value: "held", label: "Hold — compute one result, then freeze" },
    ],
    description:
      "§T384: inference arrives late and at its own rate, so what the node publishes " +
      "BETWEEN results is a decision rather than an accident. Keep up re-runs whenever the " +
      "previous run finishes. Hold computes one map and then keeps publishing it — right " +
      "for a still, and for stopping a multi-second model from occupying a core forever. " +
      "Either way the node's info popup reports how many frames behind the published map " +
      "is, so a stale one is visible rather than silent.",
  };

  schema["rateLimit"] = {
    type: "number",
    label: "Rate Limit",
    group: "Freshness",
    default: 0,
    min: 0,
    max: 10,
    step: 0.1,
    // Above the slider's travel is legal — a fast model on a fast backend may genuinely
    // want more than 10 — and below zero is not a rate (§B111).
    range: "floor",
    unit: "hz",
    description:
      `The most runs per second this node will start. 0 is no cap. A run is never started ` +
      `while one is in flight, so this can only ever make it slower — it is there to stop a ` +
      `multi-second model from re-running the instant it finishes and pinning a core. ` +
      `${choice.descriptor.label} measured ${measuredCost(choice)}, which is about ` +
      `${(1000 / choice.cpuMillisAt518).toFixed(2)} runs per second, so a cap above that ` +
      `changes nothing. Measured on the TIMELINE clock, and applied to live playback only: ` +
      `an offline render computes a result for every frame so a take reproduces (§V586).`,
  };

  schema["nearIsBright"] = {
    type: "boolean",
    label: "Near Is Bright",
    group: "Output",
    default: true,
    description:
      "Depth Anything emits INVERSE relative depth, so close is a high value and the map " +
      "reads near-bright by default. Turn this off to publish far-bright instead, which is " +
      "what a fog or a depth-of-field mask usually wants.",
  };

  schema["outputRange"] = {
    type: "vector",
    size: 2,
    label: "Output Range",
    group: "Output",
    default: [0, 1],
    min: 0,
    max: 1,
    range: "bounded",
    description:
      "The low and high value the normalised map is stretched into before it leaves the " +
      "node. Displace reads 0.5 as no displacement, so [0.4, 0.6] is a gentler relief " +
      "without touching Displace's own amount, and [1, 0] is another way to flip it. The " +
      "map is normalised across each frame's own range first — Depth Anything's scale is " +
      "relative and differs per image, so brightness is not comparable between frames.",
  };

  return schema;
}

/**
 * The preprocess, from §V827's seam (T957).
 *
 * This node's own letterbox WGSL was the ORIGINAL — §T974 wrote it here and `occOf` in
 * `depth-runner.ts` is its float64 twin. It moved to the seam when the matte needed the
 * same square, and the reason to take the shared copy rather than keep a local one is the
 * pairing: the aspect rule is stated in two languages that must agree, and a third copy
 * in WGSL is a third chance for them to disagree silently. A squeezed frame degrades a
 * monocular estimator plausibly, which is the failure no pixel gate catches.
 */
const DEPTH_PREPROCESS_WGSL = letterboxPreprocessWgsl();

/* T965: the ENCODING half of the node's parameters lives here rather than in the worker,
   and that placement is the point. Flipping near/far or narrowing the published range is a
   UNIFORM WRITE on a pass that is already running (§V5) — done in the encoder it would mean
   a protocol field, a re-run of a multi-second model to see a change, and a knob whose
   effect arrives seconds after the drag. The model's numbers are untouched; only how they
   are published changes. */
const DEPTH_BLIT_WGSL = `struct DepthOutput { invert: f32, low: f32, high: f32 };

@group(0) @binding(0) var<uniform> params: DepthOutput;
@group(0) @binding(1) var depthTexture: texture_2d<f32>;

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let dims = vec2f(textureDimensions(depthTexture, 0));
  let texel = vec2i(clamp(uv, vec2f(0.0), vec2f(1.0)) * (dims - vec2f(1.0)));
  let raw = textureLoad(depthTexture, texel, 0).r;
  let oriented = mix(raw, 1.0 - raw, params.invert);
  let value = mix(params.low, params.high, oriented);
  return vec4f(value, value, value, 1.0);
}`;

/** Booleans reach a uniform block as 0/1 floats; the shader `mix`es on them. */
function flag(value: unknown, fallback: boolean): number {
  return (typeof value === "boolean" ? value : fallback) ? 1 : 0;
}

/** The stored output range, or the identity. A malformed pair falls back rather than throws. */
function outputRangeOf(stored: Readonly<Record<string, unknown>>): readonly [number, number] {
  const raw = stored["outputRange"];
  if (!Array.isArray(raw) || raw.length < 2) return [0, 1];
  const low = Number(raw[0]);
  const high = Number(raw[1]);
  return [Number.isFinite(low) ? low : 0, Number.isFinite(high) ? high : 1];
}

export const depthNode: NodeDefinition = {
  type: "depth",
  version: 1,
  title: "Depth",
  category: "filter",
  description:
    "Estimates a depth map from an image — near is bright, far is dark — using Depth Anything V2 running in the browser. The model is downloaded once per machine on first use, with your consent and a progress readout, and is never bundled. Until it is available the node publishes flat mid-grey, which Displace reads as no displacement, so a document using Depth opens and renders on a machine that cannot run it. Results arrive at the model's own rate rather than once per frame: live playback shows the most recent one and reports its age, while an offline render waits for each frame so a take reproduces.",
  tags: ["depth", "ml", "inference", "3d", "displace"],
  inputs: [{ id: "input", label: "Input", type: RGBA_TEXTURE }],
  outputs: [{ id: "out", label: "Out", type: RGBA_TEXTURE }],
  /**
   * The STATIC fallback (§T880's rule): what the palette, a help page and a fresh drop
   * see. Built from the DEFAULT model by the very function `parametersFor` uses, so the
   * two cannot drift and every key a fresh node stores has a home in both.
   */
  parameters: depthParameters({}),
  /**
   * PER-INSTANCE schema, computed from the chosen model (§T965(c), §T960). See
   * `depthParameters` for what varies and why it is read from the weights rather than
   * declared.
   */
  parametersFor(stored) {
    return depthParameters(stored);
  },
  /**
   * The OUTPUT follows the input's shape, not the model's. The model works at its own
   * square whatever the picture is; the depth map is then sampled back up to the source's
   * resolution, so a Depth in a chain behaves like every other filter and a downstream
   * Displace lines up with the image it is displacing.
   */
  resolutionPolicy: { kind: "inherit", input: "input" },
  compile(context): CompiledNodeDescription {
    const { nodeId, inputs, outputs, parameters } = readCompileInputs(context);
    const source = inputs["input"];
    const target = outputs["out"];
    // No input or nothing consuming the output: compile to nothing. §V585 — an unwired
    // model node costs zero and, crucially, downloads nothing.
    if (source === undefined || target === undefined) return { passes: [] };

    // Resolved through `parametersFor`, so a node on a model with a pinned input shape
    // resolves to the export size here whatever is stored (§T965's degrade rule).
    const { inputSide } = depthSettingsFor(parameters);
    const workgroups = Math.ceil(inputSide / 8);
    const [low, high] = outputRangeOf(parameters);

    const preprocess: DispatchPassDescriptor = {
      kind: "dispatch",
      id: `${nodeId}:preprocess`,
      shader: DEPTH_PREPROCESS_WGSL,
      entryPoint: "main",
      workgroups: [workgroups, workgroups, 1],
      buffers: [{ binding: "modelInput", resourceId: scratchResourceId(nodeId, DEPTH_INPUT_KEY) }],
      textures: [{ binding: "sourceTexture", resourceId: source.resource, sampled: "unfiltered" }],
      uniforms: { side: inputSide },
      uniformBinding: "params",
      nodeId,
    };

    const blit: EffectPassDescriptor = {
      kind: "effect",
      id: `${nodeId}:result`,
      shader: DEPTH_BLIT_WGSL,
      target,
      textures: [{ binding: "depthTexture", resourceId: scratchResourceId(nodeId, DEPTH_RESULT_KEY), sampled: "unfiltered" }],
      // The model emits near-bright already, so "Near Is Bright" ON is NO inversion.
      uniforms: { invert: 1 - flag(parameters["nearIsBright"], true), low, high },
      uniformBinding: "params",
      nodeId,
    };

    return {
      passes: [preprocess, blit],
      scratch: [
        {
          key: DEPTH_INPUT_KEY,
          kind: "buffer",
          stride: 16,
          capacity: inputSide * inputSide,
        },
        {
          key: DEPTH_RESULT_KEY,
          kind: "external",
          sourceId: inferenceSourceIdFor(nodeId),
          // Linear, NOT srgb: a depth map is a measurement, not a picture (§V56's
          // family). T959: and FLOAT, not bytes — the model emits float32, and an 8-bit
          // result texture quantised every consumer to 256 depth levels (visible
          // terracing on T958's metric unprojection). Single channel is the truth of a
          // depth map; readers that luma-weight a colour map read .r when g+b are zero.
          format: "r32float",
        },
      ],
    };
  },
};
