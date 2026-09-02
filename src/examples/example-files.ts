import { buildProjectFile, type ProjectFile } from "../domain/project/index.ts";
import type { GraphComponentDefinition } from "../domain/types/components.ts";
import { EXAMPLE_DOCUMENTS, EXAMPLE_TIMESTAMP } from "./documents.ts";

/**
 * T956: which library components an example EMBEDS (an example file is standalone, so an
 * instance's definition rides in its own componentLibrary — the same way a user's save
 * carries theirs). Keyed by projectId; the definitions come from the caller, because the
 * starter set is authored asynchronously through the real commands and this module stays
 * pure.
 */
export const EXAMPLE_COMPONENT_IDS: Readonly<Record<string, readonly string[]>> = {
  "example-e47-hologram": ["depthPoints", "depthCut"],
};

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
export function buildExampleFiles(
  components: readonly GraphComponentDefinition[] = [],
): readonly ProjectFile[] {
  const byId = new Map(components.map((definition) => [definition.componentId, definition]));
  return EXAMPLE_DOCUMENTS.map((document) => {
    const wanted = EXAMPLE_COMPONENT_IDS[document.projectId] ?? [];
    const embedded = wanted.map((id) => {
      const definition = byId.get(id as never);
      if (definition === undefined) {
        throw new Error(`example "${document.projectId}" embeds component "${id}", which the caller did not supply`);
      }
      return definition;
    });
    return buildProjectFile({
      document,
      now: () => EXAMPLE_TIMESTAMP,
      ...(embedded.length === 0 ? {} : { components: embedded }),
    });
  });
}
