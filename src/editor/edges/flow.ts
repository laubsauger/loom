import { portFamilyColor } from "@ui/ports.ts";
import type { PortKind } from "@domain/types/ports.ts";

/**
 * The signature element (§C): "edge = living signal. flow-dash animation, hue = source
 * port family, speed & opacity <- real per-pass GPU ms. idle pass -> static hairline."
 *
 * Everything the edge renderer needs to decide is decided here, as pure functions, so
 * the claim the visual makes can be tested rather than eyeballed: a pass that costs more
 * GPU time flows visibly faster and brighter than one that costs less, and a pass with
 * no measurement at all does not pretend to be alive.
 */

/** §V26 — never an arbitrary colour. `null` (unresolvable source port) reads neutral. */
export function edgeFamilyColor(kind: PortKind | null | undefined): string {
  return kind === null || kind === undefined ? "var(--port-unknown)" : portFamilyColor(kind);
}

/** Length of one dash + gap, in canvas px. The keyframe offsets by exactly this. */
export const FLOW_DASH_PX = 14;
/** The dash itself; the rest of the period is gap. Short dash = a travelling pulse. */
export const FLOW_DASH_ON_PX = 3;

/**
 * Below this a pass is not measurably doing anything — the timer noise floor. Treating
 * it as flowing would make the animation decorative instead of informative.
 */
export const IDLE_MS = 0.05;
/** One 60 fps frame. A single pass at the whole frame budget is as busy as it gets. */
export const BUDGET_MS = 16;

export const SLOW_PX_PER_SEC = 16;
export const FAST_PX_PER_SEC = 190;
export const MIN_OPACITY = 0.3;
export const MAX_OPACITY = 0.95;

export interface FlowDescription {
  /** True only when there is a real measurement above the idle floor. */
  moving: boolean;
  /** Seconds for one dash period. Shorter = busier. 0 when static. */
  periodSeconds: number;
  opacity: number;
  /** Normalised cost, 0..1, log-scaled across IDLE_MS..BUDGET_MS. */
  load: number;
}

export const STATIC_FLOW: FlowDescription = Object.freeze({
  moving: false,
  periodSeconds: 0,
  opacity: MIN_OPACITY,
  load: 0,
});

function clamp01(value: number): number {
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

export interface FlowOptions {
  /** Source pass is bypassed or muted — no work, therefore no flow. */
  inactive?: boolean;
}

/**
 * GPU milliseconds for the source pass -> how its edge animates.
 *
 * `null`/`undefined` means "no timing available", which is the state the whole app is in
 * until T41 wires real timestamp spans: the edge falls back to a static hairline rather
 * than inventing motion. The scale is logarithmic because per-pass costs span three
 * orders of magnitude (a 0.05 ms copy next to a 12 ms blur), and a linear ramp would
 * leave every ordinary pass indistinguishable at the bottom of the range.
 */
export function describeFlow(
  gpuMs: number | null | undefined,
  options: FlowOptions = {},
): FlowDescription {
  if (options.inactive === true) return STATIC_FLOW;
  if (gpuMs === null || gpuMs === undefined) return STATIC_FLOW;
  if (!Number.isFinite(gpuMs) || gpuMs <= IDLE_MS) return STATIC_FLOW;

  const load = clamp01(Math.log(gpuMs / IDLE_MS) / Math.log(BUDGET_MS / IDLE_MS));
  const pxPerSecond = SLOW_PX_PER_SEC + (FAST_PX_PER_SEC - SLOW_PX_PER_SEC) * load;
  return {
    moving: true,
    periodSeconds: FLOW_DASH_PX / pxPerSecond,
    opacity: MIN_OPACITY + (MAX_OPACITY - MIN_OPACITY) * load,
    load,
  };
}

/** Compact per-pass timing for the node title bar. `null` -> an em dash, never "0". */
export function formatGpuMs(gpuMs: number | null | undefined): string {
  if (gpuMs === null || gpuMs === undefined || !Number.isFinite(gpuMs)) return "—";
  if (gpuMs >= 10) return `${gpuMs.toFixed(1)} ms`;
  return `${gpuMs.toFixed(2)} ms`;
}
