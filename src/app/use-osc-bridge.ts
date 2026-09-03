import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { createNodeReferenceReader, resolveParameters } from "@domain/parameters/index.ts";
import { effectiveParameterSchema, type ChannelResolver } from "@domain/parameters/resolve.ts";
import type { RuntimeDiagnostic } from "@domain/types/diagnostics.ts";
import type { FrameEvaluationInput } from "@domain/types/frame.ts";
import type { GraphDocument } from "@domain/types/graph.ts";
import type { NodeId } from "@domain/types/ids.ts";
import type { NodeRegistryView } from "@nodes/registry/registry.ts";
import { OSC_CHANNEL_PREFIX } from "@domain/osc/osc-address.ts";
import type { OscBridgeState } from "@domain/osc/osc-status.ts";
import { describeSendOutcome, oscStatusLine } from "@domain/osc/osc-status.ts";
import { emissionRefusal, type SideEffectPolicy } from "@domain/render/side-effects.ts";
import { createDeviceClient, type DeviceClient } from "@/mcp/device-client.ts";
import type { OscSendOutcome } from "@/mcp/device-protocol.ts";
import type { BridgeSocketFactory } from "@/mcp/bridge-client.ts";
import type { OscMessage } from "@/mcp/osc-codec.ts";

/**
 * T942 tier 3 — the session's ONE device attachment, and the OSC pump (§V182 with a wire).
 *
 * ## What it is
 *
 * It holds one `device`-role socket to the local helper, publishes every OSC reading into
 * the channel seam the value graph already threads (`ValueEvaluateContext.channels`, built
 * for `analyze`), and pushes every `oscOut` node's bag back out once per frame. `oscIn`
 * projects readings through its own generated Address parameters; `channelIn` can read one
 * directly by name. No new port type, no compiler change, and nothing here knows what a
 * control is — `useMidiInput`'s shape exactly (§T959), with a helper in the middle because
 * a page can neither listen nor speak UDP.
 *
 * ## NO NEW CHROME — THE NODE IS THE INTERFACE, AND THE PROBLEMS PANE IS THE REASON
 *
 * Owner's ruling: *"everything should be a node surface so that we don't end up with a
 * million menu sections hard coded into our app."* So this hook renders nothing and owns
 * no panel. What it produces besides values is `diagnostics` — ordinary
 * `RuntimeDiagnostic`s, keyed to the node they concern — which join the one list `app.tsx`
 * already assembles and the problems pane already renders, beside media's and the value
 * graph's. §V365's rule is paid (the reason reaches a surface) with nothing built to pay
 * it, and the next device to land does the same.
 *
 * ## PAIRING IS NOT A SECOND CEREMONY, AND IT IS NOT DOCUMENT STATE
 *
 * The device socket presents the SAME pairing code the agent bridge does, out of the same
 * `sessionPairingMemory` (T925). So a tab that has paired in the agent panel's Connections
 * section is already able to speak OSC, and the pairing code never becomes a node
 * parameter — which matters, because a node parameter is saved into the `.loom.json` and a
 * control secret must not be. When the document wants OSC and no attachment exists, this
 * hook retries from that memory on a slow cadence, so pairing MID-SESSION lights the node
 * up without a reload (§T948 rule 1: probe the capability, do not gate on the deployment).
 *
 * ## THE SEND LIVES HERE, NOT IN THE NODE — AND THAT IS THE OFFLINE ANSWER
 *
 * §T950's fifth gap is "no side-effect story for offline/headless". This is it, and it is
 * structural rather than a flag: `oscOut.valueEvaluate` is a pure passthrough, and the
 * transmission is pumped from the app's live frame loop. An offline render, a headless
 * export and the Dawn gates all run the value graph and none of them construct this hook,
 * so none of them transmit. A send inside `valueEvaluate` would have made a background
 * export fire UDP at a lighting rig, silently, once per exported frame.
 *
 * T949 FOUND THE HOLE IN THAT STORY AND CLOSED IT. "An offline render never constructs
 * this hook" is true of a HEADLESS render and false of an IN-APP TAKE: `renderFrameRange`
 * steps the live transport, which runs the same `advanceChannels`, which calls this
 * `sync` — so a range render transmitted at encode rate while this paragraph said it
 * did not. `sync` now takes a `SideEffectPolicy` and `app.tsx` passes `"blocked"` while a
 * take is running, checked per node against the node's own `sideEffect` declaration.
 *
 * ## WHICH PORTS ARE OPEN IS THE DOCUMENT'S DECISION, AND ITS DEFAULT IS NONE
 *
 * The session listens on exactly the ports the document's `oscIn` nodes name, and their
 * default is `0` — not listening. Opening a patch never opens a socket by itself, and
 * deleting the last `oscIn` closes one with nothing remembering to.
 *
 * ## NOTHING IS SENT WITHOUT A DESTINATION (§T950 gap 4)
 *
 * `oscOut.host` defaults to `""` and `oscOut.port` to `0`, and `vetOscDestination` refuses
 * both — here, before a byte leaves the page, and again in the helper, which is the side
 * that owns the socket. Broadcast and multicast are refused by name for the same reason:
 * Art-Net's default IS a broadcast address, and defaulting a destination is §T458's
 * measured mistake wearing a different protocol.
 *
 * ## Why the readings are a ref and not React state (§V16)
 *
 * A fader bank pushes hundreds of messages a second. Readings go into a ref the resolver
 * reads at frame time; only the ATTACHMENT STATE and the DIAGNOSTIC SET — which change
 * when a sender starts or a destination breaks, not when a fader moves — are React state,
 * and each is written only when it actually differs.
 */

