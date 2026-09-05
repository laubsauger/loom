import type { GraphDocument } from "@domain/types/graph.ts";
import { parseProjectDocument } from "@domain/project/index.ts";

import { EXAMPLE_CAPABILITIES } from "../../examples/capabilities.ts";
import type { LibraryEntry } from "../../examples/library-entry.ts";
import { getExampleInput, listExamplesInput } from "../schemas.ts";
import type { GetExampleInput, ListExamplesInput } from "../schemas.ts";
import { failed, ok } from "../tool-support.ts";
import type { AgentEdgeView, AgentNodeView } from "./read.ts";
import { edgeViews, nodeView } from "./read.ts";
import type { AgentTool } from "../types.ts";

/**
 * THE WORKED ANSWERS (T1211).
 *
 * ## The gap these two tools close
 *
 * Measured before they were written: the agent read surface was `get_diagnostics`,
 * `get_graph`, `get_node_definition`, `get_node`, `get_project_summary`,
 * `get_runtime_metrics`, `get_selection` and `list_node_definitions` — and there was NO
 * tool for examples or components at all. So an agent could enumerate 107 node types and
 * could not see one of the 57 shipped examples or 9 starter components, which are the only
 * two artefacts in the build that show how nodes COMBINE. It was handed a parts bin and no
 * assemblies, and then asked to build.
 *
 * That is the same failure §T1204, §T1207 and §T1209 each found in a different place: a
 * capability nobody is told about is indistinguishable from a missing one. Here the
 * capability was not even reachable.
 *
 * ## Why a listing and not a dump
 *
 * 66 files, 23 KB of JSON on average and 120 KB at the top: handing an agent the corpus is
 * 1.5 MB it has to page through to answer "how does anyone wire a feedback loop". So the
 * shape is the one a human library uses — rows with a name, what the file DEMONSTRATES and
 * one sentence, then a way to open one. The tags are §T1162's, DERIVED from the node types
 * in each file rather than authored per example, so a row cannot claim a capability the
 * graph does not contain; `list_examples` publishes the tag DEFINITIONS alongside the rows,
 * because a filter vocabulary nobody can read the meaning of is a guessing game.
 *
 * ## And `get_example` returns a GRAPH, not a file
 *
 * The question an agent has is "what is wired to what", and `.loom.json` answers it with a
 * migration envelope, a settings block, an asset list and every default parameter. So the
 * bytes go through the REAL parse path (§V88 — the same one `project.open` uses, migrations
 * and all) and come back projected through `get_graph`'s own `GraphView` shape. An agent
 * that can read the live document can read a shipped one with no new vocabulary, and a
 * shipped file that no longer parses is reported as the loader's failure rather than
 * silently listed as an empty graph.
 */

/** One tag's badge and the sentence that DEFINES it — never a claim about any one file. */
export interface LibraryTagInfo {
  readonly tag: string;
  readonly label: string;
  readonly meaning: string;
}

export interface LibraryListing {
  readonly entries: readonly LibraryEntry[];
  /**
   * Every tag `entries[].tags` can carry, with its meaning. Published with the rows and not
   * behind a second call: §T1209's lesson is that an agent which must REMEMBER to ask a
   * second question will not ask it.
   */
  readonly tags: readonly LibraryTagInfo[];
  /** Rows the filter removed, so an empty result is distinguishable from an empty corpus. */
  readonly filteredOut: number;
}

export interface ExampleDetail {
  readonly fileName: string;
  readonly name: string;
  readonly kind: LibraryEntry["kind"];
  readonly tags: readonly string[];
  readonly summary: string;
  readonly nodes: readonly AgentNodeView[];
  readonly edges: readonly AgentEdgeView[];
  readonly groupIds: readonly string[];
}

const TAG_INFO: readonly LibraryTagInfo[] = EXAMPLE_CAPABILITIES.map(({ tag, label, meaning }) => ({
  tag,
  label,
  meaning,
}));

export const listExamples: AgentTool<ListExamplesInput, LibraryListing> = {
  name: "list_examples",
  title: "List examples and components",
  description:
    "The shipped example projects and starter components — the worked answers for how nodes are wired together. Rows carry capability tags derived from each file's own node types; filter by tag to find a graph that already does what you are about to build, then open it with get_example.",
  kind: "read",
  inputSchema: listExamplesInput,
  requires: { ports: ["library"] },
  capabilities: [],
  mutates: false,
  run(input, runtime) {
    const catalogue = runtime.ports.library;
    // Unreachable through the surface, which checks `requires.ports` first; kept because a
    // direct caller of `run` would otherwise get a TypeError instead of a result (§V39).
    if (catalogue === undefined) {
      return Promise.resolve(
        failed<LibraryListing>("list_examples", "tool.unavailable", "No example catalogue is attached to this surface."),
      );
    }
    const all = catalogue.list();
    const entries = all.filter(
      (entry) =>
        (input.kind === undefined || entry.kind === input.kind) &&
        (input.tag === undefined || (entry.tags as readonly string[]).includes(input.tag)),
    );
    return Promise.resolve(
      ok("list_examples", { entries, tags: TAG_INFO, filteredOut: all.length - entries.length }),
    );
  },
};

export const getExample: AgentTool<GetExampleInput, ExampleDetail> = {
  name: "get_example",
  title: "Get one example",
  description:
    "One shipped example or starter component as a graph — its nodes and edges in the same shape get_graph returns, so it can be read the way the live document is. Parameters are omitted unless asked for. Names come from list_examples.",
  kind: "read",
  inputSchema: getExampleInput,
  requires: { ports: ["library"] },
  capabilities: [],
  mutates: false,
  run(input, runtime) {
    const catalogue = runtime.ports.library;
    if (catalogue === undefined) {
      return Promise.resolve(
        failed<ExampleDetail>("get_example", "tool.unavailable", "No example catalogue is attached to this surface."),
      );
    }
    const entry = catalogue.list().find((candidate) => candidate.fileName === input.fileName);
    const text = entry === undefined ? undefined : catalogue.read(entry.fileName);
    if (entry === undefined || text === undefined) {
      // The caller's own string is echoed; no shipped document text is quoted (§V37).
      return Promise.resolve(
        failed<ExampleDetail>("get_example", "example.unknown", `No shipped file named "${input.fileName}".`, {
          suggestion: "Call list_examples for the file names this build ships.",
        }),
      );
    }
    const parsed = parseProjectDocument(text);
    if (!parsed.ok) {
      return Promise.resolve(
        failed<ExampleDetail>("get_example", "example.unreadable", `"${input.fileName}" did not parse: ${parsed.reason}`, {
          diagnostics: parsed.diagnostics,
        }),
      );
    }
    return Promise.resolve(ok("get_example", detailOf(entry, parsed.document.graph, input.includeParameters === true)));
  },
};

function detailOf(entry: LibraryEntry, graph: GraphDocument, includeParameters: boolean): ExampleDetail {
  return {
    fileName: entry.fileName,
    name: entry.name,
    kind: entry.kind,
    tags: entry.tags,
    summary: entry.summary,
    nodes: Object.keys(graph.nodes)
      .sort()
      .flatMap((nodeId) => {
        const node = graph.nodes[nodeId];
        return node === undefined ? [] : [nodeView(node, includeParameters)];
      }),
    edges: edgeViews(graph),
    groupIds: Object.keys(graph.groups).sort(),
  };
}

export const libraryTools: readonly AgentTool[] = [listExamples, getExample] as readonly AgentTool[];
