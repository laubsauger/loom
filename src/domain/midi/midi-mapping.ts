/**
 * T942 tier 1 — MIDI-learn's document half: what a learned control IS, and how a raw
 * hardware reading becomes a published channel.
 *
 * ## Why this is a domain module and not part of the node
 *
 * Three surfaces need the same answers and none of them may disagree: the `midiIn` node
 * (which turns readings into a bag every frame), the inspector's learn UI (which writes
 * the mapping and shows what a control is bound to), and the session's listener (which
 * decodes the bytes and publishes them under a name). A key spelled one way in the
 * listener and another way in the node is a control that learns and then reads its rest
 * value forever — silent, plausible, and exactly §V147's family. So the SPELLING lives
 * here, once, with the decode and the mapping arithmetic beside it.
 *
 * ## The channel seam is not invented here — it already existed (§T942's finding)
 *
 * `ValueEvaluateContext.channels?: (name) => number | undefined` was built for `analyze`
 * and `channelIn` reads an arbitrary string name through it. A MIDI CC is a string name.
 * So the session publishes RAW readings under `midi:<device>:<source>` into that same
 * seam, and the node reads them back — no new port type, no compiler change, and
 * `channelIn` can read a raw CC directly for free if someone wants one.
 *
 * ## WHAT IS SUPPORTED, stated rather than discovered (the brief's rule)
 *
 *  - **Control Change, 7-bit** (status 0xB0-0xBF): raw 0..127. The common case, and what
 *    every knob, fader and pad on a class-compliant controller sends.
 *  - **Pitch bend** (status 0xE0-0xEF): raw 0..16383. It is 14-bit IN THE MESSAGE — two
 *    data bytes, LSB first — so full resolution falls out of decoding it correctly and
 *    treating it as 7-bit would be the silent mangling the brief forbids. Its rest is the
 *    CENTRE, which is why `rest` is a mapping field rather than assumed to be `range[0]`.
 *
 * ## WHAT IS NOT, and what happens instead
 *
 *  - **14-bit CC pairs (MSB on cc N, LSB on cc N+32)** are NOT reassembled. A device that
 *    sends them is read at 7-bit resolution off the MSB, which is correct-but-coarse
 *    rather than wrong — but its LSB stream is a SEPARATE learnable control that sweeps
 *    0..127 many times per knob turn. Learn the MSB (the lower cc number). Reassembly
 *    needs a per-device declaration that a pair IS a pair; guessing it from traffic would
 *    make a coarse knob and a fast knob indistinguishable.
 *  - **Note on/off and velocity**: not decoded. A note is a gate AND a velocity AND a
 *    pitch, and note-on with velocity 0 is a note-off — three channels and an encoding
 *    wart, which is a design rather than a decode. Out of scope for this row.
 *  - **MIDI clock / transport (0xF8, 0xFA-0xFC)**: not decoded. A clock is 24 pulses per
 *    quarter note and what anyone wants from it is a TEMPO, which is an estimator over a
 *    pulse train, not a reading. §T825 also records that we have no beat/bar surface for
 *    a tempo to drive yet, so it would arrive with nowhere to go.
 *  - **SysEx, NRPN/RPN, aftertouch, program change**: not decoded. Access is requested
 *    WITHOUT sysex, so the permission prompt stays the ordinary one.
 *
 * Anything not in the supported list is dropped at `decodeMidiMessage`, so it can never
 * be learned and can never be published — an unsupported message does nothing at all
 * rather than binding a control that then behaves strangely.
 */

/** The kinds of message a control can be learned from. See the module note for the rest. */
export type MidiSourceKind = "cc" | "pitchBend";

/** WHICH physical control a learned channel is bound to. */
export interface MidiSource {
  readonly kind: MidiSourceKind;
  /** MIDI channel, 1..16 — as the hardware numbers it, not as the wire encodes it. */
  readonly channel: number;
  /** Controller number 0..127. Absent for `pitchBend`, which has no number. */
  readonly number?: number;
}

/**
 * One learned control: a NAME the user chose, the hardware it is bound to, and the band
 * it lands in.
 *
 * `range` is here rather than downstream on purpose. §T738 measured what the alternative
 * costs: every example hand-building a gain+bias chain per source, and every one of them
 * breaking on real input. A 7-bit CC normalises to 0..1 at the source and `range` maps
 * that to the useful band ONCE, in the place the binding already lives.
 */
