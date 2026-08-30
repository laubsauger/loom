export { arePortsCompatible, describePortType } from "./port-compat.ts";
export { compareEdgeOrder, edgeOrderKey, incomingEdgesInOrder } from "./edge-order.ts";
export type { OrderableEdge } from "./edge-order.ts";
export { referenceCycleDiagnostics, referenceCyclesThrough } from "./reference-cycles.ts";
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
