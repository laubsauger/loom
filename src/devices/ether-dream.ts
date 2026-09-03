/**
 * T950 — the Ether Dream wire protocol and client state machine, PURE.
 *
 * No sockets here: bytes in, bytes out, so every state transition and every encoded
 * byte is gateable to exact values with no hardware in the room — the property that
 * ruled Ether Dream over the emulator-less alternatives (§T947's research). The
 * transport that owns a socket (the bridge helper, a later commit) drives this machine;
 * the TS emulator beside this file (`ether-dream-emulator.ts`) implements the DAC's own
 * state machines from the same specification so the two can be gated against each other
 * exchange by exchange.
 *
 * ## Provenance, byte by byte (§B148's rule: never the card alone)
 *
 * Encodings are from the vendor's protocol page (ether-dream.com/protocol.html, fetched
 * 2026-09-03), cross-checked against `nannou-org/ether-dream`'s protocol.rs — the
 * MIT/Apache reference implementation whose DAC emulator carries the full state
 * machines. ONE CONTRADICTION between the two sources was found and is resolved here:
 * the vendor page writes the queue-rate-change opcode as `'q' (0x74)`, but ASCII 'q'
 * is 0x71 — the page disagrees with its own comment. The reference implementation,
 * which has been run against real DACs, uses 0x74; the BYTE VALUE wins over the
 * mnemonic, and this paragraph exists so nobody "fixes" it back to 0x71.
 *
 * ## The safety encoders live WITH the protocol, not with the caller
 *
 * G3 (every block ends blanked), G4 (non-finite/out-of-range coordinates BLANK and
 * hold the last valid position — a NaN clamped to zero would park the beam at the
 * centre of the field at full brightness, the exact hazard geometry) and G9 (the rate
 * clamps to the device-reported maximum, which the broadcast carries precisely so it
 * is never hardcoded) are enforced by the only functions that produce point bytes, so
 * no caller can skip them by being new.
 */

/* ------------------------------------------------------------------ wire constants */

export const ETHER_DREAM_TCP_PORT = 7765;
export const ETHER_DREAM_BROADCAST_PORT = 7654;

export const COMMAND = {
  prepare: 0x70, // 'p'
  begin: 0x62, // 'b'
  /** 0x74, NOT 0x71: the spec page's own "'q'" comment contradicts its byte — see above. */
  queueRate: 0x74,
  data: 0x64, // 'd'
  stop: 0x73, // 's'
  emergencyStop: 0x00,
  emergencyStopAlt: 0xff,
  clearEmergencyStop: 0x63, // 'c'
  ping: 0x3f, // '?'
} as const;

export const RESPONSE = {
  ack: 0x61, // 'a'
  nakFull: 0x46, // 'F'
  nakInvalid: 0x49, // 'I'
  /** "the emergency condition persists" — a REFUSED clear, which the UI must surface (G7). */
  nakStopCondition: 0x21, // '!'
} as const;

export const LIGHT_ENGINE = { ready: 0, warmup: 1, cooldown: 2, emergencyStop: 3 } as const;
export const PLAYBACK = { idle: 0, prepared: 1, playing: 2 } as const;

export const POINT_BYTES = 18;
export const STATUS_BYTES = 20;
export const RESPONSE_BYTES = 2 + STATUS_BYTES;

/* --------------------------------------------------------------------- structures */

/** `dac_point`, 18 bytes little-endian, packed, full scale 65535 (the spec's words). */
export interface DacPoint {
  readonly control: number;
  readonly x: number;
  readonly y: number;
  readonly r: number;
  readonly g: number;
  readonly b: number;
  readonly i: number;
  readonly u1: number;
  readonly u2: number;
}

export interface DacStatus {
  readonly protocol: number;
  readonly lightEngineState: number;
  readonly playbackState: number;
  readonly source: number;
  readonly lightEngineFlags: number;
  readonly playbackFlags: number;
  readonly sourceFlags: number;
  readonly bufferFullness: number;
  readonly pointRate: number;
  readonly pointCount: number;
}

export interface DacResponse {
  readonly response: number;
  readonly command: number;
  readonly status: DacStatus;
}

export interface DacBroadcast {
  readonly mac: readonly number[];
  readonly hwRevision: number;
  readonly swRevision: number;
  /** Device-reported. NEVER hardcode a capacity; the broadcast exists to carry it. */
  readonly bufferCapacity: number;
  /** Device-reported. G9's clamp ceiling. */
  readonly maxPointRate: number;
  readonly status: DacStatus;
}

