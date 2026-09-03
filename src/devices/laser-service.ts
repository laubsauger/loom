import {
  COMMAND,
  RESPONSE,
  clampPointRate,
  createEtherDreamClient,
  deadManPayloads,
  encodeBegin,
  encodeData,
  encodePrepare,
  encodeSingle,
  blankedTail,
  parseResponse,
  samplesToPoints,
  applyScanFail,
  SCAN_FAIL_START,
  RESPONSE_BYTES,
  type PlannedSample,
  type ScanFailState,
} from "./ether-dream.ts";

/**
 * T950 — the HELPER-SIDE laser service: the armed, exclusive, stateful lifecycle
 * (§T950 gap 4) with the dead-man timer (G2) in the process that survives the page.
 *
 * ## Why this lives helper-side, mechanically
 *
 * The page is the component that can crash, hang, be throttled as a background tab, or
 * be closed — so a watchdog in the page cannot protect against the page. This service
 * runs in the bridge helper (a separate OS process), and its dead-man fires on ITS
 * clock when point blocks stop arriving FOR ANY REASON, including reasons the page
 * cannot report. What fires is fixed by the protocol module (`deadManPayloads`:
 * darkness at the last position, Stop, Emergency Stop, in that order) so this file
 * decides only WHEN, never WHAT. G5's software scan-fail sits beside it because the
 * two split one hazard class: the dead-man covers blocks that STOP arriving, the
 * scan-fail covers blocks that KEEP arriving carrying a beam that stopped moving.
 *
 * ## The lifecycle, and what each transition refuses
 *
 *   disconnected → connected      connect(host); device capacity and max rate arrive
 *                                 from DISCOVERY (the caller plumbs the broadcast's
 *                                 device-reported values — nothing here hardcodes
 *                                 either, per the spec's own design).
 *   connected  → armed            arm() — a deliberate call per session. Arming is
 *                                 NEVER document state (G1) and does not survive the
 *                                 service; dispose() disarms and fires the dead-man
 *                                 sequence if a stream was live.
 *   armed      → streaming        the first stream() sends prepare + begin at the
 *                                 G9-clamped rate, then credit-gated data blocks,
 *                                 every one ending blanked (G3, via the encoders).
 *   any        → estopped         estop(), the dead-man, or the device's own report.
 *                                 clearEstop() can be REFUSED by the device (NAK '!')
 *                                 and the refusal is surfaced, never silently retried.
 *
 * ## Injected time, injected sockets
 *
 * The clock and the socket factory are constructor inputs, so every safety behaviour —
 * including the dead-man ACTUALLY FIRING — is asserted in a deterministic test against
 * the protocol emulator, with no wall clock and no network (§V44's discipline applied
 * to the one place a real timer will eventually live).
 */

export interface TcpSocketLike {
  write(bytes: Uint8Array): void;
  onData(handler: (bytes: Uint8Array) => void): void;
  onClose(handler: () => void): void;
  close(): void;
}

export interface TcpSocketFactory {
  connect(host: string, port: number): TcpSocketLike;
}

export interface LaserClock {
  now(): number;
  /** Repeating timer; returns the cancel. The helper passes setInterval; tests a fake. */
  every(ms: number, tick: () => void): () => void;
}

export interface LaserDeviceInfo {
  /** Device-reported, from the discovery broadcast. Never hardcoded (the spec's rule). */
  readonly bufferCapacity: number;
  readonly maxPointRate: number;
}

export type LaserServicePhase = "disconnected" | "connected" | "armed" | "streaming" | "estopped";

export interface LaserServiceState {
  readonly phase: LaserServicePhase;
  readonly clearRefused: boolean;
  readonly underflowed: boolean;
  readonly bufferFullness: number;
}

export interface LaserServiceOptions {
  readonly sockets: TcpSocketFactory;
  readonly clock: LaserClock;
  /** Dead-man timeout — a small multiple of the frame interval, far below any device watchdog. */
  readonly deadManMs?: number;
  readonly onState?: (state: LaserServiceState, reason: string) => void;
  /** An author-set projector ceiling for G9; lowers the device max, never raises it.
   *  Read PER STREAM, so a host may supply a live getter; undefined defers to the
   *  device's own reported maximum. */
  readonly projectorMaxPps?: number | undefined;
}

