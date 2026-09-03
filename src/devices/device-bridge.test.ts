import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createNodeRegistry } from "../nodes/registry/registry.ts";
import { allNodeDefinitions } from "../nodes/definitions/index.ts";
import { createValueGraphSession } from "../domain/channels/value-graph.ts";
import { resolveParameters } from "../domain/parameters/index.ts";
import { effectiveParameterSchema } from "../domain/parameters/resolve.ts";
import type { GraphDocument, GraphNode } from "../domain/types/graph.ts";
import type { NodeId } from "../domain/types/ids.ts";
import type { FrameEvaluationInput } from "../domain/types/frame.ts";
import { createHeadlessMcpServer } from "../mcp/serve.ts";
import { createDeviceClient } from "./device-client.ts";
import type { UdpSocket, UdpSocketFactory } from "./device-hub.ts";
import { encodeOscMessage } from "./osc-codec.ts";
import type { OscBridgeState } from "../domain/osc/osc-status.ts";
import type { OscSendOutcome } from "./device-protocol.ts";

/**
 * THE DEVICE BRIDGE, OVER A REAL SOCKET (T942 tier 3, §V382).
 *
 * ## Why this suite refuses to stub the loopback transport
 *
 * §V382: a test stubbed at the boundary its author wrote asserts the CALLBACK, not the
 * bytes. So the WebSocket half is real on both sides — the product's `createDeviceClient`
 * with its default browser socket (Node's global `WebSocket`) against a real
 * `createHeadlessMcpServer` — and the handshake, the masking and the frame codec are all
 * exercised in both directions.
 *
 * ## What IS faked, and why that is the honest line
 *
 * The UDP socket, and only the UDP socket. §T959 shipped `tools/midi-sender.html` plus an
 * injectable `MIDIAccess` for exactly this reason: a gate cannot plug in hardware, and a
 * suite that bound real UDP ports would start depending on what else is running on the
 * machine. The hand-testing half is `tools/osc-send.mjs` and `tools/osc-listen.mjs`;
 * this half replaces the operating system and NOTHING else — the OSC bytes are real, the
 * codec is real, the coalescing is real, the vetting is real.
 *
 * ## THE FOUR GATES THIS ROW OWES, each named on its describe block
 *
 *  1. an OSC message drives a PARAMETER, end to end, through the real value graph;
 *  2. `oscOut` sends and the result does NOT OVERSTATE DELIVERY;
 *  3. an unreachable bridge DEGRADES WITH A STATED REASON;
 *  4. there is NO DEFAULT DESTINATION.
 */

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

