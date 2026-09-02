import type { NodeId } from "../../domain/types/ids.ts";
import type { FrameEvaluationInput } from "../../domain/types/frame.ts";
import type { ChannelResolver } from "../../domain/parameters/resolve.ts";
import { absTimeSecondsOf } from "../../domain/types/frame.ts";

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
  /**
   * §T384's FRESHNESS POLICY, as a value rather than a hidden constant (§T965).
   *
   * The shortest gap, in TIMELINE seconds, between two runs of this node. `0` or absent
   * is no cap and reproduces the behaviour every entry had before this existed. It only
   * ever makes a node run LESS: a run is never started while one is in flight, so the
   * cap is a floor on the gap and never a promise of a rate.
   *
   * It is deliberately confined to the LIVE fill policy. `settle` — the non-realtime one —
   * ignores it, because §V586 makes a take's picture independent of when results happened
   * to arrive, and a cadence knob that thinned an export would put a live-playback comfort
   * setting inside the reproducibility path.
   */
  readonly minIntervalSeconds?: number;
  /**
   * Compute ONE result, then stop (§T384).
   *
   * Not "publish nothing": the entry still produces its first result, and from then on it
   * keeps serving that one while its reported age grows — which is the honest reading of a
   * frozen depth map and is why age is a number rather than a boolean. Unlike the rate
   * limit this DOES bind `settle`, because a take of a document whose author froze the map
   * must show the frozen map; an export that quietly re-ran it every frame would be
   * rendering a different document from the one on screen.
   */
  readonly hold?: boolean;
  /**
   * The node's NAME, under which this entry publishes its timing channels (§T976).
   *
   * The user-facing identity, not the id, for §V129's reason and `AnalyzeEntry.channel`'s:
   * `depth1:ready` is a readable driven-parameter reference and a uuid is not. Absent for
   * an unnamed node, which then publishes nothing rather than publishing under a name
   * nobody can type.
   */
  readonly channel?: string;
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
   *
   * `absSeconds` is that frame's ABSOLUTE time (§T461/§T495) — the free-running clock that
   * never resets at a timeline lap — and it is what BOTH the rate limit and every timing
   * channel are measured against. Never a wall reading (§V44): the offline transport
   * publishes an absolute clock too, so a take measures the same numbers twice. The
   * timeline clock would have been wrong for a different reason: it WRAPS, so a looping
   * document would report an inference rate that collapsed once a lap.
   *
   * Absent, no entry is rate limited and the rate channels report nothing measured.
   */
  sample(frameIndex: number, absSeconds?: number): void;
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
  /**
   * Why the last run for this node failed, or `undefined` if the last one succeeded
   * (B156).
   *
   * `runOnce` keeps the previous value on a failure — §V144's "stale beats stalled" — and
   * that is right for the PICTURE and wrong for the REPORT: a model that was downloaded
   * and then cannot run leaves a node serving its identity fallback forever, which is
   * pixel-for-pixel the state of a machine with no model at all. The seam is the only
   * place that sees the reason, so it keeps it; the surface decides whether it is worth
   * saying (§V469 — not silent, not fatal).
   */
  lastFailure(nodeId: NodeId): string | undefined;
  /**
   * ═══════════════════════════════════════════════════════════════════════════════════
   * §T976 — THE TIMING, PUBLISHED AS ORDINARY CHANNELS
   * ═══════════════════════════════════════════════════════════════════════════════════
   *
   * The owner asked for "a secondary output like a CHOP readout that tells us frame rate,
   * realtime factor, delay" and, in the same breath, for "some sort of smoothing or
   * lerping to compensate in case the framerate is low". Those are ONE feature: **a fixed
   * lerp is a constant pretending to know the lag.** A lerp driven by the MEASURED lag is
   * right at 2 fps and at 20, so publishing these numbers is what makes the smoothing
   * honest instead of guessed — and the smoother is then an ordinary Lag with an ordinary
   * driven parameter, not a hidden constant inside this node.
   *
   * No new mechanism (§T942, §T960): this is `analyze`'s seam, answering a node NAME.
   * `analyze` publishes a bare name; an inference node publishes `<name>:<field>`, because
   * it has more than one number to say and `:` is already the addressing separator.
   *
   *   `depth1:ready`           1 once a result HAS LANDED, else 0.
   *   `depth1:lagFrames`       frames between the frame the published result was computed
   *                            from and the frame being rendered.
   *   `depth1:delaySeconds`    the same distance on the absolute clock — what a lerp wants.
   *   `depth1:fps`             completed inferences per second.
   *   `depth1:realtimeFactor`  that rate over the DISPLAY rate. 1 is keeping up; 0.05 is
   *                            one inference every twenty frames.
   *
   * ⚠ `ready` IS THE LOAD-BEARING ONE and its definition is exact: **the first successful
   * RESULT, never "the model downloaded"**. A model present but yet to produce a frame
   * reads NOT ready, or a switch driven by it flips to a node still publishing its neutral
   * fallback — which is the §B156 pair (downloaded-and-computing vs downloaded-and-broken)
   * arriving in a consumer that cannot tell them apart either.
   *
   * ⚠ AND THE ONE PLACE §T715's "no result reports NO age" CANNOT BE HONOURED AS ABSENCE.
   * A channel that answers `undefined` is not a channel that says "unknown", it is an
   * UNKNOWN CHANNEL, and the expression referencing it fails. So before the first result
   * the timing fields read 0 — and `ready` reads 0 beside them, which carries exactly the
   * information the absence carried. Reading a lag without reading `ready` is the mistake
   * that makes; the pairing is the contract, and it is why `ready` exists as its own field
   * rather than being inferred from a lag of zero.
   */
  readonly resolver: ChannelResolver;
  /**
   * §T978 — FORGET THIS NODE'S RESULT, so `ready` goes false and the identity fallback is
   * published again. The recovery gesture's half of the state that lives in here.
   *
   * Deliberately NOT a `track([])`: that would drop every node. This is one node, because
   * the pulse is on one node.
   */
  reset(nodeId: NodeId): void;
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

