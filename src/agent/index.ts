/**
 * The agent tool surface (track O, T54–T60).
 *
 * Headless by construction: nothing under `src/agent/**` imports React or touches the
 * DOM, so the same surface backs an in-tab WebMCP adapter and an out-of-process MCP
 * server (doc §30.2). The presence UI lives in `src/editor/agent/**` and only reads.
 */

export { createAgentToolSurface } from "./surface.ts";
export type { AgentSurfaceOptions, AgentToolSurface, RevertData } from "./surface.ts";

export { createAgentPresence } from "./presence.ts";
export type {
  AgentActivity,
  AgentPresenceOptions,
  AgentPresenceSnapshot,
  AgentPresenceStore,
  AgentPresenceView,
  AgentProposal,
  AgentTransaction,
  ProposalStatus,
} from "./presence.ts";

export { TOOL_CAPABILITIES, capabilitiesForTool } from "./capabilities.ts";

export { DEFAULT_OUTPUT_PORT, outputKey } from "./types.ts";
export type {
  AgentPortName,
  AgentPorts,
  AgentRuntimeMetrics,
  AgentTool,
  AgentToolInfo,
  OutputRef,
  PreviewExport,
  PreviewImage,
  PreviewImageRequest,
  ToolKind,
  ToolResult,
  ToolStatus,
} from "./types.ts";

export type { PatchToolData } from "./tool-support.ts";
export type {
  AgentEdgeView,
  AgentNodeView,
  GraphView,
  NodeDefinitionDetail,
  NodeDefinitionSummary,
  NodeDetail,
  ProjectSummary,
} from "./tools/read.ts";
export type { PreviewImageData } from "./tools/preview.ts";
export { encodeBase64 } from "./tools/preview.ts";
export { graphPatchOperationSchema } from "./schemas.ts";
