import { beforeEach, describe, expect, it } from "vitest";

import { MIN_NODE_SIZE } from "../types/graph.ts";
import type { GraphPatchOperation } from "../types/patch.ts";
import { alice, contextFor, createHarness, patch, type Harness } from "./test-support.ts";

/**
 * `setNodeSize` at the document boundary (T208, §V116, §V66).
 *
 * The composed gesture test (`src/tests/integration/node-resize.test.tsx`) is what proves
 * a drag becomes one patch; this covers what the drag can never reach, because React
 * Flow's resizer already refuses it: the floor and the malformed input an AGENT can send
 * straight to the bus (§V29 makes that the same door the canvas uses).
 */

let harness: Harness;

beforeEach(() => {
  harness = createHarness();
});

async function apply(operations: GraphPatchOperation[]) {
  return harness.bus.execute(
    "graph.applyPatch",
    patch(harness.store.view.getRevision(), operations),
    contextFor(alice),
  );
}

async function seedNode(): Promise<string> {
  const result = await apply([
    { op: "addNode", ref: "$n", type: "test.solid", position: { x: 0, y: 0 } },
  ]);
  return result.output.createdIds["$n"] as string;
}

const sizeOf = (nodeId: string) => harness.store.view.getGraph().nodes[nodeId]?.size;

describe("setNodeSize (T208, §V116)", () => {
  it("stores the size on the node", async () => {
    const nodeId = await seedNode();
    await apply([{ op: "setNodeSize", nodeId, size: { width: 320, height: 240 } }]);
    expect(sizeOf(nodeId)).toEqual({ width: 320, height: 240 });
  });

  it("clamps to the floor rather than rejecting the patch (§V116)", async () => {
    const nodeId = await seedNode();
    // Refusing would be worse than clamping: a resize arrives with a position in the
    // same patch (§V32), so a rejection over one pixel of overshoot would silently throw
    // away the move half of the gesture as well.
    const result = await apply([{ op: "setNodeSize", nodeId, size: { width: 4, height: 4 } }]);
    expect(result.output.status).toBe("applied");
    expect(sizeOf(nodeId)).toEqual(MIN_NODE_SIZE);
  });

  it("clears the override, returning the node to its content size", async () => {
    const nodeId = await seedNode();
    await apply([{ op: "setNodeSize", nodeId, size: { width: 320, height: 240 } }]);
    await apply([{ op: "setNodeSize", nodeId, size: null }]);
    expect(sizeOf(nodeId)).toBeUndefined();
  });

  it("refuses a non-finite size at the zod boundary rather than writing NaN (§V66)", async () => {
    const nodeId = await seedNode();
    // The §V66 stake: NaN serializes to null and the saved document stops loading.
    const result = await apply([
      { op: "setNodeSize", nodeId, size: { width: Number.NaN, height: 100 } },
    ]);
    expect(result.output.status).toBe("rejected");
    expect(sizeOf(nodeId)).toBeUndefined();
  });

  it("is a VALUE edit: it does not conflict with a concurrent structural patch (§V33)", async () => {
    const nodeId = await seedNode();
    const stale = harness.store.view.getRevision();
    // Somebody else adds a node in between. A layout edit must not lose that race, or a
    // human resizing a node at 60Hz would starve every agent patch (and vice versa).
    await apply([{ op: "addNode", ref: "$other", type: "test.solid", position: { x: 400, y: 0 } }]);

    const result = await harness.bus.execute(
      "graph.applyPatch",
      patch(stale, [{ op: "setNodeSize", nodeId, size: { width: 320, height: 240 } }]),
      contextFor(alice),
    );
    expect(result.output.status).toBe("applied");
  });
});
