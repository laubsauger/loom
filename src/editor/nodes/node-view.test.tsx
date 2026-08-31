// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { installDomStubs } from "@ui/testing/install-dom-stubs.ts";
import { createDomainBus } from "@domain/commands/index.ts";
import { createGraphStore } from "@domain/graph/store.ts";
import { createSequentialIdFactory } from "@domain/graph/ids.ts";
import { alice, contextFor } from "@domain/commands/test-support.ts";
import type { GraphDocument } from "@domain/types/graph.ts";
import type { GraphPatchOperation } from "@domain/types/patch.ts";
import { createTestRegistry } from "@nodes/registry/test-nodes.ts";
import { createNodeRegistry } from "@nodes/registry/registry.ts";
import type { NodeRegistry } from "@nodes/registry/registry.ts";
import { allNodeDefinitions } from "@nodes/definitions/index.ts";
import {
  CanvasFixture,
  fixtureContext,
  installFlowStubs,
  nodeProps,
  setReducedMotion,
} from "@editor/graph-canvas/testing.tsx";
import type { NodeRunStatus, NodeRuntimeStore } from "@editor/graph-canvas/node-runtime.ts";
import { NodeView } from "./node-view.tsx";
import { STATUS_LABEL } from "./status.ts";

beforeAll(() => {
  installDomStubs();
  installFlowStubs();
});
beforeEach(() => setReducedMotion(false));
afterEach(cleanup);

const invocation = contextFor(alice);

interface Options {
  graph?: GraphDocument;
  renderPreview?: (nodeId: string) => React.ReactNode;
  renderControls?: (nodeId: string) => React.ReactNode;
  /** Current canvas selection (§V101) — defaults to none. */
  selection?: readonly string[];
  /** T457: the REAL catalogue, for nodes whose behaviour keys off their true type. */
  registry?: ReturnType<NodeRegistry["view"]>;
  /** T599: spy for the "+N more" chip's door. */
  showProblems?: () => void;
  /** T602: spy for the double-click dive. */
  diveIn?: (nodeId: string) => void;
  /** T603: catalogue view for instance marks. */
  components?: unknown;
}

/**
 * Mounts one node against a real store and a real command bus, so every edit the node
 * chrome makes is exercised through the only mutation path there is (§V29).
 */
function mountNode(type: string, options: Options = {}) {
  const store = createGraphStore({
    ids: createSequentialIdFactory("n"),
    ...(options.graph === undefined ? {} : { initialGraph: options.graph }),
  });
  const { bus } = createDomainBus({ store, registry: options.registry ?? createTestRegistry().view() });
  const dispatched: GraphPatchOperation[][] = [];
  const toggled: { command: string; nodeIds: readonly string[] }[] = [];

  const seeded = Object.keys(bus.store.getGraph().nodes)[0];
  const nodeId = seeded ?? "pending";

  const { value, runtime } = fixtureContext({
    store: bus.store,
    registry: bus.registry,
    dispatch: (operations, label) => {
      dispatched.push(operations);
      void bus.execute(
        "graph.applyPatch",
        { baseRevision: bus.store.getRevision(), operations, label },
        invocation,
      );
    },
    selection: options.selection ?? [],
    // Mirrors `graph-canvas.tsx`'s real `toggleUi` (§V101/§V102/§V29): a badge press
    // runs the SAME bus command the keymap and the context menu use, never a raw patch.
    toggleUi: (command, nodeIds) => {
      toggled.push({ command, nodeIds });
      void bus.execute(command, { nodeIds }, invocation);
    },
    ...(options.renderPreview === undefined ? {} : { renderPreview: options.renderPreview }),
    ...(options.renderControls === undefined ? {} : { renderControls: options.renderControls }),
    ...(options.showProblems === undefined ? {} : { showProblems: options.showProblems }),
    ...(options.diveIn === undefined ? {} : { diveIn: options.diveIn }),
    ...(options.components === undefined ? {} : { components: options.components as never }),
  });

  const view = render(
    <CanvasFixture value={value}>
      <NodeView {...nodeProps(nodeId)} />
    </CanvasFixture>,
  );

  return { ...view, bus, runtime, nodeId, dispatched, toggled, type };
}

