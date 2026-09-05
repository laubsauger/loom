import { afterEach, describe, expect, it } from "vitest";

import { createDeviceHub, nodeUdpSocketFactory, type DeviceSession } from "@devices/device-hub.ts";
import { messagesFor } from "@/app/use-osc-bridge.ts";
import { createValueGraphSession } from "@domain/channels/value-graph.ts";
import { createParameterReadOptions, resolveParameters } from "@domain/parameters/index.ts";
import type { FrameEvaluationInput } from "@domain/types/frame.ts";
import type { NodeId } from "@domain/types/ids.ts";
import { allNodeDefinitions } from "@nodes/definitions/index.ts";
import { createNodeRegistry } from "@nodes/registry/registry.ts";
import { EXAMPLE_DOCUMENTS } from "./documents.ts";

/**
 * ⚑ T1193 — E64 RELAY'S CIRCUIT ACTUALLY CLOSES, THROUGH A REAL UDP SOCKET.
 *
 * ## Why this file exists, and what was already covered without it
 *
 * The OSC path had good gates and no gate on the JOIN. `device-bridge.test.ts` GATE 1 takes
 * bytes the product's own encoder produced, pushes them at a bound port, and follows the
 * reading through the real value graph into a driven parameter; GATE 2 puts `oscOut`'s
 * outcome under the "sent, arrival unconfirmed" contract; `use-osc-bridge.test.tsx` proves
 * the pump sends a live document's bag and refuses to send an unconfigured one. Every one
 * of them exercises ONE END.
 *
 * E64 is the first document whose claim is that the two ends are the same circuit — its
 * `oscOut` transmits to the port its `oscIn` listens on — and "both halves work" does not
 * imply "the loop closes". The address the sender writes and the address the receiver
 * learns are two strings in two nodes, the single-channel bag takes the BARE address rather
 * than `/loom/relay/value`, and a receiver's `levelAddress` that disagreed with either would
 * publish its Rest for ever while every existing gate stayed green. That is the shape §V910
 * is about: a gate wearing a name it does not measure. So this measures it.
 *
 * ## What it does, exactly
 *
 * The document is the SHIPPED one, read from `EXAMPLE_DOCUMENTS` — its own host, its own
 * port, its own address, its own Rest, none of them restated here. The helper half is the
 * real `createDeviceHub` over `nodeUdpSocketFactory`, so the datagram is a real datagram on
 * the real loopback interface: the egress socket hands it to the OS and the ingress socket
 * bound to `BRIDGE_HOST` receives it. `messagesFor` is the app's own egress formatter and
 * the value graph is the app's own evaluator.
 *
 * ## What it deliberately does NOT claim
 *
 * **No latency number.** The round trip measured about two frames of a 60 Hz loop on a
 * quiet machine, and that number is a property of the machine, of the hub's 16 ms
 * coalescing flush and of whatever else is running — a gate asserting it would be a clock
 * test wearing a correctness test's name (§V147). The `.md` records the measurement and
 * says where it came from.
 *
 * **Not the page↔helper hop.** The loopback WebSocket between a browser tab and the helper
 * is not in this path; `device-bridge.test.ts` owns it, from the other side. What is here
 * is the half that file stubs — the UDP itself — and the join it has no document for.
 *
 * **Not the picture.** Whether the returned number makes a good frame is the look
 * baseline's question and Dawn's. This asserts the number arrives and the parameter moves.
 */

const REGISTRY = createNodeRegistry(allNodeDefinitions).view();

/** The shipped document, not a fixture: the point is that ITS numbers agree with each other. */
const RELAY = EXAMPLE_DOCUMENTS.find((document) => document.projectId === "example-e64-relay");
if (RELAY === undefined) throw new Error("E64 Relay is not in EXAMPLE_DOCUMENTS");

/** The node ids the document uses. Read from the graph so a rename fails here, loudly. */
const SEND = "send" as NodeId;
const HEAR = "hear" as NodeId;
const DIM = "dim" as NodeId;

function parameterOf(nodeId: NodeId, key: string): unknown {
  return RELAY?.graph.nodes[nodeId]?.parameters[key];
}

const closers: Array<() => void> = [];
afterEach(() => {
  while (closers.length > 0) closers.pop()?.();
});

interface Circuit {
  readonly session: DeviceSession;
  readonly readings: Map<string, number>;
}

function openCircuit(port: number): Circuit {
  const readings = new Map<string, number>();
  const hub = createDeviceHub({ socketFactory: nodeUdpSocketFactory(), flushMs: 16 });
  const session = hub.open({
    onEvents: (_stream, _at, _seq, _dropped, values) => {
      for (const [name, value] of Object.entries(values)) readings.set(name, value);
    },
    onState: () => undefined,
  });
  closers.push(() => {
    session.close();
    hub.dispose();
  });
  const subscribed = session.subscribe({ kind: "osc", port });
  // Loud rather than skipped: a port this machine cannot bind is a failure to report, and a
  // `return` here would turn the only gate on the join into a green tick (§V910).
  if ("reason" in subscribed) throw new Error(`could not listen on ${String(port)}: ${subscribed.reason}`);
  return { session, readings };
}

/**
 * Run the document's value graph for one frame, transmit what `oscOut` published, and hand
 * back both ends of the circuit as the graph itself reads them.
 *
 * `meter1` is fed synthetically. The GPU reduction is not the subject here and feeding it
 * by hand is what makes the assertion exact: the number that goes round is one this test
 * chose, so a value that came back could not have come from anywhere else.
 */
