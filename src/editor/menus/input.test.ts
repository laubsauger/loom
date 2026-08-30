import { beforeEach, describe, expect, it } from "vitest";
import { alice, contextFor } from "@domain/commands/test-support.ts";
import type { MenuItem, MenuTarget } from "@domain/types/menus.ts";
import { resolveMenuInput } from "./input.ts";
import { menuFixture, type MenuFixture } from "./test-support.ts";

/**
 * Target → command input (T126, §V29).
 *
 * The menu never mutates anything itself; it builds the input for a bus command. So the
 * thing worth testing is that the input it builds is the one the user meant — and that
 * an input it cannot complete is refused instead of sent half-formed.
 */

let fixture: MenuFixture;

beforeEach(async () => {
  fixture = await menuFixture();
});

const item = (command: string, extra: Partial<MenuItem> = {}): MenuItem =>
  ({ command, label: "x", ...extra }) as MenuItem;

describe("node commands", () => {
  const node = (nodeId: string): MenuTarget => ({ surface: "node", nodeId });

  it("acts on the clicked node when it is not part of the selection", () => {
    const resolved = resolveMenuInput(
      item("graph.removeNodes"),
      node(fixture.solid),
      fixture.context([fixture.blur]),
    );
    expect(resolved).toEqual({ ok: true, input: { nodeIds: [fixture.solid] } });
  });

  it("acts on the whole selection when the clicked node is inside it", () => {
    // Right-clicking one of five selected nodes and deleting only that one is the
    // classic node-editor papercut.
    const resolved = resolveMenuInput(
      item("graph.removeNodes"),
      node(fixture.solid),
      fixture.context([fixture.blur, fixture.solid]),
    );
    expect(resolved).toEqual({ ok: true, input: { nodeIds: [fixture.blur, fixture.solid].sort() } });
  });

  it("refuses when there is no node under the cursor", () => {
    const resolved = resolveMenuInput(item("graph.removeNodes"), { surface: "node" }, fixture.context());
    expect(resolved.ok).toBe(false);
  });
});

describe("add node here", () => {
  it("builds a one-operation patch at the cursor position", () => {
    const resolved = resolveMenuInput(
      item("graph.applyPatch", { input: { type: "test.blur" } }),
      { surface: "canvas", position: { x: 30, y: 70 } },
      fixture.context(),
    );
    expect(resolved).toEqual({
      ok: true,
      input: {
        baseRevision: fixture.bus.store.getRevision(),
        label: "Add node",
        operations: [
          { op: "addNode", ref: "$added", type: "test.blur", position: { x: 30, y: 70 } },
        ],
      },
    });
  });

  it("refuses an add-node item that names no type", () => {
    expect(resolveMenuInput(item("graph.applyPatch"), { surface: "canvas" }, fixture.context()).ok).toBe(
      false,
    );
  });

  it("really adds the node when the resulting input goes to the bus (§V29)", async () => {
    const resolved = resolveMenuInput(
      item("graph.applyPatch", { input: { type: "test.blur" } }),
      { surface: "canvas", position: { x: 30, y: 70 } },
      fixture.context(),
    );
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    const before = Object.keys(fixture.bus.store.getGraph().nodes).length;
    await fixture.bus.execute("graph.applyPatch", resolved.input as never, contextFor(alice));
    expect(Object.keys(fixture.bus.store.getGraph().nodes).length).toBe(before + 1);
  });
});

describe("disconnecting", () => {
  it("collects every edge on the clicked port", () => {
    const resolved = resolveMenuInput(
      item("graph.applyPatch"),
      { surface: "port", nodeId: fixture.blur, portId: "source" },
      fixture.context(),
    );
    expect(resolved).toEqual({
      ok: true,
      input: {
        baseRevision: fixture.bus.store.getRevision(),
        label: "Disconnect",
        operations: [{ op: "disconnect", edgeIds: [fixture.edgeId] }],
      },
    });
  });

  it("deletes exactly the clicked edge", async () => {
    const resolved = resolveMenuInput(
      item("graph.applyPatch"),
      { surface: "edge", edgeId: fixture.edgeId },
      fixture.context(),
    );
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    await fixture.bus.execute("graph.applyPatch", resolved.input as never, contextFor(alice));
    expect(fixture.bus.store.getGraph().edges[fixture.edgeId]).toBeUndefined();
  });

  it("refuses when the port has nothing connected", () => {
    const resolved = resolveMenuInput(
      item("graph.applyPatch"),
      { surface: "port", nodeId: fixture.solid, portId: "in" },
      fixture.context(),
    );
    expect(resolved.ok).toBe(false);
  });
});

describe("parameters", () => {
  const parameter: MenuTarget = { surface: "parameter", nodeId: "", parameterKey: "radius" };

  /**
   * T246: reset is `parameter.reset`, not a menu-built patch. The command owns the
   * §V149 rules (mode restored too, retained payloads kept, and it says what it cleared)
   * and a patch assembled here could only ever implement half of them.
   */
  it("resets through the command that owns the rules", async () => {
    const target = { ...parameter, nodeId: fixture.blur };
    await fixture.bus.execute(
      "graph.applyPatch",
      {
        baseRevision: fixture.bus.store.getRevision(),
        label: "edit",
        operations: [{ op: "setParameters", nodeId: fixture.blur, parameters: { radius: 12 } }],
      },
      contextFor(alice),
    );

    const resolved = resolveMenuInput(item("parameter.reset"), target, fixture.context());
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    await fixture.bus.execute("parameter.reset", resolved.input as never, contextFor(alice));
    expect(fixture.bus.store.getGraph().nodes[fixture.blur]?.parameters["radius"]).toBe(4);
  });

  it("passes the node and key to the commands that only need a reference", () => {
    const target = { ...parameter, nodeId: fixture.blur };
    expect(resolveMenuInput(item("parameter.copyReference"), target, fixture.context())).toEqual({
      ok: true,
      input: { nodeId: fixture.blur, parameterKey: "radius" },
    });
    expect(resolveMenuInput(item("component.publishParameter"), target, fixture.context())).toEqual({
      ok: true,
      input: { nodeId: fixture.blur, parameterKey: "radius" },
    });
  });

  it("merges the mode submenu's static input onto the parameter reference", () => {
    const target = { ...parameter, nodeId: fixture.blur };
    const modeItem = { command: "parameter.setMode" as never, input: { mode: "expression" }, label: "Expression" };
    expect(resolveMenuInput(modeItem, target, fixture.context())).toEqual({
      ok: true,
      input: { nodeId: fixture.blur, parameterKey: "radius", mode: "expression" },
    });
  });
});

describe("commands that want nothing from the target", () => {
  it("passes the item's static input through untouched", () => {
    expect(resolveMenuInput(item("graph.paste"), { surface: "canvas" }, fixture.context())).toEqual({
      ok: true,
      input: {},
    });
    expect(
      resolveMenuInput(
        item("graph.selectAll", { input: { scope: "all" } }),
        { surface: "canvas" },
        fixture.context(),
      ),
    ).toEqual({ ok: true, input: { scope: "all" } });
  });

  it("hands the cursor position to the node search, so it opens where the click was", () => {
    expect(
      resolveMenuInput(
        item("ui.openNodeSearch"),
        { surface: "canvas", position: { x: 5, y: 6 } },
        fixture.context(),
      ),
    ).toEqual({ ok: true, input: { position: { x: 5, y: 6 } } });
  });
});
