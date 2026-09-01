import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { SEEK_TOLERANCE_SECONDS, applyMediaPlayhead, type PlayableMedia } from "./media-playback.ts";
import { createMediaClock, mediaPlayhead, type MediaTransportValues } from "@domain/media/transport.ts";
import { liveClock } from "@domain/transport/live-clock.ts";

/**
 * T740 — THE AUDIO SKIP, GATED AT THE DRIFT RATHER THAN AT THE SYMPTOM.
 *
 * The owner heard it: "target fps set to 60 fps but running on battery with the browser
 * limiting to 30fps we get skips in the audio". It is a CLOCK bug. `liveClock` advanced
 * the timeline by a fixed `1/fps` per TICK, so 30 delivered ticks against a 60 fps project
 * moved the timeline half a second per real second. An `<audio>` element does not slow
 * down to match — it plays on the sound hardware's own clock — so it raced ahead and
 * `applyMediaPlayhead` seeked it back every time the gap passed `SEEK_TOLERANCE_SECONDS`.
 *
 * ⚠ THE PRINCIPLE: audio is a real-time stream and frames are SAMPLES of it. When they
 * disagree, DROP A FRAME, NEVER A SAMPLE.
 *
 * ## What this gates, and what it cannot
 *
 * No test here can listen. What it CAN do is drive the clock at a DELIVERED rate below the
 * TARGET rate and count the corrections, which is the drift itself rather than its sound.
 * MEASURED on the parent commit, 60 fps target / 30 Hz delivered: 9 seeks in 3 seconds,
 * gaps 0.300–0.333s — the prediction was "roughly every 0.3s" and it held. The 0.333 is
 * the quantisation: drift crosses the 0.15s tolerance at 0.3s but is only observed on a
 * delivered tick, 33ms apart. After the fix: zero, at every rate below.
 *
 * §V701 does not bite: there is no async in this path at all. The frame loop is driven by
 * an explicit `for`, so every tick is genuinely ordered and there is no window to own.
 */

const BASE: MediaTransportValues = {
  playMode: "timeline",
  play: true,
  speed: 1,
  cue: false,
  cuePoint: 0,
  trimStart: 0,
  trimEnd: 0,
  extend: "loop",
};

/**
 * A media element that plays on its OWN clock, which is the entire point: real seconds
 * in, real seconds of audio out, exactly as the sound hardware does it. A double that
 * advanced by the frame's delta instead could never show this bug.
 */
function playingElement(duration: number) {
  let paused = true;
  let currentTime = 0;
  const element: PlayableMedia & { advanceReal: (seconds: number) => void } = {
    get currentTime() {
      return currentTime;
    },
    set currentTime(value: number) {
      currentTime = value;
    },
    playbackRate: 1,
    get duration() {
      return duration;
    },
    get paused() {
      return paused;
    },
    play() {
      paused = false;
    },
    pause() {
      paused = true;
    },
    advanceReal(seconds: number) {
      if (!paused) currentTime += seconds * element.playbackRate;
    },
  };
  return element;
}

/**
 * `seconds` of REAL time with the browser delivering `deliveredHz` ticks per second while
 * the project asks for `fps` — the composition the owner is running, minus the GPU.
 */
function play({ fps, deliveredHz, seconds }: { fps: number; deliveredHz: number; seconds: number }) {
  const stepSeconds = 1 / deliveredHz;
  let nowMs = 0;
  const clock = liveClock({ fps, presenting: () => true, now: () => nowMs });
  const media = createMediaClock();
  const element = playingElement(60 * 60); // long enough that nothing wraps
  const seekAtSeconds: number[] = [];

  const ticks = Math.round(seconds * deliveredHz);
  let timelineSeconds = 0;
  for (let tick = 0; tick < ticks; tick += 1) {
    if (tick > 0) {
      nowMs += stepSeconds * 1000;
      element.advanceReal(stepSeconds);
    }
    const frame = clock.next();
    timelineSeconds = frame.timeSeconds;
    const elapsed = media.advance(BASE, frame.deltaSeconds, frame.timeSeconds);
    const head = mediaPlayhead(BASE, elapsed, element.duration);
    if (applyMediaPlayhead(element, BASE, head)) seekAtSeconds.push(nowMs / 1000);
  }

  return {
    seeks: seekAtSeconds.length,
    seekAtSeconds,
    wallSeconds: nowMs / 1000,
    timelineSeconds,
    heardSeconds: element.currentTime,
  };
}

