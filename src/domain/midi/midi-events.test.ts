import { describe, expect, it } from "vitest";

import {
  appendMidiEvent,
  MIDI_EVENT_RING,
  midiEventCountName,
  midiEventName,
  packMidiEvent,
  readMidiEvents,
  unpackMidiEvent,
} from "./midi-events.ts";

/** A session's store, as the hook keeps it: names to numbers. */
function ring(device = "") {
  const store = new Map<string, number>();
  let count = 0;
  return {
    send(...bytes: number[]): void {
      const packed = packMidiEvent(Uint8Array.from(bytes));
      if (packed !== null) count = appendMidiEvent((name, value) => void store.set(name, value), device, count, packed);
    },
    channels: (name: string): number | undefined => store.get(name),
  };
}

describe("the MIDI event ring (T1762b)", () => {
  it("packs a channel-voice message into one number and back, and nothing else", () => {
    expect(unpackMidiEvent(packMidiEvent(Uint8Array.from([0x92, 60, 100])) as number)).toEqual({ kind: 0x90, channel: 3, data1: 60, data2: 100 });
    expect(unpackMidiEvent(packMidiEvent(Uint8Array.from([0xb0, 64, 127])) as number)).toEqual({ kind: 0xb0, channel: 1, data1: 64, data2: 127 });
    // Channel pressure is two bytes.
    expect(unpackMidiEvent(packMidiEvent(Uint8Array.from([0xdf, 90])) as number)).toEqual({ kind: 0xd0, channel: 16, data1: 90, data2: 0 });
    // Clock, SysEx, a truncated note and nothing at all are not events.
    for (const bytes of [[0xf8], [0xf0, 1, 2, 0xf7], [0x90, 60], []]) expect(packMidiEvent(Uint8Array.from(bytes))).toBeNull();
    expect(packMidiEvent(null)).toBeNull();
  });

  it("is spelled `midi:<device>:events` and `midi:<device>:event.<slot>`, `*` for any device", () => {
    expect(midiEventCountName("")).toBe("midi:*:events");
    expect(midiEventCountName("port-7")).toBe("midi:port-7:events");
    expect(midiEventName("", 5)).toBe("midi:*:event.5");
    expect(midiEventName("port-7", MIDI_EVENT_RING + 5)).toBe("midi:port-7:event.5");
  });

  it("a reader gets every message since it last looked, in the order they arrived", () => {
    const session = ring();
    session.send(0x90, 60, 100);
    const first = readMidiEvents(session.channels, "", 0);
    expect(first.events.map((event) => [event.kind, event.data1, event.data2])).toEqual([[0x90, 60, 100]]);
    session.send(0xb0, 64, 127);
    session.send(0x80, 60, 40);
    session.send(0x90, 60, 80);
    const second = readMidiEvents(session.channels, "", first.cursor);
    expect(second.events.map((event) => [event.kind, event.data1, event.data2])).toEqual([
      [0xb0, 64, 127],
      [0x80, 60, 40],
      [0x90, 60, 80],
    ]);
    expect(readMidiEvents(session.channels, "", second.cursor).events).toEqual([]);
  });

  it("a reader's FIRST look starts from now: what was played before it existed is not its to act on", () => {
    const session = ring();
    session.send(0x90, 60, 100);
    const first = readMidiEvents(session.channels, "", undefined);
    expect(first.events).toEqual([]);
    session.send(0x90, 64, 100);
    expect(readMidiEvents(session.channels, "", first.cursor).events.map((event) => event.data1)).toEqual([64]);
  });

  it("with no session behind it there is nothing to read, and that is not an error", () => {
    expect(readMidiEvents(undefined, "", undefined)).toEqual({ events: [], cursor: 0 });
    expect(readMidiEvents(() => undefined, "", 12)).toEqual({ events: [], cursor: 12 });
  });

  it("a reader a whole ring behind reads the newest ring's worth, oldest first", () => {
    const session = ring();
    for (let index = 0; index < MIDI_EVENT_RING + 10; index += 1) session.send(0xb0, 1, index % 128);
    const read = readMidiEvents(session.channels, "", 0);
    expect(read.events).toHaveLength(MIDI_EVENT_RING);
    expect(read.events[0]?.data2).toBe(10 % 128);
    expect(read.cursor).toBe(MIDI_EVENT_RING + 10);
  });
});
