import { useCallback, useMemo, useRef, useState } from "react";
import { createValueGraphSession } from "@domain/channels/value-graph.ts";
import type { ChannelResolver } from "@domain/parameters/resolve.ts";
import type { RuntimeDiagnostic } from "@domain/types/diagnostics.ts";
import type { FrameInputs } from "@domain/types/backend.ts";
import type { FrameEvaluationInput } from "@domain/types/frame.ts";
import type { NodeId } from "@domain/types/ids.ts";
import type { FlattenedGraph } from "@compiler/index.ts";
import type { AppRuntime } from "./app-runtime.ts";

/**
 * The value graph, constructed (B27, T305's sibling, §V179, §V155, §V181).
 *
 * ## What was wrong
 *
 * `createValueGraphSession` had no caller. T273-T277 shipped Mouse, Math, Limit, Slope,
 * Trigger, Lag and Filter with green unit tests and a working evaluator, and nothing in
 * the product ever evaluated one — so `mouse1 → lag1 → parameter` did nothing, and the
 * four nodes declaring `stateful.reset` had nothing able to reset them. Seventh instance
 * of §V220's shape; the enumeration guard (T306) is what named it.
 *
 * ## Once per frame, unconditionally — not on demand
 *
 * §V179 puts the evaluation before the GPU plan, and §V155 is why it cannot be lazy: a
 * stateful stage that is skipped does not go stale and self-correct, its trajectory
 * DIVERGES and nothing afterwards fixes it. So `evaluate` is called for every rendered
 * frame whether or not any parameter reads a channel. Resolving lazily on first read
 * would mean a Lag that nobody is currently listening to silently stops integrating, and
 * then produces a plausible wrong number the moment someone connects it.
 *
 * There is no GPU here at all — this is scalars on the CPU (§V183), so none of the frame
 * guard's constraints that shape the Analyze readback (§V223) apply. It runs directly in
 * the frame callback, before the animated-parameter push, which is where §V179 puts it.
 *
 * ## Where it sits among the resolvers
 *
 * Three answer `driven` channels and the order is the contract (first non-undefined wins):
 *
 *   1. Analyze  — a MEASUREMENT of the running program (T305).
 *   2. this     — the CPU signal chain, for the frame being rendered.
 *   3. `graphChannelResolver` — T238's single-channel shorthand.
 *
 * The third is now a BACKSTOP rather than a necessity, and saying so exactly matters: a
 * value node declaring `valueChannel` (the LFO/Constant/Timer trio) is a member of the
 * value graph too, so this resolver answers for it in both the framed and the zero-frame
 * case. The two agree by construction where they overlap — both call the node's own
 * `valueChannel` with the same values and the same frame — so the shorthand is kept as the
 * answer of last resort rather than removed, and it should never be the one that replies.
 *
 * ## The structural compile gets a THROWAWAY session
 *
 * A compile with no frame happens on every document edit, before anything has rendered.
 * Resolving it against the LIVE session would advance every stateful stage once per
 * compile — a Lag that jumps whenever you drag a node — so the zero-frame answer comes
 * from a session built for the question and discarded, keyed on the document revision so
 * it is one topological walk per edit rather than one per driven parameter.
 *
 * Without it the alternative is `undefined`, and then every structural compile of a
 * working `mouse1 → lag1 → param` graph reports "channel lag1 is not attached". A panel
 * that cries wolf on every compile is a panel people stop reading (§V91's spirit).
 *
 * ## Reset
 *
 * §V181 ties the stateful stages to §V170's seek rules — their state is not a function of
 * frame index, so a seek that replays must clear them first or the replayed frames carry a
 * trajectory belonging to a different history.
 */

