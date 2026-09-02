import { createSocket } from "node:dgram";

import { BRIDGE_HOST } from "./bridge-protocol.ts";
import {
  deviceStreamId,
  vetOscDestination,
  vetOscListenPort,
  type DeviceFlowMode,
  type DeviceReadings,
  type DeviceSourceDescriptor,
  type DeviceSourceSpec,
  type OscSendOutcome,
} from "./device-protocol.ts";
import { decodeOscPacket, encodeOscMessage, type OscMessage } from "./osc-codec.ts";
import { OSC_CHANNEL_CAP, oscMessageReadings } from "../domain/osc/osc-address.ts";

/**
 * THE HELPER SIDE OF THE DEVICE ROLE (T942 tier 3) — what a page cannot do for itself.
 *
 * ## What this is for
 *
 * A page can dial out to a socket. It can never LISTEN, and it can never speak a datagram.
 * That is the entire reason a helper exists (the plan's §2, Refinement A), and this module
 * is the whole of it: a UDP socket per subscription, a coalescing buffer in front of the
 * loopback push, and an egress path that reports what it can honestly know.
 *
 * ## LOOPBACK, WITH NO OPTION TO BE OTHERWISE (§T458(a))
 *
 * The ingress socket binds `BRIDGE_HOST` — the same constant, from the same module, that
 * the WebSocket listener binds — and there is no parameter here or on the wire that could
 * carry a different address. `vetOscListenPort` takes no host for that reason.
 *
 * **The limit this imposes, stated rather than discovered:** an OSC sender on ANOTHER
 * machine (a phone running TouchOSC, the common case) cannot reach a loopback-bound
 * socket. Sending from THIS machine works, which is what `tools/osc-send.mjs` is for.
 * Widening to a LAN bind is a real decision with a real argument to make — a listening
 * socket on a studio network is what §T458 measured going wrong — and it is deliberately
 * not made here by defaulting.
 *
 * ## THE EGRESS SOCKET, AND THE ONE THING IT DOES THAT IS NOT LOOPBACK
 *
 * Sending to a LAN address requires a socket the OS can route from, so the egress socket
 * is not loopback-bound: `dgram` binds it to an ephemeral port when the first datagram
 * goes out. Named because it is the one place this feature touches a non-loopback
 * interface. It SERVES nothing — no handler is attached to it, so anything arriving there
 * is dropped by this process — and every destination it is asked for has been through
 * `vetOscDestination` twice, on the page's side and again here.
 *
 * ## COALESCING IS THE BACKPRESSURE STORY FOR THIS SOURCE (§T950 gap 2)
 *
 * A fader bank sends hundreds of messages a second; a frame reads once. So readings
 * accumulate as NEWEST-PER-NAME and flush on a timer, and the flush carries `dropped` —
 * how many readings were superseded — so the page can SEE that it is behind rather than
 * watching a fader teleport. What is deliberately not built is credit: OSC has no buffer
 * to overflow. The mode is declared per stream so the device that does (§T947's Ether
 * Dream) can land without revising the protocol.
 */

/** The socket shape this module needs. Narrow, so a gate can drive it with no network. */
export interface UdpSocket {
  bind(port: number, host: string, done: (error: Error | null) => void): void;
  onMessage(handler: (bytes: Uint8Array) => void): void;
  send(bytes: Uint8Array, port: number, host: string, done: (error: Error | null) => void): void;
  close(): void;
}

export type UdpSocketFactory = () => UdpSocket;

/**
 * How often coalesced readings are pushed to the page, in milliseconds.
 *
 * ~60 Hz: the rate a frame reads at. Pushing faster would cost a socket message the page
 * throws away; pushing slower would make a fader feel late. Injectable so a gate can flush
 * on demand rather than waiting on a clock (§V44's spirit).
 */
const DEFAULT_FLUSH_MS = 16;

export interface DeviceHubOptions {
  readonly socketFactory: UdpSocketFactory;
  readonly flushMs?: number;
  /** Host clock, injectable so a gate asserts an exact `at` rather than a range. */
  readonly now?: () => number;
}

/** One attached device client's session. Dies with the socket that opened it (§T458(b)). */
export interface DeviceSession {
  subscribe(source: unknown): { readonly stream: string; readonly flow: DeviceFlowMode; readonly detail: string } | { readonly reason: string };
  unsubscribe(stream: unknown): void;
  send(to: unknown, packets: unknown): Promise<OscSendOutcome>;
  close(): void;
}

