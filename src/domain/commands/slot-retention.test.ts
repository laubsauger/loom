import { describe, expect, it } from "vitest";
import { createDomainBus } from "./index.ts";
import { createGraphStore } from "../graph/store.ts";
import { createSequentialIdFactory } from "../graph/ids.ts";
import { createNodeRegistry } from "../../nodes/registry/registry.ts";
import { allNodeDefinitions } from "../../nodes/definitions/index.ts";
import type { GraphDocument } from "../types/graph.ts";
import type { InvocationContext } from "../types/commands.ts";
import type { ParameterSlot } from "../types/parameters.ts";

/**
 * §T895/§B166 (§V108) — an inactive binding survives a value edit and any number of mode
 * flips. The owner reported that switching a parameter Constant → Expression came back to a
 * seeded default instead of the reference it had. The loss was NOT the mode switch (which
 * spreads every binding) but the bare-value write that followed it: storing the number in
 * place of the whole slot dropped the expression payload. This drives the real bus and holds
 * §V108's promise that "nothing ever deletes an inactive binding on a mode switch" through a
 * value write and N flips.
 */

const CTX: InvocationContext = { actor: { kind: "system", id: "test", label: "test" }, projectId: "test", capabilities: [] };
const EXPRESSION = "op('lfo1').par.value";

function harness() {
  const slot: ParameterSlot = {
    mode: "expression",
    bindings: {
      static: { kind: "static", value: 0.8 },
      expression: { kind: "expression", source: EXPRESSION },
    },
  };
  const graph = {
    revision: 1,
    nodes: { lv: { id: "lv", type: "level", definitionVersion: 1, position: { x: 0, y: 0 }, parameters: { brightness: slot } } },
    edges: {},
    groups: {},
  } as unknown as GraphDocument;
  const store = createGraphStore({ initialGraph: graph, ids: createSequentialIdFactory("t"), now: () => "1970-01-01T00:00:00.000Z" });
  const { bus } = createDomainBus({ store, registry: createNodeRegistry(allNodeDefinitions).view() });
  const brightness = () => store.view.getGraph().nodes["lv"]?.parameters["brightness"] as ParameterSlot;
  const setMode = (mode: string) => bus.execute("parameter.setMode", { nodeId: "lv", parameterKey: "brightness", mode } as never, CTX);
  const writeValue = (value: number) =>
    bus.execute("graph.applyPatch", { baseRevision: store.view.getRevision(), operations: [{ op: "setParameters", nodeId: "lv", parameters: { brightness: value } }] } as never, CTX);
  return { brightness, setMode, writeValue };
}

describe("a parameter's inactive binding survives edits and mode flips (§T895, §V108)", () => {
  it("a bare value edit in Constant mode keeps the expression reference", async () => {
    const h = harness();
    await h.setMode("static");
    await h.writeValue(0.5); // the slider in Constant mode
    // The static value took the edit; the expression reference is untouched.
    expect(h.brightness().bindings.static).toEqual({ kind: "static", value: 0.5 });
    expect(h.brightness().bindings.expression).toEqual({ kind: "expression", source: EXPRESSION });
  });

  it("the reference is still there after switching back to Expression (the owner's report)", async () => {
    const h = harness();
    await h.setMode("static");
    await h.writeValue(0.5);
    await h.setMode("expression");
    expect(h.brightness().mode).toBe("expression");
    expect(h.brightness().bindings.expression).toEqual({ kind: "expression", source: EXPRESSION });
  });

  it("survives a value edit plus N mode flips, byte-identical in its inactive payload", async () => {
    const h = harness();
    await h.setMode("static");
    await h.writeValue(0.5);
    for (let i = 0; i < 6; i += 1) {
      await h.setMode("expression");
      await h.setMode("static");
    }
    // The expression reference is byte-identical to what it started as, whatever the flips.
    expect(h.brightness().bindings.expression).toEqual({ kind: "expression", source: EXPRESSION });
  });
});