describe("T740 — a throttled rAF must not skip the audio", () => {
  /**
   * The reported case, and the one the fix is named for. 30 is what Chrome and Safari
   * throttle a background or battery-saving tab to.
   */
  it("60 fps target, 30 Hz delivered: the element is never seeked (was ~every 0.33s)", () => {
    const result = play({ fps: 60, deliveredHz: 30, seconds: 10 });
    // Before the fix this was 30 — drift accruing at 0.5s per second against a 0.15s
    // tolerance. Zero is the claim: the element is left alone to play.
    expect(result.seeks).toBe(0);
    // ...and the reason it is left alone: it is where the timeline says it is.
    expect(result.heardSeconds).toBeCloseTo(result.wallSeconds, 6);
  });

  /**
   * The rate that rounding alone does NOT fix, which is why the clock carries its
   * remainder: 45/60 rounds 1.33 frames to 1 every tick and the timeline runs at 75%
   * speed — the same bug, quieter, seeking every 0.6s instead of every 0.3s.
   */
  for (const deliveredHz of [50, 45, 40, 30, 24, 20, 15]) {
    it(`60 fps target, ${String(deliveredHz)} Hz delivered: timeline tracks real time and nothing seeks`, () => {
      const result = play({ fps: 60, deliveredHz, seconds: 10 });
      expect(result.seeks).toBe(0);
      // The timeline is quantised to the frame grid, so it may sit up to half a frame off
      // real time — two orders of magnitude inside the tolerance that triggers a seek.
      expect(Math.abs(result.timelineSeconds - result.wallSeconds)).toBeLessThan(1 / 60);
      expect(Math.abs(result.timelineSeconds - result.wallSeconds)).toBeLessThan(
        SEEK_TOLERANCE_SECONDS,
      );
    });
  }

  it("the healthy case is unchanged: 60 fps target, 60 Hz delivered, no seeks", () => {
    const result = play({ fps: 60, deliveredHz: 60, seconds: 10 });
    expect(result.seeks).toBe(0);
    expect(result.heardSeconds).toBeCloseTo(result.wallSeconds, 6);
  });

  /**
   * The guard against the vacuous version. Every assertion above would also pass on a
   * clock that never moved and an element that never played, so this is the one that says
   * the harness can see a seek at all — and it is the OLD behaviour, reproduced by hand:
   * a timeline advancing at exactly half real time.
   */
  it("the harness DOES see a seek when the timeline runs at half speed (the old clock)", () => {
    const element = playingElement(3600);
    const seeks: number[] = [];
    for (let tick = 0; tick < 90; tick += 1) {
      if (tick > 0) element.advanceReal(1 / 30);
      // What the fixed step produced: one frame of a 60fps timeline per delivered tick.
      const head = mediaPlayhead(BASE, tick / 60, 3600);
      if (applyMediaPlayhead(element, BASE, head)) seeks.push(tick / 30);
    }
    expect(seeks.length).toBe(9);
    for (let index = 1; index < seeks.length; index += 1) {
      const gap = (seeks[index] as number) - (seeks[index - 1] as number);
      expect(gap).toBeGreaterThan(0.28);
      expect(gap).toBeLessThan(0.35);
    }
  });
});

/**
 * §V437 — THE REACH. Every assertion above builds its own `liveClock` and would stay green
 * on a session whose clock was never told it is presenting: the property would be
 * delivered to the transport and not to the app, which is the failure this project has now
 * found five times. `presenting` DEFAULTS TO FALSE (§V662's safe direction), so losing the
 * one line at the composition root silently restores the half-speed clock and the audio
 * skip with it — and nothing else would notice.
 */
describe("T740 — the session's clock is actually told it is presenting", () => {
  const source = readFileSync(
    fileURLToPath(new URL("./use-frame-loop.ts", import.meta.url)),
    "utf8",
  );

  it("the scan finds the construction it polices — not a green from a moved file", () => {
    expect(source).toContain("liveClock({");
  });

  it("`use-frame-loop` declares `presenting`, and binds it to whether the LOOP is running", () => {
    const call = source.slice(source.indexOf("liveClock({"));
    const construction = call.slice(0, call.indexOf("});") + 3);
    expect(construction).toContain("presenting:");
    // Bound to the scheduler, not to a constant: `presenting: () => true` would put the
    // catch-up back on the seek and the render take (see live-clock.test.ts).
    expect(construction).toContain("running");
    expect(construction).not.toMatch(/presenting:\s*\(\)\s*=>\s*true/);
  });
});
