import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { createDomainBus } from "@domain/commands/index.ts";
import { createGraphStore } from "@domain/graph/store.ts";
import { createSequentialIdFactory } from "@domain/graph/ids.ts";
import type { LoomBus } from "@domain/commands/bus.ts";
import type { NodeId } from "@domain/types/ids.ts";
import { createNodeRegistry } from "@nodes/registry/registry.ts";
import { allNodeDefinitions } from "@nodes/definitions/index.ts";
import { installDomStubs } from "@ui/testing/install-dom-stubs.ts";
import { alice, contextFor } from "@domain/commands/test-support.ts";

import { Inspector } from "./inspector.tsx";
import type { InspectorProjectSettings } from "./inspector.tsx";

/**
 * T1321b — THE SUGGESTED SYNC OFFSET RENDERS AT THE SYNC OFFSET FIELD.
 *
 * §T1319b measured the floor and built the apply gesture, on the audio node's STATUS LINE,
 * while the knob it is for lives in the Analysis group below — so the number and its field
 * were in different parts of one panel, and the owner asked for a "prefill" because that is
 * the only thing that arrangement leaves to ask for.
 *
 * These mount the INSPECTOR rather than a component, because the claim is about WHERE: the
 * caption and its button have to be inside the Sync Offset row, and there has to be exactly
 * one of them in the panel. A test of the surface alone cannot see either fact.
 *
 * The two rulings that must survive every future edit here:
 *   §V985 — the measurement is a FLOOR, the words say "at least", and they name the part
 *           `outputLatency` cannot see. A user who applies it, is still late, and cannot
 *           learn it was a lower bound concludes the FEATURE is broken.
 *   §V986 — an unmeasurable browser gets the sentence and NO button, and an unmeasured 0
 *           makes no claim at all. A confident "0 ms" is the one thing that must never be
 *           offered where someone is looking for an authority.
 * And the standing constraint the row exists to protect: this SUGGESTS. `syncOffset` is
 * stored in the document and applied identically to an offline render, so nothing may write
 * it but a gesture — a machine-derived prefill would quietly retime a shipped take the
 * moment the document opened on another box.
 */

const settings: InspectorProjectSettings = {
  outputResolution: { width: 1920, height: 1080 },
  workingFormat: "rgba8unorm",
  limits: { maxResolution: 4096 },
};

const context = contextFor(alice);

/** A machine that reports latency: 21 ms out + 5 ms base + one 60 Hz frame = 43 ms. */
const MEASURED = {
  outputSeconds: 0.021,
  baseSeconds: 0.005,
  frameSeconds: 1 / 60,
  suggestedSeconds: 0.0427,
} as const;

beforeAll(() => {
  installDomStubs();
});
afterEach(cleanup);

async function mount(
  nodeType: string,
  options: {
    status?: { kind: "idle" | "live" | "error"; latency?: typeof MEASURED | null };
    parameters?: Record<string, number>;
  } = {},
): Promise<{ bus: LoomBus; nodeId: NodeId }> {
  const store = createGraphStore({ ids: createSequentialIdFactory("i") });
  const { bus } = createDomainBus({
    store,
    registry: createNodeRegistry(allNodeDefinitions).view(),
  });
  const created = await bus.execute(
    "graph.applyPatch",
    {
      baseRevision: 0,
      operations: [{ op: "addNode", ref: "$n", type: nodeType, position: { x: 0, y: 0 } }],
    },
    context,
  );
  const nodeId = created.output.createdIds["$n"] as NodeId;
  if (options.parameters !== undefined) {
    await bus.execute(
      "graph.applyPatch",
      {
        baseRevision: bus.store.getRevision(),
        operations: [{ op: "setParameters", nodeId, parameters: options.parameters }],
      },
      context,
    );
  }
  render(
    <Inspector
      bus={bus}
      context={context}
      nodeId={nodeId}
      settings={settings}
      {...(options.status === undefined ? {} : { audioStatus: () => options.status! })}
    />,
  );
  return { bus, nodeId };
}

/** The row the caption must be inside — the inspector tags every generic row with its key. */
const syncOffsetRow = (): HTMLElement | null =>
  document.querySelector<HTMLElement>('[data-parameter-key="syncOffset"]');

const applyButtons = (): HTMLElement[] => screen.queryAllByRole("button", { name: /^Use / });

const storedSyncOffset = (bus: LoomBus, nodeId: NodeId): unknown =>
  bus.store.getGraph().nodes[nodeId]?.parameters["syncOffset"];

