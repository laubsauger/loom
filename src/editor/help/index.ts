/**
 * Help surfaces (T200, T201). Every section is DERIVED from a live source (§V105).
 *
 * What the composition root needs from here:
 *  - `<HelpHost bus nodes scope? />` — mount once, inside the `KeymapProvider`. It
 *    registers `ui.openHelp` and owns the panel's open state.
 *
 * What the inspector's parameter control kit needs from here:
 *  - `<ExpressionHelp source scope onInsert? />` — the helper beside an expression
 *    field: live result, the variables in scope with their current values, and what the
 *    evaluator actually accepts.
 */

export { HELP_SECTIONS, OPEN_HELP_COMMAND, helpHolderFor, registerHelpCommand } from "./command.ts";
export type { HelpHandlers, HelpHolder, HelpSection } from "./command.ts";

export { HelpHost } from "./help-host.tsx";
export type { HelpHostProps } from "./help-host.tsx";

export { HelpPanel } from "./help-panel.tsx";
export type { HelpPanelProps } from "./help-panel.tsx";

export { McpSetup } from "./mcp-setup.tsx";

export { ExpressionHelp } from "./expression-help.tsx";
export type { ExpressionHelpProps } from "./expression-help.tsx";

export {
  CANDIDATE_FUNCTIONS,
  expressionFunctions,
  expressionOperators,
  expressionSuggestions,
  expressionVariables,
  frameScope,
  previewExpression,
} from "./expression-reference.ts";
export type { ExpressionPreview, ExpressionSample, ExpressionVariable } from "./expression-reference.ts";

export { nodeReference, nodeReferenceSections } from "./node-reference.ts";
export type {
  NodeReference,
  NodeReferenceSection,
  ParameterReference,
  PortReference,
} from "./node-reference.ts";

export { shortcutForCommand, shortcutSections } from "./shortcut-reference.ts";
export type { ShortcutEntry, ShortcutSection } from "./shortcut-reference.ts";