const DEFAULT_DEAD_MAN_MS = 250;
const TAIL_POINTS = 8;
/**
 * G5 — the lit-dwell ceiling, in TIME so the point budget scales with the rate. 50 ms
 * clears any planner corner dwell by orders of magnitude while staying in the range
 * hardware scan-fail circuits act in. A CONSTANT, not an option: like G9's clamp it
 * must not be raisable from the page, and unlike G9 there is no device-reported number
 * to defer to.
 */
const SCAN_FAIL_MAX_DWELL_MS = 50;

export function createLaserService(options: LaserServiceOptions): {
  connect(host: string, port: number, device: LaserDeviceInfo): void;
  /** The session's deliberate gesture. Never called on load, never persisted (G1). */
  arm(): void;
  disarm(): void;
  /** One planned frame of samples. Returns a refusal sentence, or null when written. */
  stream(samples: readonly PlannedSample[], pointRate: number): string | null;
  estop(): void;
  clearEstop(): void;
  state(): LaserServiceState;
  dispose(): void;
} {
  const deadManMs = options.deadManMs ?? DEFAULT_DEAD_MAN_MS;
  const client = createEtherDreamClient();

  let socket: TcpSocketLike | null = null;
  let device: LaserDeviceInfo | null = null;
  let phase: LaserServicePhase = "disconnected";
  let sessionOpen = false; // prepare+begin sent
  let lastPosition = { x: 0, y: 0 };
  let lastStreamAt = 0;
  let scanFail: ScanFailState = SCAN_FAIL_START;
  let scanFailBlanking = false;
  let cancelWatchdog: (() => void) | null = null;
  let received = new Uint8Array(0);

  const state = (): LaserServiceState => ({
    phase,
    clearRefused: client.state().clearRefused,
    underflowed: client.state().underflowed,
    bufferFullness: client.state().reportedFullness,
  });

  const announce = (reason: string): void => {
    options.onState?.(state(), reason);
  };

  const onBytes = (bytes: Uint8Array): void => {
    const joined = new Uint8Array(received.length + bytes.length);
    joined.set(received, 0);
    joined.set(bytes, received.length);
    let at = 0;
    while (at + RESPONSE_BYTES <= joined.length) {
      client.onResponse(parseResponse(joined, at));
      at += RESPONSE_BYTES;
      if (client.state().phase === "estopped" && phase !== "estopped") {
        phase = "estopped";
        announce("the device reported an emergency stop");
      }
    }
    received = joined.slice(at);
  };

  /**
   * G2 — fires when blocks stop arriving for ANY reason. Unconditional payloads from
   * the protocol module; then the session is disarmed, because whatever stopped the
   * stream has to be looked at by a person before light happens again.
   */
  const fireDeadMan = (why: string): void => {
    if (socket === null) return;
    for (const payload of deadManPayloads(lastPosition)) socket.write(payload);
    sessionOpen = false;
    phase = "estopped";
    announce(why);
  };

  const armWatchdog = (): void => {
    cancelWatchdog?.();
    cancelWatchdog = options.clock.every(Math.max(25, Math.floor(deadManMs / 2)), () => {
      if (phase !== "streaming") return;
      if (options.clock.now() - lastStreamAt > deadManMs) {
        fireDeadMan(
          `no point block for ${String(deadManMs)} ms — the dead-man blanked, stopped and e-stopped the device`,
        );
      }
    });
  };

  return {
    connect(host, port, info) {
      if (socket !== null) throw new Error("already connected — the laser session is exclusive");
      device = info;
      client.onBroadcast({
        mac: [0, 0, 0, 0, 0, 0],
        hwRevision: 0,
        swRevision: 0,
        bufferCapacity: info.bufferCapacity,
        maxPointRate: info.maxPointRate,
        status: {
          protocol: 0,
          lightEngineState: 0,
          playbackState: 0,
          source: 0,
          lightEngineFlags: 0,
          playbackFlags: 0,
          sourceFlags: 0,
          bufferFullness: 0,
          pointRate: 0,
          pointCount: 0,
        },
      });
      socket = options.sockets.connect(host, port);
      socket.onData(onBytes);
      socket.onClose(() => {
        // The wire itself died. The device's own link-loss e-stop covers a LOST LINK;
        // this covers the helper seeing the close first: mark and report.
        phase = "disconnected";
        sessionOpen = false;
        announce("the device connection closed");
      });
      phase = "connected";
      announce(`connected to ${host}`);
    },

    arm() {
      if (phase !== "connected") return;
      phase = "armed";
      armWatchdog();
      announce("armed — output is live when streaming begins");
    },

    disarm() {
      if (phase === "streaming" || phase === "armed") {
        if (sessionOpen && socket !== null) {
          socket.write(encodeData(blankedTail(lastPosition, TAIL_POINTS)));
          socket.write(encodeSingle(COMMAND.stop));
          sessionOpen = false;
        }
        phase = "connected";
        cancelWatchdog?.();
        cancelWatchdog = null;
        announce("disarmed");
      }
    },

    stream(samples, pointRate) {
      if (socket === null || device === null) return "no device is connected";
      if (phase !== "armed" && phase !== "streaming") {
        return phase === "estopped"
          ? "the device is emergency-stopped; clear the e-stop and re-arm first"
          : "not armed — arming is a deliberate session action and never a document state";
      }
      const rate = clampPointRate(pointRate, device.maxPointRate, options.projectorMaxPps);
      if (!sessionOpen) {
        socket.write(encodePrepare());
        socket.write(encodeBegin(0, rate));
        sessionOpen = true;
        // A fresh session is a fresh galvo history — every reopen path (arm after
        // disarm, after an e-stop clear, after the dead-man) funnels through here.
        scanFail = SCAN_FAIL_START;
        scanFailBlanking = false;
      }
      const converted = samplesToPoints(samples, lastPosition);
      lastPosition = converted.last;
      /*
       * G5 — software scan-fail, BESIDE the dead-man because they split one hazard
       * class: the dead-man covers blocks that STOP arriving, this covers blocks that
       * keep arriving with a beam that has stopped moving — the stuck plan the credit
       * model reads as perfectly healthy. The G3 tail below deliberately does NOT pass
       * through the tracker: it is unlit and would reset the dwell at every frame
       * boundary, amnestying exactly the frame-after-frame stationary beam this exists
       * to catch.
       */
      const guarded = applyScanFail(
        converted.points,
        scanFail,
        Math.max(1, Math.ceil((rate * SCAN_FAIL_MAX_DWELL_MS) / 1000)),
      );
      const block = [...guarded.points, ...blankedTail(lastPosition, TAIL_POINTS)];
      if (client.writable() < block.length) {
        // The credit model withholds rather than risking NAK-Full; the frame is simply
        // not written and the caller may retry next frame — the DAC still holds the
        // previous blanked-tailed block, so what plays out is darkness, not garbage.
        // The dwell state is NOT committed for a withheld frame: only points that
        // actually cross the wire count toward the beam's time at one spot.
        return `the device buffer has no room for ${String(block.length)} points`;
      }
      scanFail = guarded.state;
      if (guarded.blanked > 0 && !scanFailBlanking) {
        scanFailBlanking = true;
        announce(
          `scan-fail: the beam sat lit and stationary past ${String(SCAN_FAIL_MAX_DWELL_MS)} ms — the stationary run is blanked until it moves (G5)`,
        );
      } else if (guarded.blanked === 0 && scanFailBlanking) {
        scanFailBlanking = false;
        announce("scan-fail cleared — the beam is moving again");
      }
      socket.write(encodeData(block));
      client.wrote(block.length);
      lastStreamAt = options.clock.now();
      if (phase !== "streaming") {
        phase = "streaming";
        announce("streaming");
      }
      return null;
    },

    estop() {
      socket?.write(encodeSingle(COMMAND.emergencyStop));
      sessionOpen = false;
      phase = "estopped";
      announce("emergency stop sent");
    },

    clearEstop() {
      // The device may REFUSE with NAK '!' while its condition persists; the client
      // records that and `state().clearRefused` surfaces it. Never retried in a loop —
      // a held hardware e-stop hidden behind silent retries is the failure mode (G7).
      socket?.write(encodeSingle(COMMAND.clearEmergencyStop));
      if (phase === "estopped") phase = "connected";
    },

    state,

    dispose() {
      if (phase === "streaming") {
        fireDeadMan("the session ended while streaming — blanked, stopped, e-stopped");
      }
      cancelWatchdog?.();
      cancelWatchdog = null;
      socket?.close();
      socket = null;
      phase = "disconnected";
    },
  };
}

/** Referenced so the constant is part of this module's contract, not just the client's. */
export const LASER_NAK_STOP_CONDITION = RESPONSE.nakStopCondition;
