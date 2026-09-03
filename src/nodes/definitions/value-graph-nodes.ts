import type {
  CompiledNodeDescription,
  NodeDefinition,
  StatefulDeclaration,
  ValueChannels,
  ValueEvaluateContext,
} from "../../domain/types/node-definition.ts";
import type { NumberParameter, ParameterSchema } from "../../domain/types/parameters.ts";
import { VALUE_PORT } from "./common-ports.ts";
import { resolveSwitchBlend, resolveSwitchIndex, switchParametersFor } from "./switch.ts";
import { cycleHash } from "./values.ts";

/**
 * The CHOP set (T275-T277, §V179): value-graph stages, wired `mouse1 → lag1 → param`.
 *
 * All CPU-side, all per frame, all deterministic (§V143): frame + inputs + params +
 * state in, numbers out. The stateful ones (Slope, Trigger, Lag, Filter) declare
 * `stateful` (§V181): unskippable under §V155 — a skipped smoothing stage does not go
 * stale, it DIVERGES — and their state ties them to §V170's seek rules; it clears on
 * transport reset. Channel bags flow through per channel, so a Lag on a Mouse smooths
 * x and y independently with nothing configured.
 */

export { VALUE_PORT } from "./common-ports.ts";

const noPasses = (): CompiledNodeDescription => ({ passes: [] });

/** §V181: value-graph state resets with the transport, replays deterministically. */
const VALUE_STATEFUL: StatefulDeclaration = {
  reset: true,
  deterministicReplay: true,
  checkpoint: false,
  randomAccess: false,
};

const num = (value: unknown, fallback: number): number =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

/** Applies `map` to every channel of `bag` — the per-channel convention of the set. */
function mapChannels(bag: ValueChannels, map: (value: number, name: string) => number): ValueChannels {
  const out: Record<string, number> = {};
  for (const [name, value] of Object.entries(bag)) out[name] = map(value, name);
  return out;
}

/** T275 — Mouse (§V182): the SAME pointer the shaders read, never a second listener. */
export const mouseNode: NodeDefinition = {
  type: "mouse",
  version: 1,
  title: "Mouse",
  category: "value",
  description: "The pointer as channels: x, y (0..1, the shared-frame convention) and buttons. Wire it, lag it, drive with it. CLOCKLESS (§V436): it reports where the cursor is, so a timeline loop passes straight through it.",
  tags: ["value", "input", "pointer", "mouse"],
  inputs: [],
  outputs: [{ id: "out", label: "Out", type: VALUE_PORT }],
  parameters: {},
  valueEvaluate: ({ pointer }) => ({
    x: pointer?.x ?? 0,
    y: pointer?.y ?? 0,
    buttons: pointer?.buttons ?? 0,
  }),
  compile: noPasses,
};

/** T276 — Math: per-channel arithmetic against a second input (or the constant). */
export const valueMathNode: NodeDefinition = {
  type: "valueMath",
  version: 1,
  title: "Math",
  category: "value",
  description: "Per-channel arithmetic: input (op) operand. The operand is the b input's matching channel, else its value, else the constant. CLOCKLESS (§V436): it reads no clock, so whatever its inputs do across a timeline loop, it does.",
  tags: ["value", "math", "chop"],
  inputs: [
    { id: "a", label: "A", type: VALUE_PORT },
    { id: "b", label: "B", type: VALUE_PORT, optional: true },
  ],
  outputs: [{ id: "out", label: "Out", type: VALUE_PORT }],
  parameters: {
    operation: {
      type: "enum",
      label: "Operation",
      default: "add",
      options: [
        { value: "add", label: "Add" },
        { value: "subtract", label: "Subtract" },
        { value: "multiply", label: "Multiply" },
        { value: "divide", label: "Divide" },
        { value: "minimum", label: "Minimum" },
        { value: "maximum", label: "Maximum" },
      ],
    },
    operand: { type: "number", label: "Operand", default: 1 },
  },
  valueEvaluate: ({ inputs, values }) => {
    const a = inputs["a"] ?? {};
    const b = inputs["b"];
    const fallback = num(values["operand"], 1);
    const operate = (left: number, right: number): number => {
      switch (values["operation"]) {
        case "subtract":
          return left - right;
        case "multiply":
          return left * right;
        case "divide":
          return right === 0 ? 0 : left / right;
        case "minimum":
          return Math.min(left, right);
        case "maximum":
          return Math.max(left, right);
        default:
          return left + right;
      }
    };
    return mapChannels(a, (value, name) => operate(value, b?.[name] ?? b?.["value"] ?? fallback));
  },
  /**
   * T735: arithmetic against a constant does not change how often the signal repeats, so
   * a Math fed by an LFO has the LFO's period and can draw its whole cycle. These were
   * exactly the nodes the owner watched jank — the history plot's 2 s window over a 16-91 s
   * cycle refit its axis ~200 times a minute while the signal did nothing.
   *
   * Honest where it is not: with BOTH inputs wired to different periods the output repeats
   * on their common multiple, not on either. The chain resolver refuses that case rather
   * than drawing one period's worth of a curve that does not close, and such a node keeps
   * the history plot.
   */
  plotPeriodFollowsInputs: true,
  compile: noPasses,
};

