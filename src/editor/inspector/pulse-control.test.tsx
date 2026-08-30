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
import { createNodeRegistry } from "@nodes/registry/registry.ts";
import { installDomStubs } from "@ui/testing/install-dom-stubs.ts";
import { Inspector } from "./inspector.tsx";
import type { InspectorProjectSettings } from "./inspector.tsx";

/**
 * Pulse, on the ASSEMBLED pane, mounted the way `main.tsx` mounts it (T214, B10).
 *
 * B10 is the reason the `<StrictMode>` wrapper is not optional here: an editor built in a
 * memo and disposed in an effect cleanup passed every unit test and was permanently dead
 * in the app, because React ran the cleanup while the memo cell survived. A pulse goes
 * through that same editor. So the assertion runs from a real click, through the pane's
 * own editor, through the bus, to the command that actually fired.
 */

beforeAll(installDomStubs);
afterEach(cleanup);

declare module "@domain/types/commands.ts" {
  interface CommandMap {
    "test.clearHistory": { input: { nodeIds?: readonly string[] }; output: { cleared: number } };
  }
}

const rgba = { kind: "texture2d", sample: "float", channels: 4 } as const;

const pulsing: NodeDefinition = {
  type: "test.pulsing",
  version: 1,
  title: "Pulsing",
  category: "test",
  inputs: [],
  outputs: [{ id: "out", label: "Out", type: rgba }],
  resolutionPolicy: { kind: "project" },
  formatPolicy: { kind: "project" },
  parameters: {
    // TD pairs a hold toggle with a momentary fire on Feedback; the pane must render
    // both, and they must not be the same control.
    reset: { type: "boolean", label: "Reset", default: false },
    resetPulse: {
      type: "pulse",
      label: "Reset Pulse",
      fires: "test.clearHistory",
      input: { nodeIds: ["$node"] },
    },
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
  const store = createGraphStore({ ids: createSequentialIdFactory("pulse") });
  const { bus } = createDomainBus({ store, registry: createNodeRegistry([pulsing]).view() });
  const fired: Array<{ nodeIds?: readonly string[] }> = [];
  bus.registerCommand({
    name: "test.clearHistory",
    handler: (input) => {
      fired.push(input);
      return { status: "applied", output: { cleared: 1 } };
    },
  });

  const created = await bus.execute(
    "graph.applyPatch",
    {
      baseRevision: 0,
      operations: [{ op: "addNode", ref: "$n", type: pulsing.type, position: { x: 0, y: 0 } }],
    },
    context,
  );
  const nodeId = created.output.createdIds["$n"] as NodeId;

  render(
    <StrictMode>
      <Inspector bus={bus} context={context} nodeId={nodeId} settings={settings} />
    </StrictMode>,
  );

  return { bus, nodeId, fired };
}

describe("a pulse in the inspector (§V123, §V124)", () => {
  it("fires the command its manifest names, from a click on the pane", async () => {
    const { fired, nodeId } = await setup();

    fireEvent.click(screen.getByRole("button", { name: "Fire Reset Pulse" }));
    await settle();

    expect(fired).toEqual([{ nodeIds: [nodeId] }]);
  });

  it("writes NOTHING to the document (§V124)", async () => {
    const { bus, nodeId } = await setup();
    const revisionBefore = bus.store.getRevision();

    fireEvent.click(screen.getByRole("button", { name: "Fire Reset Pulse" }));
    await settle();

    expect(bus.store.getRevision()).toBe(revisionBefore);
    // Not even a disarmed `false`: a pulse is absent from the bag entirely.
    expect(Object.keys(bus.store.getGraph().nodes[nodeId]?.parameters ?? {})).toEqual(["reset"]);
    expect(bus.store.getHistory(alice).undo).toHaveLength(1); // the addNode, and only it
  });

  it("is audited, so the reset is traceable even though it is not undoable (§V31)", async () => {
    const { bus } = await setup();

    fireEvent.click(screen.getByRole("button", { name: "Fire Reset Pulse" }));
    await settle();

    const commands = bus.store.getAudit().map((entry) => entry.command);
    expect(commands).toContain("parameter.pulse");
  });

  it("renders the hold toggle and the momentary fire as two different controls", async () => {
    await setup();
    // The toggle announces state; the pulse does not have one to announce.
    expect(screen.getByRole("switch", { name: "Reset" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Fire Reset Pulse" })).toBeDefined();
  });

  it("fires once per click, not once per render", async () => {
    const { fired } = await setup();
    const button = screen.getByRole("button", { name: "Fire Reset Pulse" });

    fireEvent.click(button);
    await settle();
    fireEvent.click(button);
    await settle();

    expect(fired).toHaveLength(2);
  });
});