function graphWith(type: string, ui?: Record<string, boolean>): GraphDocument {
  return {
    revision: 1,
    nodes: {
      n1: {
        id: "n1",
        type,
        definitionVersion: 1,
        position: { x: 0, y: 0 },
        parameters: {},
        ...(ui === undefined ? {} : { ui }),
      },
    },
    edges: {},
    groups: {},
  };
}

async function publish(
  runtime: NodeRuntimeStore,
  nodeId: string,
  patch: Parameters<NodeRuntimeStore["publish"]>[1],
) {
  await act(async () => {
    runtime.publish(nodeId, patch);
    await new Promise((resolve) => setTimeout(resolve, 1));
  });
}

describe("V1 — the node renders the document, not a copy of it", () => {
  it("takes its title and ports from the registered definition", () => {
    const { container } = mountNode("test.composite", { graph: graphWith("test.composite") });

    expect(screen.getByTitle("Composite")).toBeDefined();
    const rows = [...container.querySelectorAll("li[data-kind]")];
    // T695/T227 — "Layers 1", not "Layers": a variadic input renders one NUMBERED socket
    // per edge plus a spare, and here it is unwired, so the spare is the only one. The
    // index is not decoration; it is the address the user aims a replacing drop at, and a
    // socket the document orders (§V131) while the node refuses to say which one it is
    // leaves "put this behind that" unsayable.
    expect(rows.map((row) => row.textContent)).toEqual(["Layers 1", "Mask", "Out"]);
  });

  it("puts inputs on the left and outputs on the right (doc §17.2)", () => {
    const { container } = mountNode("test.blur", { graph: graphWith("test.blur") });

    const inputs = [...container.querySelectorAll('[data-handlepos="left"]')];
    const outputs = [...container.querySelectorAll('[data-handlepos="right"]')];
    expect(inputs.map((handle) => handle.getAttribute("data-handleid"))).toEqual(["source"]);
    expect(outputs.map((handle) => handle.getAttribute("data-handleid"))).toEqual(["out"]);
  });

  it("preserves an unresolved node instead of dropping it (§V10)", () => {
    const { container } = mountNode("not.installed", { graph: graphWith("not.installed") });

    const node = container.querySelector("[data-testid^='node-']");
    expect(node?.getAttribute("data-status")).toBe("error");
    expect(screen.getByText(/Unknown node type "not.installed"/)).toBeDefined();
    // No definition means no ports we could honestly draw.
    expect(container.querySelectorAll("li[data-kind]")).toHaveLength(0);
  });
});

describe("V26 — port dots carry the family colour the edges use", () => {
  it("colours every port from its own family token", () => {
    const { container } = mountNode("test.composite", { graph: graphWith("test.composite") });
    const rows = [...container.querySelectorAll("li[data-kind]")];
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      const kind = row.getAttribute("data-kind");
      expect(row.getAttribute("style")).toContain(`--port-color: var(--port-${kind})`);
    }
  });

  it("gives a differently typed port a different family token", () => {
    const { container } = mountNode("test.scalarF32", { graph: graphWith("test.scalarF32") });
    const row = container.querySelector("li[data-kind]");
    expect(row?.getAttribute("data-kind")).toBe("scalar");
    expect(row?.getAttribute("style")).toContain("var(--port-scalar)");
  });
});