export interface DeviceHub {
  readonly sources: readonly DeviceSourceDescriptor[];
  /**
   * Opens a session for one device client.
   *
   * `onEvents` and `onState` are the PUSH channels — they carry no id, nothing waits for
   * them, and the host forwards them straight onto the socket (§T950 gap 1).
   */
  open(handlers: {
    onEvents: (stream: string, at: number, seq: number, dropped: number, values: DeviceReadings) => void;
    onState: (stream: string, state: "open" | "error" | "closed", detail: string) => void;
  }): DeviceSession;
  dispose(): void;
}

interface Stream {
  readonly id: string;
  readonly socket: UdpSocket;
  /** Newest value per channel name since the last flush. */
  readonly pending: Map<string, number>;
  /** Readings superseded since the last flush. Reported, never swallowed (§V469). */
  dropped: number;
  seq: number;
  /** Distinct names published on this stream, for the cap. */
  readonly known: Set<string>;
  capReported: boolean;
}

export function createDeviceHub(options: DeviceHubOptions): DeviceHub {
  const flushMs = options.flushMs ?? DEFAULT_FLUSH_MS;
  const now = options.now ?? ((): number => Date.now());
  const sessions = new Set<{ close: () => void }>();
  let disposed = false;

  const sources: readonly DeviceSourceDescriptor[] = [
    {
      kind: "osc",
      detail: `OSC over UDP, listening on ${BRIDGE_HOST} only — a sender on another machine cannot reach it.`,
    },
  ];

  const open: DeviceHub["open"] = (handlers) => {
    const streams = new Map<string, Stream>();
    /** Opened lazily on the first send, so a page that only listens never touches egress. */
    let egress: UdpSocket | null = null;
    let timer: ReturnType<typeof setInterval> | null = null;
    let closed = false;

    const flushOne = (stream: Stream): void => {
      if (stream.pending.size === 0 && stream.dropped === 0) return;
      const values: Record<string, number> = {};
      for (const [name, value] of stream.pending) values[name] = value;
      const dropped = stream.dropped;
      stream.pending.clear();
      stream.dropped = 0;
      stream.seq += 1;
      handlers.onEvents(stream.id, now(), stream.seq, dropped, values);
    };

    const flush = (): void => {
      for (const stream of streams.values()) flushOne(stream);
    };

    const ensureTimer = (): void => {
      if (timer !== null) return;
      timer = setInterval(flush, flushMs);
      (timer as { unref?: () => void }).unref?.();
    };

    const session: DeviceSession = {
      subscribe(source) {
        if (closed || disposed) return { reason: "The device bridge is shutting down." };
        if (typeof source !== "object" || source === null) {
          return { reason: "That subscription named no source." };
        }
        const spec = source as Partial<DeviceSourceSpec>;
        if (spec.kind !== "osc") {
          return { reason: `This bridge serves OSC sources only, and that one said "${String(spec.kind)}".` };
        }
        const port = vetOscListenPort(spec.port);
        if (!port.ok) return { reason: port.reason };
        const id = deviceStreamId({ kind: "osc", port: port.value });
        const existing = streams.get(id);
        if (existing !== undefined) {
          return { stream: id, flow: "coalesce", detail: `Already listening on ${BRIDGE_HOST}:${String(port.value)}.` };
        }
        const socket = options.socketFactory();
        const stream: Stream = {
          id,
          socket,
          pending: new Map(),
          dropped: 0,
          seq: 0,
          known: new Set(),
          capReported: false,
        };
        streams.set(id, stream);
        socket.onMessage((bytes) => {
          const decoded = decodeOscPacket(bytes);
          if (decoded.error !== null && decoded.messages.length === 0) {
            // Said once per stream rather than per packet: a sender speaking something
            // else entirely would otherwise flood the page with the same sentence.
            handlers.onState(id, "error", `An OSC packet could not be read: ${decoded.error}`);
            return;
          }
          for (const message of decoded.messages) {
            for (const [name, value] of oscMessageReadings(message.address, message.args)) {
              if (!stream.known.has(name)) {
                if (stream.known.size >= OSC_CHANNEL_CAP) {
                  if (!stream.capReported) {
                    stream.capReported = true;
                    handlers.onState(
                      id,
                      "error",
                      `More than ${String(OSC_CHANNEL_CAP)} distinct OSC addresses arrived; further new addresses are ignored. Narrow what the sender transmits.`,
                    );
                  }
                  continue;
                }
                stream.known.add(name);
              }
              if (stream.pending.has(name)) stream.dropped += 1;
              stream.pending.set(name, value);
            }
          }
        });
        socket.bind(port.value, BRIDGE_HOST, (error) => {
          if (error !== null) {
            streams.delete(id);
            socket.close();
            handlers.onState(id, "error", `Could not listen on ${BRIDGE_HOST}:${String(port.value)} — ${error.message}`);
            return;
          }
          handlers.onState(id, "open", `Listening for OSC on ${BRIDGE_HOST}:${String(port.value)}.`);
        });
        ensureTimer();
        return {
          stream: id,
          flow: "coalesce",
          detail: `Opening ${BRIDGE_HOST}:${String(port.value)}.`,
        };
      },

      unsubscribe(stream) {
        if (typeof stream !== "string") return;
        const live = streams.get(stream);
        if (live === undefined) return;
        streams.delete(stream);
        live.socket.close();
        handlers.onState(stream, "closed", "The page stopped listening.");
      },

      async send(to, packets) {
        if (closed || disposed) {
          return { delivery: "refused", reason: "The device bridge is shutting down." };
        }
        const record = typeof to === "object" && to !== null ? (to as Record<string, unknown>) : {};
        // Vetted HERE as well as on the page's side. The check belongs on the side that
        // owns the socket: a page that skipped its own vet must still not reach the wire.
        const destination = vetOscDestination(record["host"], record["port"]);
        if (!destination.ok) return { delivery: "refused", reason: destination.reason };
        if (!Array.isArray(packets) || packets.length === 0) {
          return { delivery: "refused", reason: "That send carried no messages." };
        }
        const encoded: Uint8Array[] = [];
        for (const packet of packets as readonly unknown[]) {
          if (typeof packet !== "object" || packet === null) continue;
          const message = packet as Partial<OscMessage>;
          if (typeof message.address !== "string" || !Array.isArray(message.args)) continue;
          const bytes = encodeOscMessage(message.address, message.args as readonly number[]);
          if (bytes !== null) encoded.push(bytes);
        }
        if (encoded.length === 0) {
          return {
            delivery: "refused",
            reason: "Nothing in that send could be encoded — an address must start with / and every value must be a finite number.",
          };
        }
        if (egress === null) egress = options.socketFactory();
        const socket = egress;
        let failure: string | null = null;
        for (const bytes of encoded) {
          const error = await new Promise<Error | null>((resolve) => {
            socket.send(bytes, destination.value.port, destination.value.host, resolve);
          });
          if (error !== null) {
            failure = error.message;
            break;
          }
        }
        if (failure !== null) return { delivery: "failed", reason: failure };
        /*
         * THE ONE ANSWER UDP PERMITS (§T950 gap 3). The OS accepted these datagrams from
         * us. Nothing here, and nothing that could ever be added here, knows whether they
         * arrived — so the word is `unconfirmed` and there is no other word available in
         * the union to reach for.
         */
        return {
          delivery: "unconfirmed",
          transport: "udp",
          handed: encoded.length,
          to: destination.value,
          at: now(),
        };
      },

      close() {
        if (closed) return;
        closed = true;
        sessions.delete(session);
        if (timer !== null) clearInterval(timer);
        timer = null;
        for (const stream of streams.values()) stream.socket.close();
        streams.clear();
        egress?.close();
        egress = null;
      },
    };

    sessions.add(session);
    return session;
  };

  return {
    sources,
    open,
    dispose() {
      disposed = true;
      for (const session of sessions) session.close();
      sessions.clear();
    },
  };
}

