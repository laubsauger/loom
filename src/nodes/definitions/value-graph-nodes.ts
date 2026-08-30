import type {
  CompiledNodeDescription,
  NodeDefinition,
  StatefulDeclaration,
  ValueChannels,
  ValueEvaluateContext,
} from "../../domain/types/node-definition.ts";
import type { PortType } from "../../domain/types/ports.ts";

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

export const VALUE_PORT: PortType = { kind: "value" };

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
  description: "The pointer as channels: x, y (0..1, the shared-frame convention) and buttons. Wire it, lag it, drive with it.",
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
  description: "Per-channel arithmetic: input (op) operand. The operand is the b input's matching channel, else its value, else the constant.",
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
  compile: noPasses,
};

/** T276 — Limit: clamp every channel. */
export const limitNode: NodeDefinition = {
  type: "limit",
  version: 1,
  title: "Limit",
  category: "value",
  description: "Clamps every channel between minimum and maximum.",
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
  compile: noPasses,
};

/** T276 — Slope: per-channel derivative, per second. Stateful (previous frame's bag). */
export const slopeNode: NodeDefinition = {
  type: "slope",
  version: 1,
  title: "Slope",
  category: "value",
  description: "Rate of change per second, per channel. Zero on the first frame and when time stands still.",
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
export const triggerNode: NodeDefinition = {
  type: "trigger",
  version: 1,
  title: "Trigger",
  category: "value",
  description: "Emits 1 on the frame a channel rises past the threshold, 0 otherwise. A pulse, not a level.",
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
export const lagNode: NodeDefinition = {
  type: "lag",
  version: 1,
  title: "Lag",
  category: "value",
  description: "Smooths every channel toward its input over the lag time. The classic mouse-follow feel.",
  tags: ["value", "smooth", "ease", "chop"],
  inputs: [{ id: "in", label: "In", type: VALUE_PORT }],
  outputs: [{ id: "out", label: "Out", type: VALUE_PORT }],
  parameters: {
    lag: { type: "number", label: "Lag", default: 0.25, min: 0, unit: "seconds" },
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
  description: "One-pole low-pass per channel, parameterised as a cutoff frequency.",
  tags: ["value", "lowpass", "filter", "chop"],
  inputs: [{ id: "in", label: "In", type: VALUE_PORT }],
  outputs: [{ id: "out", label: "Out", type: VALUE_PORT }],
  parameters: {
    cutoff: { type: "number", label: "Cutoff", default: 2, min: 0.01, max: 100, unit: "hz" },
  },
  stateful: VALUE_STATEFUL,
  valueEvaluate: (context) =>
    smooth(context, (values) => 1 / (2 * Math.PI * Math.max(0.01, num(values["cutoff"], 2)))),
  compile: noPasses,
};

export const valueGraphNodeDefinitions: readonly NodeDefinition[] = [
  mouseNode,
  valueMathNode,
  limitNode,
  slopeNode,
  triggerNode,
  lagNode,
  valueFilterNode,
];
