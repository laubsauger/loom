// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
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
