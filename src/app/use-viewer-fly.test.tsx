// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { installDomStubs } from "@ui/testing/install-dom-stubs.ts";
import { alice, contextFor, createHarness } from "@domain/commands/test-support.ts";
import { KEYMAP_CONTEXT_ATTRIBUTE } from "@editor/keymap/context.ts";
import { KeymapProvider } from "@editor/keymap/keymap-provider.tsx";
import { createKeymapStore } from "@editor/keymap/store.ts";
import { DEFAULT_BINDINGS } from "@editor/keymap/defaults.ts";
import { createPreviewOrbitStore } from "@editor/viewer/preview-orbit-store.ts";
import type { NodeId } from "@domain/types/ids.ts";
import type { ResolvedOutput } from "@compiler/types.ts";
import type { LoomBackend } from "@runtime/backend/index.ts";
import type { UniformUpdate } from "@runtime/backend/backend-types.ts";
import type { OrbitCameraBasis } from "@runtime/previews/index.ts";
import { useViewCameraOverride } from "./use-view-camera.ts";
import { useViewerFly } from "./use-viewer-fly.ts";

/**
 * §T1311b(b) — FLY, ASSERTED AS A MOVED CAMERA rather than as a wired call site.
 *
 * §V998 is the reason this file exists in this shape. "Wired" has two halves and each looks
 * finished from its own side; this row was mis-scoped three times by greps that answered
 * "is it connected" instead of "does it work". So the harness below runs the WHOLE chain a
 * key press actually travels — the keymap's binding table, the DOM event, the gesture's
 * integration, the inspection store, and `use-view-camera`'s push — and every assertion is
 * on `viewEye`: the number the shader reads to build its ray. Nothing here asserts that a
 * handler was called.
 *
 * The test that carries the most weight is the REBIND one. It is the only thing that can
 * distinguish "the keymap owns which key means forward" from "the component happens to
 * compare against `w`", and the two are indistinguishable in every other test in this file.
 */

const NODE = "temple" as NodeId;
const VIEWPORT_PASS = "temple#viewport:out";
/** E68's shape: standing in the nave at z = −5.2, looking down the hall toward +z. */
const HOME_EYE: readonly [number, number, number] = [0, 1.62, -5.2];
const HOME_TARGET: readonly [number, number, number] = [0, 1.9, 6];
const FOV = 1.0638;

const BASIS: OrbitCameraBasis = { eye: HOME_EYE, lookAt: HOME_TARGET, fovY: FOV, aspect: 16 / 9 };

const viewportRow = (): ResolvedOutput =>
  ({
    nodeId: NODE,
    portId: "out#view",
    resourceId: "viewport:temple:out",
    resourceKind: "target",
    size: [960, 540],
    format: "rgba8unorm",
    space: "linear",
    temporal: false,
    viewCamera: { passId: VIEWPORT_PASS, eye: HOME_EYE, lookAt: HOME_TARGET, fovY: FOV, aspect: 16 / 9 },
  }) as unknown as ResolvedOutput;

/**
 * rAF, driven by hand. jsdom's own fires on a timer, which makes "how far did the camera
 * fly" a function of how long the test machine took — and this project does not accept a
 * tolerance band where an exact value is available (§V147). Stepping it manually makes the
 * elapsed time a CONSTANT, so the distance flown below is arithmetic.
 */
function manualFrames() {
  const callbacks: FrameRequestCallback[] = [];
  let at = 1000;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback): number => {
    callbacks.push(callback);
    return callbacks.length;
  });
  vi.stubGlobal("cancelAnimationFrame", () => {});
  return {
    /** Advance one frame of exactly `ms`, running whatever was queued. */
    step(ms: number): void {
      at += ms;
      const due = callbacks.splice(0, callbacks.length);
      act(() => {
        for (const callback of due) callback(at);
      });
    },
  };
}

function recordingBackend() {
  const updates: UniformUpdate[] = [];
  return {
    updates,
    backend: {
      updateUniforms(update: UniformUpdate) {
        updates.push(update);
      },
    } as unknown as LoomBackend,
  };
}

function Pane(props: {
  orbits: ReturnType<typeof createPreviewOrbitStore>;
  backend: LoomBackend;
  basis: OrbitCameraBasis | null;
}) {
  const fly = useViewerFly({ orbits: props.orbits, nodeId: NODE, basis: props.basis });
  useViewCameraOverride({ backend: props.backend, output: viewportRow(), orbits: props.orbits });
  return (
    <div
      {...{ [KEYMAP_CONTEXT_ATTRIBUTE]: "viewer" }}
      data-testid="viewer-pane"
      tabIndex={-1}
      onKeyDown={fly.onKeyDown}
      onKeyUp={fly.onKeyUp}
      onBlur={fly.onBlur}
      data-viewer-flying={fly.flying ? "true" : undefined}
    >
      <select aria-label="output">
        <option>out</option>
      </select>
    </div>
  );
}

