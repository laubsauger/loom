// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { LoomBackend } from "@runtime/backend/index.ts";
import { attachNativeOutput, desktopOutputBridge } from "@devices/native-output.ts";
import type { NativeOutputSelection } from "@devices/native-output.ts";
import { nativeOutputSender } from "@devices/native-output-channel.ts";
import { useNativeOutput } from "./use-native-output.ts";
import { createHarness } from "@domain/commands/test-support.ts";
import { drainNativeViewerOutputs } from "./native-viewer-outputs.ts";
import { renderRangeHolderFor } from "./render-range.ts";

vi.mock("@devices/native-output.ts", () => ({ attachNativeOutput: vi.fn(), desktopOutputBridge: vi.fn() }));
vi.mock("@devices/native-output-channel.ts", () => ({ nativeOutputSender: vi.fn() }));
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.resetAllMocks(); });

function setup() {
  const { bus } = createHarness();
  let opened!: () => void;
  const bridge = { nativeOutput: true as const, open: vi.fn(() => new Promise<void>(resolve => { opened = resolve; })),
    close: vi.fn(async () => {}), resize: vi.fn(async () => {}),
    status: vi.fn(async () => ({ copied: 0, dropped: 0, error: null })) };
  vi.mocked(desktopOutputBridge).mockReturnValue(bridge);
  const sender = { promise: Promise.resolve(), waitAvailable: vi.fn(async () => {}), sentFrames: 0, available: true, send: vi.fn(), close: vi.fn() };
  vi.mocked(nativeOutputSender).mockReturnValue(sender);
  const owner = { presentedFrames: vi.fn(() => 0), update: vi.fn(), dispose: vi.fn() };
  vi.mocked(attachNativeOutput).mockReturnValue(owner);
  vi.stubGlobal("OffscreenCanvas", class {
    width: number; height: number;
    constructor(width: number, height: number) { this.width = width; this.height = height; }
  });
  vi.stubGlobal("requestAnimationFrame", vi.fn(() => 1));
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  const backend = {} as LoomBackend;
  const first: NativeOutputSelection = { resourceId: "first", size: [1280, 720] };
  const view = renderHook(({ selection, documentIdentity }) => useNativeOutput(backend, selection, documentIdentity, bus), {
    initialProps: { selection: first as NativeOutputSelection | null, documentIdentity: "document" },
  });
  let opening!: Promise<void>;
  act(() => { opening = view.result.current.toggle(); });
  const finish = () => act(async () => { opened(); await opening; });
  return { bridge, sender, owner, view, finish, backend, bus, open: () => opened(), settled: () => opening };
}

it("attaches the current selection when it changes during native window acquisition", async () => {
  const h = setup();
  const next: NativeOutputSelection = { resourceId: "second", size: [1920, 1080] };
  h.view.rerender({ selection: next, documentIdentity: "document" });
  await h.finish();
  expect(attachNativeOutput).toHaveBeenCalledWith(h.backend, next, expect.objectContaining({ width: 1920, height: 1080 }));
  expect(h.bridge.resize).toHaveBeenCalledWith(expect.any(String), 1920, 1080);
  expect(h.view.result.current.ready).toBe(true);
});

it("distinguishes pending acquisition from an attached presentation with no frames", async () => {
  vi.useFakeTimers();
  const h = setup();
  await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
  expect(h.view.result.current.status).toBe("Acquiring native output window and frame channel");
  expect(h.view.result.current.ready).toBe(false);
  expect(h.owner.presentedFrames).not.toHaveBeenCalled();
  await h.finish();
  await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
  expect(h.view.result.current.status).toContain("0 rendered, 0 transferred");
  expect(h.view.result.current.ready).toBe(true);
});

it("does not attach a vanished selection after native acquisition completes", async () => {
  const h = setup();
  h.view.rerender({ selection: null, documentIdentity: "document" });
  await h.finish();
  expect(attachNativeOutput).not.toHaveBeenCalled();
  expect(h.sender.close).toHaveBeenCalledOnce();
  expect(h.bridge.close).toHaveBeenCalled();
  expect(h.view.result.current.active).toBe(false);
});

