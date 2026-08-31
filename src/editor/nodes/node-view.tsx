import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { RefObject } from "react";
import type {
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
} from "react";
import { Handle, NodeResizer, Position, useUpdateNodeInternals } from "@xyflow/react";
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
import type { NodeId } from "@domain/types/ids.ts";
import { MIN_NODE_SIZE } from "@domain/types/graph.ts";
import { previewablePort } from "@domain/graph/previewable.ts";
import { incomingEdgesInOrder, variadicHandleId } from "@domain/graph/edge-order.ts";
import type { GraphDocument } from "@domain/types/graph.ts";
import { publishesValueChannels } from "@domain/types/node-definition.ts";
import type { PortDefinition } from "@domain/types/ports.ts";
import { useGraphCanvas, useNodeRuntime } from "@editor/graph-canvas/canvas-context.ts";
import type {
  NodeToggleCommand,
  PreviewInspectSource,
  PreviewLensSource,
} from "@editor/graph-canvas/canvas-context.ts";
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
    previewInspect,
    previewLens,
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

  const portsRef = useRef<HTMLDivElement | null>(null);
  useHandleBoundsInSync(id, portsRef);

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
  /**
   * T675: non-null only where the compiler published an orbit for this node's preview —
   * pointset and geometry syntheses and the scene stocks, never a texture output and
   * never a CAMERA payload, whose tile draws through the payload's own matrix (§T639(a)).
   * The composition root answers; this file does not infer 3D-ness from a node type.
   */
  const inspect = hasPreview ? (previewInspect?.(id) ?? null) : null;
  /** T685: §V70a's "this picture is not the node's output" warning, same seam shape. */
  const lens = hasPreview ? (previewLens?.(id) ?? null) : null;
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
          {lens === null ? null : <PreviewLensMark nodeId={id} source={lens} />}
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
          {/*
            T675 — the preview's inspection camera, LAST in the row on purpose.

            It is here rather than at the tile's corner because the shared preview surface
            composites over everything inside a node (see `canvas-context.ts` — z-index 30
            against the viewport's 2, in stacking contexts no local number can bridge), so
            a control drawn on the tile is invisible exactly when the tile is live, which
            is exactly when there is something to inspect. The header is chrome nothing is
            ever composited over.

            LAST because it is the one toggle that comes and goes: it is offered only where
            the compiler published an orbit, and a suspended preview publishes none (T669).
            At the end of the row its arrival and departure move nothing else, so P, B and M
            stay where the hand expects them.
          */}
          {inspect === null ? null : <PreviewInspectToggle nodeId={id} source={inspect} />}
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

        <div className={styles.ports} ref={portsRef}>
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
              .map((port) =>
                // T695: a variadic input is N sockets plus a spare, not one socket that
                // swallows everything. See `VariadicPortRows`.
                port.variadic === true ? (
                  <VariadicPortRows key={port.id} nodeId={id as NodeId} port={port} />
                ) : (
                  <PortRow key={port.id} port={port} side="input" />
                ),
              )}
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
  /** Only where a test has to find ONE of these among the row (T675's inspect toggle). */
  testId?: string;
}

/**
 * §V20 — the classic node-editor bug: a press on an embedded control starts a node drag
 * or a canvas pan, and the control never sees the gesture. Two independent guards, since
 * either alone has a hole: React Flow's own `nodrag`/`nopan` opt-out classes, and
 * stopping the pointer press from reaching the node wrapper's drag listener at all.
 * The click itself is left to bubble, so pressing a toggle still selects its node.
 */
