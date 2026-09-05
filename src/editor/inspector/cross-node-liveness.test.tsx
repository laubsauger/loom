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
import type { StoredParameter } from "@domain/types/parameters.ts";
import { createNodeRegistry } from "@nodes/registry/registry.ts";
import { installDomStubs } from "@ui/testing/install-dom-stubs.ts";
import { Inspector } from "./inspector.tsx";
import type { InspectorProjectSettings } from "./inspector.tsx";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════
 * T1177 — A ROW'S MEMO MAY NOT OUTLIVE THE *OTHER* NODE IT IS READING (§V935)
 * ═══════════════════════════════════════════════════════════════════════════════════
 *
 * `ParameterControl` is a `React.memo` since T1177, and the survey that asked for it said
 * the inspector should "resolve on its own node's revision, not the whole graph's". THAT
 * PREMISE IS FALSE, AND THIS FILE IS WHY. E55's `haze1` carries twenty parameters that read
 * `op('reactor1').par.<key>`: turn a knob on `reactor1` and every one of `haze1`'s twenty
 * displayed values moves while `haze1`'s own node object is not touched at all. A memo keyed
 * on the inspected node — its revision, its identity, anything local to it — freezes all
 * twenty and reports nothing. §V935's second question ("can the value change while the key
 * does not?") answers yes here, loudly, on a shipped example.
 *
 * So the boundary compares the RESOLVED VALUES themselves (`ui/controls/props-equal.ts`),
 * which is a claim that cannot go stale because it caches nothing. What this file gates is
 * that the claim is true through the whole assembled pane, on the three shapes the resolver
 * mints FRESH on every read and identity alone would therefore never bail out on:
 *
 *   1. a NUMBER carried by an `op('other').par.x` expression — the cross-node case above;
 *   2. a COMPOUND, whose `value` is a new array and whose `components` are new records;
 *   3. a DIAGNOSTIC, a new object every read. (The comparator's union-of-keys rule, which
 *      is what makes a prop that APPEARS count, is gated as a property in
 *      `ui/controls/props-equal.test.ts` — see the §V910 note on that test below for why
 *      it could not honestly be isolated here.)
 *
 * §B181's ruling is the reason none of these assert "a render was skipped": twenty-six
 * green tests all resolved a STATIC parameter while every driven one had been frozen for
 * months. "It did not re-render" is equally true of the fix and of the bug. Every assertion
 * below reads the number ON SCREEN and requires it to MOVE.
 */

beforeAll(installDomStubs);
afterEach(cleanup);

const rgba = { kind: "texture2d", sample: "float", channels: 4 } as const;

/** The node an expression READS. Nothing here is inspected; only its knob is turned. */
const sourceNode: NodeDefinition = {
  type: "test.source",
  version: 1,
  title: "Source",
  category: "test",
  inputs: [],
  outputs: [{ id: "out", label: "Out", type: rgba }],
  resolutionPolicy: { kind: "project" },
  formatPolicy: { kind: "project" },
  parameters: {
    level: { type: "number", label: "Level", default: 1, min: 0, max: 100, step: 1 },
  },
  compile: () => ({ passes: [] }),
};

/** The node the pane is OPEN on. Its values come from somewhere else. */
const sinkNode: NodeDefinition = {
  type: "test.sink",
  version: 1,
  title: "Sink",
  category: "test",
  inputs: [],
  outputs: [{ id: "out", label: "Out", type: rgba }],
  resolutionPolicy: { kind: "project" },
  formatPolicy: { kind: "project" },
  parameters: {
    amount: { type: "number", label: "Amount", default: 0.8, min: 0, max: 1000, step: 0.01 },
    offset: { type: "vector", size: 2, label: "Offset", default: [0, 0], min: -10, max: 10 },
  },
  compile: () => ({ passes: [] }),
};

const registry = createNodeRegistry([sourceNode, sinkNode]).view();

const settings: InspectorProjectSettings = {
  outputResolution: { width: 1920, height: 1080 },
  workingFormat: "rgba8unorm",
};

const context = contextFor(alice);

/**
 * What the resolver says when `op('…')` names nothing. Matched loosely on purpose: the
 * claim is "the panel SAYS the reference is broken", and pinning the sentence would make
 * this fail for a reworded message rather than for a frozen row.
 */
const SAYS_UNRESOLVED = /unknown node|is not a node|no node named|cannot be resolved|unresolved/i;

/** §V108: an expression over another node's parameter, retaining 0.8 behind it. */
const readsAnotherNode = (source: string): StoredParameter => ({
  mode: "expression",
  bindings: {
    expression: { kind: "expression", source },
    static: { kind: "static", value: 0.8 },
  },
});

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 8));
  });
}

