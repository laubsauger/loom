import { describe, expect, it } from "vitest";
import { alice, contextFor, createHarness, patch } from "../../domain/commands/test-support.ts";
import type { LoomBus } from "../../domain/commands/bus.ts";
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

async function seed(bus: LoomBus, operations: GraphPatchOperation[]) {
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

const nodeCount = (bus: LoomBus) => Object.keys(bus.store.getGraph().nodes).length;
const edgeCount = (bus: LoomBus) => Object.keys(bus.store.getGraph().edges).length;

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

describe("paste rewrites the copies' references to the COPIES (B44/T371, §V320)", () => {
  /**
   * The inverted member of B41's class: paste DROPPED labels and copied parameters
   * verbatim, so a pasted node's op()/driven/source reference still named the SOURCE —
   * the copy silently drove the original. The gate is §V321-shaped: duplicate a
   * two-node selection with a reference between them and assert the copy drives the COPY.
   */
  async function referenceHarness() {
    const { createGraphStore } = await import("../../domain/graph/store.ts");
    const { createDomainBus } = await import("../../domain/commands/index.ts");
    const { createNodeRegistry } = await import("../../nodes/registry/registry.ts");
    const { allNodeDefinitions } = await import("../../nodes/definitions/index.ts");
    const store = createGraphStore();
    const { bus } = createDomainBus({
      store,
      registry: createNodeRegistry(allNodeDefinitions).view(),
    });
    // `over` auto-names to `over1` (§V129); the feedback records it by that name (§V285).
    const seeded = await bus.execute(
      "graph.applyPatch",
      patch(bus.store.getRevision(), [
        { op: "addNode", ref: "$over", type: "over", position: { x: 0, y: 0 } },
        {
          op: "addNode",
          ref: "$echo",
          type: "feedback",
          position: { x: 0, y: 100 },
          parameters: { source: "over1" },
        },
      ], "seed"),
      invocation,
    );
    expect(seeded.status).toBe("applied");
    return {
      bus,
      over: seeded.output.createdIds["$over"] as string,
      echo: seeded.output.createdIds["$echo"] as string,
    };
  }

  it("a pasted pair's source reference drives the COPY, not the original", async () => {
    const { bus, over, echo } = await referenceHarness();
    await bus.execute("graph.copySelection", { nodeIds: [over, echo] }, invocation);
    const pasted = await bus.execute("graph.paste", {}, invocation);
    expect(pasted.status).toBe("applied");

    const overCopy = pasted.output.createdIds[`$copy:${over}`] as string;
    const echoCopy = pasted.output.createdIds[`$copy:${echo}`] as string;
    const nodes = bus.store.getGraph().nodes;
    // The copy renamed away from the original, and its reference followed the rename.
    expect(nodes[overCopy]?.label).toBe("over2");
    expect(nodes[echoCopy]?.parameters.source).toBe("over2");
    // The original loop is untouched.
    expect(nodes[over]?.label).toBe("over1");
    expect(nodes[echo]?.parameters.source).toBe("over1");
  });

  it("a reference to a node OUTSIDE the selection stays on the original, deliberately", async () => {
    const { bus, echo } = await referenceHarness();
    await bus.execute("graph.copySelection", { nodeIds: [echo] }, invocation);
    const pasted = await bus.execute("graph.paste", {}, invocation);

    const echoCopy = pasted.output.createdIds[`$copy:${echo}`] as string;
    // `over1` was not copied: the pasted feedback still records the original.
    expect(bus.store.getGraph().nodes[echoCopy]?.parameters.source).toBe("over1");
  });

  it("cut then paste keeps the names — a free label is kept, not renumbered", async () => {
    const { bus, over, echo } = await referenceHarness();
    await bus.execute("graph.cutSelection", { nodeIds: [over, echo] }, invocation);
    const pasted = await bus.execute("graph.paste", {}, invocation);
    expect(pasted.status).toBe("applied");

    const nodes = bus.store.getGraph().nodes;
    const overCopy = pasted.output.createdIds[`$copy:${over}`] as string;
    const echoCopy = pasted.output.createdIds[`$copy:${echo}`] as string;
    expect(nodes[overCopy]?.label).toBe("over1");
    expect(nodes[echoCopy]?.parameters.source).toBe("over1");
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

    // T353/§V297: `ui.preview` is the SWITCH and it is default-ON, so the first toggle of
    // an untouched node turns it OFF. Writing `true` here would be the button claiming to
    // have enabled a preview that was already running (§V304).
    await bus.execute("node.toggleDisplay", { nodeIds: [solid] }, invocation);
    expect(bus.store.getGraph().nodes[solid]?.ui?.preview).toBe(false);

    await bus.execute("node.toggleDisplay", { nodeIds: [solid] }, invocation);
    expect(bus.store.getGraph().nodes[solid]?.ui?.preview).toBe(true);
  });

  it("pins separately from the switch, so one never moves the other", async () => {
    const { bus, solid } = await harnessWithPair();

    await bus.execute("node.togglePin", { nodeIds: [solid] }, invocation);

    expect(bus.store.getGraph().nodes[solid]?.ui?.previewPinned).toBe(true);
    // Two fields behind one control is how the button and the picture drifted apart in
    // the first place (§V304); pinning must not switch anything off.
    expect(bus.store.getGraph().nodes[solid]?.ui?.preview).toBeUndefined();
  });
});

/**
 * T1102 — the STACKING ORDER a user places, and the fact that it is a document edit.
 *
 * The assertion is about the ORDER between nodes rather than about the number written: `z`
 * is a position in a sequence, not a magic value, and a test pinned to "z === 1" would go
 * red on a perfectly good renumbering. What the compositor and the DOM both consume is
 * "which node's number is bigger", so that is what these state.
 */
describe("node.bringToFront (T1102)", () => {
  const zOf = (bus: LoomBus, nodeId: string): number => bus.store.getGraph().nodes[nodeId]?.ui?.z ?? 0;

  it("raises a node above every other node in the graph", async () => {
    const { bus, solid, blur } = await harnessWithPair();
    // Both start at the floor: an untouched document has no stacking order at all, which
    // is the state every project saved before this field existed is in.
    expect(bus.store.getGraph().nodes[solid]?.ui?.z).toBeUndefined();

    await bus.execute("node.bringToFront", { nodeIds: [blur] }, invocation);
    expect(zOf(bus, blur)).toBeGreaterThan(zOf(bus, solid));

    // And the other way round with nothing else changed — the pair is what makes this a
    // claim about order rather than about which node happens to be called `blur`.
    await bus.execute("node.bringToFront", { nodeIds: [solid] }, invocation);
    expect(zOf(bus, solid)).toBeGreaterThan(zOf(bus, blur));
  });

  it("keeps a multi-selection's own order instead of flattening it", async () => {
    const { bus, solid, blur } = await harnessWithPair();
    await bus.execute("node.bringToFront", { nodeIds: [blur] }, invocation);
    const before = zOf(bus, blur) > zOf(bus, solid);

    // Raising both must not silently collapse the arrangement the user just built: they
    // would have to rebuild it to discover it was gone.
    await bus.execute("node.bringToFront", { nodeIds: [solid, blur] }, invocation);
    expect(zOf(bus, blur) > zOf(bus, solid)).toBe(before);
  });

  it("is an ordinary undoable document edit, not view state", async () => {
    // The whole persisted-vs-derived decision in one assertion: if this were view state
    // there would be nothing for undo to restore, and nothing for a save to write.
    const { bus, solid, blur } = await harnessWithPair();
    await bus.execute("node.bringToFront", { nodeIds: [blur] }, invocation);
    expect(zOf(bus, blur)).toBeGreaterThan(zOf(bus, solid));

    await bus.execute("graph.undo", {}, invocation);
    expect(bus.store.getGraph().nodes[blur]?.ui?.z).toBeUndefined();
  });

  it("refuses an empty selection rather than bumping the revision", async () => {
    const { bus } = await harnessWithPair();
    const before = bus.store.getRevision();
    const result = await bus.execute("node.bringToFront", { nodeIds: [] }, invocation);
    expect(result.status).toBe("rejected");
    expect(bus.store.getRevision()).toBe(before);
  });

  it("refuses a non-integer z through the patch layer, whoever writes it", async () => {
    // The command can only mint integers; an agent or a hand-written patch can try
    // anything, and a NaN would make the whole stacking order incomparable with no bad
    // pixel to point at (§V66's shape: validate before anything reads the field).
    const { bus, solid } = await harnessWithPair();
    const result = await bus.execute(
      "graph.applyPatch",
      patch(bus.store.getRevision(), [{ op: "setNodeUi", nodeId: solid, ui: { z: 1.5 } }], "bad z"),
      invocation,
    );
    expect(result.status).toBe("rejected");
    expect(bus.store.getGraph().nodes[solid]?.ui?.z).toBeUndefined();
  });
});

describe("commands the keymap names but nothing implements", () => {
  it("stays unregistered rather than stubbed, so the palette can say so honestly", async () => {
    const { bus } = createHarness("u");

    // Registering any of these would make the palette look complete while the action
    // silently did nothing — the failure mode this task explicitly forbids.
    for (const name of [
      // node.rename moved OUT of this list when GraphNode.label and the setNodeLabel
      // patch op landed — it is now a real command, not a would-be no-op.
      "view.home",
      "view.frameAll",
      // `graph.layout`/`graph.layoutAll` left this list in B84: they ARE registered now,
      // by `registerLayoutCommands` in `createDomainBus`. `view.*` stay because their
      // registrar lives beside the canvas, not on the domain bus.
      //
      // T423 moved `graph.diveIn`/`graph.jumpUp` from "nobody implements it" to
      // "registered beside the canvas", the same category `view.*` is in — WHICH component
      // you are inside is view state, so `registerComponentNavigationCommands` lives in
      // `src/app` and the DOMAIN bus still does not have them. §V333 is why they are not
      // simply left here with the old reason: absence on THIS harness stopped meaning
      // absence in the product the moment the app registered them, and the assertion that
      // still knows the difference is `composition-seams.test.ts`, which reads both.
      "transport.togglePlay",
      "project.save",
      "runtime.resetFeedback",
    ]) {
      expect(bus.hasCommand(name)).toBe(false);
    }
  });
});
