import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AgentToolSurface } from "@agent/index.ts";
import { SHADER_SOURCE_PARAMETER } from "@domain/commands/index.ts";
import type { RuntimeDiagnostic } from "@domain/types/diagnostics.ts";
import type { GraphDocument } from "@domain/types/graph.ts";
import type { NodeId } from "@domain/types/ids.ts";
import { AgentPresencePanel, McpConnectionPanel, useAgentPresence } from "@editor/agent/index.ts";
import { PerformancePanel } from "@editor/inspect/index.ts";
import type { CookPolicyValue } from "@editor/inspect/index.ts";
import { KEYMAP_CONTEXT_ATTRIBUTE } from "@editor/keymap/index.ts";
import { ShaderEditor, commitShaderSource, diagnosticsToMarkers } from "@editor/shader-editor/index.ts";
import { codeParametersOf } from "@domain/parameters/index.ts";
import { isParameterSlot } from "@domain/parameters/slots.ts";
import { useAppRuntime } from "./app-context.ts";
import type { GpuStatus } from "./gpu-status.ts";
import type { McpTransportsView } from "./use-mcp-transports.ts";
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
  /**
   * T492: the pane's subjects are EVERY code-valued parameter of the selected node —
   * derived from the manifest kind, never a roster of names (§V437). One node may carry
   * several (a kernel, its spawn hook, its group predicate, its attribute schema); the
   * strip below switches between them and the buffer machinery treats (node, parameter)
   * as the subject where it used to treat the node alone.
   */
  const codeParameters = useMemo(() => {
    const declared =
      definition === undefined
        ? []
        : codeParametersOf(definition.parameters).map((entry) => ({
            key: entry.key,
            label: entry.definition.label,
            language: entry.definition.language as "wgsl" | "json" | "expression",
            defaultText: entry.definition.default,
            kind: "parameter" as const,
          }));
    /**
     * T505: expressions are code too. An expression lives in a slot's MODE, not as a
     * parameter, so the census cannot see it (and must not be forced to — a mode is
     * not a parameter). The pane derives a second subject family from the NODE: every
     * slot currently in expression mode, edited with the same editor, committed back
     * into its envelope with every other binding kept (§V108: mode payloads survive).
     */
    const expressions =
      node === undefined
        ? []
        : Object.entries(node.parameters)
            .filter(
              (entry): entry is [string, { mode: "expression"; bindings: Record<string, unknown> }] =>
                isParameterSlot(entry[1]) &&
                entry[1].mode === "expression" &&
                entry[1].bindings.expression !== undefined,
            )
            .map(([key]) => ({
              key: `expr:${key}`,
              label: `${key} expr`,
              language: "expression" as const,
              defaultText: "",
              kind: "expression" as const,
            }))
            .sort((a, b) => (a.key < b.key ? -1 : 1));
    return [...declared, ...expressions];
  }, [definition, node]);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const activeKey =
    selectedKey !== null && codeParameters.some((entry) => entry.key === selectedKey)
      ? selectedKey
      : (codeParameters[0]?.key ?? null);
  const active = codeParameters.find((entry) => entry.key === activeKey);
  const authorable = node !== undefined && active !== undefined && nodeId !== null;

  const committed = useMemo(() => {
    if (!authorable) return "";
    if (active.kind === "expression") {
      const stored = node.parameters[active.key.slice("expr:".length)];
      if (isParameterSlot(stored)) {
        const binding = stored.bindings.expression;
        if (binding?.kind === "expression") return binding.source;
      }
      return "";
    }
    const value = node.parameters[active.key];
    if (typeof value === "string") return value;
    return active.defaultText;
  }, [authorable, node, active]);

  const [draft, setDraft] = useState(committed);
  const draftRef = useRef(draft);
  draftRef.current = draft;

  /**
   * Two commit paths, on purpose, and here is why two exist (T492): the WGSL `source`
   * parameter travels `setShaderSource` — its own patch op, which the shader cache,
   * the compile pipeline and track B's conventions all key on — while every other code
   * parameter is an ordinary parameter and commits as one, through `setParameters`.
   * Collapsing them would either strip `source` of its cache semantics or launder a
   * kernel edit through an op named for shaders.
   */
  const commitCode = useCallback(
    (subjectNode: NodeId, key: string, source: string) => {
      if (key.startsWith("expr:")) {
        // T505: write the source back INTO the mode envelope, other bindings kept
        // (§V108 — a mode switch, and by extension a payload edit, is never
        // destructive of the neighbours).
        const parameterKey = key.slice("expr:".length);
        const stored = bus.store.getGraph().nodes[subjectNode]?.parameters[parameterKey];
        if (!isParameterSlot(stored)) return;
        void bus.execute(
          "graph.applyPatch",
          {
            baseRevision: bus.store.getRevision(),
            operations: [
              {
                op: "setParameters",
                nodeId: subjectNode,
                parameters: {
                  [parameterKey]: {
                    ...stored,
                    bindings: { ...stored.bindings, expression: { kind: "expression", source } },
                  },
                },
              },
            ],
            label: `edit ${parameterKey} expression`,
          },
          invocation,
        );
        return;
      }
      if (key === SHADER_SOURCE_PARAMETER) {
        void commitShaderSource({
          bus,
          context: invocation,
          nodeId: subjectNode,
          source,
          baseRevision: bus.store.getRevision(),
        });
        return;
      }
      void bus.execute(
        "graph.applyPatch",
        {
          baseRevision: bus.store.getRevision(),
          operations: [{ op: "setParameters", nodeId: subjectNode, parameters: { [key]: source } }],
          label: `edit ${key}`,
        },
        invocation,
      );
    },
    [bus, invocation],
  );

  /** What the render before this one committed the buffer to. */
  const subjectRef = useRef({ nodeId, key: activeKey, committed });
  /** A draft this render must flush for a subject THIS render is about to stop showing. */
  const pendingCommitRef = useRef<{ nodeId: NodeId; key: string; source: string } | null>(null);

  // Re-sync when the subject or the stored text changes underneath the buffer (§T219/B11:
  // blur and reselect land in one tick, so the OUTGOING subject's draft is flushed from
  // refs the reset cannot clobber — leaving a node, by any route, never discards typing).
  if (
    subjectRef.current.nodeId !== nodeId ||
    subjectRef.current.key !== activeKey ||
    subjectRef.current.committed !== committed
  ) {
    const outgoing = subjectRef.current;
    if (outgoing.nodeId !== null && outgoing.key !== null && draftRef.current !== outgoing.committed) {
      pendingCommitRef.current = { nodeId: outgoing.nodeId, key: outgoing.key, source: draftRef.current };
    }
    subjectRef.current = { nodeId, key: activeKey, committed };
    setDraft(committed);
  }

  // No dependency array: checked after every commit, effectively immediately after the
  // render above stashed something, while staying a real effect.
  useEffect(() => {
    const pending = pendingCommitRef.current;
    if (pending === null) return;
    pendingCommitRef.current = null;
    commitCode(pending.nodeId, pending.key, pending.source);
  });

  const commit = useCallback(() => {
    if (nodeId === null || activeKey === null || draft === committed) return;
    commitCode(nodeId, activeKey, draft);
  }, [activeKey, commitCode, committed, draft, nodeId]);

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
    // Gutter positions are offsets into the SOURCE text; other code parameters keep the
    // node-level counts above but take no ranged markers until their diagnostics carry
    // spans of their own.
    () => (activeKey === SHADER_SOURCE_PARAMETER ? diagnosticsToMarkers(draft, nodeDiagnostics) : []),
    [activeKey, draft, nodeDiagnostics],
  );

  if (!authorable) {
    return (
      <div className={styles.dockEmpty}>
        <span>No code selected</span>
        <span className={styles.note}>
          Select a node with a code parameter — a Custom WGSL shader, a point kernel, a
          spawn hook, an attribute schema.
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
        {codeParameters.length > 1 ? (
          <span className={styles.codeSubjects} role="tablist" aria-label="Code parameters">
            {codeParameters.map((entry) => (
              <button
                key={entry.key}
                type="button"
                role="tab"
                aria-selected={entry.key === activeKey}
                className={entry.key === activeKey ? styles.codeSubjectActive : styles.codeSubject}
                onClick={() => setSelectedKey(entry.key)}
              >
                {entry.label}
              </button>
            ))}
          </span>
        ) : null}
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
          {active.language === "wgsl"
            ? "WGSL is checked when the graph compiles on a device; there is no standalone shader compile yet."
            : active.language === "json"
              ? "JSON is checked when the graph compiles; a schema that does not parse refuses by name."
              : "Expressions are checked as you commit; an unparseable one refuses with its reason."}
        </span>
      </div>
      <ShaderEditor
        value={draft}
        language={active.language}
        onChange={setDraft}
        onBlur={commit}
        markers={markers}
        label={`${active.label} for ${nodeId}`}
      />
    </div>
  );
}