/** T276 — Limit: clamp every channel. (The TOP of the same name clamps pixels; this is its CHOP twin.) */
export const valueLimitNode: NodeDefinition = {
  type: "valueLimit",
  version: 1,
  title: "Limit",
  category: "value",
  description: "Clamps every channel between minimum and maximum. CLOCKLESS (§V436): it reads no clock, so whatever its input does across a timeline loop, it does.",
  tags: ["value", "clamp", "chop"],
  inputs: [{ id: "in", label: "In", type: VALUE_PORT }],
  outputs: [{ id: "out", label: "Out", type: VALUE_PORT }],
  parameters: {
    minimum: { type: "number", label: "Minimum", default: 0 },
    maximum: { type: "number", label: "Maximum", default: 1 },
  },
  valueEvaluate: ({ inputs, values }) => {
    const lo = num(values["minimum"], 0);
    const hi = num(values["maximum"], 1);
    return mapChannels(inputs["in"] ?? {}, (value) => Math.min(hi, Math.max(lo, value)));
  },
  /** T735: clamping is per-sample and stateless, so the period passes straight through. */
  plotPeriodFollowsInputs: true,
  compile: noPasses,
};

/**
 * T276 — Slope: per-channel derivative, per second. Stateful (previous frame's bag).
 *
 * Prefixed under §V194 like Math, Limit and Filter: the image catalogue has its own Slope
 * (T284, the derivative of an IMAGE) and type strings are one flat namespace across
 * families. This one shipped first and unprefixed only because the collision had not
 * arrived yet; TD tells the two apart by the CHOP/TOP suffix, and we have no such thing.
 */
export const valueSlopeNode: NodeDefinition = {
  type: "valueSlope",
  version: 1,
  title: "Slope",
  category: "value",
  description:
    "Rate of change per second, per channel. Zero on the first frame and when time stands still. DELTA-DRIVEN (§V436): it reads the frame STEP, never a clock position, so a timeline loop passes through it without a discontinuity — the step across a lap is a real one (T464).",
  tags: ["value", "derivative", "chop"],
  inputs: [{ id: "in", label: "In", type: VALUE_PORT }],
  outputs: [{ id: "out", label: "Out", type: VALUE_PORT }],
  parameters: {},
  stateful: VALUE_STATEFUL,
  valueEvaluate: ({ inputs, frame, state }) => {
    const bag = inputs["in"] ?? {};
    const previous = (state["previous"] ?? {}) as Record<string, number>;
    const out = mapChannels(bag, (value, name) => {
      const before = previous[name];
      return before === undefined || frame.deltaSeconds <= 0 ? 0 : (value - before) / frame.deltaSeconds;
    });
    state["previous"] = { ...bag };
    return out;
  },
  compile: noPasses,
};

