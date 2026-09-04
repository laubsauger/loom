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
import { compileGraph } from "@compiler/index.ts";
import type { BackendCapabilities } from "@domain/types/backend.ts";
import type { PlannedOutput } from "./resolution.ts";
import type { ProjectSettings } from "@domain/types/graph.ts";
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
    kernel: { type: "code", language: "wgsl", label: "Kernel", default: "fn f() {}" },
    image: { type: "asset", label: "Image", kind: "image" },
    falloff: { type: "curve", label: "Falloff", default: [{ x: 0, y: 0 }, { x: 1, y: 1 }] },
  },
  compile: () => ({ passes: [] }),
};

/** A generator, so `everythingNode`'s required input is satisfied. */
const sourceNode: NodeDefinition = {
  type: "test.source",
  version: 1,
  title: "Source",
  category: "test",
  inputs: [],
  outputs: [{ id: "out", label: "Out", type: rgba }],
  parameters: {},
  compile: () => ({ passes: [] }),
};

/** A declared sink, so the graph above has somewhere to end and nothing is pruned. */
const sinkNode: NodeDefinition = {
  type: "test.sink",
  version: 1,
  title: "Sink",
  category: "test",
  sink: true,
  inputs: [{ id: "input", label: "Input", type: rgba }],
  outputs: [],
  parameters: {},
  compile: () => ({ passes: [] }),
};

const settings: InspectorProjectSettings = {
  outputResolution: { width: 1920, height: 1080 },
  workingFormat: "rgba8unorm",
  limits: { maxResolution: 4096 },
};

// Module-level so the identity is stable across renders: the pane keys its editor to it.
const context = contextFor(alice);

/**
 * T1064 — every render below hands the panel a PLAN ROW, because that is now the only
 * place a resolved size or format comes from. The default row is what the compiler
 * resolves for this fixture: the definition's policy inherits from `source`, which is
 * 800×600 rgba8unorm. Tests that used to watch the panel re-derive that number now watch
 * it REPORT one, which is the whole change.
 */
const PLANNED_800x600 = { size: [800, 600] as readonly [number, number], format: "rgba8unorm" as const };

