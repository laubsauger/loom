import {
  bridgeUrl,
  normalisePairingCode,
  parseBridgeMessage,
  BRIDGE_PORT,
} from "./transport/bridge-wire.ts";
import {
  browserSocket,
  sessionPairingMemory,
  type BridgeSocket,
  type BridgeSocketFactory,
  type PairingMemory,
} from "./transport/bridge-socket.ts";
import {
  oscPortOfStream,
  vetOscDestination,
  type DeviceFlowMode,
  type OscDestination,
  type OscSendOutcome,
} from "./device-protocol.ts";
import { DEVICE_HELPER_START } from "./helper.ts";
import { OSC_CHANNEL_PREFIX } from "../domain/osc/osc-address.ts";
/*
 * The state union lives in DOMAIN, beside the copy that renders it (§V359) — so a domain
 * module never has to import a transport to say why there is no OSC. This file publishes
 * that union onward for its callers; it does not own it.
 */
import type { OscBridgeState } from "../domain/osc/osc-status.ts";
import type { OscMessage } from "./osc-codec.ts";
import type { LaserCommand, LaserOutcome, VisionOutcome, VisionSegmentRequest } from "./device-protocol.ts";

/**
 * THE PAGE HALF OF THE DEVICE ROLE (T942 tier 3) — TRANSPORT ONLY (§V192).
 *
 * ## What it is, and what it deliberately is not
 *
 * A second socket to the SAME bridge on the SAME port, declaring the role `device` in its
 * first message. It moves bytes: readings in, sends out, state changes both ways. It holds
 * no mapping, no node, no React and no policy — `use-osc-bridge.ts` is where those live,
 * exactly as the agent client (`@/mcp/bridge-client.ts`) holds no tool definitions.
 *
 * ## Why a SECOND socket rather than a second message type on the page's
 *
 * Because the two have different lifetimes and different consequences. An MCP attachment
 * is one tab driving one document for an agent; a device attachment is one tab listening
 * to hardware. Closing the agent connection must not deafen the patch, and a device stream
 * that errors must not detach the agent. Sharing one socket would tie them, and the tie
 * would be discovered later, during a failure.
 *
 * ## The credential is the SAME pairing code, and that is a decision
 *
 * The device role presents the same human-typed code the `page` role does — not the proxy
 * token, which exists only in a `0600` file precisely because a page cannot read one
 * (T921). The threat model is identical: any page in any tab can open `ws://127.0.0.1`,
 * and the code is the gate. So a device attachment is exactly as hard to obtain as a page
 * attachment, and no easier.
 *
 * It also shares `sessionPairingMemory`: if the human paired this tab in this session, the
 * device socket reconnects silently on a reload, dies with the tab, and is forgotten the
 * moment a code is refused. Same lifetime, same reasoning, one implementation (§V39).
 *
 * ## READINGS ARE A REF, NOT STATE (§V16)
 *
 * An OSC fader bank pushes at hundreds of messages a second. Only the STREAM STATE and the
 * ADDRESS ROSTER — things that change when a sender starts, not when a fader moves —
 * belong in React. The numbers go into a Map the resolver reads at frame time.
 */

export interface DeviceClientOptions {
  readonly port?: number;
  readonly client?: string;
  readonly socketFactory?: BridgeSocketFactory;
  readonly memory?: PairingMemory;
  /** One silent attempt with a code this tab already paired with. Off for a cold test. */
  readonly autoConnect?: boolean;
  /** Published on every transition. The hook turns this into React state. */
  readonly onState: (state: OscBridgeState) => void;
  /** A batch of coalesced readings landed. The hook merges it into its ref. */
  readonly onReadings: (values: Readonly<Record<string, number>>, dropped: number, at: number) => void;
}

