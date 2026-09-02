import {
  COMMAND,
  LIGHT_ENGINE,
  PLAYBACK,
  POINT_BYTES,
  RESPONSE,
  STATUS_BYTES,
  type DacStatus,
} from "./ether-dream.ts";

/**
 * T950 — an Ether Dream DAC emulator: the DEVICE's state machines, in TypeScript,
 * implemented from the vendor's protocol page so the client in `ether-dream.ts` can be
 * gated against a counterparty that argues back — NAK-Invalid out of sequence,
 * NAK-Full on overflow, a latched e-stop that refuses to clear. This is the testable
 * half of the reason Ether Dream was chosen at all (§T947: the only candidate with a
 * full-state-machine emulator); `nannou-org/ether-dream`'s Rust `dac-emulator` is the
 * reference this one is written against, and running the client against THAT over real
 * sockets is the bridge helper's integration test, out of process, later — this one
 * exists so the exact-value gates need no cargo and no network.
 *
 * Deliberately NOT a mock: it holds real state (playback phase, light engine, buffer
 * fill, point count) and every response carries the full 20-byte status, because the
 * client's whole credit model reads `buffer_fullness` off every response and a mock
 * that echoed canned statuses would gate nothing.
 *
 * Playback drain is a METHOD (`drain(n)`), not a clock: tests advance the "hardware"
 * deterministically, which is the same no-wall-clock discipline every other gate in
 * this codebase holds (§V44's spirit).
 */

export interface EmulatorOptions {
  /** The device reports its capacity; 1799 approximates common hardware, nothing depends on it. */
  readonly bufferCapacity?: number;
  readonly maxPointRate?: number;
}

