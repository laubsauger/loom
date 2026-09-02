import type { RuntimeDiagnostic } from "../types/diagnostics.ts";
import type { EdgeId, NodeId, Revision } from "../types/ids.ts";
import type { ProjectDocument } from "../types/graph.ts";
import type { LoomBus } from "./bus.ts";
import { sharedForBus } from "./command-holder.ts";

/**
 * Bus queries for state the graph document does not hold (T175, §V39).
 *
 * Selection, diagnostics, runtime telemetry and the project envelope are all real state
 * an agent has to read before it can plan an edit, and `graph.get` answers none of them.
 * The agent surface worked around that with INJECTED PORTS: constructor arguments handed
 * in by whoever built the surface. That works in-tab and nowhere else — an out-of-process
 * MCP server holds a transport, not a reference to the running editor's React tree, so it
 * can only ever see what the bus publishes (§V39: an adapter is transport and schema, and
 * anything it cannot reach through the bus it cannot reach at all).
 *
 * ## Why the owner still supplies the data
 *
 * None of this is document state, so there is nothing for the domain layer to compute:
 * selection lives in the canvas, diagnostics in the compile pipeline, metrics in the
 * telemetry hub, the project envelope in the composition root. Each of those attaches a
 * READ FUNCTION here and the bus publishes it as a query. The domain owns the query
 * contract; the owner of the state owns the state. It is the same holder pattern
 * `project.save` and `graph.selectAll` already use, for the same reason: the bus has no
 * unregister, and React mounts more than once.
 *
 * ## Registration is honest
 *
 * A query is registered only once a source for it is attached. `hasQuery("selection.get")`
 * is therefore the truthful answer to "can anything read the selection right now", which
 * is what an adapter's availability check needs. The alternative — registering all four
 * up front and answering with an empty payload — publishes a tool that appears to work
 * and silently reports "nothing is selected" when the truth is "nobody is watching".
 */
declare module "../types/commands.ts" {
  interface QueryMap {
    /** Editor selection. Ids only: selection is view state, never document state. */
    "selection.get": { input: Record<string, never>; output: SelectionSnapshot };
    /** Compile and runtime diagnostics, newest last (§I.diag). */
    "diagnostics.get": { input: DiagnosticsQueryInput; output: DiagnosticsSnapshot };
    /** Frame and pass timing as last published by the runtime (§V16, §V85, §V86). */
    "runtime.metrics": { input: Record<string, never>; output: RuntimeMetricsSnapshot };
    /** The open project minus its graph — name, settings, assets (§V10). */
    "project.get": { input: Record<string, never>; output: ProjectSnapshot };
  }
}

export interface SelectionSnapshot {
  readonly nodeIds: readonly NodeId[];
  readonly edgeIds: readonly EdgeId[];
}

export interface DiagnosticsQueryInput {
  severity?: RuntimeDiagnostic["severity"];
  /** Keeps the newest N. Absent returns everything the source published. */
  limit?: number;
}

/**
 * What the diagnostics source publishes: the list, and WHEN it was derived (T596).
 *
 * `diagnostics` alone cannot answer "does this reflect my last edit?", and an agent that
 * cannot ask reads a clean list as approval. The measured behaviour is that everything a
 * command's own compile produces is visible on the very next read — 15 of 15 in the live
 * app, back to back, no delay — while the diagnostics only a RENDERED FRAME can produce
 * (`animation/structuralDrift`, `backend/*`) arrive when a frame arrives, which in a
 * hidden or occluded tab is up to a second later (§V434). Both are correct; neither is
 * distinguishable from a stale answer without a date on it. §V338: a report has to name
 * what it is a report OF.
 */
export interface DiagnosticsReport {
  readonly diagnostics: readonly RuntimeDiagnostic[];
  /** The document revision the compile-derived half was produced from. */
  readonly revision: Revision;
}

export interface DiagnosticsSnapshot {
  readonly diagnostics: readonly RuntimeDiagnostic[];
  /**
   * The document revision these were derived from (T596).
   *
   * Compare it with the revision your last command returned. EQUAL means the list has
   * seen your edit. BEHIND means it has not yet, and nothing in it is about your edit —
   * read again rather than concluding. Frame-produced diagnostics are a separate wait:
   * `runtime.metrics` reports whether frames are running at all.
   */
  readonly revision: Revision;
}

/**
 * The subset of the telemetry hub's snapshot that is useful to a caller which cannot
 * render — restated structurally so `src/domain` does not depend on `src/runtime`.
 *
 * §V86: a null millisecond figure means the device has no timestamp query, NOT zero cost.
 * The flag is carried separately so a consumer can tell "unavailable" from "not yet
 * measured" without inferring it from a null.
 */
export interface RuntimeMetricsSnapshot {
  readonly timingAvailable: boolean;
  readonly framesRendered: number;
  readonly lastFrameIndex: number | null;
  readonly frameGpuMs: number | null;
  readonly passCount: number;
  readonly nodeCount: number;
  readonly prunedCount: number;
  readonly estimatedResourceBytes: number | null;
  readonly memoryBudgetBytes: number | null;
  readonly overBudget: boolean;
}

