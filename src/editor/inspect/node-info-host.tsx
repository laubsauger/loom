import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { ReactNode } from "react";
import type { CompiledGraph } from "@compiler/index.ts";
import type { LoomBus } from "@domain/commands/bus.ts";
import type { NodeId } from "@domain/types/ids.ts";
import type { NodeRegistryView } from "@nodes/registry/registry.ts";
import type { TelemetrySource } from "@runtime/telemetry/index.ts";
import type { NodeRuntimeSource } from "@editor/graph-canvas/index.ts";
import { useOptionalKeymap } from "@editor/keymap/index.ts";
import { resolveMenuTarget } from "@editor/menus/index.ts";
import {
  RESET_PREVIEW_VIEW_COMMAND,
  SET_PREVIEW_VIEW_COMMAND,
  previewViewStoreFor,
} from "@editor/viewer/index.ts";
import type { PreviewLens } from "@runtime/previews/index.ts";
import { PopoverAnchor, PopoverContent, PopoverRoot } from "@ui/index.ts";
import { registerNodeInfoCommand } from "./command.ts";
import type { NodeInfoAnchor } from "./command.ts";
import { watchMiddleClick } from "./middle-click.ts";
import { buildNodeInfo } from "./node-info-model.ts";
import { NodeInfoPopup } from "./node-info-popup.tsx";

/**
 * The node info surface (T145, §V85, §V19, §V52, §V78).
 *
 * ONE popup for the whole pane, opened by ONE command. The three routes the spec asks for
 * — TouchDesigner's middle click, a keymap binding, a context-menu item — all reduce to
 * `ui.showNodeInfo` on the bus, so they cannot drift into three slightly different
 * surfaces. This component registers the command's handler and owns nothing else.
 *
 * ## What it reads (§V85)
 *
 * The document snapshot the bus already exposes, the compiled plan the app already holds,
 * the per-node runtime channel the canvas already publishes, and the telemetry hub's
 * already-coalesced snapshot. It opens no channel of its own, performs no readback (§V7),
 * and executes no command other than the one that opened it.
 *
 * The one subscription it does hold is to the telemetry hub's <= 10 Hz notification, and
 * only while the popup is open — so an open popup repaints at the same rate as every
 * other metric surface, and a closed one costs nothing (§V16).
 *
 * ## Keyboard (§V19)
 *
 * Radix owns Escape-to-close and the focus scope. Focus RESTORATION is done explicitly
 * because there is no trigger element to restore to: the popup is anchored to a point or
 * to a node's box, so we remember what had focus when it opened and put it back.
 */

export interface NodeInfoHostProps {
  readonly bus: LoomBus;
  readonly registry: NodeRegistryView;
  /** The plan currently running, or null before the first successful compile. */
  readonly compiled: CompiledGraph | null;
  /** Telemetry hub read side. Omitted, every timing field reads unavailable (§V86). */
  readonly telemetry?: TelemetrySource | null | undefined;
  /** The canvas's per-node runtime channel. */
  readonly runtime?: NodeRuntimeSource | null | undefined;
  /**
   * `BackendStatus.stale` — the output is running the last program that compiled (§V9).
   *
   * A PROGRAM-level fact passed from the composition root, because the per-node runtime
   * channel cannot carry it honestly: the flag flips in the frame loop while that channel
   * is published at compile (B36).
   */
  readonly outputStale?: boolean | undefined;
  /**
   * What a bare `ui.showNodeInfo` with no `nodeId` should describe: the selected node.
   * The middle-click route never needs this — it resolves from the click.
   */
  readonly fallbackNodeId?: NodeId | null | undefined;
  /** The surface middle clicks are watched on. */
  readonly children: ReactNode;
}

interface OpenState {
  readonly nodeId: NodeId;
  readonly anchor: NodeInfoAnchor | null;
}

