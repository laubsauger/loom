import { describe, expect, it } from "vitest";

import {
  DEFAULT_PREVIEW_ASPECT,
  boxGap,
  boxesOverlap,
  nodeBox,
  previewAspectOf,
  type NodeBox,
} from "@domain/graph/node-box.ts";
import type { GraphComponentDefinition } from "@domain/types/components.ts";
import type { GraphDocument } from "@domain/types/graph.ts";
import { createGraphStore } from "@domain/graph/store.ts";
import { EXAMPLE_DOCUMENTS } from "./documents.ts";
import { EXAMPLE_COMPONENT_IDS } from "./example-files.ts";
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

/**
 * T971 — A GATE THAT FAILS WITHOUT NAMING THE TOOL THAT FIXES IT IS A TEST PRETENDING TO
 * BE GUIDANCE.
 *
 * The remedy has existed since T279/B84 and nothing pointed at it: this failure listed the
 * offending pairs and stopped, so every reader — human or agent — had to already know that
 * `layout_graph` is the deterministic tidy, that it is the SAME bus command as the canvas
 * "Layout" row and the `L` key (§V191), and that `nodeIds` tidies a SUBSET into the
 * positions a whole-graph tidy would give it. One string turns each future failure into an
 * instruction, and it costs nothing on the green path (a message is only rendered on
 * failure).
 *
 * Deliberately NOT an auto-tidy: that would move nodes a human placed by hand, and these
 * example layouts are hand-authored (§V389 is a gate on AUTHORED geometry).
 */
const REMEDY =
  "Fix with the deterministic tidy rather than by hand: the `layout_graph` agent tool, " +
  "the canvas Layout row, or the `L` key — all one bus command (§V191). Pass `nodeIds` " +
  "to move only the nodes named above, into the positions a whole-graph tidy would give " +
  "them; omit it to tidy the document.";

/* T956: E47 instances a library component, whose type ("component:depthPoints@1")
   resolves only through the component-aware registry — the same pair the runner and the
   loader use, fed the starter definitions the shipped file embeds. */
const { components, nodes: registry } = createComponentSystem(exampleRegistry());
const STARTER_COMPONENTS = await buildStarterComponents();
for (const built of STARTER_COMPONENTS) components.register(built.definition);

/**
 * T969 — THE SAME RULES, APPLIED TO WHAT IS INSIDE A COMPONENT.
 *
 * The owner's report was "if I dig into holo1 it's just a bunched up mess in contrast to
 * our usual pretty and structured patch layouts", and the cause was this file's ITERATION:
 * it read `EXAMPLE_DOCUMENTS` and nothing else, so no component definition had ever been
 * held to §V389 at all. Measured at the time: `depthPoints` had `in_field` overlapping
 * `carve` by 158x148px and `in_field_2` overlapping `grid` by 158x140, `audioLevel` had
 * `den` and `num` on the same point, `feedbackEcho` had `decay` under `in_in1` by 18x28.
 * Three of seven, none of them visible to a gate that never looked.
 *
 * ⚑ "OUR USUAL PRETTY LAYOUTS" ARE NOT A HOUSE STYLE, THEY ARE THIS FILE. Anything it does
 * not iterate has no standard at all, which is why the coverage assertion below is a test
 * rather than a comment: an example that embeds a component this set does not hold would
 * otherwise ship un-gated and look exactly like the ones that are.
 */
const COMPONENT_DEFINITIONS: readonly GraphComponentDefinition[] = STARTER_COMPONENTS.map(
  (built) => built.definition,
);

/**
 * The aspect a COMPONENT's internals are measured with, and why it is a constant here.
 *
 * A component definition has no `settings` of its own — it is a graph in the catalogue,
 * shared by every instance, so there is no project resolution to read (T668's rule needs a
 * document and there isn't one). The tidy that placed these nodes ran inside a
 * `ComponentSession`, whose store carries the DEFAULT settings, so the box the gate
 * measures and the box the tidy measured are the same box only while those two numbers
 * agree. §V391: pin the model to the thing it claims to describe rather than assuming —
 * `is measuring real documents` below asserts the two are still equal, so a change to the
 * store's default resolution fails here instead of silently measuring a different node.
 */
