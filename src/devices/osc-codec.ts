/**
 * OSC 1.0 ON THE WIRE, BOTH DIRECTIONS (T942 tier 3).
 *
 * ## Why this is a file and not a dependency
 *
 * Same argument `./transport/loopback-ws.ts` made for RFC 6455: this codec runs inside the
 * local helper process, and OSC 1.0 is a hundred lines of big-endian reads with 4-byte
 * padding. Adding a package to widen what runs there, for that, is the trade the bridge
 * already refused once.
 *
 * ## WHERE THIS RUNS, AND WHY THE PAGE NEVER SEES A BYTE OF IT
 *
 * The helper decodes ingress into NAMED NUMBERS before anything crosses the loopback
 * socket, and encodes egress from named numbers after it. So the page speaks
 * `{ address, args: number[] }` and never OSC — which is not a convenience, it is the
 * §V37 rule with a new sender: an OSC packet arrives from anything on this machine that
 * can address a UDP port, and the fewer layers that treat it as structure the better.
 *
 * ## WHAT IS DECODED, STATED RATHER THAN DISCOVERED (§T959's rule, copied)
 *
 *  - `i` int32, `f` float32, `d` float64, `h` int64 (as a Number — see below), `T`/`F`
 *    booleans as 1/0, `c` char as its code point. All become NUMBERS, which is the whole
 *    of what the value graph is (`Record<string, number>`).
 *  - `s`/`S` strings, `b` blobs, `N` null, `I` infinitum, `t` timetag and every unknown
 *    tag are SKIPPED — their bytes are consumed so the arguments after them still line
 *    up, and they contribute no channel. The value graph carries no strings and widening
 *    it is a change to every value node (the plan's §5.2); a string that silently became
 *    a number would be worse than one that is absent.
 *  - `h` (int64) is read as a float64 and therefore loses precision past 2^53. It is
 *    decoded rather than skipped because the only senders that use it use it for counters
 *    and ids, and NOT decoding it would drop a whole argument's position; the precision
 *    limit is stated here rather than hidden.
 *
 * ## BUNDLES ARE FLATTENED AND THEIR TIME TAGS ARE IGNORED, DELIBERATELY
 *
 * A bundle's time tag asks a receiver to schedule. We have no scheduler on this side and
 * inventing one would put an OSC sender in charge of when a frame reads a value — so
 * every element is dispatched immediately, in order, and the time tag is dropped. What
 * this costs is real (a sender using bundles for sample-accurate timing gets frame-rate
 * timing instead) and it is the same trade the frame boundary already imposes on MIDI.
 *
 * ## A MALFORMED PACKET YIELDS NOTHING, NEVER A GUESS
 *
 * Every read is bounds-checked against the buffer and a short or ragged packet returns the
 * messages decoded SO FAR plus a reason. Partial credit is right here and wrong in a
 * frame codec: a UDP datagram is one packet from one sender, and a bundle whose third
 * element is truncated still carries two the sender meant.
 */

import { isPublishableOscAddress } from "../domain/osc/osc-address.ts";

/** One decoded message: where it was addressed, and its NUMERIC arguments in order. */
export interface OscMessage {
  readonly address: string;
  /** Only the arguments that are numbers. Strings and blobs are dropped — see the note. */
  readonly args: readonly number[];
}

export interface OscDecodeResult {
  readonly messages: readonly OscMessage[];
  /** One sentence naming the FIRST thing that did not parse, or null. */
  readonly error: string | null;
}

const BUNDLE_TAG = "#bundle";

/** OSC pads every unit to a multiple of four. */
function padded(length: number): number {
  return (length + 3) & ~3;
}

/**
 * Reads a null-terminated, 4-byte-padded OSC string.
 *
 * Returns null when the string is unterminated inside the buffer, which is the one case a
 * caller must not paper over: an unterminated address means the rest of the packet's
 * offsets are unknowable, not merely that one field is odd.
 */
function readString(bytes: Uint8Array, offset: number): { value: string; next: number } | null {
  let end = offset;
  while (end < bytes.length && bytes[end] !== 0) end += 1;
  if (end >= bytes.length) return null;
  let value = "";
  for (let index = offset; index < end; index += 1) value += String.fromCharCode(bytes[index] ?? 0);
  return { value, next: offset + padded(end - offset + 1) };
}

interface Reader {
  readonly bytes: Uint8Array;
  readonly view: DataView;
}

