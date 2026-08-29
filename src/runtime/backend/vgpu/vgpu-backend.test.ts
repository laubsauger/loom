import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { FrameInputs } from "../../../domain/types/backend.ts";
import type { RuntimeDiagnostic } from "../../../domain/types/diagnostics.ts";
import type { FrameLoopControl } from "../backend-types.ts";
import { BackendDiagnosticCode } from "../diagnostics.ts";
import { FrameEncodingViolation } from "../frame-guard.ts";
import { GENERATE_WGSL_EDITED, fixturePlan } from "./plan-fixture.ts";
import { mockGpuHost, type MockGpuHost, type MockInstrumentation } from "./mock-gpu-host.ts";
import { createVgpuBackend, type VgpuBackend } from "./vgpu-backend.ts";

const teardown: Array<() => void> = [];

afterEach(() => {
  while (teardown.length > 0) teardown.pop()?.();
});

interface Harness {
  readonly backend: VgpuBackend;
  readonly host: MockGpuHost;
  readonly diagnostics: RuntimeDiagnostic[];
}

async function harness(
  hostOptions: { features?: ReadonlyArray<GPUFeatureName> } = {},
  init: { requiredFeatures?: ReadonlyArray<string> } = {},
): Promise<Harness> {
  const host = mockGpuHost(hostOptions);
  const backend = createVgpuBackend({ host });
  const diagnostics: RuntimeDiagnostic[] = [];
  backend.onDiagnostic((diagnostic) => diagnostics.push(diagnostic));
  teardown.push(() => backend.dispose());
  // §V47: no canvas. The headless path is the default path, not a fallback.
  await backend.initialize(init.requiredFeatures ? { requiredFeatures: init.requiredFeatures } : {});
  return { backend, host, diagnostics };
}

function frameInputs(frameIndex: number): FrameInputs {
  return {
    frame: {
      timeSeconds: frameIndex / 60,
      deltaSeconds: 1 / 60,
      frameIndex,
      mode: "offline",
      randomSeed: 7,
    },
    pointer: { x: 0.25, y: 0.5, buttons: 0 },
    resolution: [64, 64],
  };
}

function snapshot(instrumentation: MockInstrumentation | undefined): Record<string, number> {
  if (!instrumentation) throw new Error("no live mock device");
  return { ...instrumentation.calls };
}

async function until(predicate: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(`timed out waiting for ${label}`);
}

describe("vgpu backend — initialization and capabilities", () => {
  /** §V47: `BackendInitOptions.canvas` is optional so the plan can render with no surface. */
  it("initializes and renders with no canvas at all", async () => {
    const { backend } = await harness();
    const plan = await backend.compile(fixturePlan());

    backend.render(plan, frameInputs(0));
    backend.render(plan, frameInputs(1));

    expect(backend.status.initialized).toBe(true);
    expect(backend.status.framesSubmitted).toBe(2);
    // A readback is available for the offline path, but playback never triggers one (§V48).
    expect(backend.status.readbacks).toBe(0);
    const bytes = await backend.readOutput("output");
    expect(bytes.byteLength).toBe(64 * 64 * 4);
    expect(backend.status.readbacks).toBe(1);
  });

  /** §V12: optional features are reported, never assumed, and their absence is not fatal. */
  it("reports timestamp query as unavailable and keeps working", async () => {
    const { backend, diagnostics } = await harness();

    expect(backend.capabilities?.timestampQuery).toBe(false);
    expect(diagnostics.map((d) => d.code)).toContain(BackendDiagnosticCode.timestampUnavailable);
    // Absence degrades to "no GPU timings", never to an error.
    expect(diagnostics.filter((d) => d.severity === "error")).toEqual([]);

    const plan = await backend.compile(fixturePlan());
    backend.render(plan, frameInputs(0));
    expect(backend.status.framesSubmitted).toBe(1);
  });

  it("reports timestamp query as available when the adapter has it", async () => {
    const { backend, diagnostics } = await harness(
      { features: ["timestamp-query"] },
      { requiredFeatures: ["timestamp-query"] },
    );

    expect(backend.capabilities?.timestampQuery).toBe(true);
    expect(backend.capabilities?.features).toContain("timestamp-query");
    expect(diagnostics.map((d) => d.code)).not.toContain(BackendDiagnosticCode.timestampUnavailable);
  });

  it("reports the baseline tier and the limits the compiler needs", async () => {
    const { backend } = await harness();
    const capabilities = backend.capabilities;

    expect(capabilities?.tier).toBe("B");
    expect(capabilities?.formats).toContain("rgba16float");
    expect(capabilities?.limits["maxTextureDimension2D"]).toBeGreaterThan(0);
    expect(capabilities?.limits["maxStorageBuffersPerShaderStage"]).toBeGreaterThan(0);
  });

  it("fails loudly when a required feature is missing", async () => {
    const host = mockGpuHost();
    const backend = createVgpuBackend({ host });
    const diagnostics: RuntimeDiagnostic[] = [];
    backend.onDiagnostic((diagnostic) => diagnostics.push(diagnostic));
    teardown.push(() => backend.dispose());

    await expect(backend.initialize({ requiredFeatures: ["timestamp-query"] })).rejects.toThrow();
    expect(diagnostics.map((d) => d.code)).toContain(BackendDiagnosticCode.initFailed);
  });
});

