// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { NodeId } from "@domain/types/ids.ts";
import { readComponentInstance } from "@domain/components/instance.ts";
import { installDomStubs } from "@ui/testing/install-dom-stubs.ts";
import { createAppRuntime } from "./app-runtime.ts";
import type { AppRuntime } from "./app-runtime.ts";
import { ComponentBar } from "./component-bar.tsx";
import { useComponentEditing } from "./use-component-editing.ts";
import type { ComponentEditing } from "./use-component-editing.ts";

beforeAll(installDomStubs);
afterEach(cleanup);

/**
 * DIVING IN IS EDITING SOMEWHERE ELSE (T423, T130, §V79, §V82).
 *
 * The claim the whole feature rests on, and the one thing "the command exists" cannot
 * say: a node edited INSIDE a component changes that component's DEFINITION — every
 * linked instance of it, everywhere — and does not touch the document the user came from.
 * Get it backwards in either direction and the failure is silent: edits that vanish when
 * you jump up, or a "component" that is really three copies drifting apart.
 *
 * §V321/B41: every assertion below runs against TWO instances of the same component on
 * one canvas, because a definition edit that only reached the instance you were standing
 * in would pass every single-instance test there is.
 *
 * SENSITIVITY. `useComponentEditing` returning `runtime.bus` instead of the session bus
 * reddens "changes the component, not the parent graph" (the edit lands in the document);
 * keying the session effect on the definition OBJECT rather than on id+version reddens
 * "keeps editing the same session across an edit"; dropping the truncation effect reddens
 * "follows a deleted instance back to somewhere real".
 */

interface Handle {
  editing: ComponentEditing;
}

function Harness({ runtime, handle }: { runtime: AppRuntime; handle: Handle }) {
  const editing = useComponentEditing(runtime);
  handle.editing = editing;
  return (
    <ComponentBar
      bus={runtime.bus}
      context={runtime.invocation}
      breadcrumbs={editing.breadcrumbs}
      insideComponent={editing.insideComponent}
      onNavigate={editing.navigate}
      onExit={editing.exit}
    />
  );
}

async function mount(): Promise<{ runtime: AppRuntime; handle: Handle }> {
  const runtime = createAppRuntime({ identityStorage: null });
  const handle = { editing: null as unknown as ComponentEditing };
  await act(async () => {
    render(<Harness runtime={runtime} handle={handle} />);
  });
  return { runtime, handle };
}

/** Two linked instances of the shipped Bloom, on one canvas (§V321). */
async function twoInstances(runtime: AppRuntime): Promise<[NodeId, NodeId]> {
  const placed: NodeId[] = [];
  for (const x of [0, 400]) {
    const result = await runtime.bus.execute(
      "component.instantiate",
      { componentId: "bloom", position: { x, y: 0 } },
      runtime.invocation,
    );
    expect(result.output.ok, result.diagnostics.map((d) => d.message).join("; ")).toBe(true);
    placed.push(result.output.nodeId as NodeId);
  }
  return [placed[0] as NodeId, placed[1] as NodeId];
}

