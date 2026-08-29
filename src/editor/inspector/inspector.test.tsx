// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { createDomainBus } from "@domain/commands/index.ts";
import { alice, contextFor } from "@domain/commands/test-support.ts";
import { createGraphStore } from "@domain/graph/store.ts";
import { createSequentialIdFactory } from "@domain/graph/ids.ts";
import type { RuntimeDiagnostic } from "@domain/types/diagnostics.ts";
import type { NodeId } from "@domain/types/ids.ts";
import type { NodeDefinition } from "@domain/types/node-definition.ts";
import { createNodeRegistry } from "@nodes/registry/registry.ts";
import { installDomStubs } from "@ui/testing/install-dom-stubs.ts";
import { Inspector } from "./inspector.tsx";
import type { InspectorProjectSettings } from "./inspector.tsx";

beforeAll(installDomStubs);
afterEach(cleanup);

/**
 * T38 — the inspector is driven entirely by the node manifest, and T73 — the Common
 * section shows the resolved size and format rather than the mode that produced them.
 */

const rgba = { kind: "texture2d", sample: "float", channels: 4 } as const;

/** One node that declares every `ParameterDefinition` variant, in two groups. */
const everythingNode: NodeDefinition = {
  type: "test.everything",
  version: 1,
  title: "Everything",
  category: "test",
  inputs: [{ id: "source", label: "Source", type: rgba }],
  outputs: [{ id: "out", label: "Out", type: rgba }],
  resolutionPolicy: { kind: "inherit", input: "source" },
  formatPolicy: { kind: "project" },
  parameters: {
    radius: { type: "number", label: "Radius", default: 4, min: 0, max: 64, unit: "px", group: "Shape" },
    enabled: { type: "boolean", label: "Enabled", default: true, group: "Shape" },
    mode: {
      type: "enum",
      label: "Mode",
      default: "over",
      options: [
        { value: "over", label: "Over" },
        { value: "add", label: "Add" },
      ],
      group: "Shape",
    },
    tint: { type: "color", label: "Tint", default: [1, 1, 1, 1], space: "display", group: "Colour" },
    offset: { type: "vector", label: "Offset", size: 2, default: [0, 0], group: "Colour" },
    note: { type: "string", label: "Note", default: "" },
    image: { type: "asset", label: "Image", kind: "image" },
    falloff: { type: "curve", label: "Falloff", default: [{ x: 0, y: 0 }, { x: 1, y: 1 }] },
  },
  compile: () => ({ passes: [] }),
};

const settings: InspectorProjectSettings = {
  outputResolution: { width: 1920, height: 1080 },
  workingFormat: "rgba8unorm",
  limits: { maxResolution: 4096 },
};

// Module-level so the identity is stable across renders: the pane keys its editor to it.
const context = contextFor(alice);

async function setup(options: { diagnostics?: readonly RuntimeDiagnostic[] } = {}) {
  const store = createGraphStore({ ids: createSequentialIdFactory("i") });
  const { bus } = createDomainBus({
    store,
    registry: createNodeRegistry([everythingNode]).view(),
  });
  const created = await bus.execute(
    "graph.applyPatch",
    {
      baseRevision: 0,
      operations: [
        { op: "addNode", ref: "$n", type: everythingNode.type, position: { x: 0, y: 0 } },
      ],
    },
    context,
  );
  const nodeId = created.output.createdIds["$n"] as NodeId;

  render(
    <Inspector
      bus={bus}
      context={context}
      nodeId={nodeId}
      settings={settings}
      capabilities={{ formats: ["rgba8unorm", "rgba16float"] }}
      inputResolutions={[
        { portId: "source", label: "Source", size: { width: 800, height: 600 }, format: "rgba8unorm" },
      ]}
      {...(options.diagnostics === undefined ? {} : { diagnostics: options.diagnostics })}
    />,
  );

  const node = () => bus.store.getGraph().nodes[nodeId];
  return { bus, nodeId, node };
}

/**
 * T269: Common is a PAGE now, so a Common assertion opens it first, as a user does.
 * Radix activates a tab on mousedown, which `fireEvent.click` does not synthesise.
 */
function openCommon(): void {
  const tab = screen.getByRole("tab", { name: "Common" });
  fireEvent.mouseDown(tab, { button: 0 });
  fireEvent.click(tab);
}

