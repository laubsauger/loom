import { describe, expect, it } from "vitest";

import { audioLatencyEstimate, describeAudioLatency } from "./audio-latency.ts";

/**
 * T1319b / §V985 — THE NUMBER THE SYNC OFFSET CONTROL HAS BEEN ASKING FOR.
 *
 * §T1312b shipped the knob with a description instructing the user to "set it by measuring
 * rather than by ear", and shipped no measurement. These are the two claims that make the
 * measurement usable rather than merely present:
 *
 *  1. It is a FLOOR and says so. `outputLatency` covers the audio path to the device and
 *     cannot see the render and display path, so a figure presented as exact would send
 *     someone who is still visibly late to the conclusion that the feature is broken.
 *  2. Unmeasurable is ABSENT, never zero (§V91). A browser that reports nothing must not be
 *     turned into a confident 0 ms suggestion at the exact moment a user wants an authority.
 */

describe("T1319b — the audio latency estimate is a floor, and says which part it cannot see", () => {
  it("sums the audio path and one frame, and rounds nothing away", () => {
    const estimate = audioLatencyEstimate({ outputLatency: 0.021, baseLatency: 0.005 }, 60);
    expect(estimate).not.toBeNull();
    expect(estimate?.outputSeconds).toBe(0.021);
    expect(estimate?.baseSeconds).toBe(0.005);
    expect(estimate?.frameSeconds).toBeCloseTo(1 / 60, 10);
    // 21 ms + 5 ms + one 60 fps frame: the suggestion, and a FLOOR on the real offset.
    expect(estimate?.suggestedSeconds).toBeCloseTo(0.021 + 0.005 + 1 / 60, 10);
  });

  it("says AT LEAST, and names the part the measurement does not cover", () => {
    const text = describeAudioLatency(audioLatencyEstimate({ outputLatency: 0.021 }, 60));
    expect(text).toContain("At least");
    // The sentence that stops someone concluding the feature is broken when they are still
    // late: the display's own lag is outside anything the browser will tell us.
    expect(text.toLowerCase()).toContain("display");
    expect(text).toContain("or more");
  });

  it("reports ABSENT rather than zero where the browser measures nothing", () => {
    // Neither field, both zero, and an undefined context: three ways to know nothing, and
    // none of them may become a 0 ms suggestion someone can apply.
    expect(audioLatencyEstimate({}, 60)).toBeNull();
    expect(audioLatencyEstimate({ outputLatency: 0, baseLatency: 0 }, 60)).toBeNull();
    expect(audioLatencyEstimate(undefined, 60)).toBeNull();

    const text = describeAudioLatency(null);
    expect(text).toContain("no audio output latency");
    // It still tells them what to do instead, rather than leaving a dead sentence.
    expect(text).toContain("by ear");
  });

  it("survives a project rate it cannot use, without inventing a frame term", () => {
    // fps 0 or NaN is a document that never declared one (§V68's shape). The audio half is
    // still a real measurement; the frame half simply is not there.
    const estimate = audioLatencyEstimate({ outputLatency: 0.02 }, 0);
    expect(estimate?.frameSeconds).toBe(0);
    expect(estimate?.suggestedSeconds).toBe(0.02);
    expect(describeAudioLatency(estimate)).not.toContain("one frame");
  });
});