export interface OscBridgeBinding {
  readonly state: OscBridgeState;
  /**
   * Merged into the value graph's external channels, BESIDE midi and analyze — see
   * `app.tsx`. It answers only `osc:` names, so it can never shadow a node's channel.
   */
  readonly resolver: ChannelResolver;
  /**
   * One frame: open the ports the document names, and push every `oscOut` bag.
   *
   * Called from `advanceChannels` AFTER the value graph has evaluated, so what is sent is
   * this frame's numbers rather than the previous frame's (§V179's order contract).
   */
  readonly sync: (
    frame: FrameEvaluationInput,
    graph: GraphDocument,
    registry: NodeRegistryView,
    bags: ReadonlyMap<NodeId, Readonly<Record<string, number>>>,
    channels: ChannelResolver,
    /**
     * T949 — may a world-acting node reach the world on THIS frame? Required, not
     * optional: an optional parameter nothing supplies is §V272's mechanism, and the
     * thing it would silently default is a datagram at somebody's lighting rig.
     */
    policy: SideEffectPolicy,
  ) => void;
  /**
   * Why OSC is not working, keyed to the node it concerns (§V359, §V365).
   *
   * Identity is stable while the CONDITION is, so a running session with a healthy helper
   * re-renders the problems pane exactly never.
   */
  readonly diagnostics: readonly RuntimeDiagnostic[];
  /**
   * T950 — the ONE device client, shared with the laser pump. The bridge accepts one
   * device client per tab (its own exclusivity rule), so a second attachment from the
   * laser hook would be refused by the helper; the laser rides this session instead.
   * A function, not the object: the client is rebuilt on reconnect and a captured
   * reference would go stale.
   */
  readonly deviceClient: () => DeviceClient | null;
}

export interface OscBridgeOptions {
  /**
   * How the device socket is opened. Injected ONLY by tests.
   *
   * A gate cannot run a helper process, and the whole path — attach, subscribe, decode,
   * publish, send, refuse — is worth exercising without one. Same shape `useMidiInput`
   * gives `requestAccess`.
   */
  readonly socketFactory?: BridgeSocketFactory;
  readonly port?: number;
  /** One silent attempt with a code this tab already paired with. Off for a cold test. */
  readonly autoConnect?: boolean;
  /**
   * How long between attempts to reach a helper the document is asking for.
   *
   * Two seconds, matching the bridge's own retry-on-free (T921): the thing being waited
   * for is a human starting a process and typing a code, and a bind attempt on loopback
   * costs nothing. Injectable so a gate does not wait on a clock.
   */
  readonly retryMs?: number;
}