export function createEtherDreamEmulator(options: EmulatorOptions = {}): {
  /** Feed raw command bytes (any chunking); returns the concatenated response bytes. */
  receive(bytes: Uint8Array): Uint8Array;
  /** Consume up to n points from the buffer, as the galvo clock would. */
  drain(n: number): void;
  /** Latch/release an external e-stop condition (the input pin, an over-temp). */
  holdEmergencyStop(held: boolean): void;
  status(): DacStatus;
  bufferCapacity(): number;
} {
  const capacity = options.bufferCapacity ?? 1799;
  const maxPointRate = options.maxPointRate ?? 30000;

  let lightEngine: number = LIGHT_ENGINE.ready;
  let playback: number = PLAYBACK.idle;
  let buffered = 0;
  let pointRate = 0;
  let pointCount = 0;
  let estopHeld = false;
  let underflowed = false;
  /** Partial command bytes across receive() calls — TCP has no message boundaries. */
  let pending = new Uint8Array(0);

  const status = (): DacStatus => ({
    protocol: 0,
    lightEngineState: lightEngine,
    playbackState: playback,
    source: 0,
    lightEngineFlags: 0,
    playbackFlags: underflowed ? 0b10 : 0,
    sourceFlags: 0,
    bufferFullness: buffered,
    pointRate,
    pointCount,
  });

  const respond = (response: number, command: number): Uint8Array => {
    const bytes = new Uint8Array(2 + STATUS_BYTES);
    const view = new DataView(bytes.buffer);
    view.setUint8(0, response);
    view.setUint8(1, command);
    const s = status();
    view.setUint8(2, s.protocol);
    view.setUint8(3, s.lightEngineState);
    view.setUint8(4, s.playbackState);
    view.setUint8(5, s.source);
    view.setUint16(6, s.lightEngineFlags, true);
    view.setUint16(8, s.playbackFlags, true);
    view.setUint16(10, s.sourceFlags, true);
    view.setUint16(12, s.bufferFullness, true);
    view.setUint32(14, s.pointRate, true);
    view.setUint32(18, s.pointCount, true);
    return bytes;
  };

  /** Bytes a complete command at `at` occupies, or null if the chunk is still partial. */
  const commandLength = (bytes: Uint8Array, at: number): number | null => {
    switch (bytes[at]) {
      case COMMAND.prepare:
      case COMMAND.stop:
      case COMMAND.emergencyStop:
      case COMMAND.emergencyStopAlt:
      case COMMAND.clearEmergencyStop:
      case COMMAND.ping:
        return 1;
      case COMMAND.begin:
        return at + 7 <= bytes.length ? 7 : null;
      case COMMAND.queueRate:
        return at + 5 <= bytes.length ? 5 : null;
      case COMMAND.data: {
        if (at + 3 > bytes.length) return null;
        const view = new DataView(bytes.buffer, bytes.byteOffset);
        const npoints = view.getUint16(at + 1, true);
        const length = 3 + npoints * POINT_BYTES;
        return at + length <= bytes.length ? length : null;
      }
      default:
        return 1; // unknown byte: consumed and NAK'd below
    }
  };

  const handle = (bytes: Uint8Array, at: number): Uint8Array => {
    const command = bytes[at]!;
    if (command === COMMAND.emergencyStop || command === COMMAND.emergencyStopAlt) {
      lightEngine = LIGHT_ENGINE.emergencyStop;
      playback = PLAYBACK.idle;
      buffered = 0;
      return respond(RESPONSE.ack, command);
    }
    if (command === COMMAND.clearEmergencyStop) {
      // The spec's refusal path: while the condition persists, NAK '!' — a client that
      // silently retried this in a loop would hide a held hardware e-stop from the user.
      if (estopHeld) return respond(RESPONSE.nakStopCondition, command);
      if (lightEngine === LIGHT_ENGINE.emergencyStop) lightEngine = LIGHT_ENGINE.ready;
      return respond(RESPONSE.ack, command);
    }
    if (command === COMMAND.ping) return respond(RESPONSE.ack, command);
    if (lightEngine === LIGHT_ENGINE.emergencyStop) {
      return respond(RESPONSE.nakInvalid, command);
    }
    switch (command) {
      case COMMAND.prepare:
        if (playback !== PLAYBACK.idle) return respond(RESPONSE.nakInvalid, command);
        playback = PLAYBACK.prepared;
        buffered = 0;
        underflowed = false;
        return respond(RESPONSE.ack, command);
      case COMMAND.begin: {
        if (playback !== PLAYBACK.prepared) return respond(RESPONSE.nakInvalid, command);
        const view = new DataView(bytes.buffer, bytes.byteOffset);
        pointRate = Math.min(view.getUint32(at + 3, true), maxPointRate);
        playback = PLAYBACK.playing;
        return respond(RESPONSE.ack, command);
      }
      case COMMAND.queueRate: {
        if (playback === PLAYBACK.idle) return respond(RESPONSE.nakInvalid, command);
        const view = new DataView(bytes.buffer, bytes.byteOffset);
        pointRate = Math.min(view.getUint32(at + 1, true), maxPointRate);
        return respond(RESPONSE.ack, command);
      }
      case COMMAND.data: {
        if (playback === PLAYBACK.idle) return respond(RESPONSE.nakInvalid, command);
        const view = new DataView(bytes.buffer, bytes.byteOffset);
        const npoints = view.getUint16(at + 1, true);
        if (buffered + npoints > capacity) return respond(RESPONSE.nakFull, command);
        buffered += npoints;
        pointCount += npoints;
        return respond(RESPONSE.ack, command);
      }
      case COMMAND.stop:
        if (playback === PLAYBACK.idle) return respond(RESPONSE.nakInvalid, command);
        playback = PLAYBACK.idle;
        buffered = 0;
        return respond(RESPONSE.ack, command);
      default:
        return respond(RESPONSE.nakInvalid, command);
    }
  };

  return {
    receive(chunk) {
      const bytes = new Uint8Array(pending.length + chunk.length);
      bytes.set(pending, 0);
      bytes.set(chunk, pending.length);
      const responses: Uint8Array[] = [];
      let at = 0;
      while (at < bytes.length) {
        const length = commandLength(bytes, at);
        if (length === null) break; // partial command: wait for more bytes
        responses.push(handle(bytes, at));
        at += length;
      }
      pending = bytes.slice(at);
      const total = responses.reduce((sum, r) => sum + r.length, 0);
      const out = new Uint8Array(total);
      let cursor = 0;
      for (const response of responses) {
        out.set(response, cursor);
        cursor += response.length;
      }
      return out;
    },
    drain(n) {
      if (playback !== PLAYBACK.playing) return;
      if (n >= buffered && buffered > 0) {
        // The buffer ran dry mid-stream: the spec records this as the underflow flag
        // and the stream ends. What the OUTPUT does during it is undocumented — which
        // is exactly why G3 makes every client block end blanked.
        buffered = 0;
        playback = PLAYBACK.idle;
        underflowed = true;
        return;
      }
      buffered = Math.max(0, buffered - n);
    },
    holdEmergencyStop(held) {
      estopHeld = held;
      if (held) {
        lightEngine = LIGHT_ENGINE.emergencyStop;
        playback = PLAYBACK.idle;
        buffered = 0;
      }
    },
    status,
    bufferCapacity: () => capacity,
  };
}