const COMPONENT_PREVIEW_ASPECT = DEFAULT_PREVIEW_ASPECT;

interface PlacedNode {
  readonly id: string;
  readonly type: string;
  readonly box: NodeBox;
}

function placedIn(graph: GraphDocument, previewAspect: number): readonly PlacedNode[] {
  return Object.values(graph.nodes).map((node) => ({
    id: node.id,
    type: node.type,
    // T668: the slot follows the PROJECT's aspect, so the gate measures each example
    // with its own — a square document's previewing nodes are 177px tall, not 99.
    // T695: and with its own WIRING — a variadic input grows a row per edge landing on
    // it, so a Composite fed by two layers is a row taller than one fed by one.
    box: nodeBox(node, registry.get(node.type), previewAspect, graph),
  }));
}

function placed(document: (typeof EXAMPLE_DOCUMENTS)[number]): readonly PlacedNode[] {
  return placedIn(document.graph, previewAspectOf(document.settings));
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

/** Bare intersection — the FAILURE, named on both sides so the message is actionable. */
function collisionsIn(nodes: readonly PlacedNode[]): readonly string[] {
  return pairs(nodes)
    .filter(([a, b]) => boxesOverlap(a.box, b.box))
    .map(([a, b]) => {
      const gap = boxGap(a.box, b.box);
      return `${a.id} (${a.type}) and ${b.id} (${b.type}) overlap by ${String(-gap.x)}×${String(-gap.y)}px`;
    });
}

/** Legal geometry, unreadable design — the softer half, held to its two numbers. */
function tightPairsIn(nodes: readonly PlacedNode[]): readonly string[] {
  return pairs(nodes)
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
      const collisions = collisionsIn(placed(document));
      expect(collisions, [...collisions, REMEDY].join("\n")).toEqual([]);
    },
  );

  it.each(EXAMPLE_DOCUMENTS.map((document) => [document.name, document] as const))(
    "%s keeps a readable gutter between every pair",
    (_name, document) => {
      const tight = tightPairsIn(placed(document));
      expect(tight, [...tight, REMEDY].join("\n")).toEqual([]);
    },
  );
});

/**
 * T969 — A COMPONENT'S INSIDE IS A LAYOUT SOMEONE READS, SO IT IS HELD TO THE SAME RULES.
 *
 * §T956 is what made this urgent rather than tidy: E47 ships an example that INSTANCES a
 * library component, so component internals are now READ by anyone curious enough to dive
 * in — not merely executed by the compiler, which does not care where a node sits.
 *
 * The same two assertions as above and deliberately not a relaxed pair: a component IS a
 * patch, the owner compared it to "our usual pretty and structured patch layouts", and a
 * softer bar for the inside of one would be this file having a private opinion about which
 * graphs deserve to be readable.
 */
