import { beforeEach, describe, expect, it } from "vitest";
import type { Harness } from "./test-support.ts";
import { alice, bob, contextFor, createHarness, patch } from "./test-support.ts";

/**
 * Per-node resolution and format overrides (§V50, §V51) — TouchDesigner's Common page.
 */
describe("node output overrides", () => {
  let h: Harness;
  let nodeId: string;

  beforeEach(async () => {
    h = createHarness();
    const created = await h.bus.execute(
      "graph.applyPatch",
      patch(0, [{ op: "addNode", ref: "$n", type: "test.blur", position: { x: 0, y: 0 } }]),
      contextFor(alice),
    );
    nodeId = created.output.createdIds["$n"] as string;
  });

  const node = () => h.store.view.getGraph().nodes[nodeId];

  /** Absent override is the default — the node's own policy applies. */
  it("a new node carries no override", () => {
    expect(node()?.resolution).toBeUndefined();
    expect(node()?.format).toBeUndefined();
  });

  it("sets and clears a resolution override", async () => {
    await h.bus.execute(
      "node.setResolution",
      { nodeId, resolution: { mode: "scale", factor: 0.5 } },
      contextFor(alice),
    );
    expect(node()?.resolution).toEqual({ mode: "scale", factor: 0.5 });

    await h.bus.execute("node.setResolution", { nodeId, resolution: null }, contextFor(alice));
    expect(node()?.resolution).toBeUndefined();
  });

  it("sets and clears a format override", async () => {
    await h.bus.execute(
      "node.setFormat",
      { nodeId, format: { mode: "fixed", format: "rgba16float" } },
      contextFor(alice),
    );
    expect(node()?.format).toEqual({ mode: "fixed", format: "rgba16float" });

    await h.bus.execute("node.setFormat", { nodeId, format: null }, contextFor(alice));
    expect(node()?.format).toBeUndefined();
  });

  it("keeps resolution and format independent", async () => {
    await h.bus.execute("node.setResolution", { nodeId, resolution: { mode: "project" } }, contextFor(alice));
    await h.bus.execute("node.setFormat", { nodeId, format: { mode: "input" } }, contextFor(alice));

    expect(node()?.resolution).toEqual({ mode: "project" });
    expect(node()?.format).toEqual({ mode: "input" });
  });

  /** §V51: depth is not a selectable colour output. */
  it("rejects a depth format and leaves the node untouched", async () => {
    const before = node();
    const result = await h.bus.execute(
      "node.setFormat",
      { nodeId, format: { mode: "fixed", format: "depth24plus" } as never },
      contextFor(alice),
    );

    expect(result.status).toBe("rejected");
    expect(result.diagnostics.some((d) => d.code === "node.format.invalid")).toBe(true);
    expect(node()).toEqual(before);
  });

  it("rejects a non-positive scale factor", async () => {
    const result = await h.bus.execute(
      "node.setResolution",
      { nodeId, resolution: { mode: "scale", factor: 0 } },
      contextFor(alice),
    );
    expect(result.status).toBe("rejected");
    expect(node()?.resolution).toBeUndefined();
  });

  it("rejects a fractional fixed resolution", async () => {
    const result = await h.bus.execute(
      "node.setResolution",
      { nodeId, resolution: { mode: "fixed", width: 100.5, height: 100 } },
      contextFor(alice),
    );
    expect(result.status).toBe("rejected");
    expect(node()?.resolution).toBeUndefined();
  });

  /** §V29/§V32: these commands go THROUGH the patch path, so they inherit its guarantees. */
  it("bumps the revision and writes an audit entry naming the actor", async () => {
    const before = h.store.view.getRevision();
    await h.bus.execute("node.setResolution", { nodeId, resolution: { mode: "project" } }, contextFor(bob));

    expect(h.store.view.getRevision()).toBeGreaterThan(before);
    const audit = await h.bus.query("graph.audit", {}, contextFor(bob));
    const last = audit.at(-1);
    expect(last?.command).toBe("node.setResolution");
    expect(last?.actor.id).toBe("bob");
  });

  /** §V36: dryRun validates without mutating and without an applied audit entry. */
  it("dryRun reports what would happen but changes nothing", async () => {
    const beforeRevision = h.store.view.getRevision();
    const beforeAudit = (await h.bus.query("graph.audit", {}, contextFor(alice))).length;

    const result = await h.bus.execute(
      "node.setResolution",
      { nodeId, resolution: { mode: "fixed", width: 512, height: 512 } },
      contextFor(alice, { dryRun: true }),
    );

    // §V36/T102: "validated", not "applied" — the override was never written.
    expect(result.status).toBe("validated");
    expect(result.output.status).toBe("validated");
    expect(node()?.resolution).toBeUndefined();
    expect(h.store.view.getRevision()).toBe(beforeRevision);
    expect((await h.bus.query("graph.audit", {}, contextFor(alice))).length).toBe(beforeAudit);
  });

  /** §V15/§V34: one command is one undo group. */
  it("undo restores the previous override", async () => {
    await h.bus.execute("node.setResolution", { nodeId, resolution: { mode: "project" } }, contextFor(alice));
    await h.bus.execute(
      "node.setResolution",
      { nodeId, resolution: { mode: "scale", factor: 2 } },
      contextFor(alice),
    );
    expect(node()?.resolution).toEqual({ mode: "scale", factor: 2 });

    await h.bus.execute("graph.undo", {}, contextFor(alice));
    expect(node()?.resolution).toEqual({ mode: "project" });

    await h.bus.execute("graph.undo", {}, contextFor(alice));
    expect(node()?.resolution).toBeUndefined();
  });

  it("rejects an override on a node that does not exist", async () => {
    const result = await h.bus.execute(
      "node.setResolution",
      { nodeId: "no-such-node", resolution: { mode: "project" } },
      contextFor(alice),
    );
    expect(result.status).toBe("rejected");
  });
});

