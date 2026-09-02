// @vitest-environment jsdom
import { StrictMode } from "react";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { createDomainBus } from "@domain/commands/index.ts";
import { alice, contextFor } from "@domain/commands/test-support.ts";
import { createSequentialIdFactory } from "@domain/graph/ids.ts";
import { createGraphStore } from "@domain/graph/store.ts";
import { isParameterSlot } from "@domain/parameters/slots.ts";
import type { ChannelResolver } from "@domain/parameters/resolve.ts";
import type { FrameInputs } from "@domain/types/backend.ts";
import type { NodeId } from "@domain/types/ids.ts";
import type { NodeDefinition } from "@domain/types/node-definition.ts";
import type { ParameterSlot, StoredParameter } from "@domain/types/parameters.ts";
import { createNodeRegistry } from "@nodes/registry/registry.ts";
import { installDomStubs } from "@ui/testing/install-dom-stubs.ts";
import { Inspector, LIVE_VALUE_INTERVAL_MS } from "./inspector.tsx";
import type { InspectorProjectSettings } from "./inspector.tsx";

/**
 * T893 — a driven parameter's control shows what is ON SCREEN, not the zero frame.
 *
 * The owner: "driven values / reference derived values dont seem to update their value in
 * the respective input, slider or whatever as the value changes. its basically static. and
 * this doesnt reflect whats actually currently rendering."
 *
 * The panel resolved with NO frame — §V44's deterministic zero — so the field showed the
 * t=0 resolution for the whole session while the plan re-resolved sixty times a second.
 * B95 caught the identical lie from the other end: a kernel's Value 1 reading 0.00 at
 * t=5.03s while the LFO driving it previewed 1.62.
 *
 * The three constraints are gated here rather than remembered, because each of them is a
 * different way for the fix itself to become a bug:
 *
 *  - §V16(a): the live value must NOT enter the document. It is per-frame state, and a
 *    write per frame would also mark the project dirty sixty times a second.
 *  - §V16(b) / §T714: it refreshes at most ten times a second and re-renders nothing but
 *    this pane. The stutter T714 measured was React at frame rate, not the compiler.
 *  - §V108: the RETAINED number is what a detach restores, so the display may not
 *    overwrite it. Show live, store retained.
 */

beforeAll(installDomStubs);
afterEach(cleanup);

const rgba = { kind: "texture2d", sample: "float", channels: 4 } as const;

const driven: NodeDefinition = {
  type: "test.driven",
  version: 1,
  title: "Driven",
  category: "test",
  inputs: [],
  outputs: [{ id: "out", label: "Out", type: rgba }],
  resolutionPolicy: { kind: "project" },
  formatPolicy: { kind: "project" },
  parameters: {
    amount: { type: "number", label: "Amount", default: 2, min: 0, max: 1000 },
    still: { type: "number", label: "Still", default: 7, min: 0, max: 1000 },
  },
  compile: () => ({ passes: [] }),
};

const settings: InspectorProjectSettings = {
  outputResolution: { width: 1920, height: 1080 },
  workingFormat: "rgba8unorm",
};

const context = contextFor(alice);

/** A stored slot driven by channel `lfo1`, holding NO retained static (§V108's hard case). */
const drivenByLfo: StoredParameter = {
  mode: "driven",
  bindings: { driven: { kind: "driven", channel: "lfo1" } },
};

/**
 * The channel the plan sees: a function of the FRAME, exactly like a real LFO (§V143).
 *
 * Frameless reads answer 0 — §V44's deterministic zero frame, which is precisely the
 * number the panel was stuck on. That asymmetry is what makes every assertion below
 * discriminate: a value of 0 in the field means the frame never reached the resolver.
 */
const lfo: ChannelResolver = (channel, resolveContext) =>
  channel === "lfo1" ? (resolveContext.frame?.frameIndex ?? 0) * 10 : undefined;

function frameAt(frameIndex: number): FrameInputs {
  return {
    frame: {
      timeSeconds: frameIndex / 60,
      deltaSeconds: 1 / 60,
      frameIndex,
      mode: "realtime",
      randomSeed: 0,
    },
    pointer: { x: 0, y: 0, buttons: 0 },
    resolution: [1920, 1080],
  };
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 8));
  });
}