describe("dive in / jump up", () => {
  it("refuses a node that is not a component instance, by name (§V288)", async () => {
    const { runtime, handle } = await mount();
    const added = await runtime.bus.execute(
      "graph.applyPatch",
      {
        baseRevision: runtime.bus.store.getRevision(),
        label: "add",
        operations: [{ op: "addNode", ref: "$n", type: "noise", position: { x: 0, y: 0 } }],
      },
      runtime.invocation,
    );
    const nodeId = added.output.createdIds["$n"] as NodeId;

    const result = await runtime.bus.execute(
      "graph.diveIn",
      { nodeIds: [nodeId] },
      runtime.invocation,
    );
    expect(result.status).toBe("rejected");
    expect(result.diagnostics.map((d) => d.code)).toContain("component.navigation.notAComponent");
    expect(handle.editing.insideComponent).toBe(false);
  });

  it("refuses an empty selection rather than doing nothing", async () => {
    const { runtime } = await mount();
    const result = await runtime.bus.execute("graph.diveIn", { nodeIds: [] }, runtime.invocation);
    expect(result.status).toBe("rejected");
    expect(result.diagnostics.map((d) => d.code)).toContain("component.navigation.noSelection");
  });

  it("says it is already at the top rather than silently staying there", async () => {
    const { runtime } = await mount();
    const result = await runtime.bus.execute("graph.jumpUp", {}, runtime.invocation);
    expect(result.status).toBe("rejected");
    expect(result.diagnostics.map((d) => d.code)).toContain("component.navigation.atRoot");
  });

  it("enters, shows the trail, and comes back out", async () => {
    const { runtime, handle } = await mount();
    const [first] = await twoInstances(runtime);

    await act(async () => {
      await runtime.bus.execute("graph.diveIn", { nodeId: first }, runtime.invocation);
    });
    expect(handle.editing.path).toEqual([first]);
    expect(handle.editing.definition?.componentId).toBe("bloom");
    // The trail is the affordance that makes nested editing survivable — and it names the
    // levels with the SAME labels a diagnostic path uses (§V82).
    expect(handle.editing.breadcrumbs.map((crumb) => crumb.label)).toEqual(["Main", "Bloom_1"]);
    expect(screen.getByRole("navigation", { name: "Component path" })).toBeTruthy();

    await act(async () => {
      await runtime.bus.execute("graph.jumpUp", {}, runtime.invocation);
    });
    expect(handle.editing.path).toEqual([]);
    expect(handle.editing.insideComponent).toBe(false);
  });

  it("shows the component's INTERNAL graph, not the document", async () => {
    const { runtime, handle } = await mount();
    const [first] = await twoInstances(runtime);
    const documentNodeIds = Object.keys(runtime.bus.store.getGraph().nodes).sort();

    await act(async () => {
      await runtime.bus.execute("graph.diveIn", { nodeId: first }, runtime.invocation);
    });

    const insideNodeIds = Object.keys(handle.editing.graph.nodes).sort();
    expect(insideNodeIds).not.toEqual(documentNodeIds);
    expect(insideNodeIds).toEqual(
      Object.keys(runtime.components.get("bloom", 1)?.graph.nodes ?? {}).sort(),
    );
  });
});

describe("an edit inside a component changes the COMPONENT, not the parent graph (§V79)", () => {
  it("writes the definition every linked instance shares, and leaves the document alone", async () => {
    const { runtime, handle } = await mount();
    const [first, second] = await twoInstances(runtime);

    const documentBefore = runtime.bus.store.getGraph();
    const definitionBefore = runtime.components.get("bloom", 1);
    const internalId = Object.keys(definitionBefore?.graph.nodes ?? {}).sort()[0] as NodeId;

    await act(async () => {
      await runtime.bus.execute("graph.diveIn", { nodeId: first }, runtime.invocation);
    });

    // An ordinary edit, through the ordinary command, on the bus the canvas is holding —
    // there is no component-specific write path (§V29).
    await act(async () => {
      await handle.editing.bus.execute(
        "node.rename",
        { nodeId: internalId, label: "renamed_inside" },
        runtime.invocation,
      );
    });

    const definitionAfter = runtime.components.get("bloom", 1);
    expect(definitionAfter?.graph.nodes[internalId]?.label).toBe("renamed_inside");
    // Not the parent. Same node ids, same revision: the document did not move at all.
    expect(Object.keys(runtime.bus.store.getGraph().nodes).sort()).toEqual(
      Object.keys(documentBefore.nodes).sort(),
    );
    expect(runtime.bus.store.getRevision()).toBe(documentBefore.revision);

    // §V321/B41: the SECOND instance sees it too, because there is one definition and not
    // two copies. Diving into it shows the edited graph without any further edit.
    await act(async () => {
      await runtime.bus.execute("graph.jumpUp", {}, runtime.invocation);
      await runtime.bus.execute("graph.diveIn", { nodeId: second }, runtime.invocation);
    });
    expect(handle.editing.graph.nodes[internalId]?.label).toBe("renamed_inside");
    // And both really are instances of the same component at the same pinned version.
    const graph = runtime.bus.store.getGraph();
    for (const nodeId of [first, second]) {
      const state = readComponentInstance(graph.nodes[nodeId] as never);
      expect(state?.componentId).toBe("bloom");
      expect(state?.version).toBe(1);
    }
  });

  it("follows a deleted instance back to somewhere real instead of showing a stale graph", async () => {
    const { runtime, handle } = await mount();
    const [first] = await twoInstances(runtime);

    await act(async () => {
      await runtime.bus.execute("graph.diveIn", { nodeId: first }, runtime.invocation);
    });
    expect(handle.editing.insideComponent).toBe(true);

    await act(async () => {
      await runtime.bus.execute("graph.removeNodes", { nodeIds: [first] }, runtime.invocation);
    });
    expect(handle.editing.path).toEqual([]);
    expect(handle.editing.insideComponent).toBe(false);
  });
});