/**
 * Renaming (§V29). A label is per-instance; absence means "use the definition's title",
 * so an unrenamed node keeps following a definition that is later retitled.
 */
describe("node.rename", () => {
  let h2: Harness;
  let id: string;

  beforeEach(async () => {
    h2 = createHarness();
    const created = await h2.bus.execute(
      "graph.applyPatch",
      patch(0, [{ op: "addNode", ref: "$n", type: "test.blur", position: { x: 0, y: 0 } }]),
      contextFor(alice),
    );
    id = created.output.createdIds["$n"] as string;
  });

  const node2 = () => h2.store.view.getGraph().nodes[id];

  it("a new node is auto-named from its type (§V129, T221)", () => {
    // The label is the NAME now: unique per graph, numbered at creation, so
    // `op('blur1')` has something stable to resolve against.
    expect(node2()?.label).toBe("blur1");
  });

  it("sets a label", async () => {
    await h2.bus.execute("node.rename", { nodeId: id, label: "Bloom pass" }, contextFor(alice));
    expect(node2()?.label).toBe("Bloom pass");
  });

  it("trims surrounding whitespace rather than storing it", async () => {
    await h2.bus.execute("node.rename", { nodeId: id, label: "  Edge detect  " }, contextFor(alice));
    expect(node2()?.label).toBe("Edge detect");
  });

  /** Clearing is null, not "" — absence is what "follow the definition" means. */
  it("null clears the label", async () => {
    await h2.bus.execute("node.rename", { nodeId: id, label: "Temp" }, contextFor(alice));
    await h2.bus.execute("node.rename", { nodeId: id, label: null }, contextFor(alice));
    expect(node2()?.label).toBeUndefined();
  });

  it("rejects a blank label instead of storing an invisible name", async () => {
    const result = await h2.bus.execute("node.rename", { nodeId: id, label: "   " }, contextFor(alice));
    expect(result.status).toBe("rejected");
    expect(result.diagnostics.some((d) => d.code === "node.label.empty")).toBe(true);
    expect(node2()?.label).toBe("blur1"); // the auto-assigned name survives the rejected rename
  });

  it("rejects an absurdly long label", async () => {
    const result = await h2.bus.execute(
      "node.rename",
      { nodeId: id, label: "x".repeat(200) },
      contextFor(alice),
    );
    expect(result.status).toBe("rejected");
  });

  it("is undoable as one step", async () => {
    await h2.bus.execute("node.rename", { nodeId: id, label: "First" }, contextFor(alice));
    await h2.bus.execute("node.rename", { nodeId: id, label: "Second" }, contextFor(alice));
    await h2.bus.execute("graph.undo", {}, contextFor(alice));
    expect(node2()?.label).toBe("First");
  });

  it("rejects renaming a node that does not exist", async () => {
    const result = await h2.bus.execute(
      "node.rename",
      { nodeId: "nope", label: "X" },
      contextFor(alice),
    );
    expect(result.status).toBe("rejected");
  });
});
