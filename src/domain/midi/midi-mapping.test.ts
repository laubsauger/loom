import { describe, expect, it } from "vitest";

import {
  decodeMidiMessage,
  describeMidiSource,
  midiBindingValue,
  midiChannelName,
  midiSourceKey,
  midiSourceMax,
  parseMidiMapping,
  serialiseMidiMapping,
  type MidiBinding,
} from "./midi-mapping.ts";

/**
 * T942 tier 1 — the decode and the mapping, where "what we support" stops being prose.
 *
 * The brief's instruction was: pitch bend and 14-bit CCs exist, so SAY what is supported
 * and what is not rather than silently mangling them. A module note saying so is a claim;
 * this file is the part that cannot rot, and it asserts the claim from BOTH sides — that
 * the supported messages decode at full resolution, AND that every unsupported one decodes
 * to NOTHING rather than to something plausible.
 *
 * That second direction is the whole point (§V461, §V537). A decoder that returned "some
 * number" for a note-on would pass every positive assertion here and would produce a
 * learnable control whose behaviour no documentation explains — which is precisely the
 * TouchDesigner failure the plan's §3.1(iv) catalogues: a plausible value with nothing said.
 */

const cc = (channel: number, number: number, value: number): Uint8Array =>
  new Uint8Array([0xb0 | (channel - 1), number, value]);

describe("decode — 7-bit Control Change, the case every knob and fader sends", () => {
  it("carries channel, controller number and value, with the channel 1-based", () => {
    // 1-based because that is how the hardware and every DAW number it; the wire is
    // 0-based, and translating at the boundary is what keeps "CC 74 ch 1" honest.
    expect(decodeMidiMessage(cc(1, 74, 100))).toEqual({
      source: { kind: "cc", channel: 1, number: 74 },
      raw: 100,
    });
    expect(decodeMidiMessage(cc(16, 7, 0))).toEqual({
      source: { kind: "cc", channel: 16, number: 7 },
      raw: 0,
    });
  });

  it("full scale is 127, so 0..127 maps to exactly 0..1", () => {
    expect(midiSourceMax("cc")).toBe(127);
  });
});

describe("decode — pitch bend at its real 14-bit resolution, not truncated to 7", () => {
  /*
   * The one place a lazy decoder mangles silently: pitch bend carries LSB then MSB, and
   * reading only `data[2]` gives a value that looks correct at the extremes and is wrong
   * by up to 127 steps everywhere in between. These three assertions cannot all pass on a
   * 7-bit read.
   */
  it("centre is 8192, not 64", () => {
    expect(decodeMidiMessage(new Uint8Array([0xe0, 0x00, 0x40]))).toEqual({
      source: { kind: "pitchBend", channel: 1 },
      raw: 8192,
    });
  });

  it("the LSB moves the value — a 7-bit read would report the same number for both", () => {
    const low = decodeMidiMessage(new Uint8Array([0xe0, 0x00, 0x40]))?.raw;
    const high = decodeMidiMessage(new Uint8Array([0xe0, 0x7f, 0x40]))?.raw;
    expect(low).toBe(8192);
    expect(high).toBe(8319);
    expect(high).not.toBe(low);
  });

  it("full scale is 16383 — normalising by 127 would clip at a fourteenth of travel", () => {
    expect(midiSourceMax("pitchBend")).toBe(16383);
    expect(decodeMidiMessage(new Uint8Array([0xe0, 0x7f, 0x7f]))?.raw).toBe(16383);
  });
});