/** Runs the wall clock forward, which is what the panel's <=10 Hz sampler rides on. */
async function advance(ms: number): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

interface SetupOptions {
  /** Parameters the node is created with. Default: `amount` driven by `lfo1`. */
  readonly parameters?: Record<string, StoredParameter>;
  /** Omit the frame reader entirely — the pre-T893 panel, and every headless caller. */
  readonly withoutFrames?: boolean;
}

async function setup(options: SetupOptions = {}) {
  const store = createGraphStore({ ids: createSequentialIdFactory("live") });
  const { bus } = createDomainBus({ store, registry: createNodeRegistry([driven]).view() });
  const created = await bus.execute(
    "graph.applyPatch",
    {
      baseRevision: 0,
      operations: [
        { op: "addNode", ref: "$n", type: driven.type, position: { x: 0, y: 0 } },
        {
          op: "setParameters",
          nodeId: "$n",
          parameters: options.parameters ?? { amount: drivenByLfo },
        },
      ],
    },
    context,
  );
  const nodeId = created.output.createdIds["$n"] as NodeId;

  /** The frame loop's ref, under the test's control. Reads are COUNTED (§V16's gate). */
  let current: FrameInputs | null = null;
  let reads = 0;
  const latestFrame = (): FrameInputs | null => {
    reads += 1;
    return current;
  };

  render(
    <StrictMode>
      <Inspector
        bus={bus}
        context={context}
        nodeId={nodeId}
        settings={settings}
        channels={lfo}
        {...(options.withoutFrames === true ? {} : { latestFrame })}
      />
    </StrictMode>,
  );
  await settle();

  const node = () => bus.store.getGraph().nodes[nodeId];
  return {
    bus,
    nodeId,
    node,
    reads: () => reads,
    revision: () => bus.store.getGraph().revision,
    render: (frameIndex: number) => {
      current = frameAt(frameIndex);
    },
    field: (label: string) => screen.getByRole("spinbutton", { name: label }) as HTMLInputElement,
    shown: (label: string) => (screen.getByRole("spinbutton", { name: label }) as HTMLInputElement).value,
    slot: (key: string): ParameterSlot | undefined => {
      const value = node()?.parameters[key];
      return isParameterSlot(value) ? value : undefined;
    },
    async expand(label: string) {
      fireEvent.click(screen.getByRole("button", { name: label, expanded: false }));
      await settle();
    },
  };
}

describe("T893 — the driven field tracks the frame that is rendering", () => {
  it("moves with the frame instead of sitting on the zero-frame resolution", async () => {
    const harness = await setup();

    // The lie, reproduced: nothing has rendered, so the panel is at §V44's zero frame.
    expect(harness.shown("Amount")).toBe("0");

    harness.render(12);
    await advance(LIVE_VALUE_INTERVAL_MS * 2);
    expect(harness.shown("Amount")).toBe("120");

    // And it KEEPS moving — a single update would be a coincidence, not a subscription.
    harness.render(30);
    await advance(LIVE_VALUE_INTERVAL_MS * 2);
    expect(harness.shown("Amount")).toBe("300");
  });

  it("leaves a STATIC parameter alone, and never samples the clock for one", async () => {
    // `still` has no slot at all, so nothing on this node animates. The cost of the whole
    // feature on the overwhelmingly common node must be zero: no timer, no frame read.
    const harness = await setup({ parameters: { still: 42 } });

    harness.render(50);
    await advance(LIVE_VALUE_INTERVAL_MS * 3);

    expect(harness.shown("Still")).toBe("42");
    expect(harness.reads(), "a static node must not sample the frame loop at all").toBe(0);
  });

  it("shows the zero frame when the caller has no frame loop, exactly as before", async () => {
    // A component editor, an embed, a test of the layout: §V44's deterministic zero frame
    // is the right answer for a caller with no clock, and it must stay the answer.
    const harness = await setup({ withoutFrames: true });
    harness.render(12);
    await advance(LIVE_VALUE_INTERVAL_MS * 3);
    expect(harness.shown("Amount")).toBe("0");
  });
});

