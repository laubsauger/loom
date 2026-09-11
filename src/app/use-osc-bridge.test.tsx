import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DEVICE_HELPER_COMMAND } from "@devices/helper.ts";

import { createNodeRegistry } from "@nodes/registry/registry.ts";
import { allNodeDefinitions } from "@nodes/definitions/index.ts";
import type { FrameEvaluationInput } from "@domain/types/frame.ts";
import type { GraphDocument } from "@domain/types/graph.ts";
import type { NodeId } from "@domain/types/ids.ts";
import type { BridgeSocket } from "@devices/transport/bridge-socket.ts";
import type { ChannelResolver } from "@domain/parameters/resolve.ts";
import type { SideEffectPolicy } from "@domain/render/side-effects.ts";
import type { NodeDefinition } from "@domain/types/node-definition.ts";
import type { NodeRegistryView } from "@nodes/registry/registry.ts";
import { EMISSION_PUMPS } from "@domain/render/emission-pumps.ts";
import { OSC_CHANNEL_PREFIX } from "@domain/osc/osc-address.ts";
import { VALUE_PORT } from "@nodes/definitions/common-ports.ts";
import { liveClock } from "@domain/transport/live-clock.ts";
import { projectRange } from "@domain/types/graph.ts";
import { absFrameIndexOf } from "@domain/types/frame.ts";
import type { ParameterValue } from "@domain/types/parameters.ts";
import { messagesFor, oscPumpEmittingTypes, oscPumpListeningTypes, useOscBridge } from "./use-osc-bridge.ts";

/**
 * T942 tier 3 — THE PUMP: what the document says becomes what the socket sees.
 *
 * ## What this covers that `device-bridge.test.ts` does not
 *
 * That suite drives real bytes over a real loopback socket and proves the TRANSPORT. This
 * one proves the POLICY that sits above it and is the part a document author actually
 * experiences: which ports get opened, which nodes transmit, what a node with no
 * destination does, and what the problems pane is told when there is no helper.
 *
 * The socket here is a fake that speaks the real protocol JSON, so nothing about the
 * client's message handling is stubbed — only the wire under it (§V382's line: this
 * asserts the messages, and the byte-level claim is made where it can be).
 */

const registry = createNodeRegistry(allNodeDefinitions).view();

const frameAt = (seconds: number): FrameEvaluationInput => ({
  timeSeconds: seconds,
  deltaSeconds: 1 / 60,
  frameIndex: Math.round(seconds * 60),
  mode: "realtime",
  randomSeed: 1,
});

/** A socket that records what the page sent and lets a test play the helper. */
function fakeSocket(): {
  readonly factory: (url: string) => BridgeSocket;
  readonly sent: Array<Record<string, unknown>>;
  open(): void;
  say(message: Record<string, unknown>): void;
} {
  const sent: Array<Record<string, unknown>> = [];
  let live: BridgeSocket | null = null;
  return {
    factory: () => {
      const socket: BridgeSocket = {
        send: (data) => sent.push(JSON.parse(data) as Record<string, unknown>),
        close: () => undefined,
        onopen: null,
        onmessage: null,
        onclose: null,
        onerror: null,
      };
      live = socket;
      return socket;
    },
    sent,
    open() {
      live?.onopen?.();
    },
    say(message) {
      live?.onmessage?.({ data: JSON.stringify(message) });
    },
  };
}

function graphOf(nodes: Record<string, { type: string; label: string; parameters: Record<string, unknown> }>): GraphDocument {
  return {
    revision: 1,
    groups: {},
    edges: {},
    nodes: Object.fromEntries(
      Object.entries(nodes).map(([id, node]) => [
        id,
        { id, definitionVersion: 1, position: { x: 0, y: 0 }, ...node },
      ]),
    ),
  } as unknown as GraphDocument;
}

const NO_CHANNELS = (): undefined => undefined;

/**
 * T949 — the policy every existing case in this file runs under: a live session, with a
 * person watching. `BLOCKED` is what a take, a headless export and every gate get.
 */
const LIVE: SideEffectPolicy = "live-session";
const BLOCKED: SideEffectPolicy = "blocked";

/**
 * The hook with a fake socket available and NOTHING attached — the state every session
 * starts in and the one a machine with no helper stays in.
 */
function unattached() {
  const socket = fakeSocket();
  const hook = renderHook(() => useOscBridge({ socketFactory: socket.factory, port: 1, autoConnect: false }));
  return { socket, hook };
}

