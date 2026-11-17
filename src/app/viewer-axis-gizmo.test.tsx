// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { installDomStubs } from "@ui/testing/install-dom-stubs.ts";
import { TooltipProvider } from "@ui/primitives/tooltip.tsx";
import { createAppRuntime } from "./app-runtime.ts";
import { AppRuntimeContext } from "./app-context.ts";
import { ViewerPane } from "./side-panes.tsx";
import type { AppRuntime } from "./app-runtime.ts";
import type { GraphPatchOperation } from "@domain/types/patch.ts";
import type { CompiledGraph } from "@compiler/index.ts";
import type { LoomBackend } from "@runtime/backend/index.ts";
import type { UniformUpdate } from "@runtime/backend/backend-types.ts";
import { createPreviewOrbitStore } from "@editor/viewer/preview-orbit-store.ts";
import { createLookStore } from "@editor/viewer/look-store.ts";
import { DEFAULT_PREVIEW_ORBIT, orbitPose } from "@runtime/previews/index.ts";
import { cameraBasis, cameraFrame, inCameraFrame } from "@domain/geometry/camera.ts";
import type { StoredParameter } from "@domain/types/parameters.ts";
import { authoredGraph } from "@domain/types/graph.ts";
import { cameraPoseAt } from "@editor/viewer/camera-pose.ts";
import { NO_FLATTENING } from "@domain/parameters/index.ts";

/**
 * §T1311b(c) — THE CORNER GIZMO, ASSERTED IN THE PANE THAT SHIPS IT.
 *
 * ⚑ §V998 is why this file renders the real `ViewerPane` instead of the widget alone. This
 * row has been mis-scoped three times by greps that answered "is it connected on this side"
 * — and the piece it left undone was found exactly this way: `PreviewGizmoOverlays` is
 * exported, tested, and wired in `graph-pane.tsx`, and appears ZERO times in the pane the
 * owner was looking at. A component test that mounts the widget by hand would have passed
 * for the whole time the viewer had no gizmo at all.
 *
 * So every assertion below travels the pane's own path: the compiler's published
 * `viewCamera` row → the pane's `orbitable`/`flyBasis` → the widget → the inspection store →
 * `use-view-camera.ts`'s push. The control claims land on `viewEye`, the number the shader
 * builds its ray from, and never on "a handler was called".
 */

beforeAll(() => {
  installDomStubs();
});
afterEach(cleanup);

/** E68 Sanctum's shape: standing in the nave at −z, looking down the hall toward +z. */
const HOME_EYE: readonly [number, number, number] = [0, 1.62, -5.2];
const HOME_TARGET: readonly [number, number, number] = [0, 1.9, 6];
const FOV = 1.0638;
const VIEWPORT_PASS = "temple#viewport:out";

function newRuntime(): AppRuntime {
  return createAppRuntime({
    identityStorage: null,
    actor: { kind: "human", id: "tester", label: "Tester" },
  });
}

async function seed(runtime: AppRuntime, operations: GraphPatchOperation[]) {
  return runtime.bus.execute(
    "graph.applyPatch",
    { baseRevision: runtime.bus.store.getRevision(), operations, label: "seed" },
    runtime.invocation,
  );
}

/** The two rows a §T1311b(a) shader publishes: the authored picture, and the viewport. */
function outputs(nodeId: string, withCamera: boolean): CompiledGraph["outputs"] {
  const common = {
    resourceKind: "target",
    size: [960, 540],
    format: "rgba8unorm",
    space: "linear",
    temporal: false,
  };
  const authored = { nodeId, portId: "out", resourceId: `target:${nodeId}:out`, ...common };
  if (!withCamera) return [authored] as unknown as CompiledGraph["outputs"];
  return [
    authored,
    {
      nodeId,
      portId: "out#view",
      resourceId: `viewport:${nodeId}:out`,
      ...common,
      viewCamera: {
        passId: VIEWPORT_PASS,
        eye: HOME_EYE,
        lookAt: HOME_TARGET,
        fovY: FOV,
        aspect: 16 / 9,
      },
    },
  ] as unknown as CompiledGraph["outputs"];
}

