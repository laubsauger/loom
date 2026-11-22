import { describe, expect, it, vi } from "vitest";
import { alice, contextFor, createHarness } from "@domain/commands/test-support.ts";
import type { LoomBus } from "@domain/commands/bus.ts";
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

async function seedNode(bus: LoomBus): Promise<string> {
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
    expect(lens).toEqual({ lens: "g", exposureStops: 2, tonemap: false, colormap: "none" });
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
    expect(result.output.view).toEqual({ lens: "g", exposureStops: 1, tonemap: false, colormap: "none" });
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
    // §T1556b: the bus checks it now, against the command's input schema (the lens enum is
    // `PREVIEW_LENSES`), and names the field and the lenses there are.
    expect(result.diagnostics?.[0]?.code).toBe("command.input");
    expect(result.diagnostics?.[0]?.message).toContain("invalid at lens");
    expect(result.diagnostics?.[0]?.message).toContain("'luminance'");
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

/**
 * Owner 2026-11-22 — a Depth node's preview STARTS in a colour map (Turbo: near red, far
 * blue), because its output is one value read as a picture. That start is the node's
 * default, not an alteration: no marker, no reset, and stored as absence. Everything else
 * still starts as the plain picture.
 */
describe("a node's own default lens (previewColormap)", () => {
  async function busWithDepth() {
    const { createGraphStore } = await import("@domain/graph/store.ts");
    const { createSequentialIdFactory } = await import("@domain/graph/ids.ts");
    const { createDomainBus } = await import("@domain/commands/index.ts");
    const { createNodeRegistry } = await import("@nodes/registry/registry.ts");
    const { allNodeDefinitions } = await import("@nodes/definitions/index.ts");
    const store = createGraphStore({ ids: createSequentialIdFactory("n"), now: () => "2026-11-22T00:00:00.000Z" });
    const { bus } = createDomainBus({ store, registry: createNodeRegistry(allNodeDefinitions).view() });
    const result = await bus.execute("graph.applyPatch", {
      baseRevision: bus.store.getRevision(), label: "seed",
      operations: [
        { op: "addNode", ref: "$depth", type: "depth", position: { x: 0, y: 0 } },
        { op: "addNode", ref: "$blur", type: "blur", position: { x: 200, y: 0 } },
      ],
    }, contextFor(alice));
    return { bus, depth: result.output.createdIds["$depth"]!, blur: result.output.createdIds["$blur"]! };
  }

  it("starts Depth in Turbo and everything else in the picture, both as 'default'", async () => {
    const { bus, depth, blur } = await busWithDepth();
    const store = previewViewStoreFor(bus);
    expect(store.get(depth)).toEqual({ ...DEFAULT_PREVIEW_LENS, colormap: "turbo" });
    expect(store.viewFor(depth)).toMatchObject({ mode: "colormap", colormap: 1, colormapLuminance: true });
    expect(store.isDefault(depth)).toBe(true);
    expect(store.get(blur)).toBe(DEFAULT_PREVIEW_LENS);
    // The same object each read, or a React snapshot of it never settles.
    expect(store.get(depth)).toBe(store.get(depth));
  });

  it("lets a person turn it off, which IS an alteration, and reset returns to Turbo", async () => {
    const { bus, depth } = await busWithDepth();
    const store = registerPreviewViewCommands(bus);
    const off = await bus.execute(SET_PREVIEW_VIEW_COMMAND, { nodeId: depth, colormap: "none" }, contextFor(alice));
    expect(off.output.view).toMatchObject({ colormap: "none" });
    expect(store.isDefault(depth)).toBe(false);
    expect(store.viewFor(depth).mode).toBe("color");
    await bus.execute(RESET_PREVIEW_VIEW_COMMAND, { nodeId: depth }, contextFor(alice));
    expect(store.get(depth).colormap).toBe("turbo");
    expect(store.isDefault(depth)).toBe(true);
    // Choosing Turbo by hand on a Depth node changes nothing and stores nothing.
    store.set(depth, { colormap: "turbo" });
    expect(store.isDefault(depth)).toBe(true);
  });

  it("maps the one channel an R/G/B/A lens isolates, and luminance otherwise", async () => {
    const { bus, depth } = await busWithDepth();
    const store = previewViewStoreFor(bus);
    store.set(depth, { lens: "g", colormap: "viridis" });
    expect(store.viewFor(depth)).toMatchObject({ mode: "colormap", colormap: 3, colormapLuminance: false, channel: "g" });
  });
});
