// @vitest-environment jsdom
import { StrictMode } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { createDomainBus } from "@domain/commands/index.ts";
import { alice, contextFor } from "@domain/commands/test-support.ts";
import { createSequentialIdFactory } from "@domain/graph/ids.ts";
import { createGraphStore } from "@domain/graph/store.ts";
import { isParameterSlot } from "@domain/parameters/slots.ts";
import type { NodeId } from "@domain/types/ids.ts";
import type { NodeDefinition } from "@domain/types/node-definition.ts";
import type { ParameterSlot } from "@domain/types/parameters.ts";
import { createNodeRegistry } from "@nodes/registry/registry.ts";
import { installDomStubs } from "@ui/testing/install-dom-stubs.ts";
import { Inspector } from "./inspector.tsx";
import type { InspectorProjectSettings } from "./inspector.tsx";
import { resolveParameters } from "./parameter-resolver.ts";

/**
 * T204 / T207 — parameter modes, asserted on the ASSEMBLED pane.
 *
 * The first version of the mode buttons passed every test it had and did nothing in the
 * app. `validateStoredParameter` refuses an empty expression, an empty bind ref and an
 * empty channel at write time, so a button that seeded one produced a patch the bus
 * rejected: the click dispatched, the store never changed, and the button looked inert.
 * That is the same shape as B10 — correct parts, broken composition — so the assertions
 * here go all the way to the DOCUMENT and back out through the resolver, which is what
 * the shader would read (§V109).
 */

beforeAll(installDomStubs);
afterEach(cleanup);

const rgba = { kind: "texture2d", sample: "float", channels: 4 } as const;

