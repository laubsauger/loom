import type { AssetId, EdgeId, GroupId, NodeId, PortId, Revision } from "./ids.ts";
import type { StoredParameter } from "./parameters.ts";
import type { SelectableColorFormat, TextureFormat } from "./node-definition.ts";

/**
 * Per-instance output resolution, set by the user on the node (TD "Common" page).
 *
 * Absent or "auto" defers to the node definition's own ResolutionPolicy — that is the
 * default, so an untouched node behaves exactly as its author intended. An override is
 * instance state: it is applied at compile/resize, never per frame (§V21, §V50), and is
 * always clamped to the project resolution limits (§V24).
 */
export type NodeResolutionOverride =
  | { mode: "auto" }
  | { mode: "project" }
  | { mode: "input"; input?: PortId }
  | { mode: "scale"; factor: number; input?: PortId }
  | { mode: "fixed"; width: number; height: number }
  /** TD "Fit Resolution": fit inside width x height, preserving the input's aspect. */
  | { mode: "fit"; width: number; height: number; input?: PortId }
  /** TD "Limit Resolution": clamp to width x height only when the input exceeds it. */
  | { mode: "limit"; width: number; height: number; input?: PortId };

/**
 * Per-instance output pixel format, set by the user on the node (TD "Common" page).
 *
 * Absent or "auto" defers to the node definition's own FormatPolicy. Unlike resolution,
 * a format request can be unsupported by the device: an override is validated against the
 * capability report and falls back with a diagnostic rather than failing (§V12, §V51).
 */
export type NodeFormatOverride =
  | { mode: "auto" }
  | { mode: "project" }
  | { mode: "input"; input?: PortId }
  | { mode: "fixed"; format: SelectableColorFormat };

/**
 * Floor for `GraphNode.size` (T208, §V116).
 *
 * One constant, read by both ends of the gesture: the editor hands it to React Flow's
 * resizer so the drag itself cannot go below it, and `applyGraphPatch` clamps to it so
 * an agent — or a hand-written patch — cannot either. Two numbers in two places is how
 * the UI floor and the document floor drift apart.
 *
 * Sized to keep a node legible: the title bar, a preview worth looking at, and a couple
 * of port rows still fit. Below this a node is a smudge you cannot aim at (§V99).
 */
export const MIN_NODE_SIZE: { readonly width: number; readonly height: number } = Object.freeze({
  width: 120,
  height: 96,
});

/** TD-style presets. "auto" and "custom" are handled outside this list. */
export const RESOLUTION_SCALE_PRESETS = [
  { label: "1/8", factor: 0.125 },
  { label: "1/4", factor: 0.25 },
  { label: "1/2", factor: 0.5 },
  { label: "2x", factor: 2 },
  { label: "4x", factor: 4 },
  { label: "8x", factor: 8 },
] as const;

/**
 * The two pictures a value node's body can draw.
 *
 * `trail` is the picture that was always there and is deliberately ONE name for two
 * renderings: a pure periodic node draws one whole cycle of its real function with a
 * playhead, a stateful one draws its rolling history window. Both answer "where has this
 * been", both are a curve, and which of the two a node gets is a property of the node
 * rather than a choice the user makes — so splitting them into two user-facing modes
 * would offer a switch whose second position is unreachable on most nodes.
 *
 * `bar` answers "what is it NOW", which is the question a curve reads worst: a boolean
 * flicking between 0 and 1 is a smear, and a value near a bound tells you nothing about
 * which bound without a scale.
 */
export type ValuePlotMode = "bar" | "trail";

/** Channels an image operator processes. Disabled channels preserve its first texture input. */
export interface ChannelMask {
  readonly r: boolean;
  readonly g: boolean;
  readonly b: boolean;
  readonly a: boolean;
}

export const DEFAULT_CHANNEL_MASK: ChannelMask = Object.freeze({ r: true, g: true, b: true, a: true });

export function isDefaultChannelMask(mask: ChannelMask | undefined): boolean {
  return mask === undefined || (mask.r && mask.g && mask.b && mask.a);
}

