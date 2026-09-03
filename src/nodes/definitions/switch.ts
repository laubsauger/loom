import type { NodeDefinition, CompiledNodeDescription } from "../../domain/types/node-definition.ts";
import type { ParameterSchema } from "../../domain/types/parameters.ts";
import type { EffectPassDescriptor } from "../../runtime/backend/plan.ts";
import { MAX_TEXTURE_INPUTS, RGBA_TEXTURE } from "./common-ports.ts";
import { missingCompileResource, readCompileInputs } from "./compile-context.ts";
import { readFlag, readNumber } from "./parameter-readers.ts";
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

/** The two inputs a fractional index sits between, and how far across it is (T1054). */
export interface SwitchBlend {
  /** `floor(raw)`, wrapped — the input a hard select would show. */
  readonly index: number;
  /** The one after it, wrapped, so the LAST input's neighbour is the FIRST. */
  readonly next: number;
  /** `raw - floor(raw)`, in [0, 1). 0 means "sitting exactly on `index`". */
  readonly fraction: number;
}

/**
 * Where a fractional index sits, for CROSSFADE (T1054).
 *
 * `index` is `resolveSwitchIndex`'s answer, unchanged and reused rather than recomputed —
 * crossfade must never disagree with a hard select about which input `2.0` is.
 *
 * THE SEAM IS THE WHOLE POINT. `next` wraps, so the last input's neighbour is the first
 * one, and a ramp running off the end fades LAST→FIRST instead of stopping or jumping.
 * That falls out of the node's existing wrap rather than being a second rule: at 2.999 of
 * three inputs the picture is 99.9% input 0, and at 3.0 it is input 0 exactly. The same
 * holds going down — floor takes -0.25 to input 2 with a fraction of 0.75, three quarters
 * of the way toward input 0 — so the function is continuous everywhere, including through
 * zero, which is where a `%`-based fraction would have flipped sign.
 */
export function resolveSwitchBlend(raw: number, count: number): SwitchBlend {
  if (count <= 0) return { index: 0, next: 0, fraction: 0 };
  const safe = Number.isFinite(raw) ? raw : 0;
  const index = resolveSwitchIndex(safe, count);
  return { index, next: (index + 1) % count, fraction: safe - Math.floor(safe) };
}

/**
 * Is crossfade definitely OFF for this stored node (T1054)? — the question the index's
 * STEP hangs on, which is why it is a shared function rather than a `=== true` at two
 * call sites.
 *
 * "Definitely" is load-bearing. A parameter takes every mode (§V107), so `crossfade` can
 * be an expression, a bind or a driven channel, and NONE of those has an answer at schema
 * time — the toggle may be on at the very next frame. Only a stored static false (or
 * nothing stored at all, which is the default) is a promise that the index is discrete.
 * Every other case frees the step, because an integer rung on an index whose fraction
 * might become the control is a feature the user cannot reach by dragging.
 */
export function switchCrossfadeIsOff(stored: Readonly<Record<string, unknown>>): boolean {
  const slot = stored["crossfade"];
  if (slot === undefined || slot === null) return true;
  if (typeof slot === "boolean") return !slot;
  if (typeof slot !== "object") return false;
  // A mode envelope (§V108). Anything but `static` is unknowable here, so it frees.
  const envelope = slot as { mode?: unknown; bindings?: Record<string, unknown> };
  if (envelope.mode !== "static") return false;
  const binding = envelope.bindings?.["static"] as { value?: unknown } | undefined;
  return binding?.value !== true;
}

/**
 * A switch's own schema, with the index's step CONDITIONAL on crossfade (T1054, §T880).
 *
 * T1047 gave the index `step: 1` because an index counts, and that is true exactly while
 * the selection is discrete. Turn crossfade on and it stops being true in the strongest
 * way: the FRACTION becomes the control, so an integer rung makes the new feature
 * unreachable by the gesture people would use to reach it. The step is therefore a
 * property of the instance, not of the type — which is what `parametersFor` is for.
 *
 * Freed means the DECLARED step goes away entirely, not that it shrinks to some smaller
 * lattice: `declaredStep` is the only step allowed to snap (T989, §V832), and a crossfade
 * position is continuous. `dragStepFor` then supplies its own 0.01 ergonomic, so the
 * gesture stays usable without any number reaching the document that the user did not aim
 * at.
 */
export function switchParametersFor(
  base: ParameterSchema,
  stored: Readonly<Record<string, unknown>>,
): ParameterSchema {
  if (switchCrossfadeIsOff(stored)) return base;
  const index = base["index"];
  if (index === undefined || index.type !== "number") return base;
  const { step: _snapped, ...freed } = index;
  return { ...base, index: freed };
}

/**
 * The texture Switch's STATIC schema, hoisted so `parametersFor` can rebuild it without
 * reading the node back off itself (`osc.ts`'s shape, §T880's rule about the static
 * fallback: this is what the palette, the help page and a fresh drop see).
 */
