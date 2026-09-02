// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { createMemoryStorage, installDomStubs } from "@ui/testing/install-dom-stubs.ts";
import { installFlowStubs } from "@editor/graph-canvas/testing.tsx";
import type { BackendCapabilities, CompiledExecutionPlan } from "@domain/types/backend.ts";
import type { LoomBackend } from "@runtime/backend/index.ts";
import { App } from "./app.tsx";
import { createAppRuntime } from "./app-runtime.ts";
import type { AppRuntime } from "./app-runtime.ts";
import type { GpuStatus } from "./gpu-status.ts";

/**
 * B32/T326 — the cook policy reaches the backend (§V157, §V220).
 *
 * `setCookPolicy` had no production caller: every call site in the tree was a test or a
 * fixture stub, so T254's static-plan gate was unreachable and the backend sat on its
 * `"always"` default forever. A gate that shipped, was tested, and could not be entered.
 *
 * §V157 keeps this switch forever as the permanent bisect for "is it cooking?", which
 * only works if something actually flips it — so the test is that a real frame of the
 * composed app sets a policy, and that changing the control changes what the backend gets.
 */

beforeAll(() => {
  installDomStubs();
  installFlowStubs();
});
afterEach(cleanup);

const CAPABILITIES: BackendCapabilities = {
  tier: "B",
  features: [],
  formats: ["rgba8unorm", "rgba8unorm-srgb", "rgba16float", "r32float", "depth24plus"],
  timestampQuery: false,
  limits: { maxTextureDimension2D: 8192 },
};

function newRuntime(): AppRuntime {
  return createAppRuntime({
    identityStorage: null,
    actor: { kind: "human", id: "tester", label: "Tester" },
  });
}

function fixture() {
  const policies: string[] = [];
  const backend = {
    status: {
      initialized: true, disposed: false, halted: false, deviceGeneration: 1,
      temporalResets: 0, resourceBuilds: 0, framesSubmitted: 0, readbacks: 0,
      stale: false, estimatedResourceBytes: 0,
    },
    initialize: () => Promise.resolve(CAPABILITIES),
    compile: (plan: unknown) => Promise.resolve({ id: "f", logical: plan } as CompiledExecutionPlan),
    render() {}, resize() {},
    readOutput: () => Promise.reject(new Error("no GPU")),
    onDiagnostic: () => () => {},
    dispose() {},
    loop: () => ({ stop() {} }),
    updateUniforms() {}, resetTemporalHistory() {},
    recover: () => Promise.resolve(),
    present: (_canvas: unknown, options: { outputId: string }) => ({
      id: "p", outputId: options.outputId, setOutput() {}, dispose() {},
    }),
    previewHost: () => ({ setPreviewProgram() {}, presentPreviews() {}, dispose() {} }),
    onGpuTimings: () => () => {},
    compileShader: () => Promise.resolve({ ok: false, validated: false, diagnostics: [] }),
    readBuffer: () => Promise.reject(new Error("no GPU")),
    registerMediaSource: () => () => {},
    setCookPolicy: (policy: string) => policies.push(policy),
  } as unknown as LoomBackend;
  return { backend, policies };
}

async function mount(runtime: AppRuntime, backend: LoomBackend) {
  const status: GpuStatus = { kind: "ready", capabilities: CAPABILITIES, baseline: true, backend };
  await act(async () => {
    render(<App runtime={runtime} storage={createMemoryStorage()} gpuProbe={() => Promise.resolve(status)} />);
  });
}

describe("T326 — the cook policy is set on the backend", () => {
  it("tells the backend a policy at all, which nothing did before", async () => {
    const runtime = newRuntime();
    const gpu = fixture();
    await mount(runtime, gpu.backend);
    expect(gpu.policies.length).toBeGreaterThan(0);
    runtime.dispose();
  });

  it("defaults to ALWAYS, the behaviour the product already had (§V157)", async () => {
    const runtime = newRuntime();
    const gpu = fixture();
    await mount(runtime, gpu.backend);
    // Not because "auto" is unsafe — T340 fixed the lag that made it so, and
    // `cook-parity.test.ts` compares the value visible at EVERY frame index. Turning the
    // gate on for everyone is a decision about what every project does per frame, and its
    // evidence is the example census rather than one measured graph.
    expect(gpu.policies[0]).toBe("always");
    runtime.dispose();
  });

  it("sends what the switch is turned to, so the bisect actually bisects", async () => {
    const runtime = newRuntime();
    const gpu = fixture();
    await mount(runtime, gpu.backend);

    const select = screen.getByTestId("cook-policy") as HTMLSelectElement;
    expect(select.value).toBe("always");
    await act(async () => {
      fireEvent.change(select, { target: { value: "auto" } });
    });

    // §V157 keeps this control forever as "is it cooking?" — a switch the user can move
    // that the backend never hears is exactly the shape of the bug this closes.
    expect(gpu.policies.at(-1)).toBe("auto");
    runtime.dispose();
  });
});