function recordingBackend() {
  const updates: UniformUpdate[] = [];
  return {
    updates,
    backend: {
      updateUniforms(update: UniformUpdate) {
        updates.push(update);
      },
      present: () => ({ id: "p", outputId: "x", setOutput() {}, dispose() {} }),
      onDiagnostic: () => () => {},
    } as unknown as LoomBackend,
  };
}

/**
 * rAF by hand. The widget polls while the camera is adjustable, and so does the uniform
 * push; jsdom's own timer-driven frames would make "did it follow" a race with the machine.
 */
function manualFrames() {
  const queue: FrameRequestCallback[] = [];
  let at = 1000;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback): number => {
    queue.push(callback);
    return queue.length;
  });
  vi.stubGlobal("cancelAnimationFrame", () => {});
  return {
    step(): void {
      at += 16;
      const due = queue.splice(0, queue.length);
      act(() => {
        for (const callback of due) callback(at);
      });
    },
  };
}

/** Where one ball actually sits on the widget, read off the DOM the user sees. */
function ballAt(key: string): { left: number; top: number; depth: number } {
  const ball = screen.getByTestId(`viewer-axis-${key}`);
  return {
    left: Number.parseFloat(ball.style.left),
    top: Number.parseFloat(ball.style.top),
    depth: Number.parseFloat(ball.dataset["depth"] ?? "NaN"),
  };
}

async function mount(options: { withCamera: boolean }) {
  const frames = manualFrames();
  const runtime = newRuntime();
  await seed(runtime, [
    { op: "addNode", ref: "$temple", type: "customWgsl", position: { x: 0, y: 0 } },
  ]);
  const graph = runtime.bus.store.getGraph();
  const nodeId = Object.keys(graph.nodes)[0]!;
  const orbits = createPreviewOrbitStore();
  const { backend, updates } = recordingBackend();
  const compiled = {
    outputs: outputs(nodeId, options.withCamera),
    diagnostics: [],
  } as unknown as CompiledGraph;
  render(
    <TooltipProvider>
      <AppRuntimeContext.Provider value={runtime}>
        <ViewerPane compiled={compiled} graph={graph} backend={backend} orbits={orbits} liveReads={{ channels: () => undefined, flattening: () => NO_FLATTENING, frame: () => undefined }} />
      </AppRuntimeContext.Provider>
    </TooltipProvider>,
  );
  // The viewport row is a CHOICE in the pane's own selector; picking it is how a user
  // reaches the inspection camera at all (§T1311b(a) ships it as a separate port).
  const select = screen.getByTestId("viewer-output-select") as HTMLSelectElement;
  const key = `${nodeId}:${options.withCamera ? "out#view" : "out"}`;
  await act(async () => {
    fireEvent.change(select, { target: { value: key } });
  });
  return { runtime, orbits, frames, updates, nodeId };
}

