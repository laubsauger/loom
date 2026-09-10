import { describe, expect, it } from "vitest";

import { createVgpuBackend } from "./vgpu-backend.ts";
import { nodeGpuHost, probeDawn } from "./node-gpu-host.ts";
import type { GpuHost } from "./gpu-host.ts";
import { SHARED_UNIFORMS_WGSL } from "../shared-uniforms.ts";
import { BackendDiagnosticCode } from "../diagnostics.ts";
import type { LogicalExecutionPlan } from "../../../domain/types/backend.ts";
import type { RuntimeDiagnostic } from "../../../domain/types/diagnostics.ts";

/**
 * T1261 — WHAT A THROWING ENCODE LEAVES ON THE QUEUE, per `frame(gpu, cb)` site.
 *
 * vgpu 0.4.0 made `frame(gpu, cb)` / `frameLoop` atomic: a callback that throws has its
 * frame CANCELED (nothing it encoded reaches the queue) where 0.3.1 submitted whatever was
 * encoded before the throw. Only the command buffer is covered — CPU-side state the
 * callback mutated before throwing (ping-pong swaps, ring rotations, self-submitting
 * dispatches) is not rolled back by anyone. The backend is the only vgpu importer (§V3),
 * so its three encode sites are the only places the choice can be wrong, and each one's
 * decision is pinned here on Dawn by the pixels the next reader sees (§V147):
 *
 * 1. The LOOP path (`frameLoop` / the timer scheduler → `runFrame`): PARTIAL SUBMIT.
 *    `runFrame` catches the throw inside the callback (T98's diagnostic + storm halt), so
 *    the callback returns normally and vgpu submits the passes encoded before the throw —
 *    the same thing 0.3.1 did. Kept because it is the state consistent with the CPU-side
 *    mutations that already happened: a pair that swapped after its write pass must have
 *    that write on the queue, or the next frame reads a half nobody wrote. It is also what
 *    keeps the loop alive: under 0.4's cancel-on-throw, a throw that ESCAPED the callback
 *    would stop the `frameLoop` for good.
 * 2. The DIRECT path (`encodeSegmented`, the export/headless/paused-app entry): PARTIAL
 *    SUBMIT, opted into explicitly (`f.submit()` in the callback's own catch, the shape
 *    upstream documents). Same reasoning as the loop, plus §V47: the same failing plan must
 *    leave the same state on both paths, or a project renders two different pictures after
 *    the same error. `render()` still rethrows, so nothing downstream believes the frame
 *    completed.
 * 3. The temporal-history CLEAR (`clearTemporalHistory`): DROPPED WHOLE — vgpu's new
 *    default, accepted. No CPU bookkeeping is tied to the individual clears, the caller
 *    gets the error either way, and "history is gone" (§V22) must never be true of one
 *    half of a pair and false of the other: a half-reset simulation is the worst outcome.
 *
 * The throw is injected through the host seam: the raw Dawn device's frame encoder gets a
 * `beginRenderPass` that throws on the Nth pass of the next frame. That is exactly where
 * vgpu's own validation throws land (`f.pass` on a bad scissor, a canceled frame, a
 * duplicate span), and it needs no test-only hook in product code.
 */

const SIZE = 8;
/** Red byte = frameIndex, exactly: f32(n/255)·255 rounds to n for every small integer n. */
const FIRST_WGSL = `${SHARED_UNIFORMS_WGSL}
@group(0) @binding(0) var<uniform> frameU: SharedFrame;
@fragment fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  return vec4f(frameU.frameIndex / 255.0, 0.0, 0.0, 1.0);
}`;
/** Green byte = frameIndex, same construction, into its own target. */
const SECOND_WGSL = FIRST_WGSL.replace(
  "vec4f(frameU.frameIndex / 255.0, 0.0, 0.0, 1.0)",
  "vec4f(0.0, frameU.frameIndex / 255.0, 0.0, 1.0)",
);
const WHITE_WGSL = `@fragment fn fs(@location(0) uv: vec2f) -> @location(0) vec4f { return vec4f(1.0); }`;

const INJECTED = "injected: encode threw mid-frame (T1261)";

