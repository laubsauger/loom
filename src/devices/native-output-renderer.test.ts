// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => {
  class Port {
    onmessage: ((event: { data: unknown }) => void | Promise<void>) | null = null;
    onmessageerror: (() => void) | null = null;
    postMessage = vi.fn(); start = vi.fn(); close = vi.fn();
    receive(data: unknown) { return this.onmessage?.({ data }); }
  }
  return { Port, channel: vi.fn() };
});
vi.mock("./native-output-channel.ts", () => ({ nativeOutputChannel: fixture.channel }));
afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.resetModules();
  document.body.replaceChildren();
});

async function setup(available = true) {
  window.history.replaceState(null, "", "/?name=test&width=1280&height=720");
  const transfer = vi.fn();
  const context = vi.spyOn(HTMLCanvasElement.prototype, "getContext")
    .mockReturnValue(available ? { transferFromImageBitmap: transfer } as unknown as ReturnType<HTMLCanvasElement["getContext"]> : null);
  const worker = { port: new fixture.Port(), onerror: null };
  fixture.channel.mockReturnValue(worker);
  vi.stubGlobal("MessagePort", fixture.Port);
  class Bitmap {
    width = 1920; height = 1080; close = vi.fn();
  }
  vi.stubGlobal("ImageBitmap", Bitmap);
  vi.stubGlobal("loomNativeSurface", { frameReady: vi.fn(async () => {}) });
  await import("../desktop/output-renderer.ts");
  const port = new fixture.Port();
  worker.port.receive({ kind: "ready", port });
  return { port, transfer, context, frame: new Bitmap() };
}

it("adopts the bitmap directly, resizes at full resolution, and acknowledges after transfer", async () => {
  const { port, transfer, context, frame } = await setup();
  transfer.mockImplementation(() => expect(port.postMessage).not.toHaveBeenCalled());
  await port.receive({ kind: "frame", frame });
  expect(context).toHaveBeenCalledTimes(1);
  expect(context).toHaveBeenCalledWith("bitmaprenderer", { alpha: false });
  expect(transfer).toHaveBeenCalledTimes(1);
  expect(transfer).toHaveBeenCalledWith(frame);
  expect(frame.close).toHaveBeenCalledTimes(1);
  expect(port.postMessage).toHaveBeenCalledTimes(1);
  expect(port.postMessage).toHaveBeenCalledWith({ kind: "released" });
  const canvas = document.querySelector("canvas")!;
  expect([canvas.width, canvas.height]).toEqual([1920, 1080]);
  expect(canvas.dataset.receivedFrames).toBe("1");
});

it("closes the bitmap but does not acknowledge successful presentation on failure", async () => {
  const { port, transfer, frame } = await setup();
  transfer.mockImplementation(() => { throw new Error("presentation failed"); });
  await expect(port.receive({ kind: "frame", frame })).rejects.toThrow("presentation failed");
  expect(frame.close).toHaveBeenCalledTimes(1);
  expect(port.postMessage).not.toHaveBeenCalled();
});

it("rejects an unavailable compositor context explicitly", async () => {
  await expect(setup(false)).rejects.toThrow("no ImageBitmap presentation context");
});
