// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { ReactNode } from "react";
import { alice, contextFor, createHarness } from "@domain/commands/test-support.ts";
import type { LoomBus } from "@domain/commands/bus.ts";
import type { PassDescriptor, ResourceDescriptor } from "@runtime/backend/plan.ts";
import type { ResolvedOutput } from "@compiler/index.ts";
import { EMPTY_READBACK_BUDGET } from "@runtime/telemetry/index.ts";
import type { TelemetrySnapshot } from "@runtime/telemetry/index.ts";
import { installDomStubs } from "@ui/testing/install-dom-stubs.ts";
import { KeymapProvider } from "@editor/keymap/index.ts";
import { registerPreviewViewCommands } from "@editor/viewer/index.ts";
import { SHOW_NODE_INFO_COMMAND } from "./command.ts";
import { buildNodeInfo } from "./node-info-model.ts";
import { NodeInfoHost } from "./node-info-host.tsx";
import { NodeInfoPopup } from "./node-info-popup.tsx";
import { PerformanceView } from "./performance-panel.tsx";
import { compiledOf, graphOf, hubWith, node, testRegistry } from "./test-support.ts";
import { allNodeDefinitions } from "@nodes/definitions/index.ts";
import { createNodeRegistry } from "@nodes/registry/registry.ts";

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

/**
 * T645 — §V329 REACHES A HUMAN, which is the half a classification alone does not give.
 *
 * The map and the render warning are both checkable without any UI, and both were built
 * that way. But §V329's first clause is about what someone SEES: "a node silently showing a
 * result from 400ms ago is the §V147 family again". These assert the popup actually renders
 * it — from a fixture, with no GPU, exactly as every other field here does (§V85).
 *
 * The age is on the TELEMETRY channel and not in the problems pane deliberately: it changes
 * every frame, and sixty pane entries a second is §V537's saturation with the volume up.
 */
describe("T645 — the node info popup shows §V329's staleness and classification", () => {
  const realRegistry = createNodeRegistry(allNodeDefinitions);

  const infoFor = (
    type: string,
    runtime?: Partial<{
      resultAgeFrames: number | null;
      inferenceBackend: string | null;
      inferenceMs: number | null;
    }>,
  ) =>
    buildNodeInfo({
      nodeId: "n1",
      graph: graphOf([node("n1", type, { label: type })]),
      registry: realRegistry,
      compiled: compiledOf(),
      runtime: {
        status: "valid",
        gpuMs: null,
        resultAgeFrames: null,
        inferenceBackend: null,
        inferenceMs: null,
        message: null,
        errorCount: 0,
        warningCount: 0,
        agent: null,
        preview: null,
        ...runtime,
      },
      telemetry: null,
    });

  it("shows an Analyze node's RESULT AGE, in frames, as the number it is", () => {
    render(<NodeInfoPopup info={infoFor("analyze", { resultAgeFrames: 7 })} />);
    expect(screen.getByText("result age")).toBeTruthy();
    // Named at the exact value: "behind" with no number would be the useless half.
    expect(screen.getByText("7 frames behind")).toBeTruthy();
    expect(screen.getByText("async-cached")).toBeTruthy();
  });

  it("says 'no result yet' rather than 0 for a readback that has not landed (§V86's rule)", () => {
    render(<NodeInfoPopup info={infoFor("analyze")} />);
    expect(screen.getByText("no result yet")).toBeTruthy();
    expect(screen.queryByText("0 frames behind")).toBeNull();
  });

  it("names a Webcam as a live device and says what would make it reproduce (§V403)", () => {
    render(<NodeInfoPopup info={infoFor("webcam")} />);
    expect(screen.getByText("external-live")).toBeTruthy();
    expect(screen.getByText(/record the input to a file and play that back locked to/)).toBeTruthy();
    // A live camera has no readback to be stale, so the age row must not appear at all.
    expect(screen.queryByText("result age")).toBeNull();
  });

  it("says NOTHING for a pure node — the half that keeps the badge worth reading", () => {
    // §V537/§V461: a badge on every node is a badge nobody sees. Blur is the ordinary case.
    render(<NodeInfoPopup info={infoFor("blur")} />);
    expect(screen.queryByText("result age")).toBeNull();
    expect(screen.queryByText("pure")).toBeNull();
    expect(screen.queryByText("external-live")).toBeNull();
    expect(screen.queryByText("async-cached")).toBeNull();
  });
});