/**
 * Three render passes per frame, in this order, plus a ping-pong swap: `first` and `second`
 * are independent so the queue's contents after a throw on the second pass are legible
 * (first landed? second landed?), and `history` gives the clear scenario a pair to reset.
 */
function plan(): LogicalExecutionPlan {
  return {
    resources: [
      { kind: "target", id: "first", size: [SIZE, SIZE], format: "rgba8unorm" },
      { kind: "target", id: "second", size: [SIZE, SIZE], format: "rgba8unorm" },
      { kind: "pingPong", id: "history", size: [SIZE, SIZE], format: "rgba8unorm" },
    ],
    passes: [
      { kind: "effect", id: "first", nodeId: "n-first", shader: FIRST_WGSL, target: "first", sharedBinding: "frameU" },
      { kind: "effect", id: "second", nodeId: "n-second", shader: SECOND_WGSL, target: "second", sharedBinding: "frameU" },
      { kind: "effect", id: "seed", nodeId: "n-seed", shader: WHITE_WGSL, target: "history" },
      { kind: "swap", id: "history-swap", resourceId: "history" },
    ],
    diagnostics: [],
  } as unknown as LogicalExecutionPlan;
}

function inputs(frameIndex: number) {
  return {
    frame: { timeSeconds: frameIndex / 60, deltaSeconds: 1 / 60, frameIndex, mode: "offline", randomSeed: 1 },
    pointer: { x: 0, y: 0, buttons: 0 },
    resolution: [SIZE, SIZE],
  } as never;
}

interface ThrowingHost {
  readonly host: GpuHost;
  /** The next frame encoder's `ordinal`-th `beginRenderPass` throws; one shot. */
  arm(ordinal: number): void;
  readonly fired: number;
}

/** `nodeGpuHost()` whose raw device hands out frame encoders that can be told to throw. */
function throwingHost(): ThrowingHost {
  const inner = nodeGpuHost();
  let armed: number | undefined;
  let fired = 0;
  const host: GpuHost = {
    label: inner.label,
    async create(options) {
      const session = await inner.create(options);
      const native = session.gpu.gpu as GPUDevice;
      const createEncoder = native.createCommandEncoder.bind(native);
      Object.defineProperty(native, "createCommandEncoder", {
        configurable: true,
        writable: true,
        value: (descriptor?: GPUCommandEncoderDescriptor): GPUCommandEncoder => {
          const encoder = createEncoder(descriptor);
          // Only the frame's own encoder ("vgpu.frame" is vgpu's label for it) — readback
          // copies and the boundary clear use their own encoders and must keep working.
          if (descriptor?.label !== "vgpu.frame") return encoder;
          const begin = encoder.beginRenderPass.bind(encoder);
          let seen = 0;
          Object.defineProperty(encoder, "beginRenderPass", {
            configurable: true,
            writable: true,
            value: (pass: GPURenderPassDescriptor): GPURenderPassEncoder => {
              seen += 1;
              if (armed !== undefined && seen === armed) {
                armed = undefined;
                fired += 1;
                throw new Error(INJECTED);
              }
              return begin(pass);
            },
          });
          return encoder;
        },
      });
      return session;
    },
  };
  return {
    host,
    arm(ordinal) {
      armed = ordinal;
    },
    get fired() {
      return fired;
    },
  };
}

async function until(predicate: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function harness() {
  const probe = await probeDawn();
  if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);
  const injector = throwingHost();
  const backend = createVgpuBackend({ host: injector.host });
  const diagnostics: RuntimeDiagnostic[] = [];
  backend.onDiagnostic((diagnostic) => diagnostics.push(diagnostic));
  await backend.initialize({});
  const compiled = await backend.compile(plan());
  const bytes = async (): Promise<{ first: number; second: number; history: number }> => ({
    first: (await backend.readOutput("first")).bytes[0] as number,
    second: (await backend.readOutput("second")).bytes[1] as number,
    history: (await backend.readOutput("history")).bytes[0] as number,
  });
  const frameErrors = () => diagnostics.filter((d) => d.code === BackendDiagnosticCode.frameError);
  return { backend, compiled, injector, diagnostics, bytes, frameErrors };
}