/* ----------------------------------------------------------------------- encoding */

export function encodePrepare(): Uint8Array {
  return Uint8Array.of(COMMAND.prepare);
}

/** `low_water_mark` is documented "currently unused"; carried anyway — it is the wire. */
export function encodeBegin(lowWaterMark: number, pointRate: number): Uint8Array {
  const bytes = new Uint8Array(7);
  const view = new DataView(bytes.buffer);
  view.setUint8(0, COMMAND.begin);
  view.setUint16(1, lowWaterMark, true);
  view.setUint32(3, pointRate >>> 0, true);
  return bytes;
}

export function encodeQueueRate(pointRate: number): Uint8Array {
  const bytes = new Uint8Array(5);
  const view = new DataView(bytes.buffer);
  view.setUint8(0, COMMAND.queueRate);
  view.setUint32(1, pointRate >>> 0, true);
  return bytes;
}

export function encodeSingle(command: number): Uint8Array {
  return Uint8Array.of(command);
}

export function encodeData(points: readonly DacPoint[]): Uint8Array {
  const bytes = new Uint8Array(3 + points.length * POINT_BYTES);
  const view = new DataView(bytes.buffer);
  view.setUint8(0, COMMAND.data);
  view.setUint16(1, points.length, true);
  let at = 3;
  for (const point of points) {
    view.setUint16(at, point.control, true);
    view.setInt16(at + 2, point.x, true);
    view.setInt16(at + 4, point.y, true);
    view.setUint16(at + 6, point.r, true);
    view.setUint16(at + 8, point.g, true);
    view.setUint16(at + 10, point.b, true);
    view.setUint16(at + 12, point.i, true);
    view.setUint16(at + 14, point.u1, true);
    view.setUint16(at + 16, point.u2, true);
    at += POINT_BYTES;
  }
  return bytes;
}

/* ------------------------------------------------------------------------ parsing */

export function parseStatus(view: DataView, at: number): DacStatus {
  return {
    protocol: view.getUint8(at),
    lightEngineState: view.getUint8(at + 1),
    playbackState: view.getUint8(at + 2),
    source: view.getUint8(at + 3),
    lightEngineFlags: view.getUint16(at + 4, true),
    playbackFlags: view.getUint16(at + 6, true),
    sourceFlags: view.getUint16(at + 8, true),
    bufferFullness: view.getUint16(at + 10, true),
    pointRate: view.getUint32(at + 12, true),
    pointCount: view.getUint32(at + 16, true),
  };
}

export function parseResponse(bytes: Uint8Array, at = 0): DacResponse {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    response: view.getUint8(at),
    command: view.getUint8(at + 1),
    status: parseStatus(view, at + 2),
  };
}

export function parseBroadcast(bytes: Uint8Array): DacBroadcast {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    mac: [...bytes.subarray(0, 6)],
    hwRevision: view.getUint16(6, true),
    swRevision: view.getUint16(8, true),
    bufferCapacity: view.getUint16(10, true),
    maxPointRate: view.getUint32(12, true),
    status: parseStatus(view, 16),
  };
}

/* ------------------------------------------------------------------ safety encoders */