async function until(predicate: () => boolean, what: string, budgetMs = 5_000): Promise<void> {
  const deadline = Date.now() + budgetMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}.`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** One datagram the helper handed to the operating system. */
interface Handed {
  readonly bytes: Uint8Array;
  readonly port: number;
  readonly host: string;
}

/**
 * The operating system, replaced.
 *
 * `bind` succeeds unless the test says otherwise; `send` records unless the test says
 * otherwise. `deliver` is how a test plays the part of an OSC sender: it pushes bytes into
 * whichever socket bound the port, which is the same path a real datagram takes.
 */
function fakeUdp(): {
  readonly factory: UdpSocketFactory;
  readonly handed: Handed[];
  deliver(port: number, bytes: Uint8Array): void;
  boundPorts(): readonly number[];
  failNextBindWith(message: string): void;
  failNextSendWith(message: string): void;
} {
  const bound = new Map<number, (bytes: Uint8Array) => void>();
  const handed: Handed[] = [];
  let bindFailure: string | null = null;
  let sendFailure: string | null = null;

  const factory: UdpSocketFactory = () => {
    let handler: ((bytes: Uint8Array) => void) | null = null;
    let boundPort: number | null = null;
    const socket: UdpSocket = {
      bind(port, host, done) {
        // The host is asserted, not ignored: §T458(a) is the finding that a "local" relay
        // bound the wildcard, and the only place that can be caught is where bind is called.
        expect(host).toBe("127.0.0.1");
        const failure = bindFailure;
        bindFailure = null;
        if (failure === null) {
          boundPort = port;
          bound.set(port, (bytes) => handler?.(bytes));
        }
        // ASYNCHRONOUS, because `dgram.bind` is. A synchronous callback here would report
        // a bind failure BEFORE the subscription was answered and the page would end on
        // the wrong state — a fake that is easier than the real thing is a fake that
        // proves an ordering the product never sees (§V382's spirit).
        queueMicrotask(() => {
          done(failure === null ? null : new Error(failure));
        });
      },
      onMessage(next) {
        handler = next;
      },
      send(bytes, port, host, done) {
        if (sendFailure !== null) {
          const message = sendFailure;
          sendFailure = null;
          done(new Error(message));
          return;
        }
        handed.push({ bytes, port, host });
        done(null);
      },
      close() {
        if (boundPort !== null) bound.delete(boundPort);
        boundPort = null;
      },
    };
    return socket;
  };

  return {
    factory,
    handed,
    deliver(port, bytes) {
      const target = bound.get(port);
      if (target === undefined) throw new Error(`Nothing is listening on ${String(port)}`);
      target(bytes);
    },
    boundPorts: () => [...bound.keys()],
    failNextBindWith(message) {
      bindFailure = message;
    },
    failNextSendWith(message) {
      sendFailure = message;
    },
  };
}

interface DeviceHarness {
  readonly port: number;
  readonly pairingCode: string;
  readonly udp: ReturnType<typeof fakeUdp>;
  readonly server: ReturnType<typeof createHeadlessMcpServer>;
}

async function bridgedServer(): Promise<DeviceHarness> {
  const directory = mkdtempSync(join(tmpdir(), "loom-device-"));
  cleanups.push(() => {
    rmSync(directory, { recursive: true, force: true });
  });
  const udp = fakeUdp();
  const server = createHeadlessMcpServer({
    send: () => undefined,
    bridge: {
      // Port 0: the OS picks, so parallel suites never collide on the shared constant.
      port: 0,
      handoffDir: directory,
      udpSocketFactory: udp.factory,
      // Flushed by hand in these tests rather than on a timer, so nothing waits on a clock.
      deviceFlushMs: 5,
    },
  });
  cleanups.push(() => {
    server.dispose();
  });
  await until(() => server.bridgeStatus()?.port != null, "the bridge to bind a port");
  const status = server.bridgeStatus();
  if (status?.port == null || status.pairingCode === null) throw new Error("bridge reported no port");
  return { port: status.port, pairingCode: status.pairingCode, udp, server };
}

interface AttachedDevice {
  readonly states: OscBridgeState[];
  readonly readings: Map<string, number>;
  readonly drops: number[];
  readonly client: ReturnType<typeof createDeviceClient>;
  state(): OscBridgeState;
}

function attachDevice(harness: { port: number }, code: string, options: { autoConnect?: boolean } = {}): AttachedDevice {
  const states: OscBridgeState[] = [];
  const readings = new Map<string, number>();
  const drops: number[] = [];
  const client = createDeviceClient({
    port: harness.port,
    client: "vitest-device",
    // Never the real `sessionStorage`: a test must not leave a control secret behind, and
    // two tests in one file must not read each other's.
    memory: { read: () => null, write: () => undefined, forget: () => undefined },
    autoConnect: options.autoConnect ?? false,
    onState: (state) => states.push(state),
    onReadings: (values, dropped) => {
      for (const [name, value] of Object.entries(values)) readings.set(name, value);
      drops.push(dropped);
    },
  });
  cleanups.push(() => {
    client.dispose();
  });
  client.connect(code);
  return { states, readings, drops, client, state: () => states[states.length - 1] as OscBridgeState };
}

/* ------------------------------------------------------------------ GATE 1 */

describe("GATE 1 — an OSC message drives a parameter, end to end", () => {
  it("arrives as UDP bytes and comes out as a driven parameter's number", async () => {
    const harness = await bridgedServer();
    const device = attachDevice(harness, harness.pairingCode);
    await until(() => device.state().kind === "attached", "the device role to attach");

    device.client.listen([9457]);
    await until(() => harness.udp.boundPorts().includes(9457), "the helper to bind the UDP port");

    // A REAL OSC packet, encoded by the product's own encoder, pushed into the socket the
    // helper bound — the same path a datagram from `tools/osc-send.mjs` takes.
    const packet = encodeOscMessage("/synth/cutoff", [0.625]);
    expect(packet).not.toBeNull();
    harness.udp.deliver(9457, packet as Uint8Array);

    await until(() => device.readings.has("osc:/synth/cutoff"), "the reading to reach the page");
    expect(device.readings.get("osc:/synth/cutoff")).toBeCloseTo(0.625, 6);

    /*
     * And now the half that makes this a GATE rather than a transport test: the reading
     * goes through the REAL value graph, the REAL `oscIn` node and the REAL parameter
     * resolver, and a driven parameter reads the number. §V461 — an exact value, and one
     * that could not have come from a rest or a default.
     */
    const registry = createNodeRegistry(allNodeDefinitions).view();
    const session = createValueGraphSession(registry);
    const graph = documentWith(
      // The node's OWN parameters are the whole interface (the owner's node-surface
      // ruling): `controls` declares the names and `parametersFor` grows the rest, so
      // `cutoffAddress` and `cutoffRest` are ORDINARY parameters, not a JSON blob.
      node("osc1", "oscIn", { port: 9457, controls: "cutoff", cutoffAddress: "/synth/cutoff", cutoffRest: 0.11 }),
    );
    const frame: FrameEvaluationInput = {
      timeSeconds: 0,
      deltaSeconds: 1 / 60,
      frameIndex: 0,
      mode: "realtime",
      randomSeed: 1,
    };
    const evaluated = session.evaluate(graph, frame, {
      pointer: { x: 0, y: 0, buttons: 0 },
      // The session's OWN resolver shape: `osc:` names, exactly as `app.tsx` merges it.
      channels: (name) => device.readings.get(name),
    });
    expect(evaluated.byId.get("osc1" as NodeId)).toEqual({ cutoff: 0.625 });

    /*
     * And through a DRIVEN PARAMETER, which is the thing a user actually wires — the
     * §V108 envelope with a retained static beside the binding, so a resolver that failed
     * to answer would fall back to 0.02 and this assertion would catch it rather than
     * reading a plausible zero.
     */
    const driven = resolveParameters(
      {
        ...node("blur1", "blur", {}),
        parameters: {
          size: {
            mode: "driven",
            bindings: {
              driven: { kind: "driven", channel: "osc1:cutoff" },
              static: { kind: "static", value: 0.02 },
            },
          },
        },
      } as unknown as GraphNode,
      registry.get("blur"),
      { frame, channels: evaluated.resolver },
    );
    expect(driven.get("size")?.value).toBeCloseTo(0.625, 6);
  });

  it("publishes a multi-argument message by index, and the bare address for argument 0", async () => {
    const harness = await bridgedServer();
    const device = attachDevice(harness, harness.pairingCode);
    await until(() => device.state().kind === "attached", "the device role to attach");
    device.client.listen([9458]);
    await until(() => harness.udp.boundPorts().includes(9458), "the helper to bind the UDP port");

    harness.udp.deliver(9458, encodeOscMessage("/pad/xy", [0.25, 0.75]) as Uint8Array);
    await until(() => device.readings.has("osc:/pad/xy/1"), "both arguments to arrive");
    // A positional argument has no name to take, so it takes an index — and argument 0
    // ALSO answers to the bare address, which is what a one-argument sender documents.
    expect(device.readings.get("osc:/pad/xy")).toBeCloseTo(0.25, 6);
    expect(device.readings.get("osc:/pad/xy/0")).toBeCloseTo(0.25, 6);
    expect(device.readings.get("osc:/pad/xy/1")).toBeCloseTo(0.75, 6);
  });

  it("coalesces a burst to the NEWEST value and says how many it dropped (§T950 gap 2)", async () => {
    const harness = await bridgedServer();
    const device = attachDevice(harness, harness.pairingCode);
    await until(() => device.state().kind === "attached", "the device role to attach");
    device.client.listen([9459]);
    await until(() => harness.udp.boundPorts().includes(9459), "the helper to bind the UDP port");

    // A fader bank's worth of traffic between two flushes. What a frame wants is the
    // POSITION, not the history — but the history being discarded must be VISIBLE, or a
    // page that fell behind watches a fader teleport with nothing saying why (§V469).
    for (let index = 0; index < 10; index += 1) {
      harness.udp.deliver(9459, encodeOscMessage("/fader", [index / 10]) as Uint8Array);
    }
    await until(() => device.readings.has("osc:/fader"), "the coalesced batch to arrive");
    expect(device.readings.get("osc:/fader")).toBeCloseTo(0.9, 6);
    // 10 readings under one name, per published channel (`/fader` and `/fader/0`), so 9
    // of each were superseded. The number is REPORTED rather than swallowed.
    expect(device.drops.reduce((sum, value) => sum + value, 0)).toBe(18);
  });
});

/* ------------------------------------------------------------------ GATE 2 */

describe("GATE 2 — oscOut sends, and the result does not overstate delivery (§T950 gap 3)", () => {
  it("reports UNCONFIRMED for a datagram the OS accepted — never delivered, never ok", async () => {
    const harness = await bridgedServer();
    const device = attachDevice(harness, harness.pairingCode);
    await until(() => device.state().kind === "attached", "the device role to attach");

    const outcome = await device.client.send(
      { host: "127.0.0.1", port: 9460 },
      [{ address: "/loom/level", args: [0.5] }],
    );
    expect(outcome.delivery).toBe("unconfirmed");
    if (outcome.delivery !== "unconfirmed") throw new Error("unreachable");
    expect(outcome.handed).toBe(1);
    expect(outcome.transport).toBe("udp");

    // The bytes really left, and they are really OSC — decoded back by hand rather than
    // trusted, so an encoder that emitted the wrong thing cannot pass this.
    expect(harness.udp.handed).toHaveLength(1);
    const sent = harness.udp.handed[0] as Handed;
    expect(sent.host).toBe("127.0.0.1");
    expect(sent.port).toBe(9460);
    expect(Buffer.from(sent.bytes).toString("ascii", 0, 11)).toBe("/loom/level");

    /*
     * §V461 the other way round: the assertion that this gate exists for is what the
     * outcome CANNOT say. The union has three members and none of them means "arrived", so
     * there is no word here for a UI to render as success. Pinned by name, because a
     * future author adding a `delivered` member would be re-introducing exactly the claim
     * UDP cannot support.
     */
    const words = new Set(
      ([
        { delivery: "refused", reason: "x" },
        { delivery: "failed", reason: "x" },
        outcome,
      ] as OscSendOutcome[]).map((entry) => entry.delivery),
    );
    expect([...words].sort()).toEqual(["failed", "refused", "unconfirmed"]);
    expect(words.has("delivered" as never)).toBe(false);
  });

  it("reports FAILED — not unconfirmed — when the local socket rejects the write", async () => {
    const harness = await bridgedServer();
    const device = attachDevice(harness, harness.pairingCode);
    await until(() => device.state().kind === "attached", "the device role to attach");

    harness.udp.failNextSendWith("EACCES: permission denied");
    const outcome = await device.client.send({ host: "10.0.0.4", port: 9461 }, [
      { address: "/loom/level", args: [0.5] },
    ]);
    // The distinction is the whole point: `failed` means the bytes never left this
    // machine, and calling that `unconfirmed` would claim strictly more than we know.
    expect(outcome.delivery).toBe("failed");
    if (outcome.delivery !== "failed") throw new Error("unreachable");
    expect(outcome.reason).toContain("EACCES");
    expect(harness.udp.handed).toHaveLength(0);
  });

  it("refuses a message it cannot encode rather than sending something else", async () => {
    const harness = await bridgedServer();
    const device = attachDevice(harness, harness.pairingCode);
    await until(() => device.state().kind === "attached", "the device role to attach");

    // NaN is what a missing upstream looks like by the time it gets here, and a receiver
    // will happily apply one to a fader.
    const outcome = await device.client.send({ host: "127.0.0.1", port: 9462 }, [
      { address: "/loom/level", args: [Number.NaN] },
    ]);
    expect(outcome.delivery).toBe("refused");
    expect(harness.udp.handed).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ GATE 3 */

describe("GATE 3 — an unreachable bridge degrades with a STATED reason (§V359, §T715)", () => {
  it("says UNREACHABLE, not silence, when no helper is listening", async () => {
    // A port nobody bound. This is the ordinary state of every machine that has not run
    // the helper, and of the hosted build, which is why it is a gate rather than an edge.
    const device = attachDevice({ port: 45_311 }, "ABCDEF");
    await until(() => device.state().kind === "unreachable", "the client to report unreachable");
    expect(device.state().kind).toBe("unreachable");
  });

  it("a document referencing an absent bridge still evaluates, at its DECLARED rests", () => {
    // §T715's constraint verbatim: the node always exists, always publishes its output
    // type, and the document renders — degraded. `rest`, not a blind zero, because a
    // control whose neutral is not zero must not open hard-left (§V353).
    const registry = createNodeRegistry(allNodeDefinitions).view();
    const session = createValueGraphSession(registry);
    const graph = documentWith(
      node("osc1", "oscIn", {
        port: 9463,
        controls: "cutoff pan",
        cutoffAddress: "/synth/cutoff",
        cutoffRest: 0.37,
        panAddress: "/synth/pan",
        panRest: -1,
      }),
    );
    // NO `channels` at all — the shape a session with no device attachment has.
    const evaluated = session.evaluate(
      graph,
      { timeSeconds: 0, deltaSeconds: 1 / 60, frameIndex: 0, mode: "realtime", randomSeed: 1 },
      { pointer: { x: 0, y: 0, buttons: 0 } },
    );
    expect(evaluated.byId.get("osc1" as NodeId)).toEqual({ cutoff: 0.37, pan: -1 });
  });

  it("says WHICH failure it is: a wrong pairing code is refused BY NAME, not by silence", async () => {
    const harness = await bridgedServer();
    const device = attachDevice(harness, "ZZZZZZ");
    await until(() => device.state().kind === "refused", "the bridge to refuse the code");
    const state = device.state();
    if (state.kind !== "refused") throw new Error("unreachable");
    // §V359: refused and unreachable are different sentences because they need different
    // actions — one is "start the helper", the other is "read the current code".
    expect(state.reason).toContain("pairing code");
  });

  it("names a helper with no device support distinctly from a wrong code", async () => {
    // The bridge exists, the code is right, and it serves no devices. Collapsing this into
    // "refused" would send the reader hunting for a code that was never the problem.
    const { createBridgeHost } = await import("../mcp/bridge-host.ts");
    const host = createBridgeHost({
      headless: { listTools: () => [], callTool: () => Promise.resolve({}) },
      port: 0,
    });
    cleanups.push(() => {
      host.dispose();
    });
    await until(() => host.status().port != null, "the deviceless bridge to bind");
    const device = attachDevice({ port: host.status().port as number }, host.pairingCode);
    await until(() => device.state().kind === "refused", "the bridge to refuse the device role");
    const state = device.state();
    if (state.kind !== "refused") throw new Error("unreachable");
    expect(state.reason).toContain("without device support");
  });

  it("reports a bind failure as a stream error carrying the operating system's words", async () => {
    const harness = await bridgedServer();
    const device = attachDevice(harness, harness.pairingCode);
    await until(() => device.state().kind === "attached", "the device role to attach");
    harness.udp.failNextBindWith("EADDRINUSE: address already in use");
    device.client.listen([9464]);
    await until(() => device.state().kind === "error", "the stream error to reach the page");
    const state = device.state();
    if (state.kind !== "error") throw new Error("unreachable");
    expect(state.reason).toContain("EADDRINUSE");
  });
});

/* ------------------------------------------------------------------ GATE 4 */

describe("GATE 4 — there is no default destination (§T950 gap 4, §T458)", () => {
  it("a fresh oscOut node ships with no host and no port", () => {
    const registry = createNodeRegistry(allNodeDefinitions).view();
    // Read through the ONE schema funnel (§T903/§V814), not off `definition.parameters`.
    const schema = effectiveParameterSchema(registry.get("oscOut"), {});
    const host = schema["host"];
    const port = schema["port"];
    expect(host?.type === "string" ? host.default : "unset").toBe("");
    expect(port?.type === "number" ? port.default : -1).toBe(0);
  });

  it("a fresh oscIn node declares no controls and names no port", () => {
    const registry = createNodeRegistry(allNodeDefinitions).view();
    const schema = effectiveParameterSchema(registry.get("oscIn"), {});
    const port = schema["port"];
    const controls = schema["controls"];
    // Port 0 is "not listening": opening a document must never open a UDP socket by itself.
    expect(port?.type === "number" ? port.default : -1).toBe(0);
    expect(controls?.type === "string" ? controls.default : "unset").toBe("");
    // And the generated half is genuinely generated — absent with nothing declared,
    // present the moment a name is. That is the node-surface mechanism, asserted.
    expect(Object.keys(schema)).not.toContain("cutoffAddress");
    expect(Object.keys(effectiveParameterSchema(registry.get("oscIn"), { controls: "cutoff" }))).toContain(
      "cutoffAddress",
    );
  });

  it("refuses to transmit with no destination, and says what to set", async () => {
    const harness = await bridgedServer();
    const device = attachDevice(harness, harness.pairingCode);
    await until(() => device.state().kind === "attached", "the device role to attach");
    const outcome = await device.client.send({ host: "", port: 0 }, [{ address: "/x", args: [1] }]);
    expect(outcome.delivery).toBe("refused");
    if (outcome.delivery !== "refused") throw new Error("unreachable");
    expect(outcome.reason).toContain("no default");
    expect(harness.udp.handed).toHaveLength(0);
  });

  it("refuses broadcast and multicast by name — Art-Net's habit, not copied", async () => {
    const harness = await bridgedServer();
    const device = attachDevice(harness, harness.pairingCode);
    await until(() => device.state().kind === "attached", "the device role to attach");
    for (const host of ["255.255.255.255", "2.255.255.255", "192.168.1.255", "239.255.0.1"]) {
      const outcome = await device.client.send({ host, port: 6454 }, [{ address: "/x", args: [1] }]);
      expect(outcome.delivery, host).toBe("refused");
    }
    expect(harness.udp.handed).toHaveLength(0);
  });

  it("vets on the HELPER's side too, so a page that skipped its own check still cannot", async () => {
    const harness = await bridgedServer();
    const device = attachDevice(harness, harness.pairingCode);
    await until(() => device.state().kind === "attached", "the device role to attach");

    /*
     * The page's own vet is a convenience — it turns "no destination" into a sentence in
     * the inspector without a round trip. The check that MATTERS is on the side that owns
     * the socket, because a page is the untrusted half. So this bypasses the client's
     * `send` and speaks the wire directly, exactly as a modified page could.
     */
    const raw = new WebSocket(`ws://127.0.0.1:${String(harness.port)}`);
    const outcomes: OscSendOutcome[] = [];
    raw.onmessage = (event: MessageEvent) => {
      const message = JSON.parse(String(event.data)) as Record<string, unknown>;
      if (message["type"] === "deviceAttached") {
        raw.send(
          JSON.stringify({
            type: "deviceSend",
            id: 1,
            to: { host: "255.255.255.255", port: 6454 },
            packets: [{ address: "/x", args: [1] }],
          }),
        );
      }
      if (message["type"] === "deviceSendResult") outcomes.push(message["outcome"] as OscSendOutcome);
    };
    raw.onopen = () => {
      raw.send(JSON.stringify({ type: "deviceAttach", code: harness.pairingCode, client: "raw" }));
    };
    cleanups.push(() => {
      raw.close();
    });
    // The device slot is held by `device`, so this raw socket is refused for THAT reason —
    // which is itself the §T458(b) answer — and the vet is asserted on a fresh bridge below.
    device.client.disconnect();
    await until(() => outcomes.length > 0, "the helper to answer the raw send", 8_000);
    expect(outcomes[0]?.delivery).toBe("refused");
    expect(harness.udp.handed).toHaveLength(0);
  });
});

