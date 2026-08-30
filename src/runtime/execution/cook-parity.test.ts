import { describe, expect, it } from "vitest";
import { compileGraph } from "../../compiler/index.ts";
import type { BackendCapabilities } from "../../domain/types/backend.ts";
import type { GraphDocument, ProjectSettings } from "../../domain/types/graph.ts";
import { createVgpuBackend } from "../backend/index.ts";
import { mockGpuHost } from "../backend/vgpu/mock-gpu-host.ts";
import { createNodeRegistry } from "../../nodes/registry/registry.ts";
import { allNodeDefinitions } from "../../nodes/definitions/index.ts";
import { createFrameDriver } from "./frame-driver.ts";
import { createPointerSource } from "./pointer.ts";

/**
 * §V157's oracle: "auto" must equal "always" at EVERY FRAME INDEX (T340, T254).
 *
 * The invariant is about what is ON SCREEN, not about how many commands were encoded. A
 * skipped frame is CORRECT when the pixels would have been identical — that is the entire
 * point of the gate — so comparing encode counts would fail every legitimate skip.
 *
 * So this compares the VALUE VISIBLE at each frame index: the value carried by the most
 * recent frame that actually encoded. Under "always" that is this frame's value; under
 * "auto" it is this frame's value when the frame rendered, and the previous one when it
 * was skipped. Identical sequences mean the gate never changed a picture.
 *
 * §V157 warns that the failure SELF-CORRECTS by the final frame, so an end-state
 * comparison passes it. This compares every index for exactly that reason — and it did
 * catch the real thing: with the push after `render`, the frame motion starts on is
 * skipped and its value lands one frame late.
 */

const SETTINGS: ProjectSettings = {
  outputResolution: { width: 64, height: 64 },
  workingFormat: "rgba16float",
  randomSeed: 1,
  previewLongEdge: 192,
  previewFps: 30,
  limits: {
    maxResolution: 4096,
    maxDispatch: 65_535,
    maxBufferBytes: 268_435_456,
    memoryBudgetBytes: 1_073_741_824,
  },
};

const CAPABILITIES: BackendCapabilities = {
  tier: "B",
  features: [],
  formats: ["rgba8unorm", "rgba8unorm-srgb", "rgba16float", "r32float", "depth24plus"],
  timestampQuery: false,
  limits: { maxTextureDimension2D: 8192 },
};

/** checker → level → output: static by construction, so the gate can actually engage. */
function staticGraph(): GraphDocument {
  return {
    revision: 1,
    groups: {},
    nodes: {
      c: { id: "c", type: "checker", definitionVersion: 1, position: { x: 0, y: 0 }, parameters: {} },
      l: {
        id: "l",
        type: "level",
        definitionVersion: 1,
        position: { x: 240, y: 0 },
        parameters: { brightness: 1 },
      },
      o: { id: "o", type: "output", definitionVersion: 1, position: { x: 480, y: 0 }, parameters: {} },
    },
    edges: {
      e1: { id: "e1", source: { nodeId: "c", portId: "out" }, target: { nodeId: "l", portId: "input" } },
      e2: { id: "e2", source: { nodeId: "l", portId: "out" }, target: { nodeId: "o", portId: "input" } },
    },
  } as GraphDocument;
}

/** Motion starts at frame 3 — before that the value is genuinely unchanged. */
const valueAt = (frameIndex: number): number => (frameIndex < 3 ? 1 : 1 + frameIndex * 0.01);

const FRAMES = 8;

type PushSeam = "before" | "after";

/**
 * Runs the real driver against the real backend and reports the value VISIBLE at each
 * frame index. `seam` chooses whether the uniform push happens before the encode (the
 * T340 ordering) or after it (the ordering that produced the lag).
 */
