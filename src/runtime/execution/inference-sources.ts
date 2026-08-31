import type { NodeId } from "../../domain/types/ids.ts";
import type { FrameEvaluationInput } from "../../domain/types/frame.ts";

/**
 * The CPU half of an inference node — the async seam the whole ML program rests on
 * (T715/T384, §V585, §V586, §V329).
 *
 * ## It is not a new shape. It is two existing shapes spliced.
 *
 * `compileGraph` is SYNCHRONOUS and PURE (§V585), so a node's `compile()` cannot await,
 * allocate, or read ambient state. Everything asynchronous therefore lives out here, and
 * the two halves it needs BOTH already ship:
 *
 *   IN   a compute dispatch resamples the source into an ordinary scratch BUFFER, read
 *        by `backend.readBuffer` between frames — `analyze`'s exact route (§V48), just
 *        bigger. Analyze writes 16 bytes; this writes an image. No new GPU→CPU route.
 *   OUT  the result bytes go back through `registerMediaSource`, filling the `external`
 *        scratch texture the node declares — `webcam`/`movieFileIn`'s exact route
 *        (§V135/§V136). No new resource kind.
 *
 * So this module owns only the middle: what the node's output MEANS between inferences.
 *
 * ## Why analyze's contract cannot simply be inherited
 *
 * §V144 gave Analyze "one frame late, never a stall", and that is right for a readback
 * whose latency is BOUNDED — the buffer holds frame N-1's reduction whenever the copy
 * lands. Inference is not bounded. A 100 ms depth pass at 60fps is six frames stale, and
 * the number is input-dependent, so "one frame late" as an unstated assumption is false
 * the moment a model is slower than a frame. Three things follow, and each is a decision
 * rather than a detail:
 *
 * 1. AGE IS A NUMBER, NOT A CONSTANT. Published per node in FRAMES — never milliseconds,
 *    which would be a §V44 wall-clock read. `resultAges` is the same shape `AnalyzeAge`
 *    uses so the node info popup reads it through the channel that already exists (§V85).
 *
 * 2. THERE IS A REAL NEVER-YET STATE. A webcam's "no frame" resolves in about one frame;
 *    a model may have no result for seconds, or forever if its download failed. So a
 *    tracked entry carries an IDENTITY FALLBACK and `currentFrame` serves it until the
 *    first result lands. This is the whole of the owner's constraint: an unavailable
 *    accelerator degrades the RATE, never the CONTRACT — the node always exists, always
 *    publishes its declared output type, and a document using it loads and renders on a
 *    machine that cannot run it. Depth's identity is mid-grey, which `displace` already
 *    defines as "no displacement" (`filters.ts:173`), so the fallback composes to a
 *    no-op rather than to a black hole in the picture.
 *
 * 3. THE FILL POLICY BRANCHES ON `frame.mode`, AND THE PREDICATE IS `!== "realtime"`.
 *    §V586 made `mode` the reproducibility seam and nothing has branched on it until now.
 *    The branch is deliberately phrased as "is this a real-time presentation?" rather
 *    than "is this offline?" because `mode` is THREE-valued: the headless harness runs
 *    `fixed-step` and the cook oracle runs `offline`. Writing `mode === "offline"` would
 *    leave every Dawn gate on the stale path — plausible pixels, silently inert input,
 *    which is exactly the reader-that-cannot-see family (T630/T633/T650/T655/T661) this
 *    seam must not join. Phrasing it this way also means a mode added later BLOCKS by
 *    default, which is the safe direction to be wrong in.
 *
 * Both offline drivers already await per frame, so blocking costs nothing structurally.
 */

/** How stale one inference node's published result is, right now (§V329). */
export interface InferenceAge {
  readonly nodeId: NodeId;
  /**
   * Frames between the frame whose input produced this result and the frame being asked
   * about. `0` is a result computed from the frame being rendered — what the blocking
   * path guarantees. Larger is a live result still catching up, and it is exactly the
   * number §V329 says must not be invisible.
   */
  readonly ageFrames: number;
}

