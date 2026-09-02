import { describe, expect, it } from "vitest";

import { decodeOscPacket, encodeOscMessage } from "./osc-codec.ts";
import { isPublishableOscAddress, oscMessageReadings } from "../domain/osc/osc-address.ts";

/**
 * OSC 1.0, BOTH DIRECTIONS (T942 tier 3).
 *
 * Every packet here is built BYTE BY BYTE rather than by calling our own encoder, wherever
 * the point is decoding: a codec tested against itself agrees with itself and can be wrong
 * in both directions at once. The round-trip test is the one place both halves meet, and
 * it is labelled as such.
 */

/** A packet built by hand, so the decoder is tested against the SPEC and not against us. */
function packet(address: string, tags: string, body: Uint8Array): Uint8Array {
  const pad = (length: number): number => (length + 3) & ~3;
  const out = new Uint8Array(pad(address.length + 1) + pad(tags.length + 1) + body.length);
  for (let index = 0; index < address.length; index += 1) out[index] = address.charCodeAt(index);
  const tagsAt = pad(address.length + 1);
  for (let index = 0; index < tags.length; index += 1) out[tagsAt + index] = tags.charCodeAt(index);
  out.set(body, tagsAt + pad(tags.length + 1));
  return out;
}

function float32(value: number): Uint8Array {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setFloat32(0, value, false);
  return bytes;
}

function int32(value: number): Uint8Array {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setInt32(0, value, false);
  return bytes;
}

describe("decoding", () => {
  it("reads a float argument big-endian, which is the only endianness OSC has", () => {
    const decoded = decodeOscPacket(packet("/synth/cutoff", ",f", float32(0.625)));
    expect(decoded.error).toBeNull();
    expect(decoded.messages).toEqual([{ address: "/synth/cutoff", args: [0.625] }]);
  });

  it("reads ints, doubles and booleans as numbers, because the value graph has only those", () => {
    const double = new Uint8Array(8);
    new DataView(double.buffer).setFloat64(0, 0.125, false);
    expect(decodeOscPacket(packet("/a", ",i", int32(42))).messages[0]?.args).toEqual([42]);
    expect(decodeOscPacket(packet("/a", ",d", double)).messages[0]?.args).toEqual([0.125]);
    // T and F occupy no bytes at all, which is the encoding wart most hand-rolled decoders
    // get wrong by advancing four.
    expect(decodeOscPacket(packet("/a", ",TFf", float32(1))).messages[0]?.args).toEqual([1, 0, 1]);
  });

  it("holds the POSITION of an argument it cannot carry, rather than renumbering the rest", () => {
    // `/pad "hi" 0.5` must still put 0.5 at index 1. Dropping the string outright would
    // silently rebind whatever learned `/pad/1` to a different value.
    const body = new Uint8Array([...Array.from(Buffer.from("hi\0\0")), ...float32(0.5)]);
    const decoded = decodeOscPacket(packet("/pad", ",sf", body));
    expect(decoded.messages[0]?.args).toHaveLength(2);
    expect(Number.isNaN(decoded.messages[0]?.args[0] as number)).toBe(true);
    expect(decoded.messages[0]?.args[1]).toBe(0.5);
    // And a non-number publishes NOTHING, rather than a zero a fader would happily take.
    expect(oscMessageReadings("/pad", decoded.messages[0]?.args ?? [])).toEqual([["osc:/pad/1", 0.5]]);
  });

  it("flattens a bundle in wire order and drops its time tag", () => {
    const first = packet("/a", ",f", float32(0.25));
    const second = packet("/b", ",f", float32(0.75));
    const head = Buffer.from("#bundle\0");
    const timetag = Buffer.alloc(8);
    const sized = (element: Uint8Array): Buffer => {
      const size = Buffer.alloc(4);
      size.writeInt32BE(element.length, 0);
      return Buffer.concat([size, Buffer.from(element)]);
    };
    const bundle = Buffer.concat([head, timetag, sized(first), sized(second)]);
    const decoded = decodeOscPacket(new Uint8Array(bundle));
    expect(decoded.error).toBeNull();
    expect(decoded.messages.map((message) => message.address)).toEqual(["/a", "/b"]);
  });

  it("stops at a type tag it does not know, because an unknown tag has an unknown WIDTH", () => {
    // Guessing four bytes would silently misread every argument after it — the §V147
    // family: plausible numbers, wrong, nothing said.
    const decoded = decodeOscPacket(packet("/a", ",Zf", float32(1)));
    expect(decoded.messages).toEqual([]);
    expect(decoded.error).toContain("type tag");
  });

  it("keeps the readable half of a ragged bundle and still names the problem", () => {
    const good = packet("/a", ",f", float32(0.25));
    const head = Buffer.from("#bundle\0");
    const size = Buffer.alloc(4);
    size.writeInt32BE(good.length, 0);
    const oversized = Buffer.alloc(4);
    oversized.writeInt32BE(9_999, 0);
    const bundle = Buffer.concat([head, Buffer.alloc(8), size, Buffer.from(good), oversized]);
    const decoded = decodeOscPacket(new Uint8Array(bundle));
    // Partial credit is right for a datagram: one sender's whole intent arrived, and
    // throwing the readable half away helps nobody.
    expect(decoded.messages.map((message) => message.address)).toEqual(["/a"]);
    expect(decoded.error).not.toBeNull();
  });

  it("returns nothing, never a guess, for bytes that are not OSC at all", () => {
    expect(decodeOscPacket(new Uint8Array([1, 2, 3])).messages).toEqual([]);
    expect(decodeOscPacket(new Uint8Array(0)).messages).toEqual([]);
  });
});

