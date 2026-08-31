import type {
  CompiledNodeDescription,
  NodeDefinition,
  StatefulDeclaration,
  ValueChannels,
  ValueEvaluateContext,
} from "../../domain/types/node-definition.ts";
import { VALUE_PORT } from "./common-ports.ts";
import { resolveSwitchIndex } from "./switch.ts";
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
 */
function smooth(
  context: ValueEvaluateContext,
  secondsFor: (values: ValueEvaluateContext["values"]) => number,
): ValueChannels {
  const bag = context.inputs["in"] ?? {};
  const held = (context.state["held"] ?? {}) as Record<string, number>;
  const seconds = Math.max(1e-6, secondsFor(context.values));
  const k = 1 - Math.exp(-context.frame.deltaSeconds / seconds);
  const out = mapChannels(bag, (value, name) => {
    const current = held[name] ?? value; // first sight: start ON the input, no swoop-in
    const next = context.frame.deltaSeconds <= 0 ? current : current + (value - current) * k;
    held[name] = next;
    return next;
  });
  context.state["held"] = held;
  return out;
}

/** T277 — Lag: eases toward the input over `lag` seconds. */
export const valueLagNode: NodeDefinition = {
  type: "valueLag",
  version: 1,
  title: "Lag",
  category: "value",
  description:
    "Smooths every channel toward its input over the lag time. The classic mouse-follow feel. DELTA-DRIVEN (§V436): the ease reads the frame STEP, not a clock position, so its held value survives a timeline loop intact rather than restarting.",
  tags: ["value", "smooth", "ease", "chop"],
  inputs: [{ id: "in", label: "In", type: VALUE_PORT }],
  outputs: [{ id: "out", label: "Out", type: VALUE_PORT }],
  parameters: {
    lag: { type: "number", label: "Lag", default: 0.25, min: 0, range: "floor", unit: "seconds" },
  },
  stateful: VALUE_STATEFUL,
  valueEvaluate: (context) => smooth(context, (values) => num(values["lag"], 0.25)),
  compile: noPasses,
};

/** T277 — Filter: the same smoother parameterised as a cutoff, for signal-shaped uses. */
export const valueFilterNode: NodeDefinition = {
  type: "valueFilter",
  version: 1,
  title: "Filter",
  category: "value",
  description:
    "One-pole low-pass per channel, parameterised as a cutoff frequency. DELTA-DRIVEN (§V436), like Lag: the frame STEP sets the coefficient, so a timeline loop does not reset the filter state.",
  tags: ["value", "lowpass", "filter", "chop"],
  inputs: [{ id: "in", label: "In", type: VALUE_PORT }],
  outputs: [{ id: "out", label: "Out", type: VALUE_PORT }],
  parameters: {
    cutoff: { type: "number", label: "Cutoff", default: 2, min: 0.01, max: 100, range: "floor", unit: "hz" },
  },
  stateful: VALUE_STATEFUL,
  valueEvaluate: (context) =>
    smooth(context, (values) => 1 / (2 * Math.PI * Math.max(0.01, num(values["cutoff"], 2)))),
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
 */
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
  parameters: {
    index: {
      type: "number",
      label: "Index",
      default: 0,
      step: 1,
      // No min/max, for the texture Switch's reason (T235): out of range is the NORMAL
      // case for a driven index, and the node's answer is to wrap it. A declared range
      // would make §V66 reject a static 3 while an expression producing 3 wrapped happily.
      description: "Which connected input to pass, 0-based. Out of range wraps, so -1 is the last.",
    },
  },
  valueEvaluate: ({ inputs, values }) => {
    // Port order is the branch order, and only CONNECTED ports are branches: an absent
    // input is not a black frame to cut to, it is not a branch at all.
    const connected = (["in1", "in2", "in3", "in4"] as const)
      .map((port) => inputs[port])
      .filter((bag): bag is ValueChannels => bag !== undefined);
    const chosen = connected[resolveSwitchIndex(num(values["index"], 0), connected.length)];
    // A copy, never the input object: the evaluator caches bags by node id and a shared
    // reference would let a downstream stage's mutation reach back into its source.
    return chosen === undefined ? {} : { ...chosen };
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