describe("the performance tab (T41)", () => {
  const snapshot = (over: Partial<TelemetrySnapshot> = {}): TelemetrySnapshot => ({
    timingAvailable: true,
    plan: {
      categories: new Map([["blur", "filter"]]),
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
    cpuTimingAvailable: false,
    nodes: [],
    categories: [],
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

  /**
   * T256 / §V86 — CPU and GPU on the same row, and an absent half is a WORD.
   *
   * The failure this guards is specific: a zero in the gpu column reads as "free", and the
   * device that produces it (no `timestamp-query`) is the one where a build otherwise looks
   * entirely healthy. Someone then optimises the node above the zero.
   */
  const withCost = (over: Partial<TelemetrySnapshot> = {}) =>
    snapshot({
      cpuTimingAvailable: true,
      nodes: [
        {
          nodeId: "blur1",
          sourcePath: "Main / Bloom_1 / blur1",
          label: "blur1",
          category: "filter",
          passCount: 2,
          cpu: { availability: "measured", ms: 0.5 },
          gpu: { availability: "measured", ms: 5 },
        },
        {
          nodeId: "noise1",
          sourcePath: null,
          label: "noise1",
          category: "generator",
          passCount: 1,
          cpu: { availability: "pending", ms: null },
          gpu: { availability: "measured", ms: 1 },
        },
      ],
      categories: [
        {
          category: "filter",
          nodeCount: 1,
          passCount: 2,
          cpu: { availability: "measured", ms: 0.5 },
          gpu: { availability: "measured", ms: 5 },
        },
        {
          category: "generator",
          nodeCount: 1,
          passCount: 1,
          cpu: { availability: "pending", ms: null },
          gpu: { availability: "measured", ms: 1 },
        },
      ],
      ...over,
    });

  it("puts the CATEGORY rollup on the surface and the node rows behind a disclosure", () => {
    render(<PerformanceView snapshot={withCost()} />);
    const section = screen.getByLabelText("Cost");
    expect(section.textContent).toContain("filter");
    expect(section.textContent).toContain("generator");
    expect(section.textContent).toContain("5.000 ms");
    const disclosure = section.querySelector("details");
    expect((disclosure as HTMLDetailsElement).open).toBe(false);
    expect(section.textContent).toContain("Main / Bloom_1 / blur1");
  });

  it("shows both halves of a row and never fabricates the missing one (§V86)", () => {
    render(<PerformanceView snapshot={withCost()} />);
    const section = screen.getByLabelText("Cost");
    // noise1's CPU half has no span yet. The cell says so; it does not say 0.000 ms.
    expect(section.textContent).toContain("measuring…");
    expect(section.textContent).not.toContain("0.000 ms");
  });

  it("names the state rather than tabulating 'unavailable' when nothing measures", () => {
    render(
      <PerformanceView snapshot={withCost({ timingAvailable: false, cpuTimingAvailable: false })} />,
    );
    const section = screen.getByLabelText("Cost");
    // §V91 + §V90: a table of N identical "unavailable" cells is the same sentence N times.
    expect(section.querySelector("table")).toBeNull();
    expect(section.textContent).toContain("No timing on this device");
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
    bus: LoomBus;
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

  async function seed(bus: LoomBus): Promise<string> {
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

/**
 * T336 — the preview LENS controls.
 *
 * Placement is the decision under test as much as behaviour. §V90/§V91/§V92 rule out a row of
 * channel buttons living permanently on every node body, so these live inside the popup: one
 * gesture away, scoped to one node, and gone the moment it closes. The first two tests pin the
 * two ways the section must NOT appear, because a control that cannot act is the thing the
 * owner has objected to twice.
 */
describe("the preview lens (T336)", () => {
  const lensInfo = (overrides: Parameters<typeof buildNodeInfo>[0] | null = null) =>
    buildNodeInfo(
      overrides ?? {
        nodeId: "blur",
        graph: graphOf([node("blur", "test.blur")]),
        registry,
        compiled: blurPlan(),
      },
    );

  it("is absent when the caller offers no way to apply one", () => {
    render(<NodeInfoPopup info={lensInfo()} />);
    expect(screen.queryByLabelText("Preview lens")).toBeNull();
  });

  it("is absent on a node that materializes no texture — there is no preview to filter", () => {
    const info = buildNodeInfo({
      nodeId: "blur",
      graph: graphOf([node("blur", "test.blur")]),
      registry,
      compiled: compiledOf(),
    });
    render(<NodeInfoPopup info={info} onLens={() => {}} />);
    expect(screen.queryByLabelText("Preview lens")).toBeNull();
  });

  it("offers every lens, and says which one is on (§V19)", () => {
    render(
      <NodeInfoPopup
        info={lensInfo()}
        lens={{ lens: "g", exposureStops: 0, tonemap: false }}
        onLens={() => {}}
      />,
    );
    const group = screen.getByRole("group", { name: "Channel" });
    expect([...group.querySelectorAll("button")].map((button) => button.textContent)).toEqual([
      "RGB",
      "R",
      "G",
      "B",
      "A",
      "LUM",
    ]);
    expect(screen.getByRole("button", { name: "G" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "RGB" }).getAttribute("aria-pressed")).toBe("false");
  });

  it("reports one field at a time, so picking a channel does not clear the exposure", async () => {
    const calls: unknown[] = [];
    render(
      <NodeInfoPopup
        info={lensInfo()}
        lens={{ lens: "rgb", exposureStops: 2, tonemap: false }}
        onLens={(patch) => calls.push(patch)}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "A" }));
    expect(calls).toEqual([{ lens: "a" }]);
  });

  it("steps exposure in stops, from whatever it currently is", async () => {
    const calls: unknown[] = [];
    render(
      <NodeInfoPopup
        info={lensInfo()}
        lens={{ lens: "rgb", exposureStops: -1, tonemap: false }}
        onLens={(patch) => calls.push(patch)}
      />,
    );
    expect(screen.getByTestId("lens-exposure").textContent).toBe("-1 EV");
    await userEvent.click(screen.getByRole("button", { name: "Exposure up one stop" }));
    expect(calls).toEqual([{ exposureStops: 0 }]);
  });

  it("toggles the tonemap rather than setting it", async () => {
    const calls: unknown[] = [];
    render(
      <NodeInfoPopup
        info={lensInfo()}
        lens={{ lens: "rgb", exposureStops: 0, tonemap: true }}
        onLens={(patch) => calls.push(patch)}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "tonemap" }));
    expect(calls).toEqual([{ tonemap: false }]);
  });

  it("offers reset only once there is something to reset (§V90)", async () => {
    const { unmount } = render(
      <NodeInfoPopup
        info={lensInfo()}
        lens={{ lens: "rgb", exposureStops: 0, tonemap: false }}
        onLens={() => {}}
        onLensReset={() => {}}
      />,
    );
    expect(screen.queryByRole("button", { name: "reset" })).toBeNull();
    unmount();

    let reset = 0;
    render(
      <NodeInfoPopup
        info={lensInfo()}
        lens={{ lens: "b", exposureStops: 0, tonemap: false }}
        onLens={() => {}}
        onLensReset={() => {
          reset += 1;
        }}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "reset" }));
    expect(reset).toBe(1);
  });
});

/**
 * T336 — the popup's buttons reach the bus, and the bus reaches the store.
 *
 * The §V220 half. Every test above renders `NodeInfoPopup` with a callback and would stay
 * green if the host never wired one — which is precisely the shape that has failed fourteen
 * times here. So this drives the mounted host through the same command a keybinding or an
 * agent would name (§V78) and asserts the lens the preview tick will read.
 */
describe("the lens controls are wired to the command (T336)", () => {
  it("a click in the popup sets the lens the preview system reads", async () => {
    const { bus } = createHarness();
    const store = registerPreviewViewCommands(bus);

    const added = await bus.execute(
      "graph.applyPatch",
      {
        baseRevision: bus.store.getRevision(),
        label: "seed",
        operations: [{ op: "addNode", ref: "$blur", type: "test.blur", position: { x: 0, y: 0 } }],
      },
      contextFor(alice),
    );
    const nodeId = added.output.createdIds["$blur"];
    if (nodeId === undefined) throw new Error("fixture patch was rejected");

    const plan = compiledOf({
      passes: [effect(`${nodeId}:p0`, nodeId, `${nodeId}:out`)],
      resources: [target(`${nodeId}:out`)],
      order: [nodeId],
      outputs: [resolved(nodeId, `${nodeId}:out`)],
    });

    render(
      <KeymapProvider bus={bus} invocationContext={contextFor(alice)}>
        <NodeInfoHost bus={bus} registry={registry} compiled={plan} fallbackNodeId={nodeId}>
          <div className="react-flow__node" data-id={nodeId} />
        </NodeInfoHost>
      </KeymapProvider>,
    );

    await bus.execute(SHOW_NODE_INFO_COMMAND, { nodeId }, contextFor(alice));
    await waitFor(() => expect(screen.getByLabelText("Preview lens")).toBeTruthy());

    await userEvent.click(screen.getByRole("button", { name: "G" }));
    await waitFor(() => expect(store.get(nodeId).lens).toBe("g"));
    // The lens is a look, not an edit: it went through the bus and left no patch behind.
    expect(bus.store.getRevision()).toBe(added.revision);

    await userEvent.click(screen.getByRole("button", { name: "reset" }));
    await waitFor(() => expect(store.isDefault(nodeId)).toBe(true));
  });

  it("shows no lens controls when no command is registered to serve them (§V90)", async () => {
    // A different bus, deliberately: nothing registered `preview.setView` on it, so the
    // section must not render rather than render buttons that do nothing.
    const { bus } = createHarness("unregistered");
    const added = await bus.execute(
      "graph.applyPatch",
      {
        baseRevision: bus.store.getRevision(),
        label: "seed",
        operations: [{ op: "addNode", ref: "$blur", type: "test.blur", position: { x: 0, y: 0 } }],
      },
      contextFor(alice),
    );
    const nodeId = added.output.createdIds["$blur"];
    if (nodeId === undefined) throw new Error("fixture patch was rejected");
    const plan = compiledOf({
      passes: [effect(`${nodeId}:p0`, nodeId, `${nodeId}:out`)],
      resources: [target(`${nodeId}:out`)],
      order: [nodeId],
      outputs: [resolved(nodeId, `${nodeId}:out`)],
    });

    render(
      <KeymapProvider bus={bus} invocationContext={contextFor(alice)}>
        <NodeInfoHost bus={bus} registry={registry} compiled={plan} fallbackNodeId={nodeId}>
          <div className="react-flow__node" data-id={nodeId} />
        </NodeInfoHost>
      </KeymapProvider>,
    );

    await bus.execute(SHOW_NODE_INFO_COMMAND, { nodeId }, contextFor(alice));
    await waitFor(() => expect(screen.getByTestId("node-info")).toBeTruthy());
    expect(screen.queryByLabelText("Preview lens")).toBeNull();
  });
});