export interface GraphNode {
  id: NodeId;
  type: string;
  definitionVersion: number;
  position: { x: number; y: number };
  /**
   * Explicit size in graph-space CSS px, set by dragging the node's resize handles
   * (T208, §V116). Absent = the node sizes itself from its content, which is what an
   * untouched node does. Persisted and undoable like every other document field: a
   * saved project keeps the composition the user laid out.
   */
  size?: { width: number; height: number };
  parameters: Record<string, StoredParameter>;
  /**
   * User-given name for THIS node. Absent means "use the definition's title", which is
   * the default and what an untouched node shows — so renaming is additive and a node
   * that was never renamed keeps following its definition if that is retitled.
   */
  label?: string;
  /** Optional per-instance output resolution. Absent = the definition's policy (§V50). */
  resolution?: NodeResolutionOverride;
  /** Optional per-instance output pixel format. Absent = the definition's policy (§V51). */
  format?: NodeFormatOverride;
  /** Common processing channels. Absent means RGBA; generators preserve neutral (0,0,0,1). */
  channelMask?: ChannelMask;
  state?: Record<string, unknown>;
  ui?: {
    collapsed?: boolean;
    /**
     * The preview SWITCH (T353, §V297). Absent means ON — a visible texture node previews
     * by default (§V28b), so an untouched node and a deliberately-enabled one are the same
     * document. `false` means OFF, and OFF is not "hidden": no tile is allocated, nothing
     * is scheduled, and the node is not a preview sink, so the compiler prunes it and it
     * costs no GPU work at all. That is the only way to make a node stop costing anything.
     *
     * This used to be the PIN, which is why pressing `P` appeared to do nothing: previews
     * were on either way. The pin is `previewPinned` below.
     */
    preview?: boolean;
    /**
     * Keep previewing while scrolled off screen (§V28b, §V28). The rarer need, so it lives
     * in the context menu rather than on a button on every node.
     */
    previewPinned?: boolean;
    /**
     * T601: which INNER node a component instance's preview shows, by internal node id.
     * Absent means the node behind the first output socket — the component's Out node
     * (T607), which is TD's own default. The Common page states and edits the choice
     * (§V499: with several outputs the default is stated, never silently first), and
     * naming any internal node is TD's debug-view idiom. Meaningless on non-instances.
     */
    componentPreview?: string;
    /**
     * T1102 — STACKING ORDER among overlapping nodes. Higher draws in front; absent is 0.
     *
     * Document state rather than view state, and that is the whole decision: the owner
     * asked to "place nodes above others", and a placement that evaporates on reload is
     * not a placement. It costs nothing that was not already here — `ui` is persisted and
     * undoable, `setNodeUi` already carries it, and an absent value has always meant the
     * default — so no migration: a document written before this field is a document where
     * every node sits at 0, which is exactly what it looked like.
     *
     * Deliberately NOT the whole answer to which node is in front. React Flow ELEVATES the
     * selected node above this, so the node you are dragging comes forward without writing
     * to the document at all — a click is not an edit (§V15's spirit: gestures commit, not
     * hovers). This field is what survives letting go.
     */
    z?: number;
    bypassed?: boolean;
    muted?: boolean;
    /**
     * T463: this node's output renders as the GRAPH BACKGROUND — behind the patch,
     * dimmed, TD's network-background way of working. Watching it routes through the
     * same preview-sink set as a tile or viewer (T252), so a marked node costs one
     * shared materialization and an unmarked document costs nothing.
     */
    background?: boolean;
    /**
     * Which picture this value node's body draws — a BAR of the current value, or the
     * CURVE it has been drawing all along. Absent means the default for what this node
     * IS: a pure periodic source keeps its whole-cycle curve and playhead (T459 — a bar
     * cannot show frequency or waveform, which is the thing you open an LFO to see),
     * everything else gets the bar.
     *
     * Document state rather than view state, by the owner's call, made with the cost
     * stated: it travels with the project and with a shared example, and ⌘Z after a mode
     * switch undoes the switch rather than the last edit (§V16's argument, overridden
     * deliberately here). It needs no migration for the reason `z` above needs none —
     * `ui` is already persisted and already treats an absent value as the default, so a
     * document written before this field is one where every node draws its default
     * picture, which is exactly what those documents looked like.
     */
    valuePlotMode?: ValuePlotMode;
    color?: string;
  };
}

