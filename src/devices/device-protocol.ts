/**
 * THE DEVICE ROLE — A THIRD ROLE ON THE BRIDGE THAT ALREADY EXISTS (T942 tier 3, T950).
 *
 * ## There is no second server here, and that is the whole design
 *
 * The helper's listener (`@/mcp/bridge-host.ts`) is already a loopback WebSocket host with an
 * origin allowlist, a CSPRNG pairing code, one-page-at-a-time, EADDRINUSE→proxy and
 * retry-on-free (T921).
 * Everything below is a THIRD ROLE on that socket, alongside `page` and `proxy`. Nothing
 * about the listener changes: same process, same `BRIDGE_HOST = "127.0.0.1"`, same port,
 * same `isPermittedOrigin`, same code — all of them from `./transport/bridge-wire.ts`, which
 * is where the posture is argued. This file only adds messages.
 *
 * **§T458's three measured findings, and where each is already answered:**
 *
 *  - **(a) it bound the wildcard (`*:4797`) and called itself a local relay.** The device
 *    role adds no listener, so it inherits `BRIDGE_HOST` verbatim — and the ONE new
 *    listener OSC needs (a UDP socket) is bound to the same constant by
 *    `vetOscListenPort`, which takes no host at all. There is no parameter anywhere in
 *    this feature that could be set to `0.0.0.0`, which is `./transport/bridge-wire.ts`'s own
 *    argument applied to a second protocol.
 *  - **(b) it did not isolate channels — any connected client could invoke another's
 *    tools.** One `device` client at a time, refused BY NAME, exactly as `page` is. A
 *    device client's subscriptions and its egress destinations belong to that connection
 *    and die with it, so there is no roster for a second client to reach across. The
 *    device role also never occupies the page slot and never sees a tool: a socket that
 *    presented a pairing code as `device` cannot then call `callTool`, because the role is
 *    settled once, in the first message, and the handler for one role does not read the
 *    other's messages.
 *  - **(c) no rate limiting on registration.** Unchanged and inherited: the host closes on
 *    the first wrong code, so there is no guessing loop to run. The device role adds
 *    `BRIDGE_ATTACH_TIMEOUT_MS` silence handling from the same code path.
 *
 * **The one new exposure, named rather than glossed (the plan's §7.1):** the MCP bridge
 * lets an agent DRIVE Loom; the device bridge lets Loom REACH THE NETWORK. The mitigation
 * is structural and is the reason `vetOscDestination` exists: **the helper transmits only
 * to a destination the page named in the request, there is no default destination
 * anywhere, and broadcast and multicast are refused by name.**
 *
 * ## GAP 1 (§T950) — THE STREAMING SHAPE, AND THE RULE THAT MAKES IT UNAMBIGUOUS
 *
 * The MCP protocol is request/response with a numeric `id`. OSC is pushed. So the device
 * role carries both, and they are told apart by ONE structural rule that is worth stating
 * because everything after it depends on it:
 *
 *   **After the handshake, the PRESENCE OF `id` on a HOST→PAGE message decides what it is.
 *   `id` present: this is the one reply owed to that request. `id` absent: this is an
 *   unsolicited PUSH, and `stream` names which stream it belongs to.**
 *
 * The handshake is the two messages either side of that rule — `deviceAttached` and
 * `refused`, the answers to `deviceAttach` — and they carry neither, exactly as the page
 * role's `attached`/`refused` do. There is only ever one attach in flight per socket, so
 * there is nothing for an id to disambiguate.
 *
 * That is the question a reader has to answer at runtime — "do I resolve a pending promise,
 * or hand this to the resolver?" — and it is decidable from one field, which is why it is
 * asserted structurally rather than left as a convention. `deviceEvents` and
 * `deviceStreamState` therefore carry NO `id`, ever, and nothing waits for them.
 *
 * `deviceSubscribed` legitimately carries both, and the pairing is the point: it is the
 * reply that TELLS the page which stream its request opened, so every push that follows can
 * be routed by a name the page now knows. A `stream` on a message with an `id` is a value
 * being returned; a `stream` on a message without one is a routing tag.
 *
 * The PAGE→HOST direction reads the same way: a request carries an `id` because exactly one
 * answer is owed, and `stream` appears there as an ARGUMENT naming what to act on
 * (`deviceUnsubscribe`). `deviceAck` carries no `id` because no answer is owed — flow
 * control is told, not asked.
 *
 * ## GAP 2 (§T950) — BACKPRESSURE: ROOM LEFT, NOTHING BUILT
 *
 * OSC does not need credit-based flow control; the Ether Dream later WILL (`buffer_fullness`
 * in every status, NAK-Full on overflow), and a protocol that cannot express it would have
 * to be revised rather than extended. So the shape is here and the mechanism is not:
 *
 *  - every subscription reply DECLARES its flow mode (`coalesce` today, `credit` reserved),
 *    so a consumer reads what it is getting instead of assuming;
 *  - every push carries `seq` and `dropped`, so coalescing is VISIBLE — a page that fell
 *    behind is told how many readings it never saw (§V469: a swallowed refusal is worse
 *    than a slow one), rather than silently seeing a smooth fader jump;
 *  - `deviceAck` exists on the wire. A `coalesce` source accepts and ignores it. A future
 *    `credit` source will refuse to send past an unacked window, and the page half will
 *    already be speaking the message.
 *
 * ## GAP 3 (§T950) — DATAGRAM SEMANTICS: A SEND MUST NOT LOOK LIKE AN ARRIVAL
 *
 * Request/response framing implies a reliability UDP does not have. `sendOsc` crosses a
 * loopback socket to a helper that hands bytes to `dgram.send`; the helper learns whether
 * the LOCAL write succeeded and can never learn whether anything received it. So
 * `OscSendOutcome` has three members and **`delivered` is not one of them**:
 *
 *   `refused`      — nothing was transmitted, and why (no destination, broadcast, cap).
 *   `failed`       — the local socket rejected the write, in the OS's own words.
 *   `unconfirmed`  — the bytes left this machine. Arrival is UNKNOWABLE and this word is
 *                    the only one that says so.
 *
 * The vocabulary is the guarantee: there is no success word in this union, so no caller
 * can render one, and a UI that wanted to say "sent ✓" has to reach for a word that is not
 * there. Its own test pins the member names for exactly that reason.
 *
 * ## GAP 4 (§T950) — NO DEFAULT DESTINATION, ANYWHERE
 *
 * Art-Net's default is a broadcast address and OSC out takes a host and a port; defaulting
 * either is §T458's mistake wearing a different protocol. So:
 *
 *  - `oscOut`'s `host` defaults to `""` and its `port` to `0` — a fresh node transmits
 *    NOTHING and says so;
 *  - `vetOscDestination` refuses an empty host, an out-of-range port, the limited and
 *    directed broadcast addresses, the multicast range, and any name that would need DNS;
 *  - the helper vets every request again on arrival, so a page cannot reach the socket
 *    with a destination the vet would refuse — the check is on the side that owns the
 *    socket, not only on the side that asked.
 */

