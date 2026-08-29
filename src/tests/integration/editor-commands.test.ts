import { describe, expect, it } from "vitest";
import { alice, contextFor, createHarness, patch } from "../../domain/commands/test-support.ts";
import type { ShaderloomBus } from "../../domain/commands/bus.ts";
import type { GraphPatchOperation } from "../../domain/types/patch.ts";

/**
 * The editing commands the keymap names, against the real bus (T51 task 2).
 *
 * These are the commands `delete`, `mod+c/x/v`, `mod+d`, `b`, `d` and `r` dispatch to.
 * Every one of them is asserted to land in the DOCUMENT — not merely to return a
 * successful result — because the failure mode this task exists to prevent is a command
 * that reports success while nothing mutates (§V29).
 */

const invocation = contextFor(alice);

async function seed(bus: ShaderloomBus, operations: GraphPatchOperation[]) {
  const result = await bus.execute(
    "graph.applyPatch",
    patch(bus.store.getRevision(), operations, "seed"),
    invocation,
  );
  expect(result.status).toBe("applied");
  return result;
}

/** Solid → Blur, so copy/duplicate have an internal edge to preserve. */
async function harnessWithPair() {
  const { bus } = createHarness("e");
  const seeded = await seed(bus, [
    { op: "addNode", ref: "$a", type: "test.solid", position: { x: 0, y: 0 } },
    { op: "addNode", ref: "$b", type: "test.blur", position: { x: 200, y: 0 } },
    {
      op: "connect",
      source: { nodeId: "$a", portId: "out" },
      target: { nodeId: "$b", portId: "source" },
    },
  ]);
  const solid = seeded.output.createdIds["$a"] as string;
  const blur = seeded.output.createdIds["$b"] as string;
  return { bus, solid, blur };
}

const nodeCount = (bus: ShaderloomBus) => Object.keys(bus.store.getGraph().nodes).length;
const edgeCount = (bus: ShaderloomBus) => Object.keys(bus.store.getGraph().edges).length;

describe("graph.removeNodes", () => {
  it("deletes the node and its incident edges (§V40)", async () => {
    const { bus, solid } = await harnessWithPair();

    const result = await bus.execute("graph.removeNodes", { nodeIds: [solid] }, invocation);

    expect(result.status).toBe("applied");
    expect(nodeCount(bus)).toBe(1);
    expect(edgeCount(bus)).toBe(0);
  });

  it("refuses an empty selection instead of bumping the revision", async () => {
    const { bus } = await harnessWithPair();
    const before = bus.store.getRevision();

    const result = await bus.execute("graph.removeNodes", { nodeIds: [] }, invocation);

    expect(result.status).toBe("rejected");
    expect(bus.store.getRevision()).toBe(before);
  });

  it("is one undo group — deleting and undoing restores the edge too (§V34, §V65)", async () => {
    const { bus, solid } = await harnessWithPair();
    await bus.execute("graph.removeNodes", { nodeIds: [solid] }, invocation);

    await bus.execute("graph.undo", {}, invocation);

    expect(nodeCount(bus)).toBe(2);
    expect(edgeCount(bus)).toBe(1);
  });
});