/** One inference node the current plan actually allocates resources for. */
export interface InferenceEntry {
  readonly nodeId: NodeId;
  /** The scratch buffer the GPU half wrote this frame's preprocessed input into. */
  readonly inputResourceId: string;
  /** The media-registry key the result texture uploads from. */
  readonly sourceId: string;
  /**
   * Served until the first result lands, and after a permanent failure. Never empty:
   * a node with no identity value cannot honour the contract that it always publishes.
   */
  readonly fallback: Uint8Array;
}

/** What a node's model does. Injected, so a pseudo-inference and a real model both plug in. */
export type InferenceRunner = (
  nodeId: NodeId,
  input: ArrayBuffer,
) => Promise<Uint8Array>;

/** One upload the backend's media registry can consume (`MediaSource`'s shape). */
export interface InferenceFrame {
  readonly frameId: number;
  readonly bytes: Uint8Array;
}

export interface InferenceSources {
  /** Replaces the tracked set — called after each successful compile. */
  track(entries: ReadonlyArray<InferenceEntry>): void;
  /**
   * LIVE fill policy. Fire-and-forget: issues a run for any entry not already in flight
   * and returns immediately. Never awaited from inside a frame (§V184 — a stall is
   * invisible in a test and fatal in a 60Hz loop).
   *
   * `frameIndex` is the frame that just closed, whose input the buffer now holds. It is
   * passed in rather than counted here because §V44 puts the clock in the caller.
   */
  sample(frameIndex: number): void;
  /**
   * NON-REALTIME fill policy. Resolves once every tracked entry holds a result computed
   * from THIS frame's input, so the picture a take renders does not depend on when a
   * result happened to arrive. A run that rejects leaves the previous value standing and
   * does not hang the range — a take that stalls forever is worse than one that is stale
   * and says so.
   */
  settle(frameIndex: number): Promise<void>;
  /**
   * The per-node upload. Returns the identity fallback until a first result lands, so a
   * machine with no accelerator renders the document rather than refusing it.
   *
   * `frameId` changes only when the CONTENT changes (§V136: media uploads on frame-ready,
   * never per render frame), so a stale result re-uploads nothing.
   */
  currentFrame(nodeId: NodeId): InferenceFrame | undefined;
  /** Per-node staleness for the telemetry channel (§V85). Only nodes with a result appear. */
  resultAges(frameIndex: number): readonly InferenceAge[];
  /** Whether a node has ever produced a result. Drives the "model unavailable" surface. */
  ready(nodeId: NodeId): boolean;
}

/** §V586's seam. Phrased as "is this a real-time presentation?" — see the module note. */
export function blocksForResult(mode: FrameEvaluationInput["mode"]): boolean {
  return mode !== "realtime";
}

/**
 * The media-registry key an inference node's RESULT texture uploads from — the exact
 * parallel of `mediaSourceIdFor`, and deliberately a DIFFERENT prefix.
 *
 * The harness registers synthetic test cards for every `media:` source it finds in the
 * plan; an inference result must not collect one, because its stand-in is a RECORDED
 * inference rather than a test card. Keeping the namespaces apart is what lets both
 * feeds walk the same `plan.resources` list without either claiming the other's textures.
 */
export function inferenceSourceIdFor(nodeId: string): string {
  return `infer:${nodeId}`;
}

