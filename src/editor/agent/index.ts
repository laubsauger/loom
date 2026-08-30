/**
 * Agent presence UI (T60, §V42). The only React in the agent surface: `src/agent/**` is
 * headless so it can back an external MCP server too, and this pane reads a snapshot of
 * it without ever producing tool state.
 */

export { AgentBadge, AgentPresencePanel } from "./agent-presence.tsx";
export type { AgentBadgeProps, AgentPresencePanelProps } from "./agent-presence.tsx";
export { useAgentPresence } from "./use-agent-presence.ts";
export { McpConnectionPanel } from "./mcp-connection-panel.tsx";
export type { McpConnectionPanelProps, McpToolDetail } from "./mcp-connection-panel.tsx";
export { describeOperation } from "./describe-operation.ts";
export type { OperationRow } from "./describe-operation.ts";
