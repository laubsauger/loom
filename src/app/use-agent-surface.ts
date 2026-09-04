import { useEffect, useMemo, useRef } from "react";
import { createAgentToolSurface } from "@agent/index.ts";
import type {
  AgentPorts,
  AgentRuntimeMetrics,
  AgentToolSurface,
  CapabilityGrantRoute,
} from "@agent/index.ts";
import { frameClockVerdict } from "@runtime/telemetry/frame-clock.ts";
import { attachStateSources } from "@domain/commands/index.ts";
import type { Actor, CapabilityClass } from "@domain/types/commands.ts";
import type { RuntimeDiagnostic } from "@domain/types/diagnostics.ts";
import type { NodeId, Revision } from "@domain/types/ids.ts";
import type { AppRuntime } from "./app-runtime.ts";

/**
 * The agent tool surface, constructed (B12, T220, §V39, §V42).
 *
 * ## What was wrong
 *
 * `createAgentToolSurface` had no caller anywhere in `src/app/**`. The surface was built,
 * tested and absent from the product: an agent could not read the graph, propose a patch
 * or be seen doing either, and the only visible symptom was an acceptance test whose
 * docblock explained the gap. This hook is the seam that was missing.
 *
 * ## Sources, not ports
 *
 * §V39 says an adapter is transport plus schema. Selection, diagnostics, runtime metrics
 * and the project envelope are state the graph document does not hold, and the surface
 * used to take them as INJECTED PORTS — references to this tree's own objects, which
 * works in-tab and nowhere else. They are bus QUERIES now (T175), so the composition root
 * ATTACHES them: `attachStateSources` publishes `selection.get`, `diagnostics.get`,
 * `runtime.metrics` and `project.get`, and an out-of-process MCP server reads exactly
 * what an in-tab call reads.
 *
 * Registration is honest by construction — a query exists only once a source is attached,
 * so `hasQuery("selection.get")` is the truthful answer to "can anything read the
 * selection right now", which is what the tool's availability check asks.
 *
 * ## Live reads through refs
 *
 * The sources close over refs rather than over render values. A source that captured this
 * render's `selection` would report a stale answer for the rest of the session, and
 * re-attaching on every render would re-register nothing (the bus has no unregister) while
 * churning the surface. One surface per runtime; one set of sources; both read live.
 *
 * ## Transports are not built here (T397)
 *
 * This hook used to call `registerWebMcp` and discard what it returned, which is how the
 * app came to publish twenty-eight document-editing tools while being unable to tell
 * anyone whether it had (§V338). Publication moved to `useMcpTransports`, which registers
 * AND records the result somewhere a human can read it. This hook stays transport-free,
 * which is also what §V192 asks of everything around the surface.
 */

/** The agent this build talks to. §V30: an agent is an actor, never anonymous. */
export const AGENT_ACTOR: Actor = { kind: "agent", id: "assistant", label: "Assistant" };

/**
 * WHAT A BROWSER TAB CAN ACTUALLY GRANT — which today is nothing (T1097, §V38).
 *
 * The finding, live: `render_preview` was published to this page's WebMCP and bridge
 * transports while the `export` grant it checks was issuable ONLY by `--grant-export` on
 * the stdio server's own invocation. There is no in-page grant UI, so no tab could ever
 * hold it. A check with no grant path is not a permission, it is a refusal wearing one —
 * §V38's "permanent denial in a costume" — and the refusal read "ask the user, through the
 * app's confirm flow", sending the caller at a wall that cannot move.
 *
 * Declaring it is the floor, not the fix: the honest resolutions are to BUILD the in-page
 * grant (a page asking to render and read back pixels is a real capability decision and
 * needs a surface that makes the ask legible, not a yes button) or to STOP PUBLISHING these
 * tools to a tab. Until one of those is decided, the caller is told the truth instead of
 * being told to wait for a prompt nobody sends.
 *
 * Four tools sit behind these two classes: `render_preview`, `describe_output`,
 * `read_points` (export) and `save_project` (localFile).
 */
