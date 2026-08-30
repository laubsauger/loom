import { describe, expect, it } from "vitest";
import { DEFAULT_PROJECT_SETTINGS } from "../types/graph.ts";
import { alice, bob, contextFor } from "./test-support.ts";
import { createDomainBus } from "./index.ts";

/**
 * `project.setSettings` (T272, §V177, §V29, §V68).
 *
 * Settings are document state, so the interesting assertions are the document ones: one
 * revision, one undo entry that actually restores, a partial patch that does not clobber
 * the fields it did not name, and a refusal that leaves the document alone.
 */

function harness() {
  const { bus, store } = createDomainBus();
  return { bus, store, ctx: contextFor(alice) };
}

describe("a settings edit is a document edit", () => {
  it("writes the field and bumps the revision", async () => {
    const { bus, store, ctx } = harness();
    const before = store.view.getRevision();

    const result = await bus.execute("project.setSettings", { settings: { fps: 30 } }, ctx);

    expect(result.status).toBe("applied");
    expect(result.output.changed).toEqual(["fps"]);
    expect(store.view.getSettings().fps).toBe(30);
    expect(store.view.getRevision()).toBeGreaterThan(before);
  });

  it("is PARTIAL: fields it does not name keep their values", async () => {
    const { bus, store, ctx } = harness();
    await bus.execute("project.setSettings", { settings: { fps: 24 } }, ctx);
    await bus.execute("project.setSettings", { settings: { randomSeed: 7 } }, ctx);

    // Two controls edited in sequence must not clobber each other. A command taking a
    // WHOLE settings object would make the second write carry the first's stale copy.
    expect(store.view.getSettings().fps).toBe(24);
    expect(store.view.getSettings().randomSeed).toBe(7);
    expect(store.view.getSettings().workingFormat).toBe(DEFAULT_PROJECT_SETTINGS.workingFormat);
  });

  it("reports the CLASSIFICATION, so the caller need not derive it again", async () => {
    const { bus, ctx } = harness();
    const rate = await bus.execute("project.setSettings", { settings: { fps: 30 } }, ctx);
    expect(rate.output.structural).toBe(false);

    const structural = await bus.execute(
      "project.setSettings",
      { settings: { outputResolution: { width: 640, height: 480 } } },
      ctx,
    );
    expect(structural.output.structural).toBe(true);
  });

  it("does nothing at all when the value is already what was asked for", async () => {
    const { bus, store, ctx } = harness();
    const revision = store.view.getRevision();
    const result = await bus.execute(
      "project.setSettings",
      { settings: { workingFormat: DEFAULT_PROJECT_SETTINGS.workingFormat } },
      ctx,
    );
    expect(result.status).toBe("applied");
    expect(result.output.changed).toEqual([]);
    // No revision burned, so autosave does not write and undo has nothing to swallow.
    expect(store.view.getRevision()).toBe(revision);
  });
});

describe("undo restores settings, as one entry (§V177)", () => {
  it("puts the previous value back", async () => {
    const { bus, store, ctx } = harness();
    await bus.execute("project.setSettings", { settings: { fps: 24 } }, ctx);
    expect(store.view.getSettings().fps).toBe(24);

    await bus.execute("graph.undo", {}, ctx);
    expect(store.view.getSettings().fps).toBe(DEFAULT_PROJECT_SETTINGS.fps);

    await bus.execute("graph.redo", {}, ctx);
    expect(store.view.getSettings().fps).toBe(24);
  });

  it("makes ONE entry for one edit, whatever it touched", async () => {
    const { bus, store, ctx } = harness();
    await bus.execute(
      "project.setSettings",
      { settings: { fps: 24, randomSeed: 5 }, label: "Set frame rate" },
      ctx,
    );
    const history = store.view.getHistory(alice);
    expect(history.undo).toHaveLength(1);
    expect(history.undo[0]?.label).toBe("Set frame rate");

    // One press restores both fields: two entries would leave the document in a state
    // the user never authored.
    await bus.execute("graph.undo", {}, ctx);
    expect(store.view.getSettings().fps).toBe(DEFAULT_PROJECT_SETTINGS.fps);
    expect(store.view.getSettings().randomSeed).toBe(DEFAULT_PROJECT_SETTINGS.randomSeed);
  });

  it("is per actor, like every other undo (§V41)", async () => {
    const { bus, store } = harness();
    await bus.execute("project.setSettings", { settings: { fps: 24 } }, contextFor(alice));
    // Bob has nothing to undo; Alice's settings edit is not his to roll back.
    await bus.execute("graph.undo", {}, contextFor(bob));
    expect(store.view.getSettings().fps).toBe(24);
  });
});

describe("a bad patch is refused, not coerced (§V37, §V68)", () => {
  it("rejects a field the schema does not accept and leaves the document alone", async () => {
    const { bus, store, ctx } = harness();
    const revision = store.view.getRevision();
    const result = await bus.execute(
      "project.setSettings",
      { settings: { fps: "fast" } as never },
      ctx,
    );
    expect(result.status).toBe("rejected");
    expect(result.output.ok).toBe(false);
    expect(result.diagnostics[0]?.code).toBe("project.settings.invalid");
    expect(store.view.getRevision()).toBe(revision);
    expect(store.view.getSettings().fps).toBe(DEFAULT_PROJECT_SETTINGS.fps);
  });

  it("validates each supplied field exactly as the loader would", async () => {
    const { bus, store, ctx } = harness();
    const result = await bus.execute(
      "project.setSettings",
      { settings: { workingFormat: "not-a-format" } as never },
      ctx,
    );
    expect(result.status).toBe("rejected");
    expect(store.view.getSettings().workingFormat).toBe(DEFAULT_PROJECT_SETTINGS.workingFormat);
  });
});