async function setup(
  options: { diagnostics?: readonly RuntimeDiagnostic[]; planned?: PlannedOutput | null } = {},
) {
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
      planned={options.planned === undefined ? PLANNED_800x600 : options.planned}
      {...(options.diagnostics === undefined ? {} : { diagnostics: options.diagnostics })}
    />,
  );

  const node = () => bus.store.getGraph().nodes[nodeId];
  /** Re-render with a DIFFERENT plan row — what a recompile does in the live app. */
  const recompiledTo = (planned: PlannedOutput): void => {
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
        planned={planned}
      />,
    );
  };
  return { bus, nodeId, node, recompiledTo };
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

  // T954 REPLACED THIS TEST'S CLAIM, deliberately: it used to assert the type's display
  // name, the machine type AND the id all at once, which is precisely the header the
  // owner reported — the type in both prominent slots and the identity last. The header
  // now names the node and badges the type; the full gate is the T954 block below.
  it("names the node, and addresses it by its machine type", async () => {
    const harness = await setup();
    expect(screen.getByText(harness.node()?.label as string)).toBeDefined();
    expect(screen.getByText("test.everything")).toBeDefined();
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

/**
 * T492 — a code-KIND parameter renders the REAL editor, by derivation.
 *
 * The chain under test is the whole point: manifest declares `type: "code"` → the
 * control kit's exhaustive switch offers the injected editor → the inspector injects
 * CodeField (the one CodeMirror, T356). Nothing here names "kernel" outside the
 * fixture; a ninth code parameter anywhere gets this control the day it is declared,
 * which is the gate the owner's "any other parameter that is this kind of stuff" asks
 * for (§V437).
 */
/**
 * T498 — the tab already says Parameters; the default group draws no second heading.
 * The same word twice, stacked, was the owner's unnameable oddity. Named groups keep
 * their headings, because those carry information the tab does not.
 */
describe("T498 — no doubled Parameters heading", () => {
  it("draws headings for named groups only", async () => {
    await setup();
    const headings = [...document.querySelectorAll('[class*="sectionHeader"]')].map(
      (node) => node.textContent?.trim(),
    );
    expect(headings).toContain("Shape");
    expect(headings).toContain("Colour");
    expect(headings).not.toContain("Parameters");
    // The ungrouped section still exists and is addressable — only its ink is gone.
    expect(document.querySelector('section[aria-label="Parameters"]')).not.toBeNull();
  });
});

describe("T492 — code parameters get the code editor", () => {
  it("mounts CodeMirror for a code-kind parameter, not a plain text field", async () => {
    await setup();
    const host = document.querySelector('[data-parameter-code]');
    expect(host).not.toBeNull();
    // The real editor, not the multiline fallback: CodeMirror renders its own surface.
    expect(host?.querySelector('[data-testid="shader-editor-surface"]')).not.toBeNull();
    // And the plain string parameter beside it stays a plain field.
    expect(screen.getByLabelText("Note").tagName).toBe("INPUT");
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

  /**
   * T1064 — the readout follows the COMPILER, one plan behind, and that is the point.
   *
   * It used to halve the number itself the instant the select changed, which looked more
   * responsive and was a guess: the panel was telling the user what it believed the
   * compiler would decide. Now the override is written, the app recompiles, and the new
   * plan carries the answer — so what is asserted is the write and then the report, with
   * the recompile made explicit because this harness has no compile loop of its own.
   */
  it("stores the 1/2 override, and reports the size the NEXT plan carries", async () => {
    const harness = await setup();
    openCommon();
    fireEvent.change(screen.getByLabelText("Resolution mode"), { target: { value: "scale:1/2" } });

    await waitFor(() =>
      expect(harness.node()?.resolution).toEqual({ mode: "scale", factor: 0.5, input: "source" }),
    );
    // Still the plan it was given: no guess is made in between.
    expect(within(screen.getByLabelText("Resolved output")).getByText("800 × 600")).toBeDefined();

    harness.recompiledTo({ size: [400, 300], format: "rgba8unorm" });
    await waitFor(() =>
      expect(within(screen.getAllByLabelText("Resolved output")[1]!).getByText("400 × 300")).toBeDefined(),
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

  /**
   * T1064 — THE PANEL NO LONGER JUDGES SUPPORT, and this test is the one that used to
   * pin the bug.
   *
   * It asserted that picking `r32float` on a device without it made the readout say
   * "r32float — unsupported". Both halves were wrong at once: the node was already
   * rendering into the fallback the compiler picked, so the panel was naming a format
   * the node did not have and reporting a problem that had already been solved. The
   * substitute is named by the compiler's own diagnostic (the test directly below), and
   * the only support claim left in this panel is on the CHOOSER — an option marked
   * before it is picked, which is help rather than a lie.
   */
  it("marks an unreachable format in the chooser, and never contradicts the plan (§V12)", async () => {
    const harness = await setup({ planned: { size: [800, 600], format: "rgba16float" } });
    openCommon();
    const chooser = screen.getByLabelText("Pixel format") as HTMLSelectElement;
    const unreachable = Array.from(chooser.options).find((option) => option.value === "r32float");
    expect(unreachable?.textContent).toContain("unsupported");

    fireEvent.change(chooser, { target: { value: "r32float" } });
    await waitFor(() => expect(harness.node()?.format).toEqual({ mode: "fixed", format: "r32float" }));

    // The readout names what the PLAN carries — the fallback — not what was asked for.
    const readout = screen.getByLabelText("Resolved output");
    expect(within(readout).getByText("rgba16float")).toBeDefined();
    expect(readout.textContent).not.toContain("r32float");
    expect(readout.textContent).not.toContain("unsupported");
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

/**
 * T954 — the header says WHICH NODE, then what it is.
 *
 * It used to say the type twice and the identity once, quietly: `definition.title`
 * ("Everything") bold, `node.type` ("test.everything") beside it — the same fact in
 * machine form — and `node.id` dim and far right. So the one thing that says which node
 * this is was the smallest, dimmest and furthest from the eye, and the panel was
 * inverted from the graph node header the user had just clicked from.
 *
 * §B170 is why the name is `label ?? id` and not the id alone: ids are EDGE ADDRESSES
 * and labels are NAMES. Reading the id when a label exists is the shape of the `sway1`
 * bug that hid for months.
 */
describe("T954 — name first, machine type as a badge", () => {
  it("names the node by its LABEL, and says the machine type exactly once", async () => {
    const { node } = await setup();
    const label = node()?.label;
    expect(label).toBeDefined();

    const header = document.querySelector("header");
    expect(header).not.toBeNull();

    // The badge — one of them, carrying the addressable machine name.
    const badges = header?.querySelectorAll("[data-machine-type]") ?? [];
    expect(badges.length).toBe(1);
    expect(badges[0]?.textContent).toBe("test.everything");

    // The NAME leads, and it is the node's, not the type's display name.
    expect(header?.firstElementChild?.textContent).toBe(label);
    expect(header?.textContent).not.toContain("Everything");

    // Said once: the type occupied both prominent slots before this.
    expect(header?.textContent?.split("test.everything").length).toBe(2);

    // The id no longer takes a slot of its own — the label IS the name (§B170).
    expect(header?.textContent).not.toContain(node()?.id);
  });

  it("falls back to the ID when a node carries no label (§B170's legacy shape)", () => {
    // E14's `sway` node: `{ id, type }` with no label at all. The id is then the only
    // thing that says which node this is, and it is what `op()` cannot address — so it
    // is exactly what the header must show.
    const nodeId = "sway" as NodeId;
    const store = createGraphStore({
      initialGraph: {
        revision: 1,
        nodes: {
          [nodeId]: {
            id: nodeId,
            type: everythingNode.type,
            definitionVersion: everythingNode.version,
            position: { x: 0, y: 0 },
            parameters: {},
          },
        },
        edges: {},
        groups: {},
      },
    });
    const { bus } = createDomainBus({
      store,
      registry: createNodeRegistry([everythingNode]).view(),
    });
    render(<Inspector bus={bus} context={context} nodeId={nodeId} settings={settings} />);

    const header = document.querySelector("header");
    expect(header?.firstElementChild?.textContent).toBe("sway");
    expect(header?.querySelector("[data-machine-type]")?.textContent).toBe("test.everything");
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════════════
 * T1064 — THE NUMBER ON SCREEN IS THE NUMBER THE COMPILER RESOLVED.
 * ═══════════════════════════════════════════════════════════════════════════════════
 *
 * The panel used to run its own copy of the compiler's precedence ladder and was handed
 * the project cap ALONE, while `compiler/resolution.ts` clamps to
 * `min(project, capabilities.maxTextureDimension2D)`. Every device whose ceiling sits
 * below the project cap — most of them, at 4096 or 8192 against a 16384 project — read a
 * size the node never has. The user was told the output is 4000 wide; it was 2048.
 *
 * `a388cda` patched the mirror's inputs. This gates the real fix, and it gates it the only
 * way that cannot be satisfied by a better mirror: the expectation is COMPILED, not
 * written down. `compileGraph` runs with the device cap in force, its `ResolvedOutput` row
 * is handed to the panel exactly as `side-panes.tsx` hands it over, and the readout must
 * agree with it. Any second implementation that disagreed by a pixel fails here.
 *
 * The fixture is 4000 UNDER the 4096 project cap on purpose (§V854): a size over BOTH caps
 * would resolve to 2048 either way and would have gone green against the bug. The 16384
 * case is its converse — clamping to a constant cannot pass both.
 */
describe("the resolved-size readout is the compiler's answer, on the device in front of you", () => {
  const registry = createNodeRegistry([sourceNode, everythingNode, sinkNode]).view();

  const projectSettings = (): ProjectSettings =>
    ({
      outputResolution: { width: 1920, height: 1080 },
      workingFormat: "rgba8unorm",
      randomSeed: 1,
      previewLongEdge: 192,
      previewFps: 20,
      limits: {
        maxResolution: 4096,
        maxDispatch: 65_535,
        maxBufferBytes: 268_435_456,
        memoryBudgetBytes: 1_073_741_824,
      },
    }) as never;

  const capabilitiesWith = (deviceCap: number | undefined): BackendCapabilities =>
    ({
      tier: "A",
      features: [],
      formats: ["rgba8unorm", "rgba16float"],
      timestampQuery: false,
      limits: deviceCap === undefined ? {} : { maxTextureDimension2D: deviceCap },
    }) as never;

  async function renderWithCap(deviceCap: number | undefined): Promise<{
    readout: () => string;
    /** What the COMPILER resolved for the node — the expectation, derived not asserted. */
    planned: [number, number];
  }> {
    const store = createGraphStore({ ids: createSequentialIdFactory("i") });
    const { bus } = createDomainBus({ store, registry });
    const created = await bus.execute(
      "graph.applyPatch",
      {
        baseRevision: 0,
        operations: [
          { op: "addNode", ref: "$src", type: sourceNode.type, position: { x: -200, y: 0 } },
          { op: "addNode", ref: "$n", type: everythingNode.type, position: { x: 0, y: 0 } },
          { op: "addNode", ref: "$out", type: sinkNode.type, position: { x: 200, y: 0 } },
          {
            op: "connect",
            ref: "$feed",
            source: { nodeId: "$src", portId: "out" },
            target: { nodeId: "$n", portId: "source" },
          },
          {
            op: "connect",
            ref: "$e",
            source: { nodeId: "$n", portId: "out" },
            target: { nodeId: "$out", portId: "input" },
          },
        ],
      },
      context,
    );
    const nodeId = created.output.createdIds["$n"] as NodeId;
    await bus.execute(
      "graph.applyPatch",
      {
        baseRevision: bus.store.getGraph().revision,
        operations: [
          {
            op: "setNodeResolution",
            nodeId,
            resolution: { mode: "fixed", width: 4000, height: 4000 },
          },
        ],
      },
      context,
    );

    const compiled = compileGraph({
      graph: bus.store.getGraph(),
      settings: projectSettings(),
      registry,
      capabilities: capabilitiesWith(deviceCap),
    });
    expect(compiled.diagnostics.filter((entry) => entry.severity === "error")).toEqual([]);
    const row = compiled.outputs.find((output) => output.nodeId === nodeId);
    if (row === undefined) throw new Error("the compiler materialized no output for the node");

    render(
      <Inspector
        bus={bus}
        context={context}
        nodeId={nodeId}
        settings={settings}
        diagnostics={compiled.diagnostics}
        planned={row}
        capabilities={{
          formats: ["rgba8unorm", "rgba16float"],
          ...(deviceCap === undefined ? {} : { maxTextureDimension2D: deviceCap }),
        }}
      />,
    );
    return {
      readout: () => screen.getByLabelText("Resolved output").textContent ?? "",
      planned: [row.size[0], row.size[1]],
    };
  }

  it("shows the DEVICE ceiling when it is lower than the project cap", async () => {
    const { readout, planned } = await renderWithCap(2048);
    // The plan is the authority, and the plan says 2048 — pinned here so that "the readout
    // matches the plan" cannot be satisfied by both of them being wrong together.
    expect(planned).toEqual([2048, 2048]);
    expect(readout()).toContain(`${planned[0]} × ${planned[1]}`);
    expect(readout()).not.toContain("4000");
    expect(readout()).toContain("clamped");
  });

  it("shows the requested size when the device can allocate it — both directions", async () => {
    // The same 4000, on a device that can take it. Without this, an implementation that
    // clamped everything to a constant would pass the assertion above.
    const { readout, planned } = await renderWithCap(16384);
    expect(planned).toEqual([4000, 4000]);
    expect(readout()).toContain("4000 × 4000");
    expect(readout()).not.toContain("clamped");
  });

  it("falls back to the project cap when no device has reported yet", async () => {
    // Absent means "no report", not "unlimited": 4000 is under the 4096 project cap, so it
    // stands. This is the pre-device state the panel renders before the backend attaches.
    const { readout, planned } = await renderWithCap(undefined);
    expect(planned).toEqual([4000, 4000]);
    expect(readout()).toContain("4000 × 4000");
  });

  /**
   * The state the deleted arithmetic could not represent. No plan row means no texture —
   * pruned, inside a component, or nothing compiled yet — and a panel that answers anyway
   * is the whole class of bug this row was about, one step further along.
   */
  it("says it has no size when the node is not in the plan, rather than inventing one", async () => {
    const store = createGraphStore({ ids: createSequentialIdFactory("i") });
    const { bus } = createDomainBus({ store, registry });
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
    render(
      <Inspector
        bus={bus}
        context={context}
        nodeId={created.output.createdIds["$n"] as NodeId}
        settings={settings}
      />,
    );
    const readout = screen.getByLabelText("Resolved output").textContent ?? "";
    expect(readout).not.toMatch(/\d/);
    expect(readout).toContain("not in the compiled plan");
  });
});
