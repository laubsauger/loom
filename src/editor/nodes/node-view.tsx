import { memo, useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type {
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
} from "react";
import { Handle, NodeResizer, Position } from "@xyflow/react";
import type { NodeProps } from "@xyflow/react";
import { useStore } from "zustand";
import { cx } from "@ui/cx.ts";
import { portFamilyColor } from "@ui/ports.ts";
import { describePortType } from "@domain/graph/port-compat.ts";
import { nameBaseFor } from "@domain/graph/names.ts";
import { sourceReferenceForInput } from "@domain/graph/source-references.ts";
import { isComponentInputBoundary, isComponentOutputBoundary } from "@nodes/definitions/index.ts";
import { isComponentNodeType, parseComponentNodeType } from "@domain/components/component-type.ts";
import type { CommandResult } from "@domain/types/commands.ts";
import { MIN_NODE_SIZE } from "@domain/types/graph.ts";
import { previewablePort } from "@domain/graph/previewable.ts";
import { publishesValueChannels } from "@domain/types/node-definition.ts";
import type { PortDefinition } from "@domain/types/ports.ts";
import { useGraphCanvas, useNodeRuntime } from "@editor/graph-canvas/canvas-context.ts";
import type { NodeToggleCommand } from "@editor/graph-canvas/canvas-context.ts";
import { cssVars } from "@editor/graph-canvas/css-vars.ts";
import type { LoomNode } from "@editor/graph-canvas/derive.ts";
import type { NodeRunStatus } from "@editor/graph-canvas/node-runtime.ts";
import { formatGpuMs } from "@editor/edges/flow.ts";
import { ShaderStatusBadge } from "@editor/shader-editor/shader-status-badge.tsx";
import { nodeTypeLabelStore } from "./node-type-labels.ts";
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
  const {
    store,
    registry,
    runtime,
    selection,
    toggleUi,
    renameSession,
    beginRename,
    renameNode,
    renderPreview,
    renderControls,
    showProblems,
    diveIn,
    components,
  } = useGraphCanvas();
  // Own slice only (§V16): another node's edit does not re-render this one.
  const node = useStore(store, (state) => state.graph.nodes[id]);
  const snapshot = useNodeRuntime(runtime, id);

  /**
   * Is THIS node's title in edit mode (T415)?
   *
   * The snapshot is a boolean about this node rather than the session's node id, so
   * opening an editor anywhere re-renders exactly two nodes — the one leaving edit mode
   * and the one entering it — instead of every node on the canvas (§V16).
   */
  const isEditingName = useSyncExternalStore(
    renameSession.subscribe,
    useCallback(() => renameSession.get() === id, [renameSession, id]),
  );
  const typeLabels = nodeTypeLabelStore();
  const showTypeLabel = useSyncExternalStore(typeLabels.subscribe, typeLabels.get);

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

  /*
   * T603: a component instance must READ as one at a glance, at any zoom. Three facts,
   * one treatment: component-ness is STRUCTURAL (`data-component` drives a stacked-card
   * silhouette in CSS — the universal "contains more" shape, legible at thumbnail
   * scale); linked-ness and the available upgrade share ONE chip in the header — the
   * chip's presence says "linked instance" (a detached copy has no instance node at
   * all), its text is the pinned version, and an available upgrade turns it into
   * `v2→3` in the warning tone. T137's inspector said this; the node did not.
   */
  const instanceRef = parseComponentNodeType(node.type);
  const latestVersion =
    instanceRef === null || components === undefined
      ? undefined
      : components.latest(instanceRef.componentId)?.version;
  const upgradeAvailable =
    instanceRef !== null && latestVersion !== undefined && latestVersion > instanceRef.version;

  const bypassed = node.ui?.bypassed === true;
  const muted = node.ui?.muted === true;
  /**
   * The preview SWITCH (T353, §V297, §V304), default ON.
   *
   * `ui.preview` used to be the pin, so pressing `P` changed nothing anyone could see —
   * previews were on either way, and the button reported a state with no visible
   * consequence. §V304: the control and the picture are now ONE fact. Off means off: no
   * tile, nothing scheduled, no GPU work. Pinning — keep previewing while scrolled off
   * screen — is the rarer need and lives in the context menu (§V78, §V90), so the node
   * chrome does not grow a fourth button for it.
   */
  const previewOn = node.ui?.preview !== false;
  /**
   * What this node SHOWS in its body — a texture preview, or a value plot (T344).
   *
   * A value node produces a signal rather than pixels, and it is content in exactly the
   * same sense: TD draws a CHOP's channel in the node, and that is why a TD network reads
   * at a glance. T438: the gate is `publishesValueChannels` — the DECLARED channel, not
   * the category string. `category === "value"` was the previous key, and the day the
   * scene nodes moved onto that shelf every camera and material was offered a plot it
   * could not fill ("no signal yet") — a category is a library shelf, not a capability.
   *
   * `renderPreview` is the same seam for both; the composition root decides which surface
   * comes back, exactly as it already did for textures (T185).
   */
  const producesValue = publishesValueChannels(definition);
  /**
   * A declared SINK shows its picture too, and it is the picture that matters most.
   *
   * An Output node publishes no port — it CONSUMES one — so no output kind matches it,
   * and the node that presents the final image was the only one in the graph with an
   * empty body. It does own a texture: the render target the compiler materializes for
   * every declared sink (§V25). Same slot, same host, same scheduler — the composition
   * root fills it from the compiled output like any other tile.
   */
  const presentsTexture = definition?.sink === true;
  /**
   * EVERY PREVIEWABLE OUTPUT KIND, FROM THE ONE LIST (T532, §V437).
   *
   * This used to enumerate the kinds itself, and B65 is what that costs: T373 built the
   * whole pointset splat path — compiler synthesis, candidates, sink gating — and it fed
   * a slot this component never created, because the list here knew three kinds and a
   * pointset was a fourth. No div, no measured bounds, no sink, no target. "The pipeline
   * was complete and its last millimetre was missing."
   *
   * T532 found the same gap one kind further along: a geometry had no picture in the
   * compiler, and writing one would still have shown nothing, because this copy, the
   * candidate list and the layout model had all never heard of `scene` either. So the
   * kinds live in `PREVIEWABLE_PORT_KINDS` now and every site reads them from there —
   * which is the only version of this that a future kind cannot walk past.
   *
   * §V350: T373's own gate asserted the REQUEST side (is this node a preview candidate?)
   * — true, and blind to the display side where the break was.
   */
  const producesPreviewable = previewablePort(definition?.outputs ?? []) !== undefined;
  const hasPreview = producesPreviewable || producesValue || presentsTexture;
  const agent = snapshot.agent;

  /**
   * A user-given label wins over the definition title; absence means "follow the
   * definition", so an unrenamed node tracks a retitled definition (§V29 rename).
   */
  const displayName = node.label ?? definition?.title ?? node.type;

  /**
   * T416 — the TYPE beside the name, and only when the name stopped carrying it.
   *
   * The owner's reason is the whole design: an unrenamed node is auto-named from its type
   * (`blur1`, `over2`, §V129), so its name already IS the identification. Renaming to
   * `Bloom pass` is what spends it. So the chip appears exactly when it adds something —
   * on a node whose name is no longer its type's auto-name — and stays away otherwise,
   * because "blur1  Blur" is the same word twice in the most crowded row in the app, which
   * is precisely what §V90 forbids.
   *
   * The test is derived from `nameBaseFor`, the same function that MINTS those names, so
   * it cannot drift from the naming rule (§V316). It is a display decision only: nothing
   * here reads back into the document.
   */
  const nameCarriesType =
    definition === undefined ||
    new RegExp(`^${nameBaseFor(node.type)}\\d+$`, "i").test(displayName);
  /*
   * T639(d)/T640: an instance's synthesized definition title is the COMPONENT'S OWN
   * NAME (a component the owner called "animated" labelled its nodes "animated"), so
   * the label repeated the name and said nothing about what the node IS. The kind is
   * the useful fact, so the kind is the label.
   */
  const typeLabel = showTypeLabel && !nameCarriesType
    ? (isComponentNodeType(node.type) ? "component" : (definition?.title ?? null))
    : null;

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
        // T607: a boundary node's dangling side wears a LEAD — the "dangling input
        // cable" of the owner's framing — saying "fed from outside" (In) or "feeds
        // the outside" (Out). Pure CSS off this attribute; see .node[data-boundary].
        data-component={instanceRef !== null ? true : undefined}
        data-boundary={
          isComponentInputBoundary(node.type) ? "in" : isComponentOutputBoundary(node.type) ? "out" : undefined
        }
        data-bypassed={bypassed}
        data-muted={muted}
        // §V117 — a resized node fills the box it was dragged to, and the PREVIEW is
        // what absorbs the extra room (the CSS beside this). That is the whole point of
        // the gesture: "the node got bigger" means "I can see the image better".
        data-sized={node.size !== undefined}
        data-agent={agent?.kind ?? "none"}
        style={cssVars({ "--status-color": STATUS_TOKEN[status] })}
        // T602: double-click ENTERS a component — TD's gesture, onto the same
        // `graph.diveIn` the keymap (`i`) and the context menu run (§V78). Only for
        // instances, so every other node keeps its plain double-click (the title's
        // rename editor stops propagation before this sees it).
        onDoubleClick={
          isComponentNodeType(node.type)
            ? (event) => {
                event.stopPropagation();
                diveIn(id as never);
              }
            : undefined
        }
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
          {isEditingName ? (
            <NameEditor
              nodeId={id}
              initial={displayName}
              onCommit={renameNode}
              onClose={() => renameSession.end(id)}
            />
          ) : (
            <>
              <span
                className={styles.name}
                data-testid={`node-name-${id}`}
                title={displayName}
                // T415: TouchDesigner's own gesture, and the one the owner asked for —
                // "edit name directly in the header bar". Routed through the command so
                // the double-click, `n` and the menu's "Rename…" are one implementation
                // (§V78); React Flow's own double-click zoom is off (`zoomOnDoubleClick`),
                // so this cannot fight the canvas for the gesture.
                onDoubleClick={(event) => {
                  // T602: the TITLE keeps rename; the dive gesture is the node body.
                  event.stopPropagation();
                  beginRename(id);
                }}
              >
                {displayName}
              </span>
              {typeLabel === null ? null : (
                <span
                  className={styles.typeLabel}
                  data-testid={`node-type-${id}`}
                  title={`${definition?.title ?? node.type} — this node's type`}
                >
                  {typeLabel}
                </span>
              )}
              {instanceRef === null ? null : (
                <span
                  className={styles.componentChip}
                  data-testid={`node-component-${id}`}
                  data-upgrade={upgradeAvailable}
                  title={
                    upgradeAvailable
                      ? `Linked component instance, pinned to v${String(instanceRef.version)} — v${String(latestVersion)} is available. Editing the definition changes every linked instance; upgrading is explicit (§V84).`
                      : `Linked component instance, v${String(instanceRef.version)}. Editing the definition changes every linked instance.`
                  }
                >
                  {upgradeAvailable ? `v${String(instanceRef.version)}→${String(latestVersion)}` : `v${String(instanceRef.version)}`}
                </span>
              )}
            </>
          )}
          {/* Compile/diagnostic badge is track H's component (§V27) — it renders nothing
              at all when the node is clean, which is what keeps the chrome quiet.

              No `stale` (B36, §V269): §V9's staleness is the whole retained PROGRAM, so
              it is true for every node at once. One program fact on N badges is the same
              sentence N times (§V90), and the node at fault is already named by its error
              count. The statement lives in the node info popup, which is per-node and on
              demand. The badge's own `stale` prop stays — it derives from a real field the
              compile pipeline sets, and unwired is not the same as vacuous. */}
          <ShaderStatusBadge
            errorCount={snapshot.errorCount}
            warningCount={snapshot.warningCount}
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
            title="Preview — off costs no GPU work"
            short="P"
            pressed={previewOn}
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
            {/*
              T457 (V387): a reference-fed input is PLUMBING — the compiler synthesizes
              its edge from a name parameter, and a wire into it is refused
              (apply-patch's port.sourceReference). A socket the user cannot connect
              invites the wire and then refuses it, so it does not render at all; the
              relationship is already visible as the hued reference line (T248/T391).
            */}
            {(definition?.inputs ?? [])
              .filter((port) => sourceReferenceForInput(node.type, port.id) === undefined)
              .map((port) => (
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
        {/*
          T599: the node shows ONE message; with several diagnostics the rest were
          unreachable from the node entirely. An honest count, and a real door — the
          chip runs `ui.showProblems`, which fronts the problems tab (restoring it if
          closed). `nodrag` so the click is a click, not a node drag (§V20).
        */}
        {message !== null &&
        message !== undefined &&
        snapshot.errorCount + snapshot.warningCount > 1 ? (
          <button
            type="button"
            className={cx("nodrag", styles.moreDiagnostics)}
            onClick={(event) => {
              event.stopPropagation();
              showProblems();
            }}
          >
            +{snapshot.errorCount + snapshot.warningCount - 1} more — open problems
          </button>
        ) : null}
      </div>
    </>
  );
});

interface NameEditorProps {
  nodeId: string;
  /** The name as shown, which is what the field opens holding. */
  initial: string;
  onCommit: (nodeId: string, label: string) => Promise<CommandResult<"node.rename">>;
  onClose: () => void;
}

/**
 * The node name, in place (T415, B60).
 *
 * ## Why an input on the title and not a dialog
 *
 * The owner asked to "edit name directly in the header bar", and the gesture is right:
 * the name is one short word, the node is on screen, and a modal to type one word puts a
 * scrim over the graph you are naming a node IN.
 *
 * ## Keys
 *
 * Enter commits, Escape cancels and restores, blur commits — the same three the number
 * fields in project settings already have, so a control does not behave differently from
 * its neighbour for reasons only its author knows.
 *
 * Typing here cannot reach a graph binding, and §V53 is what makes that structural rather
 * than a promise: the keymap derives the `text` context from the EVENT TARGET, so a focused
 * `<input>` swallows every printable key and the editing keys before any `graph` binding is
 * matched. Pressing `b` in this field types a b; it does not bypass the node. Escape and
 * Enter are NOT swallowed by that rule — they fall through to the broader contexts on
 * purpose — so this handler stops them itself, and `preventDefault` is what actually does
 * it: the keymap's window listener skips an event that is already `defaultPrevented`.
 * (T360's chord capture needed `onEscapeKeyDown` on top of this because Radix listens in
 * the CAPTURE phase, §V302. Nothing here is inside a Radix surface, so it does not apply —
 * and a node title is not a dialog whose dismissal Escape has to be shared with.)
 *
 * ## A refused rename keeps the text
 *
 * §V325: a name that collides is REFUSED, never suffixed, because the references the user
 * has written point at the exact word they typed. So the field stays open holding what
 * they typed, says which name is taken, and takes focus back — silently reverting their
 * typing, or silently accepting a name they did not choose, are the two worse answers.
 */
function NameEditor({ nodeId, initial, onCommit, onClose }: NameEditorProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [draft, setDraft] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  // Enter commits and then blurs, which would commit again. One settle per session.
  const settling = useRef(false);

  useEffect(() => {
    const input = inputRef.current;
    if (input === null) return;
    input.focus();
    // Selected, not just focused: renaming usually REPLACES the auto-name rather than
    // editing it, and this is the only chance to say so without the user pressing ⌘A.
    input.select();
  }, []);

  const commit = useCallback(async () => {
    if (settling.current) return;
    const next = draft.trim();
    if (next === initial) {
      // Nothing to say: closing without a command means no revision and no undo entry
      // for an edit that did not happen (§V33).
      onClose();
      return;
    }
    settling.current = true;
    const result = await onCommit(nodeId, next);
    if (result.status === "applied") {
      onClose();
      return;
    }
    // §V288 — the refusal NAMES the problem, on the node, where the attempt was made.
    settling.current = false;
    const diagnostic = result.diagnostics.find((entry) => entry.severity !== "info");
    setError(
      [diagnostic?.message, diagnostic?.suggestion].filter((part) => part !== undefined).join(" ") ||
        "That name was refused.",
    );
    const input = inputRef.current;
    if (input !== null) {
      input.focus();
      input.select();
    }
  }, [draft, initial, nodeId, onClose, onCommit]);

  const onKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLInputElement>) => {
      if (event.key === "Enter") {
        event.preventDefault();
        event.stopPropagation();
        void commit();
      } else if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        settling.current = true;
        onClose();
      }
    },
    [commit, onClose],
  );

  return (
    <span className={cx(styles.nameEdit, "nodrag", "nopan")}>
      <input
        ref={inputRef}
        className={styles.nameInput}
        data-testid={`node-name-input-${nodeId}`}
        type="text"
        aria-label="Node name"
        aria-invalid={error !== null}
        value={draft}
        maxLength={120}
        // §V20 — the press belongs to the field, not to the node under it: without this,
        // dragging to select the text drags the node across the canvas.
        onPointerDown={(event) => event.stopPropagation()}
        onMouseDown={(event) => event.stopPropagation()}
        onDoubleClick={(event) => event.stopPropagation()}
        onChange={(event) => {
          setDraft(event.target.value);
          setError(null);
        }}
        onKeyDown={onKeyDown}
        onBlur={() => {
          void commit();
        }}
      />
      {error === null ? null : (
        <span className={styles.nameError} role="alert" data-testid={`node-name-error-${nodeId}`}>
          {error}
        </span>
      )}
    </span>
  );
}

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
