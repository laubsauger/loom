// @vitest-environment jsdom
import { StrictMode } from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { createDomainBus } from "@domain/commands/index.ts";
import { alice, contextFor } from "@domain/commands/test-support.ts";
import { createSequentialIdFactory } from "@domain/graph/ids.ts";
import { createGraphStore } from "@domain/graph/store.ts";
import { graphChannelResolver } from "@domain/channels/graph-channels.ts";
import type { FrameInputs } from "@domain/types/backend.ts";
import type { GraphDocument } from "@domain/types/graph.ts";
import type { NodeId } from "@domain/types/ids.ts";
import type { StoredParameter } from "@domain/types/parameters.ts";
import { createNodeRegistry } from "@nodes/registry/registry.ts";
import { noiseNode } from "@nodes/definitions/noise.ts";
import { outputNode } from "@nodes/definitions/output.ts";
import { timerNode } from "@nodes/definitions/values.ts";
import { compileGraph } from "@compiler/compile.ts";
import { testCapabilities, testSettings } from "@compiler/test-support.ts";
import type { EffectPassDescriptor, PassDescriptor } from "@runtime/backend/plan.ts";
import { installDomStubs } from "@ui/testing/install-dom-stubs.ts";
import { Inspector, LIVE_VALUE_INTERVAL_MS } from "./inspector.tsx";
import type { InspectorProjectSettings } from "./inspector.tsx";

/**
 * B46 — a parameter driven by `op('name').chan.value` shows the LIVE number, not 0.8.
 *
 * The owner, on E46-Lantern: "we have a pulse1 LFO that is driving the amount of the
 * shader, and the amount expression is there and it references the value, but it never
 * updates, it stays at 0.8, even though it clearly moves between 0.6 and 1.0." 0.8 was
 * exactly that slot's RETAINED static (§V108), so the panel was not resolving wrong — it
 * was not resolving at all, at any frame, and falling back.
 *
 * ## Why T893's suite could not fail for this
 *
 * `driven-live-values.test.tsx` drives its parameter with `mode: "driven"`, which
 * `resolveParameters` answers from its OWN `options.channels`. Since T901/§T897 a
 * documented channel read is an EXPRESSION — `op('pulse1').chan.value` — and an
 * expression's `op()` goes through `ResolveParametersOptions.nodes`, a reader CLOSURE
 * built before the resolve. The channels and the frame handed to `resolveParameters`
 * never reach that closure; `node-references.ts` reads them off the `base` the reader was
 * BUILT with. The panel built its reader with no `base` at all, so every `.chan` read
 * came back "this context has no channel resolver" and took §V108's fallback, while the
 * plan — whose reader `validate.ts` builds WITH a base — animated correctly.
 *
 * So this is B8's shape a third time (T593 was the second): one read path, two ways of
 * calling it, the panel disagreeing with the picture. Which is why the load-bearing
 * assertion here is not "the field moves" but "the field equals the PLAN's uniform at the
 * same frame". A fix that made the panel move to some other number would still be the bug.
 *
 * The value node is a Timer rather than an LFO on purpose: its channel is
 * `max(0, time - delay) * speed`, so the expected numbers are exact rather than a sine
 * rounded for display (§V147). The defect is in the wiring of the reader and is blind to
 * which node publishes the channel.
 */

beforeAll(installDomStubs);
afterEach(cleanup);

const registry = createNodeRegistry([timerNode, noiseNode, outputNode]).view();

const settings: InspectorProjectSettings = {
  outputResolution: { width: 1920, height: 1080 },
  workingFormat: "rgba8unorm",
};

const context = contextFor(alice);

/** The owner's slot, verbatim in shape: an expression over a channel, retaining 0.8. */
const drivenByChannel = (channelNodeName: string): StoredParameter => ({
  mode: "expression",
  bindings: {
    expression: { kind: "expression", source: `op('${channelNodeName}').chan.value` },
    static: { kind: "static", value: 0.8 },
  },
});

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

async function advance(ms: number): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

/** `amp` as it reaches the GPU, for the frame given. The other half of §V61's claim. */
function planAmp(graph: GraphDocument, nodeId: NodeId, frames: FrameInputs): number {
  const compiled = compileGraph({
    graph,
    settings: testSettings(),
    registry,
    capabilities: testCapabilities(),
    // §V163's per-frame compile: the SAME frame and the SAME resolver the panel was
    // handed. Anything less and the two sides would be compared at different moments,
    // which is a test that can pass while the bug is present.
    resolution: { frame: frames.frame, channels: graphChannelResolver(graph, registry) },
  });
  const passes: ReadonlyArray<PassDescriptor> = compiled.passes;
  const pass = passes.find(
    (candidate): candidate is EffectPassDescriptor =>
      candidate.kind === "effect" && candidate.nodeId === nodeId,
  );
  if (pass === undefined) throw new Error(`no effect pass for "${nodeId}"`);
  return (pass.uniforms as Record<string, number>)["amp"] as number;
}