describe("addresses are attacker-controllable text (the plan's §7.4)", () => {
  it("refuses an address carrying `:`, the value graph's own name:channel separator", () => {
    // Publishing `osc:/a:b` would read as three levels where there are two. Refused at the
    // decoder, so it can never be learned and can never publish — `decodeMidiMessage`'s
    // discipline with a different wire.
    expect(isPublishableOscAddress("/a:b")).toBe(false);
    expect(oscMessageReadings("/a:b", [1])).toEqual([]);
  });

  it("refuses whitespace, control bytes, pattern characters and a missing leading slash", () => {
    for (const address of ["synth/cutoff", "/a b", "/a\u0000b", "/a*b", "/a?b", "/a[1]", "/a{x}"]) {
      expect(isPublishableOscAddress(address), address).toBe(false);
    }
    expect(isPublishableOscAddress(`/${"a".repeat(300)}`)).toBe(false);
  });

  it("publishes argument 0 under BOTH the bare address and the index", () => {
    expect(oscMessageReadings("/pad/xy", [0.2, 0.8])).toEqual([
      ["osc:/pad/xy", 0.2],
      ["osc:/pad/xy/0", 0.2],
      ["osc:/pad/xy/1", 0.8],
    ]);
  });
});

describe("encoding", () => {
  it("refuses a non-finite argument rather than putting NaN on a fader", () => {
    // This is the shape a missing upstream takes by the time it reaches the wire, and a
    // receiver will happily apply it.
    expect(encodeOscMessage("/a", [Number.NaN])).toBeNull();
    expect(encodeOscMessage("/a", [Number.POSITIVE_INFINITY])).toBeNull();
  });

  it("refuses an address it would not accept on the way IN", () => {
    // One rule, both directions: we must not emit an address we would refuse to publish.
    expect(encodeOscMessage("a", [1])).toBeNull();
    expect(encodeOscMessage("/a:b", [1])).toBeNull();
  });

  it("round-trips through our own decoder — the one place both halves meet", () => {
    const bytes = encodeOscMessage("/loom/level", [0.25, 0.5]);
    expect(bytes).not.toBeNull();
    const decoded = decodeOscPacket(bytes as Uint8Array);
    expect(decoded.error).toBeNull();
    expect(decoded.messages).toEqual([{ address: "/loom/level", args: [0.25, 0.5] }]);
  });

  it("pads every unit to four bytes, which is what a real receiver depends on", () => {
    // `/ab` is 3 characters + NUL = 4, `,f` is 2 + NUL = 3 → padded to 4, then 4 for the
    // float. A receiver reading unpadded would find the type tags inside the address.
    expect((encodeOscMessage("/ab", [1]) as Uint8Array).length).toBe(12);
    expect((encodeOscMessage("/abc", [1]) as Uint8Array).length % 4).toBe(0);
  });
});