describe("T38 — manifest-driven inspector", () => {
  it("renders a control for every ParameterDefinition variant the node declares", async () => {
    await setup();
    expect(screen.getByRole("spinbutton", { name: "Radius" })).toBeDefined();
    expect(screen.getByRole("switch", { name: "Enabled" })).toBeDefined();
    expect(screen.getByLabelText("Mode")).toBeDefined();
    expect(screen.getByLabelText("Tint hex")).toBeDefined();
    expect(screen.getByRole("spinbutton", { name: "Offset x" })).toBeDefined();
    expect(screen.getByLabelText("Note")).toBeDefined();
    expect(screen.getByLabelText("Image")).toBeDefined();
    expect(screen.getByLabelText(/Falloff curve/)).toBeDefined();
  });

  it("groups parameters as the manifest groups them", async () => {
    await setup();
    const shape = screen.getByRole("region", { name: "Shape" });
    expect(within(shape).getByRole("spinbutton", { name: "Radius" })).toBeDefined();
    const colour = screen.getByRole("region", { name: "Colour" });
    expect(within(colour).getByLabelText("Tint hex")).toBeDefined();
    // Ungrouped parameters land in the default group, not in someone else's.
    expect(within(screen.getByRole("region", { name: "Parameters" })).getByLabelText("Note")).toBeDefined();
  });

  it("names the node and shows its type and id", async () => {
    const harness = await setup();
    expect(screen.getByText("Everything")).toBeDefined();
    expect(screen.getByText("test.everything")).toBeDefined();
    expect(screen.getByText(harness.nodeId)).toBeDefined();
  });

  it("writes an edit through the bus, not into the node object (§V29)", async () => {
    const harness = await setup();
    fireEvent.keyDown(screen.getByRole("spinbutton", { name: "Radius" }), { key: "End" });
    await waitFor(() => expect(harness.node()?.parameters["radius"]).toBe(64));
    expect(harness.bus.store.getAudit().at(-1)?.command).toBe("graph.applyPatch");
  });

  it("shows an empty state rather than crashing when nothing is selected", () => {
    const store = createGraphStore({ ids: createSequentialIdFactory("e") });
    const { bus } = createDomainBus({ store, registry: createNodeRegistry([everythingNode]).view() });
    render(<Inspector bus={bus} context={context} nodeId={null} settings={settings} />);
    expect(screen.getByText("No node selected")).toBeDefined();
  });
});

describe("T73 — the Common section shows what the node will actually produce", () => {
  it("reads out the resolved size from the definition's policy when untouched", async () => {
    await setup();
    const readout = screen.getByLabelText("Resolved output");
    // The policy inherits from the connected input, which is 800×600 — not the project.
    expect(within(readout).getByText("800 × 600")).toBeDefined();
    expect(within(readout).getByText("rgba8unorm")).toBeDefined();
  });

  it("halves the readout when the user picks 1/2, and stores the override", async () => {
    const harness = await setup();
    openCommon();
    fireEvent.change(screen.getByLabelText("Resolution mode"), { target: { value: "scale:1/2" } });

    await waitFor(() =>
      expect(harness.node()?.resolution).toEqual({ mode: "scale", factor: 0.5, input: "source" }),
    );
    await waitFor(() =>
      expect(within(screen.getByLabelText("Resolved output")).getByText("400 × 300")).toBeDefined(),
    );
  });

  it("clears the override with null when the user goes back to Auto (§V50)", async () => {
    const harness = await setup();
    openCommon();
    fireEvent.change(screen.getByLabelText("Resolution mode"), { target: { value: "project" } });
    await waitFor(() => expect(harness.node()?.resolution).toEqual({ mode: "project" }));

    fireEvent.change(screen.getByLabelText("Resolution mode"), { target: { value: "auto" } });
    // Absent, not {mode:"auto"} — the node follows its definition's policy again.
    await waitFor(() => expect(harness.node()?.resolution).toBeUndefined());
  });

  it("offers custom width and height once Custom is chosen, seeded with the current size", async () => {
    const harness = await setup();
    openCommon();
    fireEvent.change(screen.getByLabelText("Resolution mode"), { target: { value: "custom" } });

    await waitFor(() =>
      expect(harness.node()?.resolution).toEqual({ mode: "fixed", width: 800, height: 600 }),
    );
    const width = await screen.findByRole("spinbutton", { name: "Width" });
    expect(width.getAttribute("aria-valuenow")).toBe("800");

    fireEvent.keyDown(width, { key: "PageUp" });
    fireEvent.keyUp(width, { key: "PageUp" });
    await waitFor(() =>
      expect(harness.node()?.resolution).toEqual({ mode: "fixed", width: 810, height: 600 }),
    );
  });

  it("stores a format override and clears it again", async () => {
    const harness = await setup();
    openCommon();
    fireEvent.change(screen.getByLabelText("Pixel format"), { target: { value: "rgba16float" } });
    await waitFor(() =>
      expect(harness.node()?.format).toEqual({ mode: "fixed", format: "rgba16float" }),
    );

    fireEvent.change(screen.getByLabelText("Pixel format"), { target: { value: "auto" } });
    await waitFor(() => expect(harness.node()?.format).toBeUndefined());
  });

  it("warns when the chosen format is outside the device capability report (§V12)", async () => {
    const harness = await setup();
    openCommon();
    fireEvent.change(screen.getByLabelText("Pixel format"), { target: { value: "r32float" } });
    await waitFor(() => expect(harness.node()?.format).toBeDefined());

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("r32float");
    expect(within(screen.getByLabelText("Resolved output")).getByText("unsupported")).toBeDefined();
  });

  it("surfaces the compiler's own diagnostic and the fallback it chose (§V51)", async () => {
    const store = createGraphStore({ ids: createSequentialIdFactory("d") });
    const { bus } = createDomainBus({ store, registry: createNodeRegistry([everythingNode]).view() });
    const created = await bus.execute(
      "graph.applyPatch",
      {
        baseRevision: 0,
        operations: [{ op: "addNode", ref: "$n", type: everythingNode.type, position: { x: 0, y: 0 } }],
      },
      context,
    );
    const nodeId = created.output.createdIds["$n"] as NodeId;

    render(
      <Inspector
        bus={bus}
        context={context}
        nodeId={nodeId}
        settings={settings}
        diagnostics={[
          {
            severity: "warning",
            code: "node.format.unsupported",
            message: "r32float is unsupported on this device; falling back to rgba16float.",
            nodeId,
            suggestion: "Choose rgba16float to make the fallback explicit.",
          },
        ]}
      />,
    );

    openCommon();
    const alert = await screen.findByRole("alert");
    // The message is the compiler's, verbatim: the UI does not recompute the fallback.
    expect(alert.textContent).toContain("falling back to rgba16float");
    expect(alert.textContent).toContain("Choose rgba16float");
  });
});

