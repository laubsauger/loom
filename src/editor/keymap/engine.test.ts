import { beforeEach, describe, expect, it, vi } from "vitest";
import { alice, contextFor, createHarness } from "../../domain/commands/test-support.ts";
import type { ShaderloomBus } from "../../domain/commands/bus.ts";
import { createKeymapEngine } from "./engine.ts";
import type { KeymapDispatch } from "./engine.ts";
import type { KeyEventLike } from "./keys.ts";
import { createKeymapStore } from "./store.ts";
import type { KeyBinding, KeymapEnvironment, Platform } from "./types.ts";

/**
 * The keymap engine (T76, §V52, §V53).
 *
 * Everything here runs headless: key resolution, context precedence, chords and
 * dispatch are pure logic over a bus, and none of it needs React or a DOM.
 */

function binding(overrides: Partial<KeyBinding> & Pick<KeyBinding, "id" | "keys">): KeyBinding {
  return {
    context: "global",
    command: "graph.undo",
    label: overrides.id,
    ...overrides,
  };
}

interface Rig {
  bus: ShaderloomBus;
  executed: { name: string; input: unknown }[];
  press(event: KeyEventLike, context?: KeymapEnvironment["context"]): KeymapDispatch;
  setEnvironment(next: Partial<KeymapEnvironment>): void;
  advance(ms: number): void;
}

function rig(
  bindings: KeyBinding[],
  options: { platform?: Platform; environment?: Partial<KeymapEnvironment> } = {},
): Rig {
  const { bus } = createHarness();
  const executed: { name: string; input: unknown }[] = [];
  const realExecute = bus.execute.bind(bus);
  vi.spyOn(bus, "execute").mockImplementation((name, input, context) => {
    executed.push({ name, input });
    return realExecute(name, input, context);
  });

  const store = createKeymapStore({
    defaults: bindings,
    storage: null,
    platform: options.platform ?? "mac",
  });

  let environment: KeymapEnvironment = {
    context: "global",
    selection: [],
    hoveredNodeId: null,
    ...options.environment,
  };
  let clock = 1000;

  const engine = createKeymapEngine({
    bus,
    platform: options.platform ?? "mac",
    getResolved: () => store.getSnapshot(),
    getEnvironment: () => environment,
    getInvocationContext: () => contextFor(alice),
    now: () => clock,
  });

  return {
    bus,
    executed,
    press: (event, context) =>
      engine.handleKey(event, context === undefined ? undefined : { context }),
    setEnvironment: (next) => {
      environment = { ...environment, ...next };
    },
    advance: (ms) => {
      clock += ms;
    },
  };
}

const modZ = (extra: Partial<KeyEventLike> = {}): KeyEventLike => ({
  key: "z",
  code: "KeyZ",
  metaKey: true,
  ...extra,
});

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("dispatch goes through the bus (§V29, §V52)", () => {
  it("runs the named command, never an inline handler", async () => {
    const test = rig([binding({ id: "undo", keys: "mod+z", command: "graph.undo" })]);
    const result = test.press(modZ());
    expect(result.status).toBe("dispatched");
    if (result.status !== "dispatched") return;
    await result.run;
    expect(test.executed.map((call) => call.name)).toEqual(["graph.undo"]);
  });

  it("reports a binding whose command nobody has registered instead of throwing", async () => {
    const test = rig([
      binding({ id: "play", keys: "space", command: "transport.togglePlay" }),
    ]);
    const result = test.press({ key: " ", code: "Space" });
    expect(result.status).toBe("unresolved");
    if (result.status !== "unresolved") return;
    expect(result.command).toBe("transport.togglePlay");
    expect(test.executed).toEqual([]);
    // And nothing was stubbed onto the bus to make it "work".
    expect(test.bus.hasCommand("transport.togglePlay")).toBe(false);
  });
});

describe("`mod` is Cmd on macOS and Ctrl elsewhere", () => {
  it("fires on Cmd, not Ctrl, on mac", () => {
    const test = rig([binding({ id: "undo", keys: "mod+z" })], { platform: "mac" });
    expect(test.press(modZ()).status).toBe("dispatched");
    expect(test.press({ key: "z", code: "KeyZ", ctrlKey: true }).status).toBe("ignored");
  });

  it("fires on Ctrl, not Cmd, elsewhere", () => {
    const test = rig([binding({ id: "undo", keys: "mod+z" })], { platform: "other" });
    expect(test.press({ key: "z", code: "KeyZ", ctrlKey: true }).status).toBe("dispatched");
    expect(test.press(modZ()).status).toBe("ignored");
  });
});