export interface DeviceClient {
  connect(pairingCode: string): void;
  disconnect(options?: { readonly forget?: boolean }): void;
  /**
   * The set of UDP ports this document wants open — the ports its `oscIn` nodes name.
   *
   * Declarative rather than incremental: the caller states what it wants and this opens
   * and closes streams to match. An `oscIn` deleted from the graph closes its socket with
   * nothing remembering to call an `unlisten`.
   */
  listen(ports: readonly number[]): void;
  /**
   * Hand messages to the helper for transmission.
   *
   * Resolves with what the helper could HONESTLY report — see `OscSendOutcome`. There is
   * no success member in that union, so a caller cannot render one.
   */
  send(to: OscDestination, packets: readonly OscMessage[]): Promise<OscSendOutcome>;
  /**
   * One attempt with the code this tab already paired with, if there is one.
   *
   * The device role has no pairing UI of its own — a pairing code must never become a node
   * parameter, because a node parameter is written into the `.loom.json`. So the ONE
   * ceremony is the agent panel's Connections section, and this is how a document that
   * starts asking for OSC afterwards picks the attachment up without a reload (§T948 rule
   * 1: probe the capability at runtime, do not gate on the deployment). A no-op while an
   * attempt is in flight and when nothing is remembered.
   */
  reconnectRemembered(): void;
  /**
   * T950 — one laser command to the helper's laser door. Resolves with the door's own
   * outcome (the vet's or the device's sentence on refusal, the measured state either
   * way); rejects only when no helper is attached, which the caller words for the user.
   */
  laser(command: LaserCommand): Promise<LaserOutcome>;
  /** T950: unsolicited laser state changes — the dead-man firing, a device e-stop. */
  onLaserState(listener: (detail: string) => void): void;
  /**
   * T1029 — one picture to the helper's vision door, one owed mask (or refusal) back.
   * Rejects only when no helper is attached; a door refusal arrives as an outcome so
   * the caller can surface its sentence per node rather than as a thrown mystery.
   */
  vision(request: VisionSegmentRequest): Promise<VisionOutcome>;
  dispose(): void;
}