describe("§V389 — component internals are held to the same rules (T969)", () => {
  it("is measuring the components examples actually embed, with the aspect the tidy used", () => {
    // Non-vacuity: seven starter components, every one carrying real nodes.
    expect(COMPONENT_DEFINITIONS.length).toBeGreaterThan(5);
    const everyNode = COMPONENT_DEFINITIONS.flatMap((definition) =>
      placedIn(definition.graph, COMPONENT_PREVIEW_ASPECT),
    );
    expect(everyNode.length).toBeGreaterThan(30);
    for (const node of everyNode) {
      expect(registry.get(node.type), `${node.type} is not in the catalogue`).toBeDefined();
      expect(node.box.width).toBeGreaterThan(0);
      expect(node.box.height).toBeGreaterThan(30);
    }

    /*
     * COVERAGE, ASSERTED RATHER THAN ASSUMED. §T969's cause was a gate whose iteration did
     * not reach the thing it was supposed to hold; the same mistake one level along is an
     * example embedding a component that is not in the starter set, which would ship with
     * no standard while looking exactly like one that has one.
     */
    const gated = new Set(COMPONENT_DEFINITIONS.map((definition) => definition.componentId));
    for (const [projectId, ids] of Object.entries(EXAMPLE_COMPONENT_IDS)) {
      for (const id of ids) {
        expect(gated.has(id as never), `${projectId} embeds "${id}", which this gate never measures`).toBe(true);
      }
    }

    /*
     * §V391 — the aspect pin. The tidy ran inside a `ComponentSession`, whose store carries
     * the default settings; the gate measures with `DEFAULT_PREVIEW_ASPECT`. Those are two
     * constants in two modules and nothing but this line keeps them the same number.
     */
    const sessionSettings = createGraphStore({
      initialGraph: { revision: 0, nodes: {}, edges: {}, groups: {} },
    }).view.getSettings();
    expect(previewAspectOf(sessionSettings)).toBe(COMPONENT_PREVIEW_ASPECT);
  });

  it.each(COMPONENT_DEFINITIONS.map((definition) => [definition.name, definition] as const))(
    "%s has no two nodes occupying the same space",
    (_name, definition) => {
      const collisions = collisionsIn(placedIn(definition.graph, COMPONENT_PREVIEW_ASPECT));
      expect(collisions, [...collisions, REMEDY].join("\n")).toEqual([]);
    },
  );

  it.each(COMPONENT_DEFINITIONS.map((definition) => [definition.name, definition] as const))(
    "%s keeps a readable gutter between every pair",
    (_name, definition) => {
      const tight = tightPairsIn(placedIn(definition.graph, COMPONENT_PREVIEW_ASPECT));
      expect(tight, [...tight, REMEDY].join("\n")).toEqual([]);
    },
  );
});

/**
 * T969 / §T886 — THE TIDY MOVED NODES AND CHANGED NOTHING ELSE.
 *
 * §T886's lesson is that a regeneration is where an unrelated change rides along unnoticed
 * — there, a deleted blank line took a whole row out of a markdown table and the gate
 * greps could not see it. The tidy added to `starter-components.ts` regenerates every
 * shipped component file, so the same exposure applies: a reordered edge, a dropped
 * published parameter or a renamed exposure would land in a diff everybody reads as
 * "layout".
 *
 * So the claim is MEASURED, not reviewed. The set is authored twice in one process — once
 * with the tidy and once without — and every byte is compared except the two things a move
 * is ALLOWED to change: node positions, and the graph revision the move consumed.
 *
 * This is a property of the authoring path, not of a particular diff, so it keeps holding
 * for the next component and the next layout change.
 */
describe("§T886 — the component tidy changed layout only (T969)", () => {
  /** Everything a `moveNodes` patch is permitted to touch, removed. */
  function withoutGeometry(definition: GraphComponentDefinition): unknown {
    const nodes = Object.fromEntries(
      Object.entries(definition.graph.nodes).map(([id, node]) => {
        const { position: _position, ...rest } = node;
        return [id, rest];
      }),
    );
    const { revision: _revision, ...graph } = definition.graph;
    return { ...definition, graph: { ...graph, nodes } };
  }

  it("is byte-identical to the untidied authoring, apart from node positions", async () => {
    const untidied = await buildStarterComponents({ tidy: false });
    expect(untidied.length).toBe(COMPONENT_DEFINITIONS.length);

    for (const [index, before] of untidied.entries()) {
      const after = COMPONENT_DEFINITIONS[index];
      expect(after, `no tidied counterpart for ${before.definition.componentId}`).toBeDefined();
      if (after === undefined) continue;
      expect(after.componentId).toBe(before.definition.componentId);
      expect(
        JSON.stringify(withoutGeometry(after)),
        `${after.componentId}: the tidy changed something that is not a node position`,
      ).toBe(JSON.stringify(withoutGeometry(before.definition)));
    }
  });

  it("actually moved something, or it is comparing a no-op with itself", async () => {
    // Sensitivity: without this the test above passes when the tidy does nothing at all,
    // which is the exact state §T969 was filed about.
    const untidied = await buildStarterComponents({ tidy: false });
    const moved = untidied.filter((before, index) => {
      const after = COMPONENT_DEFINITIONS[index];
      return (
        after !== undefined &&
        JSON.stringify(after.graph.nodes) !== JSON.stringify(before.definition.graph.nodes)
      );
    });
    expect(moved.length).toBeGreaterThan(0);
  });
});