describe("recursion is refused by the catalogue, so navigation cannot regress (§V83)", () => {
  it("will not register a component that contains itself, and names the cycle", async () => {
    const { runtime } = await mount();
    const bloom = runtime.components.get("bloom", 1);
    if (bloom === undefined) throw new Error("the shipped Bloom did not install");

    // Direct: Bloom containing a Bloom. This is what an infinite dive would need to exist.
    expect(() =>
      runtime.components.register({
        ...bloom,
        graph: {
          ...bloom.graph,
          nodes: {
            ...bloom.graph.nodes,
            self: {
              id: "self",
              type: "component:bloom@1",
              definitionVersion: 1,
              position: { x: 0, y: 0 },
              parameters: {},
            },
          },
        },
      }),
    ).toThrowError(/recursion/i);

    // Indirect, the case that actually happens: a wrapper around Bloom, then Bloom around
    // the wrapper. Nobody builds the one-hop version by accident.
    runtime.components.register({
      componentId: "wrapper",
      version: 1,
      name: "Wrapper",
      graph: {
        revision: 0,
        nodes: {
          inner: {
            id: "inner",
            type: "component:bloom@1",
            definitionVersion: 1,
            position: { x: 0, y: 0 },
            parameters: {},
          },
        },
        edges: {},
        groups: {},
      },
      inputs: [],
      outputs: [],
      parameters: [],
    });

    expect(() =>
      runtime.components.register({
        ...bloom,
        graph: {
          ...bloom.graph,
          nodes: {
            ...bloom.graph.nodes,
            viaWrapper: {
              id: "viaWrapper",
              type: "component:wrapper@1",
              definitionVersion: 1,
              position: { x: 0, y: 0 },
              parameters: {},
            },
          },
        },
      }),
    ).toThrowError(/recursion/i);
  });
});

