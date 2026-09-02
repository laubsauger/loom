import { describe, expect, it } from "vitest";

import { MIDI_COPY_LIMIT, midiStatusLine, type MidiAccessState } from "./midi-status.ts";

/**
 * T942 tier 1 — §V359 as a test: the reasons must be DIFFERENT SENTENCES.
 *
 * "There is no MIDI" has at least six causes and each one needs a different thing from the
 * reader. The failure this file exists to prevent is the one the plan found all over
 * TouchDesigner's I/O operators and §V359 names directly: an unavailable thing rendered as
 * the same nothing as a forgotten one, so "not detected" and "nobody built this" are the
 * same pixels.
 *
 * So the assertions are: every state is covered; no two states produce the same line; the
 * copy tells the reader what to DO (§T948 rule 3); a state that cannot be retried does not
 * offer a button that pretends otherwise; and every string is inside §V90/§V91/§V92's
 * 60-character cap.
 *
 * That last one is not covered by `copy-guard.test.ts` — it excludes `src/editor/inspector`
 * by design, which is exactly where this copy would otherwise live. Hoisting the strings
 * here is what puts them back under a cap, and this is the cap.
 */

const STATES: readonly MidiAccessState[] = [
  { kind: "idle" },
  { kind: "unsupported" },
  { kind: "requesting" },
  { kind: "granted" },
  { kind: "denied" },
  { kind: "failed", message: "the port went away" },
];

describe("§V359 — the reasons are distinguishable, not one shared nothing", () => {
  it("no two states read the same", () => {
    // Both directions (§V461): a function returning one string for everything would pass
    // every individual assertion below and would be the same as saying nothing.
    const lines = STATES.map((state) => JSON.stringify(midiStatusLine(state, 0)));
    expect(new Set(lines).size).toBe(STATES.length);
  });

  it("granted-with-no-input differs from granted-with-inputs", () => {
    // The pair most easily collapsed, and the one that matters most in a live room: access
    // is on and nothing is plugged in is a DIFFERENT action from access is on and working.
    expect(midiStatusLine({ kind: "granted" }, 0).headline).not.toBe(
      midiStatusLine({ kind: "granted" }, 2).headline,
    );
    expect(midiStatusLine({ kind: "granted" }, 0).hint).toBe("Attach a controller.");
  });

  it("counts the inputs it found, singular and plural", () => {
    expect(midiStatusLine({ kind: "granted" }, 1).headline).toContain("1 input");
    expect(midiStatusLine({ kind: "granted" }, 3).headline).toContain("3 inputs");
  });
});

describe("§T948 rule 3 — the copy says what to DO, not what is broken", () => {
  it("names an action wherever there is one to name", () => {
    expect(midiStatusLine({ kind: "idle" }, 0).hint).toContain("Enable");
    expect(midiStatusLine({ kind: "denied" }, 0).hint).toContain("Allow");
    expect(midiStatusLine({ kind: "granted" }, 0).hint).toContain("Attach");
    expect(midiStatusLine({ kind: "requesting" }, 0).hint).toContain("Answer");
  });

  it("names Firefox's add-on, because there a refusal and a missing add-on are the same", () => {
    // Bugzilla 1742635: a Firefox page cannot tell a user denial from a missing
    // site-permission add-on. The honest move is to name both routes rather than to
    // assert the one we cannot know.
    expect(midiStatusLine({ kind: "denied" }, 0).hint).toContain("Firefox");
  });

  it("Safari's permanent absence offers no button, because no button would help", () => {
    // Safari has no Web MIDI at any version. A retry control here would be a promise the
    // browser cannot keep, which is worse than the honest dead end.
    const unsupported = midiStatusLine({ kind: "unsupported" }, 0);
    expect(unsupported.canRequest).toBe(false);
    expect(unsupported.hint).toContain("Chrome");
  });

  it("a state already in flight, or already working, offers no button either", () => {
    expect(midiStatusLine({ kind: "requesting" }, 0).canRequest).toBe(false);
    expect(midiStatusLine({ kind: "granted" }, 1).canRequest).toBe(false);
  });

  it("a refusal and a fault CAN be retried — a denied prompt is recoverable", () => {
    expect(midiStatusLine({ kind: "denied" }, 0).canRequest).toBe(true);
    expect(midiStatusLine({ kind: "failed", message: "boom" }, 0).canRequest).toBe(true);
  });

  it("a fault quotes the browser's own words rather than paraphrasing them", () => {
    expect(midiStatusLine({ kind: "failed", message: "the port went away" }, 0).hint).toBe(
      "the port went away",
    );
  });
});

describe("§V90/§V91/§V92 — every chrome string is inside the 60-character cap", () => {
  it("headline and hint, for every state", () => {
    for (const state of STATES) {
      const status = midiStatusLine(state, 4);
      expect(status.headline.length, status.headline).toBeLessThanOrEqual(MIDI_COPY_LIMIT);
      // A `failed` hint is the BROWSER's message and can be any length — it is data, not
      // chrome, in exactly the sense the copy guard's own allowlist reasoning uses.
      if (state.kind === "failed" || status.hint === null) continue;
      expect(status.hint.length, status.hint).toBeLessThanOrEqual(MIDI_COPY_LIMIT);
    }
  });
});