async function mountLook(picture: "renderer" | "camera", parameters: Record<string, StoredParameter> = {}) {
  const frames = manualFrames();
  const runtime = newRuntime();
  await seed(runtime, [
    { op: "addNode", ref: "$camera", type: "camera", label: "camera_shot", position: { x: 0, y: 0 }, parameters },
    { op: "addNode", ref: "$renderer", type: "renderSurface", label: "render_harp", position: { x: 200, y: 0 } },
  ]);
  const graph = runtime.bus.store.getGraph();
  const camera = Object.values(graph.nodes).find((node) => node.type === "camera")!.id;
  const renderer = Object.values(graph.nodes).find((node) => node.type === "renderSurface")!.id;
  const nodeId = picture === "renderer" ? renderer : camera;
  const looks = createLookStore();
  const orbits = createPreviewOrbitStore();
  const { backend } = recordingBackend();
  const basis = { eye: HOME_EYE, lookAt: HOME_TARGET };
  const compiled = {
    outputs: [{
      ...outputs(nodeId, false)[0]!,
      previewCamera: picture === "camera"
        ? { kind: "pose" }
        : { kind: "none", reason: { because: "through-camera", camera } },
      look: { renderer, basis },
    }],
    diagnostics: [],
  } as unknown as CompiledGraph;
  const pane = (nextGraph = graph) => (
    <TooltipProvider>
      <AppRuntimeContext.Provider value={runtime}>
        <ViewerPane compiled={compiled} graph={nextGraph} backend={backend} orbits={orbits} looks={looks}
          liveReads={{ channels: () => undefined, flattening: () => NO_FLATTENING, frame: () => undefined }} />
      </AppRuntimeContext.Provider>
    </TooltipProvider>
  );
  const view = render(pane());
  await act(async () => {
    fireEvent.change(screen.getByTestId("viewer-output-select"), { target: { value: `${nodeId}:out` } });
  });
  return { runtime, graph, camera, renderer, nodeId, looks, orbits, frames, basis,
    refreshGraph: () => view.rerender(pane(runtime.bus.store.getGraph())) };
}

