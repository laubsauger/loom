import { renderRangeHolderFor } from "./render-range.ts";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { isComponentNodeType } from "@domain/components/component-type.ts";
import { previewablePort } from "@domain/graph/previewable.ts";
import { viewCameraAbsentReason } from "@domain/geometry/view-camera.ts";
import type {
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
} from "react";
import { DRAG_THRESHOLD_PX } from "@ui/controls/drag-math.ts";
import { flattenedNodeId, presentsPicture } from "@compiler/index.ts";
import type { CompiledGraph } from "@compiler/index.ts";
import type { UnknownParameter } from "@domain/project/index.ts";
import type { RuntimeDiagnostic } from "@domain/types/diagnostics.ts";
import type { GraphDocument } from "@domain/types/graph.ts";
import { previewCameraAbsenceSentence } from "@compiler/preview-orbit.ts";
import { POSE_MOVED_FROM_ITS_TILE } from "@editor/viewer/camera-pose.ts";
import type { NodeId } from "@domain/types/ids.ts";
import type { ChannelResolver } from "@domain/parameters/resolve.ts";
import type { InstanceChannelSources } from "@domain/parameters/node-references.ts";
import type { FrameInputs } from "@domain/types/backend.ts";
import { ComponentPage, InspectorSubjects } from "@editor/component/index.ts";
import type { GraphComponentDefinition } from "@domain/types/components.ts";
import type { ComponentRegistryView } from "@domain/components/registry.ts";
import { Inspector } from "@editor/inspector/index.ts";
import type { InstanceParameters } from "@editor/inspector/instance-parameters.ts";
import type { InputResolution, MidiSectionSurface, PlannedOutput } from "@editor/inspector/index.ts";
import { useKeymapPane } from "@editor/keymap/index.ts";
import { ContextMenuHost } from "@editor/menus/index.ts";
import { NodeLibrary } from "@editor/library/index.ts";
import type { PortDragQuery } from "@editor/library/index.ts";
import type { LoomBackend } from "@runtime/backend/index.ts";
import { normalizedPointer } from "@runtime/execution/index.ts";
import type { PointerRect, PointerSource } from "@runtime/execution/index.ts";
import { fitInsideRegion } from "@editor/nodes/preview-fit.ts";
import { usePixelReadout, ViewerAxisGizmo } from "@editor/viewer/index.ts";
import type { PixelReadoutOptions } from "@editor/viewer/index.ts";
import type { PreviewOrbitStore } from "@editor/viewer/index.ts";
import { ORBIT_REFERENCE_WIDTH, orbitDeltaFor, zoomFactorFor } from "@editor/viewer/orbit-gestures.ts";
import type { FlyAxis } from "@editor/viewer/orbit-gestures.ts";
import type { OrbitCameraBasis, PixelProbe } from "@runtime/previews/index.ts";
import { Button } from "@ui/primitives/button.tsx";
import { Tooltip } from "@ui/primitives/tooltip.tsx";
import { useAppRuntime } from "./app-context.ts";
import { useFullscreenSurface } from "./fullscreen-commands.ts";
import { registerViewerCommands } from "./viewer-commands.ts";
import { useOutputPresentation } from "./use-output-presentation.ts";
import type { ScreenCaptureWiring } from "./use-screen-sources.ts";
import { useViewerSynthesis } from "./use-viewer-synthesis.ts";
import { useNativeOutput } from "./use-native-output.ts";
import { nativeOutputSelectionOf } from "@devices/native-output.ts";
import { colorPolicyOf } from "@domain/color/display.ts";
import { useViewCameraOverride } from "./use-view-camera.ts";
import { useViewerMapping, VIEWER_MAPPING_HINT, VIEWER_MAPPING_HINT_ON } from "./use-viewer-mapping.ts";
import type { LiveReads } from "./perform-mapping.ts";
import { cx } from "@ui/cx.ts";
import { useViewerFly } from "./use-viewer-fly.ts";
import {
  flyCameraHint,
  flyCameraLabel,
  flyingCameraSentence,
  useViewerCameraLock,
  type ViewerCameraLock,
} from "./use-viewer-camera-lock.ts";
import { NO_CAMERA_TO_FLY, VIEWER_NO_CAMERA_MESSAGE } from "./viewer-commands.ts";
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
  /*
   * Components are DELIBERATELY absent from the node library.
   *
   * Installing a component registers it as a node definition — that is how an instance
   * is created at all — so `registry.list()` returns it alongside the built-ins and the
   * library showed every component TWICE: once here and once in the Components tab,
   * which owns them and offers save/copy/upgrade that this pane cannot. The structural
   * test is `isComponentNodeType` (`component:<id>@<version>`), not a category string
   * somebody has to remember to set.
   */
  const definitions = useMemo(
    () => registry.list().filter((definition) => !isComponentNodeType(definition.type)),
    [registry],
  );

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
  /** T1531b: the whole canvas selection, primary last — the bank section adds the rest as targets. */
  selection?: readonly NodeId[];
  /**
   * Set while the editor is INSIDE a component (T423): the definition being edited, and
   * the catalogue to watch for changes to it.
   *
   * T1192 — the page editor no longer sits ABOVE the node inspector. It used to, on the
   * grounds that "both are true at once — you are editing a component AND you have one of
   * its nodes selected, and publishing a parameter needs to see both". Both are still
   * true; one scroll box was the wrong way to say it. Measured on E47's `DepthPoints_1`:
   * 2092px of component page above the selected node's first parameter, in a 366px pane.
   * The two are SUBJECTS now, one at a time, behind `InspectorSubjects` — and the publish
   * rows still see the selected node, because they live on the component page beside the
   * knobs they create.
   */
  /** T1065 — the registry view, ALWAYS (not only inside a dive): the instance's
   *  Component section (version/upgrade/enter/detach) and the Common page's inner
   *  preview picker both read it, and both exist at the root. REQUIRED on purpose —
   *  the section's predecessor sat unmounted behind an optional prop nothing supplied
   *  (§V844), so the threading is now the type checker's problem, not a test's. */
  components: ComponentRegistryView;
  componentPage?: {
    definition: GraphComponentDefinition;
    components: ComponentRegistryView;
  };
  graph: GraphDocument;
  compiled: CompiledGraph | null;
  /**
   * T1202 — where `graph` SITS, so the plan lookups below can spell an id the plan holds.
   *
   * The same prop `GraphPane` takes, for the same reason and under the same rule
   * (§T1019/§T1031): the canvas and the inspector speak INNER ids, while everything keyed
   * off the compiled/flattened document speaks PREFIXED ones. Absent or empty = the root
   * graph, where the two spellings are identical — which is exactly why the bug was
   * invisible from outside a component for six months.
   */
  componentPath?: readonly NodeId[];
  instanceParameters?: InstanceParameters;
  diagnostics: readonly RuntimeDiagnostic[];
  /**
   * The compile's own channel resolver (B46, §V61) — see `Inspector`'s prop. Passed
   * straight through: this pane invents no resolver of its own, because a second one is
   * the bug B8 recorded.
   */
  channels?: ChannelResolver;
  /**
   * T893: reads the LAST RENDERED frame, so a driven parameter's field can show what is
   * on screen instead of its zero-frame resolution. Passed straight through and sampled
   * inside the panel at <=10 Hz (§V16) — this pane never calls it.
   */
  latestFrame?: (() => FrameInputs | null) | undefined;
  /**
   * T990: the channel names a node publishes right now, so `op('lfo1').chan.` completes.
   * Passed straight through — this pane enumerates nothing itself, for the same reason it
   * invents no resolver.
   */
  channelNames?: ((nodeName: string) => readonly string[]) | undefined;
  /** T1485b: the component instances `op('…').chan` can name. Passed straight through. */
  instanceChannels?: (() => InstanceChannelSources) | undefined;
  status: GpuStatus;
  /** Values the open file carried that this build cannot read (§V68, §V69). */
  unknownParameters?: readonly UnknownParameter[];  /** T434(b)/T432: the session audio capture's status, for the Inspector's Audio section. */
  audioStatus?: () => { kind: "idle" | "live" | "error"; message?: string };
  /**
   * T1043: what a webcam node's camera was asked for and what it granted, read live for
   * the Inspector's Camera section. Passed straight through; this pane measures nothing.
   */
  cameraStatus?: (nodeId: NodeId) => import("@/app/camera-request.ts").CameraStatus | null;
  screenCapture?: ScreenCaptureWiring;
  /** T1397b: the names phones are sending cameras under now, for the Webcam's device picker. */
  phoneCameras?: readonly string[];
  /**
   * T942: the session's ONE Web MIDI access, for the Inspector's MIDI section — its state,
   * its ports, its permission request and its learn arming. Absent = no session MIDI
   * wiring (tests, embeds), and the section is then hidden the way the Audio one is.
   */
  midi?: MidiSectionSurface;
  /** T950: the laser SESSION surface, for the Inspector's Laser section on laserOut. */
  laser?: import("@editor/inspector/laser-section.tsx").LaserSectionSurface;
  /** §T1391b: the perform windows, for the Inspector's Window section on Window Out. */
  performWindows?: import("@editor/inspector/window-section.tsx").WindowSectionSurface;
}

