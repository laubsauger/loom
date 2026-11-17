/**
 * T1762b — THE MIDI EVENT RING: every channel-voice message, in arrival order, readable
 * through the channel seam.
 *
 * ## Why an ordered list and not more readings
 *
 * `midi-mapping.ts` publishes a control as its LATEST value, which is all a knob is. A
 * keyboard is not that. Whether a note rings on depends on whether the key came up before
 * or after the pedal went down; two strikes of one key between two frames are two notes;
 * a note struck and released inside one frame still happened. A latest-value reading keeps
 * none of that. So notes cross the seam as what they are: the messages, in order.
 *
 * ## The seam is the one that already existed (§T942)
 *
 * `ValueEvaluateContext.channels` answers a string name with a number, and the session
 * already publishes MIDI under `midi:<port>:…`. The ring is two more spellings:
 *
 *   midi:<port>:events        how many messages this port has ever delivered
 *   midi:<port>:event.<slot>  message number n, at slot n mod `MIDI_EVENT_RING`, packed
 *
 * and the same under `*` for "any attached device", merged in arrival order. A reader keeps
 * the count it last saw and reads forward from it (`readMidiEvents`). Nothing new is plumbed,
 * and the property §T942 named carries over whole: a headless caller that feeds `channels`
 * REPLAYS a performance, and the node cannot tell.
 *
 * ## The packing
 *
 * `status · 65536 + data1 · 256 + data2`: three bytes in one integer, exact in a double.
 * Channel-voice messages only (status 0x80 to 0xEF): notes, poly and channel pressure,
 * control change, program change, pitch bend. System messages (clock, SysEx) are not events
 * here; a clock is a tempo estimator's input, which is its own row.
 *
 * ## What "now" means for an event
 *
 * A message is read at the first frame after it arrived, so it is at most one frame old,
 * which is the contract `midiIn`'s readings already have. Its ORDER among the other
 * messages is exact; its time is that frame's.
 */
export const MIDI_EVENT_RING = 4096;

/** One message as the ring holds it, or null for anything that is not a channel-voice message. */
export function packMidiEvent(data: Uint8Array | null | undefined): number | null {
  if (data === null || data === undefined || data.length < 2) return null;
  const status = data[0] ?? 0;
  if (status < 0x80 || status > 0xef) return null;
  const kind = status & 0xf0;
  // Program change and channel pressure are two bytes; every other kind here is three.
  if (kind !== 0xc0 && kind !== 0xd0 && data.length < 3) return null;
  return status * 65536 + ((data[1] ?? 0) & 0x7f) * 256 + (kind === 0xc0 || kind === 0xd0 ? 0 : (data[2] ?? 0) & 0x7f);
}

export interface MidiEvent {
  /** 0x80 note off, 0x90 note on, 0xA0 poly pressure, 0xB0 control change, 0xC0 program, 0xD0 channel pressure, 0xE0 pitch bend. */
  readonly kind: number;
  /** MIDI channel, 1..16, as the hardware numbers it. */
  readonly channel: number;
  readonly data1: number;
  readonly data2: number;
}

export function unpackMidiEvent(packed: number): MidiEvent {
  const status = Math.floor(packed / 65536) & 0xff;
  return { kind: status & 0xf0, channel: (status & 0x0f) + 1, data1: Math.floor(packed / 256) & 0x7f, data2: packed & 0x7f };
}

/** `deviceId` empty means ANY device, as in `midiChannelName`. */
export function midiEventCountName(deviceId: string): string {
  return `midi:${deviceId === "" ? "*" : deviceId}:events`;
}

/** The ring slot message number `index` sits in. */
export function midiEventName(deviceId: string, index: number): string {
  return `midi:${deviceId === "" ? "*" : deviceId}:event.${String(index % MIDI_EVENT_RING)}`;
}

/**
 * The session's half: appends a message to a device's ring. `publish` is the session's own
 * store (its readings map), so the ring is written where the readings are and read through
 * the same resolver. Returns the device's new count.
 */
export function appendMidiEvent(publish: (name: string, value: number) => void, deviceId: string, count: number, packed: number): number {
  publish(midiEventName(deviceId, count), packed);
  publish(midiEventCountName(deviceId), count + 1);
  return count + 1;
}

export interface MidiEventRead {
  readonly events: readonly MidiEvent[];
  /** The count to pass as `cursor` next time. */
  readonly cursor: number;
}

/**
 * Every message that arrived since `cursor`, oldest first.
 *
 * `cursor` undefined is a reader's first look (a new node, or one whose state the transport
 * just cleared): it starts FROM NOW and reads nothing, because messages from before it
 * existed are not its to act on. A reader that fell a whole ring behind reads the newest
 * ring's worth; the older messages are gone.
 */
export function readMidiEvents(channels: ((name: string) => number | undefined) | undefined, deviceId: string, cursor: number | undefined): MidiEventRead {
  const count = channels?.(midiEventCountName(deviceId));
  if (channels === undefined || count === undefined || !Number.isFinite(count)) return { events: [], cursor: cursor ?? 0 };
  if (cursor === undefined || cursor > count) return { events: [], cursor: count };
  const events: MidiEvent[] = [];
  for (let index = Math.max(cursor, count - MIDI_EVENT_RING); index < count; index += 1) {
    const packed = channels(midiEventName(deviceId, index));
    if (packed !== undefined) events.push(unpackMidiEvent(packed));
  }
  return { events, cursor: count };
}
