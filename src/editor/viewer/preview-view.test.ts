import { describe, expect, it, vi } from "vitest";
import { alice, contextFor, createHarness } from "@domain/commands/test-support.ts";
import type { ShaderloomBus } from "@domain/commands/bus.ts";
import { DEFAULT_PREVIEW_LENS, DEFAULT_PREVIEW_VIEW } from "@runtime/previews/index.ts";
import {
  MAX_EXPOSURE_STOPS,
  RESET_PREVIEW_VIEW_COMMAND,
  SET_PREVIEW_VIEW_COMMAND,
  previewViewTargetFor,
  registerPreviewViewCommands,
} from "./preview-view-command.ts";
import { createPreviewViewStore, previewViewStoreFor } from "./preview-view-store.ts";

/**
 * T336 — the preview LENS.
 *
 * `PreviewView` shipped with T34 and every caller passed the default, so channel isolation,
 * exposure and the tonemap were live in the shader and unreachable from the product — the
 * CAPABILITY-without-UI shape of §V220. What is pinned here is the half that makes it
 * reachable, and the two decisions that could quietly go the other way later:
 *
 *  - a lens is SESSION state. It makes no patch, bumps no revision and leaves no undo entry,
 *    because a look is not an edit. The tests below assert the document is untouched, which
 *    is the thing that would break the day someone "helpfully" persisted it.
 *  - the lens reaches the PREVIEW path only (§V255, §V70a). Nothing here can address the
 *    present blit, and there is no code path from a command to it.
 */

async function seedNode(bus: ShaderloomBus): Promise<string> {
  const result = await bus.execute(
    "graph.applyPatch",
    {
      baseRevision: bus.store.getRevision(),
      label: "seed",
      operations: [{ op: "addNode", ref: "$blur", type: "test.blur", position: { x: 0, y: 0 } }],
    },
    contextFor(alice),
  );
  const id = result.output.createdIds["$blur"];
  if (id === undefined) throw new Error("fixture patch was rejected");
  return id;
}

describe("the lens store", () => {
  it("reads the default for a node nobody has touched", () => {
    const store = createPreviewViewStore();
    expect(store.get("n1")).toEqual(DEFAULT_PREVIEW_LENS);
    expect(store.isDefault("n1")).toBe(true);
    expect(store.viewFor("n1")).toEqual(DEFAULT_PREVIEW_VIEW);
  });

  it("applies one field at a time, so isolating a channel does not clear the exposure", () => {
    const store = createPreviewViewStore();
    store.set("n1", { exposureStops: 2 });
    const lens = store.set("n1", { lens: "g" });
    expect(lens).toEqual({ lens: "g", exposureStops: 2, tonemap: false });
  });

  it("scopes a lens to its own node", () => {
    const store = createPreviewViewStore();
    store.set("n1", { lens: "a" });
    expect(store.get("n2")).toEqual(DEFAULT_PREVIEW_LENS);
  });

  it("widens the lens into the full view the preview pass takes", () => {
    const store = createPreviewViewStore();
    store.set("n1", { lens: "luminance", exposureStops: 1, tonemap: true });
    const view = store.viewFor("n1");
    expect(view.mode).toBe("luminance");
    expect(view.exposureStops).toBe(1);
    expect(view.tonemap).toBe(true);
  });

  it("notifies only the node that changed, and only when something did", () => {
    const store = createPreviewViewStore();
    const one = vi.fn();
    const two = vi.fn();
    store.subscribe("n1", one);
    store.subscribe("n2", two);

    store.set("n1", { lens: "r" });
    expect(one).toHaveBeenCalledTimes(1);
    expect(two).not.toHaveBeenCalled();

    // Setting the same value again is not a change — a preview tick must not repaint for it.
    store.set("n1", { lens: "r" });
    expect(one).toHaveBeenCalledTimes(1);
  });

  it("forgets a node that is back to the plain picture", () => {
    const store = createPreviewViewStore();
    store.set("n1", { lens: "b", exposureStops: 3, tonemap: true });
    expect(store.isDefault("n1")).toBe(false);
    store.reset("n1");
    expect(store.isDefault("n1")).toBe(true);
    expect(store.get("n1")).toEqual(DEFAULT_PREVIEW_LENS);
  });

  it("stops notifying an unsubscribed listener", () => {
    const store = createPreviewViewStore();
    const listener = vi.fn();
    const unsubscribe = store.subscribe("n1", listener);
    unsubscribe();
    store.set("n1", { lens: "r" });
    expect(listener).not.toHaveBeenCalled();
  });

  it("hands every surface on one bus the SAME store", () => {
    // Three surfaces need this instance — the preview tick, the popup, the slot badge — and
    // a second store would make the popup change a lens nothing renders.
    const { bus } = createHarness();
    expect(previewViewStoreFor(bus)).toBe(previewViewStoreFor(bus));
  });
});

