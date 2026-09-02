import { describe, expect, it } from "vitest";

import { boxGap, boxesOverlap, nodeBox, previewAspectOf, type NodeBox } from "@domain/graph/node-box.ts";
import { EXAMPLE_DOCUMENTS } from "./documents.ts";
import { createComponentSystem } from "../domain/components/registry.ts";
import { buildStarterComponents } from "./starter-components.ts";
import { exampleRegistry } from "./runner.ts";

/**
 * NO SHIPPED EXAMPLE HAS OVERLAPPING NODES (T460, §V389, §V383).
 *
 * ## The bug this is the gate for
 *
 * Example positions are authored as fixed offsets in `documents.ts`; the rendered box is
 * a consequence of the node. E25 shipped with `floorPts` at x=-580 and `floorKernel` at
 * x=-430 — a 150px gap between two 178px nodes, which is not a near miss, it is 28px of
 * interpenetration. The owner found it by LOOKING at a screenshot (§V383), which is the
 * expensive way to find arithmetic.
 *
 * §V389: where positions are authored, GATE the geometry, so the next size change fails
 * loudly instead of shipping crooked. That is the whole point of this file — not the
 * one-time re-layout, which would drift again the first time a node grows a badge.
 *
 * ## Why it reads the DOCUMENTS and not the shipped JSON
 *
 * `documents.ts` is the source a human edits; the `.loom.json` files are generated from
 * it and `sync.test.ts` already fails if they have drifted. Gating the source means the
 * failure names the line you have to change.
 *
 * ## What "overlap" means here, and the gutter
 *
 * Bare intersection is the FAILURE. `MIN_GUTTER` is a separate, softer assertion: nodes
 * that merely touch are legal geometry and unreadable design, and a diagnostic message
 * row or an agent-activity row can make any node taller at runtime — those are the two
 * things `nodeBox` deliberately does not model, so the gutter is what covers them.
 */

/**
 * The two gutters, and they are different NUMBERS because they carry different RISKS.
 *
 * VERTICAL is the one that has to absorb growth. `.message` — two clamped lines of
 * `--fs-micro` with `var(--space-2)` padding, about 30px — appears on any node the
 * compiler complains about, and the agent-activity row appears on any node an agent is
 * touching. Those are the two regions `nodeBox` deliberately does not model, they only
 * ever push DOWNWARD, and a graph that is legal until something errors is not laid out.
 *
 * HORIZONTAL only has to be legible. `--node-width` is a constant and nothing at runtime
 * widens a node, so a column pitch that clears the box clears it forever; this is the
 * space an edge and a port label need, not a safety margin.
 */
const MIN_VERTICAL_GUTTER = 32;
const MIN_HORIZONTAL_GUTTER = 16;

/* T956: E47 instances a library component, whose type ("component:depthPoints@1")
   resolves only through the component-aware registry — the same pair the runner and the
   loader use, fed the starter definitions the shipped file embeds. */
const { components, nodes: registry } = createComponentSystem(exampleRegistry());
for (const built of await buildStarterComponents()) components.register(built.definition);

interface PlacedNode {
  readonly id: string;
  readonly type: string;
  readonly box: NodeBox;
}

function placed(document: (typeof EXAMPLE_DOCUMENTS)[number]): readonly PlacedNode[] {
  return Object.values(document.graph.nodes).map((node) => ({
    id: node.id,
    type: node.type,
    // T668: the slot follows the PROJECT's aspect, so the gate measures each example
    // with its own — a square document's previewing nodes are 177px tall, not 99.
    // T695: and with its own WIRING — a variadic input grows a row per edge landing on
    // it, so a Composite fed by two layers is a row taller than one fed by one.
    box: nodeBox(node, registry.get(node.type), previewAspectOf(document.settings), document.graph),
  }));
}

/** Every unordered pair, so a failure names both nodes rather than "something overlaps". */
function pairs(nodes: readonly PlacedNode[]): Array<readonly [PlacedNode, PlacedNode]> {
  const out: Array<readonly [PlacedNode, PlacedNode]> = [];
  for (let i = 0; i < nodes.length; i += 1) {
    for (let j = i + 1; j < nodes.length; j += 1) {
      const a = nodes[i];
      const b = nodes[j];
      if (a !== undefined && b !== undefined) out.push([a, b]);
    }
  }
  return out;
}

describe("§V389 — shipped example layouts are size-aware (T460)", () => {
  it("is measuring real documents and real definitions, or it is measuring nothing", () => {
    // Non-vacuity, in the shape the seam gates use: if the catalogue emptied or every
    // definition resolved to undefined, every assertion below would pass on nothing.
    expect(EXAMPLE_DOCUMENTS.length).toBeGreaterThan(10);
    const everyNode = EXAMPLE_DOCUMENTS.flatMap((document) => placed(document));
    expect(everyNode.length).toBeGreaterThan(100);
    for (const node of everyNode) {
      expect(registry.get(node.type), `${node.type} is not in the catalogue`).toBeDefined();
      // A definition that failed to resolve would yield a chrome-only box; a real one
      // never does, so this is what makes a silently-empty registry fail loudly.
      expect(node.box.width).toBeGreaterThan(0);
      expect(node.box.height).toBeGreaterThan(30);
    }
  });

  it.each(EXAMPLE_DOCUMENTS.map((document) => [document.name, document] as const))(
    "%s has no two nodes occupying the same space",
    (_name, document) => {
      const collisions = pairs(placed(document))
        .filter(([a, b]) => boxesOverlap(a.box, b.box))
        .map(([a, b]) => {
          const gap = boxGap(a.box, b.box);
          return `${a.id} (${a.type}) and ${b.id} (${b.type}) overlap by ${String(-gap.x)}×${String(-gap.y)}px`;
        });
      expect(collisions, collisions.join("\n")).toEqual([]);
    },
  );

  it.each(EXAMPLE_DOCUMENTS.map((document) => [document.name, document] as const))(
    "%s keeps a readable gutter between every pair",
    (_name, document) => {
      const tight = pairs(placed(document))
        .filter(([a, b]) => {
          const gap = boxGap(a.box, b.box);
          // Either axis may be the one that separates them, but each axis is held to its
          // own number: side by side needs air, stacked needs room to grow.
          return gap.x < MIN_HORIZONTAL_GUTTER && gap.y < MIN_VERTICAL_GUTTER;
        })
        .map(([a, b]) => {
          const gap = boxGap(a.box, b.box);
          return `${a.id} and ${b.id}: x gap ${String(gap.x)} (need ${String(MIN_HORIZONTAL_GUTTER)}), y gap ${String(gap.y)} (need ${String(MIN_VERTICAL_GUTTER)})`;
        });
      expect(tight, tight.join("\n")).toEqual([]);
    },
  );
});
