import type { GraphDocument } from "../types/graph.ts";
import type { NodeId, PortId } from "../types/ids.ts";
import type { AudioFeatures, FrameEvaluationInput } from "../types/frame.ts";
import type { RuntimeDiagnostic } from "../types/diagnostics.ts";
import type { NodeDefinition, ValueChannels } from "../types/node-definition.ts";
import type { NodeRegistryView } from "../../nodes/registry/registry.ts";
import type { ChannelResolver } from "../parameters/resolve.ts";
import { resolveParameterSchema } from "../parameters/resolve.ts";
import { bypassPassthroughPorts } from "../graph/bypass.ts";

/**
 * The value graph (T273/T274, §V179): TD's CHOP layer, CPU-side, evaluated once per
 * frame BEFORE the render.
 *
 * Value nodes connect through `value` ports and value EDGES — a real graph with
 * ordering, cycle detection and something to look at, replacing "a chain typed as
 * text". They never enter the GPU plan and never allocate GPU resources: §V183 says
 * why that is safe — these are SCALARS — and why the reasoning must not be generalised
 * to pixels.
 *
 * Evaluation is topological over the value edges (Kahn, sorted, deterministic). A
 * cycle is reported and its members emit empty bags — the command-time rejection
 * (§V152) is the real gate; this is the runtime backstop. Each node produces a channel
 * BAG (`{ x, y }`, `{ value }`), addressed downstream as `name` or `name:channel`
 * (§V129 again: the name is the address). Stateful stages keep a per-node bag across
 * frames (§V181), cleared on `reset()` — which is what ties them to §V170's seek
 * rules: their output is not a function of frame index alone.
 *
 * A node's own parameters resolve with the frame but WITHOUT channels — a value
 * node's parameter driven by another value node is the value graph's own wiring
 * question (connect them instead); resolving it through the resolver here would be
 * recursion through the seam this module implements.
 *
 * ## MUTE and BYPASS (T541/B114)
 *
 * This module contained no occurrence of either word until T541: texture chains honoured
 * the two flags from T250 and value chains never learned, so an `audioPattern` with the
 * mute badge lit kept driving everything downstream, plot and all. §V437's shape — the
 * flags were a PROPERTY of the graph and were delivered at one layer.
 *
 * Both are defined here EXACTLY as the compiler defines them for textures (§V109 — one
 * question, one answer), the only difference being the flavour of silence each layer has
 * to hand:
 *
 *  - **MUTE = publish NOTHING.** The node emits no bag, so it is absent from `byId` and
 *    `byName`: the resolver answers `undefined` for its name (a driven parameter falls
 *    back exactly as it does for a name that was never wired), its plot goes blank, and —
 *    the part that needs saying — a consumer's input PORT stays ABSENT rather than
 *    arriving empty. `{}` is not the same as unconnected: `valueSwitch` counts CONNECTED
 *    inputs, so an empty bag would still be a branch and muting `in1` would silently
 *    renumber the others. Absent is what "as if nothing were wired" has to mean.
 *  - **BYPASS = the input bag, unchanged**, taken from the node's passthrough input
 *    (`bypassPassthroughPorts`, shared with the compiler). Nothing arriving there — a
 *    SOURCE with no inputs at all (`audioPattern`, `lfo`, `audioFileIn`, `mouse`), or an
 *    unwired passthrough port — means there is nothing to pass, and the node is silent by
 *    the rule above. That is TD's behaviour for a bypassed generator and already this
 *    project's answer for a bypassed texture source; inventing "bypass on a source is a
 *    no-op" here would have made one flag mean two things depending on the node.
 *
 * Silence PROPAGATES: a node whose only input went silent publishes nothing itself, so
 * `mute → lag → switch` reaches the switch as an unconnected port, not as a zero.
 *
 * §V457's merge sees this: a muted node simply stops contributing to the
 * `{...prior, ...next}` fold, so on a port fed by two sources the survivor now supplies
 * every channel it publishes — including ones the muted node used to win. That is the
 * merge doing what it is specified to do (it is a compose, and one contributor left), and
 * it is deliberate: muting one node CAN change another's contribution to a shared port.
 * It is pinned by test rather than left to be rediscovered.
 *
 * A muted node's persistent state is neither advanced nor cleared — it is not cooked, the
 * way a muted CHOP is not cooked — so a Lag resumes its trajectory when the badge goes
 * out instead of jumping to a value it never travelled to.
 */

