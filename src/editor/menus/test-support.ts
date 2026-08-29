import { alice, contextFor, createHarness } from "@domain/commands/test-support.ts";
import type { ShaderloomBus } from "@domain/commands/bus.ts";
import type { NodeId } from "@domain/types/ids.ts";
import type { MenuContext } from "./guards.ts";

/**
 * A two-node, one-edge graph on a real bus — menu tests exercise the real command
 * registry, because "does this command exist" is half of what these menus decide.
 */

export interface MenuFixture {
  bus: ShaderloomBus;
  solid: NodeId;
  blur: NodeId;
  edgeId: string;
  /** Snapshot of the document, as the host takes one when a menu opens. */
  context(selection?: readonly NodeId[]): MenuContext;
}

export async function menuFixture(): Promise<MenuFixture> {
  const { bus } = createHarness();
  const result = await bus.execute(
    "graph.applyPatch",
    {
      baseRevision: bus.store.getRevision(),
      label: "seed",
      operations: [
        { op: "addNode", ref: "$solid", type: "test.solid", position: { x: 0, y: 0 } },
        { op: "addNode", ref: "$blur", type: "test.blur", position: { x: 200, y: 0 } },
        {
          op: "connect",
          source: { nodeId: "$solid", portId: "out" },
          target: { nodeId: "$blur", portId: "source" },
        },
      ],
    },
    contextFor(alice),
  );

  const solid = result.output.createdIds["$solid"];
  const blur = result.output.createdIds["$blur"];
  if (solid === undefined || blur === undefined) throw new Error("fixture patch was rejected");
  const edgeId = Object.keys(bus.store.getGraph().edges)[0];
  if (edgeId === undefined) throw new Error("fixture edge was not created");

  return {
    bus,
    solid,
    blur,
    edgeId,
    context: (selection = []) => ({
      graph: bus.store.getGraph(),
      revision: bus.store.getRevision(),
      selection,
      registry: bus.registry,
    }),
  };
}