describe("what a throwing encode leaves on the queue (T1261)", () => {
  it("direct path: the passes encoded before the throw are submitted, render() rethrows, the next frame is whole", async () => {
    const { backend, compiled, injector, bytes, frameErrors } = await harness();
    try {
      backend.render(compiled, inputs(10));
      expect(await bytes()).toEqual({ first: 10, second: 10, history: 255 });

      // Frame 11 throws on its SECOND pass: `first` was encoded, `second` and `seed` were not.
      injector.arm(2);
      expect(() => backend.render(compiled, inputs(11))).toThrow(INJECTED);
      expect(injector.fired).toBe(1);
      expect(frameErrors().map((d) => d.message)).toEqual([`Frame callback threw: ${INJECTED}`]);
      // PARTIAL SUBMIT: `first` carries frame 11, `second` still frame 10. Under vgpu's
      // cancel-on-throw default this reads { first: 10 } — the queue never saw the pass.
      expect(await bytes()).toEqual({ first: 11, second: 10, history: 255 });

      // The frame after is whole again, and the readback seam survived the throw.
      backend.render(compiled, inputs(12));
      expect(await bytes()).toEqual({ first: 12, second: 12, history: 255 });
      expect(frameErrors()).toHaveLength(1);
    } finally {
      backend.dispose();
    }
  }, 90_000);

  it("loop path: same partial submit, the diagnostic is reported, and the loop keeps ticking", async () => {
    const { backend, compiled, injector, bytes, frameErrors } = await harness();
    try {
      // One frameLoop tick at a time, so readback (never inside the loop, §V48) sits
      // between ticks. The tick is the frame driver's contract: `render()` inside the
      // loop callback, the throw escaping into `runFrame`.
      const tick = async (frameIndex: number): Promise<void> => {
        let rendered = false;
        let threw: unknown;
        const control = backend.loop(() => {
          if (rendered) return;
          rendered = true;
          try {
            backend.render(compiled, inputs(frameIndex));
          } catch (error) {
            threw = error;
            throw error;
          }
        });
        await until(() => rendered, `loop tick ${frameIndex}`);
        control.stop();
        if (threw !== undefined) throw threw;
      };

      await tick(20);
      expect(await bytes()).toEqual({ first: 20, second: 20, history: 255 });

      injector.arm(2);
      await expect(tick(21)).rejects.toThrow(INJECTED);
      expect(injector.fired).toBe(1);
      expect(frameErrors().map((d) => d.message)).toEqual([`Frame callback threw: ${INJECTED}`]);
      expect(await bytes()).toEqual({ first: 21, second: 20, history: 255 });

      // The loop registered AFTER the throw runs — if the throw had escaped the callback,
      // vgpu ≥ 0.4 would have canceled the frame AND stopped the loop, and this tick
      // would time out rather than render.
      await tick(22);
      expect(await bytes()).toEqual({ first: 22, second: 22, history: 255 });
      expect(frameErrors()).toHaveLength(1);
      expect(backend.status.halted).toBe(false);
    } finally {
      backend.dispose();
    }
  }, 90_000);

  it("temporal clear: a throw drops the whole clear — no half-reset pair", async () => {
    const { backend, compiled, injector, bytes } = await harness();
    try {
      backend.render(compiled, inputs(30));
      backend.render(compiled, inputs(31));
      expect((await bytes()).history).toBe(255);

      // The clear frame encodes pair.read first, pair.write second; the second throws.
      injector.arm(2);
      expect(() => backend.resetTemporalHistory(["history"], { silent: true })).toThrow(INJECTED);
      expect(injector.fired).toBe(1);
      // DROPPED WHOLE: the read half was NOT cleared, so the pair is still one state.
      // A partial submit would read 0 here — history gone on one half, kept on the other.
      expect((await bytes()).history).toBe(255);

      // The next reset lands in full.
      backend.resetTemporalHistory(["history"], { silent: true });
      expect((await bytes()).history).toBe(0);
    } finally {
      backend.dispose();
    }
  }, 90_000);
});
