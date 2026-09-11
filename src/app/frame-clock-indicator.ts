import type { FrameClockVerdict } from "@runtime/telemetry/frame-clock.ts";

/**
 * T1300 — THE PERMANENT REALTIME INDICATOR, as a reading rather than a component.
 *
 * The owner: *"the 'running behind' text is silly and breaks the layout when it appears.
 * instead I want an indicator that is already there and shows 'Realtime' with an indicator
 * in front that makes it clear whether we're achieving realtime = set frame rate or above
 * or not."*
 *
 * It broke the layout twice over. The notice was conditional, so it appeared and
 * disappeared inside a flex row; and it named a class (`clockNotice`) the stylesheet never
 * defined, so it arrived unstyled and at whatever width its prose happened to be. The
 * field it now replaces is ALWAYS present and reserves a box, which is the same lesson
 * `.value` already carries (T1010/B — reserve a box, do not hope the content keeps its
 * width).
 *
 * ## Why this is a module and not four lines inside the .tsx
 *
 * The reserved width has to be derived from the WIDEST WORD THIS CAN RENDER, and the gate
 * that derives it (`readout-stability.test.ts`) runs headless — it cannot import a `.tsx`.
 * So the words live here, in the one place both the component and the gate read. The
 * descriptions live here for a second reason: §V90's copy guard scans rendered `.tsx`, and
 * prose belongs in `.ts` logic.
 *
 * ## What the dot means, and what it deliberately does NOT say
 *
 * The dot answers ONE question — realtime or not — because that is the question that was
 * asked. Green is yes; anything else is no, and the colour then says whose fault (see
 * `frame-clock.ts`: the kinds are the diagnosis, `realtime` is the answer).
 *
 * It carries no NUMBER. `fps` sits immediately to its left in the same strip showing the
 * rate actually achieved, so a person at 31 of 60 reads the shortfall off the neighbour
 * rather than off a second copy of it here (§V90). Putting the figure in both places would
 * be the same fact spelled twice, two inches apart, and would un-fix the layout: a number
 * is the thing that changes width.
 */
export type FrameClockIndicatorState = "realtime" | "behind" | "throttled" | "paused";

export interface FrameClockIndicator {
  readonly state: FrameClockIndicatorState;
  /** The rendered word. The reserved width is derived from the longest of these. */
  readonly word: string;
  /** Tooltip body. The verdict's own `suggestion` wherever it has one. */
  readonly description: string;
}

/**
 * Every word the indicator can render. `readout-stability.test.ts` sizes the reserved box
 * from the longest of these, so adding a longer one fails that gate rather than shoving
 * the readout's neighbours sideways.
 */
export const FRAME_CLOCK_WORDS: Readonly<Record<FrameClockIndicatorState, string>> = {
  realtime: "Realtime",
  behind: "Behind",
  throttled: "Throttled",
  paused: "Paused",
};

/** Nothing is rendering, so there is no rate to judge. */
const PAUSED_DESCRIPTION = "The transport is stopped — press play.";

/** At or above the project frame rate, within the window's own counting resolution. */
const REALTIME_DESCRIPTION = "Rendering at the project frame rate or above.";

export function frameClockIndicator(verdict: FrameClockVerdict): FrameClockIndicator {
  if (verdict.kind === "paused") {
    return { state: "paused", word: FRAME_CLOCK_WORDS.paused, description: PAUSED_DESCRIPTION };
  }
  if (verdict.realtime) {
    return { state: "realtime", word: FRAME_CLOCK_WORDS.realtime, description: REALTIME_DESCRIPTION };
  }
  // Not realtime. `kind` says why, and the two collapsed-cadence kinds already carry the
  // remedy — the verdict is the one home for that guidance (§V437), not this file.
  if (verdict.kind === "browser-throttled") {
    return { state: "throttled", word: FRAME_CLOCK_WORDS.throttled, description: verdict.suggestion };
  }
  if (verdict.kind === "running-behind") {
    return { state: "behind", word: FRAME_CLOCK_WORDS.behind, description: verdict.suggestion };
  }
  /*
   * `live` but under the project rate — the whole band between half rate and full rate
   * that the strip used to show NOTHING for, which is the owner's "what does live even
   * mean then". It reads exactly as behind, because it is: the clock is running and the
   * machine is not keeping the rate. The suggestion is the same machine-side remedy
   * `running-behind` carries, so this says the short form and leaves the detail to the
   * performance pane it names.
   */
  return {
    state: "behind",
    word: FRAME_CLOCK_WORDS.behind,
    description: "Below the project frame rate — the fps beside this is the rate being achieved. The performance pane says which pass is paying.",
  };
}
