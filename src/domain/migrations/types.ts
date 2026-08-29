/**
 * Migration contracts (T43, §V10).
 *
 * Two kinds of migration exist and they are deliberately not the same thing:
 *
 *  - a DOCUMENT migration owns the file's own shape — `schemaVersion` — and runs on raw
 *    JSON, before anything is validated. It is the project loader's business.
 *  - a NODE migration owns one node type's parameters — `definitionVersion` — and is
 *    written by whoever wrote the node (`NodeDefinition.migrate`). The loader calls it;
 *    it never guesses on the definition's behalf.
 *
 * Both are explicit and ordered. A step nobody wrote is reported, never invented.
 */

/** Raw, unvalidated JSON object. Document migrations run at this level by design. */
export type RawDocument = Record<string, unknown>;

export interface DocumentMigration {
  /** Applies to a document whose `schemaVersion` is exactly this. */
  from: number;
  /** The `schemaVersion` the document has after the step; must be greater than `from`. */
  to: number;
  /** Shown to the user when a file is upgraded on open. */
  description: string;
  /**
   * Pure transform. It receives a private deep clone, so mutating it in place is safe and
   * nothing half-applied can escape: the loader only adopts the result of a COMPLETE chain.
   */
  migrate(document: RawDocument): RawDocument;
}

export interface AppliedMigration {
  from: number;
  to: number;
  description: string;
}
