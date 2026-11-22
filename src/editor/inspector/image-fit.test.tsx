// @vitest-environment jsdom
import { StrictMode } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createDomainBus } from "@domain/commands/index.ts";
import { alice, contextFor } from "@domain/commands/test-support.ts";
import { createSequentialIdFactory } from "@domain/graph/ids.ts";
import { createGraphStore } from "@domain/graph/store.ts";
import { effectiveParameterSchema } from "@domain/parameters/resolve.ts";
import type { NodeId } from "@domain/types/ids.ts";
import { allNodeDefinitions } from "@nodes/definitions/index.ts";
import { createNodeRegistry } from "@nodes/registry/registry.ts";
import { installDomStubs } from "@ui/testing/install-dom-stubs.ts";
import { Inspector } from "./inspector.tsx";

beforeAll(installDomStubs);
afterEach(cleanup);

const context = contextFor(alice);
async function mount(type: string, options: { nested?: boolean; variant?: "inspector" | "node" } = {}) {
  const store = createGraphStore({ ids: createSequentialIdFactory("n") });
  const { bus } = createDomainBus({ store, registry: createNodeRegistry(allNodeDefinitions).view() });
  const created = await bus.execute("graph.applyPatch", {
    baseRevision: 0,
    operations: [{ op: "addNode", ref: "$input", type, position: { x: 0, y: 0 } }],
  }, context);
  expect(created.status).toBe("applied");
  const nodeId = created.output.createdIds["$input"] as NodeId;
  const execute = vi.spyOn(bus, "execute");
  const view = render(<StrictMode><Inspector bus={bus} context={context} nodeId={nodeId}
    settings={{ outputResolution: { width: 640, height: 480 }, workingFormat: "rgba8unorm" }}
    {...(options.nested ? { planNodeId: `instance/${nodeId}` as NodeId } : {})}
    {...(options.variant === undefined ? {} : { variant: options.variant })} /></StrictMode>);
  return { bus, nodeId, execute, ...view };
}

function openCommon() {
  const tab = screen.getByRole("tab", { name: "Common" });
  fireEvent.mouseDown(tab, { button: 0 });
  fireEvent.click(tab);
}

describe("media Image fit on Common", () => {
  it.each(["movieFileIn", "webcam", "screenIn"])("%s exposes exactly the manifest choices only on Common", async (type) => {
    const { container, bus, nodeId } = await mount(type);
    expect(screen.queryByRole("combobox", { name: "Image fit" })).toBeNull();
    expect(container.querySelectorAll('[data-parameter-key="imageFit"]')).toHaveLength(0);
    openCommon();
    const common = screen.getByRole("region", { name: "Common" });
    const picker = within(common).getByRole("combobox", { name: "Image fit" }) as HTMLSelectElement;
    expect(picker.value).toBe("fit");
    expect([...picker.options].map((entry) => entry.value)).toEqual(["fit", "fill", "stretch"]);
    expect(container.querySelectorAll('[data-parameter-key="imageFit"]')).toHaveLength(1);
    expect(within(common).getByRole("combobox", { name: "Resolution mode" })).toBeTruthy();
    const definition = bus.registry.get(type);
    const node = bus.store.getGraph().nodes[nodeId];
    if (definition === undefined || node === undefined) throw new Error("Media fixture node is missing");
    expect(effectiveParameterSchema(definition, node.parameters)["imageFit"]?.group).toBe("Common");
    expect(bus.store.getGraph().nodes[nodeId]?.resolution).toBeUndefined();
  });

  it("writes fit changes through the parameter editor using the local nested id, and undo restores fit", async () => {
    const { bus, nodeId, execute } = await mount("movieFileIn", { nested: true });
    openCommon();
    fireEvent.change(screen.getByRole("combobox", { name: "Image fit" }), { target: { value: "fill" } });
    await waitFor(() => expect(bus.store.getGraph().nodes[nodeId]?.parameters["imageFit"]).toBe("fill"));
    expect(execute.mock.calls).toHaveLength(1);
    expect(execute.mock.calls[0]?.[0]).toBe("graph.applyPatch");
    expect(execute.mock.calls[0]?.[1]).toMatchObject({
      operations: [{ op: "setParameters", nodeId, parameters: { imageFit: "fill" } }],
    });
    expect(bus.store.getGraph().nodes[nodeId]?.resolution).toBeUndefined();
    await act(async () => { await bus.execute("graph.undo", {}, context); });
    expect((screen.getByRole("combobox", { name: "Image fit" }) as HTMLSelectElement).value).toBe("fit");
  });

  it("the node strip renders Image fit once inside its Common section", async () => {
    const { container } = await mount("screenIn", { variant: "node" });
    const common = screen.getByRole("region", { name: "Common" });
    expect(within(common).getByRole("combobox", { name: "Image fit" })).toBeTruthy();
    expect(container.querySelectorAll('[data-parameter-key="imageFit"]')).toHaveLength(1);
    // The framing rows filed under Common with it (anchor, zoom) are in the SAME section,
    // not a second "Common" of their own.
    for (const key of ["imageAnchorX", "imageAnchorY", "imageZoom"]) {
      expect(common.querySelectorAll(`[data-parameter-key="${key}"]`), key).toHaveLength(1);
      expect(container.querySelectorAll(`[data-parameter-key="${key}"]`), key).toHaveLength(1);
    }
  });

  it("Text keeps its existing Common controls without Image fit", async () => {
    await mount("text");
    openCommon();
    expect(screen.queryByRole("combobox", { name: "Image fit" })).toBeNull();
    expect(screen.getByRole("combobox", { name: "Resolution mode" })).toBeTruthy();
  });
});