export function PerformancePane({
  status,
  cookPolicy,
  onCookPolicyChange,
}: {
  status: GpuStatus;
  /** T326/§V157 — the bisect switch, on the surface §V92a puts diagnostics on. */
  cookPolicy?: CookPolicyValue | undefined;
  onCookPolicyChange?: ((policy: CookPolicyValue) => void) | undefined;
}) {
  const { telemetry } = useAppRuntime();
  return (
    <div className={styles.viewer}>
      <GpuStatusCard status={status} />
      <PerformancePanel
        telemetry={telemetry}
        {...(cookPolicy === undefined ? {} : { cookPolicy })}
        {...(onCookPolicyChange === undefined ? {} : { onCookPolicyChange })}
      />
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
 *
 * ## Why the connection panel lives here and not in settings (T397)
 *
 * The two candidates were this pane and the settings dialog. Connection state is not
 * configuration: it changes at runtime without anybody typing, it is the thing you WATCH
 * while an agent works, and it sits one line above the presence readout that says what
 * that same agent is doing right now. Settings is where you go to change something and
 * leave; a state you have to keep an eye on does not belong behind a modal you closed.
 *
 * The half that LOOKS like configuration — the bridge's pairing code — is not configured
 * either: it is minted per server process, typed once, and never stored (T451), so the
 * split that argument was protecting never arises.
 */
export interface AgentPaneProps {
  readonly surface: AgentToolSurface;
  /** What is published, on which transport (T397). Omitted → the connections panel is absent. */
  readonly transports?: McpTransportsView | undefined;
  /** Opens the setup documentation. §V307: a surface is opened by a COMMAND, dispatched by the caller. */
  readonly onOpenSetup?: (() => void) | undefined;
}

export function AgentPane({ surface, transports, onOpenSetup }: AgentPaneProps) {
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
      {transports === undefined ? null : (
        <McpConnectionPanel
          transports={transports.transports}
          describeTool={transports.describeTool}
          onOpenSetup={onOpenSetup}
        />
      )}
      <AgentPresencePanel
        presence={presence}
        onApprove={onApprove}
        onReject={onReject}
        onRevert={onRevert}
      />
    </div>
  );
}
