import { beforeEach, describe, expect, it } from "vitest";
import { alice, contextFor } from "@domain/commands/test-support.ts";
import type { MenuTarget } from "@domain/types/menus.ts";
import { evaluateMenuGuard, menuGuardValue } from "./guards.ts";
import { menuFixture, type MenuFixture } from "./test-support.ts";

/**
 * `when` guards (T126).
 *
 * A guard answers a question about the TARGET, and the same answer drives both the
 * disabled state of an item and the checkmark on a toggle — asking "is this bypassed"
 * in two places is how a checkmark and a menu drift apart.
 */

let fixture: MenuFixture;

beforeEach(async () => {
  fixture = await menuFixture();
});

const port = (nodeId: string, portId: string): MenuTarget => ({ surface: "port", nodeId, portId });

describe("canDisconnect", () => {
  it("passes on a connected port", () => {
    const target = port(fixture.blur, "source");
    expect(evaluateMenuGuard("canDisconnect", target, fixture.context())).toEqual({ ok: true });
  });

  it("refuses an unconnected port, and says why", () => {
    const verdict = evaluateMenuGuard("canDisconnect", port(fixture.solid, "in"), fixture.context());
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reason).toContain("Nothing is connected");
  });

  it("passes on an edge that exists and refuses one that does not", () => {
    const context = fixture.context();
    const live: MenuTarget = { surface: "edge", edgeId: fixture.edgeId };
    const gone: MenuTarget = { surface: "edge", edgeId: "edge-that-was-deleted" };
    expect(evaluateMenuGuard("canDisconnect", live, context).ok).toBe(true);
    expect(evaluateMenuGuard("canDisconnect", gone, context).ok).toBe(false);
  });
});

describe("node state guards", () => {
  const node = (nodeId: string): MenuTarget => ({ surface: "node", nodeId });

  it("reads bypass, mute and preview off the node's own ui state", async () => {
    const target = node(fixture.solid);
    expect(menuGuardValue("isBypassed", target, fixture.context())).toBe(false);

    await fixture.bus.execute(
      "node.toggleBypass",
      { nodeIds: [fixture.solid] },
      contextFor(alice),
    );

    // The context is a snapshot taken when the menu opens, so a fresh one is required
    // to see the change — which is exactly what the host does on the next right-click.
    expect(menuGuardValue("isBypassed", target, fixture.context())).toBe(true);
    expect(menuGuardValue("isMuted", target, fixture.context())).toBe(false);
    expect(menuGuardValue("showsPreview", target, fixture.context())).toBe(false);
  });

  it("is false for a node that is no longer in the document", () => {
    expect(menuGuardValue("isBypassed", node("ghost"), fixture.context())).toBe(false);
  });
});

describe("isOverridden", () => {
  const parameter = (nodeId: string, parameterKey: string): MenuTarget => ({
    surface: "parameter",
    nodeId,
    parameterKey,
  });

  it("refuses a reset when the value already equals the definition default", () => {
    // test.blur declares radius: 4, and the fixture never changed it.
    const verdict = evaluateMenuGuard(
      "isOverridden",
      parameter(fixture.blur, "radius"),
      fixture.context(),
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reason).toContain("default");
  });

  it("passes once the value differs from the default", async () => {
    await fixture.bus.execute(
      "graph.applyPatch",
      {
        baseRevision: fixture.bus.store.getRevision(),
        label: "edit",
        operations: [{ op: "setParameters", nodeId: fixture.blur, parameters: { radius: 12 } }],
      },
      contextFor(alice),
    );
    expect(
      evaluateMenuGuard("isOverridden", parameter(fixture.blur, "radius"), fixture.context()).ok,
    ).toBe(true);
  });

  it("compares array values by content, not identity", () => {
    // test.solid's colour default is [0, 0, 0, 1]; the stored value is a different array.
    expect(
      evaluateMenuGuard("isOverridden", parameter(fixture.solid, "color"), fixture.context()).ok,
    ).toBe(false);
  });
});

describe("authoring mistakes", () => {
  it("treats an unknown guard as a refusal that names itself, never as a pass", () => {
    const verdict = evaluateMenuGuard("hasVibes", { surface: "canvas" }, fixture.context());
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reason).toContain("hasVibes");
  });

  it("supports negation, like the keymap's guards", () => {
    const target = port(fixture.blur, "source");
    expect(evaluateMenuGuard("!canDisconnect", target, fixture.context()).ok).toBe(false);
    expect(evaluateMenuGuard("!canDisconnect", port(fixture.solid, "in"), fixture.context()).ok).toBe(
      true,
    );
  });

  it("an item with no guard always passes", () => {
    expect(evaluateMenuGuard(undefined, { surface: "canvas" }, fixture.context())).toEqual({
      ok: true,
    });
  });
});