const SWITCH_PARAMETERS: ParameterSchema = {
  index: {
    type: "number",
    label: "Index",
    default: 0,
    // T1047: an index counts, so its step is 1 — a DECLARED step, which is the only
    // kind that snaps since T989 split `declaredStep` from the drag ergonomic. Without
    // it a drag lands on 0.37 of an input, which the node then floors, so the readout
    // and the picture disagree about what is selected. `valueSwitch` has always
    // declared it; this node and Cache did not.
    //
    // T1054 made it CONDITIONAL rather than removing it: with crossfade on, the fraction
    // IS the control and the rung would hide the feature, so `switchParametersFor` drops
    // this key for that instance. Discrete selection keeps it.
    step: 1,
    // NO min or max, on purpose. Out-of-range is the normal case here — a driven index
    // ramps past the end — and the node's answer is to wrap it. A declared range would
    // REJECT a static 9 (§V66 validates against it) while an expression producing 9
    // wrapped happily: two answers to one question, and the static one would be the
    // surprising half. §V107 says a mode users cannot trust everywhere is worse than no
    // mode; the same holds for a value.
    description: "Which input to show, 0-based. Out of range wraps, so -1 is the last.",
  },
  crossfade: {
    type: "boolean",
    label: "Crossfade",
    // T1054, §V831: OFF, so every document written before this parameter existed renders
    // exactly what it rendered. The blend is skipped in the shader at zero, so "off" is
    // not "a mix weighted to nothing" — it is the single sample it has always been.
    default: false,
    description: "Blend the two inputs the index sits between instead of cutting, at one extra sample per pixel.",
  },
};

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
 *
 * ## CROSSFADE (T1054), and why it is a uniform rather than a compile-time flag
 *
 * TD's Switch TOP has the toggle, and with it on a fractional index BLENDS `floor(i)` into
 * `ceil(i)` by the fraction instead of cutting. The curve is LINEAR and deliberately has no
 * alternative: TD blends linearly, `mix` is what a Switch TOP does, and a shaping option
 * nobody asked for would be a second thing to get wrong for a node whose argument is that
 * it does one thing on the §V5 fast path.
 *
 * The toggle could have been `compileTime`, which would leave today's shader byte-identical
 * when it is off. It is NOT, and §V107 is the reason: T1014 measured that a driven
 * structural parameter is refused outright at runtime ("An animated parameter changed the
 * plan's structure, so it was not applied"), so a compile-time toggle would be a control
 * that silently stops working in three of its four modes. As a uniform it drives, binds and
 * takes an expression like anything else, the pipeline never rebuilds, and the cost of
 * carrying the blend while it is off is one comparison against zero.
 *
 * COST, STATED (§V228): while crossfade is ON this samples TWO textures per pixel instead
 * of one. Nothing else changes — T1014 measured that a Switch already binds and cooks every
 * source whatever the index is, so the second branch was already being rendered; the toggle
 * buys a sample, not a branch.
 *
 * ALPHA NEEDS NO CLAMP HERE, and that is a measurement rather than an omission. §V833 found
 * that an additive composite's alpha exceeds 1 and §V838 that the display transfer hides it,
 * so a blend of two such inputs is worth checking. `mix` is a CONVEX combination: its result
 * is bounded by its two endpoints on every channel, so it cannot manufacture an alpha larger
 * than one that was already arriving. Clamping would therefore not fix an overflow — it
 * would INTRODUCE a difference, making crossfade quietly clip an out-of-range alpha that the
 * hard select passes through untouched, so the toggle would change more than the blend.
 * Alpha is straight (non-premultiplied) throughout, matching TD and `composite.ts`, so all
 * four channels blend with the same weight.
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
  parameters: SWITCH_PARAMETERS,
  /**
   * PER-INSTANCE schema: crossfade decides whether the index snaps (T1054). See
   * `switchParametersFor` for the argument. Hoisted static block above rather than a read
   * of `switchNode.parameters` here, following `osc.ts` — composing the schema from its
   * own declaration is the INSIDE of the funnel (§V814), not a second way around it.
   */
  parametersFor(stored) {
    return switchParametersFor(SWITCH_PARAMETERS, stored);
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

    // T1054. `readFlag` returns 0/1 rather than a boolean because that is what reaches a
    // uniform buffer; here the flag only picks which number to send, so it is compared.
    const crossfade = readFlag(parameters, "crossfade", false) === 1;
    const blend = resolveSwitchBlend(readNumber(parameters, "index", 0), sources.length);

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
        index: blend.index,
        next: blend.next,
        // Crossfade OFF pins the blend to 0 on the CPU rather than by a second shader:
        // the toggle stays a plain uniform, so it is drivable like everything else
        // (§V107), and the shader short-circuits at 0 to exactly one sample.
        blend: crossfade ? blend.fraction : 0,
      },
      nodeId,
      label: "Switch",
    };
    return { passes: [pass] };
  },
};
