import { memo, useCallback } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { Handle, NodeResizer, Position } from "@xyflow/react";
import type { NodeProps } from "@xyflow/react";
import { useStore } from "zustand";
import { cx } from "@ui/cx.ts";
import { portFamilyColor } from "@ui/ports.ts";
import { describePortType } from "@domain/graph/port-compat.ts";
import { MIN_NODE_SIZE } from "@domain/types/graph.ts";
import type { PortDefinition } from "@domain/types/ports.ts";
import { useGraphCanvas, useNodeRuntime } from "@editor/graph-canvas/canvas-context.ts";
import type { NodeToggleCommand } from "@editor/graph-canvas/canvas-context.ts";
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
  const { store, registry, runtime, selection, toggleUi, renderPreview, renderControls } =
    useGraphCanvas();
  // Own slice only (§V16): another node's edit does not re-render this one.
  const node = useStore(store, (state) => state.graph.nodes[id]);
  const snapshot = useNodeRuntime(runtime, id);

  /**
   * §V101 — a badge press acts on the whole selection when this node is IN it, and on
   * this node alone otherwise. §V102 (all-on-then-all-off for a multi-node press) is the
   * bus command's job (`toggleFlagOperations`), not this component's — that is exactly
   * what running the same command the keymap and the menu use buys (§V29, §V52).
   */
  const toggle = useCallback(
    (command: NodeToggleCommand) => {
      const targets = selection.includes(id) ? selection : [id];
      toggleUi(command, targets);
    },
    [id, selection, toggleUi],
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
  // §V28b: `ui.preview` is a PIN — keep previewing while scrolled off screen — not the
  // on-switch. Whether the slot exists at all is decided below, from the definition.
  const pinned = node.ui?.preview === true;
  const hasPreview = (definition?.outputs ?? []).some((port) => port.type.kind === "texture2d");
  const agent = snapshot.agent;

  return (
    <>
      {/*
        T208/§V116 — resize handles, shown on the selected node only: permanent handles
        on every node in a dense graph are visual noise competing with the imagery, and
        the node you are about to resize is the node you just clicked.

        The floor comes from the document contract (`MIN_NODE_SIZE`), not from a number
        typed here, so the drag cannot reach a size `applyGraphPatch` would clamp — the
        UI and the document agree about the smallest legal node by construction.

        This emits NO patch of its own. Every pointer move is React Flow view state; the
        canvas commits the finished gesture as one `setNodeSize` (§V15, §V29).
      */}
      <NodeResizer
        isVisible={selected === true}
        minWidth={MIN_NODE_SIZE.width}
        minHeight={MIN_NODE_SIZE.height}
      />
      <div
        className={cx(styles.node, selected && styles.selected)}
        data-testid={`node-${id}`}
        data-status={status}
        data-bypassed={bypassed}
        data-muted={muted}
        // §V117 — a resized node fills the box it was dragged to, and the PREVIEW is
        // what absorbs the extra room (the CSS beside this). That is the whole point of
        // the gesture: "the node got bigger" means "I can see the image better".
        data-sized={node.size !== undefined}
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
          {/*
            A user-given label wins over the definition title; absence means "follow the
            definition", so an unrenamed node tracks a retitled definition (§V29 rename).
          */}
          <span className={styles.name} title={node.label ?? definition?.title ?? node.type}>
            {node.label ?? definition?.title ?? node.type}
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
            label="Pin preview"
            title="Pin — keep previewing when scrolled off screen"
            short="P"
            pressed={pinned}
            onToggle={() => toggle("node.toggleDisplay")}
          />
          <NodeToggle
            label="Bypass"
            short="B"
            pressed={bypassed}
            onToggle={() => toggle("node.toggleBypass")}
          />
          <NodeToggle
            label="Mute"
            short="M"
            pressed={muted}
            onToggle={() => toggle("node.toggleRender")}
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

        {hasPreview ? (
          // §V28b: a visible texture-producing node previews by default — the slot exists
          // whether or not the node is pinned. §V28 still governs whether it is actually
          // LIVE right now (on screen or pinned) versus suspended; that state comes back
          // on the runtime channel and `NodePreview` renders it (§V16).
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
    </>
  );
});

interface NodeToggleProps {
  label: string;
  /** On-hover/focus explanation, only when the accessible name alone is not enough (§V90). */
  title?: string;
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
function NodeToggle({ label, title, short, pressed, onToggle }: NodeToggleProps) {
  const swallowPress = useCallback((event: ReactPointerEvent<HTMLButtonElement>) => {
    event.stopPropagation();
  }, []);

  return (
    <button
      type="button"
      className={cx(styles.toggle, "nodrag", "nopan")}
      aria-label={label}
      aria-pressed={pressed}
      title={title ?? label}
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