describe("preview.setView / preview.resetView (§V78)", () => {
  it("registers once, however many surfaces mount", () => {
    const { bus } = createHarness();
    registerPreviewViewCommands(bus);
    expect(() => registerPreviewViewCommands(bus)).not.toThrow();
    expect(bus.hasCommand(SET_PREVIEW_VIEW_COMMAND)).toBe(true);
    expect(bus.hasCommand(RESET_PREVIEW_VIEW_COMMAND)).toBe(true);
  });

  it("sets the lens the store hands to the preview tick", async () => {
    const { bus } = createHarness();
    const store = registerPreviewViewCommands(bus);
    const nodeId = await seedNode(bus);

    const result = await bus.execute(
      SET_PREVIEW_VIEW_COMMAND,
      { nodeId, lens: "g", exposureStops: 1 },
      contextFor(alice),
    );

    expect(result.status).toBe("applied");
    expect(result.output.view).toEqual({ lens: "g", exposureStops: 1, tonemap: false });
    expect(store.viewFor(nodeId).mode).toBe("channel");
    expect(store.viewFor(nodeId).channel).toBe("g");
  });

  it("is NOT an edit — no patch, no revision bump, no undo entry", async () => {
    // The persistence decision, asserted. If a later change makes the lens document state,
    // this is the test that must be deliberately rewritten rather than quietly passing.
    const { bus } = createHarness();
    registerPreviewViewCommands(bus);
    const nodeId = await seedNode(bus);
    const before = bus.store.getRevision();
    const graphBefore = bus.store.getGraph();

    await bus.execute(SET_PREVIEW_VIEW_COMMAND, { nodeId, lens: "a" }, contextFor(alice));

    expect(bus.store.getRevision()).toBe(before);
    expect(bus.store.getGraph()).toEqual(graphBefore);
    expect(bus.store.getGraph().nodes[nodeId]?.ui).toEqual(graphBefore.nodes[nodeId]?.ui);
  });

  it("falls back to the selected node when the caller names none", async () => {
    const { bus } = createHarness();
    const store = registerPreviewViewCommands(bus);
    const nodeId = await seedNode(bus);
    previewViewTargetFor(bus).current = nodeId;

    const result = await bus.execute(SET_PREVIEW_VIEW_COMMAND, { lens: "r" }, contextFor(alice));

    expect(result.status).toBe("applied");
    expect(store.get(nodeId).lens).toBe("r");
  });

  it("refuses with a reason when nothing is selected, rather than guessing a node", async () => {
    const { bus } = createHarness();
    registerPreviewViewCommands(bus);
    await seedNode(bus);
    previewViewTargetFor(bus).current = null;

    const result = await bus.execute(SET_PREVIEW_VIEW_COMMAND, { lens: "r" }, contextFor(alice));

    expect(result.status).toBe("rejected");
    expect(result.diagnostics?.[0]?.code).toBe("preview.noTarget");
  });

  it("refuses a node that is not in the graph", async () => {
    const { bus } = createHarness();
    registerPreviewViewCommands(bus);
    const result = await bus.execute(
      SET_PREVIEW_VIEW_COMMAND,
      { nodeId: "nope", lens: "r" },
      contextFor(alice),
    );
    expect(result.status).toBe("rejected");
    expect(result.diagnostics?.[0]?.code).toBe("preview.unknownNode");
  });

  it("refuses a lens nobody wrote a shader for", async () => {
    // An agent sends JSON, so the closed union is only closed if something checks it.
    const { bus } = createHarness();
    const store = registerPreviewViewCommands(bus);
    const nodeId = await seedNode(bus);
    const result = await bus.execute(
      SET_PREVIEW_VIEW_COMMAND,
      { nodeId, lens: "chroma" as never },
      contextFor(alice),
    );
    expect(result.status).toBe("rejected");
    expect(result.diagnostics?.[0]?.code).toBe("preview.unknownLens");
    expect(store.isDefault(nodeId)).toBe(true);
  });

  it("clamps exposure and never stores a non-finite one (§V66)", async () => {
    const { bus } = createHarness();
    const store = registerPreviewViewCommands(bus);
    const nodeId = await seedNode(bus);

    await bus.execute(SET_PREVIEW_VIEW_COMMAND, { nodeId, exposureStops: 400 }, contextFor(alice));
    expect(store.get(nodeId).exposureStops).toBe(MAX_EXPOSURE_STOPS);

    await bus.execute(SET_PREVIEW_VIEW_COMMAND, { nodeId, exposureStops: NaN }, contextFor(alice));
    expect(Number.isFinite(store.get(nodeId).exposureStops)).toBe(true);
  });

  it("a dry run answers without changing anything (§V36)", async () => {
    const { bus } = createHarness();
    const store = registerPreviewViewCommands(bus);
    const nodeId = await seedNode(bus);

    const result = await bus.execute(
      SET_PREVIEW_VIEW_COMMAND,
      { nodeId, lens: "b" },
      contextFor(alice, { dryRun: true }),
    );

    expect(result.status).toBe("applied");
    expect(result.output.view?.lens).toBe("b");
    expect(store.isDefault(nodeId)).toBe(true);
  });

  it("resets back to the plain picture", async () => {
    const { bus } = createHarness();
    const store = registerPreviewViewCommands(bus);
    const nodeId = await seedNode(bus);
    await bus.execute(
      SET_PREVIEW_VIEW_COMMAND,
      { nodeId, lens: "luminance", exposureStops: 2, tonemap: true },
      contextFor(alice),
    );

    const result = await bus.execute(RESET_PREVIEW_VIEW_COMMAND, { nodeId }, contextFor(alice));

    expect(result.status).toBe("applied");
    expect(store.isDefault(nodeId)).toBe(true);
    expect(store.viewFor(nodeId)).toEqual(DEFAULT_PREVIEW_VIEW);
  });
});
