import type { LibraryCatalogue } from "@agent/index.ts";
import { libraryEntry, type LibraryEntry } from "../../examples/library-entry.ts";
import { starterComponentFiles } from "../component/starter-set.ts";
import { listExampleProjects } from "./example-catalogue.ts";

/**
 * The shipped corpus, as the IN-TAB agent surface reads it (T1211).
 *
 * The MCP server builds the same catalogue in Node from `readdirSync`
 * (`createNodeLibraryCatalogue`); this is the browser half, and the two answer identically
 * because both derive their rows from the same table (§T1162's tags) over the same shipped
 * bytes. §V941's rule: two entrances, one rite.
 *
 * Nothing is re-globbed. The examples come from `listExampleProjects`, which already carries
 * the name, the tags and the first paragraph of the `.md`; the components come from
 * `starterComponentFiles`, which is the second reading of the glob the starter registry
 * already holds.
 *
 * ⚠ WHAT A COMPONENT FILE'S GRAPH IS, so a reader is not surprised: §V94 makes a shipped
 * component a whole PROJECT — the definition rides in `componentLibrary` and the graph is a
 * small demonstration that instantiates it between a source and an Output. So `get_example`
 * on a component answers "how one is wired in", not "what is inside one", and that is the
 * question an agent about to place one actually has.
 */
export function createAgentLibraryCatalogue(): LibraryCatalogue {
  let entries: readonly LibraryEntry[] | undefined;
  let bytes: Map<string, string> | undefined;

  const build = (): void => {
    if (entries !== undefined) return;
    const rows: LibraryEntry[] = [];
    const texts = new Map<string, string>();
    for (const project of listExampleProjects()) {
      texts.set(project.fileName, project.text);
      rows.push({
        fileName: project.fileName,
        name: project.name,
        kind: "example",
        tags: project.tags,
        summary: project.description,
        nodeCount: project.nodeCount,
      });
    }
    for (const file of starterComponentFiles()) {
      texts.set(file.fileName, file.text);
      rows.push(libraryEntry({ fileName: file.fileName, kind: "component", text: file.text }));
    }
    entries = rows;
    bytes = texts;
  };

  return {
    list() {
      build();
      return entries ?? [];
    },
    read(fileName) {
      build();
      return bytes?.get(fileName);
    },
  };
}
