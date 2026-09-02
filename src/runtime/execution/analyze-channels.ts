import type { GraphDocument } from "../../domain/types/graph.ts";
import type { NodeId } from "../../domain/types/ids.ts";
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
  /**
   * The node the channel belongs to. The channel is the user-facing identity; this is the
   * one telemetry attributes the readback to, so the perf panel can name a node the canvas
   * can select rather than a name it would have to search for (T278, §V185).
   */
  readonly nodeId: NodeId;
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
      nodeId,
      resourceId: scratchResourceId(nodeId, resultKey),
      operation: operation === "minimum" || operation === "maximum" ? operation : "average",
    });
  }
  return entries;
}

/** How stale one Analyze node's published value is, right now (§V329). */
export interface AnalyzeAge {
  readonly nodeId: NodeId;
  /**
   * Frames between the frame this value reduces and the frame being asked about.
   *
   * `1` is the §V144 contract holding: the value visible while frame N renders is the
   * reduction of frame N-1. Anything larger is a readback that has not landed yet — a
   * plan mid-swap, a device recovering, or simply load — and it is exactly the number
   * §V329 says must not be invisible.
   */
  readonly ageFrames: number;
}

export interface AnalyzeChannels {
  /** Replaces the tracked set — called after each successful compile. */
  track(entries: ReadonlyArray<AnalyzeEntry>): void;
  /**
   * Pulls every tracked buffer once, asynchronously. Call between frames; never await
   * it from inside one. Overlapping calls skip buffers still in flight.
   *
   * `frameIndex` is the frame that just closed — the frame whose reduction the buffer now
   * holds. It is passed in rather than counted here because §V44 puts the clock in the
   * caller: this module reads no clock and counts no ticks, so the same call from an
   * offline driver stamps offline frame numbers with no branch anywhere.
   *
   * Returns a promise that resolves when THIS call's readbacks have fully settled —
   * `latest` written AND the in-flight guard cleared. The LIVE loop ignores it: sampling
   * is fire-and-forget there, stale beats stalled (§V144). The OFFLINE/harness path awaits
   * it (B161) — awaiting the full chain, not the raw readback, is what makes the guard
   * clear before the next sample, so the phase cannot shift with an unrelated readback's
   * microtasks and a captured frame stops perturbing a later one.
   */
  sample(frameIndex: number): Promise<void>;
  /** Synchronous, latest-completed values. Plug in front of graphChannelResolver. */
  readonly resolver: ChannelResolver;
  /**
   * §V329's FIRST HALF, which had no implementation anywhere until T645.
   *
   * "An async result in a per-frame graph must expose its staleness. A node silently
   * showing a result from 400ms ago is the §V147 family again: the picture is plausible
   * and wrong." Analyze has published a latest-wins number since T236 and exposed NO age
   * at all, so a parameter driven by it showed a value from an unknown number of frames
   * ago. This is the number, per node, and `useAnalyzeChannels` publishes it onto the
   * per-node telemetry channel where the node info popup already reads (§V85, §V16).
   *
   * Only nodes with a COMPLETED readback appear. A node still waiting for its first one
   * has no age — it has no value either, and reporting `0` would say the opposite.
   */
  resultAges(frameIndex: number): readonly AnalyzeAge[];
}

const OPERATION_INDEX = { average: 0, minimum: 1, maximum: 2 } as const;

export function createAnalyzeChannels(options: {
  readBuffer: (resourceId: string) => Promise<ArrayBuffer>;
}): AnalyzeChannels {
  let tracked: ReadonlyArray<AnalyzeEntry> = [];
  const latest = new Map<string, number>();
  /** Channel -> the frame index whose reduction `latest` currently holds (§V329). */
  const sourceFrame = new Map<string, number>();
  const inFlight = new Set<string>();

  return {
    track(entries) {
      tracked = entries;
      const names = new Set(entries.map((entry) => entry.channel));
      for (const known of [...latest.keys()]) {
        if (!names.has(known)) latest.delete(known);
      }
      // The age must be dropped with the value it describes: a renamed or deleted node
      // whose frame stamp survived would report an age for a number nobody can read.
      for (const known of [...sourceFrame.keys()]) {
        if (!names.has(known)) sourceFrame.delete(known);
      }
    },
    sample(frameIndex) {
      const settling: Array<Promise<void>> = [];
      for (const entry of tracked) {
        if (inFlight.has(entry.channel)) continue;
        inFlight.add(entry.channel);
        const chain = options
          .readBuffer(entry.resourceId)
          .then((raw) => {
            const values = new Float32Array(raw, 0, 4);
            const value = values[OPERATION_INDEX[entry.operation]];
            if (value !== undefined && Number.isFinite(value)) {
              latest.set(entry.channel, value);
              // Stamped with the frame the read was ISSUED for, not the frame it landed
              // on: the buffer holds that frame's reduction whenever the copy completes.
              sourceFrame.set(entry.channel, frameIndex);
            }
          })
          .catch(() => {
            // A failed readback (plan mid-swap, device recovering) keeps the previous
            // value — the §V144 contract: stale beats stalled, and the next sample retries.
          })
          .finally(() => {
            inFlight.delete(entry.channel);
          });
        settling.push(chain);
      }
      // The whole chain, guard-clear included — so an awaiting caller (B161) sees a
      // settled state, not just a landed readback.
      return Promise.all(settling).then(() => undefined);
    },
    resultAges(frameIndex) {
      const ages: AnalyzeAge[] = [];
      for (const entry of tracked) {
        const stamped = sourceFrame.get(entry.channel);
        if (stamped === undefined) continue;
        ages.push({ nodeId: entry.nodeId, ageFrames: frameIndex - stamped });
      }
      return ages;
    },
    resolver: (channel) => latest.get(channel),
  };
}
