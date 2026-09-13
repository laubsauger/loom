import { expect, it, vi } from "vitest";
import type { LoomBackend, MediaSource } from "@runtime/backend/backend-types.ts";
import type { FrameEvaluationInput } from "@domain/types/frame.ts";
import { createNativeVisionSource, desktopVisionBridge } from "@devices/native-inference.ts";
import { createNativeVisionSources } from "./native-vision-sources.ts";
vi.mock("@devices/native-inference.ts", () => ({ createNativeVisionSource: vi.fn(), desktopVisionBridge: vi.fn() }));
const frame = (index: number, mode: FrameEvaluationInput["mode"] = "realtime"): FrameEvaluationInput => ({
  frameIndex: index, timeSeconds: index / 60, deltaSeconds: 1 / 60, mode, randomSeed: 1,
});
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
function harness() {
  const media = new Map<string, MediaSource>();
  const backend = { registerMediaSource: (id: string, source: MediaSource) => { media.set(id, source); return () => media.delete(id); } } as unknown as LoomBackend;
  const source = { source: { currentFrame: vi.fn(() => undefined) }, ready: Promise.resolve(), available: true,
    run: vi.fn(async () => ({ session: "test", sequence: 0, width: 4, height: 2, coverage: 0.2 })), close: vi.fn(async () => {}) };
  vi.mocked(createNativeVisionSource).mockReturnValue(source);
  vi.mocked(desktopVisionBridge).mockReturnValue({} as ReturnType<typeof desktopVisionBridge>);
  const sources = createNativeVisionSources();
  const target = { nodeId: "mask", size: [4, 2] as const, minIntervalSeconds: 1, channel: "mask1" };
  return { sources, source, backend, target, media };
}

it("keeps initial empty mask distinct from delivered data, rate limits live work and retires pruned nodes", async () => {
  const h = harness(); h.sources.track([h.target], h.backend); await flush();
  expect(h.media.values().next().value?.currentFrame()?.bytes?.length).toBe(64);
  h.sources.observe(frame(0)); await flush();
  h.sources.observe(frame(1)); await flush(); expect(h.source.run).toHaveBeenCalledOnce();
  expect(h.media.values().next().value?.currentFrame()).toBeUndefined();
  h.sources.observe(frame(60)); await flush(); expect(h.source.run).toHaveBeenCalledTimes(2);
  h.sources.track([], h.backend); await flush(); expect(h.source.close).toHaveBeenCalledOnce(); expect(h.media.size).toBe(0);
});

it("offline ignores the live rate cap and awaits each rendered frame exactly once", async () => {
  const h = harness(); h.sources.track([h.target], h.backend); await flush();
  for (const index of [0, 1, 2]) { h.sources.observe(frame(index, "offline")); await h.sources.settle(index); await h.sources.settle(index); }
  expect(h.source.run).toHaveBeenCalledTimes(3); h.sources.dispose(); await flush();
});

it("offline starts independent models together but does not settle until both finish", async () => {
  const h = harness();
  let first!: () => void, second!: () => void;
  const result = { session: "test", sequence: 0, width: 4, height: 2, coverage: 0.2 };
  h.source.run.mockImplementationOnce(() => new Promise(resolve => { first = () => resolve(result); }))
    .mockImplementationOnce(() => new Promise(resolve => { second = () => resolve(result); }));
  h.sources.track([h.target, { ...h.target, nodeId: "other" }], h.backend); await flush();
  h.sources.observe(frame(0, "offline"));
  let settled = false;
  const pending = h.sources.settle(0).then(() => { settled = true; });
  await flush();
  try {
    expect(h.source.run).toHaveBeenCalledTimes(2);
    second(); await flush(); expect(settled).toBe(false);
    first(); await pending;
    await h.sources.settle(0); expect(h.source.run).toHaveBeenCalledTimes(2);
  } finally {
    first(); await flush(); second(); await pending; await h.sources.drain();
  }
});

it("backend replacement retires the old media registration and creates a fresh model owner", async () => {
  const h = harness(); h.sources.track([h.target], h.backend); await flush();
  const other = { registerMediaSource: vi.fn(() => vi.fn()) } as unknown as LoomBackend;
  h.sources.track([h.target], other); await flush();
  expect(h.source.close).toHaveBeenCalledOnce(); expect(h.media.size).toBe(0);
  expect(other.registerMediaSource).toHaveBeenCalledOnce(); h.sources.dispose(); await flush();
});

it("offline reports one model's failure only after the other submitted model settles", async () => {
  const h = harness(); let finish!: () => void;
  h.source.run.mockRejectedValueOnce(new Error("model refused"))
    .mockImplementationOnce(() => new Promise(resolve => { finish = () => resolve({ session: "other", sequence: 0, width: 4, height: 2, coverage: 0 }); }));
  h.sources.track([h.target, { ...h.target, nodeId: "other" }], h.backend); await flush();
  h.sources.observe(frame(0, "offline"));
  let failed = false;
  const pending = h.sources.settle(0).catch(error => { failed = true; throw error; });
  const failure = expect(pending).rejects.toThrow("model refused");
  await flush();
  try { expect(h.source.run).toHaveBeenCalledTimes(2); expect(failed).toBe(false); }
  finally { finish?.(); await failure; await h.sources.drain(); }
});

it("no Electron bridge reports refusal and never silently runs the helper", async () => {
  const h = harness(); vi.mocked(desktopVisionBridge).mockReturnValue(undefined);
  h.sources.track([h.target], h.backend); h.sources.observe(frame(0, "offline"));
  await expect(h.sources.settle(0)).rejects.toThrow(/requires the Apple Silicon Electron app/);
  expect(h.sources.diagnostics()[0]?.code).toBe("vision.native.refused");
  expect(h.source.run).not.toHaveBeenCalled(); h.sources.dispose();
});

it("failed GPU retirement remains visible and blocks a new document's export", async () => {
  const h = harness(); h.source.close.mockRejectedValue(new Error("GPU lease is uncertain"));
  h.sources.track([h.target], h.backend); await flush();
  h.sources.dispose(); await flush();
  const replacement = createNativeVisionSources(); replacement.track([], h.backend);
  expect(replacement.diagnostics()).toEqual([{ severity: "error", code: "vision.native.retirement",
    message: "Native Vision retirement failed; new sessions and exports remain blocked: Error: GPU lease is uncertain" }]);
  await expect(replacement.drain()).rejects.toThrow(/GPU lease is uncertain/);
});