function decodeMessage(reader: Reader, start: number, end: number): OscMessage | string {
  const address = readString(reader.bytes, start);
  if (address === null || address.next > end) return "an OSC address is not terminated";
  const tags = readString(reader.bytes, address.next);
  if (tags === null || tags.next > end) return `${address.value} has no type tag string`;
  if (!tags.value.startsWith(",")) return `${address.value} has a malformed type tag string`;
  const args: number[] = [];
  let offset = tags.next;
  for (const tag of tags.value.slice(1)) {
    switch (tag) {
      case "i": {
        if (offset + 4 > end) return `${address.value} ends inside an int argument`;
        args.push(reader.view.getInt32(offset, false));
        offset += 4;
        break;
      }
      case "f": {
        if (offset + 4 > end) return `${address.value} ends inside a float argument`;
        args.push(reader.view.getFloat32(offset, false));
        offset += 4;
        break;
      }
      case "d": {
        if (offset + 8 > end) return `${address.value} ends inside a double argument`;
        args.push(reader.view.getFloat64(offset, false));
        offset += 8;
        break;
      }
      case "h": {
        if (offset + 8 > end) return `${address.value} ends inside an int64 argument`;
        // Precision past 2^53 is lost, and the module note says so rather than this being
        // a surprise found later by whoever sends a large id.
        args.push(Number(reader.view.getBigInt64(offset, false)));
        offset += 8;
        break;
      }
      case "c": {
        if (offset + 4 > end) return `${address.value} ends inside a char argument`;
        args.push(reader.view.getInt32(offset, false));
        offset += 4;
        break;
      }
      case "T":
        args.push(1);
        break;
      case "F":
        args.push(0);
        break;
      case "N":
      case "I":
        // Zero bytes on the wire and no number to publish: the argument holds its POSITION
        // (so `/xy` with `N` then `f` still puts the float at index 1) and contributes
        // nothing. Pushing a zero here would make "no value" indistinguishable from zero.
        args.push(Number.NaN);
        break;
      case "t": {
        if (offset + 8 > end) return `${address.value} ends inside a time tag argument`;
        offset += 8;
        args.push(Number.NaN);
        break;
      }
      case "s":
      case "S": {
        const text = readString(reader.bytes, offset);
        if (text === null || text.next > end) return `${address.value} ends inside a string argument`;
        offset = text.next;
        args.push(Number.NaN);
        break;
      }
      case "b": {
        if (offset + 4 > end) return `${address.value} ends inside a blob argument`;
        const size = reader.view.getInt32(offset, false);
        if (size < 0 || offset + 4 + padded(size) > end) return `${address.value} has a blob that does not fit`;
        offset += 4 + padded(size);
        args.push(Number.NaN);
        break;
      }
      default:
        // An unknown tag has an unknown WIDTH, so the arguments after it cannot be located.
        // Stopping is the only honest answer; guessing four bytes would silently misread
        // everything that followed.
        return `${address.value} uses an OSC type tag this build does not know (${tag})`;
    }
  }
  return { address: address.value, args };
}

/**
 * One datagram to messages.
 *
 * Bundles are flattened depth-first, in wire order, with their time tags discarded (see
 * the module note). The returned `error` is advisory: `messages` still carries everything
 * decoded before the problem, because a UDP datagram is one sender's whole intent and
 * throwing the readable half away helps nobody.
 */
export function decodeOscPacket(bytes: Uint8Array): OscDecodeResult {
  const messages: OscMessage[] = [];
  const reader: Reader = {
    bytes,
    view: new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
  };

  const walk = (start: number, end: number, depth: number): string | null => {
    if (end - start < 4) return "an OSC packet is too short to contain anything";
    // A bundle is recursive and a hostile (or merely broken) sender can nest without
    // bound. Sixteen is far past any real bundle and is a cap rather than a stack trace.
    if (depth > 16) return "an OSC bundle is nested more deeply than this build will follow";
    const head = readString(bytes, start);
    if (head !== null && head.value === BUNDLE_TAG) {
      let offset = head.next + 8; // the time tag, read and dropped
      while (offset < end) {
        if (offset + 4 > end) return "an OSC bundle element has no length";
        const size = reader.view.getInt32(offset, false);
        if (size < 0 || offset + 4 + size > end) return "an OSC bundle element does not fit its packet";
        const failure = walk(offset + 4, offset + 4 + size, depth + 1);
        if (failure !== null) return failure;
        offset += 4 + size;
      }
      return null;
    }
    const decoded = decodeMessage(reader, start, end);
    if (typeof decoded === "string") return decoded;
    messages.push(decoded);
    return null;
  };

  const error = walk(0, bytes.length, 0);
  return { messages, error };
}

/**
 * Named numbers to one OSC message.
 *
 * Every argument goes out as `f` (float32), which is what an OSC receiver overwhelmingly
 * expects from a control source and what the value graph holds — a `Record<string,
 * number>` has no int/float distinction to preserve, so inventing one at the wire would be
 * a guess about the receiver rather than a fact about the data.
 *
 * A non-finite argument is REFUSED rather than encoded: `NaN` over the wire is a value a
 * receiver will happily apply to a fader, and it is exactly the shape a missing channel
 * takes on the way here.
 */
export function encodeOscMessage(address: string, args: readonly number[]): Uint8Array | null {
  if (!isPublishableOscAddress(address)) return null;
  if (args.some((value) => !Number.isFinite(value))) return null;
  const tags = `,${"f".repeat(args.length)}`;
  const addressBytes = padded(address.length + 1);
  const tagBytes = padded(tags.length + 1);
  const out = new Uint8Array(addressBytes + tagBytes + args.length * 4);
  const view = new DataView(out.buffer);
  for (let index = 0; index < address.length; index += 1) out[index] = address.charCodeAt(index) & 0x7f;
  for (let index = 0; index < tags.length; index += 1) out[addressBytes + index] = tags.charCodeAt(index) & 0x7f;
  let offset = addressBytes + tagBytes;
  for (const value of args) {
    view.setFloat32(offset, value, false);
    offset += 4;
  }
  return out;
}