/** T276 — Trigger: 1 for the single frame a channel crosses the threshold upward. */
export const valueTriggerNode: NodeDefinition = {
  type: "valueTrigger",
  version: 1,
  title: "Trigger",
  category: "value",
  description:
    "Emits 1 on the frame a channel rises past the threshold, 0 otherwise. A pulse, not a level. CLOCKLESS (§V436): it compares this frame's value to last frame's and reads no clock at all, so a timeline loop cannot make it fire or miss.",
  tags: ["value", "pulse", "threshold", "chop"],
  inputs: [{ id: "in", label: "In", type: VALUE_PORT }],
  outputs: [{ id: "out", label: "Out", type: VALUE_PORT }],
  parameters: {
    threshold: { type: "number", label: "Threshold", default: 0.5 },
  },
  stateful: VALUE_STATEFUL,
  valueEvaluate: ({ inputs, values, state }) => {
    const threshold = num(values["threshold"], 0.5);
    const above = (state["above"] ?? {}) as Record<string, boolean>;
    const out = mapChannels(inputs["in"] ?? {}, (value, name) => {
      const wasAbove = above[name] === true;
      const isAbove = value >= threshold;
      above[name] = isAbove;
      return isAbove && !wasAbove ? 1 : 0;
    });
    state["above"] = above;
    return out;
  },
  compile: noPasses,
};

/**
 * The shared one-pole smoother of Lag and Filter: the state eases toward the input
 * with a per-frame coefficient derived from the time constant — frame-rate independent
 * BY DERIVATION, not by tuning, so 30fps offline and 60fps live converge identically.
 *
 * ── T814 — RELEASE RATIO, the asymmetry knob, and it is deliberately UNIT-FREE ──
 *
 * Lag and Filter are ONE smoother parameterised two ways, and the family only stays one
 * family if the second knob is the same knob on both. A pair of absolute times could not
 * be: Lag would grow an "attack seconds / release seconds" pair and Filter an "attack hz /
 * release hz" pair, which is two different parameters wearing one name, and the second one
 * would need a sentinel default ("0 means follow the other") that steals a meaningful
 * value. A RATIO multiplies whichever time constant the node already computed, so it means
 * exactly the same thing in both — and its neutral value is a real number rather than a
 * sentinel.
 *
 * 1 is symmetric (today, exactly). Above 1 the fall is slower than the rise: fast attack,
 * slow release, TD's Lag CHOP with Lag Up below Lag Down, and the envelope shape every
 * audio chain in this project hand-builds. Below 1 is the mirror — snap down, ease up.
 *
 * NO SECOND CLOCK (§V436/§V453). Direction is decided by comparing THIS frame's input to
 * the state the smoother already holds; nothing here reads a clock position, and the only
 * time this function has ever read stays `frame.deltaSeconds`. So both nodes remain
 * DELTA-DRIVEN with the ratio at any setting: a timeline lap carries a real step (T464)
 * and the held value crosses it untouched. Stated rather than assumed, because "it
 * obviously reads nothing" is how the LFO landed on the wrong clock (B98).
 *
 * IDENTITY AT THE DEFAULT IS EXACT, NOT APPROXIMATE. At ratio 1, `attack * 1 === attack`
 * in IEEE-754, so `release` is the same double as `attack`, `kFall` is the same double as
 * `kRise`, and the per-channel select below can only return the single `k` this function
 * computed before T814. A document that never sets the parameter is not merely close to
 * its old output, it is bit-for-bit that output (§V147: measured, in the report).
 */
function smooth(
  context: ValueEvaluateContext,
  secondsFor: (values: ValueEvaluateContext["values"]) => number,
): ValueChannels {
  const bag = context.inputs["in"] ?? {};
  const held = (context.state["held"] ?? {}) as Record<string, number>;
  const attack = Math.max(1e-6, secondsFor(context.values));
  const release = Math.max(1e-6, attack * Math.max(0, num(context.values["releaseRatio"], 1)));
  const kRise = 1 - Math.exp(-context.frame.deltaSeconds / attack);
  const kFall = 1 - Math.exp(-context.frame.deltaSeconds / release);
  const out = mapChannels(bag, (value, name) => {
    const current = held[name] ?? value; // first sight: start ON the input, no swoop-in
    const k = value > current ? kRise : kFall;
    const next = context.frame.deltaSeconds <= 0 ? current : current + (value - current) * k;
    held[name] = next;
    return next;
  });
  context.state["held"] = held;
  return out;
}

/**
 * T814 — the asymmetry knob, identical on both twins (see `smooth` for why it is a ratio).
 *
 * `step` is declared rather than derived, and that is B80/T648 rather than taste: a numeric
 * parameter that declares only a range hands one derived number to the drag rate, the
 * display decimals AND the commit grid at once, and this range would derive a grid that
 * cannot hold its own default.
 */