/** Reads the anchor rect of a node already on the canvas, for the keyboard route. */
function anchorForNode(host: HTMLElement | null, nodeId: NodeId): NodeInfoAnchor | null {
  const root = host?.ownerDocument ?? null;
  if (root === null) return null;
  // React Flow's own DOM contract, the same one the context menu resolves against.
  const escaped = typeof CSS !== "undefined" && typeof CSS.escape === "function" ? CSS.escape(nodeId) : nodeId;
  const element = root.querySelector(`.react-flow__node[data-id="${escaped}"]`);
  if (element === null) return null;
  const rect = element.getBoundingClientRect();
  return { x: rect.left + rect.width / 2, y: rect.bottom };
}

export function NodeInfoHost({
  bus,
  registry,
  compiled,
  telemetry,
  runtime,
  outputStale = false,
  fallbackNodeId,
  children,
}: NodeInfoHostProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState<OpenState | null>(null);
  const restoreFocusTo = useRef<HTMLElement | null>(null);
  const fallbackRef = useRef<NodeId | null>(fallbackNodeId ?? null);
  fallbackRef.current = fallbackNodeId ?? null;

  const show = useCallback(
    (nodeId: NodeId | undefined, anchor: NodeInfoAnchor | undefined): NodeId | null => {
      const target = nodeId ?? fallbackRef.current;
      if (target === null || target === undefined) return null;
      const active = hostRef.current?.ownerDocument.activeElement ?? null;
      restoreFocusTo.current = active instanceof HTMLElement ? active : null;
      setOpen({ nodeId: target, anchor: anchor ?? anchorForNode(hostRef.current, target) });
      return target;
    },
    [],
  );

  // Register the command once per bus and keep the live handler in its holder. The bus
  // has no unregister, so the holder — not the registration — is what a remount replaces.
  useEffect(() => {
    const holder = registerNodeInfoCommand(bus);
    holder.current = { show };
    return () => {
      if (holder.current?.show === show) holder.current = null;
    };
  }, [bus, show]);

  // TouchDesigner's middle click. The watcher classifies click vs drag and never consumes
  // the pointer events, so whatever ends up owning middle-drag pan keeps working.
  useEffect(() => {
    const element = hostRef.current;
    if (element === null) return;
    return watchMiddleClick(element, (event) => {
      const start = event.target instanceof Element ? event.target : null;
      const resolved = resolveMenuTarget(start, { boundary: element });
      if (resolved === null || resolved.surface === "canvas") return;
      const nodeId =
        resolved.surface === "node" || resolved.surface === "port" || resolved.surface === "parameter"
          ? resolved.nodeId
          : null;
      if (nodeId === null) return;
      show(nodeId, { x: event.clientX, y: event.clientY });
    });
  }, [show]);

  const close = useCallback(() => {
    setOpen(null);
  }, []);

  return (
    <div ref={hostRef} data-node-info-host="">
      {children}
      {open === null ? null : (
        <NodeInfoPopover
          state={open}
          bus={bus}
          registry={registry}
          compiled={compiled}
          telemetry={telemetry ?? null}
          runtime={runtime ?? null}
          outputStale={outputStale}
          onClose={close}
          restoreFocusTo={restoreFocusTo}
        />
      )}
    </div>
  );
}

interface NodeInfoPopoverProps {
  readonly state: OpenState;
  readonly bus: LoomBus;
  readonly registry: NodeRegistryView;
  readonly compiled: CompiledGraph | null;
  readonly telemetry: TelemetrySource | null;
  readonly runtime: NodeRuntimeSource | null;
  readonly outputStale: boolean;
  readonly onClose: () => void;
  readonly restoreFocusTo: { current: HTMLElement | null };
}

/**
 * Split out so the telemetry subscription exists only while the popup is open — a closed
 * popup must not hold a metric subscription at all (§V16).
 */