export interface ValueGraphBinding {
  /**
   * Channels from the most recently evaluated frame. Stable identity, so it does not
   * re-key the compile memo every render.
   */
  readonly resolver: ChannelResolver;
  /** One frame. Call before the animated-parameter push, every rendered frame. */
  readonly evaluate: (inputs: FrameInputs) => void;
  /**
   * The channel BAGS from the most recently evaluated frame, keyed by FLAT NODE ID
   * (T344, T615).
   *
   * The plot in a node's body reads this, so it shows the same numbers the resolver
   * hands a driven parameter — §V275. Exposing the evaluated result rather than letting
   * a plot evaluate for itself is the whole point: a second evaluation would advance
   * every stateful stage twice per frame, and a Lag would run at double rate because
   * somebody was watching it.
   *
   * BY ID, not by name, since T615 — and the difference is not cosmetic. The value graph
   * now runs on the FLATTENED document, where B41's `withUniqueNames` makes an instance's
   * internal label depend on what else is in the document: add a root node called `wob`
   * and every instance's inner label shifts by one. A plot keyed on name would then draw
   * a different instance's trajectory with no error anywhere. Ids do not move.
   */
  readonly channels: () => ReadonlyMap<NodeId, Readonly<Record<string, number>>>;
  /**
   * T990 — the channel names one node is publishing right now, BY NAME.
   *
   * Enumeration, where `resolver` above can only probe: a bag is `valueEvaluate`'s return
   * value, so no definition declares its channel names and there is nothing static to
   * read. `op('lfo1').chan.<here>` in the inspector has no other honest source.
   *
   * By NAME rather than by id — the opposite of `channels` one field up, and for a reason
   * that does not contradict it. That field feeds a PLOT, which must follow one specific
   * instance's trajectory and therefore cannot use a name that B41 may renumber. This one
   * answers a REFERENCE, and `op()` addresses by name (§V129): it must resolve to whatever
   * that name resolves to, renumbering included, or the menu would offer a spelling the
   * reader then refuses.
   */
  readonly channelNames: (nodeName: string) => readonly string[];
  /** Clears every stateful stage (§V181, §V170). Transport reset and backward seek. */
  readonly reset: () => void;
  /**
   * Cycles and stage failures, for the problems panel.
   *
   * §V16 forbids per-frame React state, and this evaluates sixty times a second — so the
   * array's identity changes only when the SET OF CODES changes, not when a frame runs. A
   * cycle is a stable condition, so it re-renders once and then never again until it is
   * fixed; a clean graph never re-renders at all.
   *
   * It is surfaced rather than sampled because the alternative is silence: a value graph
   * with a cycle emits nothing, which looks exactly like a graph with nothing connected
   * (§V222). Command-time rejection (§V152) is the real gate; this is the backstop behind
   * it, and a backstop nobody can see is not one.
   */
  readonly diagnostics: readonly RuntimeDiagnostic[];
}

const NO_DIAGNOSTICS: readonly RuntimeDiagnostic[] = [];

/** §V44's deterministic zero frame: resolving outside a frame is t=0, never a wall clock. */
const ZERO_FRAME: FrameEvaluationInput = {
  timeSeconds: 0,
  deltaSeconds: 0,
  frameIndex: 0,
  mode: "offline",
  randomSeed: 0,
};

