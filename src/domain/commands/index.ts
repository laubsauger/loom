import type { NodeRegistryView } from "../../nodes/registry/registry.ts";
import type { SystemClipboard } from "./loom-clipboard.ts";
import { createGraphStore, type GraphStore, type GraphStoreOptions } from "../graph/store.ts";
import { createCommandBus, type LoomBus, type ReferenceCycleHost, type SessionScope } from "./bus.ts";
import { registerEditorCommands } from "./editor-commands.ts";
import { registerLayoutCommands } from "./layout-commands.ts";
import { registerWireTieCommands } from "./wire-tie-commands.ts";
import { registerGraphCommands } from "./graph-commands.ts";
import type { CapabilityGrantStore } from "./grants.ts";
import { registerNodeOutputCommands } from "./node-output-commands.ts";
import { registerParameterCommands } from "./parameter-commands.ts";
import { registerValidateCommand } from "./validate-command.ts";
import { registerSettingsCommands } from "./settings-commands.ts";
import { registerPresetCommands } from "../presets/commands.ts";
import { registerCueCommands } from "../presets/cue-commands.ts";
import { registerPresetDeleteCommand } from "../presets/delete-command.ts";
import { registerPresetMoveCommand } from "../presets/move-command.ts";
import { registerGridWarpCommands } from "./grid-warp-commands.ts";
import { registerControlDefaultCommands } from "./control-default-commands.ts";
import { registerPhotoMappingCommands } from "./photo-mapping-commands.ts";

export {
  CapabilityDeniedError,
  CommandRefusedError,
  InvalidCommandInputError,
  InvalidInvocationError,
  UnknownCommandError,
  UnknownQueryError,
  createCommandBus,
  inSessionKind,
} from "./bus.ts";
export type {
  AppliedInfo,
  ApplyRequest,
  CommandBusOptions,
  CommandContext,
  CommandHandler,
  CommandOutcome,
  CommandRegistration,
  CommandSession,
  InSession,
  InSessionKind,
  QueryContext,
  QueryHandler,
  QueryRegistration,
  LoomBus,
  SessionScope,
} from "./bus.ts";
export { SHADER_SOURCE_PARAMETER, applyGraphPatch } from "./apply-patch.ts";
export { registerEditorCommands } from "./editor-commands.ts";
export { registerLayoutCommands } from "./layout-commands.ts";
export { REROUTE_EDGE_COMMAND, registerWireTieCommands } from "./wire-tie-commands.ts";
export type { RerouteEdgeInput } from "./wire-tie-commands.ts";
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
  ValueChannelsSnapshot,
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
  /**
   * §T1393b: the system clipboard with Loom's structured slot beside the text — what lets
   * a copy made in one window paste in another. Supersedes `clipboard` when both are given.
   */
  systemClipboard?: SystemClipboard | undefined;
  /**
   * §T1695b: the bus this one inherits from, which makes it a component session's bus. It
   * then registers the commands that edit a graph and none of the app's: those it answers
   * through the parent (`InSession` in `bus.ts`).
   */
  parent?: LoomBus | undefined;
  /** §T1695b: what the session edits and through which instance. */
  scope?: SessionScope | undefined;
  /** The component definition edited by a session, for hypothetical reference validation. */
  referenceHost?: ReferenceCycleHost;
}

/**
 * The wired-up bus: store + registry + built-in graph commands. This is what the app
 * composes at startup and what tests use. Other tracks call `registerCommand` on the
 * returned bus rather than building their own (§V29, §V39).
 */
export function createDomainBus(options: DomainBusOptions = {}): { bus: LoomBus; store: GraphStore } {
  const { registry, store: providedStore, grants, clipboard, systemClipboard, parent, scope, referenceHost, ...storeOptions } = options;
  const store = providedStore ?? createGraphStore(storeOptions);
  const bus = createCommandBus({
    store,
    ...(registry === undefined ? {} : { registry }),
    ...(grants === undefined ? {} : { grants }),
    ...(parent === undefined ? {} : { parent }),
    ...(scope === undefined ? {} : { scope }),
    ...(referenceHost === undefined ? {} : { referenceHost }),
  });
  registerGraphCommands(bus);
  registerNodeOutputCommands(bus);
  registerEditorCommands(bus, systemClipboard === undefined ? {} : { systemClipboard });
  registerLayoutCommands(bus);
  // T1821b: wire ties — a route on a wire is a document edit, so every bus has it.
  registerWireTieCommands(bus);
  registerParameterCommands(bus, {
    ...(clipboard === undefined ? {} : { writeClipboard: clipboard }),
    ...(systemClipboard === undefined ? {} : { systemClipboard }),
  });
  registerValidateCommand(bus);
  // §T1695b: the project's settings are the project's (`app`), so a session inherits the
  // command. Its own copy wrote a session store's settings, which nothing reads (§B291).
  if (parent === undefined) registerSettingsCommands(bus);
  // T1496b: preset Store/Recall are graph edits like any other, so every bus has them —
  // the app, the headless helper and the tests alike, with no second registration site.
  registerPresetCommands(bus);
  // T1500b: the cue list's GO / BACK / fire / standby, beside the recall they are made of.
  registerCueCommands(bus);
  // T1502b: Delete, the third of a bank's three edits, in its own file (`delete-command.ts`).
  registerPresetDeleteCommand(bus);
  // T1505b: a bank beside a look moved into its component — explicit, never automatic.
  registerPresetMoveCommand(bus);
  // T1534b: a Grid Warp's row/column insert and delete — document edits, so every bus has them.
  registerGridWarpCommands(bus);
  // T1619b: a control back to its default, and its value made the default: document edits
  // a phone's vetted write reaches too, so every bus has them.
  registerControlDefaultCommands(bus);
  registerPhotoMappingCommands(bus);
  return { bus, store };
}
export { LOOM_CLIPBOARD_TYPE, decodeLoomClipboard, encodeLoomClipboard } from "./loom-clipboard.ts";
export type { LoomClipboardPayload, SystemClipboard } from "./loom-clipboard.ts";
export { createCapabilityGrantStore, type CapabilityGrantStore, type CapabilityGrantStoreOptions } from "./grants.ts";