export interface GraphEdge {
  id: EdgeId;
  source: { nodeId: NodeId; portId: PortId };
  target: { nodeId: NodeId; portId: PortId };
  /**
   * Position among the edges landing on a VARIADIC input port (T225, §V131): 0-based,
   * dense, and maintained by the patch layer — connect appends, disconnect compacts,
   * `reorderEdges` permutes.
   *
   * Explicit rather than derived from creation order, because for Over and Composite the
   * layer order IS the operation: an order that follows whichever edge was drawn first
   * changes what the graph MEANS when someone rewires it, and cannot be corrected without
   * deleting and redrawing. Absent on an edge into an ordinary port, where "which one is
   * first" is not a question — and absent on every edge in a document written before this
   * field existed, which is why an absent order sorts last (§V68, `compareEdgeOrder`).
   */
  order?: number;
}

export interface GraphGroup {
  id: GroupId;
  label: string;
  bounds: { x: number; y: number; width: number; height: number };
  color?: string;
  members: NodeId[];
}

export interface ViewportState {
  x: number;
  y: number;
  zoom: number;
}

export interface GraphDocument {
  /** Monotonic; bumped once per applied command. Patches carry a baseRevision (§V33). */
  revision: Revision;
  nodes: Record<NodeId, GraphNode>;
  edges: Record<EdgeId, GraphEdge>;
  groups: Record<GroupId, GraphGroup>;
  viewport?: ViewportState;
}

/** Phantom keys: no module can write them, so only a cast (gated) or a spread of one makes either brand. */
declare const flatGraphBrand: unique symbol;
declare const authoredGraphBrand: unique symbol;

/**
 * §T1552b — THE FLATTENED GRAPH, as a type of its own.
 *
 * The document the user authored and the one the compiler, the runtime and every per-frame
 * reader evaluate are both `GraphDocument`, so a consumer that needs the flat one accepted
 * the authored one without a word, and a component's internals did not exist for it: B29,
 * B41, B177, B188, T615 (six sites, one cause), T1067, T1485b, T1550b. A consumer that needs
 * the flat graph takes `FlatGraph`, and `store.getGraph()` is a type error there.
 *
 * Produced only by the flattener (`flattenComponents`, and `compiledWithoutCatalogue` for a
 * compile with no catalogue). `frame-path-flattening.test.ts` refuses an `as FlatGraph` cast
 * anywhere else. A spread of a flat graph is still flat (`{ ...flat, nodes }`): a transform
 * of the flattening, which is what the timeline's structure overrides are.
 */
export type FlatGraph = GraphDocument & { readonly [flatGraphBrand]: true };

/**
 * §T1552b — THE AUTHORED GRAPH, said ON PURPOSE where a reader evaluates it.
 *
 * The store's document stays a plain `GraphDocument`; this brand exists only for the sites
 * that EVALUATE parameters (`parameterReadOptions`, `validateGraph`) and accept either side,
 * so each one says which it reads. The inspector, a command's read scope and `project.validate`
 * read the document as the user wrote it, instances and all; they wrap it in
 * `authoredGraph(…)`. Everything else evaluates the flattening.
 */
export type AuthoredGraph = GraphDocument & { readonly [authoredGraphBrand]: true };

/** What a parameter read or a validation may evaluate: one side or the other, named. */
export type FlatOrAuthoredGraph = FlatGraph | AuthoredGraph;

/**
 * §T1552b: read this document AS AUTHORED — instances whole, labels as the user wrote them.
 * A flat graph is refused (it would claim to be the document while naming inlined nodes).
 */
export function authoredGraph(graph: GraphDocument & { readonly [flatGraphBrand]?: never }): AuthoredGraph {
  return graph as AuthoredGraph;
}

/**
 * Media is referenced, never inlined. v1 saves a single .loom.json with external
 * references; unresolved assets keep identity and offer a relink flow (§C).
 */
export interface AssetReference {
  assetId: AssetId;
  kind: "image" | "video" | "audio" | "gltf" | "binary";
  name: string;
  mimeType?: string;
  sizeBytes?: number;
  source:
    | { kind: "project"; relativePath: string }
    | { kind: "fileHandle"; handleId: string }
    | { kind: "objectUrl"; sessionId: string }
    | { kind: "remote"; url: string; integrity?: string };
  metadata?: Record<string, unknown>;
}

/**
 * The project's colour commitments (T84, §V56, §V70a). `workingSpace` is what every
 * effect computes in; `displayTransform` is what the OUTPUT NODE applies at the end —
 * never the present blit, which is a raw copy (§V70a), and never any node in between.
 * Recorded on the project so the choice survives save/load instead of living in code.
 */
