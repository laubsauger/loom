import { memo, useCallback } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { Handle, Position } from "@xyflow/react";
import type { NodeProps } from "@xyflow/react";
import { useStore } from "zustand";
import { cx } from "@ui/cx.ts";
import { portFamilyColor } from "@ui/ports.ts";
import { describePortType } from "@domain/graph/port-compat.ts";
import type { PortDefinition } from "@domain/types/ports.ts";
import { useGraphCanvas, useNodeRuntime } from "@editor/graph-canvas/canvas-context.ts";
import { cssVars } from "@editor/graph-canvas/css-vars.ts";
import type { LoomNode } from "@editor/graph-canvas/derive.ts";
import type { NodeRunStatus } from "@editor/graph-canvas/node-runtime.ts";
import { formatGpuMs } from "@editor/edges/flow.ts";
import { ShaderStatusBadge } from "@editor/shader-editor/shader-status-badge.tsx";
import { AGENT_LABEL, AGENT_TOKEN, STATUS_LABEL, STATUS_TOKEN } from "./status.ts";
import styles from "./node-view.module.css";

/**
 * The custom graph node (T18, doc §17.2).
 *
 * Layout is the node-editor convention and is not negotiable: inputs on the left,
 * outputs on the right, port colour by family (§V26). The title bar is compact —
 * status dot, name, per-pass timing, and the two toggles that change what the compiler
 * does with this node — because the imagery is the hero and node chrome that competes
 * with it is a bug in a tool like this.
 *
 * Three separate data channels meet here, deliberately:
 *
 *  - React Flow's props carry identity and geometry only;
 *  - the document slice for *this node* comes straight from the domain store, so the
 *    view is derived from the source of truth and never the reverse (§V1);
 *  - status, per-pass GPU ms and agent activity arrive on the runtime channel, which
 *    never enters the document and is coalesced to <= 10 Hz (§V16).
 *
 * That is why this component is memoised and why nothing above it re-renders when a
 * number ticks.
 */
export const NodeView = memo(function NodeView({ id, selected }: NodeProps<LoomNode>) {
  const { store, registry, runtime, dispatch, renderPreview, renderControls } = useGraphCanvas();
  // Own slice only (§V16): another node's edit does not re-render this one.
  const node = useStore(store, (state) => state.graph.nodes[id]);
  const snapshot = useNodeRuntime(runtime, id);

  const setUi = useCallback(
    (key: "bypassed" | "muted" | "preview", value: boolean, label: string) => {
      dispatch([{ op: "setNodeUi", nodeId: id, ui: { [key]: value } }], label);
    },
    [dispatch, id],
  );

  if (node === undefined) return null;

  const definition = registry.get(node.type);
  // §V10 — an unknown type is preserved as a placeholder, never dropped. It has no
  // ports we can trust, so it renders as an error with its serialized type visible.
  const unresolved = definition === undefined;
  const status: NodeRunStatus = unresolved ? "error" : snapshot.status;
  const message = unresolved
    ? `Unknown node type "${node.type}" — the definition is not installed.`
    : snapshot.message;

  const bypassed = node.ui?.bypassed === true;
  const muted = node.ui?.muted === true;
  const previewOn = node.ui?.preview === true;
  const agent = snapshot.agent;

  return (
    <div
      className={cx(styles.node, selected && styles.selected)}
      data-testid={`node-${id}`}
      data-status={status}
      data-bypassed={bypassed}
      data-muted={muted}
      data-agent={agent?.kind ?? "none"}
      style={cssVars({ "--status-color": STATUS_TOKEN[status] })}
    >
      <header className={styles.title}>
        <span
          className={styles.dot}
          data-testid={`node-status-${id}`}
          data-status={status}
          role="img"
          aria-label={`Status: ${STATUS_LABEL[status]}`}
          title={STATUS_LABEL[status]}
        />
        <span className={styles.name} title={definition?.title ?? node.type}>
          {definition?.title ?? node.type}
        </span>
        {/* Compile/diagnostic badge is track H's component (§V27) — it renders nothing
            at all when the node is clean, which is what keeps the chrome quiet. */}
        <ShaderStatusBadge
          errorCount={snapshot.errorCount}
          warningCount={snapshot.warningCount}
          stale={snapshot.stale}
          compiling={status === "compiling"}
        />
        <span
          className={styles.timing}
          aria-label="GPU time for this pass"
          title="GPU time for this pass"
        >
          {formatGpuMs(snapshot.gpuMs)}
        </span>
        <NodeToggle
          label="Preview"
          short="P"
          pressed={previewOn}
          onToggle={() => setUi("preview", !previewOn, previewOn ? "Hide preview" : "Show preview")}
        />
        <NodeToggle
          label="Bypass"
          short="B"
          pressed={bypassed}
          onToggle={() => setUi("bypassed", !bypassed, bypassed ? "Un-bypass node" : "Bypass node")}
        />
        <NodeToggle
          label="Mute"
          short="M"
          pressed={muted}
          onToggle={() => setUi("muted", !muted, muted ? "Unmute node" : "Mute node")}
        />
      </header>

      {agent === null ? null : (
        <p
          className={styles.agent}
          data-agent={agent.kind}
          style={cssVars({ "--agent-color": AGENT_TOKEN[agent.kind] })}
        >
          <span className={styles.agentKind}>{AGENT_LABEL[agent.kind]}</span>
          <span className={styles.agentActor}>{agent.actorLabel}</span>
          {agent.detail === undefined ? null : (
            <span className={styles.agentDetail}>{agent.detail}</span>
          )}
        </p>
      )}

      {previewOn ? (
        // Only visible/pinned previews are ever scheduled (§V28); the slot itself is
        // filled by the preview track (T34) and stays empty until then.
        <div className={cx(styles.preview, "nodrag", "nopan")} data-testid={`node-preview-${id}`}>
          {renderPreview?.(id)}
        </div>
      ) : null}

      {renderControls === undefined ? null : (
        <div className={cx(styles.controls, "nodrag", "nopan")}>{renderControls(id)}</div>
      )}

      <div className={styles.ports}>
        <ul className={cx(styles.column, styles.inputs)}>
          {(definition?.inputs ?? []).map((port) => (
            <PortRow key={port.id} port={port} side="input" />
          ))}
        </ul>
        <ul className={cx(styles.column, styles.outputs)}>
          {(definition?.outputs ?? []).map((port) => (
            <PortRow key={port.id} port={port} side="output" />
          ))}
        </ul>
      </div>

      {message === null || message === undefined ? null : (
        <p className={styles.message} title={message}>
          {message}
        </p>
      )}
    </div>
  );
});

