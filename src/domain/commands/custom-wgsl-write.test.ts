import { describe, expect, it } from "vitest";
import { createDomainBus } from "./index.ts";
import { createGraphStore } from "../graph/store.ts";
import { createSequentialIdFactory } from "../graph/ids.ts";
import { createNodeRegistry } from "../../nodes/registry/registry.ts";
import { allNodeDefinitions } from "../../nodes/definitions/index.ts";
import { SHARED_UNIFORMS_WGSL } from "../../runtime/backend/shared-uniforms.ts";
import type { GraphDocument } from "../types/graph.ts";
import type { InvocationContext } from "../types/commands.ts";

/**
 * T880 — a reflected control is an EDITABLE control. The owner reported that the parameters a
 * customWgsl reflects from its shader (`orbitSpeed`, `lightColor`) could not be dragged or
 * typed — every edit reset. The read paths saw them, but the WRITE path validated against the
 * static schema ({source, amount}), so a reflected key was "unknown" and the patch was
 * refused. This drives the real bus and asserts the write lands and sticks.
 */

const SOURCE = `${SHARED_UNIFORMS_WGSL}
struct Params { orbitSpeed: f32, lightColor: vec4f, };
@group(0) @binding(3) var<uniform> params: Params;
@fragment fn fs(@location(0) uv: vec2f) -> @location(0) vec4f { return params.lightColor * params.orbitSpeed; }`;

const CTX: InvocationContext = { actor: { kind: "system", id: "test", label: "test" }, projectId: "test", capabilities: [] };

function harness() {
  const initialGraph = {
    revision: 1,
    nodes: {
      fx: { id: "fx", type: "customWgsl", definitionVersion: 1, position: { x: 0, y: 0 }, parameters: { source: SOURCE, orbitSpeed: 1, lightColor: [1, 1, 1, 1] } },
    },
    edges: {},
    groups: {},
  } as unknown as GraphDocument;
  const store = createGraphStore({ initialGraph, ids: createSequentialIdFactory("t"), now: () => "1970-01-01T00:00:00.000Z" });
  const { bus } = createDomainBus({ store, registry: createNodeRegistry(allNodeDefinitions).view() });
  return { store, bus };
}

describe("customWgsl reflected controls are editable (T880)", () => {
  it("a value written to a reflected number applies and persists", async () => {
    const { store, bus } = harness();
    const result = await bus.execute(
      "graph.applyPatch",
      { baseRevision: store.view.getRevision(), operations: [{ op: "setParameters", nodeId: "fx", parameters: { orbitSpeed: 2.5 } }] } as never,
      CTX,
    );
    expect(result.status).toBe("applied");
    expect(result.diagnostics ?? []).toEqual([]);
    expect(store.view.getGraph().nodes["fx"]?.parameters["orbitSpeed"]).toBe(2.5);
  });

  it("a colour written to a reflected vec4f applies and persists", async () => {
    const { store, bus } = harness();
    const result = await bus.execute(
      "graph.applyPatch",
      { baseRevision: store.view.getRevision(), operations: [{ op: "setParameters", nodeId: "fx", parameters: { lightColor: [0.2, 0.4, 0.6, 1] } }] } as never,
      CTX,
    );
    expect(result.status).toBe("applied");
    expect(store.view.getGraph().nodes["fx"]?.parameters["lightColor"]).toEqual([0.2, 0.4, 0.6, 1]);
  });

  it("a field the shader does NOT declare is still refused (the guard still guards)", async () => {
    const { store, bus } = harness();
    const result = await bus.execute(
      "graph.applyPatch",
      { baseRevision: store.view.getRevision(), operations: [{ op: "setParameters", nodeId: "fx", parameters: { notAField: 3 } }] } as never,
      CTX,
    );
    // The effective schema is the shader's, so a key it never declared is unknown — the
    // reflection widened what is valid, it did not turn off validation.
    expect(result.status).not.toBe("applied");
  });
});