describe("vgpu backend — uniform updates (§V5)", () => {
  it("updates a uniform without recompiling anything", async () => {
    const { backend, host } = await harness();
    const plan = await backend.compile(fixturePlan());

    // Warm up: the first frames create the cached bind groups.
    backend.render(plan, frameInputs(0));
    backend.render(plan, frameInputs(1));

    const before = snapshot(host.instrumentation);
    const buildsBefore = backend.status.resourceBuilds;

    backend.updateUniforms({ passId: "generate", values: { amount: 0.25 } });
    backend.render(plan, frameInputs(2));
    backend.updateUniforms({ passId: "generate", values: { amount: 0.5, tint: 0.9 } });
    backend.render(plan, frameInputs(3));

    const after = snapshot(host.instrumentation);

    expect(backend.status.resourceBuilds).toBe(buildsBefore);
    expect(after["createShaderModule"]).toBe(before["createShaderModule"]);
    expect(after["createRenderPipeline"]).toBe(before["createRenderPipeline"]);
    expect(after["createBindGroupLayout"]).toBe(before["createBindGroupLayout"]);
    expect(after["createBuffer"]).toBe(before["createBuffer"]);
  });

  /**
   * The value path is closed structurally: a plan that differs only in uniform values has
   * the same structural signature, so `compile()` cannot reach resource construction.
   */
  it("recompiling a plan whose only difference is uniform values reuses the program", async () => {
    const { backend, host } = await harness();
    const first = await backend.compile(fixturePlan({ uniforms: { amount: 1, tint: 0 } }));
    backend.render(first, frameInputs(0));

    const before = snapshot(host.instrumentation);
    const buildsBefore = backend.status.resourceBuilds;

    const second = await backend.compile(fixturePlan({ uniforms: { amount: 0.1, tint: 0.4 } }));

    expect(second.id).toBe(first.id);
    expect(backend.status.resourceBuilds).toBe(buildsBefore);
    expect(snapshot(host.instrumentation)["createRenderPipeline"]).toBe(before["createRenderPipeline"]);
  });

  /** Control case: without this the test above could pass for a backend that never rebuilds. */
  it("a shader-source change does rebuild", async () => {
    const { backend } = await harness();
    const first = await backend.compile(fixturePlan());
    const buildsBefore = backend.status.resourceBuilds;

    const second = await backend.compile(fixturePlan({ generateShader: GENERATE_WGSL_EDITED }));

    expect(second.id).not.toBe(first.id);
    expect(backend.status.resourceBuilds).toBe(buildsBefore + 1);
  });

  it("reports an unknown pass instead of silently dropping the update", async () => {
    const { backend, diagnostics } = await harness();
    await backend.compile(fixturePlan());

    backend.updateUniforms({ passId: "does-not-exist", values: { amount: 1 } });

    expect(diagnostics.map((d) => d.code)).toContain(BackendDiagnosticCode.unknownPass);
  });
});

