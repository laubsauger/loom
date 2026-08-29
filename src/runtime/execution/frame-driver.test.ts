import { describe, expect, it, vi } from "vitest";
import type {
  BackendCapabilities,
  CompiledExecutionPlan,
  FrameInputs,
} from "../../domain/types/backend.ts";
import type { TransportSource } from "../../domain/types/frame.ts";
import type { BackendStatus, ShaderloomBackend } from "../backend/backend-types.ts";
import { createFrameDriver } from "./frame-driver.ts";
import { offlineTransport } from "./offline-transport.ts";
import { createPointerSource } from "./pointer.ts";

/**
 * The driver is pure scheduling and input assembly, so it is tested against a recording
 * backend rather than a GPU. What matters here is that time comes from the transport and
 * from nowhere else (§V44, §V49), and that a frame is only ever rendered for a plan.
 */
function recordingBackend(): ShaderloomBackend & {
  readonly calls: FrameInputs[];
  tick(): void;
  readonly looping: boolean;
} {
  const calls: FrameInputs[] = [];
  let onTick: (() => void) | undefined;

  const status: BackendStatus = {
    initialized: true,
    disposed: false,
    halted: false,
    deviceGeneration: 1,
    temporalResets: 0,
    resourceBuilds: 1,
    framesSubmitted: 0,
    readbacks: 0,
    stale: false,
    estimatedResourceBytes: 0,
  };

  return {
    calls,
    status,
    get looping() {
      return onTick !== undefined;
    },
    tick() {
      onTick?.();
    },
    initialize: () => Promise.resolve({} as BackendCapabilities),
    compile: (plan) => Promise.resolve({ id: "plan-1", logical: plan }),
    render(_plan, inputs) {
      calls.push(inputs);
    },
    resize() {},
    readOutput: () => Promise.resolve(new Uint8Array()),
    onDiagnostic: () => () => {},
    dispose() {},
    loop(next) {
      onTick = next;
      return {
        stop() {
          onTick = undefined;
        },
      };
    },
    updateUniforms() {},
    resetTemporalHistory() {},
    recover: () => Promise.resolve(),
    present: (_canvas, options) => ({
      id: "present-1",
      outputId: options.outputId,
      setOutput() {},
      dispose() {},
    }),
    previewHost: () => ({
      setPreviewProgram() {},
      presentPreviews() {},
      dispose() {},
    }),
    onGpuTimings: () => () => {},
  };
}

const plan: CompiledExecutionPlan = {
  id: "plan-1",
  logical: { passes: [], resources: [], diagnostics: [] },
};

describe("frame driver", () => {
  it("feeds every time value from the transport, never from a clock", async () => {
    const backend = recordingBackend();
    const transport = offlineTransport({ fps: 30, seed: 11 });
    const driver = createFrameDriver({
      backend,
      transport,
      pointer: createPointerSource(),
      resolution: () => [320, 180],
    });
    driver.setPlan(plan);

    driver.step();
    driver.step();
    driver.step();

    expect(backend.calls.map((call) => call.frame.frameIndex)).toEqual([0, 1, 2]);
    expect(backend.calls.map((call) => call.frame.timeSeconds)).toEqual([0, 1 / 30, 2 / 30]);
    expect(backend.calls.every((call) => call.frame.randomSeed === 11)).toBe(true);
    expect(backend.calls.every((call) => call.frame.mode === "offline")).toBe(true);
    expect(backend.calls[0]?.resolution).toEqual([320, 180]);
  });

  /**
   * The same driver and the same plan, driven by a different transport. If anything here
   * read wall time the two runs could not be byte-identical.
   */
  it("produces an identical input sequence on a reset and replay", () => {
    const backend = recordingBackend();
    const transport = offlineTransport({ fps: 60, seed: 3 });
    const driver = createFrameDriver({
      backend,
      transport,
      pointer: createPointerSource(),
      resolution: () => [64, 64],
    });
    driver.setPlan(plan);

    for (let index = 0; index < 5; index += 1) driver.step();
    const first = backend.calls.map((call) => ({ ...call.frame }));

    backend.calls.length = 0;
    transport.reset();
    for (let index = 0; index < 5; index += 1) driver.step();

    expect(backend.calls.map((call) => ({ ...call.frame }))).toEqual(first);
  });

  it("renders nothing until a plan is set", () => {
    const backend = recordingBackend();
    const driver = createFrameDriver({
      backend,
      transport: offlineTransport({ fps: 60 }),
      pointer: createPointerSource(),
      resolution: () => [8, 8],
    });

    expect(driver.step()).toBeNull();
    expect(backend.calls).toEqual([]);
    expect(driver.framesRendered).toBe(0);

    driver.setPlan(plan);
    expect(driver.step()).not.toBeNull();
    expect(driver.framesRendered).toBe(1);
  });

  it("passes the live pointer state into the frame inputs", () => {
    const backend = recordingBackend();
    const pointer = createPointerSource();
    const driver = createFrameDriver({
      backend,
      transport: offlineTransport({ fps: 60 }),
      pointer,
      resolution: () => [8, 8],
    });
    driver.setPlan(plan);

    pointer.set({ x: 0.75, buttons: 1 });
    driver.step();
    pointer.reset();
    driver.step();

    expect(backend.calls[0]?.pointer).toEqual({ x: 0.75, y: 0, buttons: 1 });
    expect(backend.calls[1]?.pointer).toEqual({ x: 0, y: 0, buttons: 0 });
  });

  it("runs through the backend's scheduler when started, and stops cleanly", () => {
    const backend = recordingBackend();
    const onFrame = vi.fn();
    const driver = createFrameDriver({
      backend,
      transport: offlineTransport({ fps: 60 }),
      pointer: createPointerSource(),
      resolution: () => [8, 8],
      onFrame,
    });
    driver.setPlan(plan);

    driver.start();
    expect(driver.running).toBe(true);
    backend.tick();
    backend.tick();

    driver.stop();
    expect(driver.running).toBe(false);
    expect(backend.looping).toBe(false);
    backend.tick();

    expect(driver.framesRendered).toBe(2);
    expect(onFrame).toHaveBeenCalledTimes(2);
  });
});

describe("offline transport", () => {
  it("emits exact frame times with a zero first delta", () => {
    const transport: TransportSource = offlineTransport({ fps: 24, startFrame: 10, mode: "fixed-step" });

    const first = transport.next();
    const second = transport.next();

    expect(first).toEqual({
      timeSeconds: 10 / 24,
      deltaSeconds: 0,
      frameIndex: 10,
      mode: "fixed-step",
      randomSeed: 0,
    });
    expect(second.deltaSeconds).toBeCloseTo(1 / 24, 12);
    expect(second.frameIndex).toBe(11);
  });

  it("reseeds on reset", () => {
    const transport = offlineTransport({ fps: 60, seed: 1 });
    transport.next();
    transport.reset(99);
    const after = transport.next();

    expect(after.frameIndex).toBe(0);
    expect(after.randomSeed).toBe(99);
  });
});
