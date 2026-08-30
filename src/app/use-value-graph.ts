import { useCallback, useMemo, useRef, useState } from "react";
import { createValueGraphSession } from "@domain/channels/value-graph.ts";
import type { ChannelResolver } from "@domain/parameters/resolve.ts";
import type { RuntimeDiagnostic } from "@domain/types/diagnostics.ts";
import type { FrameInputs } from "@domain/types/backend.ts";
import type { FrameEvaluationInput } from "@domain/types/frame.ts";
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

export function useValueGraph(runtime: AppRuntime): ValueGraphBinding {
  // The store is the authority on the graph and is read AT evaluation time rather than
  // captured: the session must never be rebuilt on a document edit, because rebuilding it
  // would clear every stateful stage — an edit anywhere would reset every Lag in the
  // project, which is §V155's divergence with a different cause.
  const runtimeRef = useRef(runtime);
  runtimeRef.current = runtime;

  const session = useMemo(() => createValueGraphSession(runtime.registry), [runtime.registry]);

  const latest = useRef<ChannelResolver | null>(null);
  const [diagnostics, setDiagnostics] = useState<readonly RuntimeDiagnostic[]>(NO_DIAGNOSTICS);
  /** Signature of what is currently reported, so an unchanged condition costs no render. */
  const reported = useRef("");

  const evaluate = useCallback(
    (inputs: FrameInputs) => {
      const result = session.evaluate(runtimeRef.current.bus.store.getGraph(), inputs.frame, {
        // §V182: the SAME pointer the shaders read. A second DOM listener would drift by a
        // frame and the CPU and GPU halves of one graph would disagree about the cursor.
        pointer: inputs.pointer,
      });
      latest.current = result.resolver;

      const signature = result.diagnostics
        .map((diagnostic) => `${diagnostic.code}:${diagnostic.nodeId ?? ""}`)
        .sort()
        .join("|");
      if (signature === reported.current) return;
      reported.current = signature;
      setDiagnostics(result.diagnostics.length === 0 ? NO_DIAGNOSTICS : [...result.diagnostics]);
    },
    [session],
  );

  const reset = useCallback(() => {
    session.reset();
    // The channels go with the state. Keeping the last frame's numbers after a reset would
    // hand the first replayed frame a value from the history just thrown away.
    latest.current = null;
  }, [session]);

  /** Zero-frame answer for the structural compile, one walk per document revision. */
  const structural = useRef<{ revision: number; resolver: ChannelResolver } | null>(null);

  const resolver = useCallback<ChannelResolver>(
    (channel, context) => {
      if (context.frame !== undefined) return latest.current?.(channel, context);

      // No frame: this is the structural compile (§V44's deterministic zero frame). A
      // THROWAWAY session, never the live one — resolving here against live state would
      // advance every stateful stage once per compile, so dragging a node would move a Lag.
      const graph = runtimeRef.current.bus.store.getGraph();
      const cached = structural.current;
      if (cached === null || cached.revision !== graph.revision) {
        const once = createValueGraphSession(runtimeRef.current.registry);
        const result = once.evaluate(graph, ZERO_FRAME, { pointer: { x: 0, y: 0, buttons: 0 } });
        structural.current = { revision: graph.revision, resolver: result.resolver };
        return result.resolver(channel, context);
      }
      return cached.resolver(channel, context);
    },
    [],
  );

  return { resolver, evaluate, reset, diagnostics };
}