function setup(options?: { basis?: OrbitCameraBasis | null; overrides?: Record<string, string | null> }) {
  const { bus } = createHarness();
  const dispatched: string[] = [];
  const realExecute = bus.execute.bind(bus);
  vi.spyOn(bus, "execute").mockImplementation((name, input, context) => {
    dispatched.push(name);
    return realExecute(name, input, context);
  });
  const keymapStore = createKeymapStore({ defaults: DEFAULT_BINDINGS, storage: null, platform: "other" });
  for (const [bindingId, keys] of Object.entries(options?.overrides ?? {})) {
    const result = keymapStore.setOverride(bindingId, keys);
    // A rebind the store refused would make the assertion below pass for the wrong reason
    // — the key would be unbound rather than moved (§V968: validate the detector).
    if (result.status !== "ok") throw new Error(`${bindingId}: ${result.status}`);
  }
  const orbits = createPreviewOrbitStore();
  const { backend, updates } = recordingBackend();
  render(
    <KeymapProvider bus={bus} store={keymapStore} invocationContext={contextFor(alice)}>
      <Pane orbits={orbits} backend={backend} basis={options?.basis === undefined ? BASIS : options.basis} />
    </KeymapProvider>,
  );
  return { orbits, updates, dispatched, pane: screen.getByTestId("viewer-pane") };
}

/** The last eye the shader was handed. */
function eye(updates: readonly UniformUpdate[]): readonly number[] {
  const last = updates[updates.length - 1];
  if (last === undefined) throw new Error("nothing was ever pushed to the viewport pass");
  return last.values["viewEye"] as readonly number[];
}

/** How far down the hall (+z, the home view direction) the camera has travelled. */
function travelled(updates: readonly UniformUpdate[]): number {
  return eye(updates)[2]! - HOME_EYE[2];
}