export function createDeviceClient(options: DeviceClientOptions): DeviceClient {
  const openSocket = options.socketFactory ?? browserSocket;
  const url = bridgeUrl(options.port ?? BRIDGE_PORT);
  const clientName = options.client ?? "a Loom tab";
  const memory = options.memory ?? sessionPairingMemory();

  let socket: BridgeSocket | null = null;
  let wanted = false;
  let attached = false;
  let attempting: string | null = null;
  let nextId = 1;
  /** The ports the document names, re-requested whenever an attachment is re-made. */
  let wantedPorts: readonly number[] = [];
  /** Streams believed open, by UDP port. */
  const streams = new Map<number, string>();
  let flow: DeviceFlowMode = "coalesce";
  /** Sends awaiting their one reply. `id` means exactly one answer is owed (§T950 gap 1). */
  const pending = new Map<number, (outcome: OscSendOutcome) => void>();
  /** T950: laser commands awaiting their one owed reply, and their push listeners. */
  const laserPending = new Map<number, (outcome: LaserOutcome) => void>();
  /** T1029: segmentations awaiting their one owed mask. */
  const visionPending = new Map<number, (outcome: VisionOutcome) => void>();
  const laserStateListeners = new Set<(detail: string) => void>();
  let disposed = false;

  const publish = (state: OscBridgeState): void => {
    options.onState(state);
  };

  const send = (message: Record<string, unknown>): void => {
    socket?.send(JSON.stringify(message));
  };

  /** Opens what is wanted and not open; closes what is open and no longer wanted. */
  const reconcile = (): void => {
    if (!attached) return;
    for (const port of wantedPorts) {
      if (streams.has(port)) continue;
      // Marked pending with a placeholder so a second reconcile in the same tick does not
      // ask twice; the real stream id lands on `deviceSubscribed`.
      streams.set(port, "");
      send({ type: "deviceSubscribe", id: nextId++, source: { kind: "osc", port } });
    }
    for (const [port, stream] of [...streams]) {
      if (wantedPorts.includes(port)) continue;
      streams.delete(port);
      if (stream !== "") send({ type: "deviceUnsubscribe", id: nextId++, stream });
    }
    publish(streams.size === 0 ? { kind: "attached" } : { kind: "listening", ports: [...streams.keys()] });
  };

  const settleAll = (outcome: OscSendOutcome): void => {
    for (const [, resolve] of pending) resolve(outcome);
    pending.clear();
  };

  const handle = (message: Record<string, unknown>): void => {
    switch (message["type"]) {
      case "deviceAttached": {
        attached = true;
        if (attempting !== null) memory.write(attempting);
        streams.clear();
        publish({ kind: "attached" });
        reconcile();
        return;
      }
      case "refused": {
        const said = message["reason"];
        wanted = false;
        attached = false;
        memory.forget();
        closeSocket();
        publish({ kind: "refused", reason: typeof said === "string" ? said : "no reason given" });
        return;
      }
      case "deviceSubscribed": {
        const stream = message["stream"];
        if (typeof stream !== "string") return;
        if (message["flow"] === "credit") flow = "credit";
        // The helper names the stream; the port is read back OUT of that name, through the
        // wire module's own parser, so the two halves cannot disagree about which socket
        // this is or spell the id two ways (§V39).
        const port = oscPortOfStream(stream);
        if (port !== null) streams.set(port, stream);
        publish({ kind: "listening", ports: [...streams.keys()] });
        return;
      }
      case "deviceRefused": {
        const said = message["reason"];
        publish({ kind: "refused", reason: typeof said === "string" ? said : "no reason given" });
        return;
      }
      case "deviceStreamState": {
        // T950: the laser's pushes ride the shared state channel under stream "laser" —
        // routed to their own listeners, never into the OSC status machine below.
        if (message["stream"] === "laser") {
          const said = message["detail"];
          if (typeof said === "string") for (const listener of [...laserStateListeners]) listener(said);
          return;
        }
        const state = message["state"];
        const detail = message["detail"];
        const said = typeof detail === "string" ? detail : "no reason given";
        const named = message["stream"];
        if (state === "error") publish({ kind: "error", reason: said });
        else if (state === "closed") {
          for (const [port, id] of [...streams]) if (id === named) streams.delete(port);
          publish(
            !attached
              ? { kind: "idle" }
              : streams.size === 0
                ? { kind: "attached" }
                : { kind: "listening", ports: [...streams.keys()] },
          );
        } else if (state === "open") {
          publish({ kind: "listening", ports: [...streams.keys()] });
        }
        return;
      }
      case "deviceEvents": {
        // A PUSH: no `id`, nothing waiting, no reply. See `device-protocol.ts`.
        const values = message["values"];
        if (typeof values !== "object" || values === null) return;
        const numbers: Record<string, number> = {};
        for (const [name, value] of Object.entries(values as Record<string, unknown>)) {
          // Names off a socket are DATA. The prefix is CHECKED rather than assumed, so a
          // helper (or anything pretending to be one) cannot publish into another
          // resolver's namespace (§V665's lesson, from the safe side).
          if (typeof value === "number" && Number.isFinite(value) && name.startsWith(OSC_CHANNEL_PREFIX)) {
            numbers[name] = value;
          }
        }
        const dropped = typeof message["dropped"] === "number" ? message["dropped"] : 0;
        const at = typeof message["at"] === "number" ? message["at"] : 0;
        options.onReadings(numbers, dropped, at);
        // Flow control exists on the wire and is a no-op for a coalescing stream. Sent
        // anyway, so the message is exercised in the product rather than only in a test
        // when the first `credit` device lands (§T950 gap 2).
        const seq = message["seq"];
        const stream = message["stream"];
        if (flow === "credit" && typeof seq === "number" && typeof stream === "string") {
          send({ type: "deviceAck", stream, seq });
        }
        return;
      }
      case "deviceSendResult": {
        const id = message["id"];
        if (typeof id !== "number") return;
        const resolve = pending.get(id);
        if (resolve === undefined) return;
        pending.delete(id);
        const outcome = message["outcome"];
        resolve(readOutcome(outcome));
        return;
      }
      case "deviceLaserResult": {
        const id = message["id"];
        if (typeof id !== "number") return;
        const resolve = laserPending.get(id);
        if (resolve === undefined) return;
        laserPending.delete(id);
        resolve(message["outcome"] as LaserOutcome);
        return;
      }
      case "deviceVisionResult": {
        const id = message["id"];
        if (typeof id !== "number") return;
        const resolve = visionPending.get(id);
        if (resolve === undefined) return;
        visionPending.delete(id);
        resolve(message["outcome"] as VisionOutcome);
        return;
      }
      default:
        return;
    }
  };

  const closeSocket = (): void => {
    const live = socket;
    socket = null;
    attempting = null;
    streams.clear();
    if (live !== null) {
      live.onclose = null;
      live.close();
    }
  };

  const client: DeviceClient = {
    connect(pairingCode) {
      if (wanted || disposed) return;
      const code = normalisePairingCode(pairingCode);
      if (code === "") {
        publish({ kind: "refused", reason: "No pairing code entered." });
        return;
      }
      wanted = true;
      attempting = code;
      publish({ kind: "connecting" });
      let live: BridgeSocket;
      try {
        live = openSocket(url);
      } catch {
        wanted = false;
        publish({ kind: "unreachable" });
        return;
      }
      socket = live;
      live.onopen = () => {
        if (!wanted) {
          live.close();
          return;
        }
        // The code goes in the first MESSAGE, never in the URL (T398).
        live.send(JSON.stringify({ type: "deviceAttach", code, client: clientName }));
      };
      live.onmessage = (event) => {
        const message = parseBridgeMessage(event.data);
        if (message !== null) handle(message);
      };
      live.onclose = () => {
        if (socket !== live) return;
        socket = null;
        attempting = null;
        streams.clear();
        const wasAttached = attached;
        attached = false;
        streams.clear();
        settleAll({
          delivery: "failed",
          reason: "The device bridge closed before this send was answered.",
        });
        if (!wanted) return;
        wanted = false;
        publish(wasAttached ? { kind: "error", reason: "The device bridge closed the connection." } : { kind: "unreachable" });
      };
      live.onerror = () => {
        if (socket !== live) return;
        publish({ kind: "unreachable" });
      };
    },

    disconnect(disconnectOptions) {
      wanted = false;
      attached = false;
      if (disconnectOptions?.forget === true) memory.forget();
      settleAll({ delivery: "refused", reason: "The device bridge was disconnected." });
      closeSocket();
      publish({ kind: "idle" });
    },

    listen(ports) {
      const unique = [...new Set(ports)].filter((port) => Number.isInteger(port) && port > 0).sort((a, b) => a - b);
      if (unique.length === wantedPorts.length && unique.every((port, index) => port === wantedPorts[index])) return;
      wantedPorts = unique;
      reconcile();
    },

    async send(to, packets) {
      // Vetted HERE as well as in the helper. Refusing before a byte leaves the page is
      // what makes "no destination" a sentence in the inspector rather than a round trip.
      const destination = vetOscDestination(to.host, to.port);
      if (!destination.ok) return { delivery: "refused", reason: destination.reason };
      if (!attached || socket === null) {
        return {
          delivery: "refused",
          reason: `No device bridge is attached, so nothing was sent — ${DEVICE_HELPER_START}.`,
        };
      }
      if (packets.length === 0) return { delivery: "refused", reason: "Nothing to send." };
      const id = nextId++;
      const answered = new Promise<OscSendOutcome>((resolve) => {
        pending.set(id, resolve);
      });
      send({ type: "deviceSend", id, to: destination.value, packets });
      return await answered;
    },

    laser(command: LaserCommand): Promise<LaserOutcome> {
      if (socket === null || !attached) {
        return Promise.reject(
          new Error(`no device bridge is attached — ${DEVICE_HELPER_START}.`),
        );
      }
      const id = nextId++;
      const settled = new Promise<LaserOutcome>((resolve) => {
        laserPending.set(id, resolve);
      });
      send({ type: "deviceLaser", id, command });
      return settled;
    },
    onLaserState(listener) {
      laserStateListeners.add(listener);
    },
    vision(request: VisionSegmentRequest): Promise<VisionOutcome> {
      if (socket === null || !attached) {
        return Promise.reject(
          new Error(`no device bridge is attached — ${DEVICE_HELPER_START}.`),
        );
      }
      const id = nextId++;
      const settled = new Promise<VisionOutcome>((resolve) => {
        visionPending.set(id, resolve);
      });
      send({ type: "deviceVision", id, request });
      return settled;
    },
    reconnectRemembered() {
      if (wanted || attached || disposed) return;
      const code = memory.read();
      if (code === null) return;
      client.connect(code);
    },

    dispose() {
      disposed = true;
      wanted = false;
      attached = false;
      settleAll({ delivery: "refused", reason: "The tab went away." });
      closeSocket();
    },
  };

  publish({ kind: "idle" });

  const remembered = memory.read();
  if (remembered !== null && options.autoConnect !== false) client.connect(remembered);

  return client;
}

