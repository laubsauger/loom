import type { AssetId, EdgeId, GroupId, NodeId, PortId, Revision } from "./ids.ts";
import type { ParameterValue } from "./parameters.ts";
import type { TextureFormat } from "./node-definition.ts";

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
  | { mode: "fixed"; width: number; height: number };

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
  | { mode: "fixed"; format: TextureFormat };

/** Formats a user may select for a colour output. Depth is never offered here (§V51). */
export const SELECTABLE_COLOR_FORMATS = ["rgba8unorm", "rgba16float", "r32float"] as const;

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
  size?: { width: number; height: number };
  parameters: Record<string, ParameterValue>;
  /** Optional per-instance output resolution. Absent = the definition's policy (§V50). */
  resolution?: NodeResolutionOverride;
  /** Optional per-instance output pixel format. Absent = the definition's policy (§V51). */
  format?: NodeFormatOverride;
  state?: Record<string, unknown>;
  ui?: {
    collapsed?: boolean;
    preview?: boolean;
    bypassed?: boolean;
    muted?: boolean;
    color?: string;
  };
}

export interface GraphEdge {
  id: EdgeId;
  source: { nodeId: NodeId; portId: PortId };
  target: { nodeId: NodeId; portId: PortId };
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

export interface ProjectSettings {
  outputResolution: { width: number; height: number };
  workingFormat: TextureFormat;
  /** Project-level seed feeding FrameEvaluationInput.randomSeed (§V45). */
  randomSeed: number;
  previewLongEdge: number;
  previewFps: number;
  limits: {
    maxResolution: number;
    maxDispatch: number;
    maxBufferBytes: number;
    memoryBudgetBytes: number;
  };
}

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
