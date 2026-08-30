import type { NodeRegistryView } from "../../nodes/registry/registry.ts";
import { createGraphStore, type GraphStore, type GraphStoreOptions } from "../graph/store.ts";
import { createCommandBus, type ShaderloomBus } from "./bus.ts";
import { registerEditorCommands } from "./editor-commands.ts";
import { registerLayoutCommands } from "./layout-commands.ts";
import { registerGraphCommands } from "./graph-commands.ts";
import type { CapabilityGrantStore } from "./grants.ts";
import { registerNodeOutputCommands } from "./node-output-commands.ts";
import { registerParameterCommands } from "./parameter-commands.ts";
import { registerValidateCommand } from "./validate-command.ts";
import { registerSettingsCommands } from "./settings-commands.ts";

export {
  CapabilityDeniedError,
  InvalidInvocationError,
  UnknownCommandError,
  UnknownQueryError,
  createCommandBus,
} from "./bus.ts";
export type {
  AppliedInfo,
  ApplyRequest,
  CommandBusOptions,
  CommandContext,
  CommandHandler,
  CommandOutcome,
  CommandRegistration,
  QueryContext,
  QueryHandler,
  QueryRegistration,
  ShaderloomBus,
} from "./bus.ts";
export { SHADER_SOURCE_PARAMETER, applyGraphPatch } from "./apply-patch.ts";
export { registerEditorCommands } from "./editor-commands.ts";
export { registerLayoutCommands } from "./layout-commands.ts";
export type {
  ClipboardCommandOutput,
  DuplicateInput,
  NodeSelectionInput,
  PasteInput,
} from "./editor-commands.ts";
export { registerGraphCommands } from "./graph-commands.ts";
export { registerNodeOutputCommands } from "./node-output-commands.ts";
export { registerParameterCommands } from "./parameter-commands.ts";
export type {
  ParameterCommandOptions,
  ParameterCopyOutput,
  ParameterPasteInput,
  ParameterRef,
  ParameterResetOutput,
  ParameterSetModeInput,
  PulseInput,
  PulseOutput,
} from "./parameter-commands.ts";
export type {
  HistoryCommandOutput,
  HistoryGroupSummary,
  HistorySummary,
  RevertTransactionInput,
  RevertTransactionOutput,
} from "./graph-commands.ts";
export { registerValidateCommand } from "./validate-command.ts";
export type { ValidationReport } from "./validate-command.ts";
export {
  isValueOnlyPatch,
  operationClass,
  overlappingEntities,
  patchTouchedEntities,
  touchedEntities,
} from "./patch-scope.ts";
export type { PatchOperationClass } from "./patch-scope.ts";
export { attachStateSources, stateSourcesFor } from "./state-queries.ts";
export type {
  DiagnosticsQueryInput,
  DiagnosticsSnapshot,
  ProjectSnapshot,
  RuntimeMetricsSnapshot,
  SelectionSnapshot,
  StateSources,
} from "./state-queries.ts";

export interface DomainBusOptions extends GraphStoreOptions {
  registry?: NodeRegistryView;
  store?: GraphStore;
  /** Bus-owned capability grant store (T90, §V38). Created empty when not supplied. */
  grants?: CapabilityGrantStore;
  /**
   * Where a copied parameter string is mirrored so it can leave the app (§V148). The
   * browser composition root supplies `navigator.clipboard`; a headless bus supplies
   * nothing and keeps working.
   */
  clipboard?: ((text: string) => void) | undefined;
}

/**
 * The wired-up bus: store + registry + built-in graph commands. This is what the app
 * composes at startup and what tests use. Other tracks call `registerCommand` on the
 * returned bus rather than building their own (§V29, §V39).
 */
export function createDomainBus(options: DomainBusOptions = {}): { bus: ShaderloomBus; store: GraphStore } {
  const { registry, store: providedStore, grants, clipboard, ...storeOptions } = options;
  const store = providedStore ?? createGraphStore(storeOptions);
  const bus = createCommandBus({
    store,
    ...(registry === undefined ? {} : { registry }),
    ...(grants === undefined ? {} : { grants }),
  });
  registerGraphCommands(bus);
  registerNodeOutputCommands(bus);
  registerEditorCommands(bus);
  registerLayoutCommands(bus);
  registerParameterCommands(bus, { ...(clipboard === undefined ? {} : { writeClipboard: clipboard }) });
  registerValidateCommand(bus);
  registerSettingsCommands(bus);
  return { bus, store };
}
export { createCapabilityGrantStore, type CapabilityGrantStore, type CapabilityGrantStoreOptions } from "./grants.ts";
