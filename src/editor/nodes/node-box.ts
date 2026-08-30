import { sourceReferenceForInput } from "@domain/graph/source-references.ts";
import type { GraphNode } from "@domain/types/graph.ts";
import type { NodeDefinition } from "@domain/types/node-definition.ts";
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
 * `example-layout.test.ts`; this is the function it measures with, and the same one a
 * real auto-layout would need the day `L`/`layoutAll` stops being honestly-absent.
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
 * `.preview` is `aspect-ratio: 16 / 9`. Under `border-box` the ratio governs the BORDER
 * box, so the hairline is inside the derived height and is not added again.
 */
const PREVIEW_ASPECT = 16 / 9;

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
 * The four kinds `node-view.tsx` enumerates, in the same order and for the same reasons:
 * a texture producer, a value node (its plot), a POINTSET producer (T373/B65 — pointsets
 * preview now, and the day they started every point node got ~100px taller), and a
 * declared SINK, which consumes rather than produces and still owns a target (§V25).
 *
 * Keyed on the port KIND and the manifest's own `category`/`sink`, exactly as the
 * component is, so a new producer is covered by construction rather than by a list
 * somebody has to remember to extend (§V316).
 */
export function nodeHasPreview(node: GraphNode, definition: NodeDefinition | undefined): boolean {
  if (node.ui?.preview === false) return false;
  if (definition === undefined) return false;
  const producesTexture = definition.outputs.some((port) => port.type.kind === "texture2d");
  const producesPointset = definition.outputs.some((port) => port.type.kind === "pointset");
  // T462 (§V85): scene payloads preview as stock scenes — geometry ("scene") does not.
  const producesScenePayload = definition.outputs.some(
    (port) => port.type.kind === "camera" || port.type.kind === "light" || port.type.kind === "material",
  );
  // T438 (§V316): channel publication is declared, never read off the category shelf.
  return (
    producesTexture ||
    producesPointset ||
    producesScenePayload ||
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
    height += Math.floor(contentWidth / PREVIEW_ASPECT);
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
