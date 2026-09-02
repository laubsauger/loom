// @vitest-environment jsdom
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { installDomStubs } from "@ui/testing/install-dom-stubs.ts";
import { alice, contextFor, createHarness, patch } from "@domain/commands/test-support.ts";
import type { LoomBus } from "@domain/commands/bus.ts";
import { TOGGLE_REFERENCE_LINES_COMMAND } from "@editor/edges/reference-lines-command.ts";
import { GraphCanvas } from "./graph-canvas.tsx";
import { createNodeRuntimeStore } from "./node-runtime.ts";
import { installFlowStubs } from "./testing.tsx";

/**
 * Reference lines on the real canvas (T248, §V151, §V153).
 *
 * The owner's ask was "a connection line when there's a reference being used in an
 * expression or otherwise — dashed and straight, so it's clear who talks to whom". Each
 * half of that is a separate claim and each one is asserted here: that the line exists at
 * all, that it is straight and dashed rather than a second curved wire, and that it is a
 * PICTURE — not an edge anyone can select, delete or drop onto (§V151).
 */

beforeAll(() => {
  installDomStubs();
  installFlowStubs();
});
afterEach(cleanup);

const invocation = contextFor(alice);

async function apply(bus: LoomBus, operations: Parameters<typeof patch>[1], label?: string) {
  await act(async () => {
    await bus.execute("graph.applyPatch", patch(bus.store.getRevision(), operations, label), invocation);
  });
}

const expression = (source: string) => ({
  mode: "expression",
  bindings: { expression: { kind: "expression", source } },
});
const driven = (channel: string) => ({
  mode: "driven",
  bindings: { driven: { kind: "driven", channel } },
});

/** Two solids far apart, so any line between them has a real length to measure. */
async function mountWith(parameters: Record<string, unknown> | null) {
  const { bus } = createHarness("r");
  const runtime = createNodeRuntimeStore({ intervalMs: 0 });
  const seeded = await bus.execute(
    "graph.applyPatch",
    patch(bus.store.getRevision(), [
      { op: "addNode", ref: "$a", type: "test.solid", position: { x: 0, y: 0 } },
      { op: "addNode", ref: "$b", type: "test.solid", position: { x: 600, y: 0 } },
    ]),
    invocation,
  );
  const ids = {
    a: seeded.output.createdIds["$a"] as string,
    b: seeded.output.createdIds["$b"] as string,
  };
  if (parameters !== null) {
    await apply(bus, [{ op: "setParameters", nodeId: ids.b, parameters } as never]);
  }
  const view = render(<GraphCanvas bus={bus} invocation={invocation} runtime={runtime} />);
  return { ...view, bus, ids };
}

describe("reference lines are drawn from the parameters (§V151)", () => {
  it("draws a line for an op() reference in an expression", async () => {
    // `solid2.amount` reads `solid1`, and nothing wires the two together.
    const { container, ids } = await mountWith({ amount: expression("op('solid1').par.amount") });

    await waitFor(() => {
      expect(container.querySelector(`[data-testid="reference-line-${ids.a}-${ids.b}"]`)).not.toBeNull();
    });
  });

  it("draws a line for a DRIVEN channel too, which has no wire either", async () => {
    // The case the owner will notice most: an LFO or a Mouse moving a parameter with
    // nothing on screen connecting them.
    const { container, ids } = await mountWith({ amount: driven("solid1") });
    await waitFor(() => {
      const line = container.querySelector(`[data-testid="reference-line-${ids.a}-${ids.b}"]`);
      expect(line?.getAttribute("data-kind")).toBe("driven");
    });
  });

  it("draws it STRAIGHT and DASHED — never a second curved wire", async () => {
    const { container, ids } = await mountWith({ amount: expression("op('solid1').par.amount") });

    const group = await waitFor(() => {
      const found = container.querySelector(`[data-testid="reference-line-${ids.a}-${ids.b}"]`);
      if (found === null) throw new Error("no reference line");
      return found;
    });

    // STRAIGHT: an SVG <line>, which has no way of being curved, rather than a <path>
    // whose `d` the reader has to trust.
    const line = group.querySelector("line");
    expect(line).not.toBeNull();
    // DASHED, and the pattern has an actual gap in it: `6 5`, not `6 0`.
    const dash = (line?.getAttribute("stroke-dasharray") ?? "").split(" ").map(Number);
    expect(dash).toHaveLength(2);
    expect(dash[0]).toBeGreaterThan(0);
    expect(dash[1]).toBeGreaterThan(0);
  });

  it("names the parameters that caused it, so the line says WHY it is there", async () => {
    const { container, ids } = await mountWith({
      amount: expression("op('solid1').par.amount"),
      "color.r": expression("op('solid1').par.amount"),
    });

    await waitFor(() => {
      const group = container.querySelector(`[data-testid="reference-line-${ids.a}-${ids.b}"]`);
      // One line, both parameters — including a COMPONENT slot (§V113).
      expect(group?.getAttribute("data-parameters")).toBe("amount,color.r");
    });
  });

  it("draws nothing when no parameter reads anything", async () => {
    const { container } = await mountWith(null);
    await waitFor(() => {
      expect(container.querySelectorAll(".react-flow__node")).toHaveLength(2);
    });
    expect(container.querySelector('[data-testid="reference-lines"]')).toBeNull();
  });
});

describe("§V151 — a line is a VIEW, not an edge", () => {
  it("adds nothing to the edge layer, so it cannot be selected or deleted", async () => {
    const { container, bus } = await mountWith({ amount: expression("op('solid1').par.amount") });

    await waitFor(() => {
      expect(container.querySelector('[data-testid="reference-lines"]')).not.toBeNull();
    });
    // The document has no edge: the dependency lives in a PARAMETER, and storing it
    // would be two sources of truth for one fact.
    expect(Object.keys(bus.store.getGraph().edges)).toHaveLength(0);
    // Nor does React Flow's edge layer, which is what makes "not a drop target" and
    // "not deletable" structural rather than a promise — `onEdgesChange` never sees it.
    expect(container.querySelectorAll(".react-flow__edge")).toHaveLength(0);
  });

  it("takes no pointer events, so the node underneath keeps every gesture", async () => {
    const { container } = await mountWith({ amount: expression("op('solid1').par.amount") });
    const layer = await waitFor(() => {
      const found = container.querySelector('[data-testid="reference-lines"]');
      if (found === null) throw new Error("no layer");
      return found;
    });
    expect(getComputedStyle(layer).pointerEvents).toBe("none");
  });
});

describe("§V153 — the lines are toggleable", () => {
  it("hides and shows them through the command every route names", async () => {
    const { container, bus } = await mountWith({ amount: expression("op('solid1').par.amount") });
    await waitFor(() => {
      expect(container.querySelector('[data-testid="reference-lines"]')).not.toBeNull();
    });

    await act(async () => {
      const result = await bus.execute(TOGGLE_REFERENCE_LINES_COMMAND, {}, invocation);
      expect(result.output.shown).toBe(false);
    });
    // A dense network is unreadable with every relationship drawn — which is why TD
    // ships the toggle and why §V153 requires it.
    expect(container.querySelector('[data-testid="reference-lines"]')).toBeNull();

    await act(async () => {
      await bus.execute(TOGGLE_REFERENCE_LINES_COMMAND, { show: true }, invocation);
    });
    await waitFor(() => {
      expect(container.querySelector('[data-testid="reference-lines"]')).not.toBeNull();
    });
  });
});
