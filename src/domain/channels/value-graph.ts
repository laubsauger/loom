import type { GraphDocument } from "../types/graph.ts";
import type { NodeId, PortId } from "../types/ids.ts";
import type { FrameEvaluationInput } from "../types/frame.ts";
import type { RuntimeDiagnostic } from "../types/diagnostics.ts";
import type { NodeDefinition, ValueChannels } from "../types/node-definition.ts";
import type { NodeRegistryView } from "../../nodes/registry/registry.ts";
import type { ChannelResolver } from "../parameters/resolve.ts";
import { resolveParameterSchema } from "../parameters/resolve.ts";

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
 */

export interface ValueGraphResult {
  /** Channel bags keyed by node NAME (unnamed value nodes are unaddressable, like T238). */
  readonly byName: ReadonlyMap<string, ValueChannels>;
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
    extras?: { pointer?: { x: number; y: number; buttons: number } },
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
      for (const nodeId of order) {
        const member = members.get(nodeId);
        const node = graph.nodes[nodeId];
        if (member === undefined || node === undefined) continue;

        const inputs: Record<PortId, ValueChannels> = {};
        for (const entry of incoming.get(nodeId) ?? []) {
          // Merged over sorted edge ids: later channels win on a name clash, which is
          // deterministic and lets a multi-wire input compose bags.
          inputs[entry.port] = { ...(inputs[entry.port] ?? {}), ...(byId.get(entry.source) ?? {}) };
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
        // Non-finite numbers never leave a stage: downstream math on NaN is a graph
        // that silently dies three nodes later.
        const clean: Record<string, number> = {};
        for (const [name, value] of Object.entries(channels)) {
          if (Number.isFinite(value)) clean[name] = value;
        }
        byId.set(nodeId, clean);
        if (node.label !== undefined) byName.set(node.label, clean);
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

      return { byName, diagnostics, resolver };
    },
  };
}
