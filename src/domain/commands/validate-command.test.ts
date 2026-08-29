import { beforeEach, describe, expect, it } from "vitest";

import type { GraphPatchOperation } from "../types/patch.ts";
import { alice, contextFor, createHarness, patch, type Harness } from "./test-support.ts";

/**
 * T174 (§V39): `project.validate` on the bus.
 *
 * The tool surface has named this command since it was written and reported itself
 * unavailable because nothing registered it. It is one implementation — the compiler's
 * own validator — reachable by the palette, a hotkey and every adapter alike, rather than
 * a second copy of the rules inside an adapter.
 */

let harness: Harness;

beforeEach(() => {
  harness = createHarness();
});

const context = () => contextFor(alice);

const apply = async (operations: GraphPatchOperation[]) =>
  harness.bus.execute(
    "graph.applyPatch",
    patch(harness.store.view.getRevision(), operations),
    context(),
  );

const validate = () => harness.bus.execute("project.validate", {}, context());

describe("project.validate", () => {
  it("reports a well-formed graph as valid", async () => {
    const built = await apply([
      { op: "addNode", ref: "$a", type: "test.solid", position: { x: 0, y: 0 } },
      { op: "addNode", ref: "$b", type: "test.blur", position: { x: 200, y: 0 } },
    ]);
    await apply([
      {
        op: "connect",
        source: { nodeId: built.output.createdIds["$a"] as string, portId: "out" },
        target: { nodeId: built.output.createdIds["$b"] as string, portId: "source" },
      },
    ]);

    const result = await validate();
    expect(result.status).toBe("applied");
    expect(result.output.ok).toBe(true);
    expect(result.output.nodeCount).toBe(2);
    expect(result.output.edgeCount).toBe(1);
    expect(result.output.cycles).toEqual([]);
    expect(result.output.unresolvedNodeIds).toEqual([]);
  });

  it("reports a required input that nothing feeds, without mutating anything", async () => {
    await apply([{ op: "addNode", ref: "$b", type: "test.blur", position: { x: 0, y: 0 } }]);
    const before = harness.store.view.getGraph();

    const result = await validate();

    // "applied" means the validation RAN; `ok` is the answer to the question. A status of
    // "rejected" would mean the command itself could not run.
    expect(result.status).toBe("applied");
    expect(result.output.ok).toBe(false);
    expect(result.output.diagnostics.some((entry) => entry.severity === "error")).toBe(true);
    expect(harness.store.view.getGraph()).toBe(before);
    expect(harness.store.view.getRevision()).toBe(before.revision);
  });

  it("names an illegal same-frame cycle (§V4)", async () => {
    const built = await apply([
      { op: "addNode", ref: "$a", type: "test.blur", position: { x: 0, y: 0 } },
      { op: "addNode", ref: "$b", type: "test.blur", position: { x: 200, y: 0 } },
    ]);
    const a = built.output.createdIds["$a"] as string;
    const b = built.output.createdIds["$b"] as string;
    await apply([
      { op: "connect", source: { nodeId: a, portId: "out" }, target: { nodeId: b, portId: "source" } },
      { op: "connect", source: { nodeId: b, portId: "out" }, target: { nodeId: a, portId: "source" } },
    ]);

    const result = await validate();
    expect(result.output.ok).toBe(false);
    expect(result.output.cycles).toEqual([[a, b].sort()]);
  });

  it("reports an unknown node type as unresolved rather than dropping it (§V10)", async () => {
    // A placeholder cannot be created through a patch — the type must be registered —
    // so it is seeded the way a loaded file produces one: in the initial document.
    const placeholder = createHarness();
    placeholder.store.raw.setState({
      graph: {
        revision: 1,
        nodes: {
          ghost: {
            id: "ghost",
            type: "some.package.NotInstalled",
            definitionVersion: 1,
            position: { x: 0, y: 0 },
            parameters: {},
          },
        },
        edges: {},
        groups: {},
      },
    });

    const result = await placeholder.bus.execute("project.validate", {}, context());
    expect(result.output.ok).toBe(false);
    expect(result.output.unresolvedNodeIds).toEqual(["ghost"]);
    expect(result.output.nodeCount).toBe(1);
  });
});