/** One planned sample as the pump hands it over: clip-space position, 0..1 colour. */
export interface PlannedSample {
  readonly x: number;
  readonly y: number;
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

const FULL = 65535;

function channel(value: number): number {
  return Number.isFinite(value) ? Math.round(Math.min(1, Math.max(0, value)) * FULL) : 0;
}

function axis(value: number): number {
  return Math.round(value * 32767);
}

/**
 * G4, and the direction matters more than the rule: a NON-FINITE or OUT-OF-RANGE
 * coordinate BLANKS the beam and HOLDS THE LAST VALID POSITION. Clamping instead would
 * park a NaN at the centre of the field at whatever brightness the colour channels
 * hold — the exact hazard geometry — so colour is ZEROED, never clamped, and position
 * never invents a value the plan did not contain.
 */
export function samplesToPoints(
  samples: readonly PlannedSample[],
  start: { x: number; y: number } = { x: 0, y: 0 },
): { points: DacPoint[]; last: { x: number; y: number } } {
  const points: DacPoint[] = [];
  let last = { x: start.x, y: start.y };
  for (const sample of samples) {
    const valid =
      Number.isFinite(sample.x) &&
      Number.isFinite(sample.y) &&
      Math.abs(sample.x) <= 1 &&
      Math.abs(sample.y) <= 1;
    if (valid) last = { x: sample.x, y: sample.y };
    points.push({
      control: 0,
      x: axis(last.x),
      y: axis(last.y),
      r: valid ? channel(sample.r) : 0,
      g: valid ? channel(sample.g) : 0,
      b: valid ? channel(sample.b) : 0,
      i: valid ? FULL : 0,
      u1: 0,
      u2: 0,
    });
  }
  return { points, last };
}

/**
 * G3: every transmitted block ends BLANKED at the last position, because the spec
 * documents the underflow FLAG and not what the output does during one — §T947's
 * research looked specifically and it is not there. Blanked tails make the behaviour
 * ours instead of undefined: a buffer that runs dry runs dry on darkness.
 */
export function blankedTail(last: { x: number; y: number }, count: number): DacPoint[] {
  const point: DacPoint = {
    control: 0,
    x: axis(last.x),
    y: axis(last.y),
    r: 0,
    g: 0,
    b: 0,
    i: 0,
    u1: 0,
    u2: 0,
  };
  return Array.from({ length: Math.max(1, count) }, () => point);
}

/* ------------------------------------------------------- G5: software scan-fail */

/**
 * The lit-dwell tracker's cross-block state: the ANCHOR of the current lit run (DAC
 * units) and how many lit points have sat within epsilon of it. Held by the service
 * across blocks, because a stationary beam streamed frame after frame is exactly the
 * case a per-block check would amnesty at every frame boundary.
 */
export interface ScanFailState {
  readonly x: number;
  readonly y: number;
  readonly dwell: number;
}

export const SCAN_FAIL_START: ScanFailState = { x: 0, y: 0, dwell: 0 };

/**
 * "Stationary" epsilon in DAC units (~0.2% of the ±32767 field). Displacement is
 * measured from the RUN'S ANCHOR, not the previous point: a slow crawl of sub-epsilon
 * steps accumulates displacement from the anchor and eventually resets the run, while
 * successive-difference comparison would never see it move at all.
 */
const SCAN_FAIL_EPSILON = 64;

/**
 * G5 — software scan-fail: a lit run that stays within epsilon of its anchor for more
 * than `maxDwellPoints` is BLANKED from that point until it moves or goes dark. The
 * position still crosses (a blanked hold, exactly G4's shape), only the light is cut —
 * this guards the hazard the credit model cannot see, a protocol-valid buffer full of
 * one bright spot. Pure and stateless-in, so the gates feed it points directly; the
 * service owns the state and the threshold-in-points arithmetic. The projector's own
 * scan-fail hardware remains the operator's responsibility; this only keeps OUR stuck
 * plan from being the cause.
 */
export function applyScanFail(
  points: readonly DacPoint[],
  state: ScanFailState,
  maxDwellPoints: number,
): { points: DacPoint[]; state: ScanFailState; blanked: number } {
  let { x, y, dwell } = state;
  let blanked = 0;
  const out = points.map((point) => {
    const lit = point.i > 0 && (point.r > 0 || point.g > 0 || point.b > 0);
    if (!lit) {
      x = point.x;
      y = point.y;
      dwell = 0;
      return point;
    }
    if (dwell > 0 && Math.abs(point.x - x) <= SCAN_FAIL_EPSILON && Math.abs(point.y - y) <= SCAN_FAIL_EPSILON) {
      dwell += 1;
    } else {
      x = point.x;
      y = point.y;
      dwell = 1;
    }
    if (dwell > maxDwellPoints) {
      blanked += 1;
      return { ...point, r: 0, g: 0, b: 0, i: 0 };
    }
    return point;
  });
  return { points: out, state: { x, y, dwell }, blanked };
}

/**
 * G9: a rate change is a request to move mirrors faster. The ceiling is the DEVICE'S
 * OWN `max_point_rate` from the broadcast, optionally lowered by an author-set
 * projector ceiling — never raised. Community practice runs at ~80% of a scanner's
 * safe rate and treats audible galvo whine as a stop signal; the clamp cannot hear,
 * so it enforces the part arithmetic can.
 */
export function clampPointRate(requested: number, deviceMax: number, projectorCeiling?: number): number {
  const ceiling = projectorCeiling === undefined ? deviceMax : Math.min(deviceMax, projectorCeiling);
  return Math.max(1, Math.min(Math.floor(requested), Math.floor(ceiling)));
}

/* -------------------------------------------------------------- client state machine */

export type ClientPhase = "idle" | "prepared" | "playing" | "estopped";

export interface EtherDreamClientState {
  readonly phase: ClientPhase;
  /** Device capacity, from the broadcast — writes are refused until it is known. */
  readonly capacity: number | null;
  /** The DAC's last self-reported fullness. */
  readonly reportedFullness: number;
  /** Points written since that report — the un-acked half of the credit model. */
  readonly inFlight: number;
  readonly lastStatus: DacStatus | null;
  /** A clear that came back NAK '!' — the refusal a UI must surface, not retry (G7). */
  readonly clearRefused: boolean;
  /** Bit 1 of playback_flags on the latest status: the last stream underflowed. */
  readonly underflowed: boolean;
}

/**
 * The credit model, and why it needs no clock: the Ether Dream is a clocked FIFO that
 * reports `buffer_fullness` in EVERY response. The client counts what it has written
 * since the last report and refuses to write a block that could overflow —
 * `reported + inFlight + block ≤ capacity` — so NAK-Full is a failure of the model,
 * not a flow-control primitive. Every response REPLACES `reportedFullness` and zeroes
 * `inFlight`, because the report already includes everything acknowledged. Purely
 * message-driven: deterministic under test, no wall clock anywhere (§V44's spirit at
 * the transport).
 */
export function createEtherDreamClient(): {
  state(): EtherDreamClientState;
  /** Feed the broadcast that discovered the device. */
  onBroadcast(broadcast: DacBroadcast): void;
  /** Feed one parsed response; returns it for convenience. */
  onResponse(response: DacResponse): DacResponse;
  /** How many points may be written RIGHT NOW without risking NAK-Full. */
  writable(): number;
  /** Record a data command of `count` points as sent. */
  wrote(count: number): void;
} {
  let phase: ClientPhase = "idle";
  let capacity: number | null = null;
  let reportedFullness = 0;
  let inFlight = 0;
  let lastStatus: DacStatus | null = null;
  let clearRefused = false;
  let underflowed = false;

  return {
    state: () => ({ phase, capacity, reportedFullness, inFlight, lastStatus, clearRefused, underflowed }),
    onBroadcast(broadcast) {
      capacity = broadcast.bufferCapacity;
    },
    onResponse(response) {
      lastStatus = response.status;
      reportedFullness = response.status.bufferFullness;
      inFlight = 0;
      underflowed = (response.status.playbackFlags & 0b10) !== 0;
      if (response.status.lightEngineState === LIGHT_ENGINE.emergencyStop) {
        phase = "estopped";
      } else {
        switch (response.status.playbackState) {
          case PLAYBACK.idle:
            phase = "idle";
            break;
          case PLAYBACK.prepared:
            phase = "prepared";
            break;
          case PLAYBACK.playing:
            phase = "playing";
            break;
        }
      }
      clearRefused =
        response.command === COMMAND.clearEmergencyStop && response.response === RESPONSE.nakStopCondition;
      return response;
    },
    writable() {
      // Credit exists only inside a session: data while Idle is NAK-Invalid by the
      // spec's own state machine, and an e-stopped client writes nothing at all.
      if (capacity === null || (phase !== "prepared" && phase !== "playing")) return 0;
      return Math.max(0, capacity - reportedFullness - inFlight);
    },
    wrote(count) {
      inFlight += count;
    },
  };
}

/**
 * G2's payloads — what a dead-man firing SENDS, in order, unconditionally. The TIMER
 * lives in the bridge helper (the failsafe must be on the far side of the thing that
 * can fail: a page watchdog cannot protect against the page); this function only fixes
 * WHAT fires so the helper cannot improvise it: darkness at the last position, then
 * Stop, then Emergency Stop. Blank first — a Stop from Playing leaves the transition
 * to the DAC; the tail makes the last thing in the buffer darkness either way.
 */
export function deadManPayloads(last: { x: number; y: number }): Uint8Array[] {
  return [
    encodeData(blankedTail(last, 16)),
    encodeSingle(COMMAND.stop),
    encodeSingle(COMMAND.emergencyStop),
  ];
}