describe("context precedence — narrowest wins (§V53)", () => {
  const bindings = [
    binding({ id: "global-e", keys: "e", context: "global", command: "graph.undo" }),
    binding({ id: "graph-e", keys: "e", context: "graph", command: "graph.redo" }),
  ];

  it("prefers the pane binding when the pane is active", () => {
    const test = rig(bindings);
    const result = test.press({ key: "e", code: "KeyE" }, "graph");
    expect(result.status === "dispatched" && result.command).toBe("graph.redo");
  });

  it("falls back to the global binding elsewhere", () => {
    const test = rig(bindings);
    const result = test.press({ key: "e", code: "KeyE" }, "inspector");
    expect(result.status === "dispatched" && result.command).toBe("graph.undo");
  });

  it("does not fire a pane binding from another pane", () => {
    const test = rig([binding({ id: "graph-b", keys: "b", context: "graph" })]);
    expect(test.press({ key: "b", code: "KeyB" }, "inspector").status).toBe("ignored");
    expect(test.press({ key: "b", code: "KeyB" }, "graph").status).toBe("dispatched");
  });
});

describe("the `text` context swallows editing keys (§V53)", () => {
  const bindings = [
    binding({ id: "undo", keys: "mod+z", context: "global", command: "graph.undo" }),
    binding({ id: "bypass", keys: "b", context: "graph", command: "graph.redo" }),
    binding({ id: "save", keys: "mod+s", context: "global", command: "graph.applyPatch" }),
  ];

  it("mod+z inside a text field does NOT reach graph undo", () => {
    // The classic node-editor bug, made structural: focus in an <input>, <textarea> or
    // contenteditable puts you in the text context whether or not the pane remembered
    // to say so, and an editing key never leaves it.
    const test = rig(bindings);
    const result = test.press(modZ({ target: { tagName: "TEXTAREA" } }), "graph");
    expect(result.status).toBe("swallowed");
    expect(result.consumed).toBe(false); // the field keeps its native undo
    expect(test.executed).toEqual([]);
  });

  it("swallows for a contenteditable and a bare <input> too", () => {
    const test = rig(bindings);
    expect(test.press(modZ({ target: { isContentEditable: true } })).status).toBe("swallowed");
    expect(test.press(modZ({ target: { tagName: "INPUT", type: "text" } })).status).toBe(
      "swallowed",
    );
  });

  it("swallows a bare letter, so typing 'b' never toggles bypass", () => {
    const test = rig(bindings);
    const result = test.press({ key: "b", code: "KeyB", target: { tagName: "INPUT" } }, "graph");
    expect(result.status).toBe("swallowed");
    expect(test.executed).toEqual([]);
  });

  it("still lets non-editing keys through — mod+s saves while typing", () => {
    const test = rig(bindings);
    const result = test.press({
      key: "s",
      code: "KeyS",
      metaKey: true,
      target: { tagName: "INPUT" },
    });
    expect(result.status).toBe("dispatched");
  });

  it("does not treat a checkbox or a read-only input as a text field", () => {
    const test = rig(bindings);
    expect(test.press(modZ({ target: { tagName: "INPUT", type: "checkbox" } })).status).toBe(
      "dispatched",
    );
    expect(test.press(modZ({ target: { tagName: "INPUT", readOnly: true } })).status).toBe(
      "dispatched",
    );
  });

  it("lets an explicit `text` binding win over the swallow", () => {
    const test = rig([
      ...bindings,
      binding({ id: "text-undo", keys: "mod+z", context: "text", command: "graph.redo" }),
    ]);
    const result = test.press(modZ({ target: { tagName: "TEXTAREA" } }));
    expect(result.status === "dispatched" && result.command).toBe("graph.redo");
  });
});

