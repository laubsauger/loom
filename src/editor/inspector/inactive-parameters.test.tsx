// @vitest-environment jsdom
import { StrictMode } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { createDomainBus } from "@domain/commands/index.ts";
import { alice, contextFor } from "@domain/commands/test-support.ts";
import { createSequentialIdFactory } from "@domain/graph/ids.ts";
import { createGraphStore } from "@domain/graph/store.ts";
import type { NodeId } from "@domain/types/ids.ts";
import { noiseNode } from "@nodes/definitions/noise.ts";
import { createNodeRegistry } from "@nodes/registry/registry.ts";
import { installDomStubs } from "@ui/testing/install-dom-stubs.ts";
import { Inspector } from "./inspector.tsx";
import type { InspectorProjectSettings } from "./inspector.tsx";

/**
 * T245 / B14 / §V146 — a parameter that cannot affect the output reads INACTIVE.
 *
 * The reported symptom was "no way to actually play and animate anything". The engine
 * animates; Noise's default type is `perlin2d`, a 2D slice has no fourth dimension for
 * time to move along, and the shader discards `frameU.time * speed` entirely. So the
 * user adds a Noise, sees a Time Speed parameter sitting right there, sets it, presses
 * play, and gets a still frame — having done everything correctly. A live control that
 * does nothing is worse than a control that is not there, because it sends the user
 * looking for the fault in their own understanding.
 *
 * The test runs against the REAL noise manifest rather than a fixture, because the
 * predicate living beside the parameter it describes is half the point: an inspector-side
 * lookup table would pass a fixture test and still be the wrong design.
 */

beforeAll(installDomStubs);
afterEach(cleanup);

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
  const store = createGraphStore({ ids: createSequentialIdFactory("v146") });
  const { bus } = createDomainBus({ store, registry: createNodeRegistry([noiseNode]).view() });
  const created = await bus.execute(
    "graph.applyPatch",
    {
      baseRevision: 0,
      operations: [{ op: "addNode", ref: "$n", type: noiseNode.type, position: { x: 0, y: 0 } }],
    },
    context,
  );
  const nodeId = created.output.createdIds["$n"] as NodeId;

  render(
    <StrictMode>
      <Inspector bus={bus} context={context} nodeId={nodeId} settings={settings} />
    </StrictMode>,
  );

  return {
    bus,
    nodeId,
    stored: (key: string) => bus.store.getGraph().nodes[nodeId]?.parameters[key],
    inactiveRowCount: () => document.querySelectorAll("[data-inactive='true']").length,
  };
}

describe("§V146 — inactive parameters say so instead of being silently ignored", () => {
  it("dims Time Speed on the DEFAULT noise type, which is the state B14 was reported in", async () => {
    const harness = await setup();
    const titles = ["Time Speed", "Translate 4D", "Scale 4D"].map((label) =>
      screen.getByText(label).getAttribute("title"),
    );
    for (const title of titles) {
      expect(title).toContain("no fourth dimension");
    }
    expect(harness.inactiveRowCount()).toBe(3);
  });

  it("carries the reason on the LABEL, not as a separate element (§V90)", async () => {
    await setup();
    // The label is the only hover target: no `?` handle, no badge, no inline sentence.
    const label = screen.getByText("Time Speed");
    expect(label.getAttribute("title")).toContain("Perlin 4D");
    expect(screen.queryByRole("button", { name: /help|why|\?/i })).toBeNull();
  });

  it("leaves the control EDITABLE — inactive is not disabled", async () => {
    const harness = await setup();
    const field = screen.getByRole("spinbutton", { name: "Time Speed" });
    expect((field as HTMLInputElement).disabled).toBe(false);
    // Setting it before switching to a type that uses it is a normal way to work.
    fireEvent.keyDown(field, { key: "ArrowUp" });
    fireEvent.keyUp(field, { key: "ArrowUp" });
    await settle();
    await waitFor(() => expect(harness.stored("speed")).not.toBe(0));
  });

  it("stops dimming once the node is on a type with a fourth dimension", async () => {
    const harness = await setup();
    fireEvent.change(screen.getByLabelText("Type"), { target: { value: "perlin4d" } });
    await settle();

    await waitFor(() => expect(harness.stored("type")).toBe("perlin4d"));
    expect(harness.inactiveRowCount()).toBe(0);
    expect(screen.getByText("Time Speed").getAttribute("title")).not.toContain("fourth dimension");
  });
});