describe("vgpu backend — frame loop allocation (§V8)", () => {
  it("allocates nothing once the plan is warm", async () => {
    const { backend, host } = await harness();
    const plan = await backend.compile(fixturePlan());

    // Two warm-up frames: the ping-pong pair alternates between two cached bind groups.
    backend.render(plan, frameInputs(0));
    backend.render(plan, frameInputs(1));
    backend.render(plan, frameInputs(2));

    const before = snapshot(host.instrumentation);
    const buildsBefore = backend.status.resourceBuilds;
    for (let index = 3; index < 20; index += 1) backend.render(plan, frameInputs(index));
    const after = snapshot(host.instrumentation);

    // vgpu/mock does not instrument createTexture, so the backend's own build counter
    // covers target and ping-pong allocation that the device counters cannot see.
    expect(backend.status.resourceBuilds).toBe(buildsBefore);

    for (const [name, count] of Object.entries(before)) {
      // A command encoder per frame is the point; everything else must be flat.
      if (name === "createCommandEncoder") continue;
      expect(`${name}=${after[name]}`).toBe(`${name}=${count}`);
    }
    expect(after["createCommandEncoder"]).toBe((before["createCommandEncoder"] ?? 0) + 17);
  });

  /** The guard makes the violation impossible rather than merely discouraged. */
  it("refuses to allocate or resize while a frame is open", async () => {
    const { backend } = await harness();
    const plan = await backend.compile(fixturePlan());

    let control: FrameLoopControl | undefined;
    const caught = await new Promise<{ resize: unknown; compile: Promise<unknown> }>((resolve) => {
      control = backend.loop(() => {
        let resize: unknown;
        try {
          backend.resize("scene", [32, 32]);
        } catch (error) {
          resize = error;
        }
        // compile() is async, so the guard surfaces as a rejection rather than a throw.
        const compile = backend.compile(fixturePlan({ size: [128, 128] }));
        backend.render(plan, frameInputs(0));
        control?.stop();
        resolve({ resize, compile });
      });
    });

    expect(caught.resize).toBeInstanceOf(FrameEncodingViolation);
    await expect(caught.compile).rejects.toBeInstanceOf(FrameEncodingViolation);
    expect(backend.status.framesSubmitted).toBe(1);
  });

  it("encodes into the loop's frame rather than opening a nested one", async () => {
    const { backend, diagnostics } = await harness();
    const plan = await backend.compile(fixturePlan());

    let control: FrameLoopControl | undefined;
    let ticks = 0;
    await new Promise<void>((resolve) => {
      control = backend.loop(() => {
        ticks += 1;
        backend.render(plan, frameInputs(ticks));
        if (ticks >= 3) {
          control?.stop();
          resolve();
        }
      });
    });

    expect(ticks).toBe(3);
    expect(backend.status.framesSubmitted).toBe(3);
    // VGPU-FRAME-REENTRANT would have surfaced as a throw, not a diagnostic; assert clean.
    expect(diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  });
});

describe("vgpu backend — device loss (§V23)", () => {
  it("halts submission, diagnoses, rebuilds and resets temporal history", async () => {
    const { backend, host, diagnostics } = await harness();
    const plan = await backend.compile(fixturePlan());
    backend.render(plan, frameInputs(0));

    const generationBefore = backend.status.deviceGeneration;
    const resetsBefore = backend.status.temporalResets;
    const buildsBefore = backend.status.resourceBuilds;

    // Observe the halted window: while halted, render() must submit nothing.
    let submittedWhileHalted = 0;
    backend.onDiagnostic((diagnostic) => {
      if (diagnostic.code !== BackendDiagnosticCode.deviceLost) return;
      expect(backend.status.halted).toBe(true);
      const before = backend.status.framesSubmitted;
      backend.render(plan, frameInputs(1));
      backend.render(plan, frameInputs(2));
      submittedWhileHalted = backend.status.framesSubmitted - before;
    });

    host.loseDevice({ reason: "destroyed", message: "simulated" });
    await until(() => backend.status.deviceGeneration > generationBefore, "device rebuild");
    await backend.whenSettled();

    const codes = diagnostics.map((d) => d.code);
    expect(codes).toContain(BackendDiagnosticCode.deviceLost);
    expect(codes).toContain(BackendDiagnosticCode.deviceRestored);
    expect(codes).toContain(BackendDiagnosticCode.temporalReset);

    expect(submittedWhileHalted).toBe(0);
    expect(backend.status.halted).toBe(false);
    expect(backend.status.deviceGeneration).toBe(generationBefore + 1);
    expect(backend.status.temporalResets).toBeGreaterThan(resetsBefore);
    expect(backend.status.resourceBuilds).toBe(buildsBefore + 1);
    expect(host.sessionsCreated).toBe(2);

    // The plan handle survives the rebuild, so callers do not have to recompile.
    const submittedBefore = backend.status.framesSubmitted;
    backend.render(plan, frameInputs(3));
    expect(backend.status.framesSubmitted).toBe(submittedBefore + 1);
  });

  it("keeps live uniform values across a rebuild", async () => {
    const { backend, host } = await harness();
    const plan = await backend.compile(fixturePlan({ uniforms: { amount: 1, tint: 0 } }));
    backend.updateUniforms({ passId: "generate", values: { amount: 0.125 } });

    const generationBefore = backend.status.deviceGeneration;
    host.loseDevice();
    await until(() => backend.status.deviceGeneration > generationBefore, "device rebuild");
    await backend.whenSettled();

    // A recompile of the same structure must still be a no-op after the rebuild, which is
    // only true if the rebuilt program kept its identity and its live values.
    const buildsBefore = backend.status.resourceBuilds;
    const again = await backend.compile(fixturePlan({ uniforms: { amount: 1, tint: 0 } }));
    expect(again.id).toBe(plan.id);
    expect(backend.status.resourceBuilds).toBe(buildsBefore);
  });

  it("stays halted and says so when the rebuild cannot get a device", async () => {
    const host = mockGpuHost();
    const failing: typeof host = {
      ...host,
      create(options) {
        if (host.sessionsCreated >= 1) return Promise.reject(new Error("adapter gone"));
        return host.create(options);
      },
    };
    const backend = createVgpuBackend({ host: failing });
    const diagnostics: RuntimeDiagnostic[] = [];
    backend.onDiagnostic((diagnostic) => diagnostics.push(diagnostic));
    teardown.push(() => backend.dispose());

    await backend.initialize({});
    const plan = await backend.compile(fixturePlan());
    host.loseDevice();

    await until(
      () => diagnostics.some((d) => d.code === BackendDiagnosticCode.rebuildFailed),
      "rebuild failure diagnostic",
    );

    expect(backend.status.halted).toBe(true);
    const submittedBefore = backend.status.framesSubmitted;
    backend.render(plan, frameInputs(1));
    expect(backend.status.framesSubmitted).toBe(submittedBefore);
  });
});

describe("vgpu backend — plan handling", () => {
  it("rejects a malformed plan and keeps the last valid program", async () => {
    const { backend, diagnostics } = await harness();
    const good = await backend.compile(fixturePlan());
    const builds = backend.status.resourceBuilds;

    await expect(
      backend.compile({ passes: [{ kind: "effect", id: "broken" }], resources: [], diagnostics: [] }),
    ).rejects.toThrow();

    expect(diagnostics.map((d) => d.code)).toContain(BackendDiagnosticCode.planInvalid);
    expect(backend.status.resourceBuilds).toBe(builds);

    // §V9: the previously valid program still renders.
    backend.render(good, frameInputs(0));
    expect(backend.status.framesSubmitted).toBe(1);
  });

  it("reports a pass that references a resource the plan never declares", async () => {
    const { backend, diagnostics } = await harness();

    await expect(
      backend.compile({
        resources: [{ kind: "target", id: "output", size: [8, 8], format: "rgba8unorm" }],
        passes: [
          {
            kind: "effect",
            id: "orphan",
            shader: "@fragment fn fs() -> @location(0) vec4f { return vec4f(1.0); }",
            target: "missing",
          },
        ],
        diagnostics: [],
      }),
    ).rejects.toThrow();

    expect(diagnostics.map((d) => d.code)).toContain(BackendDiagnosticCode.unknownResource);
  });

  it("skips a frame and says why when handed a stale plan handle", async () => {
    const { backend, diagnostics } = await harness();
    const stale = await backend.compile(fixturePlan());
    await backend.compile(fixturePlan({ generateShader: GENERATE_WGSL_EDITED }));

    backend.render(stale, frameInputs(0));

    expect(backend.status.framesSubmitted).toBe(0);
    expect(diagnostics.map((d) => d.code)).toContain(BackendDiagnosticCode.planNotCurrent);
  });

  it("keeps rendering cleanly after a sampled intermediate target resizes (T94)", async () => {
    // "scene" is a plain target sampled by the feedback pass. Target.resize() destroys
    // and recreates its textures, and vgpu follows the recreation automatically only
    // when the Target itself is bound — a bound .color texture keeps pointing at the
    // destroyed one, and on a real device every later frame samples a dead texture.
    const { backend, diagnostics } = await harness();
    const plan = await backend.compile(fixturePlan());
    backend.render(plan, frameInputs(0));

    backend.resize("scene", [128, 128]);
    backend.render(plan, frameInputs(1));

    expect(backend.status.framesSubmitted).toBe(2);
    expect(diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  });

  it("binds plain targets as Targets so resize recreation re-points them (T94)", () => {
    // The mock device cannot observe destroyed-texture sampling (no lifecycle
    // validation at encode, and bind-group descriptors carry opaque views), so the
    // binding CHOICE is asserted at the source level, the way §V1/§V11 are. The real
    // runtime coverage is the Dawn headless snapshot suite (T47/T69).
    const source = readFileSync(
      fileURLToPath(new URL("./resources.ts", import.meta.url)),
      "utf8",
    );
    const readTexture = source.slice(source.indexOf("const readTexture"), source.indexOf("for (const pass of passes)"));
    // Plain targets bind the Target (auto re-pointed via onTexturesRecreated)…
    expect(readTexture).toMatch(/if \(plain\) return plain;/);
    // …while ping-pong halves stay per-frame rebound and must NOT bind a half Target,
    // whose identity is frozen at build time while parity swaps every frame.
    expect(readTexture).toMatch(/return pair\.read\.color;/);
  });

  it("resizes an output and resets the feedback history that resize invalidated", async () => {
    const { backend, diagnostics } = await harness();
    const plan = await backend.compile(fixturePlan());
    backend.render(plan, frameInputs(0));

    const resetsBefore = backend.status.temporalResets;
    backend.resize("history", [128, 128]);
    expect(backend.status.temporalResets).toBe(resetsBefore + 1);

    backend.resize("nope", [16, 16]);
    expect(diagnostics.map((d) => d.code)).toContain(BackendDiagnosticCode.unknownOutput);
  });

  it("routes shader build failures to onDiagnostic and flags the retained program stale (T95)", async () => {
    const { backend, diagnostics } = await harness();
    const good = await backend.compile(fixturePlan());
    expect(backend.status.stale).toBe(false);

    await expect(
      backend.compile(fixturePlan({ generateShader: "this is not wgsl at all {" })),
    ).rejects.toThrow();

    // §V9/§V27: the problems tab listens on onDiagnostic, so the failure must arrive
    // there, not only inside the thrown error.
    expect(diagnostics.map((d) => d.code)).toContain(BackendDiagnosticCode.planInvalid);
    expect(backend.status.stale).toBe(true);

    // The previous program keeps rendering while stale.
    backend.render(good, frameInputs(0));
    expect(backend.status.framesSubmitted).toBe(1);

    // A successful compile clears the flag.
    await backend.compile(fixturePlan());
    expect(backend.status.stale).toBe(false);
  });

  it("rejects resources beyond device texture limits before allocating anything (T97)", async () => {
    const { backend, diagnostics } = await harness();
    const buildsBefore = backend.status.resourceBuilds;

    await expect(backend.compile(fixturePlan({ size: [1_000_000, 8] }))).rejects.toThrow();

    expect(diagnostics.map((d) => d.code)).toContain(BackendDiagnosticCode.resourceLimit);
    // §V24: the limit is enforced before allocation, not discovered as a device error.
    expect(backend.status.resourceBuilds).toBe(buildsBefore);
  });

  it("reports an estimate of the program's texture memory (§V24)", async () => {
    const { backend } = await harness();
    await backend.compile(fixturePlan());
    // scene 64×64 rgba16float (8B) + output 64×64 rgba8unorm (4B) + history ping-pong
    // 64×64 rgba16float ×2 halves.
    expect(backend.status.estimatedResourceBytes).toBe(64 * 64 * (8 + 4 + 8 * 2));
  });
});

describe("vgpu backend — presentation seam (T87, §V64/§V70)", () => {
  /** A structural canvas whose webgpu context textures come from the live mock device. */
  function stubCanvas(host: MockGpuHost) {
    let frames = 0;
    const context = {
      configure() {},
      unconfigure() {},
      getCurrentTexture: () => {
        frames += 1;
        const device = host.device;
        if (!device) throw new Error("no live mock device");
        return device.createTexture({
          size: [64, 64],
          format: "rgba8unorm",
          usage: ["render_attachment", "texture_binding"] as unknown as GPUTextureUsageFlags,
        });
      },
    };
    return {
      canvas: { width: 64, height: 64, getContext: (kind: string) => (kind === "webgpu" ? context : null) },
      presentedFrames: () => frames,
    };
  }

  it("presents a compiled output to a handed-in canvas, GPU-to-GPU", async () => {
    const { backend, host, diagnostics } = await harness();
    const plan = await backend.compile(fixturePlan());
    const { canvas, presentedFrames } = stubCanvas(host);

    backend.present(canvas, { outputId: "output" });
    backend.render(plan, frameInputs(0));
    const afterFirst = presentedFrames();
    backend.render(plan, frameInputs(1));

    // vgpu may pull the context texture more than once per frame; what matters is
    // that every rendered frame reaches the canvas.
    expect(afterFirst).toBeGreaterThan(0);
    expect(presentedFrames()).toBeGreaterThan(afterFirst);
    // §V7/§V48: presenting is a blit, never a readback.
    expect(backend.status.readbacks).toBe(0);
    expect(diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  });

  it("presents the same output on multiple surfaces at once (§V70)", async () => {
    const { backend, host } = await harness();
    const plan = await backend.compile(fixturePlan());
    const first = stubCanvas(host);
    const second = stubCanvas(host);

    backend.present(first.canvas, { outputId: "output" });
    backend.present(second.canvas, { outputId: "output" });
    backend.render(plan, frameInputs(0));

    expect(first.presentedFrames()).toBeGreaterThan(0);
    expect(second.presentedFrames()).toBeGreaterThan(0);
  });

  it("a surface attached before any compile lights up after one", async () => {
    const { backend, host, diagnostics } = await harness();
    const { canvas, presentedFrames } = stubCanvas(host);

    backend.present(canvas, { outputId: "output" });
    const plan = await backend.compile(fixturePlan());
    backend.render(plan, frameInputs(0));

    expect(presentedFrames()).toBeGreaterThan(0);
    expect(diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  });

  it("setOutput repoints a live surface, and presenting a feedback output tracks the swap", async () => {
    const { backend, host, diagnostics } = await harness();
    const plan = await backend.compile(fixturePlan());
    const { canvas, presentedFrames } = stubCanvas(host);

    const handle = backend.present(canvas, { outputId: "output" });
    backend.render(plan, frameInputs(0));
    const beforeSwitch = presentedFrames();
    handle.setOutput("history"); // a ping-pong output: rebinds every frame
    expect(handle.outputId).toBe("history");
    backend.render(plan, frameInputs(1));
    backend.render(plan, frameInputs(2));

    expect(beforeSwitch).toBeGreaterThan(0);
    expect(presentedFrames()).toBeGreaterThan(beforeSwitch);
    expect(diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  });

  it("keeps presenting across a structural recompile", async () => {
    const { backend, host, diagnostics } = await harness();
    const first = await backend.compile(fixturePlan());
    const { canvas, presentedFrames } = stubCanvas(host);
    backend.present(canvas, { outputId: "output" });
    backend.render(first, frameInputs(0));

    const beforeRecompile = presentedFrames();
    const second = await backend.compile(fixturePlan({ generateShader: GENERATE_WGSL_EDITED }));
    backend.render(second, frameInputs(1));

    expect(beforeRecompile).toBeGreaterThan(0);
    expect(presentedFrames()).toBeGreaterThan(beforeRecompile);
    expect(diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  });

  it("re-establishes surfaces after device loss (§V23)", async () => {
    const { backend, host, diagnostics } = await harness();
    const plan = await backend.compile(fixturePlan());
    const { canvas, presentedFrames } = stubCanvas(host);
    backend.present(canvas, { outputId: "output" });
    backend.render(plan, frameInputs(0));

    const generation = backend.status.deviceGeneration;
    host.loseDevice();
    await until(() => backend.status.deviceGeneration > generation, "device rebuild");
    await backend.whenSettled();

    const beforeLoss = presentedFrames();
    const recompiled = await backend.compile(fixturePlan());
    backend.render(recompiled, frameInputs(1));
    expect(beforeLoss).toBeGreaterThan(0);
    expect(presentedFrames()).toBeGreaterThan(beforeLoss);
    expect(diagnostics.filter((d) => d.code === BackendDiagnosticCode.presentFailed)).toEqual([]);
  });

  it("dispose frees the canvas for a new presentation", async () => {
    const { backend, host } = await harness();
    await backend.compile(fixturePlan());
    const { canvas } = stubCanvas(host);

    const handle = backend.present(canvas, { outputId: "output" });
    handle.dispose();
    // vgpu guards one live surface per canvas; a disposed one must release its claim.
    const again = backend.present(canvas, { outputId: "output" });
    expect(again.id).not.toBe(handle.id);
  });
});

describe("vgpu backend — per-resource reuse across recompiles (T143, §V22)", () => {
  it("adding an unrelated node carries the feedback pair over instead of recreating it", async () => {
    const { backend, host, diagnostics } = await harness();
    const first = await backend.compile(fixturePlan());
    backend.render(first, frameInputs(0));
    backend.render(first, frameInputs(1));

    const shaderModules = snapshot(host.instrumentation).createShaderModule ?? 0;
    const resets = backend.status.temporalResets;

    const second = await backend.compile(fixturePlan({ extraGenerator: true }));
    backend.render(second, frameInputs(2));

    // scene + output + history + sampler carried; only "extra" is new.
    expect(backend.status.lastBuild).toEqual({
      resourcesCreated: 1,
      resourcesReused: 4,
      effectsBuilt: 1,
      effectsReused: 3,
    });
    // Only the new pass compiled a shader — carried effects skipped compilation.
    expect(snapshot(host.instrumentation).createShaderModule).toBe(shaderModules + 1);
    // The carried pair was never cleared or recreated: its CONTENTS survived the edit.
    expect(backend.status.temporalResets).toBe(resets);
    expect(diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  });

  it("a shader edit rebuilds that effect alone; everything else is carried", async () => {
    const { backend } = await harness();
    await backend.compile(fixturePlan());

    await backend.compile(fixturePlan({ generateShader: GENERATE_WGSL_EDITED }));

    expect(backend.status.lastBuild).toEqual({
      resourcesCreated: 0,
      resourcesReused: 4,
      effectsBuilt: 1, // generate
      effectsReused: 2, // feedback + composite
    });
  });

  it("a full first build reports zero reuse", async () => {
    const { backend } = await harness();
    await backend.compile(fixturePlan());
    expect(backend.status.lastBuild).toEqual({
      resourcesCreated: 4,
      resourcesReused: 0,
      effectsBuilt: 3,
      effectsReused: 0,
    });
  });
});

describe("vgpu backend — resize/compile reconciliation (R4)", () => {
  it("does not rebuild when the compiler hands back the sizes resize() already applied", async () => {
    const { backend } = await harness();
    const plan = await backend.compile(fixturePlan());
    backend.render(plan, frameInputs(0));
    const builds = backend.status.resourceBuilds;

    backend.resize("scene", [128, 128]);
    backend.resize("output", [128, 128]);
    backend.resize("history", [128, 128]);
    const resets = backend.status.temporalResets;

    // The compiler re-propagates resolution and emits the same plan at the new size.
    // The signature was reconciled by resize(), so this must be a cache hit: no
    // rebuild, and — critically — no second feedback-history wipe (§V22).
    await backend.compile(fixturePlan({ size: [128, 128] }));
    expect(backend.status.resourceBuilds).toBe(builds);
    expect(backend.status.temporalResets).toBe(resets);
  });

  it("does rebuild when the compiler asks for a size the live targets no longer have", async () => {
    const { backend } = await harness();
    await backend.compile(fixturePlan());
    const builds = backend.status.resourceBuilds;

    backend.resize("scene", [128, 128]);

    // The plan still says 64×64 for scene — descriptors no longer match, so this is a
    // real structural change, not a spurious cache hit on stale descriptors.
    await backend.compile(fixturePlan());
    expect(backend.status.resourceBuilds).toBe(builds + 1);
  });

  it("keeps the memory estimate in step with live resizes (§V24)", async () => {
    const { backend } = await harness();
    await backend.compile(fixturePlan());
    const before = backend.status.estimatedResourceBytes;

    backend.resize("scene", [128, 128]);
    // scene is rgba16float: 128² − 64² pixels at 8 bytes each.
    expect(backend.status.estimatedResourceBytes).toBe(before + (128 * 128 - 64 * 64) * 8);
  });
});

describe("vgpu backend — capability truth (T96, §V51)", () => {
  it("excludes r32float without float32-filterable, includes it with the feature", async () => {
    const plain = await harness();
    expect(plain.backend.capabilities?.formats).not.toContain("r32float");
    expect(plain.backend.capabilities?.formats).toContain("rgba16float");

    const filterable = await harness(
      { features: ["float32-filterable"] },
      { requiredFeatures: ["float32-filterable"] },
    );
    expect(filterable.backend.capabilities?.formats).toContain("r32float");
  });
});

describe("vgpu backend — recovery hardening (T98)", () => {
  /** Wraps the mock host so `create` fails a set number of times before succeeding. */
  function flaky(inner: MockGpuHost, failures: number): MockGpuHost & { setFailures(n: number): void } {
    let remaining = failures;
    return {
      ...inner,
      get instrumentation() {
        return inner.instrumentation;
      },
      get sessionsCreated() {
        return inner.sessionsCreated;
      },
      loseDevice: (info) => inner.loseDevice(info),
      setFailures(n: number) {
        remaining = n;
      },
      async create(options) {
        if (remaining > 0) {
          remaining -= 1;
          throw new Error("adapter unavailable (simulated)");
        }
        return inner.create(options);
      },
    };
  }

  it("retries the rebuild and recovers on a later attempt", async () => {
    const inner = mockGpuHost();
    const host = flaky(inner, 0);
    const backend = createVgpuBackend({ host, retryDelay: () => Promise.resolve() });
    teardown.push(() => backend.dispose());
    await backend.initialize({});
    await backend.compile(fixturePlan());

    const generation = backend.status.deviceGeneration;
    host.setFailures(2); // first two re-acquires fail, the third succeeds
    inner.loseDevice();
    await until(() => backend.status.deviceGeneration > generation, "recovery after retries");
    await backend.whenSettled();

    expect(backend.status.halted).toBe(false);
  });

  it("gives up after the attempt budget and comes back through recover()", async () => {
    const inner = mockGpuHost();
    const host = flaky(inner, 0);
    const diagnostics: RuntimeDiagnostic[] = [];
    const backend = createVgpuBackend({
      host,
      maxRebuildAttempts: 2,
      retryDelay: () => Promise.resolve(),
    });
    backend.onDiagnostic((d) => diagnostics.push(d));
    teardown.push(() => backend.dispose());
    await backend.initialize({});
    await backend.compile(fixturePlan());

    host.setFailures(Number.POSITIVE_INFINITY);
    inner.loseDevice();
    await until(
      () => diagnostics.some((d) => d.code === BackendDiagnosticCode.submissionHalted),
      "halt after exhausted retries",
    );
    expect(backend.status.halted).toBe(true);

    // The GPU comes back; an explicit recover() must not be a dead end (§V23).
    host.setFailures(0);
    await backend.recover();
    expect(backend.status.halted).toBe(false);
    expect(backend.status.deviceGeneration).toBe(2);
  });

  it("lets compile() wait out the recovery window instead of throwing (R9)", async () => {
    const inner = mockGpuHost();
    const host = flaky(inner, 0);
    // The retry gate holds the recovery open so the mid-recovery window is observable.
    let releaseRetry!: () => void;
    const gate = new Promise<void>((resolve) => (releaseRetry = resolve));
    const backend = createVgpuBackend({ host, retryDelay: () => gate });
    teardown.push(() => backend.dispose());
    await backend.initialize({});
    await backend.compile(fixturePlan());

    host.setFailures(1); // first re-acquire fails, second (after the gate) succeeds
    inner.loseDevice();
    await until(() => backend.status.halted, "loss observed");

    // Issued mid-recovery: previously this threw "called before initialize()".
    const pending = backend.compile(fixturePlan({ size: [32, 32] }));
    releaseRetry();
    const compiled = await pending;
    expect(compiled.id).toBeDefined();
    expect(backend.status.halted).toBe(false);
  });

  it("halts the loop after repeated frame errors instead of throwing into rAF forever", async () => {
    const { backend, diagnostics } = await harness();
    await backend.compile(fixturePlan());

    backend.loop(() => {
      throw new Error("pass exploded");
    });
    await until(
      () => diagnostics.some((d) => d.code === BackendDiagnosticCode.submissionHalted),
      "halt after frame-error streak",
    );

    expect(backend.status.halted).toBe(true);
    expect(diagnostics.some((d) => d.code === BackendDiagnosticCode.frameError)).toBe(true);

    // The session is still alive — recover() resumes without a device rebuild.
    const generation = backend.status.deviceGeneration;
    await backend.recover();
    expect(backend.status.halted).toBe(false);
    expect(backend.status.deviceGeneration).toBe(generation);
  });
});
