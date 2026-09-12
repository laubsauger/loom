import { describe, expect, it } from "vitest";

import { createDomainBus } from "@domain/commands/index.ts";
import { alice, contextFor } from "@domain/commands/test-support.ts";
import { createComponentSystem } from "@domain/components/registry.ts";
import { createGraphStore } from "@domain/graph/store.ts";
import { loadProject } from "@domain/project/index.ts";
import type { GraphNode } from "@domain/types/graph.ts";
import type { NodeId } from "@domain/types/ids.ts";
import type { ParameterSlot } from "@domain/types/parameters.ts";
import { createParameterEditor } from "@editor/inspector/parameter-editor.ts";
import { createCameraGizmoStore } from "@editor/viewer/camera-gizmo-store.ts";
import { movableChannels, poseFromFacts, readCameraPoseFacts } from "@editor/viewer/camera-pose.ts";
import { listExamples } from "../../examples/catalogue.ts";
import { exampleRegistry } from "../../examples/runner.ts";

/**
 * T1314b / §B219 — FLY E69 BURNISH'S CAMERA AND PROVE THE DOCUMENT SURVIVES IT.
 *
 * ## The bug, as the user met it
 *
 * Drag a camera tile on any of the twelve catalogue cameras with a driven channel: the drag
 * lands, the camera does not move, and the value the document keeps for when nothing is
 * driving (§V914 — what every thumbnail, headless render and claim reads) is silently
 * replaced by an arbitrary dragged pose. Nothing errors. The damage shows up later, in a
 * render nobody connects to a drag.
 *
 * E69 is the worst case of the four: it stores NO bare `eye`, so §T692's guard fell through
 * to a hardcoded copy of the schema default `[0, 0.5, 3]` while the camera sits at y 1.9,
 * z 8.4 — the gizmo armed, orbited about a pivot the camera never had, and wrote it.
 *
 * ## Why this is an integration test and not a unit one
 *
 * The corruption lived in the JOIN: a blind read in `graph-pane`, a bare-compound write in
 * the gizmo store, and `apply-patch`'s §V108 rule that a bare value updates the retained
 * STATIC binding without disturbing the inactive expression. Each is defensible alone. So
 * this drives the real store through the real `ParameterEditor` onto a real bus holding the
 * real shipped document, and then reads the document back.
 */

const { components, nodes } = createComponentSystem(exampleRegistry());
const context = contextFor(alice);
/** Immediate, because the editor's default scheduler is rAF and there are no frames here. */
const schedule = (run: () => void): (() => void) => {
  run();
  return () => {};
};

function burnishFixture() {
  const file = listExamples().find((entry) => entry.fileName.startsWith("E69-"));
  if (file === undefined) throw new Error("E69-Burnish is not in examples/");
  const loaded = loadProject(file.text, { nodes, components });
  if (!loaded.ok) throw new Error(`E69 did not load: ${loaded.reason}`);
  const camera = Object.values(loaded.document.graph.nodes).find((node) => node.type === "camera");
  if (camera === undefined) throw new Error("E69 has no camera node");

  const store = createGraphStore({ initialGraph: loaded.document.graph });
  const { bus } = createDomainBus({ store, registry: nodes });
  const editor = createParameterEditor({ bus, context, schedule });
  const gizmo = createCameraGizmoStore({
    editor: { setStored: (nodeId, entries, phase) => editor.setStored(nodeId, entries, phase) },
    readPose: (nodeId) => {
      const node = store.view.getGraph().nodes[nodeId];
      if (node === undefined) return null;
      const facts = readCameraPoseFacts(node, nodes.get(node.type), {});
      if (facts === null) return null;
      const { eye, lookAt } = poseFromFacts(facts);
      return { eye, lookAt, eyeMask: movableChannels(facts.eye), lookAtMask: movableChannels(facts.lookAt) };
    },
  });
  const cameraId = camera.id as NodeId;
  /*
   * The editor is FIRE AND FORGET by design: `write()` does `void sendParameters(...)`,
   * which enqueues an async `bus.execute`. Nothing is handed back to the caller, so a test
   * cannot await the write — it waits for the DOCUMENT to move, which is the only thing the
   * seam actually promises. Bounded, so a broken write fails as a timeout rather than a hang.
   */
  const settled = async (): Promise<void> => {
    const start = bus.store.getRevision();
    for (let tick = 0; tick < 200 && bus.store.getRevision() === start; tick += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 1));
    }
  };
  const read = (): GraphNode => {
    const node = store.view.getGraph().nodes[cameraId];
    if (node === undefined) throw new Error("the camera left the document");
    return node;
  };
  return { gizmo, cameraId, read, before: camera, settled };
}

const slotOf = (node: GraphNode, key: string): ParameterSlot => {
  const stored = node.parameters[key];
  if (typeof stored !== "object" || stored === null || !("bindings" in stored)) {
    throw new Error(`${key} is not a slot: ${JSON.stringify(stored)}`);
  }
  return stored as ParameterSlot;
};

describe("T1314b — flying E69 Burnish's camera leaves its driven channel untouched", () => {
  it("moves the free channels and writes nothing at all to the expression channel", async () => {
    const { gizmo, cameraId, read, before, settled } = burnishFixture();
    const eyeXBefore = slotOf(before, "eye.x");

    gizmo.setMode(cameraId, "adjustable");
    gizmo.apply(cameraId, { azimuth: 0.35 });
    gizmo.apply(cameraId, { elevation: 0.2 });
    gizmo.release?.(cameraId);
    await settled();

    const after = read();
    const eyeXAfter = slotOf(after, "eye.x");

    // (a) The EXPRESSION is untouched — same mode, same source. The drag never had any
    // business writing here, and before T1314b it did.
    expect(eyeXAfter.mode).toBe("expression");
    expect(eyeXAfter.bindings.expression).toEqual(eyeXBefore.bindings.expression);

    // (b) The RETAINED STATIC is untouched. This is §V914's value — the one a headless
    // render uses when nothing drives the channel — and replacing it was the actual damage.
    expect(eyeXAfter.bindings.static).toEqual(eyeXBefore.bindings.static);

    /*
     * (c) THE CORRUPTION'S OWN SIGNATURE, asserted before anything else about movement.
     *
     * E69 stores no bare `eye`. §V113 makes the bare key the BASE TUPLE that every stored
     * component overrides, so a bare write is both inert for the driven channel and a
     * replacement of the retained base — §B219's "the camera does not move and the retained
     * value becomes an arbitrary dragged pose", in one key. Under the old blind guard this
     * key appears, holding a pose derived from the hardcoded `[0, 0.5, 3]`; it must not.
     */
    expect(after.parameters["eye"]).toBeUndefined();

    // (d) The free channels MOVED, so this was a real flight and not a refusal in disguise.
    expect(after.parameters["eye.y"]).not.toEqual(before.parameters["eye.y"]);
    expect(after.parameters["eye.z"]).not.toEqual(before.parameters["eye.z"]);
  });

  it("names the held channel, so the gesture says what it will not do (§V830)", () => {
    const { before } = burnishFixture();
    const facts = readCameraPoseFacts(before, nodes.get(before.type), {});
    if (facts === null) throw new Error("E69's camera has free channels");
    expect(facts.held).toContain("x (Expression)");
    expect(facts.held).toContain("Eye");
  });
});