export function createInferenceSources(options: {
  readBuffer: (resourceId: string) => Promise<ArrayBuffer>;
  run: InferenceRunner;
}): InferenceSources {
  let tracked: ReadonlyArray<InferenceEntry> = [];
  /** nodeId -> the most recent completed result. */
  const latest = new Map<NodeId, Uint8Array>();
  /** nodeId -> the frame index whose input produced `latest` (§V329). */
  const sourceFrame = new Map<NodeId, number>();
  /** nodeId -> upload generation. Bumped only when the bytes change (§V136). */
  const generation = new Map<NodeId, number>();
  const inFlight = new Set<NodeId>();

  const forget = (nodeId: NodeId): void => {
    latest.delete(nodeId);
    sourceFrame.delete(nodeId);
    generation.delete(nodeId);
  };

  /**
   * One run, from the buffer read through to the stored result.
   *
   * Shared by both fill policies so they cannot drift: the ONLY difference between live
   * and offline is whether the caller awaits this, which is what keeps §V47's "same graph
   * and same compiler" literally true — both modes produce the identical plan.
   */
  const runOnce = async (entry: InferenceEntry, frameIndex: number): Promise<void> => {
    const { nodeId } = entry;
    inFlight.add(nodeId);
    try {
      const input = await options.readBuffer(entry.inputResourceId);
      const bytes = await options.run(nodeId, input);
      // Stamped with the frame the run was ISSUED for, not the frame it landed on: the
      // buffer held that frame's input whenever the model finishes with it.
      latest.set(nodeId, bytes);
      sourceFrame.set(nodeId, frameIndex);
      generation.set(nodeId, (generation.get(nodeId) ?? 0) + 1);
    } catch {
      // A failed read (plan mid-swap, device recovering) or a failed run (model not
      // acquired, backend refused) keeps the previous value — §V144's "stale beats
      // stalled" — and the next sample retries. The LOUD half of this is not here: an
      // unavailable model is a problems-pane diagnostic raised by the acquisition path,
      // because it is a persistent actionable state, where staleness changes every frame
      // and belongs on telemetry (T645's own ruling).
    } finally {
      inFlight.delete(nodeId);
    }
  };

  return {
    track(entries) {
      tracked = entries;
      const live = new Set(entries.map((entry) => entry.nodeId));
      // The age and the generation must be dropped with the value they describe: a
      // renamed or deleted node whose stamp survived would report an age for bytes
      // nobody can read.
      for (const known of [...latest.keys()]) {
        if (!live.has(known)) forget(known);
      }
    },

    sample(frameIndex) {
      for (const entry of tracked) {
        if (inFlight.has(entry.nodeId)) continue;
        void runOnce(entry, frameIndex);
      }
    },

    async settle(frameIndex) {
      // Deliberately NOT skipping entries already in flight: a run issued for an earlier
      // frame would satisfy the await while holding the wrong frame's input, which is the
      // recorder's own backlog lesson — a capture that completes late encodes the wrong
      // pixels. Awaiting the in-flight one first drains it, then this frame's run issues.
      for (const entry of tracked) {
        if (inFlight.has(entry.nodeId)) {
          // Yield until the outstanding run clears. It resolves or rejects; either way
          // `inFlight` is cleared in a `finally`, so this cannot spin forever.
          while (inFlight.has(entry.nodeId)) await Promise.resolve();
        }
        await runOnce(entry, frameIndex);
      }
    },

    currentFrame(nodeId) {
      const entry = tracked.find((candidate) => candidate.nodeId === nodeId);
      if (entry === undefined) return undefined;
      const bytes = latest.get(nodeId);
      if (bytes === undefined) {
        // NEVER-YET. The identity fallback, at generation 0 — the contract holds even
        // though no accelerator has produced anything, which is the entire point.
        return { frameId: 0, bytes: entry.fallback };
      }
      return { frameId: generation.get(nodeId) ?? 0, bytes };
    },

    resultAges(frameIndex) {
      const ages: InferenceAge[] = [];
      for (const entry of tracked) {
        const stamped = sourceFrame.get(entry.nodeId);
        // A node still waiting for its first result has no age — it has no value either,
        // and reporting 0 would say the opposite (`AnalyzeAge`'s own rule).
        if (stamped === undefined) continue;
        ages.push({ nodeId: entry.nodeId, ageFrames: frameIndex - stamped });
      }
      return ages;
    },

    ready(nodeId) {
      return latest.has(nodeId);
    },
  };
}
