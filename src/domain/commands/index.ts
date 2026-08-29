import type { NodeRegistryView } from "../../nodes/registry/registry.ts";
import { createGraphStore, type GraphStore, type GraphStoreOptions } from "../graph/store.ts";
import { createCommandBus, type ShaderloomBus } from "./bus.ts";
import { registerEditorCommands } from "./editor-commands.ts";
import { registerGraphCommands } from "./graph-commands.ts";
import { registerNodeOutputCommands } from "./node-output-commands.ts";

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
export type {
  ClipboardCommandOutput,
  DuplicateInput,
  NodeSelectionInput,
  PasteInput,
} from "./editor-commands.ts";
export { registerGraphCommands } from "./graph-commands.ts";
export { registerNodeOutputCommands } from "./node-output-commands.ts";
export type {
  HistoryCommandOutput,
  HistoryGroupSummary,
  HistorySummary,
} from "./graph-commands.ts";

export interface DomainBusOptions extends GraphStoreOptions {
  registry?: NodeRegistryView;
  store?: GraphStore;
}

/**
 * The wired-up bus: store + registry + built-in graph commands. This is what the app
 * composes at startup and what tests use. Other tracks call `registerCommand` on the
 * returned bus rather than building their own (§V29, §V39).
 */
export function createDomainBus(options: DomainBusOptions = {}): { bus: ShaderloomBus; store: GraphStore } {
  const { registry, store: providedStore, ...storeOptions } = options;
  const store = providedStore ?? createGraphStore(storeOptions);
  const bus = createCommandBus({
    store,
    ...(registry === undefined ? {} : { registry }),
  });
  registerGraphCommands(bus);
  registerNodeOutputCommands(bus);
  registerEditorCommands(bus);
  return { bus, store };
}
