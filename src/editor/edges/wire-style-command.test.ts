import { describe, expect, it } from "vitest";
import { alice, contextFor, createHarness } from "@domain/commands/test-support.ts";
import type { PreferenceStorage } from "@editor/nodes/node-type-labels.ts";
import { WIRE_STYLES } from "./wire-path.ts";
import {
  SET_WIRE_STYLE_COMMAND,
  WIRE_STYLE_STORAGE_KEY,
  createWireStyleStore,
  registerWireStyleCommand,
  wireStyleStore,
} from "./wire-style-command.ts";

/**
 * `view.setWireStyle` and the preference behind it (T1820b).
 *
 * How wires are drawn is a choice about one's own screen: per PERSON, persisted, never in a
 * `.loom.json`. Each test pins one consequence: the curved default, the reload round trip,
 * the corrupt entry, the refused write, one store across buses, and a command that edits
 * nothing.
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

describe("the wire style preference round-trips through storage", () => {
  it("is curved for someone who never chose", () => {
    expect(createWireStyleStore(memoryStorage()).get()).toBe("curved");
    expect(createWireStyleStore(null).get()).toBe("curved");
  });

  it("is still straight after a reload when straight was picked", () => {
    const storage = memoryStorage();
    createWireStyleStore(storage).set("straight");
    expect(storage.data[WIRE_STYLE_STORAGE_KEY]).toBe("straight");
    expect(createWireStyleStore(storage).get()).toBe("straight");
    createWireStyleStore(storage).set("gentle");
    expect(createWireStyleStore(storage).get()).toBe("gentle");
  });

  it("reads a corrupt entry as the default", () => {
    expect(createWireStyleStore(memoryStorage({ [WIRE_STYLE_STORAGE_KEY]: "bezier" })).get()).toBe("curved");
    expect(createWireStyleStore(memoryStorage({ [WIRE_STYLE_STORAGE_KEY]: "" })).get()).toBe("curved");
  });

  it("still changes the wires when the storage refuses the write", () => {
    const store = createWireStyleStore({
      getItem: () => null,
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
    });
    let notified = 0;
    store.subscribe(() => {
      notified += 1;
    });
    expect(store.set("straight")).toBe("straight");
    expect(store.get()).toBe("straight");
    expect(notified).toBe(1);
  });

  it("is one store for the person, not one per bus", () => {
    const { bus: one } = createHarness("one");
    const { bus: two } = createHarness("two");
    expect(registerWireStyleCommand(one)).toBe(registerWireStyleCommand(two));
    expect(registerWireStyleCommand(one)).toBe(wireStyleStore());
  });
});

describe("view.setWireStyle sets the preference through the bus (§V29)", () => {
  it("obeys `style`, steps to the next one when it is omitted, and a dry run changes nothing", async () => {
    const { bus } = createHarness("w");
    const store = registerWireStyleCommand(bus);
    store.set("curved");
    const stepped = await bus.execute(SET_WIRE_STYLE_COMMAND, {}, invocation);
    expect(stepped.status).toBe("applied");
    expect(stepped.output).toEqual({ style: "gentle" });
    const explicit = await bus.execute(SET_WIRE_STYLE_COMMAND, { style: "straight" }, invocation);
    expect(explicit.output).toEqual({ style: "straight" });
    // Wraps: after the last style comes the first.
    const wrapped = await bus.execute(SET_WIRE_STYLE_COMMAND, {}, { ...invocation, dryRun: true });
    expect(wrapped.status).toBe("validated");
    expect(wrapped.output).toEqual({ style: WIRE_STYLES[0] });
    expect(store.get()).toBe("straight");
    store.set("curved");
  });

  it("refuses a style it does not draw", async () => {
    const { bus } = createHarness("w");
    const store = registerWireStyleCommand(bus);
    const refused = await bus.execute(SET_WIRE_STYLE_COMMAND, { style: "spline" as never }, invocation);
    expect(refused.status).toBe("rejected");
    expect(store.get()).toBe("curved");
  });

  it("writes no patch and bumps no revision — how wires are drawn is not an edit", async () => {
    const { bus } = createHarness("w");
    registerWireStyleCommand(bus);
    const revision = bus.store.getRevision();
    await bus.execute(SET_WIRE_STYLE_COMMAND, { style: "straight" }, invocation);
    expect(bus.store.getRevision()).toBe(revision);
    wireStyleStore().set("curved");
  });
});