/**
 * The real socket, adapted field by field (`node:dgram`).
 *
 * This module is NODE-SIDE ONLY — the page half is `device-client.ts` and never imports
 * it, which is what keeps a node builtin out of the app's bundle graph.
 */
export function nodeUdpSocketFactory(): UdpSocketFactory {
  return () => {
    const socket = createSocket({ type: "udp4", reuseAddr: false });
    let handler: ((bytes: Uint8Array) => void) | null = null;
    socket.on("message", (data: Buffer) => {
      handler?.(new Uint8Array(data));
    });
    // An error on a UDP socket is not fatal to the process and must not be: an ICMP
    // port-unreachable from a destination nobody is listening on arrives here.
    socket.on("error", () => undefined);
    socket.unref();
    return {
      bind(port, host, done) {
        const fail = (error: Error): void => {
          socket.off("error", fail);
          done(error);
        };
        socket.once("error", fail);
        socket.bind(port, host, () => {
          socket.off("error", fail);
          done(null);
        });
      },
      onMessage(next) {
        handler = next;
      },
      send(bytes, port, host, done) {
        socket.send(bytes, port, host, (error) => {
          done(error ?? null);
        });
      },
      close() {
        try {
          socket.close();
        } catch {
          // Already closed, or never bound. Nothing to say.
        }
      },
    };
  };
}