async function setup() {
  const store = createGraphStore({ ids: createSequentialIdFactory("cross") });
  const { bus } = createDomainBus({ store, registry });

  const created = await bus.execute(
    "graph.applyPatch",
    {
      baseRevision: 0,
      operations: [
        { op: "addNode", ref: "$src", type: sourceNode.type, position: { x: 0, y: 0 } },
        { op: "addNode", ref: "$sink", type: sinkNode.type, position: { x: 200, y: 0 } },
      ],
    },
    context,
  );
  const sourceId = created.output.createdIds["$src"] as NodeId;
  const sinkId = created.output.createdIds["$sink"] as NodeId;

  // §V129/§B170 — `op()` takes the LABEL the real command path assigned, read back rather
  // than assumed, so this stays a test of the reference and not of the namer.
  const sourceName = bus.store.getGraph().nodes[sourceId]?.label;
  if (sourceName === undefined) throw new Error("the source node has no name to reference");

  await bus.execute(
    "graph.applyPatch",
    {
      baseRevision: bus.store.getGraph().revision,
      operations: [
        {
          op: "setParameters",
          nodeId: sinkId,
          parameters: { amount: readsAnotherNode(`op('${sourceName}').par.level * 2`) },
        },
      ],
    },
    context,
  );

  render(
    <StrictMode>
      <Inspector bus={bus} context={context} nodeId={sinkId} settings={settings} />
    </StrictMode>,
  );
  await settle();

  const turn = async (parameters: Record<string, StoredParameter>, nodeId = sourceId) => {
    await act(async () => {
      await bus.execute(
        "graph.applyPatch",
        {
          baseRevision: bus.store.getGraph().revision,
          operations: [{ op: "setParameters", nodeId, parameters }],
        },
        context,
      );
    });
    await settle();
  };

  return {
    bus,
    sourceId,
    sinkId,
    turn,
    shown: (label: string) =>
      Number((screen.getByRole("spinbutton", { name: label }) as HTMLInputElement).value),
    /** Opens the mode panel the way a user does: by clicking the parameter NAME. */
    expand: (label: string) => {
      fireEvent.click(screen.getByRole("button", { name: label, expanded: false }));
    },
    remove: async (nodeId: NodeId) => {
      await act(async () => {
        await bus.execute(
          "graph.applyPatch",
          {
            baseRevision: bus.store.getGraph().revision,
            operations: [{ op: "removeNodes", nodeIds: [nodeId] }],
          },
          context,
        );
      });
      await settle();
    },
  };
}

describe("T1177 — the inspected node's rows track the OTHER nodes they read (§V935)", () => {
  it("moves an op('other').par expression when the OTHER node's knob turns", async () => {
    const harness = await setup();

    // `level` starts at 1, the expression doubles it. Exact numbers, not a band: a fix
    // that made the field move to some other number would still be the bug (§V147).
    expect(harness.shown("Amount")).toBe(2);

    await harness.turn({ level: 7 });
    expect(harness.shown("Amount")).toBe(14);

    await harness.turn({ level: 21 });
    expect(harness.shown("Amount")).toBe(42);

    // Stated separately, because "the memo froze it" and "the expression never resolved"
    // both leave a field sitting still — and §V108's retained static is 0.8, which is the
    // number a frozen slot would be showing.
    expect(harness.shown("Amount")).not.toBe(2);
    expect(harness.shown("Amount")).not.toBe(0.8);
  });

  it("keeps tracking across a knob turned SIXTY times, the way a drag arrives", async () => {
    const harness = await setup();

    // The real gesture is rAF-coalesced into ~60 commits a second (§T1176). A memo that
    // hits once and then latches would pass a two-commit test and fail this one.
    for (let step = 1; step <= 60; step += 1) {
      await harness.turn({ level: step });
      expect(harness.shown("Amount"), `step ${String(step)}`).toBe(step * 2);
    }
  });

  it("moves a COMPOUND, whose value and components are minted fresh on every read", async () => {
    const harness = await setup();

    // §V113: a vector renders one field per channel and its `value` is a NEW array from
    // every resolve, so identity alone can never bail out on it — and never claiming
    // equality would make the memo pointless. The comparator walks it.
    expect(harness.shown("Offset x")).toBe(0);
    expect(harness.shown("Offset y")).toBe(0);

    await harness.turn({ offset: [3, -4] as never }, harness.sinkId);
    expect(harness.shown("Offset x")).toBe(3);
    expect(harness.shown("Offset y")).toBe(-4);
  });

  it("reports a reference that broke, though the VALUE it shows does not move", async () => {
    const harness = await setup();
    harness.expand("Amount");

    // The retained static is 0.8 and `level * 2` is 2, so first make the two AGREE: with
    // `level` at 0.4 the expression resolves to exactly the number the fallback would give.
    // Delete the referenced node now and the row must still update, even though the NUMBER
    // it displays is byte-identical across the render and the edit landed on a different
    // node entirely. A row memo that had only looked at `value` would go on claiming the
    // reference resolves.
    //
    // ⚠ §V910, measured rather than assumed: this does NOT isolate the `diagnostic` prop.
    // Losing the target also flips `driven`, so ignoring `diagnostic` alone in the
    // comparator leaves this test GREEN — verified by editing. The union-of-keys rule that
    // makes an APPEARING prop count is gated where it is a property, in `props-equal.test.ts`.
    //
    // Deleted rather than renamed, deliberately: §V128 rewrites references on rename, so a
    // rename is the case where nothing is supposed to break.
    await harness.turn({ level: 0.4 });
    expect(harness.shown("Amount")).toBe(0.8);
    const before = screen.queryAllByText(SAYS_UNRESOLVED).length;
    expect(before).toBe(0);

    await harness.remove(harness.sourceId);
    expect(harness.shown("Amount")).toBe(0.8);
    expect(screen.queryAllByText(SAYS_UNRESOLVED).length).toBeGreaterThan(0);
  });
});
