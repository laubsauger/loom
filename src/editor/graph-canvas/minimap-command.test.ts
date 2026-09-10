import { describe, expect, it } from "vitest";
import { alice, contextFor, createHarness } from "@domain/commands/test-support.ts";
import type { PreferenceStorage } from "@editor/nodes/node-type-labels.ts";
import { allNodeDefinitions } from "@nodes/definitions/index.ts";
import { minimapNodeColor } from "./graph-minimap.tsx";
import {
  MINIMAP_DEFAULT,
  MINIMAP_STORAGE_KEY,
  TOGGLE_MINIMAP_COMMAND,
  createMinimapStore,
  minimapStore,
  registerMinimapCommand,
} from "./minimap-command.ts";

/**
 * `view.toggleMinimap` and the preference behind it (T1257).
 *
 * The map is per PERSON and persisted: a hidden map that comes back on reload is a
 * setting that does not work, and one that arrives inside a `.loom.json` is one person's
 * screen imposed on another's. Each test here pins one of those consequences — the
 * round trip, the corrupt-entry default, the storage that refuses — rather than the
 * mechanism that happens to implement them.
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

describe("the overview map preference round-trips through storage", () => {
  it("is ON by default — the map is what tells a first-time reader where the network went", () => {
    expect(MINIMAP_DEFAULT).toBe(true);
    expect(createMinimapStore(memoryStorage()).get()).toBe(true);
    // No storage at all (a hardened embedder) is the default too, not a crash.
    expect(createMinimapStore(null).get()).toBe(true);
  });

  it("hides on one store and stays hidden on the next — the reload case", () => {
    const storage = memoryStorage();
    createMinimapStore(storage).set(false);
    expect(storage.data[MINIMAP_STORAGE_KEY]).toBe("off");
    expect(createMinimapStore(storage).get()).toBe(false);

    createMinimapStore(storage).set(true);
    expect(storage.data[MINIMAP_STORAGE_KEY]).toBe("on");
    expect(createMinimapStore(storage).get()).toBe(true);
  });

  it("reads a corrupt entry as the default, never as hidden", () => {
    expect(createMinimapStore(memoryStorage({ [MINIMAP_STORAGE_KEY]: "false" })).get()).toBe(true);
    expect(createMinimapStore(memoryStorage({ [MINIMAP_STORAGE_KEY]: "" })).get()).toBe(true);
  });

  it("still changes what is on screen when the storage refuses the write", () => {
    const refusing: PreferenceStorage = {
      getItem: () => null,
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
    };
    const store = createMinimapStore(refusing);
    let notified = 0;
    store.subscribe(() => {
      notified += 1;
    });
    expect(store.set(false)).toBe(false);
    expect(store.get()).toBe(false);
    expect(notified).toBe(1);
  });

  it("is one store for the person, not one per bus", () => {
    const { bus: one } = createHarness("one");
    const { bus: two } = createHarness("two");
    expect(registerMinimapCommand(one)).toBe(registerMinimapCommand(two));
    expect(registerMinimapCommand(one)).toBe(minimapStore());
  });
});

describe("view.toggleMinimap flips the preference through the bus (§V29)", () => {
  it("flips when `show` is omitted, obeys it when given, and a dry run changes nothing", async () => {
    const { bus } = createHarness("m");
    const store = registerMinimapCommand(bus);
    store.set(true);

    const flipped = await bus.execute(TOGGLE_MINIMAP_COMMAND, {}, invocation);
    expect(flipped.status).toBe("applied");
    expect(flipped.output).toEqual({ shown: false });
    expect(store.get()).toBe(false);

    const explicit = await bus.execute(TOGGLE_MINIMAP_COMMAND, { show: true }, invocation);
    expect(explicit.output).toEqual({ shown: true });
    expect(store.get()).toBe(true);

    const dry = await bus.execute(TOGGLE_MINIMAP_COMMAND, {}, { ...invocation, dryRun: true });
    expect(dry.status).toBe("validated");
    expect(dry.output).toEqual({ shown: false });
    expect(store.get()).toBe(true);
  });

  it("writes no patch and bumps no revision — a look at the graph is not an edit", async () => {
    const { bus } = createHarness("m");
    registerMinimapCommand(bus);
    const revision = bus.store.getRevision();
    await bus.execute(TOGGLE_MINIMAP_COMMAND, {}, invocation);
    expect(bus.store.getRevision()).toBe(revision);
  });

  it("registers once per bus, so a remount does not throw", () => {
    const { bus } = createHarness("m");
    registerMinimapCommand(bus);
    expect(() => registerMinimapCommand(bus)).not.toThrow();
    expect(bus.hasCommand(TOGGLE_MINIMAP_COMMAND)).toBe(true);
  });
});

describe("map colours come from the token layer (§V17)", () => {
  it("names a CSS variable for every shipped node, and a literal for none", () => {
    // `var(--…)` and nothing else: no hex, no rgb(), no named colour. A literal here would
    // be the one colour on the canvas that ignores the theme.
    const token = /^var\(--[a-z0-9-]+\)$/i;
    for (const definition of allNodeDefinitions) {
      expect(minimapNodeColor(definition), definition.type).toMatch(token);
    }
    // Sinks have no output port and so no family; they take the dim text tone rather
    // than a colour that would claim a family they do not have.
    const sink = allNodeDefinitions.find((definition) => definition.outputs.length === 0);
    expect(sink, "no sink in the registry — the branch below would be untested").toBeDefined();
    expect(minimapNodeColor(sink)).toBe("var(--text-dim)");
    expect(minimapNodeColor(undefined)).toBe("var(--text-dim)");
    // And a source with an output carries that output's port colour, not the sink tone.
    const texture = allNodeDefinitions.find((definition) => definition.outputs[0]?.type.kind === "texture2d");
    expect(minimapNodeColor(texture)).toBe("var(--port-texture2d)");
  });
});
