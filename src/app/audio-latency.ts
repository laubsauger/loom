/**
 * T1319b / §V985 — WHAT THE SYNC OFFSET SHOULD BE, MEASURED RATHER THAN DIALLED BY EAR.
 *
 * §T1312b shipped Sync Offset and deferred this, and the parameter's own description has
 * been instructing a measurement that did not exist: *"the right value is a property of this
 * machine and display, so set it by measuring rather than by ear."* A control and the means
 * of knowing what to put in it are ONE feature (§V985) — this is the missing half.
 *
 * ## It is a FLOOR, and saying so is the whole design
 *
 * `AudioContext.outputLatency` is the audio path to the device: buffering, the driver, the
 * interface. It cannot see the other side of the problem — the graph evaluating, the GPU
 * rendering, the compositor presenting, the panel's own lag. So the honest statement is "at
 * least this much", never "this much".
 *
 * The failure mode of pretending otherwise is not a slightly wrong number. Someone applies a
 * confident-looking 12 ms, is still visibly late, and has no way to learn the figure was a
 * lower bound — so they conclude the feature is broken and stop using it. That is strictly
 * worse than showing nothing, which is why every string this module produces says "at least"
 * and names the part it does not cover.
 *
 * ## Why it can be absent
 *
 * `outputLatency` is optional in the browsers: some report 0, some do not implement it. A
 * zero suggestion would be a confident lie in exactly the place a user is looking for an
 * authority, so an unmeasurable context returns null and the surface says it cannot measure
 * here — §V91's absence-reads-as-absence, applied to a number.
 */

/** One frame at the project rate: the picture's own minimum lag, before any GPU work. */
const frameSecondsFor = (fps: number): number => (Number.isFinite(fps) && fps > 0 ? 1 / fps : 0);

/** The slice of `AudioContext` this reads — structural, so a test needs no Web Audio. */
export interface AudioLatencySource {
  readonly outputLatency?: number | undefined;
  readonly baseLatency?: number | undefined;
}

export interface AudioLatencyEstimate {
  /** Device-side latency the context reports, seconds. */
  readonly outputSeconds: number;
  /** The context's own processing quantum, seconds. Part of the same path. */
  readonly baseSeconds: number;
  /** One frame at the project rate, seconds. */
  readonly frameSeconds: number;
  /**
   * What to suggest: the audio path plus one frame. A FLOOR on the true offset, because
   * nothing here can see the render and display path.
   */
  readonly suggestedSeconds: number;
}

/**
 * The estimate, or null when this environment reports no latency at all.
 *
 * Null rather than zero on purpose: "the browser told us nothing" and "there is no latency"
 * are different facts, and only one of them should ever be offered as a value to apply.
 */
export function audioLatencyEstimate(
  source: AudioLatencySource | undefined,
  fps: number,
): AudioLatencyEstimate | null {
  if (source === undefined) return null;
  const output = typeof source.outputLatency === "number" && Number.isFinite(source.outputLatency) ? source.outputLatency : 0;
  const base = typeof source.baseLatency === "number" && Number.isFinite(source.baseLatency) ? source.baseLatency : 0;
  // Nothing measurable: no `outputLatency`, no `baseLatency`. The frame term alone is not a
  // measurement of this machine — every machine has frames — so there is nothing to offer.
  if (output <= 0 && base <= 0) return null;
  const frame = frameSecondsFor(fps);
  return {
    outputSeconds: output,
    baseSeconds: base,
    frameSeconds: frame,
    suggestedSeconds: output + base + frame,
  };
}

const ms = (seconds: number): string => `${(seconds * 1000).toFixed(0)} ms`;

/**
 * The sentence beside the number. Always "at least", and it always names the part the
 * measurement cannot see — see the module note on why that phrasing is the design.
 */
export function describeAudioLatency(estimate: AudioLatencyEstimate | null): string {
  if (estimate === null) {
    return "This browser reports no audio output latency, so there is nothing to measure here — set Sync Offset by ear, or use a machine that reports it.";
  }
  const parts = [`audio out ${ms(estimate.outputSeconds + estimate.baseSeconds)}`];
  if (estimate.frameSeconds > 0) parts.push(`one frame ${ms(estimate.frameSeconds)}`);
  return `At least ${ms(estimate.suggestedSeconds)} (${parts.join(" + ")}). Your display's own lag is not included, so the real offset is this or more.`;
}