function NodeInfoPopover({
  state,
  bus,
  registry,
  compiled,
  telemetry,
  runtime,
  outputStale,
  onClose,
  restoreFocusTo,
}: NodeInfoPopoverProps) {
  const { nodeId, anchor } = state;

  // Both of these are ALREADY-coalesced channels: the telemetry hub notifies at <= 10 Hz
  // and the canvas runtime store at <= 10 Hz. Subscribing here adds no new sampling rate.
  const telemetryVersion = useSyncExternalStore(
    useCallback(
      (listener: () => void) => telemetry?.subscribe(listener) ?? (() => {}),
      [telemetry],
    ),
    useCallback(() => telemetry?.snapshot() ?? null, [telemetry]),
    useCallback(() => telemetry?.snapshot() ?? null, [telemetry]),
  );
  const runtimeSnapshot = useSyncExternalStore(
    useCallback(
      (listener: () => void) => runtime?.subscribe(nodeId, listener) ?? (() => {}),
      [runtime, nodeId],
    ),
    useCallback(() => runtime?.get(nodeId), [runtime, nodeId]),
    useCallback(() => runtime?.get(nodeId), [runtime, nodeId]),
  );

  /**
   * The preview lens (T336) — read from the bus-scoped store, written by executing a command.
   *
   * The dispatch is `bus.execute` with the keymap's invocation context, which is exactly what
   * `useRunCommand` does; it is inlined rather than called because that hook throws outside a
   * `<KeymapProvider>` and this popup is renderable from a fixture with no provider at all
   * (§V85's whole point). With no provider and no registered command, `onLens` stays
   * undefined and the section does not render — a control that cannot act is not shown (§V90).
   */
  const lensStore = previewViewStoreFor(bus);
  const lens = useSyncExternalStore(
    useCallback((listener: () => void) => lensStore.subscribe(nodeId, listener), [lensStore, nodeId]),
    useCallback(() => lensStore.get(nodeId), [lensStore, nodeId]),
    useCallback(() => lensStore.get(nodeId), [lensStore, nodeId]),
  );
  const invocation = useOptionalKeymap()?.invocationContext ?? null;
  const lensAvailable = invocation !== null && bus.hasCommand(SET_PREVIEW_VIEW_COMMAND);
  const onLens = useCallback(
    (patch: Partial<PreviewLens>) => {
      if (invocation === null) return;
      void bus.execute(SET_PREVIEW_VIEW_COMMAND, { nodeId, ...patch }, invocation);
    },
    [bus, invocation, nodeId],
  );
  const onLensReset = useCallback(() => {
    if (invocation === null) return;
    void bus.execute(RESET_PREVIEW_VIEW_COMMAND, { nodeId }, invocation);
  }, [bus, invocation, nodeId]);

  const graph = bus.store.getGraph();
  const info = useMemo(
    () =>
      buildNodeInfo({
        nodeId,
        graph,
        registry,
        compiled,
        runtime: runtimeSnapshot,
        telemetry,
        outputStale,
      }),
    // `telemetryVersion` is the snapshot identity the hub hands out; it changes once per
    // metric tick and is what makes this recompute at <= 10 Hz rather than per frame.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [nodeId, graph, registry, compiled, runtimeSnapshot, telemetry, telemetryVersion, outputStale],
  );

  return (
    <PopoverRoot
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <PopoverAnchor asChild>
        <span
          aria-hidden="true"
          style={
            anchor === null
              ? { position: "fixed", left: "50%", top: "50%" }
              : { position: "fixed", left: `${anchor.x}px`, top: `${anchor.y}px` }
          }
        />
      </PopoverAnchor>
      <PopoverContent
        aria-label={`Node info for ${info.label}`}
        onCloseAutoFocus={(event) => {
          // No trigger element to return to, so put focus back where it was by hand.
          event.preventDefault();
          restoreFocusTo.current?.focus();
        }}
      >
        <NodeInfoPopup
          info={info}
          lens={lens}
          {...(lensAvailable ? { onLens, onLensReset } : {})}
        />
      </PopoverContent>
    </PopoverRoot>
  );
}
