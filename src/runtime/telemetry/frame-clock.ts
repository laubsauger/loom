import type { ProjectSettings } from "../../domain/types/graph.ts";
import { projectFps } from "../../domain/types/graph.ts";

/**
 * T304 — WHY IS NOTHING MOVING? One derivation, two surfaces (§V437).
 *
 * §V434 cost nine agents measurement time and §V560 turned the same fact into a
 * correctness hazard: the browser SUSPENDS the frame clock for a hidden or occluded
 * window while everything else keeps running, and a person or an agent staring at a
 * frozen picture had no way to learn the browser did it — both have repeatedly
 * concluded the tool was broken.
 *
 * The verdict distinguishes the three facts a frozen picture can mean, BY NAME
 * (§V541), because their remedies differ:
 *
 *  - `paused`            — the transport is stopped. Press play.
 *  - `browser-throttled` — playing, but the page is hidden/occluded and the frame
 *    cadence collapsed: the BROWSER stopped the clock. For a person the remedy is
 *    bringing the window to the front; for an agent driving a CDP session this is the
 *    DEFAULT state, expected, and frames advance under forced paints (§V560).
 *  - `running-behind`    — playing and visible, but the cadence is under half the
 *    project rate: the machine, not the browser. Lower steps, resolution or counts.
 *
 * This notice FIXES nothing and does not pretend to (the §V560 remedies — hidden-page
 * resync steps, wall-clock grace, backstop timeouts — live where they belong). It is
 * the surface that stops people mis-attributing, which is a full job on its own.
 *
 * Consumed by the timeline readout (humans) and `get_runtime_metrics` (agents — the
 * MORE important reader, because agent sessions are where throttling is the default).
 * Both feed it their local facts; the JUDGEMENT lives only here.
 */
export type FrameClockVerdict =
  | { readonly kind: "live"; readonly observedFps: number }
  | { readonly kind: "paused" }
  | {
      readonly kind: "browser-throttled";
      readonly observedFps: number;
      readonly suggestion: string;
    }
  | {
      readonly kind: "running-behind";
      readonly observedFps: number;
      readonly suggestion: string;
    };

/** How far back a frame still counts as "recent", in ms. */
export const FRAME_CLOCK_WINDOW_MS = 1500;

export interface FrameClockInput {
  readonly playing: boolean;
  /** `document.visibilityState === "hidden"` at the moment of asking. */
  readonly hidden: boolean;
  readonly settings: Pick<ProjectSettings, "fps">;
  /** performance.now()-domain timestamps of recently RENDERED frames. */
  readonly recentFrameTimes: readonly number[];
  readonly now: number;
}

export function frameClockVerdict(input: FrameClockInput): FrameClockVerdict {
  if (!input.playing) return { kind: "paused" };
  const cutoff = input.now - FRAME_CLOCK_WINDOW_MS;
  const recent = input.recentFrameTimes.filter((at) => at > cutoff).length;
  const observedFps = recent / (FRAME_CLOCK_WINDOW_MS / 1000);
  const expected = projectFps(input.settings);
  /* Half rate is the line: a loop merely busy renders unevenly but above it, and a
     suspended clock sits at 0-2 fps (browser timers fire ~1/s when hidden). The floor
     of 1 keeps a 2fps art project from reading as broken. */
  if (observedFps >= Math.max(1, expected * 0.5)) return { kind: "live", observedFps };
  if (input.hidden) {
    return {
      kind: "browser-throttled",
      observedFps,
      suggestion:
        "The browser suspends the frame clock for a hidden or occluded window. Bring this window to the front. (Driving the app through automation? This is the expected state — frames advance on forced paints, and nothing is broken.)",
    };
  }
  return {
    kind: "running-behind",
    observedFps,
    suggestion:
      "The machine cannot keep the project rate: frames are rendering, slowly. Reduce ray/kernel steps, resolutions or point counts — the performance pane says which pass is paying.",
  };
}