/** The numeric fields, named once so the no-result answer and the switch cannot diverge. */
const TIMING_FIELDS: ReadonlySet<string> = new Set([
  "lagFrames",
  "delaySeconds",
  "fps",
  "realtimeFactor",
]);

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
  /** nodeId -> why the most recent run failed. Cleared by the next success (B156). */
  const failure = new Map<NodeId, string>();
  /** nodeId -> the absolute time the last live run was ISSUED at (`minIntervalSeconds`). */
  const issuedAt = new Map<NodeId, number>();
  /** nodeId -> the absolute time the CURRENT result completed (§T976's rate and delay). */
  const resultAt = new Map<NodeId, number>();
  /** nodeId -> seconds between the last two completed results. 0 until there are two. */
  const resultInterval = new Map<NodeId, number>();
  /**
   * The clock, as the CALLER last reported it (§V44 — this module reads none).
   *
   * `settle` takes no seconds: `onFrameRendered` hands it a frame INDEX and nothing else.
   * Both offline drivers run the frame observer, and therefore `sample`, before rendering
   * the frame they then settle, so the value standing here is that frame's. Documented
   * rather than assumed, because if that order ever inverts the delay channels go one
   * frame stale and nothing else changes.
   */
  let clockSeconds: number | undefined;
  /** Seconds per DISPLAYED frame, from consecutive samples. 0 until two have arrived. */
  let displayInterval = 0;

  const forget = (nodeId: NodeId): void => {
    latest.delete(nodeId);
    sourceFrame.delete(nodeId);
    generation.delete(nodeId);
    failure.delete(nodeId);
    issuedAt.delete(nodeId);
    resultAt.delete(nodeId);
    resultInterval.delete(nodeId);
  };

  /**
   * Whether the LIVE policy is allowed to start a run for this entry right now.
   *
   * Two refusals, and they are different in kind. `hold` is a policy about the RESULT —
   * one has landed and the author asked for that one — so it also binds `settle`. The rate
   * limit is a policy about the MACHINE, so it does not.
   */
  const heldBack = (entry: InferenceEntry): boolean => entry.hold === true && latest.has(entry.nodeId);

  const rateLimited = (entry: InferenceEntry, absSeconds: number | undefined): boolean => {
    const gap = entry.minIntervalSeconds ?? 0;
    if (gap <= 0 || absSeconds === undefined) return false;
    const last = issuedAt.get(entry.nodeId);
    // A clock that jumped BACKWARDS must not lock the node out until it catches up again,
    // so anything but "later by less than the gap" is allowed. The absolute clock never
    // steps back — but `absTimeSecondsOf` falls back to the TIMELINE one on a transport
    // that publishes no absolute reading, and that one wraps at every lap, so the guard
    // earns its place rather than being defensive about an impossibility.
    return last !== undefined && absSeconds >= last && absSeconds - last < gap;
  };

  /**
   * §T976's five fields, per entry. Zero everywhere until a result lands — see the
   * interface note on why absence is not expressible here and `ready` carries it instead.
   */
  const timingOf = (entry: InferenceEntry, frame: FrameEvaluationInput, field: string): number | undefined => {
    const { nodeId } = entry;
    if (field === "ready") return latest.has(nodeId) ? 1 : 0;
    const stamped = sourceFrame.get(nodeId);
    // No result yet: every timing field is 0, and `ready` beside it is 0. An UNKNOWN field
    // still answers `undefined` — the two must not collapse, or `depth1:lagFrmes` becomes
    // a silent zero instead of an unknown channel.
    if (stamped === undefined) return TIMING_FIELDS.has(field) ? 0 : undefined;
    switch (field) {
      case "lagFrames":
        return Math.max(0, frame.frameIndex - stamped);
      case "delaySeconds": {
        const at = resultAt.get(nodeId);
        if (at === undefined) return 0;
        return Math.max(0, absTimeSecondsOf(frame) - at);
      }
      case "fps": {
        const interval = resultInterval.get(nodeId) ?? 0;
        return interval > 0 ? 1 / interval : 0;
      }
      case "realtimeFactor": {
        const interval = resultInterval.get(nodeId) ?? 0;
        // One measurement over another: inference rate / display rate. Both come off the
        // same clock, so a slow machine moves the numerator and the denominator together
        // and the ratio still says "one inference every N frames" truthfully.
        if (interval <= 0 || displayInterval <= 0) return 0;
        return displayInterval / interval;
      }
      default:
        // NOT ours. An unrecognised field must fall through to the next resolver rather
        // than answer 0, or a typo becomes a silent zero instead of an unknown channel.
        return undefined;
    }
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
      failure.delete(nodeId);
      // §T976: the RATE is the gap between two completed results, measured on the clock
      // the caller last reported. A rate derived from one result is not a rate, so the
      // interval stays 0 until there are two and `fps` says 0 rather than infinity.
      if (clockSeconds !== undefined) {
        const previous = resultAt.get(nodeId);
        if (previous !== undefined && clockSeconds > previous) {
          resultInterval.set(nodeId, clockSeconds - previous);
        }
        resultAt.set(nodeId, clockSeconds);
      }
    } catch (error) {
      // A failed read (plan mid-swap, device recovering) or a failed run (model not
      // acquired, backend refused) keeps the previous value — §V144's "stale beats
      // stalled" — and the next sample retries.
      //
      // B156: it also RECORDS WHY, which it used not to. Swallowing the reason made a
      // model that downloaded and then could not run indistinguishable from a machine
      // with no model — both serve mid-grey, and neither said anything. The acquisition
      // path cannot raise this one: acquisition succeeded. Only the run knows.
      failure.set(nodeId, error instanceof Error ? error.message : String(error));
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

    sample(frameIndex, absSeconds) {
      // The DISPLAY rate, from consecutive samples on the same clock the results use, so
      // `realtimeFactor` is one measurement divided by another rather than a measurement
      // divided by a setting. A backwards step (a loop on a transport with no absolute
      // clock) is ignored rather than producing a negative interval.
      if (absSeconds !== undefined) {
        if (clockSeconds !== undefined && absSeconds > clockSeconds) {
          displayInterval = absSeconds - clockSeconds;
        }
        clockSeconds = absSeconds;
      }
      for (const entry of tracked) {
        if (inFlight.has(entry.nodeId)) continue;
        if (heldBack(entry) || rateLimited(entry, absSeconds)) continue;
        if (absSeconds !== undefined) issuedAt.set(entry.nodeId, absSeconds);
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
        // A HELD entry that already has its result keeps it — the take must render the
        // document the author froze. It still runs ONCE if nothing has landed yet, so a
        // held node in an export is stale by choice rather than blank by accident.
        if (heldBack(entry)) continue;
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

    lastFailure(nodeId) {
      return failure.get(nodeId);
    },

    /**
     * §T976. Answers ONLY `<trackedNodeName>:<knownField>` and `undefined` for everything
     * else, so it can sit in front of the other resolvers without shadowing them — the
     * property `app.tsx`'s merge note states and the reason `midi`/`osc` check their own
     * prefixes rather than assuming.
     */
    resolver: (channel, context) => {
      const split = channel.lastIndexOf(":");
      if (split <= 0) return undefined;
      const name = channel.slice(0, split);
      const field = channel.slice(split + 1);
      const entry = tracked.find((candidate) => candidate.channel === name);
      if (entry === undefined) return undefined;
      const { frame } = context;
      if (frame === undefined) return undefined;
      return timingOf(entry, frame, field);
    },

    reset(nodeId) {
      forget(nodeId);
    },
  };
}
