// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { alice, contextFor } from "@domain/commands/test-support.ts";
import type { MenuItem, MenuTarget } from "@domain/types/menus.ts";
import { isMenuSeparator } from "@domain/types/menus.ts";
import { resolveMenuInput } from "./input.ts";
import { menuSchemaFor } from "./schemas.ts";
import { menuFixture } from "./test-support.ts";
import { PARAMETER_KEY_ATTRIBUTE, PARAMETER_NODE_ATTRIBUTE, resolveMenuTarget } from "./target.ts";

/**
 * Target resolution (T126, §V78).
 *
 * ONE root per surface only works if a click can say what it landed on. These tests are
 * written against React Flow's own DOM markers — the ones the canvas already renders —
 * so a library upgrade that changed them fails here rather than in production.
 */

function html(markup: string): HTMLElement {
  const host = document.createElement("div");
  host.innerHTML = markup;
  document.body.append(host);
  return host;
}

afterEach(() => {
  document.body.innerHTML = "";
});

const CANVAS = `
  <div class="react-flow__node" data-id="node-1">
    <div class="inner">
      <span class="title">Blur</span>
      <div class="react-flow__handle" data-nodeid="node-1" data-handleid="source" data-id="rf-node-1-source-target"></div>
    </div>
  </div>
  <svg><g class="react-flow__edge" data-id="edge-1"><path class="react-flow__edge-path"></path></g></svg>
  <div class="pane"></div>
`;

describe("resolving a click", () => {
  it("picks the node, not the canvas, for a click inside a node", () => {
    const host = html(CANVAS);
    const title = host.querySelector(".title");
    expect(resolveMenuTarget(title, { fallback: "canvas" })).toEqual({
      surface: "node",
      nodeId: "node-1",
    });
  });

  it("picks the port, not the node, for a click on a handle", () => {
    const host = html(CANVAS);
    const handle = host.querySelector(".react-flow__handle");
    // The handle lives INSIDE the node, so nearest-marker-wins is the whole rule.
    expect(resolveMenuTarget(handle, { fallback: "canvas" })).toEqual({
      surface: "port",
      nodeId: "node-1",
      portId: "source",
    });
  });

  it("picks the edge for a click on an edge path", () => {
    const host = html(CANVAS);
    const path = host.querySelector(".react-flow__edge-path");
    expect(resolveMenuTarget(path, { fallback: "canvas" })).toEqual({
      surface: "edge",
      edgeId: "edge-1",
    });
  });

  it("falls back to the pane's own surface on empty canvas", () => {
    const host = html(CANVAS);
    expect(resolveMenuTarget(host.querySelector(".pane"), { fallback: "canvas" })).toEqual({
      surface: "canvas",
    });
  });

  it("resolves nothing when the pane declares no fallback", () => {
    const host = html(CANVAS);
    expect(resolveMenuTarget(host.querySelector(".pane"))).toBeNull();
  });

  it("carries the graph-space position so 'add node here' lands under the cursor", () => {
    const host = html(CANVAS);
    const target = resolveMenuTarget(host.querySelector(".pane"), {
      fallback: "canvas",
      position: { x: 120, y: -40 },
    });
    expect(target?.position).toEqual({ x: 120, y: -40 });
  });
});