describe("chords", () => {
  const bindings = [
    binding({ id: "chord", keys: "g d", context: "global", command: "graph.undo" }),
    binding({ id: "single", keys: "x", context: "global", command: "graph.redo" }),
  ];

  const g = { key: "g", code: "KeyG" };
  const d = { key: "d", code: "KeyD" };
  const x = { key: "x", code: "KeyX" };

  it("fires after the full sequence", () => {
    const test = rig(bindings);
    const pending = test.press(g);
    expect(pending.status).toBe("pending");
    expect(pending.consumed).toBe(true);
    const done = test.press(d);
    expect(done.status === "dispatched" && done.command).toBe("graph.undo");
  });

  it("times out, so a much later second key is not read as a chord", () => {
    const test = rig(bindings);
    test.press(g);
    test.advance(5000);
    const late = test.press(d);
    expect(late.status).toBe("ignored");
    expect(test.executed).toEqual([]);
  });

  it("does not swallow an unrelated key when the sequence fails", () => {
    const test = rig(bindings);
    test.press(g);
    // "x" does not continue "g d" — it must still fire its own binding.
    const result = test.press(x);
    expect(result.status === "dispatched" && result.command).toBe("graph.redo");
  });

  it("reports an unmatched key after a failed sequence as ignored, not consumed", () => {
    const test = rig(bindings);
    test.press(g);
    const result = test.press({ key: "q", code: "KeyQ" });
    expect(result.status).toBe("ignored");
    expect(result.consumed).toBe(false);
  });

  it("a bare modifier press neither starts nor breaks a sequence", () => {
    const test = rig(bindings);
    test.press(g);
    expect(test.press({ key: "Shift", code: "ShiftLeft", shiftKey: true }).status).toBe("modifier");
    expect(test.press(d).status).toBe("dispatched");
  });

  it("cannot start a chord while a text field has focus", () => {
    const test = rig(bindings);
    expect(test.press({ ...g, target: { tagName: "INPUT" } }).status).toBe("swallowed");
    expect(test.press(d).status).toBe("ignored");
  });
});

describe("`when` guards and selection-resolved input (T77)", () => {
  const deleteBinding = binding({
    id: "delete",
    keys: "delete",
    context: "graph",
    command: "node.setResolution",
    when: "hasSelection",
    inputFrom: { from: "selection", as: "nodeIds" },
  });

  it("blocks the binding when the guard fails", () => {
    const test = rig([deleteBinding]);
    const result = test.press({ key: "Delete", code: "Delete" }, "graph");
    expect(result.status).toBe("blocked");
    expect(result.consumed).toBe(false);
    expect(test.executed).toEqual([]);
  });

  it("passes the selection to the command when it is satisfied", () => {
    const test = rig([deleteBinding]);
    test.setEnvironment({ selection: ["node-a", "node-b"] });
    const result = test.press({ key: "Delete", code: "Delete" }, "graph");
    expect(result.status).toBe("dispatched");
    if (result.status !== "dispatched") return;
    expect(result.input).toEqual({ nodeIds: ["node-a", "node-b"] });
  });

  it("falls through to a broader binding when the narrower one is guarded off", () => {
    const test = rig([
      deleteBinding,
      binding({ id: "global-delete", keys: "delete", context: "global", command: "graph.undo" }),
    ]);
    const result = test.press({ key: "Delete", code: "Delete" }, "graph");
    expect(result.status === "dispatched" && result.command).toBe("graph.undo");
  });

  it("merges static input with the resolved value", () => {
    const test = rig([
      binding({
        id: "hovered",
        keys: "p",
        context: "graph",
        command: "node.setFormat",
        when: "nodeHovered",
        input: { slot: 1 },
        inputFrom: { from: "hoveredNode", as: "nodeId" },
      }),
    ]);
    test.setEnvironment({ hoveredNodeId: "node-h" });
    const result = test.press({ key: "p", code: "KeyP" }, "graph");
    expect(result.status === "dispatched" && result.input).toEqual({ slot: 1, nodeId: "node-h" });
  });
});

describe("unbound and overridden bindings", () => {
  it("an override replaces the default key", () => {
    const store = createKeymapStore({
      defaults: [binding({ id: "undo", keys: "mod+z" })],
      storage: null,
      platform: "mac",
    });
    store.setOverride("undo", "mod+u");
    const { bus } = createHarness();
    const engine = createKeymapEngine({
      bus,
      platform: "mac",
      getResolved: () => store.getSnapshot(),
      getInvocationContext: () => contextFor(alice),
    });
    expect(engine.handleKey({ key: "z", code: "KeyZ", metaKey: true }).status).toBe("ignored");
    expect(engine.handleKey({ key: "u", code: "KeyU", metaKey: true }).status).toBe("dispatched");
  });

  it("null unbinds — the key does nothing at all", () => {
    const store = createKeymapStore({
      defaults: [binding({ id: "undo", keys: "mod+z" })],
      storage: null,
      platform: "mac",
    });
    store.setOverride("undo", null);
    const { bus } = createHarness();
    const engine = createKeymapEngine({
      bus,
      platform: "mac",
      getResolved: () => store.getSnapshot(),
      getInvocationContext: () => contextFor(alice),
    });
    expect(engine.handleKey({ key: "z", code: "KeyZ", metaKey: true }).status).toBe("ignored");
  });
});
