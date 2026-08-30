// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { ReactNode } from "react";
import { alice, contextFor, createHarness } from "@domain/commands/test-support.ts";
import type { ShaderloomBus } from "@domain/commands/bus.ts";
import type { PassDescriptor, ResourceDescriptor } from "@runtime/backend/plan.ts";
import type { ResolvedOutput } from "@compiler/index.ts";
import { EMPTY_READBACK_BUDGET } from "@runtime/telemetry/index.ts";
import type { TelemetrySnapshot } from "@runtime/telemetry/index.ts";
import { installDomStubs } from "@ui/testing/install-dom-stubs.ts";
import { SHOW_NODE_INFO_COMMAND } from "./command.ts";
import { buildNodeInfo } from "./node-info-model.ts";
import { NodeInfoHost } from "./node-info-host.tsx";
import { NodeInfoPopup } from "./node-info-popup.tsx";
import { PerformanceView } from "./performance-panel.tsx";
import { compiledOf, graphOf, hubWith, node, testRegistry } from "./test-support.ts";

/**
 * The node info surface (T145, T41, §V85, §V86, §V19).
 *
 * Two things are being pinned here. First, that the popup renders every field from a
 * FIXTURE — no device, no adapter, no frame loop — which is what makes §V85's "read-only
 * view over data already collected" checkable rather than aspirational. Second, that it is
 * fully keyboard-operable: TD reaches this with the mouse, but a surface only reachable
 * with a middle click is a surface half the users cannot open (§V19).
 */

beforeAll(installDomStubs);
afterEach(cleanup);

const registry = testRegistry();

const target = (id: string): ResourceDescriptor => ({
  kind: "target",
  id,
  size: [1280, 720],
  format: "rgba16float",
});

const effect = (id: string, nodeId: string, resourceId: string): PassDescriptor => ({
  kind: "effect",
  id,
  shader: "",
  target: resourceId,
  nodeId,
});

const resolved = (nodeId: string, resourceId: string): ResolvedOutput => ({
  nodeId,
  portId: "out",
  resourceId,
  resourceKind: "target",
  size: [1280, 720],
  format: "rgba16float",
  space: "linear",
  temporal: false,
});

function blurPlan() {
  return compiledOf({
    passes: [effect("blur:p0", "blur", "blur:out")],
    resources: [target("blur:out")],
    order: ["blur"],
    outputs: [resolved("blur", "blur:out")],
    estimatedResourceBytes: 1280 * 720 * 8,
  });
}

