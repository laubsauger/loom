import { afterEach, describe, expect, it, vi } from "vitest";
import { nativeOutputSender } from "./native-output-channel.ts";

const fixture = vi.hoisted(() => {
  class Port {
    onmessage: ((event: { data: unknown }) => void) | null = null;
    onmessageerror: (() => void) | null = null;
    postMessage = vi.fn(); start = vi.fn(); close = vi.fn();
    receive(data: unknown) { this.onmessage?.({ data }); }
  }
  return { Port, workers: [] as Array<{ port: Port; onerror: (() => void) | null }> };
});
vi.mock("./native-output-worker.ts?sharedworker", () => ({ default: class {
  port = new fixture.Port(); onerror = null;
  constructor() { fixture.workers.push(this); }
} }));
afterEach(() => { fixture.workers.length = 0; vi.unstubAllGlobals(); });

function setup() {
  vi.stubGlobal("MessagePort", fixture.Port);
  const sender = nativeOutputSender("test");
  const worker = fixture.workers[0]!;
  const frames = new fixture.Port();
  return { sender, worker, frames };
}

describe("native output direct frame channel", () => {
  it("bounds transfers to one in flight and keeps frame payloads out of the shared worker", async () => {
    const { sender, worker, frames } = setup();
    const bitmap = {} as ImageBitmap;
    expect(sender.available).toBe(false);
    expect(() => sender.send(bitmap)).toThrow(/unavailable/);
    worker.port.receive({ kind: "ready", port: frames });
    await sender.promise;
    sender.send(bitmap);
    expect(sender.available).toBe(false);
    expect(() => sender.send(bitmap)).toThrow(/busy/);
    expect(frames.postMessage).toHaveBeenCalledWith({ kind: "frame", frame: bitmap }, [bitmap]);
    expect(worker.port.postMessage).toHaveBeenCalledTimes(1);
    frames.receive({ kind: "released" });
    expect(sender.available).toBe(true);
    expect(sender.sentFrames).toBe(1);
    sender.close(); sender.close();
    expect(frames.close).toHaveBeenCalledTimes(1);
    expect(sender.available).toBe(false);
    expect(() => sender.send(bitmap)).toThrow(/unavailable/);
  });

  it("surfaces errors after readiness instead of silently stalling", async () => {
    const { sender, worker, frames } = setup();
    worker.port.receive({ kind: "ready", port: frames });
    await sender.promise;
    frames.onmessageerror?.();
    expect(() => sender.available).toThrow(/deserialized/);
    expect(() => sender.send({} as ImageBitmap)).toThrow(/deserialized/);
    sender.close();
  });

  it("rejects cancelled acquisition and never becomes available after close", async () => {
    const { sender } = setup();
    const rejected = expect(sender.promise).rejects.toThrow(/cancelled/);
    sender.close();
    await rejected;
    expect(sender.available).toBe(false);
  });

  it("awaits the real release acknowledgment and rejects a waiting consumer on close", async () => {
    const { sender, worker, frames } = setup();
    worker.port.receive({ kind: "ready", port: frames }); await sender.promise;
    sender.send({} as ImageBitmap);
    let done = false;
    const waiting = sender.waitAvailable().then(() => { done = true; });
    await Promise.resolve(); expect(done).toBe(false);
    frames.receive({ kind: "released" }); await waiting; expect(done).toBe(true);
    sender.send({} as ImageBitmap);
    const rejected = expect(sender.waitAvailable()).rejects.toThrow(/closed/);
    await Promise.resolve(); sender.close(); await rejected;
  });
});