import type { OscMessage } from "./osc-codec.ts";

/** What a device client asks the helper to open. One kind today; the union is the seam. */
export type DeviceSourceSpec = {
  readonly kind: "osc";
  /** UDP port to listen on, loopback only. There is no default — see the module note. */
  readonly port: number;
};

/** What the helper can do, announced on attach so a picker is DATA rather than a dialog. */
export interface DeviceSourceDescriptor {
  readonly kind: "osc";
  /** One sentence a human reads. Rendered as text, never interpreted. */
  readonly detail: string;
}

/**
 * How a stream handles a consumer that cannot keep up.
 *
 * `coalesce` — the helper keeps only the newest reading per channel between frames and
 * reports how many it dropped. Right for control data: an OSC fader's history between two
 * frames is not information, its POSITION is.
 *
 * `credit` — RESERVED, unimplemented, and named here on purpose (§T950 gap 2). A device
 * with a finite buffer (the Ether Dream's `buffer_fullness`) cannot be coalesced; it must
 * be able to refuse. Declaring the mode per stream is what lets that land without a
 * protocol revision.
 */
export type DeviceFlowMode = "coalesce" | "credit";

/** One frame's worth of readings from one stream: newest value per channel name. */
export type DeviceReadings = Readonly<Record<string, number>>;

