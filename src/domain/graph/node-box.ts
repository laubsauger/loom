import { sourceReferenceForInput } from "@domain/graph/source-references.ts";
import type { GraphNode } from "@domain/types/graph.ts";
import type { NodeDefinition } from "@domain/types/node-definition.ts";
import { previewablePort } from "./previewable.ts";
import { publishesValueChannels } from "@domain/types/node-definition.ts";

/**
 * WHAT A NODE ACTUALLY OCCUPIES, IN GRAPH-SPACE PIXELS (T460, §V389).
 *
 * ## Why this exists
 *
 * Example layouts are authored as fixed offsets in `documents.ts` while the rendered box
 * is a CONSEQUENCE of the node — does it preview, how many port rows survive the
 * reference filter, is it a user-sized node. Author a 150px gap between two 178px nodes
 * and they overlap; that is not a subtle failure, and E25 shipped with three of them.
 *
 * §V389 is the rule that came out of it: where positions are authored, the geometry gets
 * a gate, so the next size change fails loudly instead of shipping crooked. The gate is
 * `src/examples/layout.test.ts`; this is the function it measures with.
 *
 * ## Why a model of a DOM lives in `src/domain/`
 *
 * It was in `src/editor/nodes/` until B84, when `layoutGraph` — which had been carrying its
 * own 180×100 GUESS — was made to ask it instead. Layout is domain code and runs headless
 * (the MCP server has no editor), so it cannot import the editor. This file only ever took
 * a `GraphNode` and a `NodeDefinition`, both domain types, and returned arithmetic; the
 * CSS it models is a fact about the app, not a dependency of this function. The measuring
 * spec (`src/tests/e2e/node-box.spec.ts`) is where the browser stays involved.
 *
 * ## It is a MODEL of a DOM, and that is a liability
 *
 * Every number below is read off `node-view.module.css` and the tokens it uses. A model
 * that drifts from what the browser paints makes the gate pass while the picture
 * overlaps — this bug again, one level up. So it is not trusted on arithmetic:
 * `node-box.spec.ts` measures REAL nodes in a REAL browser and fails if any of these
 * constants is wrong (§V339 — jsdom paints nothing, so the pinning cannot live in the
 * jsdom suite). Change the CSS, that spec goes red, and this file is what you fix.
 *
 * ## What it deliberately does NOT model
 *
 * The diagnostic message row and the agent-activity row are RUNTIME state, not document
 * state: the same document renders with and without them depending on whether something
 * failed or an agent is mid-edit. They can only make a node TALLER, so the gutter in the
 * layout gate is what covers them; pretending to predict them would be a fiction with a
 * number attached. The `controls` region is not modelled because nothing supplies
 * `renderControls` — measured, not assumed: the prop exists on `GraphCanvas` and no
 * caller in the tree passes one.
 */

/** `--node-width` in `node-view.module.css`. A node that was never resized is this wide. */
export const NODE_WIDTH = 178;

/**
 * `--pane-header-h`. NOT plus its hairline: `box-sizing: border-box` is global, so
 * `.title { height: 24px; border-bottom: 1px }` occupies 24px with the border inside it.
 * Adding the border was this model's first wrong answer, and the browser said so.
 */
const TITLE_HEIGHT = 24;

/**
 * `.preview` is `aspect-ratio: 16 / 9`, and since T540 it is `box-sizing: content-box`,
 * so the ratio governs the CONTENT box and the hairline below is ADDED to the derived
 * height rather than taken out of it.
 *
 * That inversion is the whole of T540: while the ratio governed the border box, the box
 * the preview system measures and fits its tile into was 16:(9 − hairline), so a 16:9
 * output letterboxed inside its own slot and left a band of ground down each side —
 * "an extra border inside the area of the preview". Measured in the real DOM at 178 px
 * node width: content 176 × 99, border box 176 × 100.
 *
 * DELIBERATELY NOT the project aspect (§V622, T668 — decided, not overlooked). The slot
 * is a fixed-footprint thumbnail serving the GRAPH's legibility, not the output's shape,
 * and this number is a compatibility surface (§V621): every authored position — the 27
 * shipped examples AND every user document — was placed around a 100px slot, and only
 * the examples have a gate. Measured before deciding: following the project aspect costs
 * E24 alone 23 overlapping pairs at 1:1, and a portrait project 203 pairs across 25 of
 * 27 examples. Post-T663 the letterboxing is uniform in slot and target alike, so a
 * non-16:9 preview is consistent, merely smaller.
 */
