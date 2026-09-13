// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import type { LoomBackend } from "@runtime/backend/index.ts";
import { createNativeOutputSession } from "./native-output-session.ts";
import { attachNativeOutput } from "./native-output.ts";
import { nativeOutputSender } from "./native-output-channel.ts";
vi.mock("./native-output.ts", () => ({ attachNativeOutput: vi.fn() }));
vi.mock("./native-output-channel.ts", () => ({ nativeOutputSender: vi.fn() }));
afterEach(() => { vi.resetAllMocks(); vi.unstubAllGlobals(); });
function setup() {
  const bitmap = { close: vi.fn() };
  const transfer = vi.fn(() => bitmap);
  vi.stubGlobal("OffscreenCanvas", class { transferToImageBitmap = transfer; });
  const bridge = { nativeOutput: true as const, open: vi.fn(async () => {}), close: vi.fn(async () => {}), resize: vi.fn(async () => {}), status: vi.fn() };
  const sender = { promise: Promise.resolve(), waitAvailable: vi.fn(async () => {}), available: true, sentFrames: 0, send: vi.fn(), close: vi.fn() };
  vi.mocked(nativeOutputSender).mockReturnValue(sender);
  const presentation = { presentedFrames: vi.fn(() => 1), update: vi.fn(), dispose: vi.fn() };
  vi.mocked(attachNativeOutput).mockReturnValue(presentation);
  const open = () => createNativeOutputSession({} as LoomBackend, bridge, { resourceId: "full-hd", size: [1920, 1080] }, "Stage");
  return { bridge, sender, presentation, transfer, bitmap, open };
}
it("uses an opaque transport ID and named full-resolution publisher; sends each frame once", async () => {
  const h = setup(); const session = h.open(); await session.ready;
  expect(h.bridge.open).toHaveBeenCalledWith(expect.stringMatching(/^loom-native-output-/), 1920, 1080, "Stage");
  session.pump(); session.pump(); expect(h.transfer).toHaveBeenCalledOnce();
  h.sender.available = false; h.presentation.presentedFrames.mockReturnValue(2);
  session.pump(); expect(h.transfer).toHaveBeenCalledOnce();
  h.sender.available = true; session.pump(); expect(h.transfer).toHaveBeenCalledTimes(2);
  const resizing = session.update({ resourceId: "other", size: [1280, 720] });
  session.pump(); expect(h.transfer).toHaveBeenCalledTimes(2);
  await resizing;
  expect(h.presentation.update).toHaveBeenCalledWith({ resourceId: "other", size: [1280, 720] });
  expect(h.bridge.resize).toHaveBeenCalledWith(expect.any(String), 1280, 720);
  expect(h.bridge.open).toHaveBeenCalledOnce();
  await session.close(); session.pump(); expect(h.transfer).toHaveBeenCalledTimes(2);
  expect(h.presentation.dispose).toHaveBeenCalledOnce();
});
it("close during open awaits acquisition and native drainage, without attaching a late canvas", async () => {
  const h = setup(); let opened!: () => void; let drained!: () => void;
  h.bridge.open.mockReturnValue(new Promise(resolve => { opened = resolve; }));
  h.bridge.close.mockReturnValue(new Promise(resolve => { drained = resolve; }));
  const session = h.open(); const closing = session.close();
  expect(session.close()).toBe(closing);
  expect(h.bridge.close).not.toHaveBeenCalled();
  opened(); await session.ready;
  expect(attachNativeOutput).not.toHaveBeenCalled();
  let done = false; void closing.then(() => { done = true; });
  await Promise.resolve(); expect(done).toBe(false);
  drained(); await closing; expect(done).toBe(true);
});
it("failed opening still cleans its exact session; frame transfer failures release the bitmap", async () => {
  const h = setup(); h.bridge.open.mockRejectedValueOnce(new Error("duplicate name"));
  const failed = h.open(); await expect(failed.ready).rejects.toThrow("duplicate name");
  await failed.close(); expect(h.bridge.close).toHaveBeenCalledOnce();
  const session = h.open(); await session.ready;
  h.sender.send.mockImplementation(() => { throw new Error("transfer failed"); });
  expect(() => session.pump()).toThrow("transfer failed");
  expect(h.bitmap.close).toHaveBeenCalledOnce(); await session.close();
});