/** Where an OSC message is being sent. Never defaulted — see the module note. */
export interface OscDestination {
  readonly host: string;
  readonly port: number;
}

/**
 * What happened to a `deviceSend`.
 *
 * THERE IS NO `delivered` MEMBER AND THERE MUST NEVER BE ONE. See the module note.
 */
export type OscSendOutcome =
  | {
      readonly delivery: "refused";
      /** Why nothing was transmitted. Shown to the user verbatim. */
      readonly reason: string;
    }
  | {
      readonly delivery: "failed";
      /** The local socket's own words. The write did not leave this machine. */
      readonly reason: string;
    }
  | {
      readonly delivery: "unconfirmed";
      readonly transport: "udp";
      /** How many datagrams the OS accepted from us. NOT how many arrived. */
      readonly handed: number;
      readonly to: OscDestination;
      /** Host clock at the hand-off, for a staleness display (the plan's §6.4). */
      readonly at: number;
    };

/* ------------------------------------------------------------------- laser (T950) */

/**
 * T950 — the LASER command family, request/response on the device role.
 *
 * Request/response FITS this device: the Ether Dream itself answers every command with a
 * full status, so the reply channel carries the device's own state and no server-push
 * stream is needed for the streaming path (gap 1's shape, resolved by the protocol being
 * command-shaped all the way down). The pushes that DO exist ride `deviceStreamState`
 * with stream `"laser"`: the dead-man firing, a device-initiated e-stop — things that
 * happen when the page is NOT asking, which is exactly what the push rule is for.
 *
 * Samples travel as a flat number array, five per sample (x, y in clip space, r, g, b in
 * 0..1): 500 samples ≈ 5 KB of JSON, three orders of magnitude inside the measured
 * budget (the plan's §12 arithmetic) — the laser path must never be used to justify
 * binary transport.
 */
export type LaserCommand =
  | {
      readonly kind: "connect";
      /** The DAC's LAN address. Vetted by `vetOscDestination` — an IPv4 literal, never
       *  broadcast, never multicast, never a name (a laser network is a network). */
      readonly host: string;
      /** An author-set projector ceiling for G9; lowers the device max, never raises. */
      readonly maxPps?: number;
    }
  | { readonly kind: "arm" }
  | { readonly kind: "disarm" }
  | {
      readonly kind: "stream";
      /** Flat (x, y, r, g, b) per sample. */
      readonly samples: readonly number[];
      readonly pointRate: number;
    }
  | { readonly kind: "estop" }
  | { readonly kind: "clearEstop" }
  | { readonly kind: "status" };

/** The laser session's state, as the HELPER reports it — measured, never echoed. */
export interface LaserStateReport {
  readonly phase: "disconnected" | "connected" | "armed" | "streaming" | "estopped";
  readonly clearRefused: boolean;
  readonly underflowed: boolean;
  readonly bufferFullness: number;
  /** Device-reported via discovery; absent until connected. Never hardcoded. */
  readonly device?: { readonly bufferCapacity: number; readonly maxPointRate: number };
}

export type LaserOutcome =
  | { readonly ok: true; readonly state: LaserStateReport }
  /** Refused or failed, with the sentence a human acts on (§V288/§V365). */
  | { readonly ok: false; readonly reason: string; readonly state: LaserStateReport };

/**
 * T1029 — one segmentation request: the page's picture, the helper's mask.
 *
 * Pixels cross as BASE64, not a number array: a 640×360 RGBA frame is ~900 KB raw and a
 * JSON number array multiplies that ~5×, while base64 costs 4/3 — measured against the
 * laser's flat-array precedent, whose frames are three orders smaller (~5 KB). The mask
 * comes back the same way. Vision picks its own mask size (aspect-preserving, ~512 on
 * the long side), so the reply carries the dimensions it chose rather than echoing the
 * request's.
 */