const RELEASE_RATIO_PARAMETER: NumberParameter = {
  type: "number",
  label: "Release Ratio",
  description:
    "Multiplies the smoothing time while a channel is FALLING. 1 smooths both directions alike, which is what this node has always done. Above 1 the fall is slower than the rise — fast attack, slow release, the envelope shape. Below 1 snaps down and eases up. Unitless on purpose: it means the same thing on Lag and on Filter.",
  default: 1,
  min: 0,
  // T823: the drag travel reaches 100, not 10. A peak-follower (5 ms attack, 500 ms
  // release) is ratio 100, and the depth is not cosmetic — the transient sag it removes is
  // 15.8% at 100 against 26.8% at 10 (T814's own measurement). `range: "floor"` always let
  // a typed or driven value go higher, but a component that PUBLISHES this parameter for the
  // user to drag needs the useful setting inside the travel, not past its end.
  max: 100,
  step: 0.01,
  range: "floor",
};

/** T277 — Lag: eases toward the input over `lag` seconds. T814 gave it the release ratio. */
export const valueLagNode: NodeDefinition = {
  type: "valueLag",
  version: 1,
  title: "Lag",
  category: "value",
  description:
    "Smooths every channel toward its input over the lag time. The classic mouse-follow feel. Release Ratio makes the fall slower than the rise (T814): at 1 both directions ease alike, above 1 it chases upward and settles back slowly — fast attack, slow release. DELTA-DRIVEN (§V436): the ease reads the frame STEP, not a clock position, so its held value survives a timeline loop intact rather than restarting, and the ratio adds no clock of its own — it compares this frame's input to the value already held.",
  tags: ["value", "smooth", "ease", "attack", "release", "chop"],
  inputs: [{ id: "in", label: "In", type: VALUE_PORT }],
  outputs: [{ id: "out", label: "Out", type: VALUE_PORT }],
  parameters: {
    lag: {
      type: "number",
      label: "Lag",
      description: "The time a channel takes to ease toward its input. With Release Ratio above 1, this is the RISE time.",
      default: 0.25,
      min: 0,
      range: "floor",
      unit: "seconds",
    },
    releaseRatio: RELEASE_RATIO_PARAMETER,
  },
  stateful: VALUE_STATEFUL,
  valueEvaluate: (context) => smooth(context, (values) => num(values["lag"], 0.25)),
  compile: noPasses,
};

/**
 * T277 — Filter: the same smoother parameterised as a cutoff, for signal-shaped uses.
 *
 * T814 — MODE, and it is on THIS twin only, which is a judgement rather than an oversight.
 *
 * The high-pass is the residual of the low-pass this node already computes: `input − held`,
 * one subtraction, no second state and no second coefficient. What it gives you is
 * TRANSIENTS ONLY — the part of a signal the smoother could not keep up with, which is a
 * band's attack with its level removed, and there is no other way to say that in the value
 * graph today.
 *
 * WHY LAG DOES NOT GET IT. The release ratio is a property of the SMOOTHER, so it belongs
 * to both parameterisations of it or the family splits. A mode is a choice of what you TAP
 * OFF the smoother, and "Lag" names the tap: a Lag whose output is the residual is not
 * lagging anything, and the node's own title would stop describing it. Low-pass and
 * high-pass are filter words on a node parameterised in Hz, and a user who wants the
 * residual of a Lag can still take it — `in` to Lag, then Math in subtract mode with the
 * raw signal on B — which is exactly the wiring this mode saves on the Filter.
 *
 * The mode does not change the CLOCK: the subtraction is per-sample and reads nothing.
 * Both branches leave the node DELTA-DRIVEN (§V436).
 */
