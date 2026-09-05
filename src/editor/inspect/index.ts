/**
 * Node inspection surfaces (§P track L — T145, T146, and T41's performance tab).
 *
 * What the composition root needs from here:
 *
 *  - `<NodeInfoHost bus registry compiled telemetry runtime fallbackNodeId>` wrapped
 *    around the graph pane. It registers `ui.showNodeInfo` and watches for TD's middle
 *    click. One host per pane — the popup is a single surface (§V85).
 *  - `SHOW_NODE_INFO_COMMAND` (`"ui.showNodeInfo"`) — the name a keymap binding and the
 *    node context menu must reference so all three routes open the same thing (§V52,
 *    §V78). Neither of those directories is ours to edit; this export is the contract.
 *  - `<PerformancePanel telemetry>` for the bottom dock's `performance` slot.
 *  - `<PipelineHost bus installed compiled graph registry>` — mount once. It registers
 *    `ui.showPipeline` and shows the pipeline inspector (T1188). ⚑ `installed` is the
 *    composition root's `installedPlan` latch, NOT `compile.compiled`: this screen
 *    describes the plan the GPU holds, which is the only reading that is true in the
 *    situation somebody opens it (§B179, §T1163).
 *  - `<ProjectSettingsHost bus settings onChange>` — mount once. It registers
 *    `ui.openSettings`, the name `mod+,`, the palette and the top bar button all execute
 *    so the dialog has one route and three doors (§V307, §V78). Nothing opens it by
 *    setting a flag.
 *
 * Nothing here mutates the document, and nothing here collects a metric — every number
 * comes from the telemetry hub, the compiled plan, or diagnostics already gathered (§V85).
 */

export { SHOW_NODE_INFO_COMMAND, nodeInfoHolderFor, registerNodeInfoCommand } from "./command.ts";
export type { NodeInfoAnchor, NodeInfoHandlers, NodeInfoHolder } from "./command.ts";

export { NodeInfoHost } from "./node-info-host.tsx";
export type { NodeInfoHostProps } from "./node-info-host.tsx";

export { NodeInfoPopup } from "./node-info-popup.tsx";
export type { NodeInfoPopupProps } from "./node-info-popup.tsx";

export { formatAspect, formatBytes, formatMs } from "./format.ts";
export type { FormattedMs } from "./format.ts";

export {
  buildNodeInfo,
  formatDecision,
  formatLabel,
  resolutionDecision,
  spaceLabel,
} from "./node-info-model.ts";
export type {
  Decision,
  DecisionSource,
  NodeInfo,
  NodeInfoRequest,
  NodeOutputInfo,
} from "./node-info-model.ts";

export type { CookPolicyValue } from "./performance-panel.tsx";
export {
  STARTER_PREFERENCE_DEFAULT,
  STARTER_PREFERENCE_STORAGE_KEY,
  createStarterPreferenceStore,
  starterPreferenceStore,
} from "./starter-preference.ts";
export type { StarterPreferenceStore } from "./starter-preference.ts";
export { ProjectSettingsDialog } from "./project-settings.tsx";
export type { ProjectSettingsProps } from "./project-settings.tsx";
export { ProjectSettingsHost } from "./project-settings-host.tsx";
export type { ProjectSettingsHostProps } from "./project-settings-host.tsx";
export {
  OPEN_SETTINGS_COMMAND,
  projectSettingsHolderFor,
  registerProjectSettingsCommand,
} from "./settings-command.ts";
export type { ProjectSettingsHandlers, ProjectSettingsHolder } from "./settings-command.ts";
export {
  SHOW_PIPELINE_COMMAND,
  pipelineHolderFor,
  registerPipelineCommand,
} from "./pipeline-command.ts";
export type { PipelineHandlers, PipelineHolder } from "./pipeline-command.ts";
export { PipelineHost } from "./pipeline-host.tsx";
export type { PipelineHostProps } from "./pipeline-host.tsx";
export { PipelinePanel, PipelineReport } from "./pipeline-panel.tsx";
export type { PipelinePanelProps } from "./pipeline-panel.tsx";
export { PipelineTrackView } from "./pipeline-track.tsx";
export type { PipelineTrackViewProps } from "./pipeline-track.tsx";
export { PipelineRail } from "./pipeline-rail.tsx";
export type { PipelineRailProps } from "./pipeline-rail.tsx";
export { buildPipelineDetail, buildPipelineView } from "./pipeline-model.ts";
export type {
  PipelineFinding,
  PipelineFindingKind,
  PipelineFindingRow,
  PipelineInstallKind,
  PipelineInstallState,
  PipelinePassRow,
  PipelineRequest,
  PipelineDetail,
  PipelineDetailField,
  PipelineDetailGroup,
  PipelineLimit,
  PipelineSelection,
  PipelineStats,
  PipelineTrack,
  PipelineTrackLane,
  PipelineTrackLoop,
  PipelineTrackMark,
  PipelineTrackSegment,
  PipelineView,
} from "./pipeline-model.ts";

export { TimingUnavailableNote } from "./timing-note.tsx";
export { PerformancePanel, PerformanceView } from "./performance-panel.tsx";
export type { PerformancePanelProps, PerformanceViewProps } from "./performance-panel.tsx";

export { watchMiddleClick } from "./middle-click.ts";
export type { MiddleClickEvent, MiddleClickOptions } from "./middle-click.ts";
