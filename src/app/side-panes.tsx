import { useCallback, useEffect, useMemo, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from "react";
import { isDeclaredSink } from "@compiler/index.ts";
import type { CompiledGraph } from "@compiler/index.ts";
import type { UnknownParameter } from "@domain/project/index.ts";
import type { RuntimeDiagnostic } from "@domain/types/diagnostics.ts";
import type { GraphDocument } from "@domain/types/graph.ts";
import type { NodeId } from "@domain/types/ids.ts";
import type { ChannelResolver } from "@domain/parameters/resolve.ts";
import { Inspector } from "@editor/inspector/index.ts";
import type { InputResolution } from "@editor/inspector/index.ts";
import { KEYMAP_CONTEXT_ATTRIBUTE } from "@editor/keymap/index.ts";
import { ContextMenuHost } from "@editor/menus/index.ts";
import { NodeLibrary } from "@editor/library/index.ts";
import type { PortDragQuery } from "@editor/library/index.ts";
import type { ShaderloomBackend } from "@runtime/backend/index.ts";
import { normalizedPointer } from "@runtime/execution/index.ts";
import type { PointerRect, PointerSource } from "@runtime/execution/index.ts";
import { usePixelReadout } from "@editor/viewer/index.ts";
import type { PixelReadoutOptions } from "@editor/viewer/index.ts";
import type { PixelProbe } from "@runtime/previews/index.ts";
import { useAppRuntime } from "./app-context.ts";
import { useOutputPresentation } from "./use-output-presentation.ts";
import type { GraphActions, PortDragOrigin } from "./graph-pane.tsx";
import type { GpuStatus } from "./gpu-status.ts";
import styles from "./panes.module.css";

/** The three panes around the canvas: catalogue, inspector, viewer. */

export interface LibraryPaneProps {
  portDrag: PortDragOrigin | null;
  onClearPortDrag: () => void;
  actions: () => GraphActions | null;
}

export function LibraryPane({ portDrag, onClearPortDrag, actions }: LibraryPaneProps) {
  const { registry } = useAppRuntime();
  const definitions = useMemo(() => [...registry.list()], [registry]);

  // The library filters on the port TYPE and the end being dragged; which node the drag
  // started from is the canvas's business (§V13).
  const query = useMemo<PortDragQuery | null>(
    () => (portDrag === null ? null : { type: portDrag.type, direction: portDrag.direction }),
    [portDrag],
  );

  const onAddNode = useCallback(
    (type: string, connectTo?: Parameters<GraphActions["addNode"]>[1]) => {
      actions()?.addNode(type, connectTo);
    },
    [actions],
  );

  return (
    <div className={styles.fill}>
      <NodeLibrary
        definitions={definitions}
        portDrag={query}
        onAddNode={onAddNode}
        onClearPortDrag={onClearPortDrag}
      />
    </div>
  );
}

export interface InspectorPaneProps {
  nodeId: NodeId | null;
  graph: GraphDocument;
  compiled: CompiledGraph | null;
  diagnostics: readonly RuntimeDiagnostic[];
  /**
   * The compile's own channel resolver (B46, §V61) — see `Inspector`'s prop. Passed
   * straight through: this pane invents no resolver of its own, because a second one is
   * the bug B8 recorded.
   */
  channels?: ChannelResolver;
  status: GpuStatus;
  /** Values the open file carried that this build cannot read (§V68, §V69). */
  unknownParameters?: readonly UnknownParameter[];
}

/**
 * Resolved size and format of whatever feeds each input of `nodeId`.
 *
 * The Common section needs this to answer "inherit from input" honestly (§V50, §V51).
 * It comes from the compiled plan, which is the only thing that knows — the document
 * stores overrides, not results.
 */
function inputResolutionsFor(
  nodeId: NodeId | null,
  graph: GraphDocument,
  compiled: CompiledGraph | null,
  ports: readonly { id: string; label: string }[],
): InputResolution[] {
  if (nodeId === null) return [];
  const upstream = new Map<string, { nodeId: NodeId; portId: string }>();
  for (const edge of Object.values(graph.edges)) {
    if (edge.target.nodeId !== nodeId) continue;
    upstream.set(edge.target.portId, edge.source);
  }

  return ports.map((port) => {
    const source = upstream.get(port.id);
    if (source === undefined) return { portId: port.id, label: port.label, connected: false };
    const output = compiled?.outputs.find(
      (candidate) => candidate.nodeId === source.nodeId && candidate.portId === source.portId,
    );
    if (output === undefined) return { portId: port.id, label: port.label, connected: true };
    return {
      portId: port.id,
      label: port.label,
      connected: true,
      size: { width: output.size[0], height: output.size[1] },
      format: output.format,
    };
  });
}

export function InspectorPane({
  nodeId,
  graph,
  compiled,
  diagnostics,
  channels,
  status,
  unknownParameters = [],
}: InspectorPaneProps) {
  const { bus, invocation, registry, settings } = useAppRuntime();

  const node = nodeId === null ? undefined : graph.nodes[nodeId];
  const definition = node === undefined ? undefined : registry.get(node.type);
  const inputs = useMemo(
    () => (definition?.inputs ?? []).map((port) => ({ id: port.id, label: port.label })),
    [definition],
  );

  const inputResolutions = useMemo(
    () => inputResolutionsFor(nodeId, graph, compiled, inputs),
    [compiled, graph, inputs, nodeId],
  );

  const unknownHere = useMemo(
    () => (nodeId === null ? [] : unknownParameters.filter((entry) => entry.nodeId === nodeId)),
    [nodeId, unknownParameters],
  );

  if (unknownHere.length > 0 && nodeId !== null) {
    return (
      <div
        className={styles.scrollFill}
        data-testid="inspector-scroll"
        {...{ [KEYMAP_CONTEXT_ATTRIBUTE]: "inspector" }}
      >
        <FutureParameters nodeId={nodeId} unknown={unknownHere} />
      </div>
    );
  }

  // `scrollFill`, not `fill`: a node with twenty parameters is taller than the right dock,
  // and a pane that grows past its dock has its overflow clipped rather than scrolled —
  // the parameters below the fold simply cannot be reached. See `panes.module.css`.
  /**
   * T246 — the parameter menu is mounted HERE, and nowhere else.
   *
   * §V78 asks for ONE root per surface with the target resolved from the event, which is
   * exactly what `ContextMenuHost` does; it had no mount anywhere in the app, so every
   * menu the menus track built was unreachable (the shape of B12/B23, §V193). No
   * `fallbackSurface`: a right-click on the pane's chrome rather than on a parameter row
   * should open nothing at all, not a menu for a parameter nobody clicked.
   */
  return (
    <ContextMenuHost bus={bus}>
      <div
        className={styles.scrollFill}
        data-testid="inspector-scroll"
        {...{ [KEYMAP_CONTEXT_ATTRIBUTE]: "inspector" }}
      >
        <Inspector
          bus={bus}
          context={invocation}
          nodeId={nodeId}
          settings={settings}
          diagnostics={diagnostics}
          capabilities={status.kind === "ready" ? { formats: status.capabilities.formats } : undefined}
          inputResolutions={inputResolutions}
          {...(channels === undefined ? {} : { channels })}
        />
      </div>
    </ContextMenuHost>
  );
}

/**
 * A node whose parameters this build cannot read (§V68, §V69, §T139).
 *
 * `loadProject` reports these and keeps the values byte-for-byte; the one thing that must
 * NOT happen is a control rendered over them. A slider does not know the value is a
 * shape it has never seen — it falls back to the definition's default, shows a number
 * that was never in the file, and the first drag writes that number over the user's data
 * on the next save. So the pane says what is true and offers nothing to drag.
 *
 * This is per-NODE rather than per-parameter because `Inspector` has no way to be told
 * "render every control except this one". The precise ask for that track is an
 * `unresolvedParameters?: readonly string[]` prop; until then, suppressing the node's
 * controls is the conservative reading of §V69 and the only one available from here.
 */
function FutureParameters({
  nodeId,
  unknown,
}: {
  nodeId: NodeId;
  unknown: readonly UnknownParameter[];
}) {
  return (
    <div className={styles.viewer} data-testid="future-parameters">
      <section className={styles.block} aria-label="Parameters from a newer version">
        <h3 className={styles.blockTitle}>set by a newer version</h3>
        <p className={styles.note}>
          {nodeId} carries {unknown.length === 1 ? "a parameter value" : "parameter values"} written
          by a newer build of Shaderloom. {unknown.length === 1 ? "It is" : "They are"} kept exactly
          as saved and written back unchanged, so nothing is lost — but this build cannot
          show a control over {unknown.length === 1 ? "it" : "them"} without inventing a value.
        </p>
        <ul className={styles.list}>
          {unknown.map((entry) => (
            <li key={entry.key} className={styles.row}>
              <span className={styles.rowName}>{entry.key}</span>
              <span className={styles.rowValue}>
                {entry.kind === undefined ? "unreadable value" : `kind: ${entry.kind}`}
              </span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

/** Stable identity of a resolved output — the selector's value and its label. */
function outputKey(output: { nodeId: string; portId: string }): string {
  return `${output.nodeId}:${output.portId}`;
}

/** A sampled channel, in the project's LINEAR working space (§V56). */
function formatChannel(value: number): string {
  if (Number.isNaN(value)) return "NaN";
  if (!Number.isFinite(value)) return value > 0 ? "+Inf" : "-Inf";
  return value.toFixed(4);
}

export interface ViewerPaneProps {
  compiled: CompiledGraph | null;
  /** Needed only to tell a declared Output node from a preview sink — see below. */
  graph: GraphDocument;
  /** The live backend, when there is one. The runtime is handed the surface (§V64). */
  backend?: ShaderloomBackend | null;
  /**
   * THE pointer source (T324, §V182, §V236). The viewer is the one publisher.
   *
   * It publishes here and nowhere else — never the graph canvas, never a window listener —
   * because a shader reading `pointer` means "where in the PICTURE", and this canvas is the
   * picture. Two sources for one device drift by a frame and the CPU and GPU halves of one
   * graph then disagree about where the cursor is (§V182).
   */
  pointer?: PointerSource | null;
  /**
   * Pixel inspection through the export interface (§V48, T36). Absent with no backend, in
   * which case the readout says so rather than showing a plausible zero.
   */
  probe?: PixelProbe | undefined;
  /** Injected by the readout tests to drive its rate limiter. */
  readoutOptions?: PixelReadoutOptions;
}

/**
 * The viewer (§I.ui, T87/T161, §V64, §V70).
 *
 * A content surface shows content, or names its empty state (§V91, §V92a) — device and
 * build diagnostics (tier, formats, memory, reuse) belong on the performance surface
 * instead (`PerformancePane`, `dock-panes.tsx`).
 *
 * The picture is a presentation surface HANDED to the runtime, never a canvas React
 * draws into (§V64): `backend.present(canvas, { outputId })` attaches it and the runtime
 * blits into it with every frame (§V7 — GPU to GPU, no readback). The canvas is never
 * remounted when the pane moves (T193), so the presentation survives being dragged to
 * another dock or floated into its own window, which is what §V64's "opening or closing a
 * pane must not stall the output" requires — and the same seam multi-window perform mode
 * (T110) is built on.
 *
 * Which output: the graph's DECLARED sink, not simply the first resolved output. Every
 * visible texture node is a preview sink (§V28b), so `compiled.outputs` is the whole
 * graph; showing its first entry would put an arbitrary intermediate node on the viewer.
 * With no Output node there is nothing to show, and the pane says so.
 */
export function ViewerPane({
  compiled,
  graph,
  backend = null,
  pointer = null,
  probe,
  readoutOptions,
}: ViewerPaneProps) {
  const { registry } = useAppRuntime();
  const outputs = useMemo(() => compiled?.outputs ?? [], [compiled]);

  const sink = useMemo(() => {
    for (const output of outputs) {
      const type = graph.nodes[output.nodeId]?.type;
      const definition = type === undefined ? undefined : registry.get(type);
      if (definition !== undefined && isDeclaredSink(definition)) return output;
    }
    return null;
  }, [graph, outputs, registry]);

  /**
   * Which output is on screen (T329, T36).
   *
   * The DECLARED sink is still the default, for the reason the note above gives — every
   * visible texture node is a preview sink (§V28b), so defaulting to the first resolved
   * output would put an arbitrary intermediate on the viewer. What the selector adds is the
   * ability to say otherwise: repointing is `setOutput` (§V70), which is why it costs a
   * uniform-sized change and not a re-attach.
   */
  const [pinnedKey, setPinnedKey] = useState<string | null>(null);
  const selected = useMemo(() => {
    if (pinnedKey !== null) {
      const match = outputs.find((output) => outputKey(output) === pinnedKey);
      // A pinned output the graph no longer produces must not leave the surface pointing
      // at a resource that has been freed; falling back to the sink is the safe answer.
      if (match !== undefined) return match;
    }
    return sink;
  }, [outputs, pinnedKey, sink]);

  const { canvasRef } = useOutputPresentation(backend, selected?.resourceId ?? null);
  /**
   * The probe's target, keyed on PRIMITIVES.
   *
   * `compiled.outputs` is a fresh array on every compile, so a memo keyed on the resolved
   * output object would hand `usePixelReadout` a new `ref` after every recompile — and its
   * reset-on-new-output effect would wipe the sample and the cursor each time. The user
   * would see the readout blink out whenever anything in the graph changed, which looks
   * like the probe failing rather than like the pane working correctly.
   */
  const selectedNodeId = selected?.nodeId ?? null;
  const selectedPortId = selected?.portId ?? null;
  const selectedRef = useMemo(
    () =>
      selectedNodeId === null || selectedPortId === null
        ? null
        : { nodeId: selectedNodeId, portId: selectedPortId },
    [selectedNodeId, selectedPortId],
  );

  /**
   * Publishing the cursor (T324, §V236).
   *
   * The canvas fills its surface exactly, so the element's own box IS the picture's box and
   * normalising against it needs no letterbox arithmetic. `buttons` rides the same events,
   * so a press with no movement still reaches a shader.
   *
   * There is deliberately NO `onPointerLeave`. §V236 says the pointer HOLDS its last
   * position when the cursor goes elsewhere, and holding is the absence of a write: zero is
   * a VALID position, so resetting here would snap every mouse-driven effect to the corner
   * the instant the cursor crossed into the inspector — a jump that reads as a bug in the
   * user's own graph. If someone adds a reset here later, that is the bug they will cause.
   *
   * §V16 is safe by construction: this writes into a plain object the frame loop samples.
   * No React state, so a 120 Hz pointer costs zero renders.
   */
  /**
   * Pixel inspection (T36, §V7, §V48).
   *
   * `usePixelReadout` is the rate limiter: one read per 100 ms and one in flight at a time,
   * so a pointer moving at 120 Hz produces ten reads a second and never a frame grab. It
   * was written for a pane nothing mounted; this is that pane's job now.
   */
  const readout = usePixelReadout(probe, selectedRef, readoutOptions ?? {});
  const { probeAt, clear } = readout;
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null);

  const probePixel = useCallback(
    (x: number, y: number) => {
      setCursor({ x, y });
      probeAt(x, y);
    },
    [probeAt],
  );

  /** Client point -> IMAGE pixel, using the same rect the pointer is normalised against. */
  const pixelAt = useCallback(
    (clientX: number, clientY: number, box: PointerRect): { x: number; y: number } | null => {
      if (selected === null) return null;
      const normalized = normalizedPointer({ x: clientX, y: clientY }, box);
      if (normalized === null) return null;
      const [width, height] = selected.size;
      return {
        x: Math.min(width - 1, Math.max(0, Math.floor(normalized.x * width))),
        y: Math.min(height - 1, Math.max(0, Math.floor(normalized.y * height))),
      };
    },
    [selected],
  );

  const publishPointer = useCallback(
    (event: ReactPointerEvent<HTMLCanvasElement>) => {
      if (pointer === null) return;
      const box = event.currentTarget.getBoundingClientRect();
      const normalized = normalizedPointer({ x: event.clientX, y: event.clientY }, box);
      if (normalized === null) return;
      pointer.set({ x: normalized.x, y: normalized.y, buttons: event.buttons });
    },
    [pointer],
  );

  /**
   * ONE handler, two jobs (§V182).
   *
   * The cursor is published for shaders and probed for the readout from the SAME event on
   * the SAME element. A second listener would be a second source for one device, and the
   * two would disagree by a frame about where the cursor is.
   */
  const onCanvasPointer = useCallback(
    (event: ReactPointerEvent<HTMLCanvasElement>) => {
      publishPointer(event);
      const pixel = pixelAt(event.clientX, event.clientY, event.currentTarget.getBoundingClientRect());
      if (pixel !== null) probePixel(pixel.x, pixel.y);
    },
    [pixelAt, probePixel, publishPointer],
  );

  /**
   * §V19 — the readout is reachable without a pointer. Arrow keys walk the probe cursor
   * over the image (shift = 10 px), which is the only way a keyboard user can inspect a
   * value at all. Deliberately NOT published to `pointer`: a shader's cursor is where the
   * mouse is, and inventing one from the keyboard would make Mouse lie.
   */
  const onCanvasKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLCanvasElement>) => {
      if (selected === null) return;
      const step = event.shiftKey ? 10 : 1;
      const [width, height] = selected.size;
      const from = cursor ?? { x: Math.floor(width / 2), y: Math.floor(height / 2) };
      let dx = 0;
      let dy = 0;
      if (event.key === "ArrowLeft") dx = -step;
      else if (event.key === "ArrowRight") dx = step;
      else if (event.key === "ArrowUp") dy = -step;
      else if (event.key === "ArrowDown") dy = step;
      else return;
      event.preventDefault();
      probePixel(
        Math.min(width - 1, Math.max(0, from.x + dx)),
        Math.min(height - 1, Math.max(0, from.y + dy)),
      );
    },
    [cursor, probePixel, selected],
  );

  // A new output invalidates the sample on screen: the number belonged to the old picture.
  useEffect(() => {
    setCursor(null);
    clear();
  }, [clear, selectedRef]);

  return (
    <div className={styles.viewer} {...{ [KEYMAP_CONTEXT_ATTRIBUTE]: "viewer" }}>
      <div className={styles.bar}>
        <label className={styles.barLabel} htmlFor="viewer-output">
          output
        </label>
        <select
          id="viewer-output"
          data-testid="viewer-output-select"
          className={styles.select}
          value={selected === null ? "" : outputKey(selected)}
          onChange={(event) => setPinnedKey(event.target.value === "" ? null : event.target.value)}
          disabled={outputs.length === 0}
        >
          {outputs.length === 0 ? <option value="">no outputs</option> : null}
          {outputs.map((output) => (
            <option key={outputKey(output)} value={outputKey(output)}>
              {outputKey(output)}
              {sink !== null && outputKey(sink) === outputKey(output) ? " (output)" : ""}
            </option>
          ))}
        </select>
      </div>

      <div className={styles.surface} data-testid="viewer-surface">
        {selected === null ? (
          <p className={styles.note}>No output</p>
        ) : (
          <canvas
            ref={canvasRef}
            className={styles.canvas}
            aria-label="Rendered output"
            data-testid="viewer-canvas"
            tabIndex={0}
            onPointerMove={onCanvasPointer}
            onPointerDown={onCanvasPointer}
            onPointerUp={onCanvasPointer}
            onKeyDown={onCanvasKeyDown}
          />
        )}
      </div>

      <dl className={styles.readout} data-testid="viewer-readout">
        <dt className={styles.rowName}>pixel</dt>
        <dd className={styles.rowValue}>
          {cursor === null ? "—" : `${cursor.x}, ${cursor.y}`}
        </dd>
        <dt className={styles.rowName}>value</dt>
        <dd className={styles.rowValue}>
          {readout.error !== null
            ? readout.error
            : readout.sample === null
              ? probe === undefined
                ? "no device"
                : "—"
              : readout.sample.rgba.map(formatChannel).join("  ")}
        </dd>
      </dl>
      <dl className={styles.readout} aria-label="Resolved output">
        <dt className={styles.rowName}>size</dt>
        <dd className={styles.rowValue}>
          {selected === null
            ? "—"
            : `${selected.size[0]} × ${selected.size[1]} · ${selected.format}`}
        </dd>
      </dl>
    </div>
  );
}