/* ---------------------------------------------------------------- SECURITY */

describe("§T458's three findings, mapped onto the device role", () => {
  it("(a) the helper binds loopback and takes no host — asserted where bind is called", async () => {
    // The fake socket asserts `127.0.0.1` inside `bind`, so this test passing at all IS
    // the assertion. What it adds is the structural half: no message on the wire and no
    // parameter anywhere carries a bind address, so there is nothing to set to 0.0.0.0.
    const harness = await bridgedServer();
    const device = attachDevice(harness, harness.pairingCode);
    await until(() => device.state().kind === "attached", "the device role to attach");
    device.client.listen([9465]);
    await until(() => harness.udp.boundPorts().includes(9465), "the helper to bind the UDP port");
    expect(harness.udp.boundPorts()).toEqual([9465]);
  });

  it("(b) ONE device client at a time, refused by name — no cross-client reach", async () => {
    const harness = await bridgedServer();
    const first = attachDevice(harness, harness.pairingCode);
    await until(() => first.state().kind === "attached", "the first device to attach");
    const second = attachDevice(harness, harness.pairingCode);
    await until(() => second.state().kind === "refused", "the second device to be refused");
    const state = second.state();
    if (state.kind !== "refused") throw new Error("unreachable");
    expect(state.reason).toContain("already using this bridge");
    // And the first is untouched — a refusal must not detach the holder.
    expect(first.state().kind).toBe("attached");
  });

  it("(c) a wrong code closes the socket, so there is no guessing loop", async () => {
    const harness = await bridgedServer();
    const device = attachDevice(harness, "ZZZZZZ");
    await until(() => device.state().kind === "refused", "the bridge to refuse");
    // The page slot is still free, which is the other half of (b): a refused DEVICE never
    // consumed anything, so a legitimate attach still works immediately afterwards.
    const second = attachDevice(harness, harness.pairingCode);
    await until(() => second.state().kind === "attached", "a good code to attach afterwards");
  });

  it("the device role never occupies the page slot, and never sees a tool", async () => {
    const harness = await bridgedServer();
    const device = attachDevice(harness, harness.pairingCode);
    await until(() => device.state().kind === "attached", "the device role to attach");
    // §V338: the status REPORTS both, separately, so "why is my OSC quiet" and "why is my
    // agent editing a headless copy" are answerable independently.
    const status = harness.server.bridgeStatus();
    expect(status?.deviceAttached).toBe(true);
    expect(status?.attached).toBe(false);
    expect(status?.deviceClient).toBe("vitest-device");
  });
});

/* --------------------------------------------------------------- helpers */

function node(id: string, type: string, parameters: Record<string, unknown>): GraphNode {
  return {
    id: id as NodeId,
    type,
    definitionVersion: 1,
    position: { x: 0, y: 0 },
    parameters,
    label: id,
  } as unknown as GraphNode;
}

function documentWith(...nodes: GraphNode[]): GraphDocument {
  return {
    revision: 1,
    nodes: Object.fromEntries(nodes.map((entry) => [entry.id, entry])),
    edges: {},
    groups: {},
  } as unknown as GraphDocument;
}