export const valueFilterNode: NodeDefinition = {
  type: "valueFilter",
  version: 1,
  title: "Filter",
  category: "value",
  description:
    "One-pole filter per channel, parameterised as a cutoff frequency. LOW-PASS keeps what changes slower than the cutoff; HIGH-PASS keeps what changes faster — the transients, with the level subtracted out. Release Ratio makes the fall slower than the rise (T814), the fast-attack/slow-release envelope shape. DELTA-DRIVEN (§V436), like Lag: the frame STEP sets the coefficient, so a timeline loop does not reset the filter state, and neither the mode nor the ratio reads a clock of its own.",
  tags: ["value", "lowpass", "highpass", "filter", "transient", "chop"],
  inputs: [{ id: "in", label: "In", type: VALUE_PORT }],
  outputs: [{ id: "out", label: "Out", type: VALUE_PORT }],
  parameters: {
    cutoff: {
      type: "number",
      label: "Cutoff",
      description: "The corner frequency. Low-pass keeps what is slower than this; high-pass keeps what is faster.",
      default: 2,
      min: 0.01,
      max: 100,
      range: "floor",
      unit: "hz",
    },
    releaseRatio: RELEASE_RATIO_PARAMETER,
    mode: {
      type: "enum",
      label: "Mode",
      description:
        "Low-pass passes the smoothed signal. High-pass passes what is left over — the part the smoother could not follow, which sits at zero while a signal is steady and spikes on every transient.",
      default: "lowpass",
      options: [
        { value: "lowpass", label: "Low-pass" },
        { value: "highpass", label: "High-pass" },
      ],
    },
  },
  stateful: VALUE_STATEFUL,
  valueEvaluate: (context) => {
    const lowpass = smooth(context, (values) => 1 / (2 * Math.PI * Math.max(0.01, num(values["cutoff"], 2))));
    if (context.values["mode"] !== "highpass") return lowpass;
    // The residual, per channel. First sight holds the input, so a high-pass opens at 0
    // rather than at the signal's level — the transient reading, from the first frame.
    const bag = context.inputs["in"] ?? {};
    return mapChannels(lowpass, (held, name) => (bag[name] ?? held) - held);
  },
  compile: noPasses,
};

/**
 * T508 — Switch: ONE source, chosen by index. TD's Switch CHOP, and the value-graph twin
 * of the texture Switch (T235).
 *
 * WHY IT HAS TO EXIST AS A NODE. `value-graph.ts` merges every edge landing on one value
 * port — `{...prior, ...next}` over sorted edge ids (§V457) — so two sources wired to the
 * same port do not blend, they CLOBBER: the later edge's `level` wins outright and the
 * other source vanishes with no diagnostic. That merge is deliberate (it lets a multi-wire
 * input compose bags of DIFFERENT channels), which is exactly why exclusivity cannot come
 * from wiring and has to come from a node. T504's owner ask was "switch around between the
 * two without mixing them together"; without this node the honest answers were a
 * multiply-and-add crossfade (a blend wearing a switch's hat) or nothing.
 *
 * FOUR NAMED PORTS, NOT A VARIADIC ONE, and that is forced rather than chosen. The
 * evaluator keys `inputs` by PORT and merges within a port, so a variadic value port could
 * not present its edges separately without changing the merge §V457 pins. Four rather than
 * the two E24 needs, because the node is public catalogue surface: `in1`/`in2` matches the
 * composite family's naming, and going from two to three later would change a shipped
 * node's shape in front of users for no gain today.
 *
 * THE INDEX COUNTS CONNECTED INPUTS, in port order, and it WRAPS — `resolveSwitchIndex` is
 * imported from the texture Switch rather than reimplemented, so "what does index 9 of 3
 * mean" has exactly one definition in the repo. A gap (in1 and in3 wired, in2 empty) is
 * two inputs, not three: an unconnected port is not a branch you can cut to.
 *
 * EXCLUSIVE BY CONSTRUCTION: the chosen bag is returned as its own copy and no other input
 * is read into the result at all. There is no merge step to get wrong.
 *
 * CLOCKLESS (§V436/§V453): it selects. It reads no clock, holds no state and has no phase,
 * so a timeline lap cannot reach it — whatever the selected input does across a loop, this
 * does. Stated here because §V453 makes the classification a decision the author owes,
 * and "it obviously reads nothing" is how `lfo` ended up on the wrong clock (B98).
 *
 * ## CROSSFADE (T1054): a lerp per channel, and what happens when the bags differ
 *
 * With the toggle on, a fractional index LERPS the two neighbouring bags instead of cutting
 * — the same rule as the texture Switch, over the same wrap, so a ramp off the end fades
 * LAST→FIRST. A number blend is the least ambiguous crossfade there is, and a driven index
 * sweeping a parameter between two sources is the case a fractional index is most obviously
 * for.
 *
 * PER CHANNEL, over the UNION of the two bags, because §T982 made a value input carry a BAG
 * and not a scalar. A channel present on both sides is `a*(1-t) + b*t`. A channel present on
 * only ONE side is that side's value scaled by its own weight — it fades out as the other
 * source takes over, which is what a crossfader does with a channel the other input does not
 * have. The alternative, passing an orphan channel through unweighted, was rejected because
 * it breaks the endpoints: at `t = 0` the output must be source A's bag EXACTLY, and a
 * union that carried B's orphans at full strength would not be. Both endpoints are exact —
 * the fraction is 0 at every integer index, and the code returns the chosen bag itself
 * there — so crossfade at an integer and a hard select are the same bag, not merely close.
 *
 * ⚠ COST: NONE, and this corrects the record rather than restating it. §T1014/§T1022 wrote
 * that "`valueSwitch` IS exclusive" and read that as an unselected branch not cooking. What
 * is exclusive is the OUTPUT BAG. `value-graph.ts` evaluates EVERY value node in the
 * document in topological order with no reachability filter, so all four branches already
 * cook at every index — measured directly by counting evaluations of three constants feeding
 * one switch: `{11:1, 22:1, 33:1}` at index 0, 1 and 2 alike. So crossfade here buys nothing
 * and costs nothing, and the parameter's description does not claim a price that a profiler
 * would not find. What IS true, and is a fact about MEANING rather than about today's
 * scheduler: crossfade makes both neighbours genuinely live, so if the pull-based cooking
 * §T1014 left unruled ever lands, these two branches are the ones it must not prune.
 */
