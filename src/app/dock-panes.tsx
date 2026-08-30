import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AgentToolSurface } from "@agent/index.ts";
import { SHADER_SOURCE_PARAMETER } from "@domain/commands/index.ts";
import type { RuntimeDiagnostic } from "@domain/types/diagnostics.ts";
import type { GraphDocument } from "@domain/types/graph.ts";
import type { NodeId } from "@domain/types/ids.ts";
import { AgentPresencePanel, useAgentPresence } from "@editor/agent/index.ts";
import { PerformancePanel } from "@editor/inspect/index.ts";
import { KEYMAP_CONTEXT_ATTRIBUTE } from "@editor/keymap/index.ts";
import { ShaderEditor, commitShaderSource, diagnosticsToMarkers } from "@editor/shader-editor/index.ts";
import { useAppRuntime } from "./app-context.ts";
import type { GpuStatus } from "./gpu-status.ts";
import styles from "./panes.module.css";

/** The panes that used to be the bottom dock's tabs: shader editor, performance, agent. */

export interface ShaderPaneProps {
  nodeId: NodeId | null;
  graph: GraphDocument;
  diagnostics: readonly RuntimeDiagnostic[];
  /**
   * The output is running the last program that COMPILED, not this edit (§V9, T337).
   *
   * `BackendStatus.stale` — a program-level fact, which is what §V9 is about: the backend
   * retained an earlier program because the latest compile failed. Read from the backend
   * rather than from the per-node runtime channel because nothing publishes it there, so
   * that field is always false and a pane reading it would show a state it can never be in.
   */
  stale?: boolean;
}

/**
 * The `shaderEditor` slot.
 *
 * Editing is local until focus leaves, and the commit is a `setShaderSource` patch on
 * the bus — one patch, so a typing burst is one undo entry (§V29, §V34). A change made
 * to the document from anywhere else (undo, an agent) replaces the buffer, because the
 * document is the source of truth and the editor is a view of it (§V1).
 *
 * There is no live WGSL compile here yet: nothing wires a `ShaderCompiler` to the device
 * (T95). Rather than render a status strip that says "compiled" when nothing compiled,
 * the strip says what is actually true and shows the diagnostics the graph compiler did
 * produce for this node (§V27).
 *
 * §T219/B11 — clicking empty canvas blurs the editor AND clears the selection in the
 * same tick, so this component can be asked to re-render onto a different (or no)
 * subject before the outgoing node's `onBlur` commit has necessarily landed. Relying on
 * blur alone to save the draft is exactly the race that lost it. The subject switch
 * below commits the OUTGOING node's draft itself, from a ref that cannot have been
 * clobbered by the reset that follows it in the same pass — so leaving a node, by any
 * route, never discards what was typed for it.
 */
