/** Inspector pane (T38) and the node Common section (T73). */

export { Inspector } from "./inspector.tsx";
export type { InspectorProps, InspectorProjectSettings } from "./inspector.tsx";

export { MidiSection } from "./midi-section.tsx";
export type { MidiSectionProps, MidiSectionSurface } from "./midi-section.tsx";

export { CommonReadout, CommonSection } from "./common-section.tsx";
export type { CommonReadoutProps, CommonSectionProps } from "./common-section.tsx";

export { ConnectionsSection } from "./connections-section.tsx";
export type { ConnectionsSectionProps } from "./connections-section.tsx";

export { connectionModel, movedOrder } from "./connections.ts";
export type {
  ConnectionInputGroup,
  ConnectionModel,
  ConnectionOutputGroup,
  ConnectionRow,
  ConnectionsRegistry,
} from "./connections.ts";

export { createParameterEditor } from "./parameter-editor.ts";
export type { ParameterEditor, ParameterEditorOptions } from "./parameter-editor.ts";

export { resolveParameter, resolveParameters } from "./parameter-resolver.ts";
export type {
  ParameterDriver,
  ParameterDriverContext,
  ParameterSource,
  ResolveParametersOptions,
  ResolvedParameter,
  ResolvedParameters,
} from "./parameter-resolver.ts";

export { DEFAULT_GROUP, groupParameters } from "./parameter-groups.ts";
export type { ParameterGroup } from "./parameter-groups.ts";

export {
  FORMAT_MODE_AUTO,
  FORMAT_MODE_INPUT,
  FORMAT_MODE_PROJECT,
  RESOLUTION_MODE_AUTO,
  RESOLUTION_MODE_CUSTOM,
  RESOLUTION_MODE_INPUT,
  RESOLUTION_MODE_OPTIONS,
  RESOLUTION_MODE_PROJECT,
  formatDiagnosticsFor,
  formatModeKey,
  formatModeOptions,
  overrideForFormatMode,
  overrideForResolutionMode,
  formatSourceLabel,
  resolutionModeKey,
  resolutionSourceLabel,
  resolvedCommonFor,
} from "./resolution.ts";
export type {
  FormatContext,
  FormatModeOption,
  InputResolution,
  ResolutionContext,
  PlannedOutput,
  ResolutionModeKey,
  ResolutionModeOption,
  ResolvedCommon,
  ResolvedCommonRequest,
  ResolvedFormat,
  ResolvedSize,
} from "./resolution.ts";
