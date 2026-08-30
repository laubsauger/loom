import { describe, expect, it } from "vitest";

import { createTestRegistry } from "../../nodes/registry/test-nodes.ts";
import { layoutGraph } from "../graph/layout.ts";
import type { GraphPatchOperation } from "../types/patch.ts";
import type { ShaderloomBus } from "./bus.ts";
import { alice, contextFor, createHarness, patch } from "./test-support.ts";

/**
 * `graph.layoutAll` / `graph.layout` against the real bus (B84, T440, §V189, §V191).
 *
 * The point of these is NOT that a layout happens — `layout.test.ts` owns the algorithm.
 * It is that the door a HUMAN opens and the door an AGENT opens reach the same answer.
 * Before B84 the algorithm existed and only `layout_graph` could call it; `L` and `l` were
 * bound to commands nobody registered, so the key did nothing at all. The first test below
 * is the whole invariant in one line: what the command wrote is exactly what `layoutGraph`
 * says, computed against the bus's own registry, so there is no second answer to drift to.
 */

const invocation = contextFor(alice);
const registry = createTestRegistry().view();

async function seed(bus: ShaderloomBus, operations: GraphPatchOperation[]) {
  const result = await bus.execute("graph.applyPatch", patch(bus.store.getRevision(), operations, "seed"), invocation);
  expect(result.status).toBe("applied");
  return result;
}

/** Solid → Blur, deliberately placed on top of each other so a tidy has work to do. */
async function harnessWithChain() {
  const { bus } = createHarness("l");
  const seeded = await seed(bus, [
    { op: "addNode", ref: "$a", type: "test.solid", position: { x: 500, y: 500 } },
    { op: "addNode", ref: "$b", type: "test.blur", position: { x: 500, y: 500 } },
    { op: "connect", source: { nodeId: "$a", portId: "out" }, target: { nodeId: "$b", portId: "source" } },
  ]);
  return {
    bus,
    solid: seeded.output.createdIds["$a"] as string,
    blur: seeded.output.createdIds["$b"] as string,
  };
}

describe("graph.layoutAll", () => {
  it("writes exactly the positions `layoutGraph` computes, so an agent and a user agree", async () => {
    const { bus } = await harnessWithChain();
    const expected = layoutGraph(bus.store.getGraph(), registry);

    const result = await bus.execute("graph.layoutAll", {}, invocation);

    expect(result.status).toBe("applied");
    const nodes = bus.store.getGraph().nodes;
    for (const [nodeId, position] of Object.entries(expected)) {
      expect(nodes[nodeId]?.position).toEqual(position);
    }
    // Non-vacuity: it really did move something, so "agrees" is not "both did nothing".
    expect(Object.keys(expected).length).toBe(2);
  });

  it("is one patch and one undo group, so Cmd+Z puts the graph back in a single press", async () => {
    const { bus, solid } = await harnessWithChain();
    const before = bus.store.getGraph().nodes[solid]?.position;

    const result = await bus.execute("graph.layoutAll", {}, invocation);
    expect(result.undoGroupId).toBeDefined();
    expect(bus.store.getGraph().nodes[solid]?.position).not.toEqual(before);

    await bus.execute("graph.undo", {}, invocation);
    expect(bus.store.getGraph().nodes[solid]?.position).toEqual(before);
  });

  it("refuses an already-tidy graph by name rather than burning an undo entry", async () => {
    // Pressing `l` twice must not cost two Cmd+Z to get back past. A `moveNodes` patch
    // that changes no coordinate is a legal patch and a real revision, which is exactly
    // the churn §V189 complains about in the other direction.
    const { bus } = await harnessWithChain();
    await bus.execute("graph.layoutAll", {}, invocation);
    const settled = bus.store.getRevision();

    const again = await bus.execute("graph.layoutAll", {}, invocation);

    expect(again.status).toBe("rejected");
    expect(again.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(["layout.alreadyTidy"]);
    expect(bus.store.getRevision()).toBe(settled);
  });

  it("refuses an empty graph by name instead of doing nothing (§V288)", async () => {
    const { bus } = createHarness("le");
    const result = await bus.execute("graph.layoutAll", {}, invocation);
    expect(result.status).toBe("rejected");
    expect(result.diagnostics[0]?.code).toBe("layout.empty");
    expect(result.diagnostics[0]?.message).toContain("empty");
  });

  it("validates without mutating when the caller asked for a dry run (§V36)", async () => {
    const { bus, solid } = await harnessWithChain();
    const before = bus.store.getGraph().nodes[solid]?.position;

    const result = await bus.execute("graph.layoutAll", {}, { ...invocation, dryRun: true });

    expect(result.status).toBe("validated");
    expect(bus.store.getGraph().nodes[solid]?.position).toEqual(before);
  });
});

describe("graph.layout", () => {
  it("moves only the named nodes, into the positions the whole-graph tidy would give them", async () => {
    const { bus, solid, blur } = await harnessWithChain();
    const whole = layoutGraph(bus.store.getGraph(), registry);
    const solidBefore = bus.store.getGraph().nodes[solid]?.position;

    const result = await bus.execute("graph.layout", { nodeIds: [blur] }, invocation);

    expect(result.status).toBe("applied");
    expect(bus.store.getGraph().nodes[blur]?.position).toEqual(whole[blur]);
    // The unselected node stays put — a partial tidy is not a whole tidy with extra steps.
    expect(bus.store.getGraph().nodes[solid]?.position).toEqual(solidBefore);
  });

  it("refuses an empty selection by name", async () => {
    const { bus } = await harnessWithChain();
    const before = bus.store.getRevision();

    const result = await bus.execute("graph.layout", { nodeIds: [] }, invocation);

    expect(result.status).toBe("rejected");
    expect(result.diagnostics[0]?.code).toBe("selection.empty");
    expect(bus.store.getRevision()).toBe(before);
  });

  it("names the ids the document does not hold, rather than reporting a move it did not make", async () => {
    const { bus } = await harnessWithChain();

    const result = await bus.execute("graph.layout", { nodeIds: ["ghost-1", "ghost-2"] }, invocation);

    expect(result.status).toBe("rejected");
    expect(result.diagnostics[0]?.code).toBe("layout.unknownNodes");
    expect(result.diagnostics[0]?.message).toContain("ghost-1");
    expect(result.diagnostics[0]?.message).toContain("ghost-2");
  });
});
