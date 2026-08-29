import { describe, expect, it, vi } from "vitest";
import { alice, contextFor, createHarness } from "@domain/commands/test-support.ts";
import type { NodeId } from "@domain/types/ids.ts";
import type { FrameScheduler } from "@ui/controls/coalesce.ts";
import { createParameterEditor } from "./parameter-editor.ts";

/**
 * The editing path from a control to the document (T37, T38).
 *
 * Three invariants are being defended, and they are the reason this module exists at
 * all: §V29 (the bus is the only mutation path), §V5 (values coalesce to frames rather
 * than one patch per pointer event) and §V15 (a continuous drag applies live values but
 * collapses into ONE undo entry).
 */

function manualScheduler(): { schedule: FrameScheduler; frame: () => void } {
  let queued: Array<() => void> = [];
  return {
    schedule: (callback) => {
      queued.push(callback);
      return () => {
        queued = queued.filter((entry) => entry !== callback);
      };
    },
    frame: () => {
      const due = queued;
      queued = [];
      for (const callback of due) callback();
    },
  };
}

async function setup() {
  const harness = createHarness("pe");
  const context = contextFor(alice);
  const result = await harness.bus.execute(
    "graph.applyPatch",
    {
      baseRevision: 0,
      operations: [{ op: "addNode", ref: "$blur", type: "test.blur", position: { x: 0, y: 0 } }],
    },
    context,
  );
  const nodeId = result.output.createdIds["$blur"] as NodeId;
  const scheduler = manualScheduler();
  let ids = 0;
  const editor = createParameterEditor({
    bus: harness.bus,
    context,
    schedule: scheduler.schedule,
    newTransactionId: () => `txn-${(ids += 1)}`,
  });
  return { ...harness, context, nodeId, scheduler, editor };
}

const radiusOf = (harness: Awaited<ReturnType<typeof setup>>): unknown =>
  harness.bus.store.getGraph().nodes[harness.nodeId]?.parameters["radius"];

describe("§V15 — a continuous drag is one undo entry", () => {
  it("applies every live value but records a single undo group", async () => {
    const harness = await setup();
    const { editor, scheduler, nodeId } = harness;

    // A drag: many live values, then the value the user released on.
    for (const value of [5, 6, 7]) {
      editor.setParameter(nodeId, "radius", value, "live");
      scheduler.frame();
      await editor.settled();
    }
    editor.setParameter(nodeId, "radius", 8, "commit");
    await editor.settled();

    expect(radiusOf(harness)).toBe(8);
    const history = harness.store.view.getHistory(alice);
    // One group for the node creation, one for the whole drag.
    expect(history.undo).toHaveLength(2);
    expect(history.undo.at(-1)?.label).toBe("Set radius");
  });

  it("undoes the whole drag in one step, back to the value it started from", async () => {
    const harness = await setup();
    const { editor, scheduler, nodeId, context } = harness;

    expect(radiusOf(harness)).toBe(4); // manifest default

    for (const value of [5, 6, 7]) {
      editor.setParameter(nodeId, "radius", value, "live");
      scheduler.frame();
      await editor.settled();
    }
    editor.setParameter(nodeId, "radius", 8, "commit");
    await editor.settled();

    await harness.bus.execute("graph.undo", {}, context);
    // Not 7 — the intermediate frames are not undo steps of their own (§V15).
    expect(radiusOf(harness)).toBe(4);
  });

  it("starts a new undo group for the next gesture", async () => {
    const harness = await setup();
    const { editor, nodeId } = harness;

    editor.setParameter(nodeId, "radius", 5, "commit");
    await editor.settled();
    editor.setParameter(nodeId, "radius", 6, "commit");
    await editor.settled();

    expect(harness.store.view.getHistory(alice).undo).toHaveLength(3);
  });
});

describe("§V5 — parameter updates coalesce to animation frames", () => {
  it("writes once per frame no matter how many values the gesture produced", async () => {
    const harness = await setup();
    const { editor, scheduler, nodeId } = harness;
    const before = harness.bus.store.getRevision();

    for (let value = 5; value <= 30; value += 1) {
      editor.setParameter(nodeId, "radius", value, "live");
    }
    scheduler.frame();
    await editor.settled();

    // 26 values, one revision — not 26 revisions and 26 audit entries.
    expect(harness.bus.store.getRevision()).toBe(before + 1);
    expect(radiusOf(harness)).toBe(30);
  });

  it("lets a commit supersede the value queued for this frame", async () => {
    const harness = await setup();
    const { editor, scheduler, nodeId } = harness;

    editor.setParameter(nodeId, "radius", 12, "live");
    editor.setParameter(nodeId, "radius", 20, "commit");
    scheduler.frame();
    await editor.settled();

    expect(radiusOf(harness)).toBe(20);
  });
});