describe("node status states are distinct (doc §17.2)", () => {
  const statuses: NodeRunStatus[] = [
    "idle",
    "compiling",
    "valid",
    "warning",
    "error",
    "device-lost",
  ];

  it("renders a distinguishable state for each", async () => {
    const seen = new Set<string>();
    for (const status of statuses) {
      const { container, runtime, nodeId, unmount } = mountNode("test.blur", {
        graph: graphWith("test.blur"),
      });
      await publish(runtime, nodeId, { status });

      const node = container.querySelector("[data-testid^='node-']");
      const dot = container.querySelector("[data-testid^='node-status-']");
      expect(node?.getAttribute("data-status")).toBe(status);
      const label = dot?.getAttribute("aria-label") ?? "";
      expect(label).toBe(`Status: ${STATUS_LABEL[status]}`);
      // Colour is never the only carrier of the state (§V19).
      seen.add(label);
      unmount();
    }
    expect(seen.size).toBe(statuses.length);
  });

  it("shows bypassed and muted as document state, separate from run status", () => {
    const bypassed = mountNode("test.blur", { graph: graphWith("test.blur", { bypassed: true }) });
    expect(
      bypassed.container.querySelector("[data-testid^='node-']")?.getAttribute("data-bypassed"),
    ).toBe("true");
    bypassed.unmount();

    const muted = mountNode("test.blur", { graph: graphWith("test.blur", { muted: true }) });
    expect(
      muted.container.querySelector("[data-testid^='node-']")?.getAttribute("data-muted"),
    ).toBe("true");
  });

  /**
   * B36/§V269 — the node badge no longer claims staleness, and that is the assertion.
   *
   * This test used to publish `stale: true` and check the badge lit. Nothing in the
   * product ever published that field, so the only thing setting it was this line: the
   * test supplied the wiring it was testing, which is why the dead field survived as long
   * as it did (§V220). §V9's staleness is the whole retained PROGRAM, true for every node
   * at once, so it belongs in the popup — per-node, on demand — and not on N badges.
   */
  it("does not claim staleness on the badge; the program-level fact is the popup's", () => {
    const { container } = mountNode("test.blur", { graph: graphWith("test.blur") });
    expect(container.textContent).not.toContain("stale");
  });

  it("carries the shader diagnostic badge, and shows nothing while clean (§V27)", async () => {
    const { runtime, nodeId } = mountNode("test.customWgsl", {
      graph: graphWith("test.customWgsl"),
    });
    expect(screen.queryByRole("status")).toBeNull();

    await publish(runtime, nodeId, { errorCount: 2, warningCount: 1 });
    expect(screen.getByRole("status").getAttribute("aria-label")).toBe(
      "Shader: 2 errors, 1 warnings",
    );
  });
});

describe("V42 — agent activity is visible on the node it is changing", () => {
  it("names the state and the actor", async () => {
    const { runtime, nodeId } = mountNode("test.blur", { graph: graphWith("test.blur") });
    await publish(runtime, nodeId, {
      agent: { kind: "awaiting-approval", actorLabel: "Claude", detail: "wants to rewrite WGSL" },
    });

    expect(screen.getByText("awaiting approval")).toBeDefined();
    expect(screen.getByText("Claude")).toBeDefined();
    expect(screen.getByText("wants to rewrite WGSL")).toBeDefined();
  });

  it("shows nothing when no agent is involved", () => {
    const { container } = mountNode("test.blur", { graph: graphWith("test.blur") });
    expect(container.querySelector("[data-testid^='node-']")?.getAttribute("data-agent")).toBe(
      "none",
    );
  });
});

describe("V16 — metrics reach the node without touching the document", () => {
  it("shows per-pass GPU time and leaves the graph revision alone", async () => {
    const { bus, runtime, nodeId } = mountNode("test.blur", { graph: graphWith("test.blur") });
    const before = bus.store.getRevision();

    expect(screen.getByLabelText("GPU time for this pass").textContent).toBe("—");
    await publish(runtime, nodeId, { gpuMs: 3.25 });

    expect(screen.getByLabelText("GPU time for this pass").textContent).toBe("3.25 ms");
    expect(bus.store.getRevision()).toBe(before);
  });
});

describe("V20 — a drag on embedded node chrome never becomes a node drag", () => {
  it("opts every embedded control out of React Flow's drag and pan filters", () => {
    const { container } = mountNode("test.blur", {
      graph: graphWith("test.blur", { preview: true }),
      renderPreview: () => <div>preview</div>,
      renderControls: () => <button type="button">radius</button>,
    });

    // React Flow refuses to start a drag or a pan when the pressed element is inside
    // `.nodrag` / `.nopan`. This is that predicate, evaluated the same way.
    for (const name of ["Bypass", "Mute", "Preview"]) {
      const control = screen.getByRole("button", { name });
      expect(control.closest(".nodrag")).not.toBeNull();
      expect(control.closest(".nopan")).not.toBeNull();
    }
    expect(screen.getByText("preview").closest(".nodrag")).not.toBeNull();
    expect(screen.getByText("radius").closest(".nodrag")).not.toBeNull();

    // The title bar, by contrast, must still drag the node.
    const title = container.querySelector("header");
    expect(title?.closest(".nodrag")).toBeNull();
  });

  it("swallows the press so an ancestor drag handler never sees it", () => {
    const ancestor = vi.fn();
    const store = createGraphStore({ initialGraph: graphWith("test.blur") });
    const { bus } = createDomainBus({ store, registry: createTestRegistry().view() });
    const { value } = fixtureContext({ store: bus.store, registry: bus.registry });

    render(
      <CanvasFixture value={value}>
        <div onPointerDown={ancestor} onMouseDown={ancestor}>
          <NodeView {...nodeProps("n1")} />
        </div>
      </CanvasFixture>,
    );

    fireEvent.mouseDown(screen.getByRole("button", { name: "Bypass" }));
    fireEvent.pointerDown(screen.getByRole("button", { name: "Bypass" }));
    expect(ancestor).not.toHaveBeenCalled();

    // A press on the node body itself still reaches the ancestor — otherwise dragging
    // a node would be broken, which is the opposite failure.
    fireEvent.mouseDown(screen.getByTitle("Blur"));
    expect(ancestor).toHaveBeenCalled();
  });
});

