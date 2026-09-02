import { describe, expect, it } from "vitest";
import { listExamples, listStarterComponentFiles } from "./catalogue.ts";

/**
 * §T916 — every op() reference in every shipped document names a node that RESOLVES.
 *
 * The §T897 migration's gates checked that zero driven bindings survived and that values
 * matched — and both forms of a DANGLING reference fall back to the same retained static
 * (§V108), so equality was green while ~a tenth of the references resolved to nothing.
 * A reference is not a value: the gate for one is existence, which needs no resolver, no
 * GPU and no frame — document against document.
 *
 * The name authority is `nodeNames`: LABELS, not ids (names.ts — an id is an address for
 * edges, a label is the name channels and op() resolve). So this walks every expression
 * source for `op('X')` and requires X to be a label in the same graph.
 */

interface LoomGraph {
  nodes?: Record<string, { label?: string; parameters?: Record<string, unknown> }>;
}

function graphOf(text: string): LoomGraph {
  const parsed = JSON.parse(text) as { graph?: LoomGraph; document?: { graph?: LoomGraph } };
  return parsed.graph ?? parsed.document?.graph ?? {};
}

function danglingRefs(graph: LoomGraph): string[] {
  const labels = new Set<string>();
  for (const node of Object.values(graph.nodes ?? {})) {
    if (typeof node.label === "string") labels.add(node.label);
  }
  const dangling: string[] = [];
  for (const [id, node] of Object.entries(graph.nodes ?? {})) {
    for (const [key, value] of Object.entries(node.parameters ?? {})) {
      const source = (value as { bindings?: { expression?: { source?: string } } })?.bindings
        ?.expression?.source;
      if (typeof source !== "string") continue;
      for (const match of source.matchAll(/op\(\s*'([^']+)'\s*\)/g)) {
        const name = match[1] ?? "";
        if (!labels.has(name)) dangling.push(`${id}.${key} -> op('${name}')`);
      }
    }
  }
  return dangling;
}

describe("every shipped op() reference names a label that exists (§T916)", () => {
  const files = [...listExamples(), ...listStarterComponentFiles()];

  it("sweeps the whole shipped set", () => {
    expect(files.length).toBeGreaterThan(40);
  });

  it.each(files.map((file) => file.fileName))("%s has no dangling references", (fileName) => {
    const file = files.find((entry) => entry.fileName === fileName);
    expect(danglingRefs(graphOf(file?.text ?? "{}"))).toEqual([]);
  });
});
