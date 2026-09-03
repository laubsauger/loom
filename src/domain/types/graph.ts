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
 * How far the transport will replay before it refuses (§V170), and therefore the largest
 * out point a range may have.
 *
 * 10 000 frames is ~2.8 minutes of 60 fps material — past anything someone scrubs to by
 * hand, and low enough that a mistyped `1e9` reports instead of hanging the browser. It
 * lives in the domain rather than beside the seek command because the RANGE is bounded by
 * it too: a project whose out point a seek would refuse is a project that cannot loop and
 * cannot render, and two copies of that number is how those quietly stop agreeing.
 */
export const SEEK_FRAME_LIMIT = 10_000;

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
  workingFormat: "rgba16float",
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