it("does not resurrect an output from a previous document", async () => {
  const h = setup();
  h.view.rerender({ selection: { resourceId: "second", size: [1920, 1080] }, documentIdentity: "replacement" });
  await h.finish();
  expect(attachNativeOutput).not.toHaveBeenCalled();
  expect(h.sender.close).toHaveBeenCalledOnce();
  expect(h.view.result.current.active).toBe(false);
});

it("retires the acquired surface and reports a failed acquisition resize", async () => {
  const h = setup();
  h.bridge.resize.mockRejectedValueOnce(new Error("Native resize failed"));
  h.view.rerender({ selection: { resourceId: "second", size: [1920, 1080] }, documentIdentity: "document" });
  await h.finish();
  expect(h.owner.dispose).toHaveBeenCalledOnce();
  expect(h.sender.close).toHaveBeenCalledOnce();
  expect(h.view.result.current.ready).toBe(false);
  expect(h.view.result.current.status).toContain("Native resize failed");
});

it("does not start pumping when closed during acquisition resize", async () => {
  const h = setup();
  let resized!: () => void;
  h.bridge.resize.mockImplementationOnce(() => new Promise<void>(resolve => { resized = resolve; }));
  h.view.rerender({ selection: { resourceId: "second", size: [1920, 1080] }, documentIdentity: "document" });
  // Acquisition reaches resize, but remains pending until after the user closes.
  await act(async () => { h.open(); });
  expect(h.bridge.resize).toHaveBeenCalled();
  await act(async () => { await h.view.result.current.toggle(); resized(); await h.settled(); });
  expect(h.owner.dispose).toHaveBeenCalledOnce();
  expect(requestAnimationFrame).not.toHaveBeenCalled();
  expect(h.view.result.current.ready).toBe(false);
});

it("awaits pending acquisition and native GPU release before offline export", async () => {
  const h = setup();
  let release!: () => void;
  h.bridge.close.mockImplementation(() => new Promise<void>(resolve => { release = resolve; }));
  let preflight!: Promise<void>;
  let drained = false;
  act(() => { preflight = drainNativeViewerOutputs(h.backend).then(() => { drained = true; }); });
  expect(h.sender.close).toHaveBeenCalledOnce();
  expect(h.bridge.close).not.toHaveBeenCalled();
  expect(h.view.result.current.active).toBe(false);
  expect(h.view.result.current.status).toContain("stopped for offline export");
  await h.finish();
  expect(attachNativeOutput).not.toHaveBeenCalled();
  expect(h.bridge.close).toHaveBeenCalledOnce();
  expect(drained).toBe(false);
  await act(async () => { release(); await preflight; });
  expect(drained).toBe(true);
});

it("cannot restart the viewer publisher while export is busy", async () => {
  const h = setup(); await h.finish();
  let busy = true;
  renderRangeHolderFor(h.bus).current = { busy: () => busy, render: vi.fn() };
  await act(async () => { await drainNativeViewerOutputs(h.backend); });
  await act(async () => { await h.view.result.current.toggle(); });
  expect(h.bridge.open).toHaveBeenCalledOnce();
  expect(h.view.result.current.status).toContain("unavailable during offline export");
  busy = false;
  h.bridge.open.mockResolvedValueOnce();
  await act(async () => { await h.view.result.current.toggle(); });
  expect(h.bridge.open).toHaveBeenCalledTimes(2);
  expect(h.view.result.current.ready).toBe(true);
});

it("pane unmount cannot hide a failed native release from the export preflight", async () => {
  const h = setup(); await h.finish();
  h.bridge.close.mockRejectedValueOnce(new Error("GPU release failed"));
  h.view.unmount();
  await expect(drainNativeViewerOutputs(h.backend)).rejects.toThrow("GPU release failed");
  await expect(drainNativeViewerOutputs(h.backend)).rejects.toThrow("GPU release failed");
});