describe("decode — everything out of scope decodes to NOTHING, never to something", () => {
  /*
   * Each of these is a message this row deliberately does not read. Returning null means
   * it can never be learned and can never publish: an unsupported control does nothing at
   * all, which is a state the user can diagnose, where "a control that behaves oddly" is
   * not.
   */
  it("note on and note off", () => {
    expect(decodeMidiMessage(new Uint8Array([0x90, 60, 100]))).toBeNull();
    expect(decodeMidiMessage(new Uint8Array([0x80, 60, 0]))).toBeNull();
  });

  it("MIDI clock and transport", () => {
    expect(decodeMidiMessage(new Uint8Array([0xf8]))).toBeNull();
    expect(decodeMidiMessage(new Uint8Array([0xfa, 0x00]))).toBeNull();
  });

  it("aftertouch, program change and SysEx", () => {
    expect(decodeMidiMessage(new Uint8Array([0xa0, 60, 90]))).toBeNull();
    expect(decodeMidiMessage(new Uint8Array([0xd0, 90]))).toBeNull();
    expect(decodeMidiMessage(new Uint8Array([0xc0, 3]))).toBeNull();
    expect(decodeMidiMessage(new Uint8Array([0xf0, 0x7e, 0xf7]))).toBeNull();
  });

  it("a truncated or absent message", () => {
    expect(decodeMidiMessage(new Uint8Array([0xb0, 74]))).toBeNull();
    expect(decodeMidiMessage(new Uint8Array([]))).toBeNull();
    expect(decodeMidiMessage(null)).toBeNull();
  });

  /**
   * The 14-bit CC pair, stated as a LIMIT rather than left to be discovered.
   *
   * A device sending 14-bit CC puts the MSB on cc N and the LSB on cc N+32. We do not
   * reassemble them, so BOTH arrive as ordinary independent 7-bit controls — the MSB is
   * the one to learn (coarse but correct), and the LSB is a real control that sweeps many
   * times per knob turn. This asserts the actual behaviour so nobody has to guess whether
   * the module note is still true.
   */
  it("a 14-bit CC pair arrives as two SEPARATE 7-bit controls, not one 14-bit control", () => {
    expect(decodeMidiMessage(cc(1, 10, 64))).toEqual({
      source: { kind: "cc", channel: 1, number: 10 },
      raw: 64,
    });
    expect(decodeMidiMessage(cc(1, 42, 127))).toEqual({
      source: { kind: "cc", channel: 1, number: 42 },
      raw: 127,
    });
  });
});

describe("channel names — the spelling three surfaces have to agree on", () => {
  it("uses a dot inside the leaf, because the colon is the value graph's own separator", () => {
    // `midi1:cutoff` addresses a node's channel. A colon inside the leaf would make an
    // address read as three levels when it is two.
    expect(midiSourceKey({ kind: "cc", channel: 1, number: 74 })).toBe("cc1.74");
    expect(midiSourceKey({ kind: "pitchBend", channel: 3 })).toBe("bend3");
  });

  it("an empty device reads the ANY-device name, so a fresh node works on first plug-in", () => {
    expect(midiChannelName("", { kind: "cc", channel: 1, number: 74 })).toBe("midi:*:cc1.74");
    expect(midiChannelName("port-7", { kind: "cc", channel: 1, number: 74 })).toBe("midi:port-7:cc1.74");
  });
});

const absolute = (range: readonly [number, number], rest?: number): MidiBinding => ({
  channel: "cutoff",
  source: { kind: "cc", channel: 1, number: 74 },
  range,
  mode: "absolute",
  ...(rest === undefined ? {} : { rest }),
});

describe("normalisation — 0..127 becomes 0..1, and the raw value stays reachable", () => {
  it("maps the controller's travel across the range", () => {
    const state = {};
    expect(midiBindingValue(absolute([0, 1]), 0, state)).toBe(0);
    expect(midiBindingValue(absolute([0, 1]), 127, state)).toBe(1);
    expect(midiBindingValue(absolute([0, 1]), 64, state)).toBeCloseTo(64 / 127, 10);
  });

  it("a range of 0..127 IS the raw value — no second channel needed for it", () => {
    // The brief asked for the raw value to be reachable. It is, through the mechanism that
    // already exists rather than by doubling the size of every bag with a `<name>Raw`.
    const state = {};
    expect(midiBindingValue(absolute([0, 127]), 97, state)).toBeCloseTo(97, 10);
  });

  it("range maps the useful band ONCE, at the source (§T738's lesson)", () => {
    // §T738 measured what happens when every user rebuilds a gain+bias chain per control.
    // A band declared in the binding is what stops that repeating for MIDI.
    const state = {};
    expect(midiBindingValue(absolute([2, 10]), 127, state)).toBeCloseTo(10, 10);
    expect(midiBindingValue(absolute([2, 10]), 0, state)).toBeCloseTo(2, 10);
  });

  it("an inverted range is honoured rather than sorted — a reversed fader is a real ask", () => {
    const state = {};
    expect(midiBindingValue(absolute([1, 0]), 127, state)).toBeCloseTo(0, 10);
  });
});

describe("ABSENT hardware publishes REST, never a blind zero and never nothing", () => {
  /*
   * §V353: deterministic silence is the declared rest value, not all-zeros and not an
   * absent bag. §T715: the node always publishes its output type, so a document loads and
   * renders on a machine with nothing plugged in. These are the assertions that make the
   * degraded path a behaviour rather than an intention.
   */
  it("falls to range[0] with nothing declared — a fader rests closed", () => {
    expect(midiBindingValue(absolute([0, 1]), undefined, {})).toBe(0);
    expect(midiBindingValue(absolute([2, 10]), undefined, {})).toBe(2);
  });

  it("falls to REST when one is declared — a centre-detented knob rests at centre", () => {
    // The case a blind zero gets wrong: a pitch bend or a bipolar knob at 0 is hard left,
    // and a graph that opens hard left is a picture nobody asked for.
    expect(midiBindingValue(absolute([-1, 1], 0), undefined, {})).toBe(0);
  });

  it("returns a NUMBER, never undefined — an absent channel would dangle every driven slot", () => {
    expect(Number.isFinite(midiBindingValue(absolute([0, 1]), undefined, {}))).toBe(true);
  });
});