export interface MidiBinding {
  /** The published channel name — `midi1:cutoff` reads this. The user's word, not `cc74`. */
  readonly channel: string;
  /** Null while a row is being learned: a named control with nothing bound yet. */
  readonly source: MidiSource | null;
  /** `[low, high]`. Set it to `[0, 127]` to read the raw controller value. */
  readonly range: readonly [number, number];
  /**
   * `absolute` — the control's position, mapped into `range`.
   * `toggle` — a latch: each press (a rising crossing of the half-way point) flips
   *   between `range[0]` and `range[1]`, which is what makes a momentary pad usable.
   *
   * Endless/relative encoders are NOT a mode here: they send deltas in one of three
   * competing encodings and reading one as absolute gives a value that jumps. They are
   * unsupported rather than approximated.
   */
  readonly mode: "absolute" | "toggle";
  /**
   * What the channel publishes when the hardware is not there — no access, no device,
   * nothing sent yet.
   *
   * Defaults to `range[0]`, which is right for a fader and WRONG for a pitch bend or a
   * centre-detented knob: §V353's rule is deterministic silence, not blind zero, and a
   * control whose rest is the centre must rest at the centre or the graph opens with a
   * hard-left picture that nobody asked for.
   */
  readonly rest?: number;
}

/** Full-scale raw reading per kind. The denominator of the 0..1 normalisation. */
export function midiSourceMax(kind: MidiSourceKind): number {
  return kind === "pitchBend" ? 16383 : 127;
}

/**
 * The published NAME of one physical control, device-independent.
 *
 * `cc1.74` rather than `cc:1:74`: `:` is already the `name:channel` addressing separator
 * in the value graph (`midi1:cutoff`), and reusing it inside a leaf would make an address
 * that reads as three levels when it is two.
 */
export function midiSourceKey(source: MidiSource): string {
  return source.kind === "pitchBend"
    ? `bend${source.channel}`
    : `cc${source.channel}.${source.number ?? 0}`;
}

/**
 * The full published channel name for a control on a device.
 *
 * `deviceId` empty means ANY device: the session publishes every reading under `*` as
 * well as under its own port id, so a `midiIn` with no device picked works the moment
 * something is plugged in — which is the state a node is in for the whole of the minute
 * after it is dropped on the canvas.
 */
export function midiChannelName(deviceId: string, source: MidiSource): string {
  return `midi:${deviceId === "" ? "*" : deviceId}:${midiSourceKey(source)}`;
}

/** A decoded reading: which control moved, and how far. */
export interface MidiReading {
  readonly source: MidiSource;
  /** The controller's own units — 0..127 for a CC, 0..16383 for pitch bend. */
  readonly raw: number;
}

/**
 * Bytes to reading, or null for every message this row does not support.
 *
 * Dropping rather than approximating is the whole point: a note-on that decoded to
 * "something" would be learnable, and the control it produced would then behave in a way
 * no documentation explains.
 */
export function decodeMidiMessage(data: Uint8Array | null | undefined): MidiReading | null {
  if (data === null || data === undefined || data.length < 2) return null;
  const status = data[0] ?? 0;
  const channel = (status & 0x0f) + 1;
  switch (status & 0xf0) {
    case 0xb0: {
      if (data.length < 3) return null;
      return { source: { kind: "cc", channel, number: (data[1] ?? 0) & 0x7f }, raw: (data[2] ?? 0) & 0x7f };
    }
    case 0xe0: {
      if (data.length < 3) return null;
      // LSB first, then MSB — 14 bits, and reading only `data[2]` is the silent mangling
      // the module note refuses.
      const raw = (((data[2] ?? 0) & 0x7f) << 7) | ((data[1] ?? 0) & 0x7f);
      return { source: { kind: "pitchBend", channel }, raw };
    }
    default:
      return null;
  }
}

/** Per-binding state across frames: the latch, and the edge it is driven by (§V181). */
interface ToggleState {
  latched: boolean;
  wasHigh: boolean;
}

/**
 * One binding's published number for this frame.
 *
 * `raw === undefined` is the DEGRADED path and it is the normal one on a machine with no
 * controller: it publishes `rest`, never a stall and never an absent channel, so every
 * parameter driven by this node keeps a defined value and the document renders (§T715's
 * constraint, §V353's silence, §V144's stale-beats-stalled).
 *
 * `state` is the node's own `ValueEvaluateContext.state` bag, keyed by channel name, and
 * it is only touched by `toggle`. It clears with the transport, so a replayed range
 * starts from an unlatched pad rather than from whatever the last take left behind.
 */
export function midiBindingValue(
  binding: MidiBinding,
  raw: number | undefined,
  state: Record<string, unknown>,
): number {
  const [low, high] = binding.range;
  const rest = binding.rest ?? low;
  if (binding.mode === "toggle") {
    const cell = readToggle(state, binding.channel);
    if (raw === undefined) {
      // Absent hardware does not flip a latch, and it does not clear one either: the
      // channel reports `rest` while the device is gone and resumes where it was.
      return rest;
    }
    const high01 = raw / midiSourceMax(binding.source?.kind ?? "cc") >= 0.5;
    if (high01 && !cell.wasHigh) cell.latched = !cell.latched;
    cell.wasHigh = high01;
    return cell.latched ? high : low;
  }
  if (raw === undefined) return rest;
  const t = raw / midiSourceMax(binding.source?.kind ?? "cc");
  return low + (high - low) * t;
}

