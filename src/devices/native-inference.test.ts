import { afterEach, expect, it, vi } from "vitest";
import type { LoomBackend } from "@runtime/backend/index.ts";
import { createNativeVisionSource, type DesktopVisionBridge, type NativeVisionMetadata } from "./native-inference.ts";

const state = vi.hoisted(() => ({ sender: undefined as unknown }));
vi.mock("./native-output-channel.ts", () => ({ nativeOutputSender: () => state.sender }));
afterEach(() => vi.unstubAllGlobals());
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { resolve, reject, promise };
}
function harness() {
  const ack = deferred<void>();
  let busy = false;
  const sender = { promise: Promise.resolve(), available: true, send: vi.fn(() => { busy = true; }),
    waitAvailable: () => busy ? ack.promise : Promise.resolve(), close: vi.fn(() => ack.reject(new Error("closed"))) };
  state.sender = sender;
  const bitmap = { close: vi.fn() };
  const transfer = vi.fn(() => bitmap);
  vi.stubGlobal("OffscreenCanvas", class { transferToImageBitmap = transfer; });
  let consume!: (frame: VideoFrame, metadata: NativeVisionMetadata) => Promise<void>;
  let name = "";
  const bridge: DesktopVisionBridge = {
    open: vi.fn(async (id, _w, _h, _ow, _oh, fn) => { name = id; consume = fn; return id; }),
    close: vi.fn(async () => undefined), status: vi.fn(async () => ({ frames: 1, busy: false, error: null })),
  };
  const dispose = vi.fn();
  const present = vi.fn(() => ({ dispose, describe: () => ({ presentedFrames: 1 }) }));
  const backend = { present } as unknown as LoomBackend;
  const source = createNativeVisionSource(backend, bridge, { inputResourceId: "modelInput", inputSize: [512, 512], outputSize: [1920, 1080] });
  const clone = { close: vi.fn() };
  const frame = { clone: vi.fn(() => clone) } as unknown as VideoFrame;
  const deliver = (metadata = {}) => consume(frame, { session: name, sequence: 0, width: 1920, height: 1080, coverage: 0.2, ...metadata });
  const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
  return { source, sender, ack, bridge, clone, frame, deliver, flush, present, dispose, transfer };
}

it("resolves on result delivery; holds a clone until the backend uploads, not until capture ACK", async () => {
  const h = harness(); await h.source.ready;
  const run = h.source.run(); await h.flush();
  expect(h.sender.send).toHaveBeenCalledOnce(); await h.deliver();
  expect((await run).coverage).toBe(0.2);
  expect(h.clone.close).not.toHaveBeenCalled();
  expect(h.source.source.currentFrame()?.image).toBe(h.clone);
  expect(h.clone.close).not.toHaveBeenCalled(); await h.flush();
  expect(h.clone.close).toHaveBeenCalledOnce(); expect(h.source.source.currentFrame()).toBeUndefined();
  h.ack.resolve(); await h.source.close();
  expect(h.bridge.close).toHaveBeenCalledOnce(); expect(h.dispose).toHaveBeenCalledOnce();
});

it("close discards an unuploaded clone and cannot leak or deliver it after document retirement", async () => {
  const h = harness(); await h.source.ready;
  const run = h.source.run(); await h.flush(); await h.deliver(); await run;
  await h.source.close(); await h.source.close();
  expect(h.clone.close).toHaveBeenCalledOnce(); expect(h.source.source.currentFrame()).toBeUndefined();
  expect(h.bridge.close).toHaveBeenCalledOnce();
  await expect(h.source.run()).rejects.toThrow(/closed/);
});

it("capture refusal rejects the active run instead of waiting forever", async () => {
  const h = harness(); await h.source.ready;
  const run = h.source.run(); const failed = expect(run).rejects.toThrow(/worker refused/); await h.flush();
  h.ack.reject(new Error("worker refused")); await failed; await h.source.close();
});

it("an ACK without a delivered result surfaces the preload consumer error", async () => {
  const h = harness(); await h.source.ready;
  vi.mocked(h.bridge.status).mockRejectedValue(new Error("invalid result metadata"));
  const run = h.source.run(); const failed = expect(run).rejects.toThrow(/invalid result metadata/); await h.flush();
  h.ack.resolve(); await failed; await h.source.close();
});

it("a failed canvas transfer leaves no orphaned result promise for close to reject", async () => {
  const h = harness(); await h.source.ready;
  h.transfer.mockImplementationOnce(() => { throw new Error("surface unavailable"); });
  await expect(h.source.run()).rejects.toThrow(/surface unavailable/);
  expect(h.sender.send).not.toHaveBeenCalled();
  h.ack.resolve(); await h.source.close(); await h.flush();
});
