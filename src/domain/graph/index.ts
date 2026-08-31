export { arePortsCompatible, describePortType } from "./port-compat.ts";
export { compareEdgeOrder, edgeOrderKey, incomingEdgesInOrder } from "./edge-order.ts";
export type { OrderableEdge } from "./edge-order.ts";
export { referenceCycleDiagnostics, referenceCyclesThrough } from "./reference-cycles.ts";
export {
  bindingTargets,
  channelTargetName,
  dependenciesFrom,
  opReferenceNames,
  parameterDependencies,
} from "./parameter-dependencies.ts";
export type { ParameterDependency, ParameterDependencyKind } from "./parameter-dependencies.ts";
export { createIdFactory, createSequentialIdFactory } from "./ids.ts";
export type { IdFactory } from "./ids.ts";
export { actorKeyOf, createGraphStore, emptyGraph } from "./store.ts";
export type {
  ActorHistory,
  ApplyInput,
  ApplyResult,
  EntityChange,
  GraphStore,
  GraphStoreInternals,
  GraphStoreOptions,
  GraphStoreState,
  GraphStoreView,
  HistoryOutcome,
  UndoGroup,
} from "./store.ts";
export { humanizeDiagnosticText, humanizeDiagnostics, nodeDisplayName } from "./diagnostic-names.ts";