/** Hoisted for the same reason the texture Switch's is (T1054): `parametersFor` rebuilds it. */
const VALUE_SWITCH_PARAMETERS: ParameterSchema = {
  index: {
    type: "number",
    label: "Index",
    // T1054: conditional on crossfade, see `switchParametersFor`.
    step: 1,
    default: 0,
    // No min/max, for the texture Switch's reason (T235): out of range is the NORMAL
    // case for a driven index, and the node's answer is to wrap it. A declared range
    // would make §V66 reject a static 3 while an expression producing 3 wrapped happily.
    description: "Which connected input to pass, 0-based. Out of range wraps, so -1 is the last.",
  },
  crossfade: {
    type: "boolean",
    label: "Crossfade",
    // §V831: OFF, so a document written before T1054 evaluates to the same numbers.
    default: false,
    description: "Blend the two inputs the index sits between, channel by channel, instead of cutting.",
  },
};

export const valueSwitchNode: NodeDefinition = {
  type: "valueSwitch",
  version: 1,
  title: "Switch",
  category: "value",
  description:
    "Passes ONE of its inputs through, chosen by index — the others contribute nothing. Drive the index to cut between sources. The index counts the CONNECTED inputs in port order and wraps, so -1 is the last. TD Switch CHOP. CLOCKLESS (§V436): it selects and reads no clock, so a timeline loop passes straight through it.",
  tags: ["value", "switch", "select", "route", "chop"],
  inputs: [
    { id: "in1", label: "In 1", type: VALUE_PORT, optional: true },
    { id: "in2", label: "In 2", type: VALUE_PORT, optional: true },
    { id: "in3", label: "In 3", type: VALUE_PORT, optional: true },
    { id: "in4", label: "In 4", type: VALUE_PORT, optional: true },
  ],
  outputs: [{ id: "out", label: "Out", type: VALUE_PORT }],
  parameters: VALUE_SWITCH_PARAMETERS,
  /** Crossfade frees the index's step, exactly as on the texture Switch (T1054). */
  parametersFor(stored) {
    return switchParametersFor(VALUE_SWITCH_PARAMETERS, stored);
  },
  valueEvaluate: ({ inputs, values }) => {
    // Port order is the branch order, and only CONNECTED ports are branches: an absent
    // input is not a black frame to cut to, it is not a branch at all.
    const connected = (["in1", "in2", "in3", "in4"] as const)
      .map((port) => inputs[port])
      .filter((bag): bag is ValueChannels => bag !== undefined);
    const raw = num(values["index"], 0);

    if (values["crossfade"] !== true) {
      const chosen = connected[resolveSwitchIndex(raw, connected.length)];
      // A copy, never the input object: the evaluator caches bags by node id and a shared
      // reference would let a downstream stage's mutation reach back into its source.
      return chosen === undefined ? {} : { ...chosen };
    }

    // T1054. Same wrap as the hard select, so the two agree at every integer index.
    const { index, next, fraction } = resolveSwitchBlend(raw, connected.length);
    const from = connected[index];
    if (from === undefined) return {};
    // Sitting exactly on an input: the bag ITSELF, not a lerp weighted to nothing. That is
    // what makes "crossfade at an integer index" and "hard select" the same bag rather than
    // the same number, which is what `toEqual` on the whole bag can actually check.
    if (fraction <= 0) return { ...from };
    const to = connected[next] ?? {};
    const blended: Record<string, number> = {};
    // The UNION: a channel only one side publishes fades with its own side's weight rather
    // than being carried at full strength, which is what keeps t=0 and t→1 honest.
    for (const name of new Set([...Object.keys(from), ...Object.keys(to)])) {
      blended[name] = (from[name] ?? 0) * (1 - fraction) + (to[name] ?? 0) * fraction;
    }
    return blended;
  },
  compile: noPasses,
};


