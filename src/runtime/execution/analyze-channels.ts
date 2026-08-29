import type { GraphDocument } from "../../domain/types/graph.ts";
import type { ChannelResolver } from "../../domain/parameters/resolve.ts";
import type { NodeRegistryView } from "../../nodes/registry/registry.ts";
import { scratchResourceId } from "../../compiler/resources.ts";
import { storedStaticValue } from "../../domain/parameters/slots.ts";

/**
 * Analyze readback channels (T236, §V144, §V48).
 *
 * The CPU half of the Analyze node: reads each analyze node's 16-byte reduction buffer
 * BETWEEN frames, keeps the latest number, and publishes it under the node's NAME as a
 * driven channel — merged in front of the pure `graphChannelResolver` so an Analyze and
 * an LFO drive parameters through the same seam.
 *
 * §V144's latency contract, decided deliberately rather than discovered: `resolver`
 * always answers SYNCHRONOUSLY with the last COMPLETED readback — the reduction of a
 * frame that already finished. `sample()` is called by the frame loop between frames
 * (§V48's sanctioned window) and is fire-and-forget; a readback that has not landed
 * simply leaves the previous value standing. One frame late is correct. A stall is not.
 * There is no clock in here at all — cadence belongs to the caller (§V44).
 */

export interface AnalyzeEntry {
  /** The channel name — the analyze node's NAME (§V129). */
  readonly channel: string;
  /** The reduction buffer's resource id in the current plan. */
  readonly resourceId: string;
  /** Which of [average, minimum, maximum] the channel publishes. */
  readonly operation: "average" | "minimum" | "maximum";
}

/** The entries the current document declares — recomputed after each compile. */
export function analyzeChannelEntries(
  graph: GraphDocument,
  registry: NodeRegistryView,
  resultKey = "result",
): AnalyzeEntry[] {
  const entries: AnalyzeEntry[] = [];
  for (const nodeId of Object.keys(graph.nodes).sort()) {
    const node = graph.nodes[nodeId];
    if (node === undefined || node.label === undefined) continue;
    const definition = registry.get(node.type);
    if (definition?.type !== "analyze") continue;
    const operation = storedStaticValue(node.parameters["operation"]);
    entries.push({
      channel: node.label,
      resourceId: scratchResourceId(nodeId, resultKey),
      operation: operation === "minimum" || operation === "maximum" ? operation : "average",
    });
  }
  return entries;
}

export interface AnalyzeChannels {
  /** Replaces the tracked set — called after each successful compile. */
  track(entries: ReadonlyArray<AnalyzeEntry>): void;
  /**
   * Pulls every tracked buffer once, asynchronously. Call between frames; never await
   * it from inside one. Overlapping calls skip buffers still in flight.
   */
  sample(): void;
  /** Synchronous, latest-completed values. Plug in front of graphChannelResolver. */
  readonly resolver: ChannelResolver;
}

const OPERATION_INDEX = { average: 0, minimum: 1, maximum: 2 } as const;

export function createAnalyzeChannels(options: {
  readBuffer: (resourceId: string) => Promise<ArrayBuffer>;
}): AnalyzeChannels {
  let tracked: ReadonlyArray<AnalyzeEntry> = [];
  const latest = new Map<string, number>();
  const inFlight = new Set<string>();

  return {
    track(entries) {
      tracked = entries;
      const names = new Set(entries.map((entry) => entry.channel));
      for (const known of [...latest.keys()]) {
        if (!names.has(known)) latest.delete(known);
      }
    },
    sample() {
      for (const entry of tracked) {
        if (inFlight.has(entry.channel)) continue;
        inFlight.add(entry.channel);
        options
          .readBuffer(entry.resourceId)
          .then((raw) => {
            const values = new Float32Array(raw, 0, 4);
            const value = values[OPERATION_INDEX[entry.operation]];
            if (value !== undefined && Number.isFinite(value)) latest.set(entry.channel, value);
          })
          .catch(() => {
            // A failed readback (plan mid-swap, device recovering) keeps the previous
            // value — the §V144 contract: stale beats stalled, and the next sample retries.
          })
          .finally(() => {
            inFlight.delete(entry.channel);
          });
      }
    },
    resolver: (channel) => latest.get(channel),
  };
}