describe("toggle — a momentary pad latches, and only on the RISING edge", () => {
  const toggle: MidiBinding = { ...absolute([0, 1]), mode: "toggle" };

  it("flips once per press, not once per message", () => {
    const state: Record<string, unknown> = {};
    expect(midiBindingValue(toggle, 0, state)).toBe(0);
    expect(midiBindingValue(toggle, 127, state)).toBe(1);
    // A pad held down sends nothing more, but a fader shoved up sends a stream; either
    // way a second high reading must not flip it back.
    expect(midiBindingValue(toggle, 120, state)).toBe(1);
    expect(midiBindingValue(toggle, 0, state)).toBe(1);
    expect(midiBindingValue(toggle, 127, state)).toBe(0);
  });

  it("absent hardware reports rest WITHOUT clearing the latch", () => {
    // Unplugging must not silently un-toggle something. The channel reports its rest while
    // the device is gone and resumes where it was.
    const state: Record<string, unknown> = {};
    midiBindingValue(toggle, 127, state);
    expect(midiBindingValue(toggle, undefined, state)).toBe(0);
    expect(midiBindingValue(toggle, 100, state)).toBe(1);
  });

  it("two controls latch independently — the state is keyed by channel name", () => {
    const state: Record<string, unknown> = {};
    midiBindingValue({ ...toggle, channel: "a" }, 127, state);
    expect(midiBindingValue({ ...toggle, channel: "b" }, 0, state)).toBe(0);
    expect(midiBindingValue({ ...toggle, channel: "a" }, 0, state)).toBe(1);
  });
});

describe("the stored mapping — tolerant, and LOUD about what it could not read", () => {
  it("round-trips through the stored form", () => {
    const bindings: MidiBinding[] = [
      { channel: "cutoff", source: { kind: "cc", channel: 1, number: 74 }, range: [0, 1], mode: "absolute" },
      { channel: "bend", source: { kind: "pitchBend", channel: 1 }, range: [-1, 1], mode: "absolute", rest: 0 },
    ];
    expect(parseMidiMapping(serialiseMidiMapping(bindings)).bindings).toEqual(bindings);
  });

  it("an empty or absent mapping is not a problem — a fresh node has learned nothing", () => {
    expect(parseMidiMapping("")).toEqual({ bindings: [], error: null });
    expect(parseMidiMapping("[]")).toEqual({ bindings: [], error: null });
    expect(parseMidiMapping(undefined)).toEqual({ bindings: [], error: null });
  });

  it("unparseable JSON reports a REASON instead of quietly becoming empty", () => {
    // §V338/§V469: a detected problem nobody is told about is indistinguishable from a
    // broken app, and "every channel reads its rest value" is exactly that shape.
    expect(parseMidiMapping("[{").error).toBe("Mapping is not valid JSON.");
    expect(parseMidiMapping('{"channel":"a"}').error).toBe("Mapping must be a list of controls.");
  });

  it("a duplicate name is refused BY NAME — a name is an address (§V129)", () => {
    const stored = JSON.stringify([{ channel: "cutoff" }, { channel: "cutoff" }]);
    expect(parseMidiMapping(stored).error).toContain("cutoff");
  });

  it("an unlearned row survives the round trip, so a named control can wait for its knob", () => {
    const stored = JSON.stringify([{ channel: "cutoff", range: [0, 1], mode: "absolute" }]);
    const parsed = parseMidiMapping(stored);
    expect(parsed.error).toBeNull();
    expect(parsed.bindings[0]?.source).toBeNull();
    expect(describeMidiSource(parsed.bindings[0]?.source ?? null)).toBe("Not learned");
  });

  it("clamps a nonsense source rather than publishing under an impossible name", () => {
    const stored = JSON.stringify([
      { channel: "a", source: { kind: "cc", channel: 99, number: 999 }, range: [0, 1], mode: "absolute" },
    ]);
    expect(parseMidiMapping(stored).bindings[0]?.source).toEqual({ kind: "cc", channel: 16, number: 127 });
  });
});