function readToggle(state: Record<string, unknown>, channel: string): ToggleState {
  const key = `toggle:${channel}`;
  const existing = state[key];
  if (
    typeof existing === "object" &&
    existing !== null &&
    "latched" in existing &&
    "wasHigh" in existing
  ) {
    return existing as unknown as ToggleState;
  }
  const fresh: ToggleState = { latched: false, wasHigh: false };
  state[key] = fresh;
  return fresh;
}

/** What `parseMidiMapping` found: the usable bindings, and why anything was dropped. */
export interface MidiMappingParse {
  readonly bindings: readonly MidiBinding[];
  /** One sentence naming the FIRST problem, or null. Empty text is not a problem. */
  readonly error: string | null;
}

const EMPTY_PARSE: MidiMappingParse = { bindings: [], error: null };

/**
 * The stored JSON to bindings, tolerantly and with a stated reason when it will not.
 *
 * Tolerant because this parameter is hand-editable in the code pane and a half-typed
 * bracket must not take the render down; stated because a mapping that silently became
 * empty is a node whose every channel reads its rest value with nothing anywhere saying
 * why — the §V338/§V469 shape the brief calls out by name.
 */
export function parseMidiMapping(stored: unknown): MidiMappingParse {
  if (typeof stored !== "string" || stored.trim() === "") return EMPTY_PARSE;
  let parsed: unknown;
  try {
    parsed = JSON.parse(stored);
  } catch {
    return { bindings: [], error: "Mapping is not valid JSON." };
  }
  if (!Array.isArray(parsed)) return { bindings: [], error: "Mapping must be a list of controls." };
  const bindings: MidiBinding[] = [];
  const seen = new Set<string>();
  for (const entry of parsed) {
    const binding = readBinding(entry);
    if (binding === null) return { bindings, error: "A control is missing its name." };
    // §V129: a name is an ADDRESS. Two controls called `cutoff` make `midi1:cutoff`
    // ambiguous, and the loser would simply never be readable.
    if (seen.has(binding.channel)) {
      return { bindings, error: `Two controls are both named ${binding.channel}.` };
    }
    seen.add(binding.channel);
    bindings.push(binding);
  }
  return { bindings, error: null };
}

function readBinding(entry: unknown): MidiBinding | null {
  if (typeof entry !== "object" || entry === null) return null;
  const record = entry as Record<string, unknown>;
  const channel = typeof record["channel"] === "string" ? record["channel"].trim() : "";
  if (channel === "") return null;
  const range = readRange(record["range"]);
  const source = readSource(record["source"]);
  const mode = record["mode"] === "toggle" ? "toggle" : "absolute";
  const rest = typeof record["rest"] === "number" && Number.isFinite(record["rest"]) ? record["rest"] : undefined;
  return { channel, source, range, mode, ...(rest === undefined ? {} : { rest }) };
}

function readRange(value: unknown): readonly [number, number] {
  if (!Array.isArray(value) || value.length < 2) return [0, 1];
  const low = typeof value[0] === "number" && Number.isFinite(value[0]) ? value[0] : 0;
  const high = typeof value[1] === "number" && Number.isFinite(value[1]) ? value[1] : 1;
  return [low, high];
}

function readSource(value: unknown): MidiSource | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const kind = record["kind"] === "pitchBend" ? "pitchBend" : record["kind"] === "cc" ? "cc" : null;
  if (kind === null) return null;
  const channel = typeof record["channel"] === "number" ? Math.min(16, Math.max(1, Math.round(record["channel"]))) : 1;
  if (kind === "pitchBend") return { kind, channel };
  const number = typeof record["number"] === "number" ? Math.min(127, Math.max(0, Math.round(record["number"]))) : 0;
  return { kind, channel, number };
}

/** Bindings back to the stored form, stable key order so a re-learn diffs readably. */
export function serialiseMidiMapping(bindings: readonly MidiBinding[]): string {
  return JSON.stringify(
    bindings.map((binding) => ({
      channel: binding.channel,
      source: binding.source,
      range: binding.range,
      mode: binding.mode,
      ...(binding.rest === undefined ? {} : { rest: binding.rest }),
    })),
    null,
    2,
  );
}

/** Human text for a binding's hardware, for the learn UI and for a status line. */
export function describeMidiSource(source: MidiSource | null): string {
  if (source === null) return "Not learned";
  if (source.kind === "pitchBend") return `Bend ch ${source.channel}`;
  return `CC ${source.number ?? 0} ch ${source.channel}`;
}