describe("save selection as a component, from the canvas (§V307)", () => {
  it("opens a NAMING surface rather than dispatching a nameless save (B60's shape)", async () => {
    const { runtime } = await mount();
    const added = await runtime.bus.execute(
      "graph.applyPatch",
      {
        baseRevision: runtime.bus.store.getRevision(),
        label: "add",
        operations: [
          { op: "addNode", ref: "$a", type: "noise", position: { x: 0, y: 0 } },
          { op: "addNode", ref: "$b", type: "blur", position: { x: 200, y: 0 } },
        ],
      },
      runtime.invocation,
    );
    const nodeIds = [added.output.createdIds["$a"], added.output.createdIds["$b"]] as NodeId[];

    await act(async () => {
      const result = await runtime.bus.execute(
        "ui.createComponent",
        { nodeIds },
        runtime.invocation,
      );
      expect(result.output.open).toBe(true);
    });

    const field = screen.getByPlaceholderText("Component name");
    await act(async () => {
      fireEvent.change(field, { target: { value: "MyThing" } });
      fireEvent.click(screen.getByRole("button", { name: "Create" }));
    });

    const saved = runtime.components
      .list()
      .find((definition) => definition.name === "MyThing");
    expect(saved).toBeDefined();
    // The two nodes left the document and one instance took their place — the whole point
    // of the gesture, and the half that silently deletes wiring when it is wrong.
    const graph = runtime.bus.store.getGraph();
    for (const nodeId of nodeIds) expect(graph.nodes[nodeId]).toBeUndefined();
    expect(
      Object.values(graph.nodes).filter((node) => readComponentInstance(node) !== null),
    ).toHaveLength(1);
  });

  it("can be entered and edited immediately after it is created (the ejection bug)", async () => {
    const { runtime, handle } = await mount();
    const added = await runtime.bus.execute(
      "graph.applyPatch",
      {
        baseRevision: runtime.bus.store.getRevision(),
        label: "add",
        operations: [
          { op: "addNode", ref: "$a", type: "noise", position: { x: 0, y: 0 } },
          { op: "addNode", ref: "$b", type: "blur", position: { x: 200, y: 0 } },
        ],
      },
      runtime.invocation,
    );
    const inner = added.output.createdIds["$b"] as NodeId;

    let instance: NodeId | null = null;
    await act(async () => {
      const saved = await runtime.bus.execute(
        "component.saveSelection",
        { nodeIds: [inner], name: "FreshlyMade" },
        runtime.invocation,
      );
      expect(saved.output.ok, saved.diagnostics.map((d) => `${d.code}: ${d.message}`).join("; ")).toBe(true);
      instance = saved.output.instanceNodeId;
    });
    expect(instance).not.toBeNull();

    /*
     * Observed live before the recovery effect re-resolved from the live stores: this
     * sequence — save a component, walk into it, touch something inside — put the user
     * back at the root, because the path-truncation recovery ran on a render whose graph
     * snapshot and navigation path came from stores that had not converged yet.
     *
     * The fixture has to do it in this ORDER and with a component created in THIS session
     * (§V461): entering a component that was already installed at boot never reproduced it.
     *
     * WHAT THIS TEST CANNOT DO, said out loud (§V472): jsdom converges the three stores
     * deterministically, so it never showed the ejection and it does not PROVE the fix.
     * It pins the property — the path survives a save-then-enter-then-edit — so a future
     * change that reintroduces an unconditional truncation is caught; the bug itself was
     * found and confirmed fixed in the running app, which is the only place the race
     * exists.
     */
    await act(async () => {
      await runtime.bus.execute("graph.diveIn", { nodeId: instance as NodeId }, runtime.invocation);
    });
    expect(handle.editing.path).toEqual([instance]);

    const internalId = Object.keys(handle.editing.graph.nodes)[0] as NodeId;
    await act(async () => {
      await handle.editing.bus.execute(
        "node.rename",
        { nodeId: internalId, label: "touched" },
        runtime.invocation,
      );
    });

    expect(handle.editing.path).toEqual([instance]);
    expect(handle.editing.definition?.name).toBe("FreshlyMade");
    expect(handle.editing.graph.nodes[internalId]?.label).toBe("touched");
  });

  it("refuses an empty selection instead of opening a prompt that cannot succeed", async () => {
    const { runtime } = await mount();
    const result = await runtime.bus.execute("ui.createComponent", {}, runtime.invocation);
    expect(result.status).toBe("rejected");
    expect(result.diagnostics.map((d) => d.code)).toContain("component.create.noSelection");
    expect(screen.queryByPlaceholderText("Component name")).toBeNull();
  });
});