const moded: NodeDefinition = {
  type: "test.moded",
  version: 1,
  title: "Moded",
  category: "test",
  inputs: [],
  outputs: [{ id: "out", label: "Out", type: rgba }],
  resolutionPolicy: { kind: "project" },
  formatPolicy: { kind: "project" },
  parameters: {
    // -180..180 exercises the fill's "from the range minimum" rule as well.
    rotate: { type: "number", label: "Rotate", default: 0, min: -180, max: 180, unit: "degrees" },
    amount: { type: "number", label: "Amount", default: 2, min: 0, max: 10 },
    enabled: { type: "boolean", label: "Enabled", default: false },
    tint: { type: "color", label: "Tint", default: [1, 1, 1, 1], space: "display" },
    offset: { type: "vector", label: "Offset", size: 2, default: [0, 0] },
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
  const store = createGraphStore({ ids: createSequentialIdFactory("mode") });
  const { bus } = createDomainBus({ store, registry: createNodeRegistry([moded]).view() });
  const created = await bus.execute(
    "graph.applyPatch",
    {
      baseRevision: 0,
      operations: [{ op: "addNode", ref: "$n", type: moded.type, position: { x: 0, y: 0 } }],
    },
    context,
  );
  const nodeId = created.output.createdIds["$n"] as NodeId;

  render(
    <StrictMode>
      <Inspector bus={bus} context={context} nodeId={nodeId} settings={settings} />
    </StrictMode>,
  );

  const node = () => bus.store.getGraph().nodes[nodeId];
  return {
    bus,
    nodeId,
    node,
    stored: (key: string) => node()?.parameters[key],
    slot: (key: string): ParameterSlot | undefined => {
      const value = node()?.parameters[key];
      return isParameterSlot(value) ? value : undefined;
    },
    /** What the compiler and the shader would actually read (§V61, §V109). */
    effective: (key: string) => {
      const current = node();
      if (current === undefined) return undefined;
      return resolveParameters(current, moded).values[key];
    },
    /** Opens the mode panel the way a user does: by clicking the parameter NAME. */
    async expand(label: string) {
      fireEvent.click(screen.getByRole("button", { name: label, expanded: false }));
      await settle();
    },
  };
}

const modeButton = (group: HTMLElement, name: RegExp) =>
  within(group).getByRole("button", { name });

describe("T204 — the mode panel changes the document (§V107, §V108)", () => {
  it("opens from the parameter name and offers every mode on a number", async () => {
    const harness = await setup();
    await harness.expand("Rotate");
    const group = screen.getByRole("group", { name: "Rotate mode" });
    for (const name of [/^Constant/, /^Expression/, /^Bind/, /^Driven/]) {
      expect(modeButton(group, name)).toBeDefined();
    }
  });

  it("offers modes on a BOOLEAN too — every type takes every mode (§V107)", async () => {
    const harness = await setup();
    await harness.expand("Enabled");
    const group = screen.getByRole("group", { name: "Enabled mode" });
    expect(modeButton(group, /^Expression/)).toBeDefined();
  });

  it("writes a slot the bus ACCEPTS when Expression is chosen — not a rejected patch", async () => {
    const harness = await setup();
    await harness.expand("Amount");
    fireEvent.click(modeButton(screen.getByRole("group", { name: "Amount mode" }), /^Expression/));
    await settle();

    const slot = harness.slot("amount");
    expect(slot?.mode).toBe("expression");
    // Seeded from the value on screen, so the parameter does not jump to zero the
    // instant the user switches mode — and, crucially, so the payload PARSES: an empty
    // expression is refused at write time and the click would have done nothing.
    expect(slot?.bindings.expression).toEqual({ kind: "expression", source: "2" });
    expect(harness.effective("amount")).toBe(2);
  });

  it("an authored expression reaches the value the shader reads (§V109)", async () => {
    const harness = await setup();
    await harness.expand("Amount");
    fireEvent.click(modeButton(screen.getByRole("group", { name: "Amount mode" }), /^Expression/));
    await settle();

    const field = screen.getByLabelText("Amount expression");
    fireEvent.change(field, { target: { value: "1 + 2" } });
    fireEvent.keyDown(field, { key: "Enter" });
    await settle();

    await waitFor(() => expect(harness.effective("amount")).toBe(3));
  });

  it("refuses to store an expression that does not parse, and says why", async () => {
    const harness = await setup();
    await harness.expand("Amount");
    fireEvent.click(modeButton(screen.getByRole("group", { name: "Amount mode" }), /^Expression/));
    await settle();

    const field = screen.getByLabelText("Amount expression");
    fireEvent.change(field, { target: { value: "1 +" } });
    fireEvent.keyDown(field, { key: "Enter" });
    await settle();

    expect(harness.slot("amount")?.bindings.expression).toEqual({ kind: "expression", source: "2" });
    expect(screen.getByRole("status").textContent).toBeTruthy();
  });

  it("keeps the expression when the user flips back to Constant, and MARKS it (§V108)", async () => {
    const harness = await setup();
    await harness.expand("Amount");
    const group = () => screen.getByRole("group", { name: "Amount mode" });

    fireEvent.click(modeButton(group(), /^Expression/));
    await settle();
    const field = screen.getByLabelText("Amount expression");
    fireEvent.change(field, { target: { value: "1 + 2" } });
    fireEvent.keyDown(field, { key: "Enter" });
    await settle();

    fireEvent.click(modeButton(group(), /^Constant/));
    await settle();

    const slot = harness.slot("amount");
    expect(slot?.mode).toBe("static");
    // The whole promise of the corner mark: the expression is still there.
    expect(slot?.bindings.expression).toEqual({ kind: "expression", source: "1 + 2" });
    // And the button SAYS so — the mark is in the accessible name, not only in pixels.
    expect(modeButton(group(), /^Expression, holds a value/)).toBeDefined();
    expect(() => modeButton(group(), /^Bind, holds a value/)).toThrow();
  });

  it("holds a Bind choice until a ref exists rather than storing a bind to nothing", async () => {
    const harness = await setup();
    await harness.expand("Amount");
    fireEvent.click(modeButton(screen.getByRole("group", { name: "Amount mode" }), /^Bind/));
    await settle();

    // Nothing written yet: an empty ref is refused at write time, so writing one would
    // have been a bounced patch and an inert button.
    expect(harness.slot("amount")).toBeUndefined();

    const field = screen.getByLabelText("Amount bound to");
    fireEvent.change(field, { target: { value: "rotate" } });
    fireEvent.keyDown(field, { key: "Enter" });
    await settle();

    await waitFor(() => expect(harness.slot("amount")?.mode).toBe("bind"));
    expect(harness.slot("amount")?.bindings.bind).toEqual({ kind: "bind", ref: "rotate" });
  });

  it("ctrl/cmd+E goes straight to the expression (TD parity)", async () => {
    const harness = await setup();
    fireEvent.keyDown(screen.getByRole("spinbutton", { name: "Amount" }), { key: "e", metaKey: true });
    await settle();
    expect(harness.slot("amount")?.mode).toBe("expression");
    expect(screen.getByLabelText("Amount expression")).toBeDefined();
  });
});

describe("T207 — compound parameters are component-addressable (§V113, §V114)", () => {
  it("gives every channel of a colour its own mode panel", async () => {
    const harness = await setup();
    await harness.expand("Tint");
    for (const channel of ["r", "g", "b", "a"]) {
      expect(screen.getByRole("group", { name: `Tint.${channel} mode` })).toBeDefined();
    }
  });

  it("gives every axis of a vector its own mode panel", async () => {
    const harness = await setup();
    await harness.expand("Offset");
    expect(screen.getByRole("group", { name: "Offset.x mode" })).toBeDefined();
    expect(screen.getByRole("group", { name: "Offset.y mode" })).toBeDefined();
  });

  it("drives ONE channel from an expression and leaves its siblings alone", async () => {
    const harness = await setup();
    await harness.expand("Tint");
    fireEvent.click(modeButton(screen.getByRole("group", { name: "Tint.g mode" }), /^Expression/));
    await settle();

    const field = screen.getByLabelText("Tint.g expression");
    fireEvent.change(field, { target: { value: "0.25" } });
    fireEvent.keyDown(field, { key: "Enter" });
    await settle();

    await waitFor(() => {
      const tint = harness.effective("tint") as readonly number[];
      // Green is the expression's; red, blue and alpha are still the manifest default.
      expect(tint[1]).toBeCloseTo(0.0508, 3); // 0.25 display → linear (§V56)
      expect(tint[0]).toBe(1);
      expect(tint[2]).toBe(1);
      expect(tint[3]).toBe(1);
    });
    expect(harness.slot("tint.g")?.mode).toBe("expression");
    expect(harness.stored("tint.r")).toBeUndefined();
  });

  it("writes every channel in ONE patch — a compound edit is one undo entry (§V114)", async () => {
    const harness = await setup();
    // Give one channel a slot: that is what forces the write to address components,
    // because the bare key no longer decides that channel.
    await harness.expand("Offset");
    fireEvent.click(modeButton(screen.getByRole("group", { name: "Offset.y mode" }), /^Expression/));
    await settle();
    const beforeRevision = harness.bus.store.getRevision();

    // Nudge x. The vector field reports the WHOLE vector, so this is the compound edit.
    fireEvent.keyDown(screen.getByRole("spinbutton", { name: "Offset x" }), { key: "ArrowUp" });
    fireEvent.keyUp(screen.getByRole("spinbutton", { name: "Offset x" }), { key: "ArrowUp" });
    await settle();

    // One revision, therefore one patch and one undo group (§V32, §V34) — not two.
    expect(harness.bus.store.getRevision()).toBe(beforeRevision + 1);
    expect(harness.stored("offset.x")).toBeDefined();
    expect(harness.stored("offset.y")).toBeDefined();
    const moved = harness.effective("offset") as readonly number[];
    expect(moved[0]).not.toBe(0);

    await act(async () => {
      await harness.bus.execute("graph.undo", {}, context);
    });
    const undone = harness.effective("offset") as readonly number[];
    expect(undone[0]).toBe(0);
  });
});
