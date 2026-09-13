// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
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
        <ViewerPane compiled={compiled} graph={graph} backend={backend} orbits={orbits} />
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

describe("the viewer's corner gizmo", () => {
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
