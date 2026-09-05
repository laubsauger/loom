import { firstParagraph, tagsOf, type ExampleTag } from "./capabilities.ts";

/**
 * ONE SHIPPED FILE, AS AN AGENT SEES IT (T1211).
 *
 * The measured gap this closes: the agent read surface could enumerate 107 node TYPES and
 * could not see a single one of the 57 examples or 9 starter components — the only two
 * artefacts in the repo that show how nodes COMBINE. A parts bin and no assemblies.
 *
 * ## Why the derivation is here and not in either caller
 *
 * There are two composition roots and they cannot share a directory read: the browser gets
 * its bytes from `import.meta.glob` (`src/editor/library/example-catalogue.ts`), the MCP
 * server gets them from `readdirSync` (`src/examples/catalogue.ts`). If each derived its own
 * entry, the two would answer differently about the same file the first time one of them
 * changed — §V941's shape, which this project answers by making both entrances run ONE rite.
 * So both hand their bytes to this function and neither owns an opinion about tags, names or
 * counts.
 *
 * ## What an entry deliberately is NOT
 *
 * It is not the file. The corpus averages 23 KB of JSON per example and peaks at 120 KB;
 * 66 of them is 1.5 MB, and a tool result that size is a denial of service dressed as help.
 * An entry is the row a reader scans — name, what it demonstrates, one sentence, how big —
 * and `get_example` is how one of them is opened. The tags are T1162's, DERIVED from the
 * node types in the file, so a row cannot claim a capability the graph does not contain.
 */
export interface LibraryEntry {
  /** File name including the extension, e.g. `E13-Prism.loom.json`. The key `get_example` takes. */
  readonly fileName: string;
  /** The project's own name, read from the file. Untrusted document text (§V37). */
  readonly name: string;
  /**
   * §V93: an example is OPENED and a component is INSTANTIATED. Different verbs, so the
   * row says which rather than leaving an agent to infer it from a directory it cannot see.
   */
  readonly kind: "example" | "component";
  /** T1162's capability tags, derived from the node types the file uses. Never authored. */
  readonly tags: readonly ExampleTag[];
  /** First prose paragraph of the sibling `.md`, or "" when none ships. Untrusted text (§V37). */
  readonly summary: string;
  /** Node count, so a row carries a size without a sentence about it. */
  readonly nodeCount: number;
}

/**
 * Every node type in a project file, in document order, plus the file's own name.
 *
 * A malformed shipped file yields an entry named by its file with no tags rather than a
 * throw: the same rule the browser catalogue's `describe` follows, because a corrupt file
 * is the LOADER's finding and a listing that cannot list is worse than one honest row.
 */
function readProjectFile(text: string): { name: string | null; nodeTypes: string[]; nodeCount: number } {
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null) return { name: null, nodeTypes: [], nodeCount: 0 };
    const record = parsed as { name?: unknown; graph?: { nodes?: unknown } };
    const name = typeof record.name === "string" && record.name !== "" ? record.name : null;
    const nodes = record.graph?.nodes;
    if (typeof nodes !== "object" || nodes === null) return { name, nodeTypes: [], nodeCount: 0 };
    const nodeTypes: string[] = [];
    for (const node of Object.values(nodes as Record<string, unknown>)) {
      const type = (node as { type?: unknown } | null)?.type;
      if (typeof type === "string") nodeTypes.push(type);
    }
    return { name, nodeTypes, nodeCount: Object.keys(nodes as Record<string, unknown>).length };
  } catch {
    return { name: null, nodeTypes: [], nodeCount: 0 };
  }
}

/** The row for one shipped file. Pure: bytes in, row out, no directory and no I/O. */
export function libraryEntry(input: {
  readonly fileName: string;
  readonly kind: "example" | "component";
  readonly text: string;
  /** The sibling `.md`, when one ships. Absent → an empty summary, never an invented one. */
  readonly markdown?: string | undefined;
}): LibraryEntry {
  const { name, nodeTypes, nodeCount } = readProjectFile(input.text);
  return {
    fileName: input.fileName,
    name: name ?? input.fileName,
    kind: input.kind,
    tags: tagsOf(nodeTypes),
    summary: input.markdown === undefined ? "" : firstParagraph(input.markdown),
    nodeCount,
  };
}