describe("V29/V101/V102 — node badges run the same bus command as the keymap and the menu", () => {
  it("bypasses and un-bypasses through node.toggleBypass, never a raw patch", async () => {
    const { bus, dispatched, toggled } = mountNode("test.blur", { graph: graphWith("test.blur") });

    fireEvent.click(screen.getByRole("button", { name: "Bypass" }));
    await waitFor(() => {
      expect(bus.store.getGraph().nodes["n1"]?.ui?.bypassed).toBe(true);
    });
    expect(toggled).toEqual([{ command: "node.toggleBypass", nodeIds: ["n1"] }]);
    // The badge never falls back to a raw `setNodeUi` patch (§V29, §V101).
    expect(dispatched).toEqual([]);

    fireEvent.click(screen.getByRole("button", { name: "Bypass" }));
    await waitFor(() => {
      expect(bus.store.getGraph().nodes["n1"]?.ui?.bypassed).toBe(false);
    });
  });

  it("mutes through the bus too, and reflects the document back", async () => {
    const { bus } = mountNode("test.blur", { graph: graphWith("test.blur") });

    fireEvent.click(screen.getByRole("button", { name: "Mute" }));
    await waitFor(() => {
      expect(bus.store.getGraph().nodes["n1"]?.ui?.muted).toBe(true);
    });
    expect(screen.getByRole("button", { name: "Mute" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("targets this node alone when it is not part of the current selection (§V101)", async () => {
    const { bus, toggled } = mountNode("test.blur", {
      graph: graphWith("test.blur"),
      selection: ["some-other-node"],
    });

    fireEvent.click(screen.getByRole("button", { name: "Bypass" }));
    await waitFor(() => {
      expect(bus.store.getGraph().nodes["n1"]?.ui?.bypassed).toBe(true);
    });
    expect(toggled).toEqual([{ command: "node.toggleBypass", nodeIds: ["n1"] }]);
  });

  it("targets the whole selection when this node is part of it (§V101, §V102)", async () => {
    const graph: GraphDocument = {
      revision: 1,
      nodes: {
        n1: { id: "n1", type: "test.blur", definitionVersion: 1, position: { x: 0, y: 0 }, parameters: {} },
        n2: { id: "n2", type: "test.blur", definitionVersion: 1, position: { x: 0, y: 0 }, parameters: {}, ui: { bypassed: true } },
      },
      edges: {},
      groups: {},
    };
    const { bus, toggled } = mountNode("test.blur", { graph, selection: ["n1", "n2"] });

    fireEvent.click(screen.getByRole("button", { name: "Bypass" }));
    await waitFor(() => {
      // A mixed selection (n2 already bypassed, n1 not) becomes uniformly ON — never
      // each node flipping independently, which would keep it mixed forever (§V102).
      expect(bus.store.getGraph().nodes["n1"]?.ui?.bypassed).toBe(true);
      expect(bus.store.getGraph().nodes["n2"]?.ui?.bypassed).toBe(true);
    });
    expect(toggled).toEqual([{ command: "node.toggleBypass", nodeIds: ["n1", "n2"] }]);
  });
});

describe("preview slot (§V28b) — visible texture-producing node previews by default", () => {
  it("shows by default for a texture-producing node, before any pin is set", () => {
    const { container } = mountNode("test.blur", {
      graph: graphWith("test.blur"),
      renderPreview: () => <div>tile</div>,
    });
    expect(container.querySelector("[data-testid^='node-preview-']")).not.toBeNull();
    expect(screen.getByText("tile")).toBeDefined();
  });

  it("gives a VALUE node a slot too, because a signal is content (T344)", () => {
    // The rule used to be "texture output or nothing", which left the half of the graph
    // that MOVES as the half nobody could see: an LFO, a Lag and a Mouse all rendered an
    // empty box and all looked inert. A value node's channel is its output in exactly the
    // sense a texture is, so it gets the same slot and the composition root decides what
    // goes in it. T438: the slot keys on the DECLARED channel (`publishesValueChannels`),
    // so the real LFO is mounted — a fixture whose only claim was its category string is
    // exactly the shape T438 retired.
    const { container } = mountNode("lfo", {
      graph: graphWith("lfo"),
      registry: createNodeRegistry(allNodeDefinitions).view(),
      renderPreview: () => <div>plot</div>,
    });
    expect(container.querySelector("[data-testid^='node-preview-']")).not.toBeNull();
  });

  it("has no slot for a node type this build does not have (§V10)", () => {
    // An unknown-type placeholder produces neither pixels nor a channel, so there is
    // nothing to show — which is what keeps the widened gate from meaning "always".
    const { container } = mountNode("test.notInThisBuild", {
      graph: graphWith("test.notInThisBuild"),
      renderPreview: () => <div>tile</div>,
    });
    expect(container.querySelector("[data-testid^='node-preview-']")).toBeNull();
  });

  /**
   * T353/§V297 — `P` is the SWITCH, and it starts pressed.
   *
   * It used to toggle the pin, so the owner pressed it and nothing they could see
   * changed: previews were on either way, and the button reported a state nobody could
   * observe. The first press must now turn the preview OFF, which means the button has to
   * read an absent flag as ON — an untouched node is previewing.
   */
  it("'P' starts on, and one press writes preview: false", async () => {
    const { bus } = mountNode("test.blur", {
      graph: graphWith("test.blur"),
      renderPreview: () => <div>tile</div>,
    });
    expect(bus.store.getGraph().nodes["n1"]?.ui?.preview).toBeUndefined();
    const button = screen.getByRole("button", { name: "Preview" });
    // Default ON, stated in the accessibility tree and not only in the pixels.
    expect(button.getAttribute("aria-pressed")).toBe("true");

    fireEvent.click(button);
    await waitFor(() => {
      expect(bus.store.getGraph().nodes["n1"]?.ui?.preview).toBe(false);
    });
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Preview" }).getAttribute("aria-pressed")).toBe("false");
    });
    // The SLOT survives: a switched-off preview says so in its body (§V91/§V100) rather
    // than the node changing shape under the press.
    expect(screen.getByText("tile")).toBeDefined();
  });
});

describe("T457 (V387) — reference-fed inputs render NO socket", () => {
  const catalogue = createNodeRegistry(allNodeDefinitions).view();

  it("a render node's only socket is the one REAL wire — every name is invisible", () => {
    const { container } = mountNode("render", { graph: graphWith("render"), registry: catalogue });
    // scenes/camera/lights are reference-fed plumbing: a socket there invites a wire
    // that apply-patch refuses (port.sourceReference), so none is drawn. The
    // environment (T482) is a genuine texture wire — pixels are data (V372) — and its
    // socket is exactly what remains.
    const inputs = [...container.querySelectorAll('[data-handlepos="left"]')];
    expect(inputs.map((handle) => handle.getAttribute("data-handleid"))).toEqual(["environment"]);
    // The output socket is real and stays.
    const outputs = [...container.querySelectorAll('[data-handlepos="right"]')];
    expect(outputs.map((handle) => handle.getAttribute("data-handleid"))).toEqual(["out"]);
  });

  it("a wireable input on the same node keeps its socket (renderSurface: points yes, camera no)", () => {
    const { container } = mountNode("renderSurface", {
      graph: graphWith("renderSurface"),
      registry: catalogue,
    });
    const inputs = [...container.querySelectorAll('[data-handlepos="left"]')];
    expect(inputs.map((handle) => handle.getAttribute("data-handleid"))).toEqual(["points"]);
  });

  it("feedback's in port is plumbing too — the loop is a NAME (T350)", () => {
    const { container } = mountNode("feedback", { graph: graphWith("feedback"), registry: catalogue });
    const inputs = [...container.querySelectorAll('[data-handlepos="left"]')];
    expect(inputs).toEqual([]);
  });
});

describe("T462 (§V85) — a scene payload node owns a preview slot", () => {
  /**
   * T532 replaced this case's last clause. It used to end "and geometry deliberately does
   * not", and that decision is what left the geometry node with nothing to show: the
   * compiler had no variant for it AND this slot, the candidate list and the layout model
   * had all never heard of `scene`, so writing one variant alone would have changed
   * nothing on screen — B65 verbatim.
   */
  it("every previewable payload kind renders the slot, geometry included (T532)", () => {
    const catalogue = createNodeRegistry(allNodeDefinitions).view();
    for (const type of ["camera", "light", "materialPhong", "geometry"]) {
      const { container, unmount } = mountNode(type, {
        graph: graphWith(type),
        registry: catalogue,
        renderPreview: () => <div>tile</div>,
      });
      // B65's lesson asserted on the DISPLAY side this time: no slot div means no
      // bounds, no sink, no target — the whole pipeline with its last millimetre gone.
      expect(container.querySelector("[data-testid^='node-preview-']"), type).not.toBeNull();
      unmount();
    }
    // NO NEGATIVE CONTROL, and that is a measurement rather than an omission: every
    // definition in the shipped catalogue now produces a texture, a pointset, a scene
    // payload or a channel, or is a declared sink, so no real node is one (the same
    // finding `pointset-preview-slot.test.tsx` records). Sensitivity is proven the other
    // way instead — drop `scene` from `PREVIEWABLE_PORT_KINDS` and the geometry case
    // here goes red, along with the compiler sweep and the layout model's agreement gate.
  });
});

describe("T599 — a node with more diagnostics than its one line owns a door to the rest", () => {
  it("shows an honest '+N more' that fronts the problems pane, and only when there IS more", async () => {
    const opened: number[] = [];
    const { runtime, nodeId, container } = mountNode("test.blur", {
      graph: graphWith("test.blur"),
      showProblems: () => opened.push(1),
    });

    // One diagnostic: the message line suffices, no chip.
    await publish(runtime, nodeId, {
      status: "error",
      errorCount: 1,
      warningCount: 0,
      message: 'Node "blur1" broke.',
    });
    expect(container.textContent).not.toContain("more");

    // Five diagnostics: one message line, four unreachable — the chip is the door.
    await publish(runtime, nodeId, {
      status: "error",
      errorCount: 2,
      warningCount: 3,
      message: 'Node "blur1" broke.',
    });
    const chip = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("+4 more"),
    );
    expect(chip).toBeDefined();
    fireEvent.click(chip as HTMLButtonElement);
    expect(opened).toHaveLength(1);
    // `nodrag`: the click is a click, never the start of a node drag (§V20).
    expect(chip?.className).toContain("nodrag");
  });
});

describe("T607 — a component boundary node wears its dangling lead", () => {
  it.each([
    ["componentIn", "in"],
    ["componentOut", "out"],
    ["componentInPoints", "in"],
    ["componentOutPoints", "out"],
  ])("%s carries data-boundary=%s for the CSS lead", (type, side) => {
    const { nodeId, container } = mountNode(type, {
      graph: graphWith(type),
      registry: createNodeRegistry(allNodeDefinitions).view(),
    });
    const element = container.querySelector(`[data-testid="node-${nodeId}"]`);
    expect(element?.getAttribute("data-boundary")).toBe(side);
  });

  it("an ordinary node carries no boundary attribute — the lead is not a default", () => {
    const { nodeId, container } = mountNode("blur", {
      graph: graphWith("blur"),
      registry: createNodeRegistry(allNodeDefinitions).view(),
    });
    expect(
      container.querySelector(`[data-testid="node-${nodeId}"]`)?.hasAttribute("data-boundary"),
    ).toBe(false);
  });
});

describe("T602 — double-click enters a component instance, and only an instance", () => {
  it("runs diveIn for an instance; a plain node's double-click stays plain; the title still renames", () => {
    const dived: string[] = [];
    const { nodeId, container } = mountNode("component:fx@1", {
      graph: graphWith("component:fx@1"),
      diveIn: (id) => dived.push(id),
    });
    const element = container.querySelector(`[data-testid="node-${nodeId}"]`);
    fireEvent.doubleClick(element as Element);
    expect(dived).toEqual([nodeId]);

    // The TITLE keeps rename: its double-click must not also dive. (An UNRESOLVED
    // instance type still renders the name span; match it by its displayed text.)
    const title = [...container.querySelectorAll("header span")].find(
      (span) => span.textContent !== null && span.textContent.length > 0 && span.getAttribute("title") !== null,
    );
    if (title !== undefined) {
      fireEvent.doubleClick(title);
      expect(dived).toHaveLength(1);
    }

    const plain = mountNode("test.blur", {
      graph: graphWith("test.blur"),
      diveIn: (id) => dived.push(id),
    });
    fireEvent.doubleClick(
      plain.container.querySelector(`[data-testid="node-${plain.nodeId}"]`) as Element,
    );
    expect(dived).toHaveLength(1);
  });
});

describe("T603 — a component instance reads as one at a glance", () => {
  it("carries the structural mark, and the chip states linked + pinned version + upgrade", async () => {
    const { createComponentSystem } = await import("@domain/components/index.ts");
    const definitionOf = (version: number) =>
      ({
        componentId: "fx",
        version,
        name: "FX",
        graph: {
          revision: 1,
          nodes: { inner: { id: "inner", type: "test.solid", definitionVersion: 1, position: { x: 0, y: 0 }, parameters: {} } },
          edges: {},
          groups: {},
        },
        inputs: [],
        outputs: [{ externalId: "out", label: "Out", nodeId: "inner", portId: "out" }],
        parameters: [],
      }) as never;
    const system = createComponentSystem(createTestRegistry().view(), [definitionOf(1)]);

    const pinned = mountNode("component:fx@1", {
      graph: graphWith("component:fx@1"),
      registry: system.nodes,
      components: system.components.view(),
    });
    const element = pinned.container.querySelector(`[data-testid="node-${pinned.nodeId}"]`);
    expect(element?.hasAttribute("data-component")).toBe(true);
    const chip = pinned.container.querySelector(`[data-testid="node-component-${pinned.nodeId}"]`);
    expect(chip?.textContent).toBe("v1");
    expect(chip?.getAttribute("data-upgrade")).toBe("false");

    // A newer version registers: the SAME node now states the available upgrade.
    system.components.register(definitionOf(2));
    const behind = mountNode("component:fx@1", {
      graph: graphWith("component:fx@1"),
      registry: system.nodes,
      components: system.components.view(),
    });
    const upgraded = behind.container.querySelector(`[data-testid="node-component-${behind.nodeId}"]`);
    expect(upgraded?.textContent).toBe("v1\u21922");
    expect(upgraded?.getAttribute("data-upgrade")).toBe("true");

    // A plain node wears none of it — the treatment is identity, not decoration.
    const plain = mountNode("test.blur", { graph: graphWith("test.blur") });
    expect(
      plain.container.querySelector(`[data-testid="node-${plain.nodeId}"]`)?.hasAttribute("data-component"),
    ).toBe(false);
    expect(plain.container.querySelector(`[data-testid="node-component-${plain.nodeId}"]`)).toBeNull();
  });
});

describe("T639(d)/T640 — an instance's type label says what the node IS", () => {
  it("reads 'component', not the component's own name again", async () => {
    // The synthesized definition's title is the component's NAME (definition.ts:95), so
    // the old label repeated the name and said nothing — a component the owner called
    // "animated" labelled its nodes "animated". The KIND is the useful fact.
    const { createComponentSystem } = await import("@domain/components/index.ts");
    const system = createComponentSystem(createTestRegistry().view(), [
      {
        componentId: "animated",
        version: 1,
        name: "animated",
        graph: {
          revision: 1,
          nodes: { inner: { id: "inner", type: "test.solid", definitionVersion: 1, position: { x: 0, y: 0 }, parameters: {} } },
          edges: {},
          groups: {},
        },
        inputs: [],
        outputs: [{ externalId: "out", label: "Out", nodeId: "inner", portId: "out" }],
        parameters: [],
      } as never,
    ]);
    const { nodeId, container } = mountNode("component:animated@1", {
      graph: graphWith("component:animated@1"),
      registry: system.nodes,
      components: system.components.view(),
    });
    const label = container.querySelector(`[data-testid="node-type-${nodeId}"]`);
    expect(label?.textContent).toBe("component");
    expect(label?.textContent).not.toBe("animated");
  });
});