function NodeToggle({ label, title, short, pressed, onToggle, testId }: NodeToggleProps) {
  const swallowPress = useCallback((event: ReactPointerEvent<HTMLButtonElement>) => {
    event.stopPropagation();
  }, []);

  return (
    <button
      type="button"
      className={cx(styles.toggle, "nodrag", "nopan")}
      {...(testId === undefined ? {} : { "data-testid": testId })}
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

/**
 * T656/T664/T675 — the preview inspection toggle: HOME ↔ ADJUSTABLE.
 *
 * Three earlier decisions survive the move out of the tile, and one is dropped.
 *
 * SURVIVES — it is the affordance AND the indicator, with no second badge beside it
 * (T613's answer). SURVIVES — one box in both states, so pressing it cannot reflow the
 * control: that was T664's finding, and using the header's own `NodeToggle` gets it for
 * free rather than re-deriving a square from the type scale. SURVIVES — state by TONE,
 * which `aria-pressed` already drives here (`--bg-active` + `--signal`) on the same
 * pressed/unpressed reading as P, B and M.
 *
 * DROPPED — the orbit-ring GLYPH. It was a 10px SVG chosen because a word changed width;
 * a one-letter mono label in a 14px box does not, and `C` reads in the row's own language
 * instead of introducing a second one. The letter is what P/B/M taught the user to look
 * for, and this control's whole bug was that nobody could find it.
 *
 * §V527: no bus, no command, no revision — the source is the pane's inspection store and
 * an inspection camera is view state. `useSyncExternalStore` on this node's own slice, so
 * adjusting one preview re-renders one toggle.
 */
function PreviewInspectToggle({ nodeId, source }: { nodeId: NodeId; source: PreviewInspectSource }) {
  const read = useCallback(() => source.mode(nodeId), [source, nodeId]);
  const mode = useSyncExternalStore(
    useCallback((listener: () => void) => source.subscribe(nodeId, listener), [source, nodeId]),
    read,
    read,
  );
  return (
    <NodeToggle
      label="Adjust this preview's camera"
      // Labels, not prose (§V90/§V91). The MODIFIER is named because it is the path that
      // needs no chrome at all, and a user who never finds this button should still be
      // able to learn it from the one place they will hover.
      title={
        mode === "adjustable"
          ? "Adjusting — press, or h over the tile, to return home"
          : "Adjust camera (or alt on tile): drag orbits, shift pans"
      }
      short="C"
      testId={`preview-inspect-${nodeId}`}
      pressed={mode === "adjustable"}
      onToggle={() => source.setMode(nodeId, mode === "adjustable" ? "home" : "adjustable")}
    />
  );
}

/**
 * T685 — the preview LENS marker, in the header rather than on the picture.
 *
 * §V70a's argument is why it exists at all: a display transform that outlives the
 * inspection HIDES WHICH NODE IS WRONG, so a preview being shown through a lens has to
 * say so. §V633 is why it is here: it used to sit in the tile's bottom-right corner, which
 * the shared preview surface composites over — so the warning was legible only on a
 * preview that was NOT live, i.e. only when there was no altered picture to warn about.
 * That is the worst possible place for it, and it is not a matter of degree: the toggle's
 * version of this bug cost the user a control, this one cost them a true statement.
 *
 * BEFORE the status badge and the timing, not after: this is a claim about what the
 * picture IS, and it should be read before anything about how the picture is doing. It
 * renders only while a lens is set (§V90 — the quiet case stays quiet), and its arrival is
 * the direct consequence of an act the user just performed, so the reflow is legible
 * rather than mysterious.
 */
function PreviewLensMark({ nodeId, source }: { nodeId: NodeId; source: PreviewLensSource }) {
  const read = useCallback(() => source.marker(nodeId), [source, nodeId]);
  const marker = useSyncExternalStore(
    useCallback((listener: () => void) => source.subscribe(nodeId, listener), [source, nodeId]),
    read,
    read,
  );
  if (marker === null) return null;
  return (
    <span
      className={styles.lensMark}
      data-testid={`preview-lens-${nodeId}`}
      title={`Preview filtered: ${marker} — the node's output is unchanged`}
    >
      {marker}
    </span>
  );
}

/**
 * KEEP REACT FLOW'S CACHED HANDLE BOUNDS EQUAL TO THE HANDLES THE BROWSER DREW (T694).
 *
 * React Flow draws an edge to `node.internals.handleBounds` — a per-node CACHE of where
 * each socket sat when it was last measured — and it refreshes that cache from a
 * `ResizeObserver` on the NODE ELEMENT. That observer is the whole of its coverage, and
 * it has one blind spot, which is the bug:
 *
 *   **a handle can move while the node's own box does not change.**
 *
 * A `ResizeObserver` sees nothing then, the cache keeps the old rectangle, and the wire
 * lands where the socket used to be. This is not hypothetical and it is not rare — it is
 * the ordinary state of a node the user has RESIZED, which is exactly what the owner
 * reported. Once `node.size` is set the outer box is FIXED and `.preview` absorbs every
 * change of the content around it (§V117), so from then on the ports block slides up and
 * down inside a box that never resizes: a diagnostic row appearing below it, a port row
 * arriving on a variadic input (T695), a definition that gains or loses a socket. On an
 * unsized node the same reflow changes the node's height and the observer catches it,
 * which is why this only shows up after a resize.
 *
 * MEASURED, both halves (`src/tests/e2e/handle-alignment.spec.ts`): a plain resize drifts
 * by 0px in @xyflow/react 12.11.5 — the observer really does cover it — and a 30px shift
 * of the ports block inside an unchanged box drifts by exactly 30px.
 *
 * ## Why it measures rather than listing its triggers
 *
 * Naming the things that move a handle is how this bug comes back: the list is open, and
 * the next entry is added by someone editing the JSX with no idea this file exists. So
 * the effect runs after EVERY render of this node and asks the browser the same question
 * React Flow's own measurement asks — where is each handle, relative to the node. If the
 * answer changed, the cache is stale, whatever caused it.
 *
 * ## Why it is guarded rather than unconditional
 *
 * `updateNodeInternals` walks the node lookup and notifies the store on every call, and
 * this component re-renders on the runtime channel at up to 10 Hz (§V16). Calling it
 * unconditionally would put an O(nodes) pass behind every GPU-timing tick on every node
 * on the canvas — trading a geometry bug for a performance one. The signature below is a
 * handful of integers read from a layout React has just committed.
 *
 * Offsets are relative to the node and divided by the live scale, so neither panning nor
 * zooming the canvas — which move and scale every rect on screen without moving one
 * handle inside its node — can make this fire.
 */
function useHandleBoundsInSync(id: string, portsRef: RefObject<HTMLElement | null>): void {
  const updateNodeInternals = useUpdateNodeInternals();
  const measured = useRef<string | null>(null);

  const sync = useCallback(() => {
    const ports = portsRef.current;
    const nodeElement = ports?.closest<HTMLElement>(".react-flow__node");
    if (ports === null || nodeElement === null || nodeElement === undefined) return;

    const base = nodeElement.getBoundingClientRect();
    // The viewport's CSS transform is on an ancestor, so every rect here is in screen
    // pixels. `offsetWidth` is the same box unscaled, which makes the ratio the zoom.
    const scale = nodeElement.offsetWidth > 0 ? base.width / nodeElement.offsetWidth : 1;
    const signature = [...ports.querySelectorAll<HTMLElement>(".react-flow__handle")]
      .map((dot) => {
        const rect = dot.getBoundingClientRect();
        const x = Math.round((rect.x - base.x) / scale);
        const y = Math.round((rect.y - base.y) / scale);
        return `${dot.dataset["handleid"] ?? ""}@${String(x)},${String(y)}`;
      })
      .join("|");

    if (signature === measured.current) return;
    // The FIRST measurement is recorded but not published: React Flow measures the node
    // itself on mount, so re-asking on the first frame would be one wasted store pass per
    // node on every document open.
    const first = measured.current === null;
    measured.current = signature;
    if (!first) updateNodeInternals(id);
  }, [id, portsRef, updateNodeInternals]);

  useLayoutEffect(sync);

  /*
   * The second watcher, and it is not belt-and-braces — the two see different things.
   *
   * The effect above runs when THIS component renders, and `NodeView` is memoised on
   * purpose (§V16): a child that holds its own subscription can re-render alone. That is
   * exactly what `VariadicPortRows` does, so the gesture that adds a port row — the T695
   * one, and the one most likely to move a handle — never reaches the parent at all.
   * Measured: without this observer the second wire into a variadic input lands on the
   * FIRST socket, because React Flow resolves the drop against bounds that still describe
   * a port with one socket in it.
   *
   * A `ResizeObserver` on the ports block sees any child's row arriving or leaving; the
   * render-time effect sees the block MOVING inside a node whose box is fixed, which no
   * resize observer anywhere can see. Neither covers the other.
   */
  useEffect(() => {
    const ports = portsRef.current;
    if (ports === null || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(sync);
    observer.observe(ports);
    return () => {
      observer.disconnect();
    };
  }, [portsRef, sync]);
}

/**
 * A VARIADIC INPUT IS N SOCKETS PLUS A SPARE (T695).
 *
 * One socket taking every wire has no address the user can aim at, so the only gesture it
 * supports is "add another" — which is the owner's report: "attaches multiple nodes to the
 * same connector ... prevents us from drop replacing new connections onto existing ones".
 * With a socket per edge the drop finally has a target: land on an occupied one and it
 * REPLACES that wire, land on the spare and it appends and a new spare appears. The
 * identity of a socket — slot k is the edge whose `order` is k — is worked out in
 * `domain/graph/edge-order.ts`, which is also where the reasoning lives.
 *
 * Its own subscription, returning a NUMBER: this re-renders when the count of wires into
 * THIS port changes and not when anything else in the document does (§V16). The count is
 * taken from `incomingEdgesInOrder` rather than from a private filter, so the row count and
 * the slot each edge is drawn to cannot come from two different readings of the same
 * document (§V487).
 */
function VariadicPortRows({ nodeId, port }: { nodeId: NodeId; port: PortDefinition }) {
  const { store } = useGraphCanvas();
  const connected = useStore(
    store,
    useCallback(
      (state: { graph: GraphDocument }) => incomingEdgesInOrder(state.graph, nodeId, port.id).length,
      [nodeId, port.id],
    ),
  );
  return (
    <>
      {Array.from({ length: connected + 1 }, (_unused, slot) => (
        <PortRow key={slot} port={port} side="input" slot={slot} occupied={slot < connected} />
      ))}
    </>
  );
}

interface PortRowProps {
  port: PortDefinition;
  side: "input" | "output";
  /** Which socket of a variadic port this row is. Absent on an ordinary port. */
  slot?: number;
  /** T695 — false for the spare socket at the end, which is drawn quieter (§V90). */
  occupied?: boolean;
}

/**
 * One port. The dot is React Flow's connection handle, coloured by port family (§V26) —
 * the same token the edges leaving it use, which is what makes the colour readable as a
 * type rather than as decoration.
 */
const PortRow = memo(function PortRow({ port, side, slot, occupied }: PortRowProps) {
  const description = describePortType(port.type);
  // A variadic socket is addressed by slot, and the projection stamps the SAME id on the
  // edge that lands there (`derive.ts`). An ordinary port stays its own plain id, so no
  // document and no existing handle id changes shape (§V68).
  const handleId = slot === undefined ? port.id : variadicHandleId(port.id, slot);
  const label = slot === undefined ? port.label : `${port.label} ${String(slot + 1)}`;
  return (
    <li
      className={cx(styles.port, side === "input" ? styles.portIn : styles.portOut)}
      data-kind={port.type.kind}
      data-slot={slot}
      data-empty={slot !== undefined && occupied !== true ? true : undefined}
      style={cssVars({ "--port-color": portFamilyColor(port.type.kind) })}
    >
      <Handle
        type={side === "input" ? "target" : "source"}
        position={side === "input" ? Position.Left : Position.Right}
        id={handleId}
        className={styles.handle}
        // V19 — reachable and named. The connect *gesture* is pointer-only until the
        // keymap track lands a keyboard binding for it (T76/T77).
        tabIndex={0}
        aria-label={`${side === "input" ? "Input" : "Output"} port ${label}, ${description}`}
        // A LABEL, not prose (§V90/§V91): the spare socket says it is spare and stops. What
        // it affords — drop here to add, drop on a filled one to replace — is the gesture
        // itself, and a sentence pinned to every variadic port in the graph is the chrome
        // this project keeps deleting.
        title={slot === undefined || occupied === true ? `${label} — ${description}` : `${label} — ${description}, empty`}
        isConnectable
      />
      <span className={styles.portLabel}>{label}</span>
    </li>
  );
});