interface NodeToggleProps {
  label: string;
  short: string;
  pressed: boolean;
  onToggle: () => void;
}

/**
 * §V20 — the classic node-editor bug: a press on an embedded control starts a node drag
 * or a canvas pan, and the control never sees the gesture. Two independent guards, since
 * either alone has a hole: React Flow's own `nodrag`/`nopan` opt-out classes, and
 * stopping the pointer press from reaching the node wrapper's drag listener at all.
 * The click itself is left to bubble, so pressing a toggle still selects its node.
 */
function NodeToggle({ label, short, pressed, onToggle }: NodeToggleProps) {
  const swallowPress = useCallback((event: ReactPointerEvent<HTMLButtonElement>) => {
    event.stopPropagation();
  }, []);

  return (
    <button
      type="button"
      className={cx(styles.toggle, "nodrag", "nopan")}
      aria-label={label}
      aria-pressed={pressed}
      title={label}
      onPointerDown={swallowPress}
      onMouseDown={swallowPress}
      onClick={onToggle}
    >
      {short}
    </button>
  );
}

interface PortRowProps {
  port: PortDefinition;
  side: "input" | "output";
}

/**
 * One port. The dot is React Flow's connection handle, coloured by port family (§V26) —
 * the same token the edges leaving it use, which is what makes the colour readable as a
 * type rather than as decoration.
 */
const PortRow = memo(function PortRow({ port, side }: PortRowProps) {
  const description = describePortType(port.type);
  return (
    <li
      className={cx(styles.port, side === "input" ? styles.portIn : styles.portOut)}
      data-kind={port.type.kind}
      style={cssVars({ "--port-color": portFamilyColor(port.type.kind) })}
    >
      <Handle
        type={side === "input" ? "target" : "source"}
        position={side === "input" ? Position.Left : Position.Right}
        id={port.id}
        className={styles.handle}
        // V19 — reachable and named. The connect *gesture* is pointer-only until the
        // keymap track lands a keyboard binding for it (T76/T77).
        tabIndex={0}
        aria-label={`${side === "input" ? "Input" : "Output"} port ${port.label}, ${description}`}
        title={`${port.label} — ${description}`}
        isConnectable
      />
      <span className={styles.portLabel}>{port.label}</span>
    </li>
  );
});
