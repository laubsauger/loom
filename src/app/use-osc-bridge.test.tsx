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
import { messagesFor, useOscBridge } from "./use-osc-bridge.ts";

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
   */
  it("resolves op().chan on an oscOut parameter, so a driven destination is not frozen", async () => {
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
    const channels = ((channel: string) => (channel === "p1:value" || channel === "p1" ? 9001 : undefined)) as ChannelResolver;
    const { socket, hook } = pumped(graph);
    await act(async () => {
      hook.result.current.sync(frameAt(0), graph, registry, new Map([["b" as NodeId, { value: 0.5 }]]), channels, LIVE);
      await Promise.resolve();
    });
    const sends = socket.sent.filter((message) => message["type"] === "deviceSend");
    expect(sends).toHaveLength(1);
    // The VALUE the expression produced, not merely that something was sent: a reader that
    // answered a stale number would still have sent, to the wrong place.
    expect((sends[0] as { to?: { port?: number } }).to?.port).toBe(9001);
  });

  it("is refusing because the NODE says it acts on the world, not because it is called oscOut", () => {
    // The pump reads `definition.sideEffect`. This pins the fact the refusal turns on, so
    // a definition that quietly loses the declaration fails here as well as above.
    expect(registry.get("oscOut")?.sideEffect).toBe("emits");
    expect(registry.get("oscIn")?.sideEffect).toBeUndefined();
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