export interface VisionSegmentRequest {
  readonly width: number;
  readonly height: number;
  /** RGBA8, row-major, base64. */
  readonly rgbaBase64: string;
}

export type VisionOutcome =
  | {
      readonly ok: true;
      readonly maskWidth: number;
      readonly maskHeight: number;
      /** One byte per pixel, 0..255 person confidence, base64. */
      readonly maskBase64: string;
      /** Helper-side wall time for the segmentation, ms. Telemetry only. */
      readonly millis: number;
    }
  | { readonly ok: false; readonly reason: string };

/** PAGE → HOST, device role. Requests carry `id`; `deviceAck` is not a request. */
export type DeviceClientMessage =
  | { readonly type: "deviceAttach"; readonly code: string; readonly client: string }
  | { readonly type: "deviceSubscribe"; readonly id: number; readonly source: DeviceSourceSpec }
  | { readonly type: "deviceUnsubscribe"; readonly id: number; readonly stream: string }
  | {
      readonly type: "deviceSend";
      readonly id: number;
      readonly to: OscDestination;
      readonly packets: readonly OscMessage[];
    }
  /** T950: one laser command, one owed reply. The helper vets and executes. */
  | { readonly type: "deviceLaser"; readonly id: number; readonly command: LaserCommand }
  /** T1029: one picture in, one owed mask (or refusal) back. Request/response fits —
   *  every ask has exactly one answer and nothing about a mask is unsolicited. */
  | { readonly type: "deviceVision"; readonly id: number; readonly request: VisionSegmentRequest }
  /** Flow control. No `id`, no reply; a `coalesce` stream accepts and ignores it. */
  | { readonly type: "deviceAck"; readonly stream: string; readonly seq: number };

/** HOST → PAGE, device role. Replies carry `id`; pushes carry `stream` and never `id`. */
export type DeviceHostMessage =
  | { readonly type: "deviceAttached"; readonly sources: readonly DeviceSourceDescriptor[] }
  | { readonly type: "refused"; readonly reason: string }
  | {
      readonly type: "deviceSubscribed";
      readonly id: number;
      readonly stream: string;
      readonly flow: DeviceFlowMode;
      readonly detail: string;
    }
  | { readonly type: "deviceRefused"; readonly id: number; readonly reason: string }
  | { readonly type: "deviceSendResult"; readonly id: number; readonly outcome: OscSendOutcome }
  | { readonly type: "deviceLaserResult"; readonly id: number; readonly outcome: LaserOutcome }
  | { readonly type: "deviceVisionResult"; readonly id: number; readonly outcome: VisionOutcome }
  /** PUSH. Unsolicited, no `id`, nothing waits for it. */
  | {
      readonly type: "deviceEvents";
      readonly stream: string;
      /** Host clock when this batch was closed, so the page can age it (the plan's §6.4). */
      readonly at: number;
      /** Monotonic per stream. A gap is a lost push, not a lost reading. */
      readonly seq: number;
      /** Readings coalesced away since the last push. Visible, never swallowed (§V469). */
      readonly dropped: number;
      readonly values: DeviceReadings;
    }
  /** PUSH. Why a stream is the way it is (§V359 — the reason travels with the absence). */
  | {
      readonly type: "deviceStreamState";
      readonly stream: string;
      readonly state: "open" | "error" | "closed";
      readonly detail: string;
    };

/** The lowest UDP port this helper will bind. Below 1024 needs privilege we must not want. */
export const MIN_OSC_PORT = 1024;
export const MAX_PORT = 65_535;

/** What a vet said. `ok: false` always carries a sentence a human can act on (§V288). */
export type Vetted<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly reason: string };

