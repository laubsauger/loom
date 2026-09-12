import { describe, expect, it } from "vitest";

import { createComponentSystem } from "@domain/components/registry.ts";
import { loadProject } from "@domain/project/index.ts";
import type { GraphNode } from "@domain/types/graph.ts";
import type { ParameterSlot } from "@domain/types/parameters.ts";
import { listExamples } from "../../examples/catalogue.ts";
import { exampleRegistry } from "../../examples/runner.ts";
import { movableChannels, poseFromFacts, readCameraPoseFacts } from "./camera-pose.ts";

/**
 * T1314b / §B219 — THE GUARD ASKED THE WRONG QUESTION, ON THE SHIPPED CATALOGUE.
 *
 * §T692's gizmo read the BARE `eye` key and called a plain 3-array "static, go ahead". §V113
 * makes a compound component-addressable, so a driven channel stores its own slot under
 * `eye.x` and the bare key holds only the base tuple — which the old read never consulted.
 *
 * These are the two shapes that actually ship, taken from the shipped documents rather than
 * hand-built, because the defect was entirely about what real documents store:
 *
 *  - **E69 Burnish** has NO bare `eye` at all. The old read fell through to a hardcoded copy
 *    of the schema default `[0, 0.5, 3]` while the camera sits at y 1.9, z 8.4 — so the
 *    gizmo armed, orbited about an invented pivot, and wrote that pose over §V914's retained
 *    value while `eye.x` stayed on its expression and the camera never moved.
 *  - **E34 Lidar** has a bare `eye` AND two driven channels, so its base tuple is stale on
 *    exactly the channels a drag must not write.
 */

const { components, nodes } = createComponentSystem(exampleRegistry());

function cameraOf(prefix: string): GraphNode {
  const file = listExamples().find((entry) => entry.fileName.startsWith(prefix));
  if (file === undefined) throw new Error(`${prefix} is not in examples/`);
  const loaded = loadProject(file.text, { nodes, components });
  if (!loaded.ok) throw new Error(`${file.fileName} did not load: ${loaded.reason}`);
  const camera = Object.values(loaded.document.graph.nodes).find((node) => node.type === "camera");
  if (camera === undefined) throw new Error(`${file.fileName} has no camera node`);
  return camera;
}

const definition = nodes.get("camera");

/** The mode the DOCUMENT stores for one channel: its own slot, else the compound's, else static. */
function storedMode(node: GraphNode, key: string, axis: string): string {
  const slotLike = (value: unknown): ParameterSlot | null =>
    typeof value === "object" && value !== null && "bindings" in value ? (value as ParameterSlot) : null;
  return slotLike(node.parameters[`${key}.${axis}`])?.mode ?? slotLike(node.parameters[key])?.mode ?? "static";
}

/**
 * THE CATALOGUE-WIDE GUARANTEE, which is what keeps §B219 fixed rather than fixed-for-E69.
 *
 * Walks every camera node of every shipped example and holds one rule: a channel is movable
 * exactly when the document stores no other mode for it. That is the property whose absence
 * WAS the bug — the old guard asked about the bare key and therefore said "movable" for 12
 * of the 20 catalogue cameras while a channel was driven.
 *
 * It is on the `test:gates` ladder because nothing else can reach it: adding a camera to any
 * example, or driving a channel on one, is a change no scoped run of that example's files
 * would connect to this file (§V957, T1274's rule).
 */