async function visibleValues(policy: "always" | "auto", seam: PushSeam): Promise<number[]> {
  const registry = createNodeRegistry(allNodeDefinitions).view();
  const plan = compileGraph({
    graph: staticGraph(),
    settings: SETTINGS,
    registry,
    capabilities: CAPABILITIES,
  });
  const levelPass = plan.passes.find(
    (pass) => "nodeId" in pass && pass.nodeId === "l" && "uniforms" in pass,
  ) as { id: string; uniforms: Record<string, unknown> } | undefined;
  if (levelPass === undefined) throw new Error("the level pass carries no uniform block");

  const backend = createVgpuBackend({ host: mockGpuHost() });
  try {
    await backend.initialize({});
    const compiled = await backend.compile(plan);
    backend.setCookPolicy(policy);

    let index = 0;
    let pushed = valueAt(0);
    const push = (): void => {
      const next = valueAt(index);
      // Only CHANGED values are written, exactly as the uniform animator does — a push
      // every frame would mark the program dirty every frame and hide the gate entirely.
      if (next === pushed) return;
      pushed = next;
      backend.updateUniforms({
        passId: levelPass.id,
        values: { ...levelPass.uniforms, brightness: next },
      });
    };

    const visible: number[] = [];
    let lastEncoded = valueAt(0);
    let skippedBefore = backend.status.framesSkipped ?? 0;

    const driver = createFrameDriver({
      backend,
      transport: {
        next: () => ({
          timeSeconds: index / 60,
          deltaSeconds: 1 / 60,
          frameIndex: index,
          mode: "offline" as const,
          randomSeed: 1,
        }),
        reset() {},
      } as never,
      pointer: createPointerSource(),
      resolution: () => [64, 64] as const,
      ...(seam === "before" ? { onBeforeFrame: () => push() } : {}),
      onFrame: () => {
        if (seam === "after") push();
      },
    });
    driver.setPlan(compiled);

    for (index = 0; index < FRAMES; index += 1) {
      driver.step();
      const skippedNow = backend.status.framesSkipped ?? 0;
      const wasSkipped = skippedNow > skippedBefore;
      skippedBefore = skippedNow;
      // A skipped frame keeps presenting what the last encoded frame produced.
      if (!wasSkipped) lastEncoded = pushed;
      visible.push(lastEncoded);
    }
    return visible;
  } finally {
    backend.dispose();
  }
}

describe("§V157 — auto shows the same picture as always, at every frame index", () => {
  it("matches frame for frame when values are pushed BEFORE the encode (T340)", async () => {
    const always = await visibleValues("always", "before");
    const auto = await visibleValues("auto", "before");

    // The reference sequence: motion starts at frame 3 and every frame carries its own value.
    expect(always).toEqual([1, 1, 1, 1.03, 1.04, 1.05, 1.06, 1.07]);
    expect(auto).toEqual(always);
  });

  it("skips frames it is ENTITLED to skip, or this proves nothing", async () => {
    // NON-VACUITY the other way. If "auto" never skipped anything the parity above would
    // be trivially true and the gate would be doing no work at all.
    const registry = createNodeRegistry(allNodeDefinitions).view();
    const plan = compileGraph({
      graph: staticGraph(),
      settings: SETTINGS,
      registry,
      capabilities: CAPABILITIES,
    });
    const backend = createVgpuBackend({ host: mockGpuHost() });
    try {
      await backend.initialize({});
      const compiled = await backend.compile(plan);
      backend.setCookPolicy("auto");
      for (let frame = 0; frame < FRAMES; frame += 1) {
        backend.render(compiled, {
          frame: { timeSeconds: 0, deltaSeconds: 1 / 60, frameIndex: frame, mode: "offline", randomSeed: 1 },
          pointer: { x: 0, y: 0, buttons: 0 },
          resolution: [64, 64],
        });
      }
      // Seven of eight: the first frame encodes, the rest are identical pixels.
      expect(backend.status.framesSkipped ?? 0).toBe(FRAMES - 1);
    } finally {
      backend.dispose();
    }
  });

  it("LOSES a frame when the push happens after the encode — the bug T340 closes", async () => {
    // The executable form of "if someone moves this back, here is what breaks". The push
    // sets the dirty mark (§V159), so doing it after `render` marks the frame that already
    // decided to skip, and the value arrives one frame late.
    const always = await visibleValues("always", "after");
    const auto = await visibleValues("auto", "after");

    expect(auto).not.toEqual(always);
    // Frame 3 is where motion starts, and it is the frame that goes missing.
    expect(always[3]).toBeCloseTo(1.03, 10);
    expect(auto[3]).toBeCloseTo(1, 10);
    // And it self-corrects, which is exactly why an end-state comparison would pass it.
    expect(auto[FRAMES - 1]).toEqual(always[FRAMES - 1]);
  });
});