/**
 * T548 — Step: hold one pseudo-random value for every N counts of the input, then move on.
 *
 * ## The gap it fills, and what was tried first
 *
 * The owner asked for "some higher level deformation that keeps active for a couple of
 * bars or something and then lerps to the next one" — a PHRASE-length timescale, between
 * the per-frame bands and the per-piece LFO. Two things already existed and neither one
 * closes it:
 *
 *  - **the LFO's `noise` shape IS a sample-and-hold**, one held value per cycle, and would
 *    be exactly this — except that it is FREE-RUNNING by design (B98), so its steps cannot
 *    line up with bars. A held value that drifts against the music it is scoring is worse
 *    than either choice made consistently;
 *  - **an expression could do the arithmetic** — `floor`, `fract` and `sin` are all in the
 *    grammar, so the classic `fract(sin(floor(bar / 4) * 12.9898) * 43758.5453)` parses.
 *    But an expression's scope is `scopeFromFrame` — clocks and frame numbers — and a
 *    CHANNEL is only reachable through `driven` mode, which reads a channel raw with no
 *    arithmetic around it. So the expression cannot see `bar`, and this cannot be written
 *    where it is read.
 *
 * `valueMath` cannot close the gap either: add/subtract/multiply/divide/min/max, and a
 * quantiser needs a floor.
 *
 * ## What it deliberately is NOT
 *
 *  - **not a second smoother.** "Lerps to the next one" is `valueLag` after this, which
 *    already eases every channel of its input. A step through a lag IS the ask; a node
 *    that both picks and smooths would be two nodes wearing one hat.
 *  - **not a stateful RNG and not an accumulator.** The pick is a pure function of the
 *    quantised input, so an offline render reproduces it and a SCRUB lands on the same
 *    value it had the first time through (§V44/§V47). A held value that depends on how you
 *    ARRIVED at a frame is the class of bug T493 spent itself on.
 *  - **not a hash of its own.** `cycleHash` is the LFO's, imported rather than rewritten,
 *    so "the stable random for index n" has one definition in the repo (§V109).
 *
 * ## Clock (§V453/§V436): CLOCKLESS, and that is the interesting part
 *
 * It reads no clock at all — it reads a COUNT that arrives on its input — so it inherits
 * whatever clock its source owns. Fed `bar` from Audio Pattern it is timeline-anchored,
 * because that node is; fed a count from something free-running it is free-running. That
 * is the answer to the swapped-source case: when the source's clock changes, the structure
 * follows it automatically, because the structure IS the source's channels.
 *
 * PER CHANNEL, like the rest of the set: feed it the whole audio bag and every channel is
 * quantised and held independently, and `step1:bar` is the one you wire. That is what lets
 * one node serve a bag rather than needing a channel-picker that does not exist.
 */