describe("T269 — parameters first, Common on its own page (§V174)", () => {
  it("opens on Parameters, with the node's own controls and not the Common ones", async () => {
    await setup();
    expect(screen.getByRole("tab", { name: "Parameters" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("tab", { name: "Common" }).getAttribute("aria-selected")).toBe("false");
    // The work is what the panel opens on; the chrome is one click away.
    expect(screen.getByRole("spinbutton", { name: "Radius" })).toBeDefined();
    expect(screen.queryByLabelText("Resolution mode")).toBeNull();
  });

  it("puts the parameter groups ABOVE the tab content boundary, not below a Common block", async () => {
    await setup();
    const parameters = screen.getByRole("tabpanel");
    // One panel is rendered at a time, and it is the parameters one.
    expect(within(parameters).getByRole("region", { name: "Shape" })).toBeDefined();
    expect(within(parameters).queryByRole("region", { name: "Common" })).toBeNull();
  });

  it("moves the resolution and format controls onto the Common page", async () => {
    await setup();
    openCommon();
    expect(screen.getByLabelText("Resolution mode")).toBeDefined();
    expect(screen.getByLabelText("Pixel format")).toBeDefined();
    // And the parameters are the ones now out of view.
    expect(screen.queryByRole("spinbutton", { name: "Radius" })).toBeNull();
  });

  it("keeps the resolved readout visible from BOTH pages", async () => {
    await setup();
    const onParameters = screen.getByLabelText("Resolved output");
    expect(within(onParameters).getByText("800 × 600")).toBeDefined();
    expect(within(onParameters).getByText("rgba8unorm")).toBeDefined();

    openCommon();
    // Same single readout, still in the header: it is the fact you check constantly, and
    // it moves as a consequence of edits made elsewhere (§V174 decision).
    const onCommon = screen.getByLabelText("Resolved output");
    expect(within(onCommon).getByText("800 × 600")).toBeDefined();
  });

  it("carries the size and format SOURCE on hover rather than printing it (§V90)", async () => {
    await setup();
    const readout = screen.getByLabelText("Resolved output");
    expect(readout.getAttribute("title")).toContain("node default");
    expect(readout.getAttribute("title")).toContain("project");
    // The source words are not taking a row of their own any more.
    expect(readout.textContent).not.toContain("node default");
  });

  it("names the state when a node declares no parameters (§V91)", async () => {
    const bare: NodeDefinition = {
      ...everythingNode,
      type: "test.bare",
      title: "Bare",
      parameters: {},
    };
    const store = createGraphStore({ ids: createSequentialIdFactory("b") });
    const { bus } = createDomainBus({ store, registry: createNodeRegistry([bare]).view() });
    const created = await bus.execute(
      "graph.applyPatch",
      {
        baseRevision: 0,
        operations: [{ op: "addNode", ref: "$n", type: bare.type, position: { x: 0, y: 0 } }],
      },
      context,
    );
    render(
      <Inspector
        bus={bus}
        context={context}
        nodeId={created.output.createdIds["$n"] as NodeId}
        settings={settings}
      />,
    );
    expect(screen.getByText("No parameters")).toBeDefined();
  });
});