/**
 * May the helper listen on this UDP port?
 *
 * Takes NO host. That is the §T458(a) answer in the type signature rather than in a
 * comment: there is no argument here that could carry `0.0.0.0`, so the caller binds
 * `BRIDGE_HOST` because it is the only address this function's callers know.
 *
 * Ports below 1024 are refused because binding one needs privilege, and a feature that
 * asks a user to run a helper as root to hear a fader is a feature with a worse answer.
 * OSC's conventional 8000/9000 and TouchOSC's defaults are all above it.
 */
export function vetOscListenPort(port: unknown): Vetted<number> {
  if (typeof port !== "number" || !Number.isInteger(port)) {
    return { ok: false, reason: "An OSC listen port must be a whole number." };
  }
  if (port < MIN_OSC_PORT || port > MAX_PORT) {
    return { ok: false, reason: `An OSC listen port must be between ${String(MIN_OSC_PORT)} and ${String(MAX_PORT)}.` };
  }
  return { ok: true, value: port };
}

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/**
 * May the helper transmit to this destination? (§T950 gap 4.)
 *
 * Refuses, each by name:
 *
 *  - **an empty host or a zero port** — a node with no destination set transmits nothing,
 *    which is the default and the point;
 *  - **`255.255.255.255` and any address ending `.255`** — the limited and the common
 *    directed broadcast. Art-Net's own default is a broadcast address and copying that
 *    habit into OSC is §T458's mistake in a different protocol;
 *  - **`224.0.0.0`–`239.255.255.255`** — multicast is a broadcast with better manners and
 *    is the same decision;
 *  - **anything that is not an IPv4 literal or `localhost`** — a hostname needs DNS, and
 *    resolving one turns "where does this go" into a question answered by a server rather
 *    than by the document. Named as a limit rather than left as a mystery: a studio
 *    destination is an address on a LAN, and typing it is the honest interface.
 */
export function vetOscDestination(host: unknown, port: unknown): Vetted<OscDestination> {
  const name = typeof host === "string" ? host.trim() : "";
  if (name === "") {
    return { ok: false, reason: "No destination. Set the Host on the OSC Out node — there is no default." };
  }
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > MAX_PORT) {
    return { ok: false, reason: `No destination port. Set Port between 1 and ${String(MAX_PORT)}.` };
  }
  if (name === "localhost") return { ok: true, value: { host: "127.0.0.1", port } };
  const match = IPV4.exec(name);
  if (match === null) {
    return {
      ok: false,
      reason: `"${name}" is not an IPv4 address. This build sends to a literal address or localhost, never a name that needs DNS.`,
    };
  }
  const octets = match.slice(1).map((part) => Number(part));
  if (octets.some((octet) => octet > 255)) {
    return { ok: false, reason: `"${name}" is not a valid IPv4 address.` };
  }
  if (octets[3] === 255) {
    return {
      ok: false,
      reason: `"${name}" is a broadcast address. This build never broadcasts — name one machine.`,
    };
  }
  const first = octets[0] ?? 0;
  if (first >= 224 && first <= 239) {
    return {
      ok: false,
      reason: `"${name}" is a multicast address. This build never multicasts — name one machine.`,
    };
  }
  if (first === 0) {
    return { ok: false, reason: `"${name}" is not a routable destination.` };
  }
  return { ok: true, value: { host: name, port } };
}

/** The stream id for one source spec. Stable, so a resubscribe addresses the same stream. */
export function deviceStreamId(source: DeviceSourceSpec): string {
  return `osc:${String(source.port)}`;
}

/**
 * The UDP port a stream id names, or null.
 *
 * The inverse of `deviceStreamId`, here rather than spelled out at the page's end: the two
 * halves are in different runtimes and the one thing that must not drift is the wire
 * (`./transport/bridge-wire.ts`'s own rule). The page reads the port back OUT of the id the
 * helper chose rather than assuming its request was answered with the port it asked for.
 */
export function oscPortOfStream(stream: unknown): number | null {
  if (typeof stream !== "string" || !stream.startsWith("osc:")) return null;
  const port = Number(stream.slice("osc:".length));
  return Number.isInteger(port) && port > 0 ? port : null;
}
