import { layoutGraph } from "../graph/layout.ts";
import { previewAspectOf } from "../graph/node-box.ts";
import type { RuntimeDiagnostic } from "../types/diagnostics.ts";
import type { GraphDocument } from "../types/graph.ts";
import type { NodeId, Revision } from "../types/ids.ts";
import type { GraphPatchOperation, GraphPatchResult } from "../types/patch.ts";
import { applyGraphPatch } from "./apply-patch.ts";
import type { CommandContext, CommandOutcome, LoomBus } from "./bus.ts";

/**
 * `graph.layoutAll` / `graph.layout` — TouchDesigner's `l` and `L` (B84, T440, §V354,
 * §V191).
 *
 * ## Why these exist now
 *
 * `defaults.ts` has bound `L` and `l` since T77, and both named PLANNED commands, so the
 * keymap engine answered `unresolved` and the two keys did nothing at all while the canvas
 * they tidy filled the window. §V354 is exactly that: honest-absent stops being honest
 * when the surface is visibly right there. The canvas menu's "Layout" row was disabled for
 * the same reason.
 *
 * Meanwhile the algorithm was already built and already shipping — to AGENTS ONLY, through
 * `layout_graph`. B84 is that asymmetry: the tool a model calls did something the button a
 * human presses could not, and the two would have disagreed about node SIZES the moment
 * both existed (see `layout.ts` for the 178-vs-180 half). §V191 says one implementation,
 * reached by both the keymap and the bus command the agent calls. This module is that one
 * place; `layout_graph` now dispatches `graph.layoutAll` rather than calling the layout
 * function itself, so "the agent and the user get the same graph" is structural and not a
 * pair of call sites that happen to match today.
 *
 * ## Why it registers here and not in `editor-commands.ts`
 *
 * It is the same patch path (`applyGraphPatch`, one `moveNodes` operation, one undo group,
 * §V32/§V34) and it could have gone in that file. It is separate because the layout
 * ALGORITHM is a domain concern with its own module and its own gate, and because
 * `editor-commands.ts` is the file every editing track edits. Nothing about the seam
 * depends on the choice: `createDomainBus` calls both registrars.
 *
 * ## The refusals (§V288)
 *
 * A tidy that moves nothing is the interesting case. `moveNodes` with the positions the
 * nodes already hold is a legal patch and would burn an undo entry on a keypress that
 * changed the picture by zero pixels — pressing `l` twice would then cost two Cmd+Z to get
 * back past. So an idempotent layout REPORTS that it was already laid out instead, which
 * is also the honest answer to "did that key work?".
 */
declare module "../types/commands.ts" {
  interface CommandMap {
    /** Tidy the whole document. One `moveNodes` patch, one undo group. */
    "graph.layoutAll": { input: LayoutAllInput; output: GraphPatchResult };
    /** Tidy only these nodes, into the positions the whole-graph tidy would give them. */
    "graph.layout": { input: LayoutInput; output: GraphPatchResult };
  }
}

export type LayoutAllInput = Record<string, never>;

export interface LayoutInput {
  readonly nodeIds: readonly NodeId[];
}

const rejection = (
  _input: unknown,
  diagnostics: RuntimeDiagnostic[],
  revision: Revision,
): GraphPatchResult => ({
  status: "rejected",
  revision,
  appliedOperations: 0,
  diagnostics,
  createdIds: {},
});

function refuse(
  context: CommandContext,
  code: string,
  message: string,
  severity: "info" | "warning" = "info",
): CommandOutcome<GraphPatchResult> {
  const revision = context.store.getRevision();
  const diagnostics: RuntimeDiagnostic[] = [{ severity, code, message }];
  return { status: "rejected", revision, diagnostics, output: rejection(null, diagnostics, revision) };
}

/** Positions that would actually CHANGE, so an already-tidy graph is a no-op, not a patch. */
function movedPositions(
  graph: GraphDocument,
  positions: Record<NodeId, { x: number; y: number }>,
): Record<NodeId, { x: number; y: number }> {
  const moved: Record<NodeId, { x: number; y: number }> = {};
  for (const [nodeId, position] of Object.entries(positions)) {
    const node = graph.nodes[nodeId];
    if (node === undefined) continue;
    if (node.position.x === position.x && node.position.y === position.y) continue;
    moved[nodeId as NodeId] = position;
  }
  return moved;
}

function tidy(
  context: CommandContext,
  label: string,
  only: ReadonlySet<NodeId> | undefined,
): CommandOutcome<GraphPatchResult> {
  const positions = layoutGraph(context.graph, context.registry, {
    // T668: node heights depend on the project's own aspect, so tidy measures with it.
    previewAspect: previewAspectOf(context.store.getSettings()),
    ...(only === undefined ? {} : { only }),
  });
  const moved = movedPositions(context.graph, positions);
  if (Object.keys(moved).length === 0) {
    return refuse(
      context,
      "layout.alreadyTidy",
      only === undefined
        ? "Every node is already where the layout would put it."
        : "Those nodes are already where the layout would put them.",
    );
  }
  const operations: GraphPatchOperation[] = [{ op: "moveNodes", positions: moved }];
  return applyGraphPatch(
    { baseRevision: context.graph.revision, label, operations },
    context,
  );
}

/** Idempotent: the bus has no unregister, and tests build more than one bus per module. */
export function registerLayoutCommands(bus: LoomBus): void {
  if (bus.hasCommand("graph.layoutAll")) return;

  bus.registerCommand({
    name: "graph.layoutAll",
    description: "Arrange every node in reading order: data flows left to right (§V189).",
    handler: (_input, context) => {
      if (Object.keys(context.graph.nodes).length === 0) {
        return refuse(context, "layout.empty", "The graph is empty, so there is nothing to lay out.");
      }
      return tidy(context, "Layout graph", undefined);
    },
    rejectionOutput: rejection,
  });

  bus.registerCommand({
    name: "graph.layout",
    description: "Arrange the selected nodes into the positions the whole-graph layout gives them.",
    handler: (input, context) => {
      const asked = [...new Set(input.nodeIds)].sort();
      if (asked.length === 0) {
        return refuse(context, "selection.empty", "Nothing is selected, so there is nothing to lay out.");
      }
      // §V123: a stale id is named, never quietly dropped into a move that did not happen.
      const missing = asked.filter((nodeId) => context.graph.nodes[nodeId] === undefined);
      if (missing.length === asked.length) {
        return refuse(
          context,
          "layout.unknownNodes",
          `The document holds none of ${missing.join(", ")}.`,
          "warning",
        );
      }
      const only = new Set(asked.filter((nodeId) => context.graph.nodes[nodeId] !== undefined));
      return tidy(context, "Layout nodes", only);
    },
    rejectionOutput: rejection,
  });
}
