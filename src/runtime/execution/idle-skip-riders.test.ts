import { describe, expect, it } from "vitest";
import { compileGraph } from "../../compiler/index.ts";
import type { BackendCapabilities, FrameInputs } from "../../domain/types/backend.ts";
import type { GraphDocument, ProjectSettings } from "../../domain/types/graph.ts";
import type { ShaderloomBackend } from "../backend/index.ts";
import { createVgpuBackend } from "../backend/index.ts";
import { mockGpuHost } from "../backend/vgpu/mock-gpu-host.ts";
import { createNodeRegistry } from "../../nodes/registry/registry.ts";
import { allNodeDefinitions } from "../../nodes/definitions/index.ts";
import { createFrameDriver } from "./frame-driver.ts";
import { createPointerSource } from "./pointer.ts";

/**
 * The idle gate and the riders on the frame seam (§V225, §V155, T254, B27).
 *
 * §V225 asks whether a graph whose ONLY motion is a value chain survives T254's whole-plan
 * idle skip. Two separate guarantees answer it, and they are separate because they can
 * break independently:
 *
 *  1. A SKIPPED FRAME STILL RUNS ITS RIDERS. The skip returns from `backend.render`, not
 *     from the driver's tick, so `onFrame` — which carries the value-graph evaluation, the
 *     animated push and the pulse watcher — fires either way. That is what makes §V155
 *     hold under the gate: a Lag keeps integrating through skipped frames rather than
 *     losing a trajectory it can never recover.
 *
 *  2. A CHANGED VALUE UN-SKIPS THE NEXT FRAME. `updateUniforms` marks the program dirty,
 *     so the write a value chain produces is itself what re-opens the gate.
 *
 * MEASURED, not reasoned (§V206). Against the real backend on the mock host, over five
 * frames of a static checker→level→output plan:
 *
 *   cookPolicy "always" (the current default) ....... 0 skipped
 *   cookPolicy "auto",  no uniform change ........... 5 skipped
 *   cookPolicy "auto",  uniform written each frame .. 0 skipped
 *
 * WORTH KNOWING FOR THE REVIEW: `setCookPolicy` has no production caller — every call site
 * in the tree is a test or a fixture stub — so the gate is unreachable in the product
 * today and `cookPolicy` stays "always". These guarantees are therefore forward-looking,
 * which is exactly when they are cheapest to pin and easiest to lose.
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

const frameInputs = (frameIndex: number): FrameInputs => ({
  frame: {
    timeSeconds: frameIndex / 60,
    deltaSeconds: 1 / 60,
    frameIndex,
    mode: "offline",
    randomSeed: 1,
  },
  pointer: { x: 0, y: 0, buttons: 0 },
  resolution: [64, 64],
});

describe("§V155 — a skipped frame still advances its riders", () => {
  it("calls onFrame even when render does nothing at all", () => {
    // A backend that renders NOTHING models the gate exactly: the skip is a return from
    // `render`, and the driver cannot tell the difference — which is the point.
    let renders = 0;
    let observed = 0;
    const backend = {
      render() {
        renders += 1;
      },
      loop: () => ({ stop() {} }),
    } as unknown as ShaderloomBackend;

    const driver = createFrameDriver({
      backend,
      transport: {
        next: () => frameInputs(renders).frame,
        reset() {},
      } as never,
      pointer: createPointerSource(),
      resolution: () => [64, 64] as const,
      onFrame: () => {
        observed += 1;
      },
    });
    driver.setPlan({ id: "p" } as never);
    driver.step();
    driver.step();

    // If the value graph rode a seam the gate could suppress, a Lag would lose every
    // skipped frame and its trajectory would diverge with nothing to notice (§V155).
    expect(observed).toBe(2);
    expect(renders).toBe(2);
  });
});

describe("§V225 — a value chain's uniform write re-opens the idle gate (T254)", () => {
  it("skips a static plan under auto, and stops skipping the moment a value is written", async () => {
    const registry = createNodeRegistry(allNodeDefinitions).view();
    const plan = compileGraph({
      graph: staticGraph(),
      settings: SETTINGS,
      registry,
      capabilities: CAPABILITIES,
    });
    expect(plan.diagnostics.filter((diagnostic) => diagnostic.severity === "error")).toEqual([]);
    const levelPass = plan.passes.find(
      (pass) => "nodeId" in pass && pass.nodeId === "l" && "uniforms" in pass,
    ) as { id: string; uniforms: Record<string, unknown> } | undefined;
    expect(levelPass).toBeDefined();

    const backend = createVgpuBackend({ host: mockGpuHost() });
    try {
      await backend.initialize({});
      const compiled = await backend.compile(plan);

      // The CURRENT default. Nothing in the product calls `setCookPolicy`, so this is what
      // the app actually runs, and nothing is skipped at all.
      let before = backend.status.framesSkipped ?? 0;
      for (let frame = 0; frame < 5; frame += 1) backend.render(compiled, frameInputs(frame));
      expect((backend.status.framesSkipped ?? 0) - before).toBe(0);

      // The gate engaged: a genuinely static plan re-encoding identical pixels is the case
      // T254 exists for, and it takes all five.
      backend.setCookPolicy("auto");
      before = backend.status.framesSkipped ?? 0;
      for (let frame = 5; frame < 10; frame += 1) backend.render(compiled, frameInputs(frame));
      expect((backend.status.framesSkipped ?? 0) - before).toBe(5);

      // §V225's actual question. A value chain reaches the GPU as a uniform write, and the
      // write is what marks the program dirty — so the graph that moves is the graph that
      // renders, with no separate signal needed and none to forget to send.
      before = backend.status.framesSkipped ?? 0;
      for (let frame = 10; frame < 15; frame += 1) {
        backend.updateUniforms({
          passId: (levelPass as { id: string }).id,
          values: { ...(levelPass as { uniforms: Record<string, unknown> }).uniforms, brightness: 1 + frame * 0.01 },
        });
        backend.render(compiled, frameInputs(frame));
      }
      expect((backend.status.framesSkipped ?? 0) - before).toBe(0);
    } finally {
      backend.dispose();
    }
  });
});
