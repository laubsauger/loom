import { describe, expect, it } from "vitest";
import { matchesChannel, parseChannelPatterns, selectChannels } from "./channel-patterns.ts";

/**
 * T1298 — the channel-pattern core, table-driven.
 *
 * The names are real: `audioIn`'s bag, the thing a Select is most often pointed at, plus a
 * numbered set for the ranges. Every row is a claim about which channels a user gets for
 * what they typed, and in which ORDER — order is a feature (a Select reorders), so each
 * expected list is exact, never a set.
 */
const AUDIO = [
  "level", "low", "lowMid", "highMid", "high", "onset", "onsetCount", "onsetMax",
  "kick", "kickCount", "snare", "snareCount", "hat", "hatCount", "centroid",
];
const NUMBERED = ["chan1", "chan2", "chan3", "chan9", "chan10", "chan12", "chan20", "chanA"];

const select = (names: readonly string[], source: string) => selectChannels(names, parseChannelPatterns(source));

describe("selectChannels — which channels, and in what order", () => {
  it.each([
    // [what the user typed, the names, exactly what they get]
    ["*", AUDIO, AUDIO],
    ["level", AUDIO, ["level"]],
    ["high low", AUDIO, ["high", "low"]], // PATTERN order: the reorder is the point
    ["*Count", AUDIO, ["onsetCount", "kickCount", "snareCount", "hatCount"]],
    ["low*", AUDIO, ["low", "lowMid"]],
    ["?at", AUDIO, ["hat"]],
    ["[hk]*", AUDIO, ["highMid", "high", "kick", "kickCount", "hat", "hatCount"]],
    ["^*Count", AUDIO, AUDIO.filter((name) => !name.endsWith("Count"))], // opens with ^: all minus
    ["onset* ^onsetMax", AUDIO, ["onset", "onsetCount"]],
    ["kick, snare , hat", AUDIO, ["kick", "snare", "hat"]], // commas and spaces both separate
    ["level level *", AUDIO, AUDIO], // no channel twice; the rest follow in publication order
    ["chan[1-3]", NUMBERED, ["chan1", "chan2", "chan3"]],
    ["chan[9-12]", NUMBERED, ["chan9", "chan10", "chan12"]], // a NUMBER range: 10 and 12 are two digits
    ["chan[0-9]", NUMBERED, ["chan1", "chan2", "chan3", "chan9"]], // a range, one digit
    ["chan[A-Z]", NUMBERED, ["chanA"]],
    ["", AUDIO, []], // no patterns select nothing
    ["nope", AUDIO, []],
  ] as const)("%j", (source, names, expected) => {
    expect(select(names, source)).toEqual(expected);
  });
});

describe("a pattern matches the WHOLE name, never a part of it", () => {
  it("does not find `lvl` inside `level`, or `low` inside `lowMid` (the editor matchers' semantics)", () => {
    const [lvl] = parseChannelPatterns("lvl");
    const [low] = parseChannelPatterns("low");
    expect(matchesChannel("level", lvl!)).toBe(false);
    expect(matchesChannel("lowMid", low!)).toBe(false);
    expect(matchesChannel("low", low!)).toBe(true);
  });

  it("reads regex metacharacters as literal characters", () => {
    const [dotted] = parseChannelPatterns("a.b");
    expect(matchesChannel("a.b", dotted!)).toBe(true);
    expect(matchesChannel("axb", dotted!)).toBe(false);
    const [plus] = parseChannelPatterns("x+");
    expect(matchesChannel("x+", plus!)).toBe(true);
    expect(matchesChannel("xx", plus!)).toBe(false);
  });

  it("reads an unclosed bracket as a literal and a leading ^ inside one as a character", () => {
    expect(select(["a[b", "ab"], "a[b")).toEqual(["a[b"]);
    expect(select(["x", "^", "y"], "[^x]")).toEqual(["x", "^"]);
  });
});
