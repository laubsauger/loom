import { describe, expect, it } from "vitest";
import { alice, contextFor, createHarness } from "@domain/commands/test-support.ts";
import type { PreferenceStorage } from "@editor/nodes/node-type-labels.ts";
import {
  SCROLL_PAN_DEFAULT,
  SCROLL_PAN_STORAGE_KEY,
  TOGGLE_SCROLL_PAN_COMMAND,
  createScrollPanStore,
  registerScrollPanCommand,
  scrollPanStore,
} from "./scroll-pan-command.ts";

/**
 * `view.toggleScrollPan` and the preference behind it (T1724b).
 *
 * What a scroll does to the graph is a choice about one's own hands and hardware: per
 * PERSON, persisted, never in a `.loom.json`. Each test pins one consequence: the
 * TouchDesigner default, the reload round trip, the corrupt entry, the refused write,
 * one store across buses, and a command that edits nothing.
 */

function memoryStorage(initial: Record<string, string> = {}): PreferenceStorage & { data: Record<string, string> } {
  const data = { ...initial };
  return {
    data,
    getItem: (key) => data[key] ?? null,
    setItem: (key, value) => {
      data[key] = value;
    },
  };
}

const invocation = contextFor(alice);

describe("the scroll gesture preference round-trips through storage", () => {
  it("zooms by default, as TouchDesigner's wheel does", () => {
    expect(SCROLL_PAN_DEFAULT).toBe(false);
    expect(createScrollPanStore(memoryStorage()).get()).toBe(false);
    expect(createScrollPanStore(null).get()).toBe(false);
  });

  it("pans on one store and still pans on the next — the reload case", () => {
    const storage = memoryStorage();
    createScrollPanStore(storage).set(true);
    expect(storage.data[SCROLL_PAN_STORAGE_KEY]).toBe("pan");
    expect(createScrollPanStore(storage).get()).toBe(true);
    createScrollPanStore(storage).set(false);
    expect(storage.data[SCROLL_PAN_STORAGE_KEY]).toBe("zoom");
    expect(createScrollPanStore(storage).get()).toBe(false);
  });

  it("reads a corrupt entry as the default", () => {
    expect(createScrollPanStore(memoryStorage({ [SCROLL_PAN_STORAGE_KEY]: "true" })).get()).toBe(false);
    expect(createScrollPanStore(memoryStorage({ [SCROLL_PAN_STORAGE_KEY]: "" })).get()).toBe(false);
  });

  it("still changes what a scroll does when the storage refuses the write", () => {
    const store = createScrollPanStore({
      getItem: () => null,
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
    });
    let notified = 0;
    store.subscribe(() => {
      notified += 1;
    });
    expect(store.set(true)).toBe(true);
    expect(store.get()).toBe(true);
    expect(notified).toBe(1);
  });

  it("is one store for the person, not one per bus", () => {
    const { bus: one } = createHarness("one");
    const { bus: two } = createHarness("two");
    expect(registerScrollPanCommand(one)).toBe(registerScrollPanCommand(two));
    expect(registerScrollPanCommand(one)).toBe(scrollPanStore());
  });
});

describe("view.toggleScrollPan flips the preference through the bus (§V29)", () => {
  it("flips when `pan` is omitted, obeys it when given, and a dry run changes nothing", async () => {
    const { bus } = createHarness("s");
    const store = registerScrollPanCommand(bus);
    store.set(false);
    const flipped = await bus.execute(TOGGLE_SCROLL_PAN_COMMAND, {}, invocation);
    expect(flipped.status).toBe("applied");
    expect(flipped.output).toEqual({ pan: true });
    expect(store.get()).toBe(true);
    const explicit = await bus.execute(TOGGLE_SCROLL_PAN_COMMAND, { pan: false }, invocation);
    expect(explicit.output).toEqual({ pan: false });
    const dry = await bus.execute(TOGGLE_SCROLL_PAN_COMMAND, {}, { ...invocation, dryRun: true });
    expect(dry.status).toBe("validated");
    expect(dry.output).toEqual({ pan: true });
    expect(store.get()).toBe(false);
  });

  it("writes no patch and bumps no revision — how one scrolls is not an edit", async () => {
    const { bus } = createHarness("s");
    registerScrollPanCommand(bus);
    const revision = bus.store.getRevision();
    await bus.execute(TOGGLE_SCROLL_PAN_COMMAND, {}, invocation);
    expect(bus.store.getRevision()).toBe(revision);
    scrollPanStore().set(false);
  });
});