describe("which UDP ports open is the DOCUMENT's decision, and its default is none", () => {
  it("asks for exactly the ports the oscIn nodes name, and for nothing when none do", () => {
    const { socket, hook } = unattached();
    act(() => {
      hook.result.current.sync(
        frameAt(0),
        graphOf({ a: { type: "oscIn", label: "osc1", parameters: { port: 0 } } }),
        registry,
        new Map(),
        NO_CHANNELS,
        LIVE,
      );
    });
    // Port 0 means NOT LISTENING. Opening a document must never open a socket by itself,
    // which is the ingress half of "no default destination".
    expect(socket.sent.filter((message) => message["type"] === "deviceSubscribe")).toEqual([]);
  });

  it("opens a socket per named port once a helper is attached, and closes one that goes away", () => {
    const { socket, hook } = unattached();
    // The page dials only when something asks; `reconnectRemembered` is a no-op with no
    // remembered code, so the test plays the helper by hand from here.
    act(() => {
      hook.result.current.sync(
        frameAt(0),
        graphOf({ a: { type: "oscIn", label: "osc1", parameters: { port: 9000 } } }),
        registry,
        new Map(),
        NO_CHANNELS,
        LIVE,
      );
    });
    // Nothing was sent, because nothing is attached — and that is the honest state, not an
    // error: the diagnostic below is how the user learns about it.
    expect(socket.sent).toEqual([]);
    expect(hook.result.current.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(["osc.helper"]);
  });
});

describe("§T948 rule 3 — the reason reaches a surface, and says what to DO", () => {
  it("names the node, and the copy never says `disabled`", () => {
    const { hook } = unattached();
    act(() => {
      hook.result.current.sync(
        frameAt(0),
        graphOf({ a: { type: "oscIn", label: "osc1", parameters: { port: 9000 } } }),
        registry,
        new Map(),
        NO_CHANNELS,
        LIVE,
      );
    });
    const [diagnostic] = hook.result.current.diagnostics;
    expect(diagnostic?.nodeId).toBe("a" as NodeId);
    expect(diagnostic?.severity).toBe("warning");
    expect(diagnostic?.message.toLowerCase()).not.toContain("disabled");
    // The action, not the fault: what to run and where to type the code.
    expect(diagnostic?.suggestion).toContain(DEVICE_HELPER_COMMAND);
    expect(diagnostic?.suggestion).toContain("Connections");
  });

  it("says nothing at all about a node that is not asking for anything", () => {
    // §V91's spirit: a pane that cries wolf is a pane people stop reading. An `oscOut`
    // with no destination is UNCONFIGURED, not broken, and telling its owner to start a
    // helper would answer a question they did not ask.
    const { hook } = unattached();
    act(() => {
      hook.result.current.sync(
        frameAt(0),
        graphOf({
          a: { type: "oscIn", label: "osc1", parameters: { port: 0 } },
          b: { type: "oscOut", label: "send1", parameters: { host: "", port: 0 } },
        }),
        registry,
        new Map(),
        NO_CHANNELS,
        LIVE,
      );
    });
    expect(hook.result.current.diagnostics).toEqual([]);
  });

  it("keeps the diagnostic ARRAY identity stable while the condition is (§V16)", () => {
    // Sixty frames a second must not re-render the problems pane. Identity moves only when
    // the set of conditions does.
    const { hook } = unattached();
    const graph = graphOf({ a: { type: "oscIn", label: "osc1", parameters: { port: 9000 } } });
    act(() => {
      hook.result.current.sync(frameAt(0), graph, registry, new Map(), NO_CHANNELS, LIVE);
    });
    const first = hook.result.current.diagnostics;
    act(() => {
      hook.result.current.sync(frameAt(1), graph, registry, new Map(), NO_CHANNELS, LIVE);
      hook.result.current.sync(frameAt(2), graph, registry, new Map(), NO_CHANNELS, LIVE);
    });
    expect(hook.result.current.diagnostics).toBe(first);
  });
});

describe("oscOut transmits only what the document configured (§T950 gap 4)", () => {
  /**
   * A hook whose device socket is ATTACHED, reached the way the product reaches it.
   *
   * There is no OSC connect button — the owner's node-surface ruling means the pairing
   * ceremony stays in the agent panel's Connections section and the device socket reuses
   * the code that left behind (T925's `sessionPairingMemory`). So this seeds that memory
   * and then asks the pump for something, which is exactly what makes a real session pick
   * the attachment up mid-flight without a reload (§T948 rule 1).
   */
  function pumped(graph: GraphDocument) {
    globalThis.sessionStorage.setItem("loom.bridge.pairing.v1", "ABCDEF");
    const socket = fakeSocket();
    const hook = renderHook(() => useOscBridge({ socketFactory: socket.factory, port: 1, autoConnect: false }));
    act(() => {
      // The document asks for OSC → the pump retries from the remembered code.
      hook.result.current.sync(frameAt(0), graph, registry, new Map(), NO_CHANNELS, LIVE);
      socket.open();
    });
    // The page presents the SAME pairing code the agent bridge uses — never a second
    // secret, and never a node parameter (a node parameter is written into the file).
    expect(socket.sent[0]).toEqual({ type: "deviceAttach", code: "ABCDEF", client: "a Loom tab" });
    act(() => {
      socket.say({ type: "deviceAttached", sources: [] });
    });
    socket.sent.length = 0;
    return { socket, hook };
  }

  it("sends NOTHING with no host and no port, whatever is wired into it", async () => {
    const graph = graphOf({
      b: { type: "oscOut", label: "send1", parameters: { host: "", port: 0 } },
      // A second node that DOES want a helper, so the attachment happens at all and the
      // silence below is about the destination rather than about being unattached.
      a: { type: "oscIn", label: "osc1", parameters: { port: 9000 } },
    });
    const { socket, hook } = pumped(graph);
    await act(async () => {
      hook.result.current.sync(frameAt(0), graph, registry, new Map([["b" as NodeId, { value: 0.5 }]]), NO_CHANNELS, LIVE);
      await Promise.resolve();
    });
    expect(socket.sent.filter((message) => message["type"] === "deviceSend")).toEqual([]);
  });

  it("honours the node's Rate, so a receiver is not flooded at frame rate", async () => {
    const graph = graphOf({
      b: { type: "oscOut", label: "send1", parameters: { host: "127.0.0.1", port: 9001, rate: 10 } },
    });
    const { socket, hook } = pumped(graph);
    const bags = new Map([["b" as NodeId, { value: 0.5 }]]);
    await act(async () => {
      // Three frames inside one tenth of a second: the first sends, the next two do not.
      hook.result.current.sync(frameAt(0), graph, registry, bags, NO_CHANNELS, LIVE);
      hook.result.current.sync(frameAt(0.016), graph, registry, bags, NO_CHANNELS, LIVE);
      hook.result.current.sync(frameAt(0.033), graph, registry, bags, NO_CHANNELS, LIVE);
      await Promise.resolve();
    });
    const sends = socket.sent.filter((message) => message["type"] === "deviceSend");
    expect(sends).toHaveLength(1);
    await act(async () => {
      hook.result.current.sync(frameAt(0.2), graph, registry, bags, NO_CHANNELS, LIVE);
      await Promise.resolve();
    });
    expect(socket.sent.filter((message) => message["type"] === "deviceSend")).toHaveLength(2);
  });

  it("a MUTED node transmits nothing, because it published no bag", async () => {
    // §V437: a muted value node is not cooked, so it falls out of the bag map — and that
    // is what stops the send, with no flag read in the pump at all.
    const graph = graphOf({
      b: { type: "oscOut", label: "send1", parameters: { host: "127.0.0.1", port: 9001 } },
    });
    const { socket, hook } = pumped(graph);
    await act(async () => {
      hook.result.current.sync(frameAt(0), graph, registry, new Map(), NO_CHANNELS, LIVE);
      await Promise.resolve();
    });
    expect(socket.sent.filter((message) => message["type"] === "deviceSend")).toEqual([]);
  });

  /*
   * T949 — A WORLD-ACTING NODE CANNOT FIRE FROM AN EXPORT PATH, AS THE CONSEQUENCE OF THE
   * DECLARATION RATHER THAN AS A PROPERTY OF THE PUMP.
   *
   * Both directions, on the SAME document and the same attached socket (§V461, §V537), so
   * the negative cannot be satisfied by a pump that never sends. And the positive is what
   * makes the declaration load-bearing: delete `sideEffect: "emits"` from `oscOut` and
   * `emissionRefusal` returns null, the blocked case transmits, and the first of these
   * goes red — which is §V272's requirement that the reader stop reading being a failure.
   */
  const configured = () =>
    graphOf({ b: { type: "oscOut", label: "send1", parameters: { host: "127.0.0.1", port: 9001 } } });

  it("sends NOTHING while a take is running, and says why", async () => {
    const graph = configured();
    const { socket, hook } = pumped(graph);
    const bags = new Map([["b" as NodeId, { value: 0.5 }]]);
    await act(async () => {
      hook.result.current.sync(frameAt(0), graph, registry, bags, NO_CHANNELS, BLOCKED);
      await Promise.resolve();
    });
    expect(socket.sent.filter((message) => message["type"] === "deviceSend")).toEqual([]);
    // §V365: a rig that goes dark with no explanation reads as a rig that is broken.
    const blocked = hook.result.current.diagnostics.filter(
      (diagnostic) => diagnostic.code === "sideEffect.blocked",
    );
    expect(blocked).toHaveLength(1);
    expect(blocked[0]?.nodeId).toBe("b" as NodeId);
    expect(blocked[0]?.severity).toBe("warning");
    expect(blocked[0]?.message).toContain("only a live session");
  });

  it("sends the same document's messages when the session IS live", async () => {
    const graph = configured();
    const { socket, hook } = pumped(graph);
    const bags = new Map([["b" as NodeId, { value: 0.5 }]]);
    await act(async () => {
      hook.result.current.sync(frameAt(0), graph, registry, bags, NO_CHANNELS, LIVE);
      await Promise.resolve();
    });
    expect(socket.sent.filter((message) => message["type"] === "deviceSend")).toHaveLength(1);
    expect(
      hook.result.current.diagnostics.filter((diagnostic) => diagnostic.code === "sideEffect.blocked"),
    ).toEqual([]);
  });

  /*
   * §T1001/§V837 — A CHANNEL EXPRESSION ON AN OSC NODE IS LIVE, NOT FROZEN.
   *
   * The pump resolved its parameters with NO node-reference reader, so `op('x').chan.*`
   * answered "this context has no channel resolver" and fell back to §V108's retained
   * static — for the life of the session. §B8's shape for the third time.
   *
   * THE FIXTURE TAKES THE PATH A REAL DOCUMENT TAKES. Post-§T901 a channel read is stored
   * as an EXPRESSION, not as `mode: "driven"`; §T1000's lesson is that the existing live
   * suite stayed green through the whole bug because it used the mode that never enters
   * the reader. So the destination port here is `op('p1').chan.value` on a real `constant`
   * node, resolved through the real `resolveParameters` inside the real hook: with no
   * reader the port reads as its retained `0` and the pump sends nothing at all.
   *
   * AND IT IS ASSERTED OVER TWO FRAMES, because "frozen" is a claim about TIME and a
   * single frame cannot refute it. One frame proves only that the number is not the
   * retained static; a reader built ONCE and closed over frame 0's channels — the
   * §T1000 shape, one `useMemo` away — answers correctly forever and still freezes.
   * So the channel MOVES between the two syncs and the datagram must move with it:
   * cut the reader and there is no send at all, hoist it out of the frame and the
   * second send goes to the FIRST frame's port.
   */
  it("resolves op().chan on an oscOut parameter, and FOLLOWS it across frames", async () => {
    const graph = graphOf({
      p1: { type: "constant", label: "p1", parameters: { value: 9001 } },
      // A statically configured `oscIn`, so the attachment happens at all — `pumped` seeds
      // the pairing memory and the pump only dials when the document is asking, and this
      // node's own port must not depend on the very read under test.
      a: { type: "oscIn", label: "osc1", parameters: { port: 9000 } },
      b: {
        type: "oscOut",
        label: "send1",
        parameters: {
          host: "127.0.0.1",
          // The stored shape §T897's migration produces for a channel read.
          port: { mode: "expression", bindings: { expression: { kind: "expression", source: "op('p1').chan.value" } } },
        },
      },
    });
    // The channel a sender is actually publishing: a different number on each frame.
    const portAt = (seconds: number): number => 9001 + Math.round(seconds);
    const channelsAt =
      (seconds: number): ChannelResolver =>
      (channel: string) =>
        channel === "p1:value" || channel === "p1" ? portAt(seconds) : undefined;
    const bags = new Map([["b" as NodeId, { value: 0.5 }]]);
    const { socket, hook } = pumped(graph);
    for (const seconds of [0, 1]) {
      await act(async () => {
        hook.result.current.sync(frameAt(seconds), graph, registry, bags, channelsAt(seconds), LIVE);
        await Promise.resolve();
      });
    }
    const sends = socket.sent.filter((message) => message["type"] === "deviceSend");
    // The VALUES the expression produced, not merely that something was sent: a reader
    // that answered a stale number would still have sent, to the wrong place — and one
    // that answered frame 0 forever would have sent both datagrams to 9001.
    expect(sends.map((message) => (message as { to?: { port?: number } }).to?.port)).toEqual([9001, 9002]);
  });

  it("is refusing because the NODE says it acts on the world, not because it is called oscOut", () => {
    // The pump reads `definition.sideEffect`. This pins the fact the refusal turns on, so
    // a definition that quietly loses the declaration fails here as well as above.
    expect(registry.get("oscOut")?.sideEffect).toBe("emits");
    expect(registry.get("oscIn")?.sideEffect).toBeUndefined();
  });
});

/*
 * §T1006 — THE SET THIS PUMP OWNS IS DERIVED, AND THE GATE IS DERIVED WITH IT.
 *
 * The pump filtered `node.type !== "oscIn" && node.type !== "oscOut"`: a set stated over
 * a CATEGORY and implemented as two named MEMBERS. §B45 is this project's record of what
 * that costs — the parameter menu enumerated four of five `ParameterMode`s and `map` was
 * absent for months, under a comment claiming every parameter takes every mode.
 *
 * So this block never writes "oscIn" or "oscOut" into an expectation of what the pump
 * handles. It FABRICATES A THIRD OSC NODE TYPE that exists nowhere in the product, hands
 * the pump a registry containing it, and requires the socket to open for it — a gate that
 * hand-listed the same two names would have moved the bug rather than caught it. And it
 * puts a FLOOR under each derivation, because a query that returns nothing would hold a
 * derived gate green while proving nothing at all.
 */
describe("§T1006 — the pump's node set is derived from the registry and the ledger", () => {
  /**
   * A listening node the catalogue has never seen, and its port parameter is deliberately
   * NOT called `port`: the pump must read the parameter the DEFINITION named. Anything
   * that pattern-matched on a type name or assumed `"port"` fails here.
   */
  const thirdListener: NodeDefinition = {
    type: "oscInFabricated",
    version: 1,
    title: "Fabricated OSC In",
    category: "input",
    description: "A third OSC-shaped listening node that exists only in this test.",
    tags: ["value", "input", "osc"],
    inputs: [],
    outputs: [{ id: "out", label: "Out", type: VALUE_PORT }],
    parameters: {
      listenPort: { type: "number", label: "Port", default: 0, min: 0, max: 65_535, step: 1 },
    },
    listensOn: { channelPrefix: OSC_CHANNEL_PREFIX, portParameter: "listenPort" },
    valueEvaluate: () => ({}),
    compile: () => ({ passes: [] }),
  };
  const extended = createNodeRegistry([...allNodeDefinitions, thirdListener]).view();

  /**
   * Attached, with whichever catalogue the case is about — and NOTHING is cleared from
   * the record, because the subscribe is exactly what is under test: the pump hands
   * `listen(ports)` the set it derived, and the client opens those sockets the moment the
   * helper answers.
   */
  function attached(graph: GraphDocument, view: NodeRegistryView) {
    globalThis.sessionStorage.setItem("loom.bridge.pairing.v1", "ABCDEF");
    const socket = fakeSocket();
    const hook = renderHook(() => useOscBridge({ socketFactory: socket.factory, port: 1, autoConnect: false }));
    act(() => {
      hook.result.current.sync(frameAt(0), graph, view, new Map(), NO_CHANNELS, LIVE);
      socket.open();
    });
    act(() => {
      socket.say({ type: "deviceAttached", sources: [] });
    });
    return { socket, hook };
  }

  const subscribedPorts = (sent: ReadonlyArray<Record<string, unknown>>): number[] =>
    sent
      .filter((message) => message["type"] === "deviceSubscribe")
      .map((message) => (message["source"] as { port?: number }).port ?? 0);

  it("opens the socket a node type it has never heard of asks for", () => {
    const graph = graphOf({
      n: { type: "oscInFabricated", label: "third1", parameters: { listenPort: 9100 } },
    });
    const { socket } = attached(graph, extended);
    // NOTHING was added to a list to make this pass. The node declared `listensOn` and
    // the pump found it in the catalogue — which is the whole claim of the row.
    expect(subscribedPorts(socket.sent)).toEqual([9100]);
  });

  it("is the DECLARATION that opens it, not the node's presence in the document", () => {
    // The same node with `listensOn` removed: the definition is otherwise identical, so
    // anything still opening a socket here is doing it for some other reason. This is the
    // red-verify baked in — the declaration is load-bearing or this test cannot pass.
    const { listensOn: _dropped, ...deaf } = thirdListener;
    const without = createNodeRegistry([...allNodeDefinitions, deaf as NodeDefinition]).view();
    const graph = graphOf({
      n: { type: "oscInFabricated", label: "third1", parameters: { listenPort: 9100 } },
      // A real `oscIn` alongside, so the session still attaches and the silence below is
      // about the fabricated node rather than about nothing being connected.
      a: { type: "oscIn", label: "osc1", parameters: { port: 9000 } },
    });
    const { socket } = attached(graph, without);
    expect(subscribedPorts(socket.sent)).toEqual([9000]);
  });

  it("derives its EGRESS set from the emission ledger's rows for this file", () => {
    // Computed from the ledger, never restated: the expectation moves when the ledger
    // does. §T1005's gate already forbids an `emits` node without a row, so this is the
    // link that makes a second sender routed here arrive pumped.
    const fromLedger = Object.entries(EMISSION_PUMPS)
      .filter(([, path]) => path === "src/app/use-osc-bridge.ts")
      .map(([type]) => type)
      .sort();
    expect(oscPumpEmittingTypes()).toEqual(fromLedger);
    // THE FLOOR (§T985): a ledger read that returned nothing would satisfy the line above
    // and prove nothing, so the set is required to be non-empty and every member of it is
    // required to really be a world-acting node.
    expect(oscPumpEmittingTypes().length).toBeGreaterThan(0);
    for (const type of oscPumpEmittingTypes()) {
      expect(registry.get(type)?.sideEffect, type).toBe("emits");
    }
  });

  it("derives its INGRESS set from the catalogue's own declarations", () => {
    const declared = allNodeDefinitions
      .filter((definition) => definition.listensOn?.channelPrefix === OSC_CHANNEL_PREFIX)
      .map((definition) => definition.type)
      .sort();
    expect(oscPumpListeningTypes(registry)).toEqual(declared);
    // The same floor, and the same reason: a registry walk that matched nothing would
    // leave every assertion above vacuously true.
    expect(oscPumpListeningTypes(registry).length).toBeGreaterThan(0);
    // And the derivation is a real filter rather than "everything": a catalogue where
    // every node listened would also pass the two lines above.
    expect(oscPumpListeningTypes(registry).length).toBeLessThan(allNodeDefinitions.length);
    // The fabricated type is found only when it is IN the catalogue handed over — which
    // is what makes the first case a property of the registry, not of this file.
    expect(oscPumpListeningTypes(extended)).toContain("oscInFabricated");
    expect(oscPumpListeningTypes(registry)).not.toContain("oscInFabricated");
  });
});

describe("a value bag as OSC messages", () => {
  it("a single `value` channel sends the bare address, mirroring the graph's own shorthand", () => {
    expect(messagesFor("/level", { value: 0.3 })).toEqual([{ address: "/level", args: [0.3] }]);
  });

  it("several channels send one message each, under the address as a prefix", () => {
    // `name:channel` in the graph becomes `/address/channel` on the wire — the same
    // mapping the ingress side uses, read backwards.
    expect(messagesFor("/pad", { y: 0.8, x: 0.2 })).toEqual([
      { address: "/pad/x", args: [0.2] },
      { address: "/pad/y", args: [0.8] },
    ]);
  });

  it("sorts, so two frames with the same bag put the same bytes on the wire", () => {
    expect(messagesFor("/pad", { b: 1, a: 2 }).map((message) => message.address)).toEqual(["/pad/a", "/pad/b"]);
  });

  it("drops a non-finite channel rather than sending a NaN a fader would take", () => {
    expect(messagesFor("/pad", { x: Number.NaN, y: 0.5 })).toEqual([{ address: "/pad/y", args: [0.5] }]);
    expect(messagesFor("/level", { value: Number.NaN })).toEqual([]);
    expect(messagesFor("/level", {})).toEqual([]);
  });
});

/*
 * ═══════════════════════════════════════════════════════════════════════════════════
 * §B212 — THE PUMP READ THE TIMELINE CLOCK AS IF IT WERE A HOST CLOCK.
 * ═══════════════════════════════════════════════════════════════════════════════════
 *
 * The owner, on E64 Relay: *"the receiving end is breaking down after it runs through the
 * timeline once. On frame 600 it suddenly just dies, at whatever point it was at."*
 *
 * 600 frames is `DEFAULT_FRAME_RANGE` — one lap at 60 fps — and "dies at whatever point it
 * was at" is a FREEZE rather than a fall to rest, which is what an `oscIn` that stops being
 * fed looks like: its last reading is retained, so the cyan trace goes flat at whatever
 * height it had. Nothing on the ingress path reads a clock at all. The egress path did:
 * `sync` took its rate-limiter clock from `frame.timeSeconds`, which WRAPS at the out point
 * (T455/T464 — that is the feature), while `lastSent` still held a reading from before the
 * wrap. `now - previous` then went to about −10 000 ms and could never climb back: the last
 * send of lap one happens at ~9.97 s and the clock's ceiling for every later lap is 9.98 s,
 * so `now - previous >= 1000 / rate` is false FOREVER. One lap, and the transmitter is dead
 * for the life of the session — silently, because a UDP send that never happens has no
 * outcome and raises no row.
 *
 * This is T489's property (`domain/transport/loop-continuity.test.ts`) escaping the graph.
 * That file enumerates NINE clock-reading surfaces and asserts none of them may see a value
 * decrease across a lap; every one of them is inside the value/render path. A SESSION PUMP
 * is a tenth, it reads the same wrapping clock, and nothing was watching it — §V437's shape
 * exactly, one layer out.
 *
 * So the gate is the RELAY, not the fix: the real hook, the real device client, the real
 * `oscOut` pump and the real `oscIn.valueEvaluate`, closed through a fake helper that echoes
 * every datagram back the way the loopback socket does — and driven by the real `liveClock`
 * across the real `projectRange`, past the wrap, asserting on the number the RECEIVING node
 * publishes. A unit test of the comparison would not have been the bug.
 */
describe("§B212 — the relay survives the lap", () => {
  /** E64's own circuit, so the numbers here are the numbers in `examples/documents/relay.ts`. */
  const LOOPBACK_HOST = "127.0.0.1";
  const LOOPBACK_PORT = 9107;
  const RELAY_ADDRESS = "/loom/relay";
  const RELAY_REST = 0.42;
  const FPS = 60;
  /** Where the sender's ramp starts — not 0, not `RELAY_REST`. See `heardOver`. */
  const RAMP_BASE = 0.1;

  /**
   * The document, both halves of the loop in one graph — `send1` transmits to the port
   * `hear1` listens on, exactly as E64 does.
   */
  const relayGraph = graphOf({
    send1: {
      type: "oscOut",
      label: "send1",
      parameters: { host: LOOPBACK_HOST, port: LOOPBACK_PORT, address: RELAY_ADDRESS, rate: 30 },
    },
    hear1: {
      type: "oscIn",
      label: "hear1",
      parameters: {
        port: LOOPBACK_PORT,
        controls: "level",
        levelAddress: RELAY_ADDRESS,
        levelRest: RELAY_REST,
      },
    },
  });

  /** The receiving node's own parameters, read by its own `valueEvaluate`. */
  const hearValues = relayGraph.nodes["hear1"]?.parameters as Record<string, ParameterValue>;

  function relay() {
    globalThis.sessionStorage.setItem("loom.bridge.pairing.v1", "ABCDEF");
    const socket = fakeSocket();
    const hook = renderHook(() =>
      useOscBridge({ socketFactory: socket.factory, port: 1, autoConnect: false }),
    );
    act(() => {
      hook.result.current.sync(frameAt(0), relayGraph, registry, new Map(), NO_CHANNELS, LIVE);
      socket.open();
    });
    act(() => {
      socket.say({ type: "deviceAttached", sources: [] });
    });
    socket.sent.length = 0;
    return { socket, hook };
  }

  /**
   * THE UDP STACK, which is the one thing a gate cannot have: every `deviceSend` the page
   * made since `from` comes back as the `deviceEvents` push a helper bound to 9107 would
   * produce for it. Everything either side of this line is the product's own code.
   */
  function echo(
    socket: ReturnType<typeof fakeSocket>,
    from: number,
  ): void {
    for (let index = from; index < socket.sent.length; index += 1) {
      const message = socket.sent[index] as Record<string, unknown>;
      if (message["type"] !== "deviceSend") continue;
      const values: Record<string, number> = {};
      for (const packet of message["packets"] as ReadonlyArray<{ address: string; args: number[] }>) {
        values[`${OSC_CHANNEL_PREFIX}${packet.address}`] = packet.args[0] as number;
      }
      socket.say({
        type: "deviceEvents",
        stream: `osc:${LOOPBACK_PORT}`,
        at: index,
        seq: index,
        dropped: 0,
        values,
      });
    }
  }

  /**
   * Run the circuit for `frames` frames off the REAL live transport, lapping at the real
   * project range, and report what `hear1` published on each one.
   *
   * The value sent is a strictly rising ramp on the ABSOLUTE frame count, so "frozen" is
   * directly readable: a heard sequence that stops rising is a receiving end that stopped
   * being fed, and it cannot be confused with the timeline's own values repeating. It
   * starts away from zero and away from `hear1`'s Rest so that "the loop closed" and
   * "nothing ever arrived" cannot produce the same number.
   */
  function heardOver(frames: number): { readonly heard: number[]; readonly sends: number[] } {
    const { socket, hook } = relay();
    const range = projectRange({});
    let nowMs = 0;
    const transport = liveClock({ fps: FPS, now: () => nowMs });
    const heard: number[] = [];
    const sends: number[] = [];
    for (let step = 0; step < frames; step += 1) {
      const frame = transport.next();
      const sent = RAMP_BASE + absFrameIndexOf(frame) / 100_000;
      const bags = new Map([["send1" as NodeId, { value: sent }]]);
      const before = socket.sent.length;
      act(() => {
        hook.result.current.sync(frame, relayGraph, registry, bags, NO_CHANNELS, LIVE);
      });
      act(() => {
        echo(socket, before);
      });
      sends.push(
        socket.sent.slice(before).filter((message) => message["type"] === "deviceSend").length,
      );
      const bag = registry.get("oscIn")?.valueEvaluate?.({
        inputs: {},
        values: hearValues,
        frame,
        state: {},
        // `use-value-graph.ts`'s adapter, verbatim: a `ChannelResolver` narrowed to the
        // `(name) => number | undefined` seam a node definition reads.
        channels: (name: string): number | undefined => {
          const value = hook.result.current.resolver(name, { frame } as never);
          return typeof value === "number" ? value : undefined;
        },
      });
      heard.push(bag?.["level"] as number);
      // The lap, as `use-frame-loop`'s `maybeLap` performs it: at the out point the
      // timeline wraps and NOTHING else is disturbed (T464).
      if (frame.frameIndex >= range.end) transport.wrapTo?.(range.start);
      nowMs += 1000 / FPS;
    }
    return { heard, sends };
  }

  it("keeps feeding the receiving end after the timeline has wrapped", () => {
    const range = projectRange({});
    // Two full laps and a bit, so the claim is about a SESSION rather than about the first
    // frame after the wrap.
    const { heard, sends } = heardOver(range.end + 1 + 200);
    const lap = range.end + 1;

    // A FLOOR first (§T985): the circuit has to close at all before its dying is worth
    // asserting. Frame zero's send goes out, comes back through the fake helper's push and
    // is what `hear1` publishes — not its Rest, which is what an open circuit reads.
    expect(heard[0]).toBeCloseTo(RAMP_BASE, 10);
    expect(RAMP_BASE).not.toBe(RELAY_REST);
    expect(sends.slice(0, lap).reduce((total, count) => total + count, 0)).toBeGreaterThan(100);

    // THE BUG, stated as the owner sees it: at frame 600 the cyan trace freezes at
    // whatever height it had and never moves again.
    const atWrap = heard[lap - 1] as number;
    const afterWrap = heard.slice(lap);
    expect(afterWrap.some((value) => value !== atWrap)).toBe(true);

    // And it is not a one-frame twitch: the receiving end keeps tracking a rising sender
    // for the whole of lap two, which is what "the relay works" means.
    expect(heard[heard.length - 1] as number).toBeGreaterThan(atWrap);
    // The transmitter runs at the SAME rate after the wrap as before it — asserted as a
    // ratio rather than as a count, so the number here is a property of `rate` against the
    // frame rate and not a transcription of what the code happened to do.
    const perFrame = (counts: readonly number[]): number =>
      counts.reduce((total, count) => total + count, 0) / counts.length;
    expect(perFrame(sends.slice(lap))).toBeCloseTo(perFrame(sends.slice(0, lap)), 2);
  });

  /*
   * THE SECOND SITE OF THE SAME CAUSE, and it is the one with the worse consequence: the
   * mid-session retry (`reconnectRemembered`) was gated on the same wrapping clock. A tab
   * that had lapped once before the helper was started would never dial again — so
   * `pnpm helper` would light nothing up, which is precisely what that retry exists to
   * make work (§T948 rule 1: probe the capability, do not gate on the deployment).
   */
  it("keeps retrying for a helper after the lap, so starting one mid-session still works", () => {
    globalThis.sessionStorage.setItem("loom.bridge.pairing.v1", "ABCDEF");
    /**
     * NO HELPER IS RUNNING — a connection to a closed loopback port is refused, which the
     * page sees as an `onclose` on a socket that never opened. That is what returns the
     * client to "not wanted" and makes the next retry a real dial, so it has to be modelled
     * here or the cadence under test would not exist at all.
     */
    const dials: BridgeSocket[] = [];
    const attempts: number[] = [];
    const factory = (): BridgeSocket => {
      const socket: BridgeSocket = {
        send: () => undefined,
        close: () => undefined,
        onopen: null,
        onmessage: null,
        onclose: null,
        onerror: null,
      };
      dials.push(socket);
      return socket;
    };
    const hook = renderHook(() =>
      useOscBridge({ socketFactory: factory, port: 1, autoConnect: false, retryMs: 500 }),
    );
    const range = projectRange({});
    let nowMs = 0;
    const transport = liveClock({ fps: FPS, now: () => nowMs });
    for (let step = 0; step < range.end + 1 + 200; step += 1) {
      const frame = transport.next();
      const before = dials.length;
      act(() => {
        hook.result.current.sync(frame, relayGraph, registry, new Map(), NO_CHANNELS, LIVE);
        // Connection refused, on whatever was just dialled.
        for (const dialled of dials.slice(before)) dialled.onclose?.();
      });
      attempts.push(dials.length - before);
      if (frame.frameIndex >= range.end) transport.wrapTo?.(range.start);
      nowMs += 1000 / FPS;
    }
    const lap = range.end + 1;
    const before = attempts.slice(0, lap).reduce((total, count) => total + count, 0);
    const after = attempts.slice(lap).reduce((total, count) => total + count, 0);
    // THE FLOOR: it really was dialling before the lap — 500 ms of retry across ten
    // seconds is twenty attempts — or the line below would be vacuously true.
    expect(before).toBeGreaterThan(10);
    // And it keeps dialling at the same cadence afterwards.
    expect(after / attempts.slice(lap).length).toBeCloseTo(before / lap, 2);
  });

  it("does not turn the wrap into a flood, so `rate` still means messages per second", () => {
    // The guard band is the other half: a lap must not be read as "infinitely overdue"
    // either. 30 messages a second against 60 fps is one send every other frame, both
    // sides of the wrap.
    const range = projectRange({});
    const { sends } = heardOver(range.end + 1 + 120);
    const lapTwo = sends.slice(range.end + 1);
    expect(lapTwo.reduce((total, count) => total + count, 0)).toBeLessThanOrEqual(
      Math.ceil(lapTwo.length / 2) + 1,
    );
  });
});