export function ShaderPane({ nodeId, graph, diagnostics, stale = false }: ShaderPaneProps) {
  const { bus, invocation, registry } = useAppRuntime();

  const node = nodeId === null ? undefined : graph.nodes[nodeId];
  const definition = node === undefined ? undefined : registry.get(node.type);
  const parameter = definition?.parameters[SHADER_SOURCE_PARAMETER];
  const authorable = node !== undefined && parameter !== undefined && parameter.type === "string";

  const committed = useMemo(() => {
    if (!authorable) return "";
    const value = node.parameters[SHADER_SOURCE_PARAMETER];
    if (typeof value === "string") return value;
    return parameter.type === "string" ? parameter.default : "";
  }, [authorable, node, parameter]);

  const [draft, setDraft] = useState(committed);
  const draftRef = useRef(draft);
  draftRef.current = draft;

  /** What the render before this one committed the buffer to. */
  const subjectRef = useRef({ nodeId, committed });
  /** A draft this render must flush for a node THIS render is about to stop showing. */
  const pendingCommitRef = useRef<{ nodeId: NodeId; source: string } | null>(null);

  // Re-sync when the subject or the stored text changes underneath the buffer. Read
  // `subjectRef`/`draftRef` — not `draft`/`committed` — for what is OUTGOING: `draft`
  // state has not been reset yet at this point in the render, but `sync`-by-comparison
  // reads would be wrong the instant a *second* switch happened before the first
  // effect ran, which refs cannot be.
  if (subjectRef.current.nodeId !== nodeId || subjectRef.current.committed !== committed) {
    const outgoing = subjectRef.current;
    if (outgoing.nodeId !== null && draftRef.current !== outgoing.committed) {
      pendingCommitRef.current = { nodeId: outgoing.nodeId, source: draftRef.current };
    }
    subjectRef.current = { nodeId, committed };
    setDraft(committed);
  }

  // No dependency array: checked after every commit, which is what makes this run
  // effectively immediately after the render above stashed something, while staying a
  // real effect rather than a bus call made during render.
  useEffect(() => {
    const pending = pendingCommitRef.current;
    if (pending === null) return;
    pendingCommitRef.current = null;
    void commitShaderSource({
      bus,
      context: invocation,
      nodeId: pending.nodeId,
      source: pending.source,
      baseRevision: bus.store.getRevision(),
    });
  });

  const commit = useCallback(() => {
    if (nodeId === null || draft === committed) return;
    void commitShaderSource({
      bus,
      context: invocation,
      nodeId,
      source: draft,
      baseRevision: bus.store.getRevision(),
    });
  }, [bus, committed, draft, invocation, nodeId]);

  const nodeDiagnostics = useMemo(
    () => diagnostics.filter((diagnostic) => diagnostic.nodeId === nodeId),
    [diagnostics, nodeId],
  );
  /**
   * The counts, folded in from the pane the app never mounted (T337, §V27).
   *
   * From the SAME diagnostics the gutter markers come from, so the summary and the marks
   * cannot disagree — a strip saying "0 err" over a red squiggle is worse than no strip.
   */
  const errorCount = nodeDiagnostics.filter((entry) => entry.severity === "error").length;
  const warningCount = nodeDiagnostics.filter((entry) => entry.severity === "warning").length;
  const markers = useMemo(
    () => diagnosticsToMarkers(draft, nodeDiagnostics),
    [draft, nodeDiagnostics],
  );

  if (!authorable || nodeId === null) {
    return (
      <div className={styles.dockEmpty}>
        <span>No shader selected</span>
        <span className={styles.note}>
          Select a node with a WGSL source parameter — Custom WGSL — to edit its shader.
        </span>
      </div>
    );
  }

  return (
    // §V53: this whole pane is a text context, so mod+z undoes typing here and never a
    // graph edit. The attribute is what the keymap engine reads.
    <div className={styles.shader} {...{ [KEYMAP_CONTEXT_ATTRIBUTE]: "text" }}>
      <div className={styles.shaderStatus}>
        <span className={styles.rowName}>
          {definition?.title ?? node.type} · {nodeId}
        </span>
        <span className={styles.note}>
          {draft === committed ? "saved" : "unsaved — commits when focus leaves"}
        </span>
        {/*
          §V9, the loud part — folded in from the unmounted pane, whose own docblock called
          it non-negotiable and which nothing rendered. When a compile fails the render did
          not stop and did not go black: it is still running the last shader that compiled.
          Without this the user reads a working output as proof their broken edit was fine.
        */}
        {stale ? (
          <span className={styles.shaderStale} role="status">
            <span className={styles.shaderStaleDot} aria-hidden="true" />
            output stale — last valid shader still rendering
          </span>
        ) : null}
        <span className={styles.shaderCounts}>
          <span
            className={errorCount > 0 ? styles.countError : styles.countOk}
            aria-label={`${errorCount} errors`}
          >
            {errorCount} err
          </span>
          <span
            className={warningCount > 0 ? styles.countWarning : undefined}
            aria-label={`${warningCount} warnings`}
          >
            {warningCount} warn
          </span>
        </span>
        <span className={styles.note}>
          WGSL is checked when the graph compiles on a device; there is no standalone
          shader compile yet.
        </span>
      </div>
      <ShaderEditor
        value={draft}
        onChange={setDraft}
        onBlur={commit}
        markers={markers}
        label={`WGSL source for ${nodeId}`}
      />
    </div>
  );
}

