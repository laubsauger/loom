import { expect, it, vi } from "vitest";
import type { LoomBackend } from "@runtime/backend/index.ts";
import { drainNativeViewerOutputs, registerNativeViewerOutput, trackNativeViewerDrain } from "./native-viewer-outputs.ts";

it("stops all viewer owners before waiting and scopes them to their backend", async () => {
  const backend = {} as LoomBackend;
  const other = {} as LoomBackend;
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const first = vi.fn(() => trackNativeViewerDrain(backend, pending));
  const second = vi.fn();
  const unrelated = vi.fn();
  registerNativeViewerOutput(backend, first);
  const unregister = registerNativeViewerOutput(backend, second);
  registerNativeViewerOutput(other, unrelated);
  let complete = false;
  const draining = drainNativeViewerOutputs(backend).then(() => { complete = true; });
  expect(first).toHaveBeenCalledOnce(); expect(second).toHaveBeenCalledOnce();
  expect(unrelated).not.toHaveBeenCalled();
  unregister();
  await Promise.resolve(); expect(complete).toBe(false);
  release(); await draining;
  expect(complete).toBe(true);
});

it("retains outstanding and failed releases after owner removal", async () => {
  const backend = {} as LoomBackend;
  let fail!: (error: Error) => void;
  const pending = new Promise<void>((_resolve, reject) => { fail = reject; });
  const unregister = registerNativeViewerOutput(backend, () => {});
  trackNativeViewerDrain(backend, pending);
  unregister();
  const draining = expect(drainNativeViewerOutputs(backend)).rejects.toThrow("uncertain GPU ownership");
  fail(new Error("uncertain GPU ownership"));
  await draining;
  await expect(drainNativeViewerOutputs(backend)).rejects.toThrow("uncertain GPU ownership");
});

it("a replacement document's owner cannot forget the prior owner's pending drain", async () => {
  const backend = {} as LoomBackend;
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const removeOldOwner = registerNativeViewerOutput(backend, () => {});
  trackNativeViewerDrain(backend, pending);
  removeOldOwner();
  const stopNewOwner = vi.fn();
  registerNativeViewerOutput(backend, stopNewOwner);
  let finished = false;
  const draining = drainNativeViewerOutputs(backend).then(() => { finished = true; });
  await Promise.resolve();
  expect(stopNewOwner).toHaveBeenCalledOnce();
  expect(finished).toBe(false);
  release(); await draining;
  expect(finished).toBe(true);
});