export interface ValueGraphResult {
  /** Channel bags keyed by node NAME (unnamed value nodes are unaddressable, like T238). */
  readonly byName: ReadonlyMap<string, ValueChannels>;
  /**
   * The same bags keyed by node ID (T615).
   *
   * A DISPLAY must read this one and never `byName`. Once the value graph runs on the
   * flattened document, an instance's internal label is whatever B41's `withUniqueNames`
   * made it: adding a root node called `wob` renames the FIRST instance's `wob` to `wob1`
   * and shifts every other instance's label along with it. State is id-keyed and survives
   * that; a plot looked up by name would silently start showing another instance's
   * numbers, which is the failure mode nobody would report as a bug.
   *
   * The RESOLVER still keys on name, correctly — a `driven` parameter names a channel,
   * and `withUniqueNames` rewrites the binding and the label together so the pair stays
   * consistent (§V129).
   */
  readonly byId: ReadonlyMap<NodeId, ValueChannels>;
  readonly diagnostics: ReadonlyArray<RuntimeDiagnostic>;
  /**
   * The resolver for `driven` parameters: `name` reads the bag's `value` channel (or
   * its only channel), `name:channel` reads a named one. Plug in front of / instead of
   * `graphChannelResolver` — the trio evaluates here too, as the degenerate case.
   */
  readonly resolver: ChannelResolver;
}

export interface ValueGraphSession {
  evaluate(
    graph: GraphDocument,
    frame: FrameEvaluationInput,
    extras?: { pointer?: { x: number; y: number; buttons: number }; audio?: AudioFeatures },
  ): ValueGraphResult;
  /** Clears every node's persistent state (§V181) — transport reset, backward seek. */
  reset(): void;
}

function isValueNode(definition: NodeDefinition | undefined): definition is NodeDefinition {
  return definition !== undefined && (definition.valueEvaluate !== undefined || definition.valueChannel !== undefined);
}

const valuePortIds = (definition: NodeDefinition): ReadonlySet<PortId> =>
  new Set(definition.inputs.filter((port) => port.type.kind === "value").map((port) => port.id));

