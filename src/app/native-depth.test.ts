import { afterEach, describe, expect, it, vi } from "vitest";
import type { LoomBackend, MediaSource } from "@runtime/backend/backend-types.ts";
import type { AcquisitionState, ModelAcquisition } from "@runtime/models/model-acquisition.ts";
import { DEPTH_ACCURATE, DEPTH_PRO2_COREML_B, DEPTH_PRO2_COREML_S } from "@runtime/models/model-catalogue.ts";
import { scratchResourceId } from "@compiler/resources.ts";
import { DEPTH_COREML_UNAVAILABLE, DEPTH_INPUT_KEY } from "@nodes/definitions/index.ts";
import { createNativeVisionSource, type DesktopDepthBridge, type DesktopDepthProgress } from "@devices/native-inference.ts";
import { DEPTH_NATIVE_SOURCES, withNativeDepthAcquisition } from "./native-depth.ts";
import { createNativeVisionSources } from "./native-vision-sources.ts";

vi.mock("@devices/native-inference.ts", async (importOriginal) => ({
  ...await importOriginal<typeof import("@devices/native-inference.ts")>(), createNativeVisionSource: vi.fn(),
}));

/**
 * T1818b — THE PAGE'S HALF OF CORE ML DEPTH.
 *
 * The desktop service downloads, verifies and runs Apple's package; the page decides WHEN
 * (a person's consent in the node's notice) and WHICH (the node's model and box). These pin
 * that decision: a browser is told why it cannot, a desktop app is told nothing is
 * downloaded until asked, and the session that opens is the node's model, function and box.
 */

const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

function fakeBridge(overrides: Partial<DesktopDepthBridge> = {}) {
  let progress: ((value: DesktopDepthProgress) => void) | undefined;
  let finish: (() => void) | undefined;
  const bridge: DesktopDepthBridge = {
    probe: vi.fn(async () => ({ available: true, models: [
      { id: "depthpro2-s-coreml" as const, bytes: DEPTH_PRO2_COREML_S.bytes, cached: false },
      { id: "depthpro2-b-coreml" as const, bytes: DEPTH_PRO2_COREML_B.bytes, cached: true },
    ] })),
    prepare: vi.fn((_id, onProgress) => new Promise<void>((resolve) => { progress = onProgress; finish = resolve; })),
    open: vi.fn(async (name: string) => name),
    close: vi.fn(async () => {}),
    status: vi.fn(async () => ({ frames: 0, busy: false, error: null })),
    reset: vi.fn(async () => {}),
    ...overrides,
  };
  return { bridge, progress: (value: DesktopDepthProgress) => progress!(value), finish: () => finish!() };
}

function browserAcquisition(): ModelAcquisition {
  return { stateOf: vi.fn(() => ({ kind: "absent" as const })), refresh: vi.fn(async () => ({ kind: "absent" as const })),
    acquire: vi.fn(async () => new ArrayBuffer(8)), cancel: vi.fn(), uninstall: vi.fn(async () => {}), list: vi.fn(async () => []) };
}

describe("Core ML acquisition through the desktop app (T1818b)", () => {
  it("tells a browser why it cannot, and never asks the browser cache for a package", async () => {
    const browser = browserAcquisition();
    const states: Array<[string, AcquisitionState]> = [];
    const acquisition = withNativeDepthAcquisition(browser, (id, state) => states.push([id, state]), () => undefined);
    expect(await acquisition.refresh(DEPTH_PRO2_COREML_S)).toEqual({ kind: "failed", reason: DEPTH_COREML_UNAVAILABLE });
    expect(await acquisition.acquire(DEPTH_PRO2_COREML_S)).toBeUndefined();
    expect(states.at(-1)).toEqual(["depthpro2-s-coreml", { kind: "failed", reason: DEPTH_COREML_UNAVAILABLE }]);
    expect(browser.refresh).not.toHaveBeenCalled();
    expect(browser.acquire).not.toHaveBeenCalled();
    // Every other model is the browser's, untouched.
    await acquisition.acquire(DEPTH_ACCURATE);
    expect(browser.acquire).toHaveBeenCalledWith(DEPTH_ACCURATE);
  });

  it("reads absent or ready from the service, and downloads only when asked, with real progress", async () => {
    const fake = fakeBridge();
    const states: Array<[string, AcquisitionState]> = [];
    const acquisition = withNativeDepthAcquisition(browserAcquisition(), (id, state) => states.push([id, state]), () => fake.bridge);
    expect(await acquisition.refresh(DEPTH_PRO2_COREML_S)).toEqual({ kind: "absent" });
    expect(await acquisition.refresh(DEPTH_PRO2_COREML_B)).toEqual({ kind: "ready" });
    expect(fake.bridge.prepare).not.toHaveBeenCalled();

    const acquired = acquisition.acquire(DEPTH_PRO2_COREML_S);
    await flush();
    expect(fake.bridge.prepare).toHaveBeenCalledWith("depthpro2-s-coreml", expect.any(Function));
    fake.progress({ phase: "downloading", received: 1000, total: DEPTH_PRO2_COREML_S.bytes });
    expect(acquisition.stateOf("depthpro2-s-coreml")).toEqual({ kind: "downloading", received: 1000, total: DEPTH_PRO2_COREML_S.bytes });
    // A second press and a probe while it runs neither start another nor reset the bar.
    void acquisition.acquire(DEPTH_PRO2_COREML_S);
    expect(await acquisition.refresh(DEPTH_PRO2_COREML_S)).toMatchObject({ kind: "downloading", received: 1000 });
    fake.progress({ phase: "compiling" });
    expect(acquisition.stateOf("depthpro2-s-coreml")).toMatchObject({ received: DEPTH_PRO2_COREML_S.bytes });
    fake.finish();
    expect(await acquired).toBeUndefined();
    expect(acquisition.stateOf("depthpro2-s-coreml")).toEqual({ kind: "ready" });
    expect(fake.bridge.prepare).toHaveBeenCalledTimes(1);
  });

  it("reports the service's own refusal and a failed download as failed, with its words", async () => {
    const refusing = fakeBridge({ probe: vi.fn(async () => ({ available: false, reason: "Core ML needs macOS 15 or later.", models: [] })) });
    const acquisition = withNativeDepthAcquisition(browserAcquisition(), () => {}, () => refusing.bridge);
    expect(await acquisition.refresh(DEPTH_PRO2_COREML_S)).toEqual({ kind: "failed", reason: "Core ML needs macOS 15 or later." });
    const broken = fakeBridge({ prepare: vi.fn(async () => { throw new Error("weight.bin failed its SHA-256 check"); }) });
    const second = withNativeDepthAcquisition(browserAcquisition(), () => {}, () => broken.bridge);
    await second.acquire(DEPTH_PRO2_COREML_S);
    expect(second.stateOf("depthpro2-s-coreml")).toEqual({ kind: "failed", reason: "weight.bin failed its SHA-256 check" });
  });
});