export interface ProjectSnapshot {
  readonly projectId: string;
  /** Author-supplied project name. Untrusted document text (§V37). */
  readonly name: string;
  readonly schemaVersion: number;
  readonly settings: ProjectDocument["settings"];
  readonly assets: ProjectDocument["assets"];
  readonly createdAt: string;
  readonly updatedAt: string;
  /** The graph revision this snapshot was read at, so a caller can pair the two. */
  readonly revision: Revision;
}

/**
 * Read functions the owner of each piece of state attaches. Every one is pull-based and
 * synchronous: a query must never make the owner push, and per-frame data must never
 * enter the document store (§V16).
 */
export interface StateSources {
  selection?: () => SelectionSnapshot;
  /** T596: the list AND the revision it was derived from — see `DiagnosticsReport`. */
  diagnostics?: () => DiagnosticsReport;
  metrics?: () => RuntimeMetricsSnapshot;
  /** Everything about the open project except its graph, which the store already has. */
  project?: () => Omit<ProjectDocument, "graph">;
}

interface SourceHolder {
  sources: StateSources;
}

function holderFor(bus: LoomBus): SourceHolder {
  /*
   * `sharedForBus`, not `commandHolder`: this holds `{ sources }` rather than a nullable
   * `current`, and it backs several QUERIES rather than one command — so the key is the
   * module's own name. It is still the same bug: a re-executed copy minted a second
   * `sources` object and every query then read an empty one.
   */
  return sharedForBus<SourceHolder>(bus, "domain/state-queries", () => ({ sources: {} }));
}

/** What a bus currently has a source for. Exposed for the composition root and tests. */
export function stateSourcesFor(bus: LoomBus): Readonly<StateSources> {
  return holderFor(bus).sources;
}

/**
 * Attaches read sources and registers the queries they back.
 *
 * Idempotent and additive: calling it again REPLACES the named sources (a remount hands
 * over a new closure) and leaves the others alone. Registration happens once per query,
 * because the bus has no unregister — the holder, not the registration, is what a
 * remount swaps.
 */
export function attachStateSources(bus: LoomBus, sources: StateSources): void {
  const holder = holderFor(bus);
  holder.sources = { ...holder.sources, ...sources };

  if (holder.sources.selection !== undefined && !bus.hasQuery("selection.get")) {
    bus.registerQuery({
      name: "selection.get",
      description: "Node and edge ids currently selected in the editor.",
      handler: (): SelectionSnapshot => {
        const read = holder.sources.selection;
        if (read === undefined) return { nodeIds: [], edgeIds: [] };
        const snapshot = read();
        return { nodeIds: [...snapshot.nodeIds], edgeIds: [...snapshot.edgeIds] };
      },
    });
  }

  if (holder.sources.diagnostics !== undefined && !bus.hasQuery("diagnostics.get")) {
    bus.registerQuery({
      name: "diagnostics.get",
      description: "Current compile and runtime diagnostics, newest last.",
      handler: (input, context): DiagnosticsSnapshot => {
        const read = holder.sources.diagnostics;
        // No source is unreachable (the query is registered only once one is attached),
        // but the store's revision is the honest stand-in rather than a fabricated 0.
        const report = read === undefined ? { diagnostics: [], revision: context.graph.revision } : read();
        const all = [...report.diagnostics];
        const bySeverity =
          input.severity === undefined ? all : all.filter((entry) => entry.severity === input.severity);
        const limit = input.limit;
        return {
          diagnostics: limit === undefined ? bySeverity : bySeverity.slice(-Math.max(0, limit)),
          revision: report.revision,
        };
      },
    });
  }

  if (holder.sources.metrics !== undefined && !bus.hasQuery("runtime.metrics")) {
    bus.registerQuery({
      name: "runtime.metrics",
      description: "Frame and pass timing last published by the runtime (§V16).",
      handler: (): RuntimeMetricsSnapshot => {
        const read = holder.sources.metrics;
        if (read === undefined) return EMPTY_METRICS;
        return read();
      },
    });
  }

  if (holder.sources.project !== undefined && !bus.hasQuery("project.get")) {
    bus.registerQuery({
      name: "project.get",
      description: "The open project minus its graph: name, settings, assets (§V10).",
      handler: (_input, context): ProjectSnapshot => {
        const read = holder.sources.project;
        const revision = context.graph.revision;
        if (read === undefined) {
          throw new Error("project.get was registered without a project source.");
        }
        const project = read();
        return {
          projectId: project.projectId,
          name: project.name,
          schemaVersion: project.schemaVersion,
          settings: project.settings,
          assets: project.assets,
          createdAt: project.createdAt,
          updatedAt: project.updatedAt,
          revision,
        };
      },
    });
  }
}

/** Timing is unavailable rather than zero when nothing has been published (§V86). */
const EMPTY_METRICS: RuntimeMetricsSnapshot = Object.freeze({
  timingAvailable: false,
  framesRendered: 0,
  lastFrameIndex: null,
  frameGpuMs: null,
  passCount: 0,
  nodeCount: 0,
  prunedCount: 0,
  estimatedResourceBytes: null,
  memoryBudgetBytes: null,
  overBudget: false,
});
