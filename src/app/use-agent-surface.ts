import { useEffect, useMemo, useRef } from "react";
import { createAgentToolSurface } from "@agent/index.ts";
import type { AgentRuntimeMetrics, AgentToolSurface } from "@agent/index.ts";
import { attachStateSources } from "@domain/commands/index.ts";
import type { Actor } from "@domain/types/commands.ts";
import type { RuntimeDiagnostic } from "@domain/types/diagnostics.ts";
import type { NodeId } from "@domain/types/ids.ts";
import { registerWebMcp } from "../mcp/webmcp.ts";
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
 */

/** The agent this build talks to. §V30: an agent is an actor, never anonymous. */
export const AGENT_ACTOR: Actor = { kind: "agent", id: "assistant", label: "Assistant" };

export interface AgentSurfaceState {
  readonly selection: readonly NodeId[];
  /** Everything the problems surface shows: compile, runtime, autosave, project (§I.diag). */
  readonly diagnostics: readonly RuntimeDiagnostic[];
}

export function useAgentSurface(runtime: AppRuntime, state: AgentSurfaceState): AgentToolSurface {
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    attachStateSources(runtime.bus, {
      selection: () => ({ nodeIds: [...stateRef.current.selection], edgeIds: [] }),
      diagnostics: () => stateRef.current.diagnostics,
      metrics: (): AgentRuntimeMetrics => {
        // §V16: sampled from the hub on demand. Nothing is pushed, and no per-frame data
        // enters the document store on the way.
        const snapshot = runtime.telemetry.snapshot();
        return {
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
        // No `requireApproval` here on purpose. §V42 requires agent activity to be
        // VISIBLE and revertible, which the presence pane provides; holding every edit
        // for a click is a product policy nobody has asked for, and the surface already
        // supports it the day someone does.
      }),
    [runtime],
  );

  // T290 (§V192): publish the SAME surface to the browser's model-context API, so an
  // in-tab agent drives the live canvas. Feature-detected; a browser without WebMCP
  // registers nothing and nothing changes. Mounted here, in the same seam that builds
  // the surface, because "built, tested, never wired" is B12's exact shape.
  useEffect(() => {
    registerWebMcp(surface);
  }, [surface]);

  return surface;
}