describe("the parameter surface", () => {
  const ROW = `
    <div ${PARAMETER_NODE_ATTRIBUTE}="node-7">
      <div ${PARAMETER_KEY_ATTRIBUTE}="radius"><label>Radius</label></div>
    </div>
  `;

  it("resolves a parameter row to its node and key", () => {
    const host = html(ROW);
    expect(resolveMenuTarget(host.querySelector("label"))).toEqual({
      surface: "parameter",
      nodeId: "node-7",
      parameterKey: "radius",
    });
  });

  it("refuses a parameter with no owning node rather than guessing one", () => {
    // A half-formed parameter target would build a command with no nodeId (§V29).
    const host = html(`<div ${PARAMETER_KEY_ATTRIBUTE}="radius"><label>Radius</label></div>`);
    expect(resolveMenuTarget(host.querySelector("label"))).toBeNull();
  });

  /**
   * §T1034 — A CONTROL ON A NODE MUST REACH THE SAME MENU AS ONE IN THE INSPECTOR.
   *
   * §T1033 removed double-click-to-reset, correctly: reset was already on the parameter
   * context menu, and the second click of a double landed inside the text editor the first
   * click had opened and destroyed the number. What was checked was the INSPECTOR, where
   * the pane root carries `data-node-id` and the menu duly opens. On the canvas there is
   * no such ancestor — React Flow spells it `data-id` — so the parameter branch fell
   * through and the walk resolved to the NODE instead: the wrong menu, no reset on it, and
   * no error to say so. §V840's shape exactly, a property proven for one path and assumed
   * for its sibling.
   *
   * The first test below is the DOM half — the one that was assumed. The second walks the
   * whole way a right-click actually travels, DOM to bus, and reads the parameter back at
   * its manifest default: `resolveMenuInput` already had the target→input half covered
   * (`input.test.ts`), and covering both halves separately is what let the join break.
   */
  const ON_CANVAS = `
    <div class="react-flow__node" data-id="node-1">
      <span class="title">Blur</span>
      <div class="controls">
        <div ${PARAMETER_KEY_ATTRIBUTE}="radius"><label>Radius</label></div>
      </div>
    </div>
  `;

  it("resolves a control INSIDE a graph node to its parameter, not to the node", () => {
    const host = html(ON_CANVAS);
    expect(resolveMenuTarget(host.querySelector("label"), { fallback: "canvas" })).toEqual({
      surface: "parameter",
      nodeId: "node-1",
      parameterKey: "radius",
    });
    // And the node itself still resolves to the node: the new owner lookup runs only
    // under a parameter key, so it cannot turn a click on the title bar into one.
    expect(resolveMenuTarget(host.querySelector(".title"), { fallback: "canvas" })).toEqual({
      surface: "node",
      nodeId: "node-1",
    });
  });

  it("lets a panel embedded in a node own its own parameters (nearest marker wins)", () => {
    // `Inspector`'s node variant sets `data-node-id` on its own root. Inside a graph node
    // that is the nearer marker and it must win, or an embedded inspector would address
    // whichever node it happened to be drawn inside.
    const host = html(`
      <div class="react-flow__node" data-id="node-1">
        <div ${PARAMETER_NODE_ATTRIBUTE}="node-7">
          <div ${PARAMETER_KEY_ATTRIBUTE}="radius"><label>Radius</label></div>
        </div>
      </div>
    `);
    expect(resolveMenuTarget(host.querySelector("label"))).toEqual({
      surface: "parameter",
      nodeId: "node-7",
      parameterKey: "radius",
    });
  });

  it("reaches parameter.reset from a right-click on a control drawn on a node", async () => {
    const fixture = await menuFixture();
    await fixture.bus.execute(
      "graph.applyPatch",
      {
        baseRevision: fixture.bus.store.getRevision(),
        label: "edit",
        operations: [{ op: "setParameters", nodeId: fixture.blur, parameters: { radius: 12 } }],
      },
      contextFor(alice),
    );
    expect(fixture.bus.store.getGraph().nodes[fixture.blur]?.parameters["radius"]).toBe(12);

    const host = html(`
      <div class="react-flow__node" data-id="${fixture.blur}">
        <div ${PARAMETER_KEY_ATTRIBUTE}="radius"><label>Radius</label></div>
      </div>
    `);
    const target = resolveMenuTarget(host.querySelector("label"), { fallback: "canvas" });
    // The menu the host would open for this target is the parameter one — asked for the
    // way the host asks — and reset is on it, gated on `isOverridden`, which is what the
    // edit above makes true.
    expect(target).not.toBeNull();
    const schema = menuSchemaFor((target as MenuTarget).surface, fixture.bus.registry);
    expect(schema.surface).toBe("parameter");
    const reset = schema.entries.find(
      (entry) => !isMenuSeparator(entry) && entry.command === "parameter.reset",
    );
    expect(reset).toBeDefined();

    const resolved = resolveMenuInput(reset as MenuItem, target as MenuTarget, fixture.context());
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    await fixture.bus.execute("parameter.reset", resolved.input as never, contextFor(alice));
    // 4 is `test.blur`'s manifest default — the value the user could not get back to.
    expect(fixture.bus.store.getGraph().nodes[fixture.blur]?.parameters["radius"]).toBe(4);
  });
});

describe("the walk", () => {
  it("stops at the host boundary instead of escaping into the rest of the app", () => {
    document.body.innerHTML = `
      <div class="react-flow__node" data-id="outside">
        <div id="host"><span id="inner"></span></div>
      </div>
    `;
    const host = document.querySelector("#host");
    expect(resolveMenuTarget(document.querySelector("#inner"), { boundary: host })).toBeNull();
  });

  it("ignores a marker element that carries no id", () => {
    const host = html(`<div class="react-flow__node"><span id="inner"></span></div>`);
    expect(resolveMenuTarget(host.querySelector("#inner"), { fallback: "canvas" })).toEqual({
      surface: "canvas",
    });
  });
});