describe("§V29/§V30 — everything goes through the bus, with an actor", () => {
  it("writes an audit entry for every applied edit", async () => {
    const harness = await setup();
    const { editor, nodeId } = harness;

    editor.setParameter(nodeId, "radius", 9, "commit");
    await editor.settled();

    const audit = harness.store.view.getAudit();
    const last = audit.at(-1);
    expect(last?.command).toBe("graph.applyPatch");
    expect(last?.actor).toEqual(alice);
    expect(last?.status).toBe("applied");
  });

  it("reports diagnostics instead of silently dropping a rejected edit", async () => {
    const onDiagnostics = vi.fn();
    const harness = createHarness("pe2");
    const context = contextFor(alice);
    const editor = createParameterEditor({ bus: harness.bus, context, onDiagnostics });

    editor.setParameter("missing-node" as NodeId, "radius", 1, "commit");
    await editor.settled();

    expect(onDiagnostics).toHaveBeenCalledTimes(1);
    const diagnostics = onDiagnostics.mock.calls[0]?.[0] as Array<{ code: string }>;
    expect(diagnostics[0]?.code).toBe("node.missing");
  });

  it("queues patches so a fast gesture never conflicts with itself (§V33)", async () => {
    const harness = await setup();
    const { editor, nodeId } = harness;

    // Fired without awaiting: each patch must read the revision AFTER the previous one.
    editor.setParameter(nodeId, "radius", 1, "commit");
    editor.setParameter(nodeId, "radius", 2, "commit");
    editor.setParameter(nodeId, "radius", 3, "commit");
    await editor.settled();

    expect(radiusOf(harness)).toBe(3);
    expect(
      harness.store.view.getAudit().filter((entry) => entry.status !== "applied"),
    ).toEqual([]);
  });
});

describe("§V50/§V51 — the Common section's commands", () => {
  it("sets and then clears a resolution override with null", async () => {
    const harness = await setup();
    const { editor, nodeId } = harness;

    await editor.setResolution(nodeId, { mode: "scale", factor: 0.5 });
    expect(harness.bus.store.getGraph().nodes[nodeId]?.resolution).toEqual({
      mode: "scale",
      factor: 0.5,
    });

    await editor.setResolution(nodeId, null);
    // Cleared, not set to {mode:"auto"} — absence is what "follow the definition" means.
    expect(harness.bus.store.getGraph().nodes[nodeId]?.resolution).toBeUndefined();
  });

  it("sets and clears a format override the same way", async () => {
    const harness = await setup();
    const { editor, nodeId } = harness;

    await editor.setFormat(nodeId, { mode: "fixed", format: "rgba16float" });
    expect(harness.bus.store.getGraph().nodes[nodeId]?.format).toEqual({
      mode: "fixed",
      format: "rgba16float",
    });

    await editor.setFormat(nodeId, null);
    expect(harness.bus.store.getGraph().nodes[nodeId]?.format).toBeUndefined();
  });
});

describe("editor lifecycle", () => {
  it("stops writing once disposed, so an unmounted pane cannot mutate the graph", async () => {
    const harness = await setup();
    const { editor, scheduler, nodeId } = harness;
    const revision = harness.bus.store.getRevision();

    editor.setParameter(nodeId, "radius", 42, "live");
    editor.dispose();
    scheduler.frame();
    await editor.settled();

    expect(harness.bus.store.getRevision()).toBe(revision);
  });

  it("knows whether a gesture is still open", async () => {
    const harness = await setup();
    const { editor, nodeId } = harness;

    expect(editor.isEditing(nodeId, "radius")).toBe(false);
    editor.setParameter(nodeId, "radius", 5, "live");
    expect(editor.isEditing(nodeId, "radius")).toBe(true);
    editor.setParameter(nodeId, "radius", 6, "commit");
    expect(editor.isEditing(nodeId, "radius")).toBe(false);
    await editor.settled();
  });
});
