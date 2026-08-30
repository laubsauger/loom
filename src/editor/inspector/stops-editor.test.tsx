// @vitest-environment jsdom
import { StrictMode } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { createDomainBus } from "@domain/commands/index.ts";
import { alice, contextFor } from "@domain/commands/test-support.ts";
import { createSequentialIdFactory } from "@domain/graph/ids.ts";
import { createGraphStore } from "@domain/graph/store.ts";
import type { NodeId } from "@domain/types/ids.ts";
import type { NodeDefinition } from "@domain/types/node-definition.ts";
import type { ColorStop } from "@domain/types/parameters.ts";
import { createNodeRegistry } from "@nodes/registry/registry.ts";
import { installDomStubs } from "@ui/testing/install-dom-stubs.ts";
import { Inspector } from "./inspector.tsx";
import type { InspectorProjectSettings } from "./inspector.tsx";

/**
 * The stop editor on the assembled pane (T270, §V114, §V195).
 *
 * Mounted in StrictMode for B10's reason: the pane owns its parameter editor, and a
 * gesture that reaches the document has to survive React mounting the tree twice.
 *
 * What is asserted is the DOCUMENT, not the DOM: a gesture is one patch and one undo
 * entry, and "the button re-rendered" is not evidence of either.
 */

beforeAll(installDomStubs);
afterEach(cleanup);

const rgba = { kind: "texture2d", sample: "float", channels: 4 } as const;

const STOPS: readonly ColorStop[] = [
  { position: 0, color: [0, 0, 0, 1] },
  { position: 1, color: [1, 1, 1, 1] },
];

const gradient: NodeDefinition = {
  type: "test.gradient",
  version: 1,
  title: "Gradient",
  category: "test",
  inputs: [],
  outputs: [{ id: "out", label: "Out", type: rgba }],
  resolutionPolicy: { kind: "project" },
  formatPolicy: { kind: "project" },
  parameters: {
    stops: { type: "stops", label: "Stops", default: STOPS, space: "display", maxStops: 4 },
    amount: { type: "number", label: "Amount", default: 1 },
  },
  compile: () => ({ passes: [] }),
};

const settings: InspectorProjectSettings = {
  outputResolution: { width: 1920, height: 1080 },
  workingFormat: "rgba8unorm",
};

const context = contextFor(alice);

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 32));
  });
}

async function setup() {
  const store = createGraphStore({ ids: createSequentialIdFactory("g") });
  const { bus } = createDomainBus({ store, registry: createNodeRegistry([gradient]).view() });
  const created = await bus.execute(
    "graph.applyPatch",
    {
      baseRevision: 0,
      operations: [{ op: "addNode", ref: "$n", type: gradient.type, position: { x: 0, y: 0 } }],
    },
    context,
  );
  const nodeId = created.output.createdIds["$n"] as NodeId;

  render(
    <StrictMode>
      <Inspector bus={bus} context={context} nodeId={nodeId} settings={settings} />
    </StrictMode>,
  );

  const stops = (): readonly ColorStop[] =>
    (bus.store.getGraph().nodes[nodeId]?.parameters["stops"] ?? []) as readonly ColorStop[];
  return { bus, nodeId, stops };
}

const click = async (name: string | RegExp): Promise<void> => {
  fireEvent.click(screen.getByRole("button", { name }));
  await settle();
};

/**
 * T499 — the strip draws the ACTUAL gradient. Ticks on a dark ground said where the
 * stops were but not what the ramp looked like; the owner called it "only showing the
 * stops on black background". The bar's background is now the interpolated ramp, via
 * CSS's own color-stop rule — which matches the shader's exactly, hard edge on a
 * backwards segment included. Generality is free: StopsField is the ONE control every
 * stops-typed parameter renders, so a palette on any node draws its colours.
 */
describe("the strip draws the gradient (T499)", () => {
  it("paints the interpolated ramp behind the ticks, positions included", async () => {
    await setup();
    const bar = document.querySelector<HTMLElement>('[class*="stopsBar"]');
    expect(bar).not.toBeNull();
    const background = bar?.style.background ?? "";
    expect(background).toContain("linear-gradient(90deg");
    // Both authored stops appear, at their authored positions.
    expect(background).toContain("0%");
    expect(background).toContain("100%");
    // And the value is a COLOUR ramp, not tick markup: at least two colour entries.
    expect(background.match(/rgba?\(/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });
});

describe("the stop editor (T270)", () => {
  it("adds a stop between the two it sits between, in ONE patch (§V114)", async () => {
    const { bus, stops } = await setup();
    const before = bus.store.getRevision();

    await click("Add a stop after Stops stop 1");

    // One revision: adding a stop is one undo entry, not "insert" plus "renumber".
    expect(bus.store.getRevision()).toBe(before + 1);
    expect(stops()).toHaveLength(3);
    // Halfway, with the blend of its neighbours — you add a stop to subdivide a gradient
    // you already like, so the useful new stop is the one that changes nothing yet.
    expect(stops()[1]?.position).toBe(0.5);
    expect(stops()[1]?.color).toEqual([0.5, 0.5, 0.5, 1]);
  });

  it("removes a stop in one patch, and refuses to remove the last one", async () => {
    const { bus, stops } = await setup();

    await click("Remove Stops stop 1");
    expect(stops()).toHaveLength(1);

    // A gradient with no stops is not a gradient. One stop is a flat colour, which is
    // legal — so the floor is one, and the button says so by being disabled.
    expect(screen.getByRole("button", { name: "Remove Stops stop 1" })).toHaveProperty("disabled", true);
    void bus;
  });

  it("reorders by moving a stop, keeping the list the author wrote", async () => {
    const { bus, stops } = await setup();
    const before = bus.store.getRevision();

    await click("Move Stops stop 2 earlier");

    expect(bus.store.getRevision()).toBe(before + 1);
    // The white stop is now first — the ARRAY moved. Nothing re-sorted by position,
    // because the list order is the gradient (the shader walks consecutive pairs).
    expect(stops()[0]?.color).toEqual([1, 1, 1, 1]);
    expect(stops()[0]?.position).toBe(1);
  });

  it("stops offering `add` at the manifest's cap", async () => {
    const { stops } = await setup();

    await click("Add a stop after Stops stop 1");
    await click("Add a stop after Stops stop 1");
    expect(stops()).toHaveLength(4); // maxStops

    for (const index of [1, 2, 3, 4]) {
      expect(
        screen.getByRole("button", { name: `Add a stop after Stops stop ${index}` }),
      ).toHaveProperty("disabled", true);
    }
  });

  /**
   * §V195 — a CONTAINER parameter is static as a whole, so it gets no mode panel. Four
   * buttons that could only ever produce a diagnostic would be the interface lying about
   * what the model supports; the moded things are the leaves, and they wait on the key
   * grammar carrying an index.
   */
  it("offers no mode panel on the container, while a scalar beside it still has one", async () => {
    await setup();
    expect(screen.queryByRole("button", { name: "Stops", expanded: false })).toBeNull();
    expect(screen.getByRole("button", { name: "Amount", expanded: false })).toBeDefined();
  });
});