function step(
  circuit: Circuit,
  graphSession: ReturnType<typeof createValueGraphSession>,
  frameIndex: number,
  meter: number,
): { readonly sent: number; readonly received: number; readonly brightness: number } {
  const frame: FrameEvaluationInput = {
    timeSeconds: frameIndex / 60,
    deltaSeconds: 1 / 60,
    frameIndex,
    mode: "realtime",
    randomSeed: RELAY?.settings.randomSeed ?? 0,
  };
  const evaluated = graphSession.evaluate(RELAY?.graph as never, frame, {
    pointer: { x: 0.5, y: 0.5, buttons: 0 },
    channels: (name: string) => (name === "meter1" ? meter : circuit.readings.get(name)),
  });
  const outBag = evaluated.byId.get(SEND) ?? {};
  const inBag = evaluated.byId.get(HEAR) ?? {};

  const address = parameterOf(SEND, "address");
  const host = parameterOf(SEND, "host");
  const port = parameterOf(SEND, "port");
  const packets = messagesFor(String(address), outBag as Record<string, number>);
  if (packets.length > 0) {
    void circuit.session.send({ host: String(host), port: Number(port) }, packets);
  }

  const dim = RELAY?.graph.nodes[DIM];
  /* §T1129's shared factory, and it is required rather than tidy: `dim1.brightness` is an
     EXPRESSION slot reading `op('ctl1').chan.level`, and the `op()` reader is built here —
     hand `resolveParameters` a bare `channels` and the expression resolves to "this context
     has no channel resolver", falls to §V108's retained static, and this gate would read a
     plausible 1.08 while measuring nothing. It did, once. */
  const brightness = resolveParameters(
    dim as never,
    REGISTRY.get("level"),
    createParameterReadOptions({
      graph: RELAY?.graph as never,
      registry: REGISTRY,
      frame,
      channels: evaluated.resolver,
    }),
  ).get("brightness")?.value;

  return {
    sent: outBag["value"] as number,
    received: inBag["level"] as number,
    brightness: brightness as number,
  };
}

/** Drives frames at the display's cadence until `done`, or fails naming what never happened. */
async function untilFrame(
  run: (frameIndex: number) => boolean,
  what: string,
  budgetFrames = 240,
): Promise<number> {
  for (let frameIndex = 0; frameIndex < budgetFrames; frameIndex += 1) {
    if (run(frameIndex)) return frameIndex;
    await new Promise((resolve) => setTimeout(resolve, 1000 / 60));
  }
  throw new Error(`${what} never happened in ${String(budgetFrames)} frames`);
}

describe("T1193 — E64 Relay: oscOut reaches its own oscIn over real UDP", () => {
  const listenPort = Number(parameterOf(HEAR, "port"));
  const rest = Number(parameterOf(HEAR, "levelRest"));

  it("names one port and one address on both halves, so the circuit is a circuit", () => {
    // The join, as a statement about the DOCUMENT rather than about the transport. It is
    // the cheap half of the claim and it is the half a rename breaks.
    expect(parameterOf(SEND, "port")).toBe(listenPort);
    expect(parameterOf(SEND, "address")).toBe(parameterOf(HEAR, "levelAddress"));
    expect(parameterOf(SEND, "host")).toBe("127.0.0.1");
    expect(parameterOf(HEAR, "controls")).toBe("level");
  });

  it("publishes its declared Rest before anything arrives — the no-helper picture", () => {
    const graphSession = createValueGraphSession(REGISTRY);
    const evaluated = graphSession.evaluate(
      RELAY?.graph as never,
      { timeSeconds: 0, deltaSeconds: 1 / 60, frameIndex: 0, mode: "realtime", randomSeed: 64 },
      { pointer: { x: 0.5, y: 0.5, buttons: 0 }, channels: () => undefined },
    );
    // No resolver at all is the strongest form of "no helper": the node still publishes.
    expect(evaluated.byId.get(HEAR)).toEqual({ level: rest });
  });

  it("carries a number the graph derived all the way round, and moves the picture with it", async () => {
    const circuit = openCircuit(listenPort);
    const graphSession = createValueGraphSession(REGISTRY);

    /* Well inside the reading's working span, so `wire1` neither clamps nor extrapolates and
       the number on the wire is one this test can name: (0.30 − 0.075) / (0.42 − 0.075). */
    const METER = 0.3;
    let last = { sent: Number.NaN, received: Number.NaN, brightness: Number.NaN };

    const settledAt = await untilFrame(
      (frameIndex) => {
        last = step(circuit, graphSession, frameIndex, METER);
        return last.received !== rest;
      },
      "a value to come back through the loopback socket",
    );

    // It came back, and it came back as itself. OSC 1.0 carries a 32-bit float, so the
    // number that returns is the f32 rounding of the number that left — stated as the
    // assertion rather than hidden inside a tolerance (§V147).
    expect(last.received).toBe(Math.fround(last.sent));
    // And it is NOT the rest, which is the whole point: an assertion that passed on the
    // degraded path would gate nothing at all.
    expect(last.received).not.toBe(rest);
    expect(settledAt).toBeGreaterThan(0);

    /*
     * The picture moves. `ctl1` maps the returned 0…1 onto a brightness with its bounds
     * INVERTED — that inversion is what makes the loop negative — so the value read off
     * `dim1.brightness` is checked against that arithmetic, and against the brightness the
     * same document renders with no helper at all. Two assertions, because "it changed" and
     * "it changed to the right thing" are different claims.
     */
    const expected = 1.24 + last.received * (0.86 - 1.24);
    expect(last.brightness).toBeCloseTo(expected, 6);
    expect(last.brightness).not.toBeCloseTo(1.24 + rest * (0.86 - 1.24), 6);
  }, 20_000);
});