async function setup() {
  const store = createGraphStore({ ids: createSequentialIdFactory("chanlive") });
  const { bus } = createDomainBus({ store, registry });

  const created = await bus.execute(
    "graph.applyPatch",
    {
      baseRevision: 0,
      operations: [
        { op: "addNode", ref: "$timer", type: timerNode.type, position: { x: 0, y: 0 } },
        { op: "addNode", ref: "$noise", type: noiseNode.type, position: { x: 200, y: 0 } },
        { op: "addNode", ref: "$out", type: outputNode.type, position: { x: 400, y: 0 } },
        { op: "connect", ref: "$e", source: { nodeId: "$noise", portId: "out" }, target: { nodeId: "$out", portId: "input" } },
      ],
    },
    context,
  );
  const timerId = created.output.createdIds["$timer"] as NodeId;
  const noiseId = created.output.createdIds["$noise"] as NodeId;

  // §V129 — the reference addresses the value node BY ITS NAME, so the name the real
  // command path assigned is the one the expression has to carry. Reading it back rather
  // than assuming it is what keeps this a test of the reference and not of the namer.
  const timerName = bus.store.getGraph().nodes[timerId]?.label;
  if (timerName === undefined) throw new Error("the timer has no name to reference");

  await bus.execute(
    "graph.applyPatch",
    {
      baseRevision: bus.store.getGraph().revision,
      operations: [
        { op: "setParameters", nodeId: noiseId, parameters: { amp: drivenByChannel(timerName) } },
      ],
    },
    context,
  );

  // The app's resolver, built the way `use-graph-compile.ts` builds it: over the document,
  // over the real registry. Not a stub — a stub would answer an address the real one does
  // not publish, and "which address" is half of what went wrong here.
  const channels = graphChannelResolver(bus.store.getGraph(), registry);

  let current: FrameInputs | null = null;
  const latestFrame = (): FrameInputs | null => current;

  render(
    <StrictMode>
      <Inspector
        bus={bus}
        context={context}
        nodeId={noiseId}
        settings={settings}
        channels={channels}
        latestFrame={latestFrame}
      />
    </StrictMode>,
  );
  await settle();

  return {
    bus,
    noiseId,
    timerName,
    render: (frameIndex: number) => {
      current = frameAt(frameIndex);
    },
    shown: (label: string) =>
      Number((screen.getByRole("spinbutton", { name: label }) as HTMLInputElement).value),
    planAt: (frameIndex: number) => planAmp(bus.store.getGraph(), noiseId, frameAt(frameIndex)),
    stored: () => bus.store.getGraph().nodes[noiseId]?.parameters["amp"],
    revision: () => bus.store.getGraph().revision,
  };
}

describe("B46 — a channel expression's field tracks the frame, and agrees with the plan (§V61)", () => {
  it("moves between two frames instead of sitting on the retained 0.8", async () => {
    const harness = await setup();

    // The Timer's channel is `time * 1`: frame 30 is 0.5 s, frame 120 is 2 s. Exact
    // numbers, and neither of them is 0.8 — the number the owner watched never change.
    harness.render(30);
    await advance(LIVE_VALUE_INTERVAL_MS * 2);
    const half = harness.shown("Amplitude");

    harness.render(120);
    await advance(LIVE_VALUE_INTERVAL_MS * 2);
    const two = harness.shown("Amplitude");

    expect(half).toBe(0.5);
    expect(two).toBe(2);
    // Stated as its own claim: a field that cannot differ between two frames is the bug,
    // whatever the two equal numbers happen to be.
    expect(half).not.toBe(two);
    expect(half).not.toBe(0.8);
  });

  it("shows the number the PLAN carries to the GPU at that same frame", async () => {
    const harness = await setup();

    // §V61/B8 in one assertion. Before the fix both sides ran: the plan resolved the
    // channel and the panel resolved the fallback, and each half looked correct alone.
    for (const frameIndex of [30, 90, 120]) {
      harness.render(frameIndex);
      await advance(LIVE_VALUE_INTERVAL_MS * 2);
      expect(harness.shown("Amplitude"), `frame ${frameIndex}`).toBe(harness.planAt(frameIndex));
    }
  });

  it("leaves the retained static in the document untouched while it displays (§V108, §V16)", async () => {
    const harness = await setup();
    const before = harness.revision();
    const stored = harness.stored();

    harness.render(120);
    await advance(LIVE_VALUE_INTERVAL_MS * 2);
    expect(harness.shown("Amplitude")).toBe(2);

    // The live number is display state. If it had leaked into the slot, flipping back to
    // Constant would hand the user whichever frame they happened to be looking at.
    expect(harness.revision()).toBe(before);
    expect(harness.stored()).toEqual(stored);
  });
});