export interface ColorPolicy {
  /** Only linear exists today (§V56); the field exists so that stays a recorded choice. */
  workingSpace: "linear";
  /** "srgb": encode at the Output node. "none": raw values out (measurement, data dumps). */
  displayTransform: "srgb" | "none";
}

export const DEFAULT_COLOR_POLICY: ColorPolicy = Object.freeze({
  workingSpace: "linear",
  displayTransform: "srgb",
});

/** The timeline rate a project runs at, with the default applied once rather than per caller. */
export function projectFps(settings: Pick<ProjectSettings, "fps">): number {
  const fps = settings.fps;
  return typeof fps === "number" && Number.isFinite(fps) && fps > 0 ? fps : DEFAULT_PROJECT_FPS;
}

/** Shared with the transport so the clock and the document cannot disagree about the default. */
export const DEFAULT_PROJECT_FPS = 60;

/**
 * T1432b — how many output pixels one authored pixel is: `outputResolution.width /
 * referenceWidth`, or exactly 1 when the project names no reference (or a meaningless one),
 * so a document without it compiles the same uniforms bit for bit.
 */
export function outputPixelScale(settings: Pick<ProjectSettings, "outputResolution" | "referenceWidth">): number {
  const reference = settings.referenceWidth;
  if (typeof reference !== "number" || !Number.isFinite(reference) || reference <= 0) return 1;
  return settings.outputResolution.width / reference;
}

/**
 * The timeline's in and out points — ONE value, three meanings (T433).
 *
 * `end` is simultaneously the render length, the loop end and the scrub extent. That is a
 * RULING, not an accident of the shape: three fields for those three jobs can disagree,
 * and a user who set the render length and then found the loop still running past it
 * would be right to call that broken. Anything in the app that needs "how long is this"
 * reads this, or it is a second number.
 *
 * Inclusive at both ends, so a range is `end - start + 1` frames and `{start: 0, end: 0}`
 * is the single frame 0 rather than an empty one. `end > start` is enforced by the
 * schema, so no consumer has to handle an inverted range.
 */
export interface FrameRange {
  start: number;
  end: number;
}

/**
 * 600 frames — ten seconds at the default 60 fps.
 *
 * Optional on `ProjectSettings` for the reason `fps` is: documents written before the
 * timeline existed must keep parsing (§V68). Read through `projectRange()` so there is
 * one answer to "what range is this project", never a `?? DEFAULT` at each call site.
 */
export const DEFAULT_FRAME_RANGE: FrameRange = Object.freeze({ start: 0, end: 599 });

export function projectRange(settings: Pick<ProjectSettings, "frameRange">): FrameRange {
  const range = settings.frameRange;
  if (range === undefined) return DEFAULT_FRAME_RANGE;
  // Defensive rather than decorative: settings arrive from a file (§V68) and the schema
  // that would have refused an inverted range only runs at the boundaries it guards.
  if (!Number.isFinite(range.start) || !Number.isFinite(range.end) || range.end <= range.start) {
    return DEFAULT_FRAME_RANGE;
  }
  return range;
}

/**
 * DEPRECATED (VN71/T1687b): nothing in the transport reads this any more.
 *
 * It was how far a seek would replay (§V170: a seek replayed from frame zero so a feedback
 * graph had its true state at the target), and through T454 it also capped the frame range,
 * which cut a three-minute piece at 60 fps (10 800 frames) off the timeline. Now a seek
 * JUMPS: it renders the target frame and leaves temporal state as it is, as TouchDesigner
 * does. Feedback carries on from what it holds, and `runtime.resetFeedback` is how to start
 * over. The range has its own cap, `RANGE_DAY_SECONDS`.
 *
 * Kept only because `src/projects/sentinel-bot/document.ts` still clamps its range to it.
 * That clamp is now unnecessary (follow-up for upstream: drop it, then this).
 */
export const SEEK_FRAME_LIMIT = 10_000;

/**
 * The RANGE cap (VN71/T1687b): one SMPTE day, 24:00:00:00, in seconds. The out point may be
 * at most `RANGE_DAY_SECONDS * fps - 1` at the project's rate (`frameRangeLimit`).
 *
 * A sanity cap, not a cost: a seek renders one frame at any distance, and a render steps its
 * range in order. It is here so a mistyped `1e9` reports instead of becoming a range nobody
 * meant, and one day is the longest span a timecode can name.
 */