describe("Core ML depth sessions (T1818b)", () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.mocked(createNativeVisionSource).mockReset(); });

  it("shows pending (R = −1) before the first result, which the result pass publishes as 0.5", () => {
    const halves = new Uint16Array(DEPTH_NATIVE_SOURCES.empty([2, 1]).buffer);
    expect([...halves]).toEqual([0xbc00, 0, 0, 0x3c00, 0xbc00, 0, 0, 0x3c00]);
  });

  it("opens the node's model and function at its box, named for the depth service, and reopens on a new box", async () => {
    const fake = fakeBridge();
    vi.stubGlobal("window", { loomDesktop: { depth: fake.bridge } });
    const media = new Map<string, MediaSource>();
    const backend = { registerMediaSource: (id: string, source: MediaSource) => { media.set(id, source); return () => media.delete(id); } } as unknown as LoomBackend;
    const sessions: Array<{ close: ReturnType<typeof vi.fn> }> = [];
    vi.mocked(createNativeVisionSource).mockImplementation((_backend, bridge, options) => {
      void bridge.open(`${options.namePrefix}x`, options.inputSize[0], options.inputSize[1], options.outputSize[0], options.outputSize[1], async () => {});
      const session = { source: { currentFrame: vi.fn(() => undefined) }, ready: Promise.resolve(), available: true,
        run: vi.fn(async () => ({ session: "x", sequence: 0, width: 4, height: 2, coverage: 1 })), close: vi.fn(async () => {}) };
      sessions.push(session);
      return session;
    });
    const sources = createNativeVisionSources(DEPTH_NATIVE_SOURCES);
    const target = (session: string, box: readonly [number, number]) => ({ nodeId: "depth", size: [1920, 1080] as const, minIntervalSeconds: 0,
      input: { key: DEPTH_INPUT_KEY, size: box, session } });
    sources.track([target("depthpro2-s-coreml|res_854x480", [854, 480])], backend);
    await flush();
    expect(vi.mocked(createNativeVisionSource).mock.calls[0]![2]).toMatchObject({
      inputResourceId: scratchResourceId("depth", DEPTH_INPUT_KEY), inputSize: [854, 480], outputSize: [1920, 1080], namePrefix: "loom-native-depth-" });
    expect(fake.bridge.open).toHaveBeenCalledWith("loom-native-depth-x", "depthpro2-s-coreml", "res_854x480", 854, 480, 1920, 1080, expect.any(Function));
    // The first frame the node shows is pending, in rgbaf16.
    expect(media.values().next().value?.currentFrame()?.bytes?.length).toBe(1920 * 1080 * 8);
    sources.track([target("depthpro2-s-coreml|res_1280x720", [1280, 720])], backend);
    await flush();
    expect(sessions[0]!.close).toHaveBeenCalledOnce();
    expect(fake.bridge.open).toHaveBeenLastCalledWith("loom-native-depth-x", "depthpro2-s-coreml", "res_1280x720", 1280, 720, 1920, 1080, expect.any(Function));
    sources.dispose();
  });

  it("says on the node that only the desktop app runs it, where there is no depth service", () => {
    vi.stubGlobal("window", {});
    const sources = createNativeVisionSources(DEPTH_NATIVE_SOURCES);
    const backend = { registerMediaSource: vi.fn(() => () => {}) } as unknown as LoomBackend;
    sources.track([{ nodeId: "depth", size: [4, 2], minIntervalSeconds: 0, input: { key: DEPTH_INPUT_KEY, size: [854, 480], session: "depthpro2-s-coreml|res_854x480" } }], backend);
    expect(sources.diagnostics()).toEqual([{ severity: "warning", code: "depth.native.refused", message: DEPTH_COREML_UNAVAILABLE, nodeId: "depth" }]);
    expect(createNativeVisionSource).not.toHaveBeenCalled();
  });
});
