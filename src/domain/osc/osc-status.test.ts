import { describe, expect, it } from "vitest";
import { DEVICE_HELPER_COMMAND } from "@devices/helper.ts";

import { OSC_COPY_LIMIT, oscStatusLine, type OscBridgeState } from "./osc-status.ts";

/**
 * T942 tier 3 — §V359 as a test: the reasons must be DIFFERENT SENTENCES.
 *
 * "There is no OSC" has seven causes and each one needs a different thing from the reader.
 * The failure this file exists to prevent is the one the plan found all over
 * TouchDesigner's I/O operators and §V359 names directly: an unavailable thing rendered as
 * the same nothing as a forgotten one, so "you have not started the helper" and "nobody
 * built this" are the same pixels.
 *
 * The cap matters here for a second reason since the owner's node-surface ruling: this
 * copy reaches the user through a DIAGNOSTIC rather than a panel, and a diagnostic row is
 * chrome too.
 */

const STATES: readonly OscBridgeState[] = [
  { kind: "idle" },
  { kind: "connecting" },
  { kind: "attached" },
  { kind: "listening", ports: [9000] },
  { kind: "refused", reason: "that pairing code does not match" },
  { kind: "unreachable" },
  { kind: "error", reason: "EADDRINUSE" },
];

describe("§V359 — the reasons are distinguishable, not one shared nothing", () => {
  it("no two states read the same", () => {
    // Both directions (§V461): a function returning one string for everything would pass
    // every individual assertion below and would be the same as saying nothing.
    const lines = STATES.map((state) => JSON.stringify(oscStatusLine(state, 0)));
    expect(new Set(lines).size).toBe(STATES.length);
  });

  it("the two most easily collapsed pair — no helper vs helper-with-no-port — differ", () => {
    // In a live room these need opposite actions: one is "start a process", the other is
    // "set a parameter on this node". Collapsing them sends the reader to the wrong place.
    expect(oscStatusLine({ kind: "unreachable" }, 0).headline).not.toBe(
      oscStatusLine({ kind: "attached" }, 0).headline,
    );
    expect(oscStatusLine({ kind: "attached" }, 0).hint).toContain("Port");
  });

  it("listening-with-nothing-heard differs from listening-with-traffic", () => {
    // The other silent pair: the socket is open and the sender is not running, versus the
    // socket is open and working. A count is what tells them apart.
    expect(oscStatusLine({ kind: "listening", ports: [9000] }, 0).headline).not.toBe(
      oscStatusLine({ kind: "listening", ports: [9000] }, 3).headline,
    );
    expect(oscStatusLine({ kind: "listening", ports: [9000] }, 1).headline).toContain("1 address");
    expect(oscStatusLine({ kind: "listening", ports: [9000] }, 3).headline).toContain("3 addresses");
  });

  it("names the ports it is listening on, so `nothing arrives` is debuggable", () => {
    expect(oscStatusLine({ kind: "listening", ports: [9000, 9001] }, 0).headline).toContain("9000, 9001");
  });
});

describe("§T948 rule 3 — the copy says what to DO, not what is broken", () => {
  it("never says `disabled`, on any state", () => {
    // The owner's objection, exactly: "disabled on the hosted version" answers a question
    // nobody asked, and it is not even true — a local clone with the helper stopped is
    // equally limited. Gate on the CAPABILITY, and say how to get it.
    for (const state of STATES) {
      const status = oscStatusLine(state, 0);
      expect(`${status.headline} ${status.hint ?? ""}`.toLowerCase()).not.toContain("disabled");
    }
  });

  it("names the helper and the command wherever starting one is the action", () => {
    expect(oscStatusLine({ kind: "idle" }, 0).hint).toContain(DEVICE_HELPER_COMMAND);
    expect(oscStatusLine({ kind: "unreachable" }, 0).hint).toContain(DEVICE_HELPER_COMMAND);
    expect(oscStatusLine({ kind: "idle" }, 0).headline).toContain("helper");
  });

  it("points at the hand-testing tool when the socket is open and silent", () => {
    // An I/O feature nobody can exercise is one nobody trusts (§T959's rule), so the copy
    // for "listening, nothing heard" names the thing that makes something arrive.
    expect(oscStatusLine({ kind: "listening", ports: [9000] }, 0).hint).toContain("osc-send");
  });

  it("quotes the helper's own words for a refusal and a stream error", () => {
    expect(oscStatusLine({ kind: "refused", reason: "stale code" }, 0).hint).toBe("stale code");
    expect(oscStatusLine({ kind: "error", reason: "EADDRINUSE" }, 0).hint).toBe("EADDRINUSE");
  });
});

describe("§V90/§V91/§V92 — every chrome string is inside the 60-character cap", () => {
  it("headline and hint, for every state", () => {
    for (const state of STATES) {
      const status = oscStatusLine(state, 4);
      expect(status.headline.length, status.headline).toBeLessThanOrEqual(OSC_COPY_LIMIT);
      // A `refused` or `error` hint is the HELPER's own message and can be any length — it
      // is data, not chrome, in exactly the sense the copy guard's allowlist reasoning uses.
      if (state.kind === "refused" || state.kind === "error" || status.hint === null) continue;
      expect(status.hint.length, status.hint).toBeLessThanOrEqual(OSC_COPY_LIMIT);
    }
  });

  it("stays inside the cap with several ports and a large address count", () => {
    // The one headline built from data rather than written, so it is the one that can grow
    // past the cap without anybody editing a string.
    const status = oscStatusLine({ kind: "listening", ports: [9000, 9001, 9002] }, 512);
    expect(status.headline.length, status.headline).toBeLessThanOrEqual(OSC_COPY_LIMIT);
  });
});
