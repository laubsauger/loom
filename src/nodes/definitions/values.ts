import type {
  CompiledNodeDescription,
  NodeDefinition,
} from "../../domain/types/node-definition.ts";
import type { FrameEvaluationInput } from "../../domain/types/frame.ts";
import type { ParameterValue } from "../../domain/types/parameters.ts";
import { VALUE_PORT } from "./common-ports.ts";

/**
 * Value sources (T238-T240, §V143): the nodes that MAKE a value move.
 *
 * CHOP analogs, CPU-side: each declares `valueChannel` — a pure function of its own
 * parameters and the frame clock — and its NAME is its channel (§V129). A parameter in
 * `driven` mode naming `lfo1` reads it through `graphChannelResolver` (T203's seam).
 * They emit no passes and no resources; their entire output is the number.
 *
 * §V143 is the law here: time comes from `FrameEvaluationInput` and nowhere else, so
 * offline and live agree frame for frame (§V44/§V45). The LFO's noise shape uses a
 * counter-based hash seeded by the frame's randomSeed — deterministic per project seed,
 * per cycle, per machine.
 *
 * EACH ALSO HAS AN OUTPUT PORT (T325, §V237), which they shipped without. Being
 * addressable by NAME and being reachable from an EDGE are two different reachabilities:
 * `driven → lfo1` worked from the day these landed, and `lfo1 → lag1` could not be drawn,
 * because a value edge needs a port to land on. T274's "single-channel is the degenerate
 * case" was true of the addressing and silently false of the graph — which left Mouse as
 * the only wirable source in the catalogue.
 *
 * The port carries the same single-channel bag the resolver already publishes: the
 * evaluator wraps a `valueChannel` node's number as `{ value }`, and every stage
 * downstream (Math's operand fallback, Lag, Filter) already reads that name.
 */

const num = (value: ParameterValue | undefined, fallback: number): number =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

const frac = (value: number): number => value - Math.floor(value);

/** Deterministic [0,1) hash of an integer cycle index and seed — the S&H noise shape. */
function cycleHash(index: number, seed: number): number {
  let h = Math.imul(index ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(seed | 1, 0xc2b2ae35);
  h = Math.imul(h ^ (h >>> 13), 0x27d4eb2f);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

export function lfoValue(
  values: Readonly<Record<string, ParameterValue>>,
  frame: FrameEvaluationInput,
): number {
  const frequency = num(values["frequency"], 1);
  const amplitude = num(values["amplitude"], 1);
  const offset = num(values["offset"], 0);
  const phaseOffset = num(values["phase"], 0);
  const phase = frame.timeSeconds * frequency + phaseOffset;

  let wave: number;
  switch (values["shape"]) {
    case "triangle":
      wave = 1 - 4 * Math.abs(frac(phase + 0.25) - 0.5);
      break;
    case "square":
      wave = frac(phase) < 0.5 ? 1 : -1;
      break;
    case "saw":
      wave = 2 * frac(phase) - 1;
      break;
    case "noise":
      // Sample & hold: one deterministic value per cycle, seeded by the project seed.
      wave = cycleHash(Math.floor(phase), frame.randomSeed) * 2 - 1;
      break;
    default:
      wave = Math.sin(phase * Math.PI * 2);
      break;
  }
  return offset + amplitude * wave;
}

/** No passes: a value source's entire output is its channel (§V143). */
const noPasses = (): CompiledNodeDescription => ({ passes: [] });

export const lfoNode: NodeDefinition = {
  type: "lfo",
  version: 1,
  title: "LFO",
  category: "value",
  description:
    "A low-frequency oscillator: sine, triangle, square, saw or sample-and-hold noise of the frame clock. Its name is its channel — drive any parameter with it, or wire it.",
  inputs: [],
  outputs: [{ id: "out", label: "Out", type: VALUE_PORT }],
  parameters: {
    shape: {
      type: "enum",
      label: "Shape",
      default: "sine",
      options: [
        { value: "sine", label: "Sine" },
        { value: "triangle", label: "Triangle" },
        { value: "square", label: "Square" },
        { value: "saw", label: "Saw" },
        { value: "noise", label: "Noise (S&H)" },
      ],
    },
    /**
     * B80 — `step` is DECLARED, and the declaration is load-bearing.
     *
     * With only `min: 0, max: 100`, the control kit derives a step of 1/100 of the range,
     * which for this parameter is exactly `1`. A step of 1 means zero display decimals AND
     * an integer quantisation grid, so a 0.25 Hz LFO rendered as `0` and — the destroying
     * half — clicking the field and clicking away committed that `0` back into the
     * document, which stops the oscillator. An LFO's useful band is well under 1 Hz
     * (0.05..0.25 across the shipped examples), so `0.01` is the granularity this control
     * actually needs; §V133's magnitude ladder still reaches finer without a re-declaration.
     */
    frequency: {
      type: "number",
      label: "Frequency",
      default: 1,
      min: 0,
      max: 100,
      step: 0.01,
      unit: "hz",
    },
    amplitude: { type: "number", label: "Amplitude", default: 1 },
    offset: { type: "number", label: "Offset", default: 0 },
    phase: { type: "number", label: "Phase", default: 0, min: 0, max: 1 },
  },
  valueChannel: lfoValue,
  /**
   * One cycle is `1/frequency` (T459). Zero or negative frequency has no cycle — the
   * output is a constant — and null is what says so, rather than an infinite period the
   * plot would try to draw.
   *
   * `noise` is sample-and-hold: it IS periodic in the sense that matters here, one held
   * value per cycle, so a period-long window shows exactly one step. That is the honest
   * picture of what it does, and it is what the aliased history could never show.
   */
  plotPeriod: (values) => {
    const frequency = num(values["frequency"], 1);
    return Number.isFinite(frequency) && frequency > 0 ? 1 / frequency : null;
  },
  compile: noPasses,
};

export const constantNode: NodeDefinition = {
  type: "constant",
  version: 1,
  title: "Constant",
  category: "value",
  description: "A named number. The patch-level knob several parameters can share by driving from it, or wiring from it.",
  inputs: [],
  outputs: [{ id: "out", label: "Out", type: VALUE_PORT }],
  parameters: {
    value: { type: "number", label: "Value", default: 0 },
  },
  valueChannel: (values) => num(values["value"], 0),
  compile: noPasses,
};

export const timerNode: NodeDefinition = {
  type: "timer",
  version: 1,
  title: "Timer",
  category: "value",
  description: "The frame clock, scaled and delayed: max(0, time - delay) * speed. A ramp to build timelines on.",
  inputs: [],
  outputs: [{ id: "out", label: "Out", type: VALUE_PORT }],
  parameters: {
    speed: { type: "number", label: "Speed", default: 1 },
    delay: { type: "number", label: "Delay", default: 0, min: 0, unit: "seconds" },
  },
  valueChannel: (values, frame) =>
    Math.max(0, frame.timeSeconds - num(values["delay"], 0)) * num(values["speed"], 1),
  compile: noPasses,
};

export const valueNodeDefinitions: readonly NodeDefinition[] = [lfoNode, constantNode, timerNode];