describe("copy / cut / paste", () => {
  it("pastes new nodes with new ids and keeps the edge between them (§V35)", async () => {
    const { bus, solid, blur } = await harnessWithPair();

    const copied = await bus.execute("graph.copySelection", { nodeIds: [solid, blur] }, invocation);
    expect(copied.output).toEqual({ nodeCount: 2, edgeCount: 1 });

    const pasted = await bus.execute("graph.paste", {}, invocation);

    expect(pasted.status).toBe("applied");
    expect(nodeCount(bus)).toBe(4);
    expect(edgeCount(bus)).toBe(2);
    // New identity, not a second reference to the same node (§I.file: ids are identity).
    const created = Object.values(pasted.output.createdIds);
    expect(created).not.toContain(solid);
  });

  it("copies the instance state addNode cannot carry", async () => {
    const { bus, solid } = await harnessWithPair();
    await seed(bus, [
      { op: "setNodeUi", nodeId: solid, ui: { bypassed: true } },
      { op: "setNodeFormat", nodeId: solid, format: { mode: "fixed", format: "rgba8unorm" } },
    ]);

    await bus.execute("graph.copySelection", { nodeIds: [solid] }, invocation);
    const pasted = await bus.execute("graph.paste", {}, invocation);
    const newId = pasted.output.createdIds["$copy:" + solid] as string;

    const copy = bus.store.getGraph().nodes[newId];
    expect(copy?.ui?.bypassed).toBe(true);
    expect(copy?.format).toEqual({ mode: "fixed", format: "rgba8unorm" });
  });

  it("cut removes the original and fills the clipboard", async () => {
    const { bus, solid } = await harnessWithPair();

    await bus.execute("graph.cutSelection", { nodeIds: [solid] }, invocation);
    expect(nodeCount(bus)).toBe(1);

    await bus.execute("graph.paste", {}, invocation);
    expect(nodeCount(bus)).toBe(2);
  });

  it("refuses to paste an empty clipboard rather than applying nothing", async () => {
    const { bus } = await harnessWithPair();
    const before = bus.store.getRevision();

    const result = await bus.execute("graph.paste", {}, invocation);

    expect(result.status).toBe("rejected");
    expect(bus.store.getRevision()).toBe(before);
  });

  it("leaves the clipboard alone on a dry run (§V36)", async () => {
    const { bus, solid } = await harnessWithPair();

    await bus.execute(
      "graph.copySelection",
      { nodeIds: [solid] },
      { ...invocation, dryRun: true },
    );
    const result = await bus.execute("graph.paste", {}, invocation);

    expect(result.status).toBe("rejected");
  });
});

describe("graph.duplicateSelection", () => {
  it("duplicates the selection, offset, edges included", async () => {
    const { bus, solid, blur } = await harnessWithPair();

    await bus.execute("graph.duplicateSelection", { nodeIds: [solid, blur] }, invocation);

    expect(nodeCount(bus)).toBe(4);
    expect(edgeCount(bus)).toBe(2);
    const original = bus.store.getGraph().nodes[solid];
    const copies = Object.values(bus.store.getGraph().nodes).filter(
      (node) => node.type === "test.solid" && node.id !== solid,
    );
    expect(copies).toHaveLength(1);
    expect(copies[0]?.position.x).toBeGreaterThan(original?.position.x ?? 0);
  });
});

describe("node ui toggles", () => {
  it("turns the flag on for the whole selection, then off again", async () => {
    const { bus, solid, blur } = await harnessWithPair();

    await bus.execute("node.toggleBypass", { nodeIds: [solid, blur] }, invocation);
    expect(bus.store.getGraph().nodes[solid]?.ui?.bypassed).toBe(true);
    expect(bus.store.getGraph().nodes[blur]?.ui?.bypassed).toBe(true);

    await bus.execute("node.toggleBypass", { nodeIds: [solid, blur] }, invocation);
    expect(bus.store.getGraph().nodes[solid]?.ui?.bypassed).toBe(false);
  });

  it("brings a mixed selection to ON rather than leaving it half-toggled", async () => {
    const { bus, solid, blur } = await harnessWithPair();
    await bus.execute("node.toggleRender", { nodeIds: [solid] }, invocation);

    await bus.execute("node.toggleRender", { nodeIds: [solid, blur] }, invocation);

    expect(bus.store.getGraph().nodes[solid]?.ui?.muted).toBe(true);
    expect(bus.store.getGraph().nodes[blur]?.ui?.muted).toBe(true);
  });

  it("writes the display flag the node view actually reads", async () => {
    const { bus, solid } = await harnessWithPair();

    await bus.execute("node.toggleDisplay", { nodeIds: [solid] }, invocation);

    expect(bus.store.getGraph().nodes[solid]?.ui?.preview).toBe(true);
  });
});

describe("commands the keymap names but nothing implements", () => {
  it("stays unregistered rather than stubbed, so the palette can say so honestly", async () => {
    const { bus } = createHarness("u");

    // Registering any of these would make the palette look complete while the action
    // silently did nothing — the failure mode this task explicitly forbids.
    for (const name of [
      "node.rename",
      "view.home",
      "view.frameAll",
      "graph.layout",
      "graph.diveIn",
      "graph.jumpUp",
      "transport.togglePlay",
      "project.save",
      "runtime.resetFeedback",
    ]) {
      expect(bus.hasCommand(name)).toBe(false);
    }
  });
});