/**
 * The `performance` slot (T41, §V16, §V86, §V92a).
 *
 * This used to be a hand-rolled placeholder that re-derived the plan's counts from
 * `CompiledGraph` and printed a paragraph about timing not existing. The real panel had
 * shipped and tested behind it the whole time. It reads the telemetry hub — the same
 * snapshot the node info popup reads, at the same <= 10 Hz — so there is one answer to
 * "how many passes" and one answer to "how long did they take" rather than two.
 *
 * With no timing source attached every ms field reads "unavailable", which is the
 * truthful state and the one §V86 requires: not 0.000, and not a CPU-side number wearing
 * a GPU label.
 *
 * The device/build card (§V92a) lives here rather than on the viewer: tier, timestamp
 * query, formats and reuse counts are what someone diagnosing COST is looking at, and a
 * content pane whose job is showing pixels is not that surface.
 */
export function PerformancePane({ status }: { status: GpuStatus }) {
  const { telemetry } = useAppRuntime();
  return (
    <div className={styles.viewer}>
      <GpuStatusCard status={status} />
      <PerformancePanel telemetry={telemetry} />
    </div>
  );
}

function GpuStatusCard({ status }: { status: GpuStatus }) {
  if (status.kind === "probing") {
    return (
      <section className={styles.block} aria-label="GPU status">
        <h3 className={styles.blockTitle}>gpu</h3>
        <p className={styles.note}>Requesting a WebGPU device…</p>
      </section>
    );
  }

  if (status.kind === "unavailable") {
    return (
      <section className={styles.block} data-tone="error" aria-label="GPU status" role="status">
        <h3 className={styles.blockTitle}>gpu unavailable</h3>
        <p className={styles.alert}>{status.reason}</p>
        <p className={styles.note}>
          The graph, the inspector and the shader editor still work — the document is the
          source of truth and does not need a device. Rendering and compile validation stay
          off until one is available.
        </p>
      </section>
    );
  }

  const { capabilities, baseline } = status;
  return (
    <section className={styles.block} aria-label="GPU status">
      <h3 className={styles.blockTitle}>gpu</h3>
      <dl className={styles.facts}>
        <div className={styles.fact}>
          <dt>tier</dt>
          <dd>{capabilities.tier}</dd>
        </div>
        <div className={styles.fact}>
          <dt>timestamp query</dt>
          <dd>{capabilities.timestampQuery ? "yes" : "no"}</dd>
        </div>
        <div className={styles.fact}>
          <dt>formats</dt>
          <dd>{capabilities.formats.join(", ")}</dd>
        </div>
      </dl>
      {baseline ? null : (
        <p className={styles.alert} role="status">
          This device is below the Tier B baseline (rgba16float, compute, storage
          buffers). Expect missing features rather than a working render.
        </p>
      )}
    </section>
  );
}

/**
 * The `agent` pane (T60, T220, §V42).
 *
 * §V42: agent activity must be VISIBLE — planning, editing, compiling, awaiting approval
 * — and invisible background mutation is forbidden. The panel was built and tested and
 * had no host; this is the host. It reads a snapshot of the presence store the tool
 * surface writes as it runs, and it is never a producer of tool state: approve, reject
 * and revert all go back through the surface, which goes through the bus (§V29).
 */
export function AgentPane({ surface }: { surface: AgentToolSurface }) {
  const presence = useAgentPresence(surface.presence);
  const onApprove = useCallback(
    (proposalId: string) => {
      void surface.approve(proposalId);
    },
    [surface],
  );
  const onReject = useCallback(
    (proposalId: string) => {
      surface.reject(proposalId);
    },
    [surface],
  );
  const onRevert = useCallback(
    (transactionId: string) => {
      void surface.revertTransaction(transactionId);
    },
    [surface],
  );
  return (
    <div className={styles.viewer}>
      <AgentPresencePanel
        presence={presence}
        onApprove={onApprove}
        onReject={onReject}
        onRevert={onRevert}
      />
    </div>
  );
}