describe("T1321b — the suggestion is at the field, not across the panel", () => {
  it("the caption and its button render INSIDE the Sync Offset row, once", async () => {
    await mount("audioFileIn", { status: { kind: "live", latency: MEASURED } });
    const row = syncOffsetRow();
    expect(row).not.toBeNull();
    // The defect this row exists to fix: the number living somewhere the field is not.
    expect(row?.textContent).toContain("At least 43 ms");
    const buttons = applyButtons();
    // Exactly one in the whole panel — the status line no longer offers the same write.
    expect(buttons).toHaveLength(1);
    expect(row?.contains(buttons[0] ?? null)).toBe(true);
  });

  it("§V985 — the words say it is a FLOOR and name what the measurement cannot see", async () => {
    await mount("audioFileIn", { status: { kind: "live", latency: MEASURED } });
    const text = syncOffsetRow()?.textContent ?? "";
    expect(text).toContain("At least");
    // The unmeasured half, named. Without this a user who is still late has no way to
    // learn the figure was a lower bound, and blames the feature.
    expect(text).toContain("display");
    expect(text).toContain("this or more");
  });

  it("the gesture — and ONLY the gesture — writes the document, and the field then says applied", async () => {
    const { bus, nodeId } = await mount("audioFileIn", {
      status: { kind: "live", latency: MEASURED },
    });
    // Rendering the suggestion wrote NOTHING: the document still holds the parameter's own
    // default, not the measurement. A prefill would quietly retime a shipped take the moment
    // the document was opened on a different machine.
    expect(storedSyncOffset(bus, nodeId)).toBe(0);

    applyButtons()[0]?.click();

    // The value the consumer reads back — the document, through the real bus, rounded as
    // the button names it (43 ms).
    await waitFor(() => {
      expect(storedSyncOffset(bus, nodeId)).toBe(0.043);
    });
    // State, not a flash: the row still says so long after the click, and there is nothing
    // left to press because there is nothing left to apply.
    await waitFor(() => {
      expect(syncOffsetRow()?.textContent).toContain("applied");
    });
    expect(applyButtons()).toHaveLength(0);
  });

  it("§V986 — an unmeasurable browser says so at the field and offers NO value to apply", async () => {
    await mount("audioFileIn", { status: { kind: "live", latency: null } });
    const row = syncOffsetRow();
    expect(row?.textContent).toContain("no audio output latency");
    // Not a disabled control ("not now") and not a 0 ms fallback (indistinguishable from a
    // real measurement of a zero-latency machine): absent.
    expect(applyButtons()).toHaveLength(0);
    expect(row?.querySelector('[data-audio-latency="unmeasurable"]')).not.toBeNull();
    // And no verdict on the value either way. A `0` suggestion here reaches the SAME lie by
    // the other road: the field already holds 0, so it would mark itself "applied" and an
    // unmeasured 0 would be wearing a measurement's authority — which is §V986 itself.
    expect(row?.textContent).not.toContain("applied");
    expect(row?.querySelector("[data-sync-offset]")).toBeNull();
  });

  it("§V986 — with no capture live the field makes NO claim, so its 0 stays a rest state", async () => {
    await mount("audioFileIn", { status: { kind: "idle", latency: MEASURED } });
    // The row is there and editable as always — this is about the CAPTION, not the knob.
    const row = syncOffsetRow();
    expect(row).not.toBeNull();
    expect(row?.textContent).not.toContain("At least");
    expect(applyButtons()).toHaveLength(0);
  });

  it("a microphone is offered nothing: live analysis cannot look ahead", async () => {
    await mount("audioIn", { status: { kind: "live", latency: MEASURED } });
    // `audioIn` has no `syncOffset` at all — so there is no row for a caption to attach to,
    // and offering the number anyway would be offering it for a control that cannot use it.
    expect(syncOffsetRow()).toBeNull();
    expect(applyButtons()).toHaveLength(0);
    expect(screen.queryByText(/At least/)).toBeNull();
  });

  it("GUARD: with no capture surface at all, the Sync Offset row is still there to edit", async () => {
    await mount("audioFileIn");
    // The legitimate case the caption's gate could swallow: an embed or a headless mount
    // passes no `audioStatus`, and the parameter must stay exactly as editable as ever.
    expect(syncOffsetRow()).not.toBeNull();
    expect(applyButtons()).toHaveLength(0);
  });
});