describe("the popup renders every field from a fixture, with no GPU", () => {
  it("shows identity, cook, output and decision facts", () => {
    const plan = blurPlan();
    const { hub } = hubWith(plan, { "blur:p0": 1.234 });
    hub.noteFrame(42);
    const info = buildNodeInfo({
      nodeId: "blur",
      graph: graphOf([node("blur", "test.blur", { label: "Soft Blur" })]),
      registry,
      compiled: plan,
      telemetry: hub,
    });

    render(<NodeInfoPopup info={info} />);

    expect(screen.getByText("Soft Blur")).toBeTruthy();
    expect(screen.getByText(/Blur · blur/)).toBeTruthy();
    expect(screen.getByText("1.234 ms")).toBeTruthy();
    expect(screen.getByText("1280 × 720")).toBeTruthy();
    expect(screen.getByText(/rgba16float/)).toBeTruthy();
    expect(screen.getByText(/linear \(working space\)/)).toBeTruthy();
    expect(screen.getByText("7.0 MiB")).toBeTruthy();
    expect(screen.getByText("42")).toBeTruthy();
    expect(screen.getAllByText(/default · follows the primary input/)).toHaveLength(2);
    hub.dispose();
  });

  it("reads 'unavailable' rather than 0 ms with no timestamp query (§V86)", () => {
    const plan = blurPlan();
    const { hub } = hubWith(plan, {}, { timestampQuery: false });
    const info = buildNodeInfo({
      nodeId: "blur",
      graph: graphOf([node("blur", "test.blur")]),
      registry,
      compiled: plan,
      telemetry: hub,
    });

    render(<NodeInfoPopup info={info} />);

    expect(screen.getByText("unavailable")).toBeTruthy();
    expect(screen.queryByText("0.000 ms")).toBeNull();
    expect(screen.getByText(/timestamp-query/)).toBeTruthy();
    // The structural facts are still there — only the duration is missing.
    expect(screen.getByText("1280 × 720")).toBeTruthy();
    hub.dispose();
  });

  it("shows a component's own / children / total split (§V87)", () => {
    const plan = compiledOf({
      passes: [
        effect("tint:p0", "dreamy1/tint1", "r1"),
        effect("blurA:p0", "dreamy1/inner1/blurA", "r2"),
      ],
      resources: [target("r1"), target("r2")],
      order: ["dreamy1/tint1", "dreamy1/inner1/blurA"],
      sources: [
        {
          nodeId: "dreamy1/tint1",
          path: ["dreamy1"],
          internalNodeId: "tint1",
          sourcePath: "Main / Dreamy_1 / Tint_1",
        },
        {
          nodeId: "dreamy1/inner1/blurA",
          path: ["dreamy1", "dreamy1/inner1"],
          internalNodeId: "blurA",
          sourcePath: "Main / Dreamy_1 / Inner_1 / Blur_A",
        },
      ],
    });
    const { hub } = hubWith(plan, { "tint:p0": 1, "blurA:p0": 4 });
    const info = buildNodeInfo({
      nodeId: "dreamy1",
      graph: graphOf([node("dreamy1", "component:dreamy@2")]),
      registry,
      compiled: plan,
      telemetry: hub,
    });

    render(<NodeInfoPopup info={info} />);

    expect(screen.getByText("own")).toBeTruthy();
    expect(screen.getByText("children")).toBeTruthy();
    expect(screen.getByText("total")).toBeTruthy();
    expect(screen.getByText("1.000 ms")).toBeTruthy();
    expect(screen.getByText("4.000 ms")).toBeTruthy();
    expect(screen.getByText("5.000 ms")).toBeTruthy();
    hub.dispose();
  });

  it("shows the flattened source path rather than the namespaced id (§V82)", () => {
    const plan = compiledOf({
      passes: [effect("p0", "dreamy1/blur2", "r0")],
      resources: [target("r0")],
      order: ["dreamy1/blur2"],
      sources: [
        {
          nodeId: "dreamy1/blur2",
          path: ["dreamy1"],
          internalNodeId: "blur2",
          sourcePath: "Main / Dreamy_1 / Blur_2",
        },
      ],
    });
    const { hub } = hubWith(plan);
    const info = buildNodeInfo({
      nodeId: "dreamy1/blur2",
      graph: graphOf([node("dreamy1/blur2", "test.blur")]),
      registry,
      compiled: plan,
      telemetry: hub,
    });
    render(<NodeInfoPopup info={info} />);
    expect(screen.getByText("Main / Dreamy_1 / Blur_2")).toBeTruthy();
    hub.dispose();
  });
});

