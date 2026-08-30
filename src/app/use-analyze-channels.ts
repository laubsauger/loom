import { useCallback, useEffect, useMemo, useRef } from "react";
import type { CompiledGraph } from "@compiler/index.ts";
import type { ChannelResolver } from "@domain/parameters/resolve.ts";
import type { FrameEvaluationInput } from "@domain/types/frame.ts";
import type { GraphDocument } from "@domain/types/graph.ts";
import type { NodeRegistryView } from "@nodes/registry/registry.ts";
import type { ShaderloomBackend } from "@runtime/backend/index.ts";
import { analyzeChannelEntries, createAnalyzeChannels } from "@runtime/execution/index.ts";
import type { AnalyzeEntry } from "@runtime/execution/index.ts";

/**
 * The CPU half of Analyze, constructed (T305, B25, §V144, §V205).
 *
 * ## What was wrong
 *
 * `createAnalyzeChannels` existed, was unit-tested, and had exactly one construction site
 * in the whole tree: its own GPU test. So an Analyze node in a running project published
 * no channel and the image→parameter loop was not closed in the product — the fourth
 * instance of "built, tested, never wired" (B12, T264 media, B23 render_preview, this).
 * The composition root is where a service like this becomes real, so it is constructed
 * here, and `composition-seams.test.tsx` (T306) now enumerates that fact rather than
 * trusting anyone to remember it.
 *
 * ## WHERE the sample runs, and why it is not the obvious place
 *
 * "Between frames" is not a figure of speech here, it is enforced. `backend.readBuffer`
 * calls `guard.assertOutsideFrame`, and the frame driver's `onFrame` seam runs INSIDE the
 * open frame — `backend.loop` invokes its callback through `runFrame`, which holds the
 * guard closed for the whole callback (§V8). Measured, not assumed:
 *
 *   readBuffer outside a frame                -> resolves
 *   readBuffer from inside the loop callback  -> FrameEncodingViolation
 *   readBuffer from a microtask queued there  -> resolves
 *
 * That middle line is why this is not simply a call in `onFrame`. `AnalyzeChannels.sample`
 * is fire-and-forget and swallows a failed read on purpose (§V144: stale beats stalled),
 * so sampling from inside the frame would produce a channel that silently never updates —
 * B25 all over again, one layer down, and invisible to every test that does not assert a
 * VALUE arrives.
 *
 * So the sample is queued as a microtask from the frame observer. vgpu's `frame()` and
 * `frameLoop()` invoke their callbacks synchronously and the guard's depth is restored in
 * a `finally`, so the microtask drains after the frame is closed and submitted. No clock
 * is read (§V44) and no timer is added: the cadence is the frame loop's own.
 *
 * ## Latency, restated because it is a contract and not an accident
 *
 * §V144: the value visible while frame N renders is the reduction of the last COMPLETED
 * frame. One frame late is correct. A stall is not, and there is no `await` on this path
 * anywhere (§V184).
 */

export interface AnalyzeChannelBinding {
  /**
   * Merged in FRONT of `graphChannelResolver` (first non-undefined wins).
   *
   * Stable identity for the life of the hook, so putting it in front of the graph
   * resolver does not re-key the compile memo every render.
   */
  readonly resolver: ChannelResolver;
  /** The frame-loop observer seam. Queues the between-frames sample. Stable. */
  readonly observe: (frame: FrameEvaluationInput) => void;
  /** Re-derives the tracked set. Call after each compile. Stable. */
  readonly track: (graph: GraphDocument, compiled: CompiledGraph | null) => void;
}

/**
 * Entries whose reduction buffer the CURRENT PLAN actually allocates.
 *
 * An Analyze node with no input compiles to no passes and declares no scratch buffer, so
 * its resource does not exist. Tracking it anyway would make `readBuffer` report an
 * `unknownResource` error into the diagnostics hub on every frame — a wall of noise for a
 * node the user has simply not connected yet. The budget in the performance panel already
 * shows that node's bytes as "unknown" rather than zero (T278), so the two surfaces tell
 * the same story: declared, not yet real.
 */
function trackableEntries(
  graph: GraphDocument,
  registry: NodeRegistryView,
  compiled: CompiledGraph | null,
): readonly AnalyzeEntry[] {
  const entries = analyzeChannelEntries(graph, registry);
  if (compiled === null) return [];
  const allocated = new Set(compiled.resources.map((resource) => resource.id));
  return entries.filter((entry) => allocated.has(entry.resourceId));
}

export function useAnalyzeChannels(
  backend: ShaderloomBackend | null | undefined,
  registry: NodeRegistryView,
): AnalyzeChannelBinding {
  // Read through a ref: the channels object is built once and must survive the backend
  // being replaced by a device-loss rebuild (§V23) without losing its latest values.
  const backendRef = useRef(backend);
  backendRef.current = backend;

  const channels = useMemo(
    () =>
      createAnalyzeChannels({
        readBuffer: (resourceId) => {
          const live = backendRef.current;
          if (live === null || live === undefined) {
            // No device. A rejection is the honest answer and `sample` already treats one
            // as "keep the previous value" — which is exactly right while the GPU is gone.
            return Promise.reject(new Error("No backend is attached; nothing to read."));
          }
          return live.readBuffer(resourceId);
        },
      }),
    [],
  );

  const registryRef = useRef(registry);
  registryRef.current = registry;

  const track = useCallback(
    (graph: GraphDocument, compiled: CompiledGraph | null) => {
      channels.track(trackableEntries(graph, registryRef.current, compiled));
    },
    [channels],
  );

  const observe = useCallback(() => {
    // See the module note: this runs inside the open frame, so the read is deferred to a
    // microtask that drains after it closes. Not a stylistic choice — a direct call here
    // fails the frame guard and is swallowed.
    queueMicrotask(() => channels.sample());
  }, [channels]);

  const resolver = useCallback<ChannelResolver>(
    (channel, context) => channels.resolver(channel, context),
    [channels],
  );

  useEffect(() => () => channels.track([]), [channels]);

  return { resolver, observe, track };
}
