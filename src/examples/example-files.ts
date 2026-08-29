import { buildProjectFile, type ProjectFile } from "../domain/project/index.ts";
import { EXAMPLE_DOCUMENTS, EXAMPLE_TIMESTAMP } from "./documents.ts";

/**
 * The exact bytes each example ships as (T153-T156).
 *
 * The point of generating rather than hand-writing is §V88's: an example has to be a file
 * the app itself would have saved. `buildProjectFile` IS the save path — same serializer,
 * same sorted-key ordering, same file-name derivation — so a shipped example cannot drift
 * into a shape the real save would never produce. `now` is pinned so regenerating changes
 * nothing unless the document changed.
 *
 * Pure: writing is `build-examples.ts`, checking is `sync.test.ts`.
 */
export function buildExampleFiles(): readonly ProjectFile[] {
  return EXAMPLE_DOCUMENTS.map((document) =>
    buildProjectFile({ document, now: () => EXAMPLE_TIMESTAMP }),
  );
}