/**
 * Resolved size and format of whatever feeds each input of `nodeId`.
 *
 * The Common section needs this to answer "inherit from input" honestly (§V50, §V51).
 * It comes from the compiled plan, which is the only thing that knows — the document
 * stores overrides, not results.
 *
 * T1202 — `graph` is the graph THE PANE IS SHOWING, so its edges name inner ids, while
 * `compiled` is the flattened plan. Every upstream node id therefore crosses through
 * `flattenedNodeId` before it is looked up; without that these rows read "connected" with
 * no size for every input of every node inside a component. See `flatPrefix` below.
 */
function inputResolutionsFor(
  nodeId: NodeId | null,
  graph: GraphDocument,
  compiled: CompiledGraph | null,
  ports: readonly { id: string; label: string }[],
  flatPrefix: string,
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
    const sourceInPlan = flattenedNodeId(flatPrefix, source.nodeId);
    const output = compiled?.outputs.find(
      (candidate) => candidate.nodeId === sourceInPlan && candidate.portId === source.portId,
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

/**
 * T1064 — the node's OWN row in the plan: the size and format it actually got.
 *
 * The sibling of `inputResolutionsFor` above, and it exists for the same reason: the
 * document stores overrides, not results, and the panel had been RE-DERIVING the results
 * from the overrides with its own copy of the compiler's ladder. Two copies of one rule
 * disagreed twice — on every device below the project cap, and on every format that fell
 * back — so the panel now reads instead.
 *
 * FIRST row, not a search: every output a node materializes shares that node's one
 * resolved resolution and format (`compiler/compile.ts` computes both once per node and
 * writes them into each slot), so any row answers, and the first is the one that exists.
 * `undefined` when the node has no row at all — PRUNED, or nothing compiled yet — which
 * the readout reports as "not in the compiled plan" rather than papering over.
 *
 * T1202/§B189 — "inside a component" USED TO BE ON THAT LIST, and it was never a state:
 * it was this function asking the flattened plan for a raw inner id. Measured on E47:
 * `matte` matched no row while `cut/matte` returned `1280x720 rgba16float`. The readout
 * told the owner an interior node was not in the plan while it was in the plan, and he
 * spent an investigation on a component-system defect that did not exist. The excuse in
 * this docblock is what kept anyone from questioning the message, so it is stated the
 * other way round now: if this returns `undefined` for a node you can see on the canvas,
 * the node is genuinely absent from the plan.
 */
function plannedOutputFor(
  nodeId: NodeId | null,
  compiled: CompiledGraph | null,
  flatPrefix: string,
): PlannedOutput | undefined {
  if (nodeId === null || compiled === null) return undefined;
  const inPlan = flattenedNodeId(flatPrefix, nodeId);
  return compiled.outputs.find((candidate) => candidate.nodeId === inPlan);
}

export function InspectorPane({
  nodeId,
  selection,
  components,
  componentPage,
  graph,
  compiled,
  componentPath,
  instanceParameters,
  diagnostics,
  channels,
  latestFrame,
  channelNames,
  instanceChannels,
  status,
  unknownParameters = [],
  audioStatus,
  cameraStatus,
  screenCapture,
  phoneCameras,
  midi,
  laser,
  performWindows,
}: InspectorPaneProps) {
  const { bus, invocation, registry, settings, flattened } = useAppRuntime();
  // T1550b: the one flattened document, so an instance lists the files it actually reads.
  const readFlattened = useCallback(() => flattened.current(), [flattened]);
  // §V351/B67: the pane that declares a context must be able to hold focus, or clicking
  // it leaves the GRAPH holding the keys — including `delete`.
  const paneRef = useRef<HTMLDivElement | null>(null);
  const paneProps = useKeymapPane<HTMLDivElement>("inspector", paneRef);

  const node = nodeId === null ? undefined : graph.nodes[nodeId];
  const definition = node === undefined ? undefined : registry.get(node.type);
  const inputs = useMemo(
    () => (definition?.inputs ?? []).map((port) => ({ id: port.id, label: port.label })),
    [definition],
  );

  /* T1019/T1031/T1202 — this pane's flat prefix, spelled the way `graph-pane.tsx` spells
     it: the inspector shows the graph the canvas shows, so it speaks INNER ids, and every
     lookup below that goes to the compiled/flattened document must prefix them. */
  const flatPrefix = (componentPath ?? []).join("/");
  /* T1202 — the id this node has IN THE PLAN, for the two lookups keyed off flat state:
     the plan's own rows (here) and the compiler's diagnostics (inside `Inspector`, which
     filters them by node for the "clamped"/"unsupported format" flags on this very
     readout). Identical to `nodeId` at the root. */
  const planNodeId = nodeId === null ? null : flattenedNodeId(flatPrefix, nodeId);

  const inputResolutions = useMemo(
    () => inputResolutionsFor(nodeId, graph, compiled, inputs, flatPrefix),
    [compiled, flatPrefix, graph, inputs, nodeId],
  );

  // T1064: the answer the Common readout shows, taken from the plan rather than re-derived.
  const planned = useMemo(
    () => plannedOutputFor(nodeId, compiled, flatPrefix),
    [compiled, flatPrefix, nodeId],
  );

  const unknownHere = useMemo(
    () => (nodeId === null ? [] : unknownParameters.filter((entry) => entry.nodeId === nodeId)),
    [nodeId, unknownParameters],
  );

  if (unknownHere.length > 0 && nodeId !== null) {
    return (
      <div {...paneProps} className={styles.scrollFill} data-testid="inspector-scroll">
        <FutureParameters nodeId={nodeId} unknown={unknownHere} />
      </div>
    );
  }

  const nodeInspector = (
    <Inspector
      bus={bus}
      // T1652b: this pane's own document (live for what it shows), so the panel renders when the pane does.
      graph={graph}
      context={invocation}
      components={components}
      flattened={readFlattened}
      nodeId={nodeId}
      settings={settings}
      diagnostics={diagnostics}
      capabilities={
        status.kind === "ready"
          ? {
              formats: status.capabilities.formats,
              // The device ceiling, so the size readout clamps the way the plan does.
              // Was omitted, and the panel showed sizes no node on this device has.
              maxTextureDimension2D: status.capabilities.limits["maxTextureDimension2D"],
            }
          : undefined
      }
      inputResolutions={inputResolutions}
      planned={planned ?? null}
      {...(planNodeId === null ? {} : { planNodeId })}
      {...(instanceParameters === undefined ? {} : { instanceParameters })}
      {...(channels === undefined ? {} : { channels })}
      {...(latestFrame === undefined ? {} : { latestFrame })}
      {...(channelNames === undefined ? {} : { channelNames })}
      {...(instanceChannels === undefined ? {} : { instanceChannels })}
      {...(audioStatus === undefined ? {} : { audioStatus })}
      {...(cameraStatus === undefined ? {} : { cameraStatus })}
      {...(screenCapture === undefined ? {} : { screenCapture })}
      {...(phoneCameras === undefined ? {} : { phoneCameras })}
      {...(midi === undefined ? {} : { midi })}
      {...(laser === undefined ? {} : { laser })}
      {...(performWindows === undefined ? {} : { performWindows })}
      {...(selection === undefined ? {} : { selection })}
    />
  );

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
      <div {...paneProps} className={styles.scrollFill} data-testid="inspector-scroll">
        {componentPage === undefined ? (
          nodeInspector
        ) : (
          /*
           * T1192 — inside a component the pane has two subjects and shows one. `node` is
           * resolved against the COMPONENT's graph, not merely non-null: diving in leaves
           * the selection pointing at the instance, whose id belongs to the document one
           * level out, and a bare null check would open an empty node panel on the way in.
           */
          <InspectorSubjects
            component={{ name: componentPage.definition.name }}
            node={
              node === undefined
                ? null
                : { id: node.id, name: node.label ?? node.id }
            }
            componentPage={
              <ComponentPage
                bus={bus}
                context={invocation}
                definition={componentPage.definition}
                components={componentPage.components}
                nodes={registry}
                selectedNodeId={nodeId}
              />
            }
            nodeInspector={nodeInspector}
          />
        )}
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
          by a newer build of Loom. {unknown.length === 1 ? "It is" : "They are"} kept exactly
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
  /** T1655b: the newest values of the installed rows, for a synthesized subject (`live-synthesis.ts`). */
  liveOutputs?: (() => CompiledGraph["outputs"] | null) | undefined;
  /**
   * Needed to tell a declared Output node from a preview sink — see below — and, §T1536b,
   * as the AUTHORED document the Edit mapping layer reads its targets from (live: the app
   * hands `useGraphCompile`'s subscription, so a drag's write comes back through here).
   */
  graph: GraphDocument;
  /** The live backend, when there is one. The runtime is handed the surface (§V64). */
  backend?: LoomBackend | null;
  /**
   * THE pointer source (T324, §V182, §V236). The viewer is the one publisher.
   *
   * It publishes here and nowhere else — never the graph canvas, never a window listener —
   * because a shader reading `pointer` means "where in the PICTURE", and this canvas is the
   * picture. Two sources for one device drift by a frame and the CPU and GPU halves of one
   * graph then disagree about where the cursor is (§V182).
   *
   * T405: with the pane tree, SEVERAL viewer instances may hold this same source. That is
   * deliberate last-writer-wins — whichever picture the cursor is over is the picture
   * "pointer" means — and it must stay ONE source: per-viewer pointer sources would make
   * one graph read two cursors in one frame, which is §V182's drift with extra steps.
   * Do not "fix" this into a source per instance.
   */
  pointer?: PointerSource | null;
  /**
   * Pixel inspection through the export interface (§V48, T36). Absent with no backend, in
   * which case the readout says so rather than showing a plausible zero.
   */
  probe?: PixelProbe | undefined;
  /** Injected by the readout tests to drive its rate limiter. */
  readoutOptions?: PixelReadoutOptions;
  /**
   * T379 — the app's SHARED inspection-orbit store (the graph pane's tiles hold the
   * same one). When the selected output is a synthesized 3D preview the compiler marked
   * orbitable, the viewer surface owns orbit/pan/zoom gestures on it — view state only
   * (§V255): no document revision, no dirty flag, nothing downstream changes.
   */
  orbits?: PreviewOrbitStore | undefined;
  /**
   * §B220 — the viewer's own preview SINK, and it is not the same thing as `interest`.
   *
   * `interest` is a PIN: it keeps a tile the graph canvas already materialised alive. It is
   * consumed by `useNodePreviews`, which runs in the GRAPH PANE ONLY — so with that pane
   * closed the viewer's selection reached nothing at all. A sink is the other half: it is
   * what makes the compiler SYNTHESISE a preview for a row that has none (§V309 — "off costs
   * nothing: no pass, no target, no bytes"). A camera, light, geometry, material or pointset
   * node has no main-program target ever, so without this the viewer had nothing to show and
   * no way to ask for it.
   */
  previewSinks?: { set(refs: ReadonlyArray<{ nodeId: string; portId: string }>): void } | undefined;
  /** Preview cadence and tile size, defaulted to `graph-pane.tsx`'s own values (§B220). */
  previewFps?: number;
  previewLongEdge?: number;
  /** T756: publishes which node this viewer is presenting — the graph pane's request
   *  assembler pins it, so a hidden tile keeps rendering under the viewer's gaze. */
  interest?: import("@editor/viewer/index.ts").PreviewInterestStore | undefined;
  /**
   * §T1539b — the app's live reads (§T1525b: the frame last rendered, the compile's channels,
   * the morphs in flight), which Edit mapping resolves a driven Corner Pin with, exactly as a
   * perform window does. REQUIRED, as on the window: an optional getter is how a reader ends
   * up resolving without it.
   */
  liveReads: LiveReads;
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
 *
 * `presentsPicture`, not `isDeclaredSink`: Analyze and Laser Out are declared sinks too,
 * and the `$target` the compiler synthesizes for them is written by nothing. E14 names
 * its Analyze `meter` and its Output `out`, `plan.outputs` is ordered by node id, and
 * this loop therefore put an unwritten texture on the viewer — a black frame with no
 * diagnostic, and (through `interest`, below) the preview crash that read as NO SIGNAL
 * on every node in the graph.
 */
export function ViewerPane({
  compiled,
  liveOutputs,
  graph,
  backend = null,
  pointer = null,
  probe,
  readoutOptions,
  orbits,
  interest,
  previewSinks,
  previewFps = 20,
  previewLongEdge = 192,
  liveReads,
}: ViewerPaneProps) {
  // T726: `documentIdentity` — WHICH document the pin below was made in. Taken from the
  // runtime because the runtime IS the loaded document (`adoptDocument`, `app.tsx`).
  const { bus, documentIdentity, invocation, registry, settings } = useAppRuntime();
  const outputs = useMemo(() => compiled?.outputs ?? [], [compiled]);
  // Selection is a demand, not evidence that a node is already being cooked.
  // Keep declared preview outputs selectable while visibility prunes their GPU work.
  const choices = useMemo(() => {
    const refs: Array<{ nodeId: string; portId: string }> = [...outputs];
    const keys = new Set(refs.map(outputKey));
    for (const node of Object.values(graph.nodes)) {
      // Instances have no output row of their own after flattening. Their compiled
      // inner outputs remain choices; do not advertise an unresolvable instance key.
      if (isComponentNodeType(node.type)) continue;
      const port = previewablePort(registry.get(node.type)?.outputs ?? []);
      if (port === undefined) continue;
      const ref = { nodeId: node.id, portId: port.id };
      if (!keys.has(outputKey(ref))) refs.push(ref);
    }
    return refs;
  }, [graph, outputs, registry]);

  const sink = useMemo(() => {
    for (const output of outputs) {
      const type = graph.nodes[output.nodeId]?.type;
      const definition = type === undefined ? undefined : registry.get(type);
      if (definition !== undefined && presentsPicture(definition)) return output;
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
   *
   * ## The pin belongs to a DOCUMENT (T726, B106, §V79)
   *
   * A pin is a key — `${nodeId}:${portId}` — and node ids are the names a person typed,
   * so two unrelated projects collide on them constantly: E31 and E32 share TWENTY-ONE
   * ids, E2 and E24 share eleven, and `out` is in all twenty-nine shipped examples. Held
   * as a bare key, a pin therefore SURVIVED a load and re-bound itself to whatever the
   * incoming document happened to call by the same name. Measured in the running app:
   * pin the viewer to `rd:out` in E2-Reaction-Diffusion, open E24-Audio-Reaction-Diffusion,
   * and the selector still reads `rd:out` — the new project's Output node is not what is
   * on screen, and nothing said so. The fallback below cannot see it, because a matching
   * key is exactly what "the pin is still valid" looks like from inside one document.
   *
   * So the pin carries the identity it was made under and is READ THROUGH it. Same
   * correction as `classify-revision.ts`'s `DocumentRevision` and for the same reason: a
   * comparison that cannot distinguish two documents must not be handed the job of
   * deciding whether something from one is valid in the other. Crossing the boundary
   * yields `null`, which is "no pin" — and no pin means the DECLARED SINK, which is what
   * opening a project is supposed to show.
   */
  const [pin, setPin] = useState<{ documentIdentity: string; key: string } | null>(null);
  const pinnedKey = pin !== null && pin.documentIdentity === documentIdentity ? pin.key : null;
  const requested = choices.find((output) => outputKey(output) === pinnedKey) ?? null;
  const setPinnedKey = useCallback(
    (key: string | null) => {
      setPin(key === null ? null : { documentIdentity, key });
    },
    [documentIdentity],
  );
  const selected = useMemo(() => {
    if (pinnedKey !== null) {
      const match = outputs.find((output) => outputKey(output) === pinnedKey);
      // A pinned output the graph no longer produces must not leave the surface pointing
      // at a resource that has been freed; falling back to the sink is the safe answer.
      if (match !== undefined) return match;
      if (requested !== null) return null; // Await materialization, not a different picture.
    }
    return sink;
  }, [outputs, pinnedKey, requested, sink]);

  /**
   * T440/§V354 — `v` points the viewer here.
   *
   * The pane owns `pinnedKey`, so the pane registers the command and fills the holder
   * while it is mounted, exactly as the canvas does for `graph.selectAll`. Reading
   * `outputs` through a ref keeps the handler stable: `compiled.outputs` is a fresh array
   * after every compile, and re-registering on each one would churn the holder for no
   * reason.
   */
  const outputsRef = useRef(choices);
  outputsRef.current = choices;
  const graphNow = useRef(graph);
  graphNow.current = graph;
  /** §T1536b: filled from `useViewerMapping` below, which needs the presentation's key. */
  const editMappingRef = useRef<(on: boolean | undefined) => boolean>(() => false);
  useEffect(() => {
    const holder = registerViewerCommands(bus);
    const handlers = {
      show: (nodeId: string): string | null => {
        /* §T1659b(2): the node's PICTURE, which is the port its tile shows, and only then any
           row at all. The rows are sorted by key, so a Render with Depth Output on answered
           `v` with `depth` (it sorts before `out`): seen on the owner's `render_shot`. */
        const pictureOf = (id: string): (typeof outputsRef.current)[number] | undefined => {
          const type = graphNow.current.nodes[id as NodeId]?.type;
          const port = type === undefined ? undefined : previewablePort(registry.get(type)?.outputs ?? []);
          return port === undefined ? undefined : outputsRef.current.find((output) => output.nodeId === id && output.portId === port.id);
        };
        const match = pictureOf(nodeId) ?? outputsRef.current.find((output) => output.nodeId === nodeId);
        if (match === undefined) return null;
        setPinnedKey(outputKey(match));
        return match.portId;
      },
      /* T380: the keymap's `h`, through a real command so it rebinds and shows in the
         shortcut editor — while the orbit store itself still holds no bus (§V527). */
      cameraHome: (): boolean => {
        const state = orbitStateRef.current;
        // §T970: locked to a camera, `h` LEAVES and writes nothing. Home must never be an
        // edit; the way back from a flown pose is undo.
        if (state.lock.armed) {
          state.lock.set(false);
          return true;
        }
        if (!state.orbitable || state.orbits === undefined || state.nodeId === null) return false;
        state.orbits.setMode(state.nodeId, "home");
        return true;
      },
      /* T379: HOME DERIVES FROM CONTENT. The preview's own position buffer is read back
         once, on this gesture (§V7: a user pressing Frame is a readback that earns
         itself), min/max reduce on the CPU, and the store frames the measured bounds.
         The buffer's dead tail (a counted producer) rides along in v1 — stated, and the
         fit margin absorbs a modest tail; an exact live-count-bounded reduce is the
         follow-up if it ever misleads. */
      frameContent: async (): Promise<boolean> => {
        const state = orbitStateRef.current;
        if (!state.orbitable || state.orbits === undefined || state.nodeId === null) return false;
        const frame = state.frameContent === undefined ? undefined : await state.frameContent();
        if (frame === undefined || state.orbits.frameContent === undefined) return false;
        state.orbits.frameContent(state.nodeId, frame);
        return true;
      },
      /* §T1311b(b): one fly step, for the palette and for an agent. The HELD key never
         comes through here — it is a gesture on the focused pane — but both land in the
         same store through the same arithmetic, so the two cannot drift. */
      fly: (direction: FlyAxis) => orbitStateRef.current.fly(direction),
      /* §T970: `c`, the bar's button and the palette all arm the one lock. The answer names
         the camera, or says why there is none to fly. */
      flyCamera: (on: boolean | undefined) => {
        const { lock: current } = orbitStateRef.current;
        if (current.target === null) return { flying: false, camera: null, refusal: current.refusal ?? NO_CAMERA_TO_FLY };
        return { flying: current.set(on), camera: current.target, refusal: null };
      },
      /* §T1536b (viewer slice): `m`, the bar's toggle and an agent all set the one mode. */
      editMapping: (on: boolean | undefined) => editMappingRef.current(on),
    };
    holder.current = handlers;
    return () => {
      if (holder.current === handlers) holder.current = null;
    };
    // `setPinnedKey` stamps the CURRENT document on the pin (T726), so the handler has to
    // be rebuilt when that changes — `bus` alone would leave `v` writing the closed
    // project's identity onto a pin made in the new one.
  }, [bus, registry, setPinnedKey]);

  /*
   * §B220 — TWO PRESENTATION PATHS, and which one runs is decided by the row itself.
   *
   * `useOutputPresentation` binds a MAIN-PROGRAM target through `backend.present`. A row that
   * carries `synthesis` has no such target — it is drawn by the preview system, which is why
   * it presented nothing here. `synthesisRow` is that case, and it is null for every ordinary
   * texture output, so the second path costs nothing when it is not needed.
   */
  const synthesisRow = selected?.synthesis === undefined ? null : selected;
  const [alphaDisplay, setAlphaDisplay] = useState<"rgba" | "rgb">("rgba");
  const { canvasRef, canvasKey } = useOutputPresentation(
    backend,
    synthesisRow === null ? (selected?.resourceId ?? null) : null,
    alphaDisplay,
  );
  const synthesisCanvasRef = useRef<HTMLCanvasElement | null>(null);
  useViewerSynthesis({
    // The viewer remains on the root runtime even when the graph pane dives into a component.
    isExporting: () => renderRangeHolderFor(bus).current?.busy() === true,
    backend,
    canvasRef: synthesisCanvasRef,
    output: synthesisRow,
    previewFps,
    previewLongEdge,
    alphaDisplay,
    documentIdentity,
    ...(orbits === undefined ? {} : { orbits }),
    liveOutputs,
  });
  // VNB25: what the Output node would show for the pinned output, as the graph's own
  // Syphon/NDI Out nodes send it (`nativeOutputSelectionOf`).
  const nativeSelection = useMemo(
    () => (selected === null ? null : nativeOutputSelectionOf(selected, colorPolicyOf(settings))),
    [selected, settings],
  );
  const nativeOutput = useNativeOutput(backend, nativeSelection, documentIdentity, bus);
  /*
   * §T1536b (viewer slice) — EDIT MAPPING over this picture: the perform window's layer in a
   * host box over the frame (`use-viewer-mapping.ts` decides which node's handles, and the
   * map is this pane's own `fitInsideRegion` letterbox). Rebuilt when the canvas is (a float
   * into another document, T705).
   */
  const mapping = useViewerMapping({
    bus,
    graph,
    registry,
    invocation,
    output: selected === null ? null : { nodeId: selected.nodeId, size: selected.size },
    surfaceKey: canvasKey,
    reads: liveReads,
    plan: compiled,
  });
  editMappingRef.current = mapping.setEditing;
  /**
   * The probe's target, keyed on PRIMITIVES.
   *
   * `compiled.outputs` is a fresh array on every compile, so a memo keyed on the resolved
   * output object would hand `usePixelReadout` a new `ref` after every recompile — and its
   * reset-on-new-output effect would wipe the sample and the cursor each time. The user
   * would see the readout blink out whenever anything in the graph changed, which looks
   * like the probe failing rather than like the pane working correctly.
   *
   * ## And the DOCUMENT is one of those primitives (T733, B106)
   *
   * Those two primitives do not move across a load, and that is the bug: `out:$target` is
   * the declared sink of all twenty-nine shipped examples, so opening any of them over
   * any other leaves `nodeId` and `portId` byte-identical, the memo referentially stable,
   * and every reset that hangs off it asleep — the sample, the cursor, and
   * `usePixelReadout`'s own generation guard, which is what stops a readback issued
   * against the CLOSED project from landing in the new one. The number under "value" then
   * belongs to a picture the user cannot see any more, and it is a NUMBER, so nothing
   * about it looks stale.
   *
   * The document is therefore part of the target's identity even though it is not part of
   * its VALUE. That is what the exemption below buys: the dependency is deliberately not
   * referenced in the body, because what has to change is the object, not the ref.
   */
  const selectedNodeId = selected?.nodeId ?? null;
  const selectedPortId = selected?.portId ?? null;
  const selectedRef = useMemo(
    () =>
      selectedNodeId === null || selectedPortId === null
        ? null
        : { nodeId: selectedNodeId, portId: selectedPortId },
    // §V676 — the rule is right about the BODY and wrong about the claim. A load must
    // mint a new target object so the invalidation effects fire, and there is nothing to
    // reference in the body to say so.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [documentIdentity, selectedNodeId, selectedPortId],
  );

  /**
   * Publishing the cursor (T324, §V236).
   *
   * The canvas fills its PICTURE box exactly (T1158 letterboxes that box inside the pane
   * rather than stretching the canvas across it), so the element's own box IS the picture's
   * box and normalising against it needs no letterbox arithmetic. `buttons` rides the same events,
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

  /**
   * T1346b — WHAT THE PROBE HAS TO SAY, or null when it has nothing.
   *
   * Null is what keeps the readout one line: the coordinate and the value are not rows
   * waiting to be filled, they are absent until a probe produced something (§V91).
   *
   * A COORDINATE ALONE IS NOT SOMETHING. The probe cursor outlives a document swap when
   * the new document's sink happens to carry the same address (§T733's adversarial case —
   * `out:$target` in both), while the sample is invalidated by the readout's own
   * generation guard. Rendering on the cursor would then show a position in a picture
   * nobody has sampled, which is the shape of stale number §T733 exists to prevent. So the
   * pair is rendered only when there is a VALUE to pair with it — a sample, the reason
   * there is none, or the honest "this machine cannot read pixels at all".
   */
  const probeFacts = useMemo((): { at: string; value: string } | null => {
    if (cursor === null) return null;
    const at = `${cursor.x}, ${cursor.y}`;
    if (readout.error !== null) return { at, value: readout.error };
    if (readout.sample !== null) return { at, value: readout.sample.rgba.map(formatChannel).join("  ") };
    // No device is a fact about the machine and worth saying the moment someone probes;
    // "a read is in flight" is not, and neither is "that sample belonged to a document you
    // have closed" — both of those are simply not a reading yet.
    return probe === undefined ? { at, value: "no device" } : null;
  }, [cursor, probe, readout.error, readout.sample]);

  // §T1178: the cursor state is written once per animation frame, not once per pointer
  // event — a 120 Hz pointer was 120 React commits a second for a crosshair that paints
  // at most 60 times. The probe keeps its own 10 Hz limiter.
  const pendingCursor = useRef<{ x: number; y: number } | null>(null);
  const cursorFrame = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (cursorFrame.current !== null) window.cancelAnimationFrame(cursorFrame.current);
    },
    [],
  );
  const probePixel = useCallback(
    (x: number, y: number) => {
      pendingCursor.current = { x, y };
      if (cursorFrame.current === null) {
        cursorFrame.current = window.requestAnimationFrame(() => {
          cursorFrame.current = null;
          if (pendingCursor.current !== null) setCursor(pendingCursor.current);
        });
      }
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
    (event: ReactPointerEvent<HTMLCanvasElement>, box: PointerRect) => {
      if (pointer === null) return;
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
  /**
   * T379 — THE VIEWER'S CAMERA, the owner's own complaint answered where they raised
   * it: "cant use orbit or any camera controls here in this geometry node… this should
   * be something they inherit from a common thing". The common thing is the same
   * arithmetic and the SAME STORE the node tiles use (orbit-gestures.ts + the app's
   * hoisted PreviewOrbitStore): both surfaces show the same preview target per node,
   * so a viewer drag and a tile drag move one camera, and neither ever touches the
   * document (§V255 — looking is not editing; no revision, no dirty flag, no change to
   * anything downstream).
   *
   * The viewer owns its surface outright — no React Flow to negotiate with — so the
   * first drag simply ENTERS adjustable and orbits: no modifier needed (the tile needs
   * alt only because a plain drag there moves the node). Shift-drag pans, the wheel
   * dollies, and the per-pixel feel is normalised by the surface's own width so a full
   * sweep is the same half-turn the 192px tile gives (T561's contract). The pixel
   * readout keeps every one of its events — a drag reads out as it orbits.
   *
   * Only outputs the COMPILER marked orbitable get any of this (synthesis.orbit — the
   * §V437 declaration): a texture output has nothing to orbit, and a camera or
   * projector tile draws through its own matrix, where an override would falsify the
   * one thing the picture exists to show (T614/T675's refusals, honored here too).
   */
  const orbitNodeId = (selected?.nodeId ?? null) as NodeId | null;
  const requestedNodeId = (requested?.nodeId ?? orbitNodeId) as NodeId | null;
  /* T756: publish the presented node as preview interest; clear on unmount and on
     switching away, so a closed viewer stops pinning anything. */
  useEffect(() => {
    if (interest === undefined) return;
    interest.set(requestedNodeId);
    return () => interest.set(null);
  }, [interest, requestedNodeId]);

  /*
   * §B220 — ASK FOR THE PREVIEW, then present it below.
   *
   * Keyed on `requested` rather than on `selected`, and that is the whole reason this works:
   * a scene-payload row DOES NOT EXIST until a sink watches it, so `selected` is undefined for
   * exactly the nodes this fixes. Registering from the resolved output would be a sink that
   * can only ever ask for rows that are already there.
   */
  const requestedKey = requested === null ? null : outputKey(requested);
  useEffect(() => {
    if (previewSinks === undefined) return;
    if (requested === null) {
      previewSinks.set([]);
      return;
    }
    previewSinks.set([{ nodeId: requested.nodeId, portId: requested.portId }]);
    return () => previewSinks.set([]);
    // `requested` is a fresh object per render; its KEY is the identity that matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewSinks, requestedKey]);
  /*
   * §T1311b(a) — AND THE OUTPUTS WHOSE SHADER DECLARED A VIEW CAMERA.
   *
   * The paragraph above is right about scene payloads and was the whole story, which is why
   * the owner's own pieces could not be orbited AT ALL: E55, E57, E68 and E70 are raymarched
   * `customWgsl`, a `customWgsl` output is a TEXTURE payload, so `synthesis.orbit` is absent
   * and the viewer refused — "stuck viewing a video texture", exactly as reported.
   *
   * A `viewCamera` row is the other way an output can honestly offer a camera: its shader
   * OPTED IN by declaring one, and the compiler emitted a VIEWPORT pass to receive it. Same
   * gestures, same store, same never-touches-the-document rule (§V255); what differs is
   * where the values land — an eye/target/fov on a second pass, not a `viewProjection` a
   * marcher could not consume.
   */
  const orbitable =
    orbits !== undefined &&
    orbitNodeId !== null &&
    (selected?.synthesis?.orbit !== undefined || selected?.viewCamera !== undefined);
  /* The delivery half: view state in the store becomes uniforms on the viewport pass. */
  useViewCameraOverride({ backend, output: selected, orbits });
  /*
   * §T1311b(b) — AND THE FLIGHT. One basis for both camera sources, because a fly is the
   * same arithmetic either way: translate the whole rig along the axes the picture is
   * actually pointing down. `synthesis.orbit` already IS an `OrbitCameraBasis`; a
   * `viewCamera` row carries the same four numbers under its own names, and the pass id
   * (which is the only field that differs) belongs to the delivery half above, not here.
   */
  const flyBasis = useMemo<OrbitCameraBasis | null>(() => {
    if (selected?.synthesis?.orbit !== undefined) return selected.synthesis.orbit;
    const camera = selected?.viewCamera;
    if (camera === undefined) return null;
    return { eye: camera.eye, lookAt: camera.lookAt, fovY: camera.fovY, aspect: camera.aspect };
  }, [selected]);
  /*
   * §T970 — THE LOCK. When the picture is drawn through a camera whose pose can be moved,
   * the viewer can be locked to it, and then every gesture below (drag, shift-drag, the
   * wheel, the fly keys) goes to that camera's document-writing store and not to the
   * inspection one. `gesture*` is that one decision, made once, so no handler can route a
   * drag to one store and its wheel to the other.
   */
  const lock = useViewerCameraLock({ bus, invocation, registry, graph, selected });
  const gestureStore = lock.armed ? lock.store : orbits;
  const gestureNodeId = lock.armed ? lock.target : orbitNodeId;
  const gestureLive = lock.armed || orbitable;
  const fly = useViewerFly({ orbits: gestureStore, nodeId: gestureNodeId, basis: !lock.armed && orbitable ? flyBasis : null });
  /*
   * T1655b — WHY THIS 3D PICTURE HAS NO CAMERA HERE, as the tile says it (one fact, one
   * sentence: the compiler's reason on the row). A picture drawn through a node's own Eye
   * and Look At is moved from that node's tile today; flying it from here is §T970.
   */
  const cameraNote = useMemo((): string | null => {
    const control = selected?.previewCamera;
    if (orbitable || selected === null || selected === undefined || control === undefined || control.kind === "orbit") return null;
    // §T970: locked, the one thing to say is that the picture's gestures are edits.
    if (lock.armed) return flyingCameraSentence(lock.name, lock.held);
    if (control.kind === "none") {
      const framed = previewCameraAbsenceSentence(control.reason, (id) => graph.nodes[id]?.label ?? id);
      // A Render whose camera cannot be flown says whose it is AND why not.
      return lock.refusal === null ? framed : `${framed} ${lock.refusal}`;
    }
    // Its own pose: flown from the button beside this line, so there is nothing to add,
    // unless the pose is driven, or the node is not in the document this pane edits.
    if (lock.target !== null) return null;
    return lock.refusal ?? POSE_MOVED_FROM_ITS_TILE;
  }, [graph, lock.armed, lock.held, lock.name, lock.refusal, lock.target, orbitable, selected]);
  /** T379: measure the selected preview's positions — the frame-content readback. */
  const measureBounds = useCallback(async (): Promise<
    { lookAt: readonly [number, number, number]; radius: number } | undefined
  > => {
    if (backend === null || selected?.synthesis === undefined) return undefined;
    const positions = selected.synthesis.passes
      .flatMap((pass) => ("buffers" in pass ? (pass.buffers ?? []) : []))
      .find((binding) => binding.binding === "positions");
    if (positions === undefined) return undefined;
    try {
      /* T1076: `positions` is a REGION of the producer's packed point buffer, so the walk
         starts at the binding's own offset and stops at its end — from byte 0 it would
         measure whatever attribute happens to sit first. */
      const packed = await backend.readBuffer(positions.resourceId);
      const raw =
        positions.offset === undefined || positions.bytes === undefined
          ? new Float32Array(packed)
          : new Float32Array(packed, positions.offset, positions.bytes / 4);
      let minX = Infinity, minY = Infinity, minZ = Infinity;
      let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
      for (let at = 0; at + 2 < raw.length; at += 4) {
        const x = raw[at]!, y = raw[at + 1]!, z = raw[at + 2]!;
        if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
        if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
      }
      if (!Number.isFinite(minX)) return undefined;
      const lookAt: readonly [number, number, number] = [
        (minX + maxX) / 2,
        (minY + maxY) / 2,
        (minZ + maxZ) / 2,
      ];
      const radius = Math.max(maxX - minX, maxY - minY, maxZ - minZ) / 2;
      return { lookAt, radius };
    } catch {
      return undefined;
    }
  }, [backend, selected]);
  /** The command handlers read through a ref so registration stays stable (T440's
      idiom, one shelf over). */
  const orbitStateRef = useRef<{
    orbits: PreviewOrbitStore | undefined;
    nodeId: NodeId | null;
    orbitable: boolean;
    frameContent?: () => Promise<{ lookAt: readonly [number, number, number]; radius: number } | undefined>;
    fly: (direction: FlyAxis) => boolean;
    lock: ViewerCameraLock;
  }>({ orbits, nodeId: orbitNodeId, orbitable, frameContent: measureBounds, fly: fly.step, lock });
  orbitStateRef.current = {
    orbits,
    nodeId: orbitNodeId,
    orbitable,
    frameContent: measureBounds,
    fly: fly.step,
    lock,
  };
  const orbitDrag = useRef<{ pointerId: number; x: number; y: number; pan: boolean } | null>(null);
  const onOrbitDown = useCallback(
    (event: ReactPointerEvent<HTMLCanvasElement>) => {
      if (!gestureLive || gestureStore === undefined || gestureNodeId === null || event.button !== 0) return;
      // The first drag is the way in: the viewer's surface has no competing gesture, so
      // there is nothing for a modifier to disambiguate (the tile's alt stays a tile
      // concern). Entering latches; the keymap's home returns (T380). §T970: a camera the
      // viewer is LOCKED to is armed already, by its button and by nothing else: a drag is
      // never the way into a mode whose every move is an edit.
      gestureStore.setMode(gestureNodeId, "adjustable");
      orbitDrag.current = {
        pointerId: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        pan: event.shiftKey,
      };
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    [gestureLive, gestureStore, gestureNodeId],
  );
  const onOrbitMove = useCallback(
    (event: ReactPointerEvent<HTMLCanvasElement>) => {
      const active = orbitDrag.current;
      if (active === null || active.pointerId !== event.pointerId || gestureStore === undefined || gestureNodeId === null) return;
      const width = event.currentTarget.getBoundingClientRect().width;
      const scale = ORBIT_REFERENCE_WIDTH / Math.max(width, 1);
      gestureStore.apply(
        gestureNodeId,
        orbitDeltaFor(event.clientX - active.x, event.clientY - active.y, { pan: active.pan, scale }),
      );
      active.x = event.clientX;
      active.y = event.clientY;
    },
    [gestureStore, gestureNodeId],
  );
  const onOrbitUp = useCallback(
    (event: ReactPointerEvent<HTMLCanvasElement>) => {
      if (orbitDrag.current?.pointerId !== event.pointerId) return;
      orbitDrag.current = null;
      if (gestureNodeId !== null) gestureStore?.release?.(gestureNodeId);
    },
    [gestureStore, gestureNodeId],
  );
  /* The wheel dollies — non-passive, so the page never scrolls under a zoom. Attached
     only while an orbitable output is selected (§V461: the mode has to turn off). */
  const orbitElement = useRef<HTMLCanvasElement | null>(null);
  /* T1655b: the canvas that is ON SCREEN. A synthesized row (a pointset, a geometry, a
     light, a material) is presented on the second canvas (§B220) and the first is hidden,
     so a listener on the first alone was a listener on nothing. */
  const synthesized = synthesisRow !== null;
  useEffect(() => {
    const element = synthesized ? synthesisCanvasRef.current : orbitElement.current;
    if (element === null || !gestureLive || gestureStore === undefined || gestureNodeId === null) return;
    const onWheel = (event: WheelEvent): void => {
      event.preventDefault();
      gestureStore.setMode(gestureNodeId, "adjustable");
      gestureStore.zoom(gestureNodeId, zoomFactorFor(event.deltaY, event.deltaMode));
    };
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => element.removeEventListener("wheel", onWheel);
  }, [gestureLive, gestureStore, gestureNodeId, canvasKey, synthesized]);

  const onCanvasPointer = useCallback(
    (event: ReactPointerEvent<HTMLCanvasElement>) => {
      // §T1178: ONE layout read per event, shared by the publish and the probe — each used
      // to take its own, two forced layouts per pointer move.
      const box = event.currentTarget.getBoundingClientRect();
      publishPointer(event, box);
      const pixel = pixelAt(event.clientX, event.clientY, box);
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

  /**
   * Fullscreen (T394, §V307).
   *
   * The SURFACE box, not the canvas: the canvas is sized to whatever box it is laid out
   * in, so filling the screen with the box is what gives the picture the whole screen and
   * keeps its letterbox. The element is PUBLISHED to a bus command rather than acted on
   * from here, so the button below, `mod+shift+f` and the palette are one code path
   * (§V29) — and the key is a rebindable row in the default keymap, not an `if` in this
   * component (§V52, §V78).
   */
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const surface = useCallback(() => surfaceRef.current, []);
  useFullscreenSurface(bus, surface);

  /**
   * T1158 — THE PICTURE LETTERBOXES INSIDE THE PANE. IT NEVER STRETCHES.
   *
   * The frame used to be locked at `aspect-ratio: 16 / 9` with the canvas filling it, so
   * the present blit stretched the output into whatever shape the pane happened to be.
   * Set a 720×1280 portrait project and the resolution reads correctly in the inspector,
   * the node tiles preview correctly, and the viewer alone shows a wide, squashed picture
   * — which is exactly the report ("even if I crunch it down it's gonna stay in the
   * initial 16:9 aspect ratio"). The viewer was the ONE surface in the app that stretched:
   * node tiles have letterboxed since §V118, and this file's sibling docblock in
   * `preview-gizmo-overlay.tsx` had already written the divergence down.
   *
   * So this is §V118's OWN function, not a second copy of its arithmetic. `.surface` is
   * now the FRAME and fills the pane; the picture is `fitInsideRegion`'s largest box with
   * the output's aspect that fits inside it, centred — the identical call
   * `use-node-previews.ts` composites every live tile with, so the two surfaces agree by
   * sharing the code rather than by coincidence.
   *
   * NOTHING IS STORED. The aspect is read off the output the compiler resolved, so it
   * follows a resolution swap (T1157) and a per-node override with no second source that
   * could disagree — the same rule §T1064 deleted 180 lines to restore.
   *
   * WHY PIXELS AND NOT AN `aspect-ratio` RULE: a `<canvas>` is a replaced element whose
   * intrinsic size is its backing store, and `use-output-presentation.ts` sizes that
   * backing store FROM the laid-out box. An aspect rule on the canvas would close that
   * loop. The box therefore lands on a plain wrapper, which has no intrinsic size, and the
   * canvas keeps filling it exactly — so the element's own box is still the picture's box
   * and the pointer/probe normalisation below needs no letterbox arithmetic of its own.
   *
   * `canvasKey` is a dependency for `use-output-presentation`'s reason: a ResizeObserver
   * is a per-window object, so a pane floated into a child document needs its observer
   * re-armed, and that key is what changes when adoption crosses documents (T705).
   */
  const pictureRef = useRef<HTMLDivElement | null>(null);
  const sourceWidth = selected?.size[0] ?? null;
  const sourceHeight = selected?.size[1] ?? null;
  useEffect(() => {
    const frame = surfaceRef.current;
    const picture = pictureRef.current;
    if (frame === null || picture === null) return;
    if (sourceWidth === null || sourceHeight === null) return;
    const apply = (): void => {
      const box = fitInsideRegion({ width: frame.clientWidth, height: frame.clientHeight }, [
        sourceWidth,
        sourceHeight,
      ]);
      picture.style.width = `${box.width}px`;
      picture.style.height = `${box.height}px`;
    };
    apply();
    const view = frame.ownerDocument.defaultView;
    if (view === null || typeof view.ResizeObserver !== "function") return;
    const observer = new view.ResizeObserver(apply);
    observer.observe(frame);
    return () => observer.disconnect();
  }, [canvasKey, sourceWidth, sourceHeight]);

  // §V351/B67. A separate ref from `surfaceRef`: that one is the picture the Fullscreen
  // API is pointed at, this one is the pane the keymap resolves against.
  const viewerPaneRef = useRef<HTMLDivElement | null>(null);
  const viewerPaneProps = useKeymapPane<HTMLDivElement>("viewer", viewerPaneRef);

  const [fullscreen, setFullscreen] = useState(false);
  useEffect(() => {
    const element = surfaceRef.current;
    if (element === null) return;
    // Escape, F11 and the browser's own chrome all leave fullscreen without asking us, so
    // the label follows the EVENT and never the click — otherwise the first Escape leaves
    // a button that says "leave fullscreen" over a window that already did.
    //
    // Listening on the ELEMENT rather than on a document: `fullscreenchange` is fired at
    // the element on entry and on exit, and a listener on the element travels with it when
    // the pane is floated into a child window (§V97, T393). A document captured at mount
    // would be the wrong one after that move.
    const sync = () => setFullscreen(element.ownerDocument.fullscreenElement === element);
    element.addEventListener("fullscreenchange", sync);
    return () => element.removeEventListener("fullscreenchange", sync);
  }, []);

  const toggleFullscreen = useCallback(() => {
    void bus.execute("view.toggleFullscreen", {}, invocation);
  }, [bus, invocation]);

  /*
   * T813 — DOUBLE-CLICK toggles fullscreen, on the owner's word ("double click to
   * fullscreen would be a neat thing for both viewer and floating viewer anyway").
   * A pointer gesture on the surface needs no button chrome and no keymap to reach a
   * floated window — the command already targets `element.ownerDocument` (§V97), so
   * the SAME handler serves the dock and the float, which is what makes this the
   * perform-mode path rather than a nicety.
   *
   * THE ORBIT GUARD: double-click was free (nothing in T379/T380's orbit set uses
   * it), but an orbit nudge small enough for the browser to still count two clicks
   * must not fling the pane fullscreen. Any press that travels past
   * DRAG_THRESHOLD_PX — the same 3px the number fields measured as real-click
   * jitter — stamps a suppression window covering the double-click interval, so a
   * drag can never end in an accidental toggle while a genuine double-click (both
   * presses under the threshold) always fires.
   */
  const pressStartRef = useRef<{ x: number; y: number } | null>(null);
  const dragEndedAtRef = useRef(0);
  const onSurfacePointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    pressStartRef.current = { x: event.clientX, y: event.clientY };
  }, []);
  const onSurfacePointerUp = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const start = pressStartRef.current;
    pressStartRef.current = null;
    if (start === null) return;
    const moved = Math.hypot(event.clientX - start.x, event.clientY - start.y);
    if (moved > DRAG_THRESHOLD_PX) dragEndedAtRef.current = event.timeStamp;
  }, []);
  const onSurfaceDoubleClick = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      // 500ms ≈ the platform double-click interval: any dblclick whose sequence
      // overlaps a drag is the drag's tail, not a request.
      if (event.timeStamp - dragEndedAtRef.current < 500) return;
      // §T1536b: a double click on the mapping layer is a mapping gesture (as on the window).
      if ((event.target as Element | null)?.closest?.("[data-perform-mapping]") != null) return;
      toggleFullscreen();
    },
    [toggleFullscreen],
  );

  return (
    /*
     * §T1311b(b) — the fly keys ride on the PANE, not on the canvas, because the pane is
     * what holds focus: `useKeymapPane`'s pointer-down focuses this element, so a click on
     * the picture leaves the keyboard here and a handler on the canvas would never see a
     * key at all. It is also the element the `viewer` keymap context is declared on, so
     * the gesture and the bindings it reads are scoped to exactly the same surface.
     */
    <div
      {...viewerPaneProps}
      className={styles.viewer}
      onKeyDown={(event) => {
        // §T1536b: Escape leaves Edit mapping first, and only while it is on.
        if (!mapping.onKeyDown(event)) fly.onKeyDown(event);
      }}
      onKeyUp={fly.onKeyUp}
      onBlur={fly.onBlur}
      data-viewer-flying={fly.flying ? "true" : undefined}
    >
      <div className={cx(styles.bar, styles.viewerBar)}>
        <label className={styles.barLabel} htmlFor="viewer-output">
          output
        </label>
        <select
          id="viewer-output"
          data-testid="viewer-output-select"
          className={cx(styles.select, styles.outputSelect)}
          value={requested !== null ? outputKey(requested) : selected === null ? "" : outputKey(selected)}
          onChange={(event) => setPinnedKey(event.target.value === "" ? null : event.target.value)}
          disabled={choices.length === 0}
        >
          {choices.length === 0 ? <option value="">no outputs</option> : null}
          {choices.map((output) => (
            <option key={outputKey(output)} value={outputKey(output)}>
              {/* T622 (§V539's boundary rule): the NAME the user gave the node (§V129:
                  the label IS the name), resolved here where the row is composed — the
                  raw id stays the option's VALUE, which is what pinning and
                  `viewer.show` key on. A flat component-inner id has no row in the raw
                  document and falls back to the id itself. */}
              {`${graph.nodes[output.nodeId as NodeId]?.label ?? output.nodeId}:${output.portId}`}
              {sink !== null && outputKey(sink) === outputKey(output) ? " (output)" : ""}
            </option>
          ))}
        </select>
        <label className={styles.barLabel} htmlFor="viewer-alpha-display">display</label>
        <select id="viewer-alpha-display" className={cx(styles.select, styles.displaySelect)} value={alphaDisplay}
          title="RGBA: alpha over checkerboard; RGB: raw colour"
          onChange={(event) => setAlphaDisplay(event.target.value === "rgb" ? "rgb" : "rgba")}>
          <option value="rgba">RGBA</option>
          <option value="rgb">RGB</option>
        </select>
        {/* §V90: the hint is carried by the label, on hover and on focus — no permanent
            caption in the bar. */}
        {nativeOutput.available ? (
          <Tooltip label={nativeOutput.status || "Publish selected output as SDR video"}>
            <Button disabled={backend === null || selected === null} onClick={nativeOutput.toggle}
              className={styles.nativeOutput}
              aria-label={nativeOutput.active ? "Stop native SDR output" : "Start native SDR output"}
              aria-pressed={nativeOutput.active}
              data-testid="native-output-toggle" data-native-output-ready={nativeOutput.ready}
              data-native-output-status={nativeOutput.status}>
              SDR
            </Button>
          </Tooltip>
        ) : null}
        {/* §T970: a picture drawn through a camera that can be moved gets the button that
            flies THAT camera, by name. It stands where the inspection button would: a
            picture has one camera or the other, never both. */}
        {lock.target !== null ? <ViewerFlyCameraButton lock={lock} /> : null}
        {lock.target !== null ? null : (
        <ViewerCameraButton
          orbits={orbits}
          nodeId={orbitNodeId}
          orbitable={orbitable}
          /* The one case that has a BETTER answer than "no camera here": a shader that
             could have opted into §T1311b(a)'s contract and did not. Read off the node's
             type, because that is the only thing the viewer knows about why the compiler
             published no camera row. */
          shaderWithoutCamera={
            !orbitable &&
            orbitNodeId !== null &&
            graph.nodes[orbitNodeId]?.type === "customWgsl"
          }
          said={cameraNote}
          flying={fly.flying}
        />
        )}
        {/* §T1536b (viewer slice): beside the camera toggle — the other mode the picture's
            own gestures switch into. The label carries the key and the way out (§V90). */}
        <Tooltip label={mapping.editing ? VIEWER_MAPPING_HINT_ON : VIEWER_MAPPING_HINT}>
          <Button
            aria-label="Edit mapping"
            aria-pressed={mapping.editing}
            data-testid="viewer-mapping-toggle"
            /* THIS viewer's mode, as the camera toggle beside it: with several viewers the
               command's holder is the last one mounted (T405), and a click means this one. */
            onClick={() => mapping.setEditing(undefined)}
          >
            <span className={styles.glyph} aria-hidden="true">
              M
            </span>
          </Button>
        </Tooltip>
        {/* Several on the chain: pick which one, as the window's inspector section does.
            A refused one stays listed (the layer's note names why) rather than hidden. */}
        {mapping.editing && mapping.targets.length > 1 ? (
          <select
            aria-label="Mapping node to edit"
            data-testid="viewer-mapping-target"
            className={styles.select}
            value={mapping.chosen ?? ""}
            onChange={(event) => mapping.choose(event.target.value)}
          >
            {mapping.targets.map((target) => (
              <option key={target.nodeId} value={target.nodeId}>
                {target.label}
              </option>
            ))}
          </select>
        ) : null}
        <Tooltip label={fullscreen ? "Leave fullscreen — Escape also works" : "Fullscreen"}>
          <Button
            aria-label={fullscreen ? "Leave fullscreen" : "Fullscreen"}
            aria-pressed={fullscreen}
            data-testid="viewer-fullscreen"
            onClick={toggleFullscreen}
          >
            <span className={styles.glyph} aria-hidden="true">{fullscreen ? "⤡" : "⤢"}</span>
          </Button>
        </Tooltip>
      </div>

      <div
        ref={surfaceRef}
        className={styles.surface}
        data-testid="viewer-surface"
        onPointerDown={onSurfacePointerDown}
        onPointerUp={onSurfacePointerUp}
        onDoubleClick={onSurfaceDoubleClick}
      >
        {/* T763 — a preview-off node in the viewer gets a SENTENCE, not a blank pane.
            §V297's "off means off" stands (T756's interest never revives a disabled
            node), but a silent black rectangle is the reader-that-cannot-see pointed
            at the user: they toggled P, later pointed the viewer here, and nothing
            connects the two. No auto-enable, no prompt — the switch is named. */}
        {requestedNodeId !== null && graph.nodes[requestedNodeId]?.ui?.preview === false ? (
          <p className={styles.note} data-testid="viewer-preview-off">
            Preview is off for this node (P re-enables)
          </p>
        ) : selected === null ? (
          <p className={styles.note}>No output</p>
        ) : (
          <div ref={pictureRef} className={styles.picture} data-testid="viewer-picture">
          {/* §B220: the preview-system surface, for rows the main program has no target for
              (camera, light, geometry, material, pointset). Mounted only for those rows —
              `useOutputPresentation` owns the canvas below and one WebGPU context cannot
              have two owners, which is why this is a second element rather than a mode. */}
          {synthesisRow === null ? null : (
            <canvas
              ref={synthesisCanvasRef}
              className={styles.canvas}
              aria-label="Rendered output"
              data-testid="viewer-synthesis-canvas"
              /*
               * T1655b — THE GESTURES, ON THE CANVAS THAT IS SHOWN. §B220 gave these rows a
               * second canvas and left orbit, pan and the wheel on the first, which is
               * `hidden` whenever this one is mounted: the bar said "drag to orbit" over a
               * pointset, a geometry, a light or a material and no drag moved it (measured in
               * the real app, on every such row the T1655b walk tried). jsdom dispatches to a hidden element, so
               * every test that dragged `viewer-canvas` passed (§V461). No pixel readout
               * here: the probe reads the main program's target, which these rows have none of.
               */
              onPointerMove={onOrbitMove}
              onPointerDown={onOrbitDown}
              onPointerUp={onOrbitUp}
              onPointerCancel={onOrbitUp}
              style={gestureLive ? { cursor: "grab", touchAction: "none" } : undefined}
            />
          )}
          <canvas
            key={canvasKey}
            ref={(element) => {
              canvasRef(element);
              orbitElement.current = element;
            }}
            className={styles.canvas}
            aria-label="Rendered output"
            data-testid="viewer-canvas"
            hidden={synthesisRow !== null}
            tabIndex={0}
            onPointerMove={(event) => {
              onCanvasPointer(event);
              onOrbitMove(event);
            }}
            onPointerDown={(event) => {
              onCanvasPointer(event);
              onOrbitDown(event);
            }}
            onPointerUp={(event) => {
              onCanvasPointer(event);
              onOrbitUp(event);
            }}
            onPointerCancel={onOrbitUp}
            onKeyDown={onCanvasKeyDown}
            style={gestureLive ? { cursor: "grab", touchAction: "none" } : undefined}
          />
          {/*
           * §T1311b(c) — THE CORNER GIZMO. A sibling of the canvas inside `.picture`, for
           * `preview-gizmo-overlay.tsx`'s structural reason restated: a control drawn
           * INSIDE the presented surface is painted over by the next present, and a press
           * that lands on a descendant of the canvas would start `onOrbitDown`'s drag
           * underneath itself. As a sibling it is neither.
           *
           * `orbitable ? flyBasis : null` is one expression and it is §V986: no basis means
           * no measurable orientation, so the widget is ABSENT rather than pointing
           * somewhere it guessed. The sentence saying WHY belongs to the camera toggle in
           * the bar (§T1311b(b)), which reads `viewCameraAbsentReason()` — one fact, one
           * wording (§V349).
           */}
          <ViewerAxisGizmo orbits={orbits} nodeId={orbitNodeId} basis={orbitable ? flyBasis : null} />
          </div>
        )}
        {/* §T1536b (viewer slice): the Edit mapping layer's host — empty to React, filled by
            `perform-mapping-overlay.ts` while the mode is on. A sibling of the picture, over
            the whole frame, so a handle off the picture (clamp-free, §T1538b) still shows. */}
        <div ref={mapping.hostRef} className={styles.mappingHost} data-testid="viewer-mapping-host" />
      </div>

      {/*
        T1346b — ONE readout line, and the pixel half of it exists only while probing.
        Owner: *"the pixel value size stuff … takes up a lot of space and that feels like
        wasted space … I like the resolution that we have it on there somewhere"*.

        It was three labelled rows, two of which said "—" until somebody moved a pointer
        over the picture — three lines of pane height to show a dash. The resolution is the
        part that is always worth space, so it stays; the probe's coordinate and sample
        JOIN the same line when there is a cursor and take no height at all when there is
        not (§V91: nothing to report is nothing shown, never a placeholder).

        ONE `dl`, carrying both the `Resolved output` name the aspect and parity gates read
        and the `viewer-readout` id the probe tests read — they were two elements only
        because they were two rows.
      */}
      <div className={styles.readoutFooter}>
        <dl className={styles.readout} aria-label="Resolved output" data-testid="viewer-readout">
          <dt className={styles.rowNameHidden}>size</dt>
          <dd
            className={styles.rowValue}
            title={selected === null ? undefined : `${selected.size[0]} × ${selected.size[1]} · ${selected.format}`}
          >
            {selected === null
              ? "—"
              : `${selected.size[0]} × ${selected.size[1]} · ${selected.format}`}
          </dd>
          {probeFacts === null ? null : (
            <>
              <dt className={styles.rowNameHidden}>pixel</dt>
              <dd className={cx(styles.rowValue, styles.readoutPixel)}>{probeFacts.at}</dd>
              <dt className={styles.rowNameHidden}>value</dt>
              <dd className={styles.rowValue} title={probeFacts.value}>{probeFacts.value}</dd>
            </>
          )}
        </dl>
        {cameraNote !== null ? (
          <p className={styles.readoutNote} data-testid="viewer-camera-note">{cameraNote}</p>
        ) : lock.target !== null ? (
          // §T1710b: a picture that can be flown keeps the line the flight's note takes, so
          // arming the flight fills it rather than shrinking the picture under the pointer.
          <p className={styles.readoutNote} aria-hidden="true">{"\u00a0"}</p>
        ) : null}
      </div>
    </div>
  );
}

/**
 * §T970 — THE BUTTON THAT FLIES A DOCUMENT CAMERA, NAMED FOR IT.
 *
 * Its face is the name of the node its gestures will write ("Fly camera_rig"), because that
 * node is often not the one the viewer is showing: a Render's picture is flown through its
 * camera. Lit while the viewer is locked; the same toggle as `c` (`viewer.flyCamera`).
 */
function ViewerFlyCameraButton({ lock }: { lock: ViewerCameraLock }) {
  const label = flyCameraLabel(lock.name);
  /* Three runs of one label, so that with no room it is the KIND that goes ("Fly cam…_rig")
     and the role that stays: two cameras differ by their role, and a tail-clipped
     "Fly camera_ov…" names neither. The words are `flyCameraLabel`'s, cut where the name is. */
  const verb = label.slice(0, label.length - lock.name.length);
  return (
    <Tooltip label={flyCameraHint(lock.name, lock.armed, lock.held)}>
      <Button
        className={styles.flyCamera}
        aria-label={label}
        aria-pressed={lock.armed}
        data-testid="viewer-fly-camera"
        data-fly-camera={lock.target ?? undefined}
        onClick={() => {
          lock.set(undefined);
        }}
      >
        <span className={styles.flyVerb}>{verb}</span>
        {lock.nameParts.kind === "" ? null : <span className={styles.flyKind}>{lock.nameParts.kind}</span>}
        <span className={styles.flyRole}>{lock.nameParts.rest}</span>
      </Button>
    </Tooltip>
  );
}

/**
 * §T1311b(b) — THE VIEWER'S CAMERA CONTROL, and the surface `viewCameraAbsentReason()`
 * was written for.
 *
 * §T1311b(a) shipped that sentence with one reader and NO surface: the gestures were
 * simply inert on an output with no camera, and there was nothing to grey out. That is the
 * defect §V123 names — a viewer that silently ignores a drag and six keys reads as broken
 * rather than as honest — and it is worse for fly than for orbit, because a user who never
 * presses this button has no way to discover that WASD does anything at all (§V90: the
 * hint is carried by the control, never painted on the picture).
 *
 * So the button is the affordance, the indicator AND the refusal, and every one of its
 * sentences is READ rather than written here:
 *
 *  - a `customWgsl` output whose shader did not opt in → `viewCameraAbsentReason()`, which
 *    names the four fields its author has to declare. That is an actionable refusal.
 *  - anything else with no camera → the command's own `VIEWER_NO_CAMERA_MESSAGE`, so the
 *    tooltip and the `viewer.cameraHome` / `viewer.fly` rejections cannot say two
 *    different things about one fact (§V349).
 *
 * DISABLED rather than absent, which is the opposite of the tile overlay's rule (T669) and
 * deliberately so: a tile with no camera is one of forty on a canvas and its silence is
 * unremarkable, while the viewer is where the user went specifically to look at this one
 * thing. Here the answer to "why can I not fly this" has to be reachable.
 *
 * T1655b: AND IT WAS NOT. The button was natively `disabled`, the button primitive gives a
 * disabled button `pointer-events: none`, and a tooltip opens on a pointer: measured in the
 * real app, no tooltip appeared on any of the rows that had a reason to give. So it is
 * `aria-disabled`, which keeps the hover and the focus the sentence needs (§V830: a control
 * you may not use but must still read is not `disabled`), and a press does nothing. Where
 * the compiler gave a reason for a 3D picture, that sentence (`said`) is this tooltip AND a
 * visible line of the readout below, so it is one fact said one way in two places.
 */
function ViewerCameraButton({
  orbits,
  nodeId,
  orbitable,
  shaderWithoutCamera,
  said,
  flying,
}: {
  orbits: PreviewOrbitStore | undefined;
  nodeId: NodeId | null;
  orbitable: boolean;
  shaderWithoutCamera: boolean;
  /** T1655b: the compiler's reason this 3D picture has no camera here, when it gave one. */
  said: string | null;
  flying: boolean;
}) {
  /* Per-node slice, like the tile toggle's: the store notifies on MODE changes only, so a
     drag or a flight costs no render at all (§V16). */
  const subscribe = useCallback(
    (listener: () => void) =>
      orbits === undefined || nodeId === null ? () => {} : orbits.subscribe(nodeId, listener),
    [orbits, nodeId],
  );
  const read = useCallback(
    () => (orbits === undefined || nodeId === null ? "home" : orbits.mode(nodeId)),
    [orbits, nodeId],
  );
  const mode = useSyncExternalStore(subscribe, read, read);
  const adjustable = orbitable && mode === "adjustable";
  const canFly = orbitable && orbits?.fly !== undefined;

  const hint = !orbitable
    ? (said ?? (shaderWithoutCamera ? viewCameraAbsentReason() : VIEWER_NO_CAMERA_MESSAGE))
    : adjustable
      ? `Inspecting${flying ? " — flying" : ""}. Drag orbits, shift-drag pans, wheel zooms${
          canFly ? ", W A S D + E Q fly (shift is faster)" : ""
        }. H returns home, F frames the content.`
      : `Inspect camera: drag to orbit${canFly ? ", W A S D + E Q to fly around" : ""}.`;

  return (
    <Tooltip label={hint}>
      <Button
        aria-disabled={!orbitable}
        className={orbitable ? undefined : styles.cameraInert}
        aria-label="Inspect camera"
        aria-pressed={adjustable}
        data-testid="viewer-camera-toggle"
        data-viewer-camera={adjustable ? "adjustable" : "home"}
        onClick={() => {
          if (!orbitable || orbits === undefined || nodeId === null) return;
          orbits.setMode(nodeId, adjustable ? "home" : "adjustable");
        }}
      >
        <span className={styles.glyph} aria-hidden="true">
          C
        </span>
      </Button>
    </Tooltip>
  );
}
