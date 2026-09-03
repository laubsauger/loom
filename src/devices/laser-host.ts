import { createSocket } from "node:dgram";
import { Socket } from "node:net";
import { ETHER_DREAM_BROADCAST_PORT, ETHER_DREAM_TCP_PORT, parseBroadcast, type PlannedSample } from "./ether-dream.ts";
import {
  createLaserService,
  type LaserClock,
  type LaserDeviceInfo,
  type LaserServiceState,
  type TcpSocketFactory,
} from "./laser-service.ts";
import { vetOscDestination, type LaserCommand, type LaserOutcome, type LaserStateReport } from "./device-protocol.ts";

/**
 * T950 — the helper's laser door: ONE `LaserCommand` in, ONE `LaserOutcome` out, with
 * the discovery, the vet and the dead-man on the side of the boundary that owns the
 * sockets. The page never sees a socket, an address it did not name, or a capacity
 * anyone invented.
 *
 * ## Discovery is the capacity's ONLY source (the spec's own rule)
 *
 * `connect` binds UDP 7654 and waits for the DAC's once-per-second broadcast FROM THE
 * NAMED HOST, reads `buffer_capacity` and `max_point_rate` out of it, then opens TCP
 * 7765. No broadcast within the window is a refusal with a sentence, never a default:
 * the broadcast exists precisely so nobody hardcodes either number, and a guessed
 * capacity is how a credit model overruns a real buffer.
 *
 * ## The vet runs HERE, on the socket's side
 *
 * The host is vetted with the same rules OSC egress uses (`vetOscDestination`, port
 * pinned to 7765): an IPv4 literal, never empty, never broadcast, never multicast,
 * never a DNS name. The page vets too, but a page cannot reach the wire with an address
 * this refuses — the check lives with the socket (§T458's lesson, third protocol).
 *
 * ## Per-path no-fire mechanisms (§V840), enumerated
 *
 *  - a headless/offline render: constructs no bridge session, so no laser host exists;
 *  - a live page that never armed: `stream` refuses in the SERVICE's state machine
 *    ("not armed — arming is a deliberate session action and never a document state");
 *  - a page that dies mid-stream: the bridge closes the device session, `dispose()`
 *    fires the dead-man sequence (darkness, Stop, E-Stop) on the helper's own clock;
 *  - a page that stalls mid-stream: the watchdog fires the same sequence after
 *    `deadManMs` with no block, independent of anything the page can or cannot report.
 */

export interface LaserHost {
  command(command: LaserCommand): Promise<LaserOutcome>;
  /** Unsolicited state changes (the dead-man fired, the device e-stopped). */
  onState(listener: (state: LaserStateReport, detail: string) => void): void;
  /** The page went away. Fires the dead-man if a stream was live, then releases. */
  dispose(): void;
}

/** One discovery attempt: resolve the device's own numbers, or say why not. */
export interface LaserDiscovery {
  /** Waits for a broadcast from `host`; resolves device-reported numbers or null. */
  discover(host: string, timeoutMs: number): Promise<LaserDeviceInfo | null>;
}

export interface LaserHostOptions {
  readonly sockets: TcpSocketFactory;
  readonly discovery: LaserDiscovery;
  readonly clock: LaserClock;
  readonly deadManMs?: number;
  readonly discoveryTimeoutMs?: number;
}

const DEFAULT_DISCOVERY_TIMEOUT_MS = 3500;

