// @vitest-environment jsdom
import { StrictMode } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
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
import type { StoredParameter } from "@domain/types/parameters.ts";
import { createNodeRegistry } from "@nodes/registry/registry.ts";
import { installDomStubs } from "@ui/testing/install-dom-stubs.ts";
import { Inspector, LIVE_VALUE_INTERVAL_MS } from "./inspector.tsx";
import type { InspectorProjectSettings } from "./inspector.tsx";

/**
 * §V830 (T988) — the PER-COMPONENT half, wired end to end.
 *
 * T893 gave the whole-slot case a live readout. §V113 gives a compound's channels their
 * own modes. The two meet at `offset.y`: one axis of a vec2 driven by a channel while its
 * sibling stays a constant the user drags.
 *
 * This file is deliberately mounted on the REAL `Inspector` rather than on the control
 * kit, because the kit's props are optional and this project's dominant bug class is a
 * feature that is fully built and never passed anything (§V272). The control-kit tests in
 * `src/ui/controls/driven-fields.test.tsx` prove the fields behave; these prove the panel
 * actually hands them the values and the modes. Delete the `componentDriven` or the
 * `liveValue` prop at the `ParameterControl` call site and these go red; the kit's tests
 * would not.
 */

beforeAll(installDomStubs);
afterEach(cleanup);

const rgba = { kind: "texture2d", sample: "float", channels: 4 } as const;

const vectorNode: NodeDefinition = {
  type: "test.vector-driven",
  version: 1,
  title: "Vector",
  category: "test",
  inputs: [],
  outputs: [{ id: "out", label: "Out", type: rgba }],
  resolutionPolicy: { kind: "project" },
  formatPolicy: { kind: "project" },
  parameters: {
    offset: { type: "vector", label: "Offset", size: 2, default: [1, 2], min: -1000, max: 1000 },
  },
  compile: () => ({ passes: [] }),
};

const settings: InspectorProjectSettings = {
  outputResolution: { width: 1920, height: 1080 },
  workingFormat: "rgba8unorm",
};

const context = contextFor(alice);

/** Only `offset.y` carries a slot; `offset` itself stays the bare default. */
const drivenByLfo: StoredParameter = {
  mode: "driven",
  bindings: { driven: { kind: "driven", channel: "lfo1" } },
};

/** Frame-shaped, like a real LFO (§V143). A frameless read answers 0 — §V44's zero frame. */
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

async function advance(ms: number): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

async function setup() {
  const store = createGraphStore({ ids: createSequentialIdFactory("vec") });
  const { bus } = createDomainBus({ store, registry: createNodeRegistry([vectorNode]).view() });
  const created = await bus.execute(
    "graph.applyPatch",
    {
      baseRevision: 0,
      operations: [
        { op: "addNode", ref: "$n", type: vectorNode.type, position: { x: 0, y: 0 } },
        { op: "setParameters", nodeId: "$n", parameters: { "offset.y": drivenByLfo } },
      ],
    },
    context,
  );
  const nodeId = created.output.createdIds["$n"] as NodeId;

  let current: FrameInputs | null = null;
  render(
    <StrictMode>
      <Inspector
        bus={bus}
        context={context}
        nodeId={nodeId}
        settings={settings}
        channels={lfo}
        latestFrame={() => current}
      />
    </StrictMode>,
  );
  await advance(8);

  const axis = (name: string): HTMLInputElement =>
    screen.getByRole("spinbutton", { name }) as HTMLInputElement;
  return {
    axis,
    node: () => bus.store.getGraph().nodes[nodeId],
    revision: () => bus.store.getGraph().revision,
    render: (frameIndex: number) => {
      current = frameAt(frameIndex);
    },
    stored: (key: string) => {
      const value = bus.store.getGraph().nodes[nodeId]?.parameters[key];
      return isParameterSlot(value) ? value.bindings.static : value;
    },
  };
}

describe("§V830 — a driven CHANNEL of a compound, in the real panel", () => {
  it("updates with the frame while its static sibling holds still", async () => {
    const harness = await setup();

    // Nothing has rendered: §V44's zero frame, which is also the number the panel was
    // stuck on before T893.
    expect(harness.axis("Offset y").value).toBe("0");
    expect(harness.axis("Offset x").value).toBe("1");

    harness.render(12);
    await advance(LIVE_VALUE_INTERVAL_MS * 2);
    expect(harness.axis("Offset y").value).toBe("120");

    // And it KEEPS moving. One update would be a coincidence, not a live readout.
    harness.render(30);
    await advance(LIVE_VALUE_INTERVAL_MS * 2);
    expect(harness.axis("Offset y").value).toBe("300");
    // The sibling is untouched by any of it — this is the §V113 seat, not a whole-slot
    // lock wearing a per-channel name.
    expect(harness.axis("Offset x").value).toBe("1");
  });

  it("is legible, focusable and marked — never disabled", async () => {
    const harness = await setup();
    harness.render(12);
    await advance(LIVE_VALUE_INTERVAL_MS * 2);

    const y = harness.axis("Offset y");
    // The defect, gated: `disabled` dims the one moving number on the panel, drops it
    // out of the tab order and tells a screen reader to skip it.
    expect(y.disabled, "the driven axis is disabled again").toBe(false);
    expect(y.getAttribute("aria-readonly")).toBe("true");
    expect(y.getAttribute("aria-valuenow")).toBe("120");
    y.focus();
    expect(document.activeElement).toBe(y);

    // The POSITIVE mark: "D", for the Driven mode deciding it, sitting on the field.
    const host = y.parentElement?.parentElement as HTMLElement;
    expect(host.querySelector('[title="Offset y — Driven"]')?.textContent).toBe("D");
    expect(y.parentElement?.getAttribute("data-driven")).toBe("true");

    // The static sibling carries none of it.
    const x = harness.axis("Offset x");
    expect(x.getAttribute("aria-readonly")).toBeNull();
    expect(x.parentElement?.getAttribute("data-driven")).toBe("false");
  });

  it("refuses a write to the driven axis and accepts one to its sibling", async () => {
    const harness = await setup();
    harness.render(12);
    await advance(LIVE_VALUE_INTERVAL_MS * 2);

    const before = harness.revision();
    const y = harness.axis("Offset y");
    fireEvent.change(y, { target: { value: "5" } });
    fireEvent.blur(y);
    await advance(8);
    // Nothing written: the channel decides this axis, and a field that banked the edit
    // would be showing the user a number the next frame silently discards.
    expect(harness.revision()).toBe(before);
    expect(harness.stored("offset.y")).toBeUndefined();

    const x = harness.axis("Offset x");
    fireEvent.change(x, { target: { value: "7" } });
    fireEvent.blur(x);
    await advance(8);
    expect(harness.stored("offset.x")).toEqual({ kind: "static", value: 7 });
  });
});