/**
 * A send outcome off the socket, validated field by field.
 *
 * An unreadable outcome becomes `failed`, never `unconfirmed`: the only two words this
 * union offers for "something happened" both mean less than the caller might hope, and
 * when we do not know which, the one that claims LESS is the honest default.
 */
function readOutcome(value: unknown): OscSendOutcome {
  if (typeof value !== "object" || value === null) {
    return { delivery: "failed", reason: "The device bridge answered with something unreadable." };
  }
  const record = value as Record<string, unknown>;
  const reason = typeof record["reason"] === "string" ? record["reason"] : "no reason given";
  if (record["delivery"] === "refused") return { delivery: "refused", reason };
  if (record["delivery"] === "unconfirmed") {
    const to = record["to"];
    const destination =
      typeof to === "object" && to !== null
        ? (to as Record<string, unknown>)
        : {};
    return {
      delivery: "unconfirmed",
      transport: "udp",
      handed: typeof record["handed"] === "number" ? record["handed"] : 0,
      to: {
        host: typeof destination["host"] === "string" ? destination["host"] : "",
        port: typeof destination["port"] === "number" ? destination["port"] : 0,
      },
      at: typeof record["at"] === "number" ? record["at"] : 0,
    };
  }
  return { delivery: "failed", reason };
}

