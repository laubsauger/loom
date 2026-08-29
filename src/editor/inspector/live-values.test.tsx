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
 * B10 / T218 — live parameter values, asserted on the ASSEMBLED pane.
 *
 * Every part of this path already had a green suite of its own while the shipped app
 * did not do the thing: `drag-math` computes the values, `NumberField` emits one per
 * pointer move, `coalesce` batches them to a frame, `parameter-editor` sends them with
 * one transaction id. What none of those could see is the seam — the pane's ownership
 * of the editor. React may run an effect's CLEANUP and then mount the same component
 * again without re-rendering it (StrictMode's development double-mount does exactly
 * that, and so does a pane being re-docked), and the pane went on using an editor whose
 * coalescer had been disposed. A disposed coalescer silently drops `schedule`, which is
 * the live path and only the live path — commits send straight through. So the
 * measurement was: one value for the whole drag, the final value on release.
 *
 * These tests therefore mount the pane the way `main.tsx` mounts the app — inside
 * `StrictMode`, with the pane owning its own editor rather than being handed one — and
 * assert on what reaches the DOCUMENT during the gesture. That is the level the bug
 * lives at: no per-module test can fail for it, and this one fails for any future
 * change that severs the control from the store mid-gesture, whatever the reason.
 *
 * §V5 is the stake: the uniform-only update path only ever runs on values that arrive
 * DURING a drag. With them swallowed, the cheap path is unreachable from the UI.
 */

beforeAll(installDomStubs);
afterEach(cleanup);

const rgba = { kind: "texture2d", sample: "float", channels: 4 } as const;

const draggable: NodeDefinition = {
  type: "test.draggable",
  version: 1,
  title: "Draggable",
  category: "test",
  inputs: [],
  outputs: [{ id: "out", label: "Out", type: rgba }],
  resolutionPolicy: { kind: "project" },
  formatPolicy: { kind: "project" },
  parameters: {
    radius: { type: "number", label: "Radius", default: 4, min: 0, max: 200, step: 1 },
  },
  compile: () => ({ passes: [] }),
};

const settings: InspectorProjectSettings = {
  outputResolution: { width: 1920, height: 1080 },
  workingFormat: "rgba8unorm",
};

// Module scope: a context that changed identity per render would be a different bug.
const context = contextFor(alice);

/** Lets the coalescer's animation frame fire and its patch settle. */
async function frame(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 32));
  });
}

async function setup() {
  const store = createGraphStore({ ids: createSequentialIdFactory("live") });
  const { bus } = createDomainBus({ store, registry: createNodeRegistry([draggable]).view() });
  const created = await bus.execute(
    "graph.applyPatch",
    {
      baseRevision: 0,
      operations: [{ op: "addNode", ref: "$n", type: draggable.type, position: { x: 0, y: 0 } }],
    },
    context,
  );
  const nodeId = created.output.createdIds["$n"] as NodeId;

  // No `editor` prop: the pane owning its own editor is the code under test.
  render(
    <StrictMode>
      <Inspector bus={bus} context={context} nodeId={nodeId} settings={settings} />
    </StrictMode>,
  );

  const field = screen.getByRole("spinbutton", { name: "Radius" });
  return {
    bus,
    nodeId,
    field,
    surface: field.parentElement as HTMLElement,
    stored: () => bus.store.getGraph().nodes[nodeId]?.parameters["radius"],
  };
}

describe("B10 — the composed inspector applies values DURING a gesture (§V15, §V5)", () => {
  it("delivers a distinct value per frame of an 80px drag, not one value and a jump", async () => {
    const harness = await setup();
    const start = harness.stored();

    const duringDrag: unknown[] = [];
    fireEvent.pointerDown(harness.surface, { button: 0, pointerId: 1, clientX: 0 });
    for (let x = 10; x <= 80; x += 10) {
      fireEvent.pointerMove(harness.surface, { pointerId: 1, clientX: x });
      await frame();
      duringDrag.push(harness.stored());
    }

    // The measurement that named the bug: eight frames of a drag showed ONE value.
    expect(new Set(duringDrag).size).toBeGreaterThan(4);
    expect(duringDrag[0]).not.toBe(start);
    // Monotonic, because a rightward drag only ever increases the value: this also
    // catches values arriving out of order, which coalescing must never produce.
    for (let i = 1; i < duringDrag.length; i += 1) {
      expect(duringDrag[i] as number).toBeGreaterThan(duringDrag[i - 1] as number);
    }

    fireEvent.pointerUp(harness.surface, { pointerId: 1, clientX: 80 });
    await frame();
    expect(harness.stored()).toBe(44);
  });

  it("keeps the whole drag in one undo entry, landing back where it started (§V15)", async () => {
    const harness = await setup();
    const start = harness.stored();

    fireEvent.pointerDown(harness.surface, { button: 0, pointerId: 1, clientX: 0 });
    for (let x = 10; x <= 80; x += 10) {
      fireEvent.pointerMove(harness.surface, { pointerId: 1, clientX: x });
      await frame();
    }
    fireEvent.pointerUp(harness.surface, { pointerId: 1, clientX: 80 });
    await frame();
    expect(harness.stored()).toBe(44);

    await act(async () => {
      await harness.bus.execute("graph.undo", {}, context);
    });
    // One undo, not eight: every frame of the gesture shared one transaction id, so
    // the live values being applied did not cost the user their history.
    expect(harness.stored()).toBe(start);
  });

  it("applies a held arrow key's repeats live, and undoes the hold in one step", async () => {
    const harness = await setup();
    const start = harness.stored();

    const duringHold: unknown[] = [];
    for (let repeat = 0; repeat < 5; repeat += 1) {
      fireEvent.keyDown(harness.field, { key: "ArrowUp", repeat: repeat > 0 });
      await frame();
      duringHold.push(harness.stored());
    }
    expect(new Set(duringHold).size).toBe(5);
    expect(duringHold[0]).not.toBe(start);

    fireEvent.keyUp(harness.field, { key: "ArrowUp" });
    await frame();
    expect(harness.stored()).toBe(9);

    await act(async () => {
      await harness.bus.execute("graph.undo", {}, context);
    });
    expect(harness.stored()).toBe(start);
  });

  it("keeps working after a remount — the editor belongs to the mount, not to a memo", async () => {
    // StrictMode already remounts once at mount time; this drives a second one through
    // the same code path a re-dock takes, so the fix is not an artefact of the first.
    const harness = await setup();
    fireEvent.pointerDown(harness.surface, { button: 0, pointerId: 2, clientX: 0 });
    fireEvent.pointerMove(harness.surface, { pointerId: 2, clientX: 20 });
    await frame();
    expect(harness.stored()).not.toBe(4);
    fireEvent.pointerUp(harness.surface, { pointerId: 2, clientX: 20 });
    await frame();

    cleanup();

    render(
      <StrictMode>
        <Inspector bus={harness.bus} context={context} nodeId={harness.nodeId} settings={settings} />
      </StrictMode>,
    );
    const remounted = screen.getByRole("spinbutton", { name: "Radius" });
    const surface = remounted.parentElement as HTMLElement;
    const before = harness.stored();
    fireEvent.pointerDown(surface, { button: 0, pointerId: 3, clientX: 0 });
    fireEvent.pointerMove(surface, { pointerId: 3, clientX: 30 });
    await frame();
    expect(harness.stored()).not.toBe(before);
  });
});