beforeAll(installDomStubs);
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("holding a fly key moves the camera the shader renders from", () => {
  it("⚑ flies FORWARD down the view direction, by the distance the elapsed time buys", () => {
    const frames = manualFrames();
    const { updates, pane } = setup();
    const before = eye(updates);
    expect(before).toEqual([...HOME_EYE]);

    fireEvent.keyDown(pane, { key: "w", code: "KeyW" });
    // The first frame only establishes the clock — there is no elapsed time yet, and a
    // camera that jumped on frame one would be integrating against an invented dt.
    frames.step(16);
    expect(travelled(updates)).toBe(0);
    // Half a second at 1.1 radii/s down an 11.2-unit hall: 6.16 units toward the altar.
    for (let frame = 0; frame < 5; frame += 1) frames.step(100);
    expect(travelled(updates)).toBeCloseTo(0.5 * 1.1 * 11.2, 6);
    // The target came with it — this is a flight, not a dolly that converges and stops.
    const target = updates[updates.length - 1]?.values["viewTarget"] as readonly number[];
    expect(target[2]! - HOME_TARGET[2]).toBeCloseTo(0.5 * 1.1 * 11.2, 6);
  });

  it("keeps flying while the key is held and stops dead when it is released", () => {
    const frames = manualFrames();
    const { updates, pane } = setup();
    fireEvent.keyDown(pane, { key: "w", code: "KeyW" });
    frames.step(16);
    frames.step(100);
    const afterOne = travelled(updates);
    frames.step(100);
    const afterTwo = travelled(updates);
    // A held key that only moved once is the auto-repeat bug this gesture exists to avoid.
    expect(afterTwo).toBeCloseTo(afterOne * 2, 6);

    fireEvent.keyUp(pane, { key: "w", code: "KeyW" });
    frames.step(100);
    frames.step(100);
    expect(travelled(updates)).toBeCloseTo(afterTwo, 6);
  });

  it("caps one frame rather than teleporting when a backgrounded tab comes back", () => {
    /*
     * A browser stops delivering animation frames to a hidden tab, so the first frame after
     * the user returns can carry seconds of elapsed time. Integrated raw, a key left held
     * during a five-second alt-tab would put the camera a quarter of a mile away and read
     * as the viewer losing the picture. The cap is a tenth of a second — three frames'
     * worth, so it never shows on a merely slow frame.
     */
    const frames = manualFrames();
    const { updates, pane } = setup();
    fireEvent.keyDown(pane, { key: "w", code: "KeyW" });
    frames.step(16);
    frames.step(5000);
    expect(travelled(updates)).toBeCloseTo(0.1 * 1.1 * 11.2, 6);
  });

  it("releases everything when the pane loses focus — a held key must not survive an alt-tab", () => {
    const frames = manualFrames();
    const { updates, pane } = setup();
    fireEvent.keyDown(pane, { key: "w", code: "KeyW" });
    frames.step(16);
    frames.step(100);
    const parked = travelled(updates);
    expect(parked).toBeGreaterThan(0);
    fireEvent.blur(pane);
    frames.step(100);
    frames.step(100);
    expect(travelled(updates)).toBeCloseTo(parked, 6);
  });

  it("throttles on shift rather than on a seventh binding", () => {
    const frames = manualFrames();
    const cruise = setup();
    fireEvent.keyDown(cruise.pane, { key: "w", code: "KeyW" });
    frames.step(16);
    frames.step(100);
    const slow = travelled(cruise.updates);
    cleanup();

    const fast = setup();
    fireEvent.keyDown(fast.pane, { key: "W", code: "KeyW", shiftKey: true });
    frames.step(16);
    frames.step(100);
    expect(travelled(fast.updates)).toBeCloseTo(slow * 4, 6);
  });

  it("⚑ DOES NOT ALSO DISPATCH THE BINDING — one press is one movement", () => {
    /*
     * The gesture and the binding name the same six keys, so the keymap would fire
     * `viewer.fly`'s discrete step on top of every held frame — and auto-repeat would make
     * that second movement arrive in stutters. Consuming the event is what keeps them from
     * fighting, and this asserts the outcome (nothing dispatched) rather than the mechanism.
     */
    const frames = manualFrames();
    const { dispatched, pane } = setup();
    fireEvent.keyDown(pane, { key: "w", code: "KeyW", bubbles: true });
    frames.step(16);
    frames.step(100);
    expect(dispatched).toEqual([]);
  });

  it("⚑ FOLLOWS A REBIND — the keymap owns which key means forward, not this component", () => {
    /*
     * THE TEST THAT DISTINGUISHES DATA FROM AN `if`. §V52 says a key's meaning is data; a
     * gesture that integrated `event.key === "w"` would pass every other test in this file
     * and fail only here, for the user who moved forward onto `i` and found their viewer
     * still flying on `w`.
     */
    const frames = manualFrames();
    const { updates, pane } = setup({ overrides: { "viewer.flyForward": "i" } });
    fireEvent.keyDown(pane, { key: "w", code: "KeyW" });
    frames.step(16);
    frames.step(100);
    expect(travelled(updates)).toBe(0);

    fireEvent.keyDown(pane, { key: "i", code: "KeyI" });
    frames.step(16);
    frames.step(100);
    expect(travelled(updates)).toBeGreaterThan(0);
  });

  it("leaves the output picker's own keys alone", () => {
    const frames = manualFrames();
    const { updates } = setup();
    fireEvent.keyDown(screen.getByLabelText("output"), { key: "d", code: "KeyD", bubbles: true });
    frames.step(16);
    frames.step(100);
    // `d` is "fly right" and it is also the first letter of half the options in a picker.
    expect(travelled(updates)).toBe(0);
  });

  it("is inert on an output that declared no camera — the refusal, as stillness", () => {
    const frames = manualFrames();
    const { updates, pane } = setup({ basis: null });
    fireEvent.keyDown(pane, { key: "w", code: "KeyW" });
    frames.step(16);
    frames.step(100);
    // And it never entered adjustable either: a mode toggled by a key that moves nothing
    // would leave the camera control lit over a camera that cannot be flown.
    expect(travelled(updates)).toBe(0);
    expect(pane.getAttribute("data-viewer-flying")).toBeNull();
  });

  it("turns the camera on by itself, so `h` returns from a flight exactly as from a drag", () => {
    const frames = manualFrames();
    const { orbits, updates, pane } = setup();
    expect(orbits.mode(NODE)).toBe("home");
    fireEvent.keyDown(pane, { key: "w", code: "KeyW" });
    frames.step(16);
    frames.step(100);
    expect(orbits.mode(NODE)).toBe("adjustable");
    expect(travelled(updates)).toBeGreaterThan(0);
    // §T656's one operation: leaving adjustable IS the reset, and the flight goes with it.
    act(() => {
      orbits.setMode(NODE, "home");
    });
    expect(eye(updates)).toEqual([...HOME_EYE]);
  });
});