describe("T893/§V16 — live values do not enter the document", () => {
  it("writes NOTHING while the value moves, so the project does not dirty per frame", async () => {
    const harness = await setup();
    const before = harness.revision();
    const stored = harness.node()?.parameters["amount"];

    for (const frameIndex of [5, 17, 42, 99]) {
      harness.render(frameIndex);
      await advance(LIVE_VALUE_INTERVAL_MS * 2);
    }
    expect(harness.shown("Amount")).toBe("990");

    // The document is byte-for-byte what it was: same revision, same stored envelope.
    expect(harness.revision()).toBe(before);
    expect(harness.node()?.parameters["amount"]).toEqual(stored);
    expect(harness.slot("amount")?.bindings.static).toBeUndefined();
  });

  it("samples at most ten times a second, however fast frames arrive (§V16, §T714)", async () => {
    const harness = await setup();
    harness.render(0);
    await advance(LIVE_VALUE_INTERVAL_MS);

    // Sixty frames at 60 Hz, handed over the way the loop hands them: written into the
    // ref, never pushed. The panel PULLS, so the cap is its own.
    const seen = new Set<string>();
    const startedAt = Date.now();
    for (let frameIndex = 1; frameIndex <= 60; frameIndex += 1) {
      harness.render(frameIndex);
      await advance(1000 / 60);
      seen.add(harness.shown("Amount"));
    }
    const elapsedMs = Date.now() - startedAt;

    /*
     * The ceiling is derived from the WALL TIME the loop actually took, not from the
     * sixty frames it fed. Under `act` each step costs more than its 16.67 ms of nominal
     * frame time, so a hard "<= 10" would measure the machine rather than the rate — it
     * read 13 on the first run of this test, with the panel sampling at exactly 10 Hz.
     * One extra for the sample already on screen when the loop started.
     */
    const ceiling = Math.ceil(elapsedMs / LIVE_VALUE_INTERVAL_MS) + 1;
    expect(seen.size, `${seen.size} updates in ${elapsedMs} ms`).toBeLessThanOrEqual(ceiling);
    // And FAR under one per frame, which is the shape §T714 measured. Sixty frames in,
    // a per-frame readout shows tens of distinct values; a 10 Hz one shows a handful.
    expect(seen.size).toBeLessThan(30);
    // The floor matters just as much: a readout that updated once and stopped would pass
    // a ceiling-only assertion while being the bug this row is about.
    expect(seen.size).toBeGreaterThanOrEqual(2);
  });
});

describe("T893/§V108 — the retained value survives being displayed over", () => {
  it("is not editable as if the shown number were the stored one", async () => {
    const harness = await setup();
    harness.render(12);
    await advance(LIVE_VALUE_INTERVAL_MS * 2);

    // The field shows 120 and refuses to be dragged to a new stored value: the channel
    // decides it, and a control that accepted an edit here would be the same lie again
    // with the arrow reversed.
    expect(harness.shown("Amount")).toBe("120");
    expect(harness.field("Amount").disabled).toBe(true);
  });

  it("detaches to the RETAINED number, never to the live sample", async () => {
    const harness = await setup();
    harness.render(12);
    await advance(LIVE_VALUE_INTERVAL_MS * 2);
    expect(harness.shown("Amount")).toBe("120");

    // Flip to Constant, which is §V108's whole promise: "flipping to Constant to check a
    // number must not cost you the expression you were writing" — and must not silently
    // capture whatever number happened to be on screen at the instant of the click.
    await harness.expand("Amount");
    const group = screen.getByRole("group", { name: "Amount mode" });
    fireEvent.click(within(group).getByRole("button", { name: /^Constant/ }));
    await settle();

    const seeded = harness.slot("amount")?.bindings.static;
    expect(seeded, "flipping to Constant wrote no static payload").toBeDefined();
    // 0, the zero-frame resolution this parameter retains — NOT 120, the frame that was
    // on screen. A live sample in this seat would make the stored value depend on WHEN
    // the user clicked, which is the document following the clock (§V16).
    expect(seeded).toEqual({ kind: "static", value: 0 });
  });
});
