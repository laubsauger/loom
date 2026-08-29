import type { AssetId, EdgeId, GroupId, NodeId, PortId, Revision } from "./ids.ts";
import type { ParameterValue } from "./parameters.ts";
import type { TextureFormat } from "./node-definition.ts";

export interface GraphNode {
  id: NodeId;
  type: string;
  definitionVersion: number;
  position: { x: number; y: number };
  size?: { width: number; height: number };
  parameters: Record<string, ParameterValue>;
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