export const RANGE_DAY_SECONDS = 86_400;

/** Frames in the range, inclusive of both ends. */
export function frameRangeLength(range: FrameRange): number {
  return range.end - range.start + 1;
}

export interface ProjectSettings {
  outputResolution: { width: number; height: number };
  workingFormat: TextureFormat;
  /** Project-level seed feeding FrameEvaluationInput.randomSeed (§V45). */
  randomSeed: number;
  previewLongEdge: number;
  previewFps: number;
  /**
   * Timeline rate: the denominator of timeline time (§V176), so changing it changes the
   * animation timebase rather than just how often we draw.
   *
   * Optional for the same reason `colorPolicy` is — documents written before it existed
   * must keep parsing (§V68). Read it through `projectFps()` rather than defaulting at
   * each call site, so there is one answer to "what rate is this project".
   *
   * NOT structural (§V178): an fps edit must not recompile or rebuild resources.
   */
  fps?: number;
  /**
   * The timeline's in/out points (T433). Read through `projectRange()`.
   *
   * NOT structural (§V178), for the same reason `fps` is not: it changes what the
   * transport does with time, never what the compiler emits or the backend allocates.
   */
  frameRange?: FrameRange;
  /** Absent in older documents; consumers read `settings.colorPolicy ?? DEFAULT_COLOR_POLICY`. */
  colorPolicy?: ColorPolicy;
  /**
   * T1785b — the project TEMPO in beats per minute: what the transport's beat clock counts
   * at when its source is `manual`, what a tap writes, and what an offline render counts at
   * whatever the source. Read it through `projectBpm()` (`domain/tempo/project-tempo.ts`).
   *
   * Optional (§V68): a document written before it is at 120. NOT structural (§V178): the
   * clock reads it per frame.
   */
  bpm?: number;
  /**
   * T1785b — what drives the beat clock live: `manual` (this BPM, typed or tapped), `audio`
   * (the analysis' tempo claim while it is confident) or `midiClock` (MIDI realtime in).
   * Absent = `manual`. NOT structural.
   */
  tempoSource?: "manual" | "audio" | "midiClock";
  /**
   * T1432b — the output WIDTH the document's pixel-sized effects are authored at.
   *
   * A blur radius or a grain size in pixels is a size in the PICTURE, so a render at twice
   * the size drew the blur half as wide across the frame (`--final` renders at 2× and
   * box-downsamples). Named, every parameter that declares `scalesWithOutput` is scaled by
   * `outputResolution.width / referenceWidth` before its node compiles — a pixel means a
   * pixel of the picture at this width. Read it through `outputPixelScale()`.
   *
   * Absent or 0 (every document before it existed, and the default): a pixel is a pixel of
   * whatever the output is, exactly as before (§V68). STRUCTURAL: the scale is compiled
   * into uniform values, so an edit recompiles (§V178).
   */
  referenceWidth?: number;
  limits: {
    maxResolution: number;
    maxDispatch: number;
    maxBufferBytes: number;
    memoryBudgetBytes: number;
  };
}

/**
 * Project defaults for a NEW project. An opened `.loom.json` brings its own (§V10).
 *
 * Lives in the domain rather than the composition root because settings are DOCUMENT
 * state (§V177) and the store seeds itself with them — a default the store had to import
 * from `src/app` would be the dependency pointing the wrong way.
 */
export const DEFAULT_PROJECT_SETTINGS: ProjectSettings = {
  outputResolution: { width: 1280, height: 720 },
  // SDR storage; shader samples remain linear. Numerical/HDR paths select float.
  workingFormat: "rgba8unorm-srgb",
  randomSeed: 1,
  previewLongEdge: 192,
  previewFps: 20,
  limits: {
    maxResolution: 4096,
    maxDispatch: 65_535,
    maxBufferBytes: 268_435_456,
    memoryBudgetBytes: 1_073_741_824,
  },
};

/** Serialized project. Never contains GPU resources, pipelines, or transient state (§V10). */
export interface ProjectDocument {
  schemaVersion: number;
  projectId: string;
  name: string;
  graph: GraphDocument;
  settings: ProjectSettings;
  assets: AssetReference[];
  createdAt: string;
  updatedAt: string;
}
