import { describe, expect, it } from "vitest";
import {
  eventStrokeToKeys,
  formatKeys,
  isValidKeys,
  normalizeKeys,
  parseKeys,
  strokeFromEvent,
  strokeMatches,
} from "./keys.ts";

describe("key string parsing", () => {
  it("parses modifiers and the key", () => {
    expect(parseKeys("mod+shift+z")).toEqual([
      { key: "z", mod: true, ctrl: false, alt: false, shift: true, meta: false },
    ]);
  });

  it("parses a chord as a sequence of steps", () => {
    const parsed = parseKeys("g d");
    expect(parsed?.length).toBe(2);
    expect(parsed?.[0]?.key).toBe("g");
    expect(parsed?.[1]?.key).toBe("d");
  });

  it("treats an uppercase letter as shift + the letter, so H and h are different bindings", () => {
    // TouchDesigner: H homes everything, h homes the selection. Both must exist, and
    // both must mean one unambiguous physical chord.
    expect(normalizeKeys("H")).toBe("shift+h");
    expect(normalizeKeys("h")).toBe("h");
    expect(normalizeKeys("H")).not.toBe(normalizeKeys("h"));
    expect(normalizeKeys("shift+h")).toBe(normalizeKeys("H"));
  });

  it("canonicalises aliases and modifier order", () => {
    expect(normalizeKeys("Esc")).toBe("escape");
    expect(normalizeKeys("Del")).toBe("delete");
    expect(normalizeKeys("shift+mod+z")).toBe("mod+shift+z");
    expect(normalizeKeys("Cmd+K")).toBe("meta+k");
  });

  it("rejects junk instead of binding it to nothing", () => {
    expect(parseKeys("")).toBeNull();
    expect(parseKeys("mod+")).toEqual([
      { key: "+", mod: true, ctrl: false, alt: false, shift: false, meta: false },
    ]);
    expect(parseKeys("mod+shift")).toBeNull();
    expect(parseKeys("notamodifier+z")).toBeNull();
    expect(isValidKeys("mod+z")).toBe(true);
  });
});

describe("`mod` resolves per platform", () => {
  const binding = parseKeys("mod+z")?.[0];

  it("is Cmd on macOS", () => {
    const cmdZ = strokeFromEvent({ key: "z", code: "KeyZ", metaKey: true });
    const ctrlZ = strokeFromEvent({ key: "z", code: "KeyZ", ctrlKey: true });
    expect(binding && cmdZ && strokeMatches(binding, cmdZ, "mac")).toBe(true);
    expect(binding && ctrlZ && strokeMatches(binding, ctrlZ, "mac")).toBe(false);
  });

  it("is Ctrl everywhere else", () => {
    const cmdZ = strokeFromEvent({ key: "z", code: "KeyZ", metaKey: true });
    const ctrlZ = strokeFromEvent({ key: "z", code: "KeyZ", ctrlKey: true });
    expect(binding && ctrlZ && strokeMatches(binding, ctrlZ, "other")).toBe(true);
    expect(binding && cmdZ && strokeMatches(binding, cmdZ, "other")).toBe(false);
  });

  it("requires an exact modifier match — mod+shift+z is not mod+z", () => {
    const stroke = strokeFromEvent({ key: "Z", code: "KeyZ", metaKey: true, shiftKey: true });
    expect(binding && stroke && strokeMatches(binding, stroke, "mac")).toBe(false);
  });
});

describe("reading a stroke off an event", () => {
  it("prefers the physical key so shifted digits still match", () => {
    // Shift+1 reports key "!" but code "Digit1".
    const stroke = strokeFromEvent({ key: "!", code: "Digit1", shiftKey: true });
    expect(stroke?.key).toBe("1");
    expect(stroke?.shift).toBe(true);
  });

  it("falls back to event.key when there is no code", () => {
    expect(strokeFromEvent({ key: "Escape" })?.key).toBe("escape");
    expect(strokeFromEvent({ key: " " })?.key).toBe("space");
  });
});

describe("display strings are platform-correct (§V55)", () => {
  it("uses Apple glyphs and Apple modifier order on macOS", () => {
    expect(formatKeys("mod+z", "mac")).toBe("⌘Z");
    expect(formatKeys("mod+shift+z", "mac")).toBe("⇧⌘Z");
    expect(formatKeys("ctrl+alt+shift+meta+k", "mac")).toBe("⌃⌥⇧⌘K");
    expect(formatKeys("delete", "mac")).toBe("⌦");
  });

  it("spells modifiers out elsewhere", () => {
    expect(formatKeys("mod+z", "other")).toBe("Ctrl+Z");
    expect(formatKeys("mod+shift+z", "other")).toBe("Ctrl+Shift+Z");
    expect(formatKeys("delete", "other")).toBe("Del");
  });

  it("shows a bare letter the way a TouchDesigner user reads it — H vs h", () => {
    expect(formatKeys("H", "mac")).toBe("H");
    expect(formatKeys("h", "mac")).toBe("h");
    expect(formatKeys("H", "other")).toBe("H");
    expect(formatKeys("h", "other")).toBe("h");
    // With another modifier, the shift is shown the conventional way.
    expect(formatKeys("mod+shift+h", "other")).toBe("Ctrl+Shift+H");
  });

  it("renders a chord step by step", () => {
    expect(formatKeys("g d", "other")).toBe("g d");
    expect(formatKeys("mod+k mod+s", "other")).toBe("Ctrl+K Ctrl+S");
  });
});

describe("capturing a keystroke for a rebind", () => {
  it("writes `mod` rather than the platform key, so an override travels", () => {
    const macStroke = strokeFromEvent({ key: "j", code: "KeyJ", metaKey: true });
    expect(macStroke && eventStrokeToKeys(macStroke, "mac")).toBe("mod+j");
    const winStroke = strokeFromEvent({ key: "j", code: "KeyJ", ctrlKey: true });
    expect(winStroke && eventStrokeToKeys(winStroke, "other")).toBe("mod+j");
  });
});
