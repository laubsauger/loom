import type { NodeDefinition } from "@domain/types/node-definition.ts";
import { friendlyPortLabel, groupByCategory } from "@editor/library/search.ts";

/**
 * The node half of the help panel, DERIVED from the registry's manifests (T200, §V105).
 *
 * A manifest already carries the title, the category, the description, the ports and the
 * parameter schema — the whole reference. Copying any of it into a help document creates
 * a second source that a renamed parameter silently falsifies, so nothing here is typed
 * out: this module reshapes what `NodeRegistryView.list()` returns and adds no facts.
 *
 * Port types are rendered with `friendlyPortLabel`, the same short form the node library
 * uses mid-drag, rather than the diagnostic form (§V57) — a reference page is read to
 * learn what connects to what, not to parse a type signature.
 *
 * ## The authored prose (T1337b, T1338b, §V998)
 *
 * Every `description` a manifest carries — 115 node strings (32,339 bytes), 293 parameter
 * (52,582) and 77 port (6,725), 91,646 in all — used to stop here.
 * `NodeReference.description` was declared, filled and
 * never rendered, and the ports and parameters did not carry theirs at all, so the only
 * human surface in the product was a native `title=` tooltip: a container that cannot be
 * scrolled or selected and dismisses on pointer move. A 2368-character node description
 * was not long prose, it was unreadable prose in the wrong container.
 *
 * So the split here is a CONTAINER decision, not an editorial one — no string is cut.
 * `summary` is the author's own first sentence and `detail` is the rest, verbatim, and
 * the panel shows the first always and the second on demand. The lede was already being
 * written as a summary: across all 485 strings it is 60 characters at the median and 164
 * at p95, against a 96/572 total, so the scannable list stays a list and the book behind
 * it stays whole.
 */

/**
 * The author's first sentence, and everything after it (T1337b).
 *
 * A sentence ends at `.`, `!` or `?` followed by whitespace or the end of the string —
 * which already excludes a decimal point ("9.6x faster") because no space follows it —
 * and is never taken before 24 characters or straight after an abbreviation, the two
 * ways this cuts in the middle of a thought. `detail` is `""` when the whole string is
 * one sentence, which is 216 of the 485 shipped strings.
 */
const ABBREVIATION = /(?:\b(?:e\.g|i\.e|vs|cf|approx|fig|eq|ch|sec|min|max|etc)|\b[A-Za-z])\.$/i;
const SENTENCE_END = /[.!?](?=\s|$)/g;

export function splitLede(text: string): { readonly summary: string; readonly detail: string } {
  SENTENCE_END.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = SENTENCE_END.exec(text)) !== null) {
    const end = match.index + 1;
    const head = text.slice(0, end);
    if (head.length < 24) continue;
    if (ABBREVIATION.test(head)) continue;
    return { summary: head, detail: text.slice(end).trim() };
  }
  return { summary: text, detail: "" };
}

export interface PortReference {
  readonly id: string;
  readonly label: string;
  readonly type: string;
  readonly optional: boolean;
  /** T1338b — what this port MEANS, as the manifest author wrote it. */
  readonly description: string | undefined;
}

export interface ParameterReference {
  readonly key: string;
  readonly label: string;
  readonly type: string;
  readonly unit: string | undefined;
  /** T1337b — what this parameter DOES, as the manifest author wrote it. */
  readonly description: string | undefined;
}

export interface NodeReference {
  readonly type: string;
  readonly title: string;
  readonly category: string;
  /** The description's first sentence — shown whenever the node is listed (T1337b). */
  readonly summary: string | undefined;
  /** Everything after that sentence, verbatim. `""` when there is no more. */
  readonly detail: string;
  readonly inputs: readonly PortReference[];
  readonly outputs: readonly PortReference[];
  readonly parameters: readonly ParameterReference[];
}

export interface NodeReferenceSection {
  readonly category: string;
  readonly nodes: readonly NodeReference[];
}

function portsOf(ports: NodeDefinition["inputs"]): readonly PortReference[] {
  return ports.map((port) => ({
    id: port.id,
    label: port.label,
    type: friendlyPortLabel(port.type),
    optional: port.optional === true,
    description: port.description,
  }));
}

function parametersOf(definition: NodeDefinition): readonly ParameterReference[] {
  return Object.entries(definition.parameters)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, parameter]) => ({
      key,
      label: parameter.label,
      type: parameter.type,
      // Only a number parameter carries a unit; asking the union for one would be a
      // fact this module invented rather than read.
      unit: parameter.type === "number" ? parameter.unit : undefined,
      description: parameter.description,
    }));
}

export function nodeReference(definition: NodeDefinition): NodeReference {
  // Split once per definition, not once per render: §T1178 hoisted this whole build out
  // of the search keystroke, and a per-keystroke regex over 91 KB would put it back.
  const prose =
    definition.description === undefined
      ? { summary: undefined, detail: "" }
      : splitLede(definition.description);
  return {
    type: definition.type,
    title: definition.title,
    category: definition.category,
    summary: prose.summary,
    detail: prose.detail,
    inputs: portsOf(definition.inputs),
    outputs: portsOf(definition.outputs),
    parameters: parametersOf(definition),
  };
}

/** Every installed node, grouped the way the registry itself groups them. */
export function nodeReferenceSections(
  definitions: readonly NodeDefinition[],
): readonly NodeReferenceSection[] {
  return groupByCategory([...definitions].sort((a, b) => a.title.localeCompare(b.title))).map(
    (bucket) => ({
      category: bucket.category,
      nodes: bucket.definitions.map(nodeReference),
    }),
  );
}