export function useValueGraph(runtime: AppRuntime, externalChannels?: ChannelResolver): ValueGraphBinding {
  // The store is the authority on the graph and is read AT evaluation time rather than
  // captured: the session must never be rebuilt on a document edit, because rebuilding it
  // would clear every stateful stage — an edit anywhere would reset every Lag in the
  // project, which is §V155's divergence with a different cause.
  const runtimeRef = useRef(runtime);
  runtimeRef.current = runtime;

  const session = useMemo(() => createValueGraphSession(runtime.registry), [runtime.registry]);

  const latest = useRef<ChannelResolver | null>(null);
  const latestBags = useRef<ReadonlyMap<NodeId, Readonly<Record<string, number>>>>(new Map());
  const latestByName = useRef<ReadonlyMap<string, Readonly<Record<string, number>>>>(new Map());
  const [diagnostics, setDiagnostics] = useState<readonly RuntimeDiagnostic[]>(NO_DIAGNOSTICS);
  /** Signature of what is currently reported, so an unchanged condition costs no render. */
  const reported = useRef("");

  const evaluate = useCallback(
    (inputs: FrameInputs) => {
      // T615: the FLATTENED document (§V437). Reading the raw one here is what made a
      // value node inside a component never evaluate at all — the flat ids `c1/wob` and
      // `c2/wob` are also what gives two instances of one Lag two trajectories (§V79),
      // since the session keys its state by node id.
      const result = session.evaluate(runtimeRef.current.flattened.current().graph, inputs.frame, {
        // §V182: the SAME pointer the shaders read. A second DOM listener would drift by a
        // frame and the CPU and GPU halves of one graph would disagree about the cursor.
        pointer: inputs.pointer,
        // T414: the same rule with sound — the ONE feature record the frame carries.
        ...(inputs.audio === undefined ? {} : { audio: inputs.audio }),
        /*
         * T654: the EXTERNAL channels a `channelIn` reads — the analyze resolver, whose
         * values are last-COMPLETED readbacks (§V144: one frame late by contract), so
         * there is no cycle here: the value graph consumes what the GPU finished, and
         * what it drives renders after.
         */
        ...(externalChannels === undefined
          ? {}
          : {
              channels: (name: string): number | undefined => {
                const value = externalChannels(name, { frame: inputs.frame } as never);
                return typeof value === "number" ? value : undefined;
              },
            }),
      });
      latest.current = result.resolver;
      latestBags.current = result.byId;
      latestByName.current = result.byName;

      const signature = result.diagnostics
        .map((diagnostic) => `${diagnostic.code}:${diagnostic.nodeId ?? ""}`)
        .sort()
        .join("|");
      if (signature === reported.current) return;
      reported.current = signature;
      setDiagnostics(result.diagnostics.length === 0 ? NO_DIAGNOSTICS : [...result.diagnostics]);
    },
    [externalChannels, session],
  );

  const channels = useCallback(() => latestBags.current, []);

  const reset = useCallback(() => {
    session.reset();
    latestBags.current = new Map();
    latestByName.current = new Map();
    // The channels go with the state. Keeping the last frame's numbers after a reset would
    // hand the first replayed frame a value from the history just thrown away.
    latest.current = null;
  }, [session]);

  /** Zero-frame answer for the structural compile, one walk per FLATTENING (T615). */
  const structural = useRef<{
    flattened: FlattenedGraph;
    resolver: ChannelResolver;
    byName: ReadonlyMap<string, Readonly<Record<string, number>>>;
  } | null>(null);

  const resolver = useCallback<ChannelResolver>(
    (channel, context) => {
      if (context.frame !== undefined) return latest.current?.(channel, context);

      // No frame: this is the structural compile (§V44's deterministic zero frame). A
      // THROWAWAY session, never the live one — resolving here against live state would
      // advance every stateful stage once per compile, so dragging a node would move a Lag.
      //
      // T615: the FLATTENED document again, and the cache is keyed on the flattening's
      // own identity rather than on `graph.revision`. A component-catalogue edit changes
      // what flattening produces while the host document's revision does not move
      // (§V210(c)) — a revision key would answer a zero-frame compile from the previous
      // internals and report a channel that has since been renamed as "not attached".
      const flattened = runtimeRef.current.flattened.current();
      const cached = structural.current;
      if (cached === null || cached.flattened !== flattened) {
        const once = createValueGraphSession(runtimeRef.current.registry);
        const result = once.evaluate(flattened.graph, ZERO_FRAME, { pointer: { x: 0, y: 0, buttons: 0 } });
        structural.current = { flattened, resolver: result.resolver, byName: result.byName };
        return result.resolver(channel, context);
      }
      return cached.resolver(channel, context);
    },
    [],
  );

  /**
   * The last evaluated frame's bag for one name, falling back to the STRUCTURAL walk the
   * resolver already keeps — so completion works before the transport has ever run, which
   * is exactly when someone is writing the expression.
   */
  const channelNames = useCallback((nodeName: string): readonly string[] => {
    const live = latestByName.current.get(nodeName);
    if (live !== undefined) return Object.keys(live);
    return Object.keys(structural.current?.byName.get(nodeName) ?? {});
  }, []);

  return { resolver, evaluate, channels, channelNames, reset, diagnostics };
}