export const valueStepNode: NodeDefinition = {
  type: "valueStep",
  version: 1,
  title: "Step",
  category: "value",
  description:
    "Holds a pseudo-random value for every N counts of its input, then steps to the next one — a phrase-length timescale. Wire bar from Audio Pattern into it and a Lag after it to get \"hold for four bars, then lerp to the next\". The pick is a pure function of the count, so a scrub and an offline render land on the same value. CLOCKLESS (§V436): it reads no clock, only a count, so it inherits whatever clock its source owns.",
  tags: ["value", "hold", "step", "sample", "random", "chop"],
  inputs: [{ id: "in", label: "In", type: VALUE_PORT }],
  outputs: [{ id: "out", label: "Out", type: VALUE_PORT }],
  parameters: {
    every: {
      type: "number",
      label: "Every",
      default: 4,
      min: 1,
      step: 1,
      range: "floor",
      description: "Counts per held value. Fed bar, this is bars per step; 4 is a phrase.",
    },
    minimum: { type: "number", label: "Minimum", default: 0 },
    maximum: { type: "number", label: "Maximum", default: 1 },
    seed: {
      type: "number",
      label: "Seed",
      default: 0,
      step: 1,
      description: "Picks a different sequence of held values from the same counts.",
    },
  },
  valueEvaluate: ({ inputs, values, frame }) => {
    const every = Math.max(1, Math.floor(num(values["every"], 4)));
    const minimum = num(values["minimum"], 0);
    const maximum = num(values["maximum"], 1);
    // The PROJECT seed is folded in alongside the node's own, exactly as the LFO's noise
    // shape does it, so re-seeding a project re-rolls every held value with it.
    const seed = Math.floor(num(values["seed"], 0)) + frame.randomSeed;
    return mapChannels(inputs["in"] ?? {}, (value) => {
      const index = Math.floor(value / every);
      return minimum + (maximum - minimum) * cycleHash(index, seed);
    });
  },
  compile: noPasses,
};

/**
 * T654 — Channel In: a named channel as a value source. TD's Select CHOP shape.
 *
 * §V615's door-opener: §V144 promised image → parameter → image and the catalogue could
 * not close it processed — analyze publishes a CHANNEL, not a port, so nothing could
 * wire from it; the driven envelope is unity-gain; expressions cannot see channels. This
 * node is the one crossing: it reads any published channel BY NAME through the resolver
 * the composition already holds (the app's analyze half, handed into the session's
 * extras — the same seam `audio` came through), and from here the whole value family
 * applies: gain it, clamp it, lag it, trigger on it. A controller becomes buildable.
 *
 * It reads EXTERNAL channels only — the value graph's own chains are edges; wire them.
 * A name nobody publishes (or a session with no resolver — a bare headless caller)
 * yields the Fallback, loudly stated here: stale-or-fallback beats stalled (§V144), and
 * the same document renders the same file twice (§V45).
 */
export const channelInNode: NodeDefinition = {
  type: "channelIn",
  version: 1,
  title: "Channel In",
  category: "value",
  description:
    "Reads a published channel by name — an Analyze node's measurement, or anything else the app publishes — as a value-graph source. Unpublished name = the Fallback value. CLOCKLESS (§V436).",
  tags: ["value", "channel", "select", "measure", "reactive"],
  inputs: [],
  outputs: [{ id: "out", label: "Out", type: VALUE_PORT }],
  parameters: {
    channel: {
      type: "string",
      label: "Channel",
      default: "",
      description: "The published name to read — an Analyze node's own name, e.g. meter1.",
    },
    fallback: {
      type: "number",
      label: "Fallback",
      default: 0,
      step: 0.001,
      description: "Published when the named channel is absent — before the first measurement lands, or with no name set.",
    },
  },
  valueEvaluate: ({ values, channels }) => {
    const name = typeof values["channel"] === "string" ? (values["channel"] as string).trim() : "";
    const fallback = typeof values["fallback"] === "number" ? (values["fallback"] as number) : 0;
    const measured = name === "" ? undefined : channels?.(name);
    return { value: measured ?? fallback };
  },
  compile: noPasses,
};

export const valueGraphNodeDefinitions: readonly NodeDefinition[] = [
  mouseNode,
  channelInNode,
  valueMathNode,
  valueLimitNode,
  valueSlopeNode,
  valueTriggerNode,
  valueLagNode,
  valueFilterNode,
  valueSwitchNode,
  valueStepNode,
];