export const PAGE_GRANT_ROUTES = {
  export: {
    obtainable: false,
    guidance:
      "No surface in this browser tab can issue the export grant: it exists only on the out-of-process Loom MCP server, whose own invocation carried `--grant-export`, and it belongs to that server's headless document — attaching this tab to the bridge does not carry it over. For pixels from THIS document, use the app's own export and record controls, which the person at the keyboard drives.",
  },
  localFile: {
    obtainable: false,
    guidance:
      "No surface in this browser tab can issue the localFile grant. The user saves through the app's own Save control, which opens the browser's file picker — the consent gesture a tool call cannot stand in for.",
  },
} satisfies Partial<Record<CapabilityClass, CapabilityGrantRoute>>;

export interface AgentSurfaceState {
  readonly selection: readonly NodeId[];
  /** T304: whether the transport is playing — the frame-clock verdict's first fact. */
  readonly playing: boolean;
  /** Everything the problems surface shows: compile, runtime, autosave, project (§I.diag). */
  readonly diagnostics: readonly RuntimeDiagnostic[];
  /**
   * The document revision the COMPILE-derived diagnostics above were produced from (T596).
   *
   * Not `store.getRevision()`, and the difference is the whole point: the store's revision
   * is what the document is at NOW, so stamping the answer with it would make every list
   * look current — including one taken before the compile that would have found the
   * problem. This is the revision the list actually saw.
   */
  readonly diagnosticsRevision: Revision;
}

export function useAgentSurface(
  runtime: AppRuntime,
  state: AgentSurfaceState,
  ports: AgentPorts = {},
): AgentToolSurface {
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    attachStateSources(runtime.bus, {
      selection: () => ({ nodeIds: [...stateRef.current.selection], edgeIds: [] }),
      diagnostics: () => ({
        diagnostics: stateRef.current.diagnostics,
        revision: stateRef.current.diagnosticsRevision,
      }),
      metrics: (): AgentRuntimeMetrics => {
        // §V16: sampled from the hub on demand. Nothing is pushed, and no per-frame data
        // enters the document store on the way.
        const snapshot = runtime.telemetry.snapshot();
        /*
         * T304: the frame-clock verdict, judged in ONE place (frame-clock.ts) and fed
         * this surface's local facts. The agent is the MORE important reader: a
         * CDP-driven session is hidden by default, and an agent reading zeros here has
         * repeatedly concluded the tool was broken (§V434 x9, §V560).
         */
        const frameClock = frameClockVerdict({
          playing: stateRef.current.playing,
          hidden: typeof document !== "undefined" && document.visibilityState === "hidden",
          settings: runtime.settings,
          recentFrameTimes: runtime.telemetry.recentFrameTimes(),
          now: typeof performance === "undefined" ? Date.now() : performance.now(),
        });
        return {
          frameClock,
          timingAvailable: snapshot.timingAvailable,
          framesRendered: snapshot.framesRendered,
          lastFrameIndex: snapshot.lastFrameIndex,
          frameGpuMs: snapshot.frame.gpuMs,
          passCount: snapshot.plan?.passes.length ?? 0,
          nodeCount: snapshot.plan?.nodeCount ?? 0,
          prunedCount: snapshot.plan?.prunedCount ?? 0,
          estimatedResourceBytes: snapshot.plan?.estimatedResourceBytes ?? null,
          memoryBudgetBytes: snapshot.plan?.memoryBudgetBytes ?? null,
          overBudget: snapshot.overBudget,
        };
      },
      project: () => runtime.project,
    });
  }, [runtime]);

  const surface = useMemo(
    () =>
      createAgentToolSurface({
        bus: runtime.bus,
        actor: AGENT_ACTOR,
        projectId: runtime.invocation.projectId,
        ports,
        // T1097: what this surface can and cannot ever be granted, as data. See above.
        grantRoutes: PAGE_GRANT_ROUTES,
        // No `requireApproval` here on purpose. §V42 requires agent activity to be
        // VISIBLE and revertible, which the presence pane provides; holding every edit
        // for a click is a product policy nobody has asked for, and the surface already
        // supports it the day someone does.
      }),
    [runtime, ports],
  );

  return surface;
}