describe("T1314b — no shipped camera can be flown on a channel another mode decides", () => {
  const cameras = listExamples().flatMap((file) => {
    const loaded = loadProject(file.text, { nodes, components });
    if (!loaded.ok) throw new Error(`${file.fileName} did not load: ${loaded.reason}`);
    return Object.values(loaded.document.graph.nodes)
      .filter((node) => node.type === "camera")
      .map((node) => ({ file: file.fileName, node }));
  });

  it("finds the catalogue's cameras at all, so a silent zero cannot pass this file", () => {
    expect(cameras.length).toBeGreaterThan(15);
  });

  it("marks a channel movable exactly when the document stores no other mode for it", () => {
    const wrong: string[] = [];
    let partlyDriven = 0;
    for (const { file, node } of cameras) {
      const facts = readCameraPoseFacts(node, definition);
      const driven = ["eye", "lookAt"].flatMap((key) =>
        ["x", "y", "z"].map((axis) => storedMode(node, key, axis) !== "static"),
      );
      if (facts === null) {
        // Null is the "nothing to fly" answer, and it is only honest when every channel is
        // decided elsewhere (§T1049: absent, never disabled).
        if (driven.some((isDriven) => !isDriven)) wrong.push(`${file}: refused a camera with a free channel`);
        continue;
      }
      if (driven.some((isDriven) => isDriven)) partlyDriven += 1;
      const movable = [...movableChannels(facts.eye), ...movableChannels(facts.lookAt)];
      for (const [index, canMove] of movable.entries()) {
        if (canMove === (driven[index] !== true)) continue;
        wrong.push(`${file}: channel ${String(index)} movable=${String(canMove)} driven=${String(driven[index])}`);
      }
    }
    expect(wrong, "a drag here would write over a channel another mode decides (§B219)").toEqual([]);
    // The dozen §B219 measured. If this ever reads 0 the corpus stopped covering the bug.
    expect(partlyDriven, "the catalogue's driven cameras are this gate's subjects").toBeGreaterThan(5);
  });
});

describe("T1314b — the camera pose is read per channel, resolved, from the shipped documents", () => {
  it("E69 Burnish: no bare `eye` at all, so the old read invented a pose the camera never had", () => {
    const facts = readCameraPoseFacts(cameraOf("E69-"), definition);
    if (facts === null) throw new Error("E69's camera has free channels; it must offer a gizmo");

    // The channel that is decided elsewhere, named by the mode the inspector names it by.
    expect(facts.eye[0]?.drivenBy).toBe("Expression");
    expect(facts.eye[1]?.drivenBy).toBeNull();
    expect(facts.eye[2]?.drivenBy).toBeNull();

    // WHERE THE CAMERA ACTUALLY IS. The old read answered [0, 0.5, 3] here — the schema
    // default, copied into the guard — for a camera framed at 1.9 / 8.4.
    const { eye, lookAt } = poseFromFacts(facts);
    expect(eye[1]).toBe(1.9);
    expect(eye[2]).toBe(8.4);
    expect(lookAt).toEqual([0, 0.75, 0]);

    // What the gesture may write, and the sentence that says what it will not.
    expect(movableChannels(facts.eye)).toEqual([false, true, true]);
    expect(movableChannels(facts.lookAt)).toEqual([true, true, true]);
    expect(facts.held).toContain("x (Expression)");
  });

  it("E34 Lidar: a stale base tuple on exactly the channels a drag must not write", () => {
    const facts = readCameraPoseFacts(cameraOf("E34-"), definition);
    if (facts === null) throw new Error("E34's camera has a free channel; it must offer a gizmo");
    expect(movableChannels(facts.eye)).toEqual([false, true, false]);
    // Both held channels are named — a refusal that names one of two is worse than useless.
    expect(facts.held).toContain("x (Expression)");
    expect(facts.held).toContain("z (Expression)");
  });

  it("offers nothing only when EVERY channel is decided elsewhere (§T1049: absent, not disabled)", () => {
    const camera = cameraOf("E69-");
    const expression = { bindings: { expression: { kind: "expression", source: "op('drift').chan.value" } }, mode: "expression" };
    const allDriven: GraphNode = {
      ...camera,
      parameters: Object.fromEntries(
        ["eye", "lookAt"].flatMap((key) => ["x", "y", "z"].map((axis) => [`${key}.${axis}`, expression])),
      ) as GraphNode["parameters"],
    };
    expect(readCameraPoseFacts(allDriven, definition)).toBeNull();

    // One free channel is still a camera worth flying — the whole point of masking over
    // refusing. E69 above is that case; this is its boundary.
    const oneFree: GraphNode = {
      ...allDriven,
      parameters: { ...allDriven.parameters, "eye.y": 1.9 } as GraphNode["parameters"],
    };
    const facts = readCameraPoseFacts(oneFree, definition);
    expect(facts).not.toBeNull();
    expect(movableChannels(facts?.eye ?? [])).toEqual([false, true, false]);
  });
});
