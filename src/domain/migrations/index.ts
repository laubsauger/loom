/**
 * Versioned-document migration (T43, §V10).
 *
 * Headless and free of any registry of its own: the document ladder is data passed in,
 * the node lane asks a `NodeDefinitionSource` the caller supplies. The project loader in
 * `src/domain/project/` is what wires both to a real file.
 */

export {
  DOCUMENT_MIGRATIONS,
  migrateProjectDocument,
  validateMigrationLadder,
  type MigrateDocumentOptions,
  type MigrateDocumentResult,
} from "./document-migrations.ts";

export {
  migrateGraphNodes,
  type NodeDefinitionSource,
  type NodeMigrationChange,
  type NodeMigrationOutcome,
} from "./node-migrations.ts";

export type { AppliedMigration, DocumentMigration, RawDocument } from "./types.ts";