const DEFAULT_RETRY_MS = 2_000;

/** Nothing to read is not the same as zero; an unheard address falls to its rest. */
type Readings = Map<string, number>;

export function useOscBridge(options: OscBridgeOptions = {}): OscBridgeBinding {
  const [state, setState] = useState<OscBridgeState>({ kind: "idle" });
  const [diagnostics, setDiagnostics] = useState<readonly RuntimeDiagnostic[]>([]);

  const readings = useRef<Readings>(new Map());
  /** Every distinct address heard this session, for the status line's count. */
  const heard = useRef<Set<string>>(new Set());
  /** Host clock of the last send per node, so `rate` is honoured per node. */
  const lastSent = useRef<Map<NodeId, number>>(new Map());
  /** The last outcome per node. Turned into a problem row only when it is not healthy. */
  const outcomes = useRef<Map<NodeId, OscSendOutcome>>(new Map());
  const reported = useRef("");
  const client = useRef<DeviceClient | null>(null);
  const liveState = useRef<OscBridgeState>({ kind: "idle" });
  const lastAttempt = useRef(Number.NEGATIVE_INFINITY);

  const onReadings = useCallback((values: Readonly<Record<string, number>>): void => {
    for (const [name, value] of Object.entries(values)) {
      readings.current.set(name, value);
      heard.current.add(name);
    }
  }, []);

  const publishState = useCallback((next: OscBridgeState): void => {
    liveState.current = next;
    setState(next);
  }, []);

  useEffect(() => {
    const live = createDeviceClient({
      ...(options.socketFactory === undefined ? {} : { socketFactory: options.socketFactory }),
      ...(options.port === undefined ? {} : { port: options.port }),
      ...(options.autoConnect === undefined ? {} : { autoConnect: options.autoConnect }),
      client: "a Loom tab",
      onState: publishState,
      onReadings,
    });
    client.current = live;
    return () => {
      client.current = null;
      live.dispose();
    };
    // The client is a TRANSPORT and outlives every render; rebuilding it because a caller
    // passed an inline options object would drop the attachment (B76's measured shape).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onReadings, publishState]);

  const resolver = useCallback<ChannelResolver>((channel) => {
    // Namespaced, and the prefix is CHECKED rather than assumed, so this resolver can
    // never answer for a node's own channel name and the merge order cannot matter
    // (§V665's lesson, from the safe side).
    if (!channel.startsWith(OSC_CHANNEL_PREFIX)) return undefined;
    return readings.current.get(channel);
  }, []);

  const sync = useCallback(
    (
      frame: FrameEvaluationInput,
      graph: GraphDocument,
      registry: NodeRegistryView,
      bags: ReadonlyMap<NodeId, Readonly<Record<string, number>>>,
      channels: ChannelResolver,
      policy: SideEffectPolicy,
    ): void => {
      const live = client.current;
      if (live === null) return;
      const ports: number[] = [];
      /** Nodes that are ASKING for OSC — the set that makes an absent helper a problem. */
      const wanting: NodeId[] = [];
      const now = frame.timeSeconds * 1000;
      const next: RuntimeDiagnostic[] = [];

      /*
       * §T1001/§V837 — THE READER AND THE OPTIONS ARE BUILT TOGETHER, FROM ONE FACTORY.
       *
       * `op('lfo1').chan.value` is read INSIDE the reader (`node-references.ts`), off
       * `options.base`. The reader is a CLOSURE built before the resolve, so the `frame`
       * and `channels` handed to `resolveParameters` never reach it — and this call site
       * passed no reader at all, so every `op().chan.*` on an OSC node answered "this
       * context has no channel resolver", fell back to §V108's retained static, and froze
       * there. A destination or a Rate driven by a channel expression would have sat on
       * its last typed value for the life of the session while the picture animated.
       *
       * That is §B8's shape for the THIRD time (§T593 was the second, §T1000 the inspector
       * one). Hence the factory rather than a `nodes` field spread on afterwards: "at
       * which moment" is a PARAMETER here, so it cannot be set on the resolve and
       * forgotten on the reader. Built once per frame, not per node — two frames in one
       * evaluation is a value that is right on its own and wrong in context.
       */
      const base = { frame, channels };
      const readOptions = {
        nodes: createNodeReferenceReader({
          graph,
          schemaOf: (target) => effectiveParameterSchema(registry.get(target.type), target.parameters),
          base,
        }),
        ...base,
      };

      for (const [rawId, node] of Object.entries(graph.nodes)) {
        if (node.type !== "oscIn" && node.type !== "oscOut") continue;
        const nodeId = rawId as NodeId;
        const definition = registry.get(node.type);
        if (definition === undefined) continue;
        // §V61's single read path, so a driven or expression-valued destination works the
        // same way a driven `speed` does on a media node — nothing here knows about modes.
        const resolved = resolveParameters(node, definition, readOptions);
        const read = (key: string): unknown => resolved.get(key)?.value;

        if (node.type === "oscIn") {
          const port = read("port");
          if (typeof port === "number" && Number.isInteger(port) && port > 0) {
            ports.push(port);
            wanting.push(nodeId);
          }
          continue;
        }

        const host = typeof read("host") === "string" ? (read("host") as string).trim() : "";
        const port = typeof read("port") === "number" ? (read("port") as number) : 0;
        // A node with no destination is not asking for a helper — it is unconfigured, and
        // saying "start the helper" about it would be answering a question nobody asked.
        if (host === "" || port <= 0) continue;
        wanting.push(nodeId);

        /*
         * T949 — THE SIDE-EFFECT GATE, and it is here rather than at the top of `sync`
         * for two reasons.
         *
         * It reads the NODE'S OWN DECLARATION (`oscOut.sideEffect === "emits"`), so the
         * declaration is load-bearing rather than decorative: unset it and this check
         * stops firing. And it is past the destination test, so an unconfigured node —
         * which was never going to transmit — produces no row; the only nodes named are
         * the ones that WOULD have reached hardware.
         *
         * §T950's fifth gap was "no side-effect story for offline/headless". The story
         * used to be structural — an offline render installs no pump — and it had a hole
         * this check closes: an IN-APP TAKE steps the same live transport through the same
         * `advanceChannels`, so a range render was spraying OSC at encode rate, which is
         * the opposite of what this module's own note claimed. `app.tsx` passes
         * `"blocked"` for the duration of a take.
         *
         * WARNING, not silence (§V365): a rig that goes dark during a take with no
         * explanation is indistinguishable from a rig that is broken.
         */
        const refusal = emissionRefusal(definition, policy);
        if (refusal !== null) {
          next.push({ severity: "warning", code: "sideEffect.blocked", nodeId, message: refusal });
          continue;
        }

        const bag = bags.get(nodeId);
        // No bag means the node published nothing this frame — nothing wired, or muted. A
        // muted node is not cooked and must not transmit; falling out of the bag map is
        // what makes that true with no flag read here (§V437).
        if (bag === undefined) continue;
        const rateValue = read("rate");
        const rate = typeof rateValue === "number" && rateValue > 0 ? rateValue : 30;
        const previous = lastSent.current.get(nodeId) ?? Number.NEGATIVE_INFINITY;
        if (now - previous >= 1000 / rate) {
          lastSent.current.set(nodeId, now);
          const named = typeof read("address") === "string" ? (read("address") as string).trim() : "";
          // An empty Address takes the node's OWN name, which mirrors how a channel is
          // addressed in the graph (`lfo1` publishes `lfo1:value`). The DESTINATION has no
          // such default and never will — see the module note.
          const address = named !== "" ? named : `/${node.label ?? rawId}`;
          const packets = messagesFor(address, bag);
          if (packets.length > 0) {
            void live.send({ host, port }, packets).then(
              (outcome) => {
                outcomes.current.set(nodeId, outcome);
              },
              (error: unknown) => {
                outcomes.current.set(nodeId, {
                  delivery: "failed",
                  reason: error instanceof Error ? error.message : String(error),
                });
              },
            );
          }
        }
        const outcome = outcomes.current.get(nodeId);
        // Only a REFUSAL or a local FAILURE becomes a problem row. `unconfirmed` is the
        // normal, healthy state of a UDP send and the node's own description is where its
        // meaning is stated — a per-frame "we still cannot tell you it arrived" row would
        // be noise that trains people to ignore the pane (§V91's spirit).
        if (outcome !== undefined && outcome.delivery !== "unconfirmed") {
          next.push({
            severity: "warning",
            code: "osc.send",
            nodeId,
            message: describeSendOutcome(outcome),
          });
        }
      }

      live.listen(ports);

      const current = liveState.current;
      const healthy = current.kind === "listening" || current.kind === "attached";
      if (wanting.length > 0 && !healthy) {
        const status = oscStatusLine(current, heard.current.size);
        for (const nodeId of wanting) {
          next.push({
            severity: "warning",
            code: "osc.helper",
            nodeId,
            // §T948 rule 3: what to DO, never "disabled". The headline names the state and
            // the hint names the action; both are under §V90's cap because they come from
            // the one place that is tested for it.
            message: `${status.headline}. ${status.hint ?? ""}`.trim(),
            suggestion:
              "Run `pnpm mcp:serve`, then enter its pairing code in the agent panel's Connections section. The helper listens on 127.0.0.1 only, so an OSC sender must be on this machine.",
          });
        }
        // Retry from the code this tab already paired with, so pairing MID-SESSION lights
        // the node up without a reload. Only when the document is actually asking.
        if (now - lastAttempt.current >= (options.retryMs ?? DEFAULT_RETRY_MS)) {
          lastAttempt.current = now;
          live.reconnectRemembered();
        }
      }

      // §V16: the array's identity moves only when the SET OF CONDITIONS does, so sixty
      // frames a second of a healthy helper cost no render at all.
      const signature = next
        .map((diagnostic) => `${diagnostic.code}:${diagnostic.nodeId ?? ""}:${diagnostic.message}`)
        .sort()
        .join("|");
      if (signature === reported.current) return;
      reported.current = signature;
      setDiagnostics(next);
    },
    [options.retryMs],
  );

  const deviceClient = useCallback(() => client.current, []);
  return useMemo(
    () => ({ state, resolver, sync, diagnostics, deviceClient }),
    [state, resolver, sync, diagnostics, deviceClient],
  );
}

/**
 * One value bag as OSC messages.
 *
 * A bag whose only channel is `value` sends the bare address — `/level 0.3` — because that
 * is what a receiver expects from a single control and it mirrors the value graph's own
 * `name` shorthand. Anything else sends one message per channel under the address as a
 * prefix, so `{x, y}` on `/pad` becomes `/pad/x` and `/pad/y`. Sorted, so two frames with
 * the same bag put the same bytes on the wire in the same order.
 *
 * Non-finite channels are DROPPED rather than sent: `NaN` is a number a receiver will
 * happily apply to a fader, and it is exactly the shape a missing upstream takes.
 */
export function messagesFor(
  address: string,
  bag: Readonly<Record<string, number>>,
): readonly OscMessage[] {
  const keys = Object.keys(bag).sort();
  if (keys.length === 0) return [];
  if (keys.length === 1 && keys[0] === "value") {
    const only = bag["value"] as number;
    return Number.isFinite(only) ? [{ address, args: [only] }] : [];
  }
  const messages: OscMessage[] = [];
  for (const key of keys) {
    const value = bag[key] as number;
    if (!Number.isFinite(value)) continue;
    messages.push({ address: `${address}/${key}`, args: [value] });
  }
  return messages;
}
