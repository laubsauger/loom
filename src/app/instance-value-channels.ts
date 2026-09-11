import type { FlattenedGraph } from "@compiler/index.ts";
import type { NodeId, PortId } from "@domain/types/ids.ts";
import type { ValueChannels } from "@domain/types/node-definition.ts";
import type { NodeRegistryView } from "@nodes/registry/registry.ts";

/**
 * A component INSTANCE's channels, taken from the inner nodes its outputs expose
 * (T1297, the other half of T1031).
 *
 * ## The seam
 *
 * `flattenComponents` DELETES the instance node — that is what flattening is — and the
 * history sampler walks the FLATTENED graph, so no ring was ever written under an
 * instance's id. Meanwhile the synthesized component definition really does carry `value`
 * output ports, so `publishesValueChannels` answered true, the pane rendered a plot, and
 * that plot said "no signal yet" forever. `audioAnalysis` exposes `levels` and `hits`; a
 * user could see the signal by diving INTO the component (T1031 fixed that half) and
 * never from the instance in front of them, which is where they were looking.
 *
 * TEXTURES ALREADY SOLVED THIS. `flattened.instanceOutputs` maps an instance's port to
 * the inner flat endpoint it became, and `redirectSink` has used it since the instance
 * node started disappearing (`compile.ts`). This is the same redirect for the value
 * layer, off the same map — no second walk of the component tree, and nothing here
 * flattens or evaluates anything (§V275: there is ONE sample of the value graph per
 * frame, and a display that re-evaluated a stateful stage would advance a Lag twice
 * purely because someone was looking at it).
 *
 * ## Naming, when an instance exposes more than one publisher
 *
 * The value graph publishes one bag PER NODE, not per port. An instance exposing one
 * value output therefore reads exactly like the node inside it — `level`, `bpm` — which
 * is the common case and the one worth keeping unadorned. An instance exposing two or
 * more DISTINCT inner publishers prefixes each with the port that exposes it
 * (`levels:level`, `hits:kick`), because merging them would let two inner nodes that both
 * publish `value` collide and one would silently win. Two ports onto the SAME inner node
 * are one bag and appear once: they address the same publication, and printing it twice
 * would claim two signals that happen to agree.
 *
 * The prefix decision is made from the exposed PORTS, not from how many bags resolved, so
 * muting one inner node does not rename the other's channels.
 *
 * ## Silence stays silence (§V91)
 *
 * A muted inner node publishes NO bag (`value-graph.ts` — mute means not cooked), so it
 * contributes nothing here and an instance whose every publisher is silent yields no
 * entry at all. The caller must then leave the instance out of `retain`'s live set, which
 * drops its ring: the plot says "no signal yet" rather than freezing on the window the
 * component had when it was switched off, and never draws a line at zero.
 */
export interface InstanceValueChannels {
  /** The INSTANCE's flattened id — the id its plot subscribes under. */
  readonly nodeId: NodeId;
  readonly channels: Readonly<Record<string, number>>;
}

export function instanceValueChannels(
  flattened: Pick<FlattenedGraph, "graph" | "instanceOutputs">,
  registry: NodeRegistryView,
  bags: ReadonlyMap<NodeId, ValueChannels>,
): readonly InstanceValueChannels[] {
  const out: InstanceValueChannels[] = [];
  for (const [instanceId, outputs] of flattened.instanceOutputs) {
    // Distinct inner publishers, in exposure order; the first port to reach one names it.
    const publishers = new Map<NodeId, PortId>();
    for (const [portId, endpoint] of outputs) {
      if (publishers.has(endpoint.nodeId)) continue;
      const inner = flattened.graph.nodes[endpoint.nodeId];
      if (inner === undefined) continue;
      // The kind lives on the INNER node's own declared port, judged the same way
      // `flatten.ts` judges previewability for a pinned instance.
      const declared = registry
        .get(inner.type)
        ?.outputs.find((port) => port.id === endpoint.portId);
      if (declared?.type.kind !== "value") continue;
      publishers.set(endpoint.nodeId, portId);
    }
    if (publishers.size === 0) continue;
    const prefixed = publishers.size > 1;
    const channels: Record<string, number> = {};
    let published = false;
    for (const [innerId, portId] of publishers) {
      const bag = bags.get(innerId);
      if (bag === undefined) continue;
      published = true;
      for (const [channel, value] of Object.entries(bag)) {
        channels[prefixed ? `${portId}:${channel}` : channel] = value;
      }
    }
    if (!published) continue;
    out.push({ nodeId: instanceId, channels });
  }
  return out;
}
