import type { GraphDocument } from "../types/graph.ts";
import type { NodeId } from "../types/ids.ts";
import type { RuntimeDiagnostic } from "../types/diagnostics.ts";

/**
 * T599 — diagnostics NAME nodes the way every other surface does.
 *
 * Ninety-odd sites across the compiler, the commands and the backend interpolate a raw
 * node id (`Node "nd_708afe2424b91" …`) into a message. That id is a receipt, not a
 * diagnostic: the user never typed it, cannot search for it, and every other surface —
 * the header, the inspector, the wires — says `blur1`. Rewriting the sites would be a
 * 91-file sweep that the 92nd site immediately un-does (§V437), so the resolution
 * happens ONCE, at the message boundary, where the graph is at hand: any quoted id that
 * names a node in the open document is replaced with that node's display label.
 *
 * QUOTED occurrences only (`"nd_x"` → `"blur1"`), deliberately: the diagnostic
 * convention is `Node "${nodeId}"` (T587 kept it precisely so this sweep catches every
 * site), and quoting is what makes the replacement collision-safe — a bare id that
 * happens to be a substring of a word is left alone. Ids that already read as names
 * (an example document's hand-written `sim`) are still replaced when a label exists,
 * which is exactly the `blur1` case the owner screenshotted.
 *
 * Agent-facing surfaces (MCP `get_diagnostics`) deliberately do NOT pass through here:
 * agents address nodes BY id, and rewriting their receipts would break the round-trip.
 */

/** The name every user-facing surface shows: the label, else the id itself. */
export function nodeDisplayName(graph: GraphDocument, nodeId: NodeId): string {
  return graph.nodes[nodeId]?.label ?? nodeId;
}

/** Replaces every quoted node id in `text` with the node's display label. */
export function humanizeDiagnosticText(text: string, graph: GraphDocument): string {
  if (!text.includes('"')) return text;
  let out = text;
  for (const [nodeId, node] of Object.entries(graph.nodes)) {
    const label = node.label;
    if (label === undefined || label === nodeId) continue;
    const quoted = `"${nodeId}"`;
    if (out.includes(quoted)) out = out.split(quoted).join(`"${label}"`);
  }
  return out;
}

/**
 * The array form for a problems list. Identity-preserving: entries with nothing to
 * rewrite are returned as-is, and a list with nothing to rewrite is the SAME array —
 * so memoized consumers see no churn when no minted id ever reached a message.
 */
export function humanizeDiagnostics(
  diagnostics: readonly RuntimeDiagnostic[],
  graph: GraphDocument,
): readonly RuntimeDiagnostic[] {
  let changed = false;
  const out = diagnostics.map((diagnostic) => {
    const message = humanizeDiagnosticText(diagnostic.message, graph);
    const suggestion =
      diagnostic.suggestion === undefined
        ? undefined
        : humanizeDiagnosticText(diagnostic.suggestion, graph);
    if (message === diagnostic.message && suggestion === diagnostic.suggestion) return diagnostic;
    changed = true;
    return { ...diagnostic, message, ...(suggestion === undefined ? {} : { suggestion }) };
  });
  return changed ? out : diagnostics;
}