describe("the viewer's corner gizmo", () => {
  it("keeps Fly armed when the parent receives an edited document or undo", async () => {
    const { runtime, graph, camera, refreshGraph } = await mountLook("renderer");
    await act(async () => { fireEvent.click(screen.getByTestId("viewer-fly-camera")); });
    await act(async () => { fireEvent.click(screen.getByTestId("viewer-axis-+x")); });
    await waitFor(() => expect(runtime.bus.store.getGraph().nodes[camera]).not.toEqual(graph.nodes[camera]));
    const snapped = runtime.bus.store.getGraph();
    refreshGraph();
    expect(screen.getByTestId("viewer-fly-camera").getAttribute("aria-pressed")).toBe("true");
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Pan right" })); });
    await waitFor(() => expect(runtime.bus.store.getGraph().nodes[camera]!.parameters["lookAt"]).not.toEqual(snapped.nodes[camera]!.parameters["lookAt"]));
    await act(async () => { await runtime.bus.execute("graph.undo", {}, runtime.invocation); });
    refreshGraph();
    expect(screen.getByTestId("viewer-fly-camera").getAttribute("aria-pressed")).toBe("true");
    expect(runtime.bus.store.getGraph().nodes[camera]).toEqual(snapped.nodes[camera]);
    runtime.dispose();
  });
  it("moves a camera whose free axes have retained component values", async () => {
    const { runtime, graph, camera, frames } = await mountLook("renderer", {
      eye: [0, 0, 3], "eye.x": 0, "eye.y": 0, "eye.z": 3,
      lookAt: [0, 0, 0], "lookAt.x": 0, "lookAt.y": 0, "lookAt.z": 0,
    });
    await act(async () => { fireEvent.click(screen.getByTestId("viewer-fly-camera")); });
    await act(async () => { fireEvent.click(screen.getByTestId("viewer-axis-+x")); });
    await waitFor(() => expect(runtime.bus.store.getGraph().nodes[camera]!.parameters["eye.x"]).toBe(3));
    frames.step();
    expect(ballAt("+x").depth).toBeGreaterThan(0.999);
    await act(async () => { await runtime.bus.execute("graph.undo", {}, runtime.invocation); });
    expect(runtime.bus.store.getGraph()).toEqual({ ...graph, revision: runtime.bus.store.getRevision() });
    runtime.dispose();
  });
  it("accumulates burst zoom clicks as distinct undoable camera gestures", async () => {
    const { runtime, graph, camera } = await mountLook("renderer", { eye: [0, 0, 3] });
    const commands = vi.spyOn(runtime.bus, "execute");
    await act(async () => { fireEvent.click(screen.getByTestId("viewer-fly-camera")); });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
      fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
      fireEvent.doubleClick(screen.getByRole("button", { name: "Zoom in" }));
    });
    await waitFor(() => expect(runtime.bus.store.getGraph().nodes[camera]!.parameters["eye"]).toEqual([0, 0, 2.1675]));
    await act(async () => { await runtime.bus.execute("graph.undo", {}, runtime.invocation); });
    expect(runtime.bus.store.getGraph().nodes[camera]!.parameters["eye"]).toEqual([0, 0, 2.55]);
    await act(async () => { await runtime.bus.execute("graph.undo", {}, runtime.invocation); });
    expect(runtime.bus.store.getGraph()).toEqual({ ...graph, revision: runtime.bus.store.getRevision() });
    expect(commands.mock.calls.some(([name]) => name === "view.toggleFullscreen")).toBe(false);
    runtime.dispose();
  });

  it.each(["level", "aimed"] as const)("pans along a rolled camera's visible right in a %s frame", async (frameMode) => {
    const origin = [7, -2, 4] as const;
    const heading = [2, 3, -4] as const;
    const eye = [1, 0.5, 3] as const;
    const target = [0, 0, 0] as const;
    const { runtime, graph, camera } = await mountLook("renderer", {
      origin: [...origin], heading: [...heading], frame: frameMode,
      eye: [...eye], lookAt: [...target], roll: 90,
    });
    await act(async () => { fireEvent.click(screen.getByTestId("viewer-fly-camera")); });
    const frame = cameraFrame(origin, heading, frameMode);
    const worldEye = inCameraFrame(frame, eye);
    const worldTarget = inCameraFrame(frame, target);
    const right = cameraBasis(worldEye, worldTarget, 90).right;
    const radius = Math.hypot(...eye);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Pan right" })); });
    await waitFor(() => expect(runtime.bus.store.getGraph().nodes[camera]).not.toEqual(graph.nodes[camera]));
    const stored = runtime.bus.store.getGraph().nodes[camera]!.parameters;
    const nextEye = inCameraFrame(frame, stored["eye"] as readonly [number, number, number]);
    const nextTarget = inCameraFrame(frame, stored["lookAt"] as readonly [number, number, number]);
    for (const axis of [0, 1, 2]) {
      expect(nextEye[axis]! - worldEye[axis]!).toBeCloseTo(right[axis]! * radius * 0.08, 5);
      expect(nextTarget[axis]! - worldTarget[axis]!).toBeCloseTo(right[axis]! * radius * 0.08, 5);
    }
    await act(async () => { await runtime.bus.execute("graph.undo", {}, runtime.invocation); });
    expect(runtime.bus.store.getGraph()).toEqual({ ...graph, revision: runtime.bus.store.getRevision() });
    runtime.dispose();
  });

  it("reflects animated driven channels throughout a held camera gesture", async () => {
    const held: StoredParameter = {
      mode: "expression", bindings: {
        expression: { kind: "expression", source: "time" },
        static: { kind: "static", value: 99 },
      },
    };
    const { runtime, camera, frames } = await mountLook("renderer", { "eye.x": held });
    let seconds = 1;
    runtime.bus.attachFrame(() => ({ timeSeconds: seconds, deltaSeconds: 1 / 60, frameIndex: seconds * 60, mode: "realtime", randomSeed: 0 }));
    await act(async () => { fireEvent.click(screen.getByTestId("viewer-fly-camera")); });
    const canvas = screen.getByTestId("viewer-canvas");
    canvas.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 800, height: 450, right: 800, bottom: 450, x: 0, y: 0, toJSON: () => "" }) as DOMRect;
    await act(async () => {
      fireEvent.pointerDown(canvas, { pointerId: 1, button: 0, clientX: 400, clientY: 200 });
      fireEvent.pointerMove(canvas, { pointerId: 1, clientX: 560, clientY: 200 });
      frames.step();
    });
    const before = ballAt("+x").depth;
    const revision = runtime.bus.store.getRevision();
    seconds = 2;
    frames.step();
    const current = runtime.bus.store.getGraph();
    const actual = cameraPoseAt(current.nodes[camera]!, runtime.registry.get("camera"), {
      ...runtime.bus.readScope(), graph: authoredGraph(current), registry: runtime.registry,
    })!;
    const offset = actual.eye.map((value, axis) => value - actual.lookAt[axis]!);
    expect(actual.eye[0]).toBe(2);
    expect(ballAt("+x").depth).toBeCloseTo(offset[0]! / Math.hypot(...offset), 4);
    expect(ballAt("+x").depth).not.toBe(before);
    expect(runtime.bus.store.getRevision()).toBe(revision);
    expect(current.nodes[camera]!.parameters["eye.x"]).toEqual(held);
    await act(async () => { fireEvent.pointerUp(canvas, { pointerId: 1 }); });
    runtime.dispose();
  });

  it("offers pan and zoom buttons for inspection and undoable Fly camera edits", async () => {
    const { runtime, graph, camera, renderer, looks, basis, frames } = await mountLook("renderer");
    const revision = runtime.bus.store.getRevision();
    fireEvent.click(screen.getByRole("button", { name: "Pan right" }));
    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    frames.step();
    const inspected = orbitPose(basis, looks.get(renderer) ?? DEFAULT_PREVIEW_ORBIT);
    expect(inspected.lookAt).not.toEqual(basis.lookAt);
    const reach = (pose: { eye: readonly number[]; lookAt: readonly number[] }) => Math.hypot(...pose.eye.map((v, i) => v - pose.lookAt[i]!));
    expect(reach(inspected)).toBeLessThan(reach(basis));
    expect(runtime.bus.store.getRevision()).toBe(revision);

    await act(async () => { fireEvent.click(screen.getByTestId("viewer-fly-camera")); });
    for (const action of ["Pan right", "Zoom in", "Zoom out"]) {
      const before = runtime.bus.store.getGraph();
      await act(async () => { fireEvent.click(screen.getByRole("button", { name: action })); });
      await waitFor(() => expect(runtime.bus.store.getGraph().nodes[camera]).not.toEqual(before.nodes[camera]));
      const after = runtime.bus.store.getGraph();
      expect(after.nodes[renderer]).toEqual(graph.nodes[renderer]);
      await act(async () => { await runtime.bus.execute("graph.undo", {}, runtime.invocation); });
      expect(runtime.bus.store.getGraph()).toEqual({ ...before, revision: runtime.bus.store.getRevision() });
    }
    runtime.dispose();
  });
  it.each(["renderer", "camera"] as const)("inspects an authored-camera %s through its shared Look without editing the camera", async (picture) => {
    const { runtime, graph, camera, renderer, nodeId, looks, orbits, frames, basis } = await mountLook(picture);
    const revision = runtime.bus.store.getRevision();
    expect(screen.getByTestId("viewer-axis-gizmo")).not.toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByTestId("viewer-axis-+x"));
    });
    frames.step();
    const pose = orbitPose(basis, looks.get(renderer) ?? DEFAULT_PREVIEW_ORBIT);
    const direction = pose.eye.map((value, index) => value - pose.lookAt[index]!);
    const length = Math.hypot(...direction);
    expect(direction[0]! / length).toBeCloseTo(1, 6);
    expect(direction[1]! / length).toBeCloseTo(0, 6);
    expect(direction[2]! / length).toBeCloseTo(0, 6);
    expect(looks.sinks[0]?.nodeId).toBe(renderer);
    expect(orbits.get(nodeId)).toBeUndefined();
    expect(ballAt("+x").depth).toBeGreaterThan(0.999);

    const before = ballAt("+x");
    const canvas = screen.getByTestId("viewer-canvas");
    canvas.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 800, height: 450, right: 800, bottom: 450, x: 0, y: 0, toJSON: () => "" }) as DOMRect;
    await act(async () => {
      fireEvent.pointerDown(canvas, { pointerId: 1, button: 0, clientX: 400, clientY: 200 });
      fireEvent.pointerMove(canvas, { pointerId: 1, clientX: 560, clientY: 200 });
      fireEvent.pointerUp(canvas, { pointerId: 1 });
    });
    frames.step();
    expect(Math.abs(ballAt("+x").left - before.left)).toBeGreaterThan(5);
    expect(runtime.bus.store.getRevision()).toBe(revision);
    expect(runtime.bus.store.getGraph()).toEqual(graph);

    // Flying explicitly switches the same instrument to the authored camera.
    await act(async () => {
      fireEvent.click(screen.getByTestId("viewer-fly-camera"));
    });
    expect(screen.getByTestId("viewer-axis-gizmo")).not.toBeNull();
    expect(looks.mode(renderer)).toBe("home");
    expect(runtime.bus.store.getRevision()).toBe(revision);
    expect(runtime.bus.store.getGraph()).toEqual(graph);
    await act(async () => {
      fireEvent.click(screen.getByTestId("viewer-axis-+x"));
    });
    await waitFor(() => expect(runtime.bus.store.getRevision()).toBeGreaterThan(revision));
    frames.step();
    const changed = runtime.bus.store.getGraph();
    expect(changed.nodes[camera]?.parameters["eye"]).not.toEqual(graph.nodes[camera]?.parameters["eye"]);
    expect(changed.nodes[renderer]).toEqual(graph.nodes[renderer]);
    expect(looks.mode(renderer)).toBe("home");
    expect(ballAt("+x").depth).toBeGreaterThan(0.999);
    await act(async () => {
      await runtime.bus.execute("graph.undo", {}, runtime.invocation);
    });
    frames.step();
    expect(runtime.bus.store.getGraph()).toEqual({ ...graph, revision: runtime.bus.store.getRevision() });
    expect(ballAt("+x").depth).toBeCloseTo(0, 5);
    runtime.dispose();
  });

  it.each(["level", "aimed"] as const)("reads world axes and snaps a rolled camera in a %s parent frame", async (frameMode) => {
    const origin = [7, -2, 4] as const;
    const heading = [2, 3, -4] as const;
    const eye = [1, 0.5, 3] as const;
    const lookAt = [0, 0, 0] as const;
    const { runtime, graph, camera, frames } = await mountLook("renderer", {
      origin: [...origin], heading: [...heading], frame: frameMode,
      eye: [...eye], lookAt: [...lookAt], roll: 67,
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("viewer-fly-camera"));
    });
    const frame = cameraFrame(origin, heading, frameMode);
    const worldEye = inCameraFrame(frame, eye);
    const worldTarget = inCameraFrame(frame, lookAt);
    const expected = cameraBasis(worldEye, worldTarget, 67);
    for (const [index, axis] of ["x", "y", "z"].entries()) {
      expect(ballAt(`+${axis}`).left).toBeCloseTo(50 + 36 * expected.right[index]!, 5);
      expect(ballAt(`+${axis}`).top).toBeCloseTo(50 - 36 * expected.up[index]!, 5);
    }
    await act(async () => {
      fireEvent.click(screen.getByTestId("viewer-axis-+x"));
    });
    await waitFor(() => expect(runtime.bus.store.getGraph()).not.toEqual(graph));
    frames.step();
    const stored = runtime.bus.store.getGraph().nodes[camera]!.parameters;
    const nextEye = inCameraFrame(frame, stored["eye"] as readonly [number, number, number]);
    const nextTarget = inCameraFrame(frame, stored["lookAt"] as readonly [number, number, number]);
    const direction = nextEye.map((value, index) => value - nextTarget[index]!);
    expect(direction[0]).toBeGreaterThan(0);
    expect(direction[1]).toBeCloseTo(0, 5);
    expect(direction[2]).toBeCloseTo(0, 5);
    expect(ballAt("+x").depth).toBeGreaterThan(0.999);
    expect(stored["origin"]).toEqual(origin);
    expect(stored["heading"]).toEqual(heading);
    expect(stored["roll"]).toBe(67);
    await act(async () => {
      await runtime.bus.execute("graph.undo", {}, runtime.invocation);
    });
    expect(runtime.bus.store.getGraph()).toEqual({ ...graph, revision: runtime.bus.store.getRevision() });
    runtime.dispose();
  });

  it("keeps driven camera channels intact and reports the orientation it could actually reach", async () => {
    const held: StoredParameter = {
      mode: "expression",
      bindings: {
        expression: { kind: "expression", source: "1" },
        static: { kind: "static", value: 99 },
      },
    };
    const { runtime, graph, camera, frames } = await mountLook("renderer", { "eye.x": held });
    await act(async () => {
      fireEvent.click(screen.getByTestId("viewer-fly-camera"));
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("viewer-axis-+z"));
    });
    await waitFor(() => expect(runtime.bus.store.getRevision()).toBeGreaterThan(graph.revision));
    frames.step();
    const moved = runtime.bus.store.getGraph().nodes[camera]!.parameters;
    expect(moved["eye.x"]).toEqual(held);
    expect(moved["eye"]).toEqual(graph.nodes[camera]!.parameters["eye"]);
    expect(moved["eye.y"]).toBe(0);
    expect(ballAt("+z").depth).toBeGreaterThan(0.9);
    expect(ballAt("+z").depth).toBeLessThan(0.999);
    await act(async () => {
      await runtime.bus.execute("graph.undo", {}, runtime.invocation);
    });
    expect(runtime.bus.store.getGraph()).toEqual({ ...graph, revision: runtime.bus.store.getRevision() });
    runtime.dispose();
  });

  it("⚑ IS ABSENT when the output declares no camera (§V986)", async () => {
    const { runtime } = await mount({ withCamera: false });
    // Not a greyed tripod pointing somewhere plausible: nothing. The sentence explaining
    // why lives on the bar's camera toggle (§T1311b(b)), which is the one control that
    // reads `viewCameraAbsentReason()` — a second copy here would be a second wording.
    expect(screen.queryByTestId("viewer-axis-gizmo")).toBeNull();
    // ...and the picture is still there, so this is a missing WIDGET and not a dead pane.
    expect(screen.getByTestId("viewer-picture")).not.toBeNull();
    runtime.dispose();
  });

  it("shows the world axes as the camera actually sees them", async () => {
    const { runtime } = await mount({ withCamera: true });
    expect(screen.getByTestId("viewer-axis-gizmo")).not.toBeNull();
    /*
     * Hand-derived, not re-derived: standing in the nave at z = −5.2 and looking toward
     * +z, world +Z points AWAY and −Z is the one facing you, while +X is on your LEFT
     * (right-handed, y up). If any of those were flipped the widget would be a mirror of
     * the picture, which is worse than no widget at all.
     */
    expect(ballAt("-z").depth).toBeGreaterThan(0.99);
    expect(ballAt("+z").depth).toBeLessThan(-0.99);
    expect(ballAt("+x").left).toBeLessThan(50);
    expect(ballAt("-x").left).toBeGreaterThan(50);
    // CSS top grows downward, so +Y above centre means a SMALLER top.
    expect(ballAt("+y").top).toBeLessThan(50);
    runtime.dispose();
  });

  it("⚑ FOLLOWS THE CAMERA — the claim a mounted-but-frozen widget fails", async () => {
    const { runtime, orbits, frames, nodeId } = await mount({ withCamera: true });
    const before = ballAt("-z");
    /*
     * Orbit through the pane's own gesture: a pointer drag on the canvas, which is what
     * `onOrbitDown`/`onOrbitMove` turn into store deltas. Nothing here writes the store
     * directly, because "the widget re-reads a store I poked" is a weaker claim than "the
     * widget follows the gesture the user makes".
     */
    const canvas = screen.getByTestId("viewer-canvas");
    canvas.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 800, height: 450, right: 800, bottom: 450, x: 0, y: 0, toJSON: () => "" }) as DOMRect;
    await act(async () => {
      fireEvent.pointerDown(canvas, { pointerId: 1, button: 0, clientX: 400, clientY: 200 });
      fireEvent.pointerMove(canvas, { pointerId: 1, clientX: 560, clientY: 200 });
      fireEvent.pointerUp(canvas, { pointerId: 1 });
    });
    frames.step();
    const after = ballAt("-z");
    // The camera turned, so the ball moved — and it moved BECAUSE the orbit did: the same
    // azimuth the store now holds is the one the widget drew.
    expect(orbits.get(nodeId)?.azimuth).not.toBe(0);
    expect(Math.abs(after.left - before.left)).toBeGreaterThan(5);
    // Turning about the UP axis swings the ball sideways, not up and down: the vertical
    // travel is a tenth of the horizontal at most. (Not zero — E68's home camera is tilted
    // slightly down, so a −Z ball off the horizon rises a little as it swings.) A widget
    // that "moved" by drifting or by re-laying-out would fail this and pass the line above.
    expect(Math.abs(after.top - before.top)).toBeLessThan(Math.abs(after.left - before.left) / 10);
    runtime.dispose();
  });

  it("⚑ CLICKING A BALL PUTS THE SHADER'S EYE ON THAT AXIS", async () => {
    const { runtime, frames, updates } = await mount({ withCamera: true });
    frames.step();
    updates.length = 0;
    await act(async () => {
      fireEvent.click(screen.getByTestId("viewer-axis-+x"));
    });
    frames.step();
    /*
     * The whole chain, and the assertion is on the NUMBER THE SHADER READS. `viewEye` is
     * pushed onto the viewport pass by `use-view-camera.ts`; if the click only entered
     * adjustable mode, or the delta were computed in the wrong convention, the eye would
     * still be down the hall and this would fail on the geometry rather than on a spy.
     */
    const pushed = updates.filter((update) => update.passId === VIEWPORT_PASS).at(-1);
    expect(pushed).toBeDefined();
    const values = pushed?.values as Record<string, readonly number[]>;
    const eye = values["viewEye"]!;
    const target = values["viewTarget"]!;
    const d = [eye[0]! - target[0]!, eye[1]! - target[1]!, eye[2]! - target[2]!];
    const length = Math.hypot(d[0]!, d[1]!, d[2]!);
    // Standing on +X, looking back at the hall's own target: the heading IS the world +X
    // axis. Exact, not a band — this is arithmetic, not a measurement (§V147).
    expect(d[0]! / length).toBeCloseTo(1, 6);
    expect(d[1]! / length).toBeCloseTo(0, 6);
    expect(d[2]! / length).toBeCloseTo(0, 6);
    // ...and the viewport pass is the ONLY thing that was written. View-only by having no
    // other pass id in scope (§T1311b(a)), re-asserted under this row's own gesture.
    expect(new Set(updates.map((update) => update.passId))).toEqual(new Set([VIEWPORT_PASS]));

    /*
     * And the instrument agrees with itself afterwards, which is the §V964 class: after
     * clicking +X, the +X ball is the one facing the viewer and the one drawn last. An
     * arrangement where the snap is right and the projection mirrored would pass every
     * assertion above and still point the user the wrong way.
     */
    expect(ballAt("+x").depth).toBeGreaterThan(0.999);
    const balls = [...document.querySelectorAll("[data-testid^='viewer-axis-+'],[data-testid^='viewer-axis--']")];
    expect(balls.at(-1)?.getAttribute("data-testid")).toBe("viewer-axis-+x");
    runtime.dispose();
  });
});