const PREVIEW_ASPECT = 16 / 9;

/** `.preview` — the hairline BELOW the tile, outside the ratio since T540. */
const PREVIEW_BORDER = 1;

/** `.ports` — `padding: var(--space-2) 0`, top and bottom. */
const PORTS_PADDING = 4 * 2;

/** `.port` — a fixed `height: 14px`. */
const PORT_ROW_HEIGHT = 14;

/** `.column` — `gap: var(--space-1)` between rows in one column. */
const PORT_ROW_GAP = 2;

/** `.node` — a 1px border on every side, and `box-sizing: border-box` is global. */
const NODE_BORDER = 1;

export interface NodeBox {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * Does this node render a preview tile?
 *
 * Exactly what `node-view.tsx` renders, because both read the SAME list of previewable
 * port kinds (T532): a previewable output, a value node (its plot), or a declared SINK,
 * which consumes rather than produces and still owns a target (§V25).
 *
 * This model is what every shipped example's overlap gate is measured against, so a kind
 * that grows a preview here grows the node by ~100px — which is what happened the day
 * pointsets started previewing, and what would silently NOT have happened for geometry if
 * this had kept its own copy of the list (§V316, §V437).
 */
export function nodeHasPreview(node: GraphNode, definition: NodeDefinition | undefined): boolean {
  if (node.ui?.preview === false) return false;
  if (definition === undefined) return false;
  // T532: the ONE list, shared with the slot that renders it and the compiler that fills
  // it. This used to enumerate kinds itself and geometry was missing from every copy —
  // so a node that grew a preview would have kept its old modelled height and every
  // shipped example's overlap gate would have gone green over a layout that had moved.
  // T438 (§V316): channel publication is declared, never read off the category shelf.
  return (
    previewablePort(definition.outputs) !== undefined ||
    publishesValueChannels(definition) ||
    definition.sink === true
  );
}


/**
 * Port ROWS, which is the taller of the two columns — they sit side by side in a grid.
 *
 * Inputs fed by a source REFERENCE are filtered out of the rendered list (T457/§V387: a
 * socket the user cannot connect does not render), so counting the manifest's inputs
 * would overstate the height of exactly the nodes E25 is full of — `render`, `geometry`,
 * `camera` — every one of which takes its scene, material and lights by name.
 */
export function nodePortRows(node: GraphNode, definition: NodeDefinition | undefined): number {
  if (definition === undefined) return 0;
  const inputs = definition.inputs.filter(
    (port) => sourceReferenceForInput(node.type, port.id) === undefined,
  ).length;
  return Math.max(inputs, definition.outputs.length);
}

/** The box this node occupies, at its authored position. */
export function nodeBox(node: GraphNode, definition: NodeDefinition | undefined): NodeBox {
  // A node the user resized fills the box they dragged (T208/§V116) — the document says
  // so outright, and nothing derived can override a stated size.
  if (node.size !== undefined) {
    return { x: node.position.x, y: node.position.y, width: node.size.width, height: node.size.height };
  }

  const contentWidth = NODE_WIDTH - NODE_BORDER * 2;
  let height = NODE_BORDER * 2 + TITLE_HEIGHT;
  if (nodeHasPreview(node, definition)) {
    height += Math.floor(contentWidth / PREVIEW_ASPECT) + PREVIEW_BORDER;
  }
  const rows = nodePortRows(node, definition);
  height += PORTS_PADDING + (rows === 0 ? 0 : rows * PORT_ROW_HEIGHT + (rows - 1) * PORT_ROW_GAP);

  return { x: node.position.x, y: node.position.y, width: NODE_WIDTH, height };
}

/** Do two boxes share any area? Touching edges do not count as overlapping. */
export function boxesOverlap(a: NodeBox, b: NodeBox): boolean {
  return (
    a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
  );
}

/** Signed gap between two boxes on each axis. Negative means they interpenetrate. */
export function boxGap(a: NodeBox, b: NodeBox): { x: number; y: number } {
  return {
    x: Math.max(a.x, b.x) - Math.min(a.x + a.width, b.x + b.width),
    y: Math.max(a.y, b.y) - Math.min(a.y + a.height, b.y + b.height),
  };
}
