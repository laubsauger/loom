/**
 * Components — subgraphs behind a stable interface (track U, T128–T137).
 *
 * Headless by construction: no React, no DOM, so the compiler and a Node test can use
 * every one of these (§V11). The React lives in `src/editor/component/**`.
 */

export {
  COMPONENT_TYPE_PREFIX,
  componentNodeType,
  isComponentNodeType,
  isValidComponentId,
  parseComponentNodeType,
} from "./component-type.ts";
export type { ComponentTypeRef } from "./component-type.ts";

export {
  COMPONENT_CATEGORY,
  componentNodeDefinition,
  internalParameterOf,
  internalPortOf,
  pruneComponentDefinition,
  validateComponentDefinition,
} from "./definition.ts";

export {
  COMPONENT_OVERRIDES_STATE_KEY,
  PARENT_BINDINGS_STATE_KEY,
  componentInstances,
  instanceDisplayNames,
  internalParameterPath,
  isComponentInstance,
  parseInternalParameterPath,
  readComponentInstance,
  readParentBindings,
} from "./instance.ts";
export type { ComponentInstanceRef } from "./instance.ts";

export {
  componentReferences,
  describeRecursion,
  detectComponentRecursion,
  wouldRecurse,
} from "./recursion.ts";
export type { ComponentGraphSource, RecursionCheckInput } from "./recursion.ts";

export {
  ComponentDefinitionError,
  createComponentAwareRegistry,
  createComponentRegistry,
  createComponentSystem,
} from "./registry.ts";
export type {
  ComponentRegistry,
  ComponentRegistryOptions,
  ComponentRegistryView,
  ComponentSystem,
} from "./registry.ts";

export {
  PARENT_PREFIX,
  buildParentScope,
  formatParentReference,
  lookupParentScope,
  parentBindResolver,
  parentScopeDrivers,
  parseParentReference,
} from "./parent-scope.ts";
export type {
  ParentLookup,
  ParentReference,
  ParentScopeDriver,
  ParentScopeDriverContext,
  ParentScopeDriverOptions,
} from "./parent-scope.ts";

export {
  componentPathNames,
  enterPath,
  parentPath,
  resolveComponentPath,
} from "./navigation.ts";
export type {
  Breadcrumb,
  ComponentFrame,
  ResolveComponentPathInput,
  ResolvedComponentPath,
} from "./navigation.ts";

export { buildComponentFromSelection } from "./save-selection.ts";
export type { ComponentFromSelection, SaveSelectionInput, SelectionWiring } from "./save-selection.ts";

export {
  defaultPublishedValues,
  exposePort,
  findPublishedParameter,
  publishParameter,
  publishedParameterOperations,
  reorderPublishedParameter,
  unexposePort,
  unpublishParameter,
} from "./published-parameter.ts";

export { defaultValueOf } from "./parameter-defaults.ts";

export {
  componentSourcePath,
  effectiveInternalOverrides,
  internalParameterValues,
} from "./flatten.ts";

export { availableUpgrade, migrationChain, planComponentUpgrade } from "./upgrade.ts";
export type { AvailableUpgrade, ComponentUpgradePlan, UpgradePlanInput } from "./upgrade.ts";

export { registerComponentCommands } from "./commands.ts";
export type {
  ComponentCommandOptions,
  ComponentEditOutput,
  ComponentHost,
  ComponentSummary,
  DetachOutput,
  ExposePortInput,
  InstanceUpgradeSummary,
  InstantiateInput,
  InstantiateOutput,
  PublishParameterInput,
  ReorderParameterInput,
  SaveSelectionCommandInput,
  SaveSelectionOutput,
  SetParentBindingInput,
  UnexposePortInput,
  UpgradeInstanceInput,
  UpgradeInstanceOutput,
} from "./commands.ts";

export { openComponentSession } from "./session.ts";
export type { ComponentSession, ComponentSessionOptions } from "./session.ts";

export {
  COMPONENT_SCHEMA_VERSION,
  componentInstanceStateSchema,
  componentLibrarySchema,
  componentMigrationSchema,
  exposedPortSchema,
  graphComponentDefinitionSchema,
  parameterDefinitionSchema,
  parseComponentDefinition,
  publishedParameterSchema,
  serializeComponentLibrary,
} from "./schemas.ts";
export type {
  ComponentParseResult,
  ParsedComponentDefinition,
  ParsedComponentLibrary,
} from "./schemas.ts";
export { deriveBoundaryPorts, withBoundaryPorts } from "./boundary-ports.ts";
