import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { createDomainBus } from "@domain/commands/index.ts";
import { createGraphStore } from "@domain/graph/store.ts";
import { createSequentialIdFactory } from "@domain/graph/ids.ts";
import type { NodeId } from "@domain/types/ids.ts";
import { createNodeRegistry } from "@nodes/registry/registry.ts";
import { allNodeDefinitions } from "@nodes/definitions/index.ts";
import { installDomStubs } from "@ui/testing/install-dom-stubs.ts";

import { Inspector } from "./inspector.tsx";
import type { InspectorProjectSettings } from "./inspector.tsx";
import { audioSectionParameters } from "./audio-section.tsx";
import { midiSectionParameters } from "./midi-section.tsx";
import { webcamSectionParameters } from "./webcam-section.tsx";
import { alice, contextFor } from "@domain/commands/test-support.ts";

/**
 * T994 — ONE CONTROL PER DOCUMENT FIELD. The device sections presented a styled picker
 * while the generic parameter groups rendered the SAME `device` key as a raw id text
 * box directly below it — two controls writing one field, the second of which lets a
 * user type an id the picker silently disagrees with. The fix is a CLAIM, not a
 * hide-list: each section declares the keys it presents, and the claim applies only
 * while the section actually renders.
 *
 * The GUARD half matters as much as the dedupe half: with the section's surface absent
 * (an embed, a test, a build without the wiring), the generic control must COME BACK —
 * a claim that outlives its section would leave the field uneditable, which is the
 * legitimate case this filter could swallow.
 */

const settings: InspectorProjectSettings = {
  outputResolution: { width: 1920, height: 1080 },
  workingFormat: "rgba8unorm",
  limits: { maxResolution: 4096 },
};

const context = contextFor(alice);

beforeAll(() => {
  installDomStubs();
});
afterEach(cleanup);

async function mount(nodeType: string, extra: Record<string, unknown> = {}) {
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
  render(<Inspector bus={bus} context={context} nodeId={nodeId} settings={settings} {...extra} />);
}

/** The generic groups render `device` as a text field named by its label. */
function genericDeviceBox(): HTMLElement | null {
  return screen.queryByRole("textbox", { name: /^(Device|Camera)$/ });
}

describe("T994 — each section claims the keys it presents", () => {
  it("the claims are what the sections actually render", () => {
    expect(audioSectionParameters("audioIn")).toEqual(["device"]);
    // audioFileIn gets status only — no picker, so no claim, so its (absent) key is
    // never filtered by a control that is not there.
    expect(audioSectionParameters("audioFileIn")).toEqual([]);
    expect(webcamSectionParameters()).toEqual(["device"]);
    // midi deliberately claims only device: the mapping's generic JSON is the learn
    // table's readable RESULT, not a duplicate control (the inspector's standing
    // "controls above the result" intent).
    expect(midiSectionParameters()).toEqual(["device"]);
  });

  it("webcam: the picker's section renders and the raw id text box does not", async () => {
    await mount("webcam");
    // The section is there (its picker announces itself as the camera control) …
    expect(screen.getByLabelText("Camera device")).toBeTruthy();
    // … and the generic text box over the same document field is gone.
    expect(genericDeviceBox()).toBeNull();
  });

  it("audioIn WITH a session surface: one device control, the section's", async () => {
    await mount("audioIn", { audioStatus: () => ({ kind: "idle" as const }) });
    expect(screen.getByLabelText(/microphone device/i)).toBeTruthy();
    expect(genericDeviceBox()).toBeNull();
  });

  it("GUARD: audioIn with NO session surface keeps the generic device control editable", async () => {
    await mount("audioIn");
    // No surface, no section — and the claim must lapse with it: the raw field is the
    // only way to edit the parameter here, and hiding it would strand the document.
    expect(screen.queryByLabelText(/microphone device/i)).toBeNull();
    expect(genericDeviceBox()).not.toBeNull();
  });
});