describe("the performance tab (T41)", () => {
  const snapshot = (over: Partial<TelemetrySnapshot> = {}): TelemetrySnapshot => ({
    timingAvailable: true,
    plan: {
      readback: EMPTY_READBACK_BUDGET,
      passes: [{ id: "blur:p0", kind: "effect", nodeId: "blur", label: null }],
      sources: [],
      resourceCount: 3,
      estimatedResourceBytes: 2048,
      memoryBudgetBytes: 1024,
      nodeCount: 4,
      prunedCount: 1,
    },
    build: { resourcesCreated: 1, resourcesReused: 6, effectsBuilt: 2, effectsReused: 3 },
    readback: EMPTY_READBACK_BUDGET,
    framesRendered: 120,
    lastFrameIndex: 119,
    frame: { availability: "measured", gpuMs: 3.5, passCount: 1, nodeCount: 1 },
    passes: [
      {
        passId: "blur:p0",
        kind: "effect",
        nodeId: "blur",
        sourcePath: "Main / Blur_1",
        label: null,
        availability: "measured",
        gpuMs: 3.5,
      },
    ],
    overBudget: true,
    ...over,
  });

  it("shows plan counts, memory against the budget, and reuse accounting", () => {
    render(<PerformanceView snapshot={snapshot()} />);
    expect(screen.getAllByText("3.500 ms").length).toBeGreaterThan(0);
    expect(screen.getByText("120")).toBeTruthy();
    expect(screen.getByText("2.0 KiB")).toBeTruthy();
    expect(screen.getByText("1.0 KiB")).toBeTruthy();
    expect(screen.getByTestId("memory-budget-warning").textContent).toContain(
      "compiler/memory-budget",
    );
    expect(screen.getByText("6")).toBeTruthy();
  });

  it("names each pass by its source path (§V82)", () => {
    render(<PerformanceView snapshot={snapshot()} />);
    expect(screen.getByText("Main / Blur_1")).toBeTruthy();
  });

  it("reads unavailable on every row with no timestamp query (§V86)", () => {
    render(
      <PerformanceView
        snapshot={snapshot({
          timingAvailable: false,
          frame: { availability: "unavailable", gpuMs: null, passCount: 1, nodeCount: 1 },
          passes: [
            {
              passId: "blur:p0",
              kind: "effect",
              nodeId: "blur",
              sourcePath: null,
              label: null,
              availability: "unavailable",
              gpuMs: null,
            },
          ],
        })}
      />,
    );
    expect(screen.getAllByText("unavailable").length).toBeGreaterThanOrEqual(2);
    expect(screen.queryByText("0.000 ms")).toBeNull();
  });

  /**
   * T278 / §V185 — the readback budget is on the surface, the attribution one level down.
   *
   * The number that has to be READABLE WITHOUT A CLICK is the count: that is the one a user
   * acts on when the frame got slow. "Which node" is the follow-up question, so it lives in
   * a disclosure — §V90's rule, applied to the pane where numbers breed fastest.
   */
  const withReadback = (over: Partial<TelemetrySnapshot["readback"]> = {}) =>
    snapshot({
      readback: {
        count: 2,
        bytes: 32,
        incomplete: false,
        performed: 41,
        rows: [
          {
            nodeId: "meterA",
            sourcePath: "Main / Bloom_1 / meter1",
            reason: 'Analyze channel "meter1"',
            resourceId: "scratch:meterA:result",
            bytes: 16,
          },
          {
            nodeId: "meterB",
            sourcePath: null,
            reason: 'Analyze channel "meter2"',
            resourceId: "scratch:meterB:result",
            bytes: 16,
          },
        ],
        ...over,
      },
    });

  it("puts the per-frame readback count and bytes on the surface (§V185)", () => {
    render(<PerformanceView snapshot={withReadback()} />);
    const section = screen.getByLabelText("Readback");
    expect(section.textContent).toContain("per frame");
    expect(section.textContent).toContain("2");
    expect(section.textContent).toContain("32 B");
    // The observed counter beside the budget: what the graph asks for, and what happened.
    expect(section.textContent).toContain("41");
  });

  it("attributes each readback to a node, behind a disclosure (§V90, §V82)", () => {
    render(<PerformanceView snapshot={withReadback()} />);
    const section = screen.getByLabelText("Readback");
    const disclosure = section.querySelector("details");
    expect(disclosure).toBeTruthy();
    // Closed by default: the breakdown is available, not permanently in the way.
    expect((disclosure as HTMLDetailsElement).open).toBe(false);
    expect(section.textContent).toContain("Main / Bloom_1 / meter1");
    expect(section.textContent).toContain('Analyze channel "meter2"');
  });

  it("shows an unsizable row as unknown and the total as a floor, not as zero", () => {
    render(
      <PerformanceView
        snapshot={withReadback({
          bytes: 16,
          incomplete: true,
          rows: [
            {
              nodeId: "meterA",
              sourcePath: null,
              reason: 'Analyze channel "meter1"',
              resourceId: "scratch:meterA:result",
              bytes: 16,
            },
            {
              nodeId: "meterB",
              sourcePath: null,
              reason: 'Analyze channel "meter2"',
              resourceId: "scratch:meterB:result",
              bytes: null,
            },
          ],
        })}
      />,
    );
    const section = screen.getByLabelText("Readback");
    expect(section.textContent).toContain("≥ 16 B");
    expect(section.textContent).toContain("unknown");
  });

  it("names the state when a plan reads nothing back (§V91)", () => {
    render(
      <PerformanceView
        snapshot={snapshot({
          readback: { count: 0, bytes: 0, incomplete: false, rows: [], performed: 0 },
        })}
      />,
    );
    // Names the STATE, not the pane's purpose, and shows no zeroed table.
    expect(screen.getByLabelText("Readback").textContent).toContain("No readbacks in this plan");
    expect(screen.getByLabelText("Readback").querySelector("details")).toBeNull();
  });
});

