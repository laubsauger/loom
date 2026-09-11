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
 *
 * ## `kind` is the DIAGNOSIS. `realtime` is the ANSWER. (T1300)
 *
 * The owner, reading the header: *"if project fps is 60 and we achieve 30 what does live
 * even mean then. that's super arbitrary"*. They are right, and the name was the lie:
 * `kind: "live"` is an ALIVENESS detector — its half-rate boundary exists to separate a
 * clock the browser SUSPENDED (0-2 fps) from a clock that is RUNNING, and nothing else.
 * 30 of 60 is a running clock, so it is `live`, and it is not remotely realtime.
 *
 * So the two questions are separated rather than conflated. `realtime` answers "are we at
 * the set frame rate or above" — the thing a person actually watches — and `kind` answers
 * "if not, whose fault": the browser suspended us, the machine cannot keep up, or the
 * transport is stopped. The kinds are UNCHANGED; other readers (`src/agent/types.ts`,
 * `get_runtime_metrics`) consume them by name and widening one would be a behaviour change
 * nobody asked for.
 */
export type FrameClockVerdict =
  | { readonly kind: "live"; readonly observedFps: number; readonly realtime: boolean }
  | { readonly kind: "paused"; readonly realtime: false }
  | {
      readonly kind: "browser-throttled";
      readonly observedFps: number;
      readonly realtime: false;
      readonly suggestion: string;
    }
  | {
      readonly kind: "running-behind";
      readonly observedFps: number;
      readonly realtime: false;
      readonly suggestion: string;
    };

/** How far back a frame still counts as "recent", in ms. */
export const FRAME_CLOCK_WINDOW_MS = 1500;

/**
 * T1300 — the realtime tolerance, counted in FRAMES OF THE WINDOW, not in percent.
 *
 * `observedFps` is a COUNT of frames in a trailing 1500 ms window divided by 1.5, so it is
 * quantized to 2/3 of a frame per second and it oscillates: a loop hitting 60 fps exactly
 * holds 89 or 90 frames in the window depending only on where `now` fell between two
 * frames. A strict `observedFps >= expected` would therefore flicker on a machine that is
 * doing everything right, which is the one thing a permanent indicator must not do.
 *
 * The slack is in frames because the artefact it absorbs is in frames:
 *
 *  - CEILING of two frames — one frame of counting resolution plus one genuinely dropped
 *    frame per 1.5 seconds. That is compositor noise, not a story worth flipping the
 *    indicator for; a third dropped frame is a real and visible shortfall.
 *  - A TENTH of the frames the window should hold, so a slow project is not graded on a
 *    60 fps machine's tolerance: two frames of a 5 fps project's 7.5 is 27% of its rate.
 *  - FLOOR of half a frame, which is not a tolerance at all but a rounding rule: `recent`
 *    is an integer and the expected count is fractional (1 fps = 1.5 frames per window),
 *    so the threshold rounds to nearest rather than demanding a count no phase can reach.
 *
 * A percentage gets this exactly backwards: a flat 5% is four frames of slack at 60 fps
 * and less than one at 24, i.e. loosest where the quantization matters least. That is why
 * there is no 0.95 here.
 */
const REALTIME_SLACK_FRAMES = 2;

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
  if (!input.playing) return { kind: "paused", realtime: false };
  const cutoff = input.now - FRAME_CLOCK_WINDOW_MS;
  const recent = input.recentFrameTimes.filter((at) => at > cutoff).length;
  const observedFps = recent / (FRAME_CLOCK_WINDOW_MS / 1000);
  const expected = projectFps(input.settings);
  /* Half rate is the line: a loop merely busy renders unevenly but above it, and a
     suspended clock sits at 0-2 fps (browser timers fire ~1/s when hidden). The floor
     of 1 keeps a 2fps art project from reading as broken. This is ALIVENESS, not
     performance — `realtime` below is the performance question (T1300). */
  if (observedFps >= Math.max(1, expected * 0.5)) {
    const expectedFrames = expected * (FRAME_CLOCK_WINDOW_MS / 1000);
    const slack = Math.min(REALTIME_SLACK_FRAMES, Math.max(0.5, expectedFrames / 10));
    return { kind: "live", observedFps, realtime: recent >= expectedFrames - slack };
  }
  /* Below half rate, `realtime` is settled by construction: the realtime line sits at
     nine tenths of the project rate or higher, so there is no cadence that is both
     throttled/behind and realtime. The types say so rather than re-deriving it. */
  if (input.hidden) {
    return {
      kind: "browser-throttled",
      observedFps,
      realtime: false,
      suggestion:
        "The browser suspends the frame clock for a hidden or occluded window. Bring this window to the front. (Driving the app through automation? This is the expected state — frames advance on forced paints, and nothing is broken.)",
    };
  }
  return {
    kind: "running-behind",
    observedFps,
    realtime: false,
    suggestion:
      "The machine cannot keep the project rate: frames are rendering, slowly. Reduce ray/kernel steps, resolutions or point counts — the performance pane says which pass is paying.",
  };
}