export function createValueGraphSession(registry: NodeRegistryView): ValueGraphSession {
  /** nodeId → persistent state bag. Survives frames; dies on reset() or node removal. */
  const states = new Map<NodeId, Record<string, unknown>>();

  return {
    reset() {
      states.clear();
    },

    evaluate(graph, frame, extras = {}) {
      const diagnostics: RuntimeDiagnostic[] = [];

      interface Member {
        readonly nodeId: NodeId;
        readonly definition: NodeDefinition;
      }
      const members = new Map<NodeId, Member>();
      for (const nodeId of Object.keys(graph.nodes).sort()) {
        const node = graph.nodes[nodeId];
        const definition = node === undefined ? undefined : registry.get(node.type);
        if (isValueNode(definition)) members.set(nodeId, { nodeId, definition });
      }
      // Drop state for nodes that left the document, so a deleted-and-recreated Lag
      // starts fresh rather than inheriting a stranger's trajectory.
      for (const nodeId of [...states.keys()]) {
        if (!members.has(nodeId)) states.delete(nodeId);
      }

      /** Value edges between members, target input port → sorted upstream sources. */
      const incoming = new Map<NodeId, Array<{ edgeId: string; source: NodeId; port: PortId }>>();
      const dependents = new Map<NodeId, NodeId[]>();
      const indegree = new Map<NodeId, number>();
      for (const nodeId of members.keys()) indegree.set(nodeId, 0);
      for (const edgeId of Object.keys(graph.edges).sort()) {
        const edge = graph.edges[edgeId];
        if (edge === undefined) continue;
        const source = members.get(edge.source.nodeId);
        const target = members.get(edge.target.nodeId);
        if (source === undefined || target === undefined) continue;
        if (!valuePortIds(target.definition).has(edge.target.portId)) continue;
        const list = incoming.get(edge.target.nodeId) ?? [];
        list.push({ edgeId, source: edge.source.nodeId, port: edge.target.portId });
        incoming.set(edge.target.nodeId, list);
        const dependentList = dependents.get(edge.source.nodeId) ?? [];
        dependentList.push(edge.target.nodeId);
        dependents.set(edge.source.nodeId, dependentList);
        indegree.set(edge.target.nodeId, (indegree.get(edge.target.nodeId) ?? 0) + 1);
      }

      // Kahn, deterministic: the ready set stays sorted.
      const order: NodeId[] = [];
      const ready = [...members.keys()].filter((nodeId) => (indegree.get(nodeId) ?? 0) === 0).sort();
      while (ready.length > 0) {
        const nodeId = ready.shift() as NodeId;
        order.push(nodeId);
        for (const next of [...(dependents.get(nodeId) ?? [])].sort()) {
          const remaining = (indegree.get(next) ?? 1) - 1;
          indegree.set(next, remaining);
          if (remaining === 0) {
            ready.push(next);
            ready.sort();
          }
        }
      }
      if (order.length < members.size) {
        const cycled = [...members.keys()].filter((nodeId) => !order.includes(nodeId)).sort();
        diagnostics.push({
          severity: "error",
          code: "valueGraph.cycle",
          message: `Value graph cycle: ${cycled.join(", ")} depend on each other; they emit nothing this frame.`,
          suggestion: "Break the loop — a feedback stage (Lag reading itself) needs an explicit delay, not a wire loop (§V152).",
        });
      }

      const byId = new Map<NodeId, ValueChannels>();
      const byName = new Map<string, ValueChannels>();
      /** Publishes a node's bag. A node that never calls this is SILENT (see the note). */
      const publish = (nodeId: NodeId, bag: ValueChannels): void => {
        // Non-finite numbers never leave a stage: downstream math on NaN is a graph
        // that silently dies three nodes later.
        const clean: Record<string, number> = {};
        for (const [name, value] of Object.entries(bag)) {
          if (Number.isFinite(value)) clean[name] = value;
        }
        // T541: NO CHANNELS IS SILENCE, whatever produced it — a mute, a bypassed source,
        // a Switch with nothing connected, a stage that threw. Publishing an empty bag
        // would make the node PRESENT-but-empty, and a consumer cannot tell that from a
        // real reading: `valueSwitch` would count it as a branch and cut to nothing. So
        // silence propagates as ABSENCE, and there is one kind of it rather than two.
        if (Object.keys(clean).length === 0) return;
        byId.set(nodeId, clean);
        const label = graph.nodes[nodeId]?.label;
        if (label !== undefined) byName.set(label, clean);
      };

      for (const nodeId of order) {
        const member = members.get(nodeId);
        const node = graph.nodes[nodeId];
        if (member === undefined || node === undefined) continue;

        // T541: MUTE first, before inputs, parameters, state or diagnostics. A muted node
        // is OFF — it does not cook, so it cannot resolve a bad parameter, cannot report a
        // shadowed channel and cannot advance a Lag. It publishes nothing at all.
        if (node.ui?.muted === true) continue;

        const inputs: Record<PortId, ValueChannels> = {};
        /** T509: who currently supplies each channel of each port, for the shadow report. */
        const providers = new Map<string, NodeId>();
        for (const entry of incoming.get(nodeId) ?? []) {
          // Merged over sorted edge ids: later channels win on a name clash, which is
          // deterministic and lets a multi-wire input compose bags (V457 — the merge
          // itself is deliberate and stays).
          // T541: a source that published NOTHING (muted, or bypassed with nothing to
          // pass) contributes no edge at all — not an empty bag. A port fed only by such
          // sources stays ABSENT from `inputs`, which is how a consumer sees "unwired":
          // `valueSwitch` counts connected inputs, and an empty bag would still be a
          // branch. §V457's merge simply loses a contributor, deliberately.
          const arriving = byId.get(entry.source);
          if (arriving === undefined) continue;
          const existing = inputs[entry.port] ?? {};
          for (const name of Object.keys(arriving)) {
            const holder = providers.get(`${entry.port}:${name}`);
            if (holder !== undefined && holder !== entry.source && name in existing) {
              // T509: the loser VANISHES with no other symptom — a user wiring two
              // audio bags into one port watches half their channels disappear. The
              // behaviour is pinned; the silence was the bug, so this is a diagnostic
              // and deliberately NOT a behaviour change.
              const winner = graph.nodes[entry.source]?.label ?? entry.source;
              const shadowed = graph.nodes[holder]?.label ?? holder;
              diagnostics.push({
                severity: "warning",
                code: "valueGraph.channelShadowed",
                message: `Value node "${node.label ?? nodeId}" port "${entry.port}": channel "${name}" arrives from both "${shadowed}" and "${winner}"; "${winner}" wins (last edge in id order) and "${shadowed}"'s value is ignored.`,
                nodeId,
                suggestion: "Rename one channel upstream, or drop one of the wires — a merged port keeps only one value per name.",
              });
            }
            providers.set(`${entry.port}:${name}`, entry.source);
          }
          inputs[entry.port] = { ...existing, ...arriving };
        }

        // T541: BYPASS is a WIRE — the passthrough input's bag, unchanged and unevaluated,
        // so nothing downstream can tell the node apart from a piece of cable. The port is
        // `bypassPassthroughPorts`, the same rule the texture compiler splices by. Nothing
        // arriving there (a SOURCE has no such port at all) means there is nothing to pass
        // and the node is silent — TD's bypassed generator, and T250's bypassed source.
        if (node.ui?.bypassed === true) {
          const through = bypassPassthroughPorts(member.definition);
          const passed = through === undefined ? undefined : inputs[through.input];
          // A copy, never the input object: `byId` hands bags to downstream stages and a
          // shared reference would let one stage's mutation reach back into its source.
          if (passed !== undefined) publish(nodeId, { ...passed });
          continue;
        }

        // Frame-scoped, channel-free parameter resolution (see the module note).
        const resolved = resolveParameterSchema(node, member.definition.parameters, { frame });
        const state = states.get(nodeId) ?? {};
        states.set(nodeId, state);

        let channels: ValueChannels = {};
        try {
          if (member.definition.valueEvaluate !== undefined) {
            channels = member.definition.valueEvaluate({
              inputs,
              values: resolved.values,
              frame,
              ...(extras.pointer === undefined ? {} : { pointer: extras.pointer }),
              ...(extras.audio === undefined ? {} : { audio: extras.audio }),
              state,
            });
          } else if (member.definition.valueChannel !== undefined) {
            channels = { value: member.definition.valueChannel(resolved.values, frame) };
          }
        } catch (error) {
          diagnostics.push({
            severity: "error",
            code: "valueGraph.evaluate",
            message: `Value node "${node.label ?? nodeId}" failed: ${error instanceof Error ? error.message : String(error)}`,
            nodeId,
          });
        }
        publish(nodeId, channels);
      }

      const resolver: ChannelResolver = (channel) => {
        const colon = channel.indexOf(":");
        const name = colon < 0 ? channel : channel.slice(0, colon);
        const bag = byName.get(name);
        if (bag === undefined) return undefined;
        if (colon >= 0) return bag[channel.slice(colon + 1)];
        if (bag["value"] !== undefined) return bag["value"];
        const keys = Object.keys(bag);
        return keys.length === 1 ? bag[keys[0] as string] : undefined;
      };

      return { byName, byId, diagnostics, resolver };
    },
  };
}