describe("opening the popup", () => {
  function Harness({
    bus,
    children,
    fallbackNodeId,
  }: {
    bus: ShaderloomBus;
    children: ReactNode;
    fallbackNodeId?: string;
  }) {
    const plan = blurPlan();
    const { hub } = hubWith(plan, { "blur:p0": 2 });
    return (
      <NodeInfoHost
        bus={bus}
        registry={registry}
        compiled={plan}
        telemetry={hub}
        {...(fallbackNodeId === undefined ? {} : { fallbackNodeId })}
      >
        {children}
      </NodeInfoHost>
    );
  }

  /** Stands in for the canvas: React Flow's own DOM contract, which is what we resolve. */
  function FakeNode({ id }: { id: string }) {
    return (
      <div className="react-flow__node" data-id={id}>
        <span>node body</span>
      </div>
    );
  }

  async function seed(bus: ShaderloomBus): Promise<string> {
    const result = await bus.execute(
      "graph.applyPatch",
      {
        baseRevision: bus.store.getRevision(),
        label: "seed",
        operations: [{ op: "addNode", ref: "$blur", type: "test.blur", position: { x: 0, y: 0 } }],
      },
      contextFor(alice),
    );
    const id = result.output.createdIds["$blur"];
    if (id === undefined) throw new Error("fixture patch was rejected");
    return id;
  }

  it("opens from TouchDesigner's middle click", async () => {
    const { bus } = createHarness();
    const nodeId = await seed(bus);
    render(
      <Harness bus={bus}>
        <FakeNode id={nodeId} />
      </Harness>,
    );

    const body = screen.getByText("node body");
    middleClick(body);

    await waitFor(() => expect(screen.getByTestId("node-info")).toBeTruthy());
  });

  it("opens from the bus command — the keymap and menu route (§V52, §V78)", async () => {
    const { bus } = createHarness();
    const nodeId = await seed(bus);
    render(
      <Harness bus={bus}>
        <FakeNode id={nodeId} />
      </Harness>,
    );

    // A keybinding and a context-menu item both resolve to exactly this call. There is no
    // second code path to the popup, which is what makes "one surface" structural.
    const result = await bus.execute(SHOW_NODE_INFO_COMMAND, { nodeId }, contextFor(alice));
    expect(result.status).toBe("applied");
    await waitFor(() => expect(screen.getByTestId("node-info")).toBeTruthy());
  });

  it("falls back to the selected node when the command names none", async () => {
    const { bus } = createHarness();
    const nodeId = await seed(bus);
    render(
      <Harness bus={bus} fallbackNodeId={nodeId}>
        <FakeNode id={nodeId} />
      </Harness>,
    );

    const result = await bus.execute(SHOW_NODE_INFO_COMMAND, {}, contextFor(alice));
    expect(result.status).toBe("applied");
    await waitFor(() => expect(screen.getByTestId("node-info")).toBeTruthy());
  });

  it("refuses a node that is not in the graph, without opening anything", async () => {
    const { bus } = createHarness();
    await seed(bus);
    render(
      <Harness bus={bus}>
        <FakeNode id="whatever" />
      </Harness>,
    );

    const result = await bus.execute(
      SHOW_NODE_INFO_COMMAND,
      { nodeId: "not-a-node" },
      contextFor(alice),
    );
    expect(result.status).toBe("rejected");
    expect(screen.queryByTestId("node-info")).toBeNull();
  });

  it("§V19 — Escape closes it and focus returns where it was", async () => {
    const user = userEvent.setup();
    const { bus } = createHarness();
    const nodeId = await seed(bus);
    render(
      <Harness bus={bus} fallbackNodeId={nodeId}>
        <>
          <button type="button">before</button>
          <FakeNode id={nodeId} />
        </>
      </Harness>,
    );

    const before = screen.getByRole("button", { name: "before" });
    before.focus();
    expect(document.activeElement).toBe(before);

    await bus.execute(SHOW_NODE_INFO_COMMAND, {}, contextFor(alice));
    await waitFor(() => expect(screen.getByTestId("node-info")).toBeTruthy());

    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByTestId("node-info")).toBeNull());
    // Focus must come back: the popup is opened from a keypress, so leaving focus on the
    // body would strand a keyboard user at the top of the document.
    await waitFor(() => expect(document.activeElement).toBe(before));
  });

  it("names itself for a screen reader", async () => {
    const { bus } = createHarness();
    const nodeId = await seed(bus);
    render(
      <Harness bus={bus} fallbackNodeId={nodeId}>
        <FakeNode id={nodeId} />
      </Harness>,
    );
    await bus.execute(SHOW_NODE_INFO_COMMAND, {}, contextFor(alice));
    await waitFor(() => expect(screen.getByLabelText(/^Node info for /)).toBeTruthy());
  });

  it("§V16 — opening it and ticking metrics never touches the document", async () => {
    const { bus } = createHarness();
    const nodeId = await seed(bus);
    const before = bus.store.getRevision();
    const auditBefore = bus.store.getAudit().length;
    const nodeBefore = JSON.stringify(bus.store.getGraph().nodes[nodeId]);

    render(
      <Harness bus={bus} fallbackNodeId={nodeId}>
        <FakeNode id={nodeId} />
      </Harness>,
    );
    await bus.execute(SHOW_NODE_INFO_COMMAND, {}, contextFor(alice));
    await waitFor(() => expect(screen.getByTestId("node-info")).toBeTruthy());

    // Showing a per-frame metric must not bump the revision: a revision that moves at
    // frame rate makes undo history meaningless and serializes telemetry into the project.
    expect(bus.store.getRevision()).toBe(before);
    // The command IS audited (§V31) — it went through the bus — but it applied no patch.
    expect(bus.store.getAudit().length).toBeGreaterThanOrEqual(auditBefore);
    expect(JSON.stringify(bus.store.getGraph().nodes[nodeId])).toBe(nodeBefore);
  });

  it("does not open on a middle DRAG — that gesture belongs to panning", async () => {
    const { bus } = createHarness();
    const nodeId = await seed(bus);
    render(
      <Harness bus={bus}>
        <FakeNode id={nodeId} />
      </Harness>,
    );

    const body = screen.getByText("node body");
    dispatch(body, "pointerdown", 1, 10, 10);
    dispatch(body, "pointermove", 1, 300, 300);
    dispatch(body, "pointerup", 1, 300, 300);

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByTestId("node-info")).toBeNull();
  });
});

function dispatch(element: Element, type: string, button: number, x: number, y: number): void {
  const event = new MouseEvent(type, {
    button,
    clientX: x,
    clientY: y,
    bubbles: true,
    cancelable: true,
  });
  Object.defineProperty(event, "pointerId", { value: 1 });
  element.dispatchEvent(event);
}

function middleClick(element: Element): void {
  dispatch(element, "pointerdown", 1, 20, 20);
  dispatch(element, "pointerup", 1, 20, 20);
}
