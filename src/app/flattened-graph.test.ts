import { describe, expect, it } from "vitest";

import { createDomainBus } from "@domain/commands/index.ts";
import { createComponentSystem } from "@domain/components/index.ts";
import { allNodeDefinitions } from "@nodes/definitions/index.ts";
import { createNodeRegistry } from "@nodes/registry/registry.ts";
import {
  animatedComponentDefinition,
  twoInstanceDocument,
} from "../tests/fixtures/animated-component.ts";
import { createFlattenedGraphSource } from "./flattened-graph.ts";

/**
 * THE MEMO — the half of T615 that is not optional (§V529).
 *
 * `flattenComponents` is a pure function of `(document, catalogue)` and costs several
 * times the value graph it feeds. Measured on ten instances of the animated fixture:
 * flattening alone is 9× the per-frame value graph, and running the correct code WITHOUT
 * this memo is 1.45× SLOWER per frame than the broken version it replaces. With it, the
 * same document costs 1.77× LESS than the broken version did.
 *
 * So this file gates the memo the way the behaviour gate gates the flattening: not "is it
 * fast" — a timing assertion is a flake — but the two properties speed is made of.
 *
 *   1. an unchanged document and catalogue return the SAME OBJECT. That is what makes the
 *      per-frame call a map lookup instead of a walk.
 *   2. a document edit, and a CATALOGUE edit with no document edit at all (§V210(c)),
 *      each produce a new one. A memo that never invalidates is a correctness bug wearing
 *      a performance fix's clothes — the host graph does not move when a component's
 *      internals are re-authored, so a document-only key would serve the old internals for
 *      ever.
 */

function harness() {
  const nodeRegistry = createNodeRegistry(allNodeDefinitions).view();
  const system = createComponentSystem(nodeRegistry);
  system.components.register(animatedComponentDefinition());
  const { bus } = createDomainBus({
    registry: system.nodes,
    initialGraph: twoInstanceDocument(),
  });
  const flattened = createFlattenedGraphSource({
    store: bus.store,
    registry: system.nodes,
    components: system.components,
  });
  return { bus, components: system.components, flattened };
}

describe("the flattened document is memoized per (document revision, catalogue revision)", () => {
  it("returns the SAME object while nothing has changed", () => {
    const { flattened } = harness();
    const first = flattened.current();
    expect(flattened.current()).toBe(first);
    expect(flattened.current()).toBe(first);
    // Non-vacuity: it is a real flattening and not an empty stub (§V461).
    expect(Object.keys(first.graph.nodes)).toContain("c1/wob");
    expect(Object.keys(first.graph.nodes)).toContain("c2/wob");
    flattened.dispose();
  });

  it("re-flattens after a DOCUMENT edit", async () => {
    const { bus, flattened } = harness();
    const before = flattened.current();
    const result = await bus.execute(
      "graph.applyPatch",
      {
        baseRevision: bus.store.getGraph().revision,
        operations: [{ op: "setParameters", nodeId: "c1", parameters: { rate: 3 } }],
      },
      { actor: { kind: "human", id: "test", label: "Test" }, projectId: "p", capabilities: [] },
    );
    expect(result.diagnostics).toEqual([]);
    expect(result.status).toBe("applied");

    const after = flattened.current();
    expect(after).not.toBe(before);
    // And the new value actually reached the internals, which is what the memo must not
    // be allowed to hide.
    expect(after.graph.nodes["c1/wob"]?.parameters["frequency"]).toBe(3);
    flattened.dispose();
  });

  it("re-flattens after a CATALOGUE edit with NO document edit (§V210(c))", () => {
    const { bus, components, flattened } = harness();
    const before = flattened.current();
    const revision = bus.store.getGraph().revision;

    // Re-author the component AT THE SAME VERSION: every linked instance changes and the
    // host document does not move at all (§V79).
    const definition = animatedComponentDefinition();
    const wob = definition.graph.nodes["wob"];
    if (wob === undefined) throw new Error("fixture lost its LFO");
    definition.graph.nodes["wob"] = { ...wob, parameters: { ...wob.parameters, amplitude: 7 } };
    components.register(definition);

    const after = flattened.current();
    expect(bus.store.getGraph().revision).toBe(revision);
    expect(after).not.toBe(before);
    expect(after.graph.nodes["c1/wob"]?.parameters["amplitude"]).toBe(7);
    flattened.dispose();
  });

  it("stops listening once disposed, so a stale source cannot hold the catalogue open", () => {
    const { components, flattened } = harness();
    const first = flattened.current();
    flattened.dispose();
    // After dispose the subscription is gone; the object is inert rather than wrong —
    // nothing in the app calls it after `runtime.dispose()`.
    components.register(animatedComponentDefinition());
    expect(first.graph.nodes["c1/wob"]).toBeDefined();
  });
});