export function createLaserHost(options: LaserHostOptions): LaserHost {
  const listeners = new Set<(state: LaserStateReport, detail: string) => void>();
  let device: LaserDeviceInfo | null = null;
  let connected = false;
  let projectorMaxPps: number | undefined;

  const report = (state: LaserServiceState): LaserStateReport => ({
    phase: connected ? state.phase : "disconnected",
    clearRefused: state.clearRefused,
    underflowed: state.underflowed,
    bufferFullness: state.bufferFullness,
    ...(device === null ? {} : { device }),
  });

  const service = createLaserService({
    sockets: options.sockets,
    clock: options.clock,
    ...(options.deadManMs === undefined ? {} : { deadManMs: options.deadManMs }),
    get projectorMaxPps() {
      return projectorMaxPps;
    },
    onState: (state, reason) => {
      for (const listener of [...listeners]) listener(report(state), reason);
    },
  });

  const ok = (): LaserOutcome => ({ ok: true, state: report(service.state()) });
  const refuse = (reason: string): LaserOutcome => ({ ok: false, reason, state: report(service.state()) });

  return {
    async command(command) {
      switch (command.kind) {
        case "connect": {
          if (connected) return refuse("already connected — the laser session is exclusive; disconnect first");
          // Port pinned: the vet's port argument exists to validate, not to choose.
          const vetted = vetOscDestination(command.host, ETHER_DREAM_TCP_PORT);
          if (!vetted.ok) return refuse(vetted.reason);
          const found = await options.discovery.discover(
            vetted.value.host,
            options.discoveryTimeoutMs ?? DEFAULT_DISCOVERY_TIMEOUT_MS,
          );
          if (found === null) {
            return refuse(
              `no Ether Dream broadcast from ${vetted.value.host} — the DAC announces itself once per second on UDP ${String(ETHER_DREAM_BROADCAST_PORT)}, and its buffer capacity is only ever taken from that announcement, never guessed.`,
            );
          }
          device = found;
          projectorMaxPps = command.maxPps === undefined || command.maxPps <= 0 ? undefined : command.maxPps;
          service.connect(vetted.value.host, ETHER_DREAM_TCP_PORT, found);
          connected = true;
          return ok();
        }
        case "arm":
          if (!connected) return refuse("no device is connected");
          service.arm();
          return ok();
        case "disarm":
          service.disarm();
          return ok();
        case "stream": {
          const samples: PlannedSample[] = [];
          for (let at = 0; at + 5 <= command.samples.length; at += 5) {
            samples.push({
              x: command.samples[at]!,
              y: command.samples[at + 1]!,
              r: command.samples[at + 2]!,
              g: command.samples[at + 3]!,
              b: command.samples[at + 4]!,
            });
          }
          const refusal = service.stream(samples, command.pointRate);
          return refusal === null ? ok() : refuse(refusal);
        }
        case "estop":
          service.estop();
          return ok();
        case "clearEstop":
          service.clearEstop();
          return service.state().clearRefused
            ? refuse(
                "the device REFUSED to clear its emergency stop — its condition persists (a held e-stop input, an over-temperature). Resolve it at the projector; this is never retried silently.",
              )
            : ok();
        case "status":
          return ok();
      }
    },
    onState(listener) {
      listeners.add(listener);
    },
    dispose() {
      service.dispose();
      connected = false;
      device = null;
    },
  };
}

/* ------------------------------------------------------------- the real sockets */

/** `node:net`, adapted field by field — the injectable twin of the test's fake. */
export function nodeTcpSocketFactory(): TcpSocketFactory {
  return {
    connect(host, port) {
      const socket = new Socket();
      socket.connect(port, host);
      // A laser stream is latency-bound and tiny; Nagle coalescing 18-byte points into
      // 40 ms batches would BE the jitter the credit model then mismeasures.
      socket.setNoDelay(true);
      return {
        write: (bytes) => {
          socket.write(bytes);
        },
        onData: (handler) => {
          socket.on("data", (data: Buffer) => handler(new Uint8Array(data)));
        },
        onClose: (handler) => {
          socket.on("close", handler);
          socket.on("error", handler);
        },
        close: () => {
          socket.destroy();
        },
      };
    },
  };
}

/**
 * `node:dgram` on the broadcast port, one attempt per connect: resolves the FIRST
 * well-formed announcement from the named host inside the window, then closes. The
 * socket exists only for the duration of the attempt — a running helper is not a
 * standing broadcast listener (the same nothing-listens-until-asked posture as the
 * OSC hub's).
 */
export function nodeLaserDiscovery(): LaserDiscovery {
  return {
    discover(host, timeoutMs) {
      return new Promise((resolve) => {
        const socket = createSocket({ type: "udp4", reuseAddr: true });
        let settled = false;
        const settle = (value: LaserDeviceInfo | null): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          socket.close();
          resolve(value);
        };
        const timer = setTimeout(() => settle(null), timeoutMs);
        socket.on("error", () => settle(null));
        socket.on("message", (data: Buffer, rinfo: { address: string }) => {
          if (rinfo.address !== host || data.length < 36) return;
          try {
            const broadcast = parseBroadcast(new Uint8Array(data));
            if (broadcast.bufferCapacity > 0 && broadcast.maxPointRate > 0) {
              settle({ bufferCapacity: broadcast.bufferCapacity, maxPointRate: broadcast.maxPointRate });
            }
          } catch {
            // A malformed datagram on the discovery port is noise, not a failure.
          }
        });
        socket.bind(ETHER_DREAM_BROADCAST_PORT);
      });
    },
  };
}
