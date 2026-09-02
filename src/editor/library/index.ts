/**
 * The three libraries (T39, T188, T189) — three panes, three verbs (§V93).
 *
 * `NodeLibrary` ADDS a type, `ComponentLibrary` INSTANTIATES a subgraph, `ExampleLibrary`
 * OPENS a project. They are exported separately and mounted separately on purpose: only
 * the third replaces the open document, and merging them would put that verb one click
 * from two undoable ones.
 */

export { NodeLibrary } from "./node-library.tsx";
export type { NodeLibraryProps } from "./node-library.tsx";

export { ComponentLibrary } from "./component-library.tsx";
export type { ComponentLibraryProps } from "./component-library.tsx";

export { ExampleLibrary } from "./example-library.tsx";
export type { ExampleLibraryProps } from "./example-library.tsx";

export { listExampleProjects } from "./example-catalogue.ts";
export type { ExampleCategory, ExampleProject } from "./example-catalogue.ts";

export { useDocumentDirty } from "./document-dirty.ts";
export type { DocumentDirty } from "./document-dirty.ts";

export {
  NODE_DRAG_MIME,
  readNodeDragPayload,
  writeNodeDragPayload,
} from "./drag-payload.ts";
export type { DragDataCarrier, NodeDragPayload } from "./drag-payload.ts";

export {
  compatibleDefinitions,
  describeDrag,
  describeDragPrecisely,
  filterLibrary,
  friendlyPortLabel,
  groupByCategory,
  matchScore,
  searchDefinitions,
} from "./search.ts";
export type {
  CategoryBucket,
  CompatibleMatch,
  LibraryFilter,
  PortDragQuery,
  ScoredDefinition,
} from "./search.ts";
