import { describe, expect, it } from "vitest";
import type { RuntimeDiagnostic } from "../../domain/types/diagnostics.ts";
import type { GraphDocument } from "../../domain/types/graph.ts";
import { mockGpuHost } from "../../runtime/backend/vgpu/mock-gpu-host.ts";
import type { MockInstrumentation } from "../../runtime/backend/vgpu/mock-gpu-host.ts";
import { createVgpuBackend } from "../../runtime/backend/vgpu/vgpu-backend.ts";
import type { VgpuBackend } from "../../runtime/backend/vgpu/vgpu-backend.ts";
import { createFrameDriver } from "../../runtime/execution/frame-driver.ts";
import { offlineTransport } from "../../runtime/execution/offline-transport.ts";
import { createPointerSource } from "../../runtime/execution/pointer.ts";
import {
  blurChainGraph,
  gradientLevelsGraph,
  nominalCapabilities,
  paritySettings,
  solidGraph,
  OUTPUT_NODE_ID,
} from "../fixtures/parity-graphs.ts";
import { compileParityGraph } from "./render-harness.ts";

/**
 * T46 — command-level assertions against `vgpu/mock`.
 *
 * The backend's own suite already drives the mock hard, but always through
 * `plan-fixture.ts`: a hand-written plan that asserts what the BACKEND does with a plan.
 * This file asks the different question — what the REAL node catalogue, through the REAL
 * compiler, actually asks the GPU to do. Those are the numbers that decide whether §V6
 * ("one render per output, however many consumers"), §V8 ("no allocation in the frame
 * loop") and §V25 ("pruned work costs nothing") hold for a document a user could build,
 * rather than for a fixture written by the person asserting them.
 *
 * What the mock CAN see: pipelines, shader modules, bind groups, bind-group layouts,
 * buffers, command encoders — with their descriptors.
 *
 * What the mock CANNOT see, and why this file is not the whole story: there is no
 * `createTexture` instrumentation, bind-group texture views are opaque, and `set()` mints a
 * fresh view object each time. So every resize/rebind/lifetime question — the T94 class —
 * is invisible here and is covered on real hardware in `dawn-render.test.ts` instead.
 */

interface MockHarness {
  readonly backend: VgpuBackend;
  readonly instrumentation: () => MockInstrumentation;
  readonly diagnostics: ReadonlyArray<RuntimeDiagnostic>;
}

async function harness(): Promise<MockHarness> {
  const host = mockGpuHost();
  const backend = createVgpuBackend({ host });
  const diagnostics: RuntimeDiagnostic[] = [];
  backend.onDiagnostic((diagnostic) => diagnostics.push(diagnostic));
  await backend.initialize({});
  return {
    backend,
    instrumentation: () => {
      const live = host.instrumentation;
      if (live === undefined) throw new Error("mock host has no live device");
      return live;
    },
    diagnostics,
  };
}

async function compileOnMock(graph: GraphDocument): Promise<MockHarness & { passCount: number }> {
  const plan = compileParityGraph(graph, nominalCapabilities());
  expect(plan.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  const h = await harness();
  await h.backend.compile(plan);
  return { ...h, passCount: plan.passes.filter((pass) => pass.kind === "effect").length };
}

/**
 * Compile AND render one frame, then read the counters.
 *
 * Bind groups are built lazily on first encode, not at `compileSync()`, so a compile-only
 * measurement reports `createBindGroup: 0` and would make every per-pass claim below
 * vacuous. Rendering first is not incidental — it is what makes the numbers mean anything.
 */
async function renderAndCount(
  graph: GraphDocument,
): Promise<{ passCount: number; calls: MockInstrumentation["calls"] }> {
  const plan = compileParityGraph(graph, nominalCapabilities());
  expect(plan.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  const { backend, instrumentation } = await harness();
  try {
    const compiled = await backend.compile(plan);
    const settings = paritySettings();
    const driver = createFrameDriver({
      backend,
      transport: offlineTransport({ fps: 60, seed: settings.randomSeed, mode: "fixed-step" }),
      pointer: createPointerSource(),
      resolution: () => [settings.outputResolution.width, settings.outputResolution.height],
    });
    driver.setPlan(compiled);
    driver.step();
    return {
      passCount: plan.passes.filter((pass) => pass.kind === "effect").length,
      calls: { ...instrumentation().calls },
    };
  } finally {
    backend.dispose();
  }
}

describe("T46 — what the real catalogue asks the GPU for", () => {
  /**
   * §V6, stated as a command count rather than as a hope.
   *
   * The graph fans one Ramp out to three independent Level branches, each with its own
   * sink. The mock instruments no render passes, so "drawn once per frame" cannot be
   * counted directly — what CAN be counted is everything a second Ramp draw would have to
   * bring with it. Ramp is the only parameterised generator here, and vgpu allocates one
   * uniform buffer per parameterised pass, so:
   *
   *   1 consumer  -> 3 passes, 3 bind groups, 2 uniform buffers (ramp, level)
   *   3 consumers -> 7 passes, 7 bind groups, 4 uniform buffers (ramp, level x3)
   *
   * The buffer count grows by exactly the number of extra LEVEL passes and not at all for
   * the extra ramp consumers. Materialising per consumer instead of per output would put
   * three ramp passes in that plan and three ramp uniform buffers on that device, and the
   * delta would be 4 rather than 2.
   */
  it("a fan-out source is drawn once, not once per consumer (§V6)", async () => {
    const single = gradientLevelsGraph();
    const fan = gradientLevelsGraph();
    for (const suffix of ["b", "c"]) {
      const id = `levels${suffix}`;
      fan.nodes[id] = {
        id,
        type: "level",
        definitionVersion: 1,
        position: { x: 200, y: 200 },
        parameters: { blacklevel: 0, whitelevel: 1, invert: 0, gamma1: 1, contrast: 1, brightness: 1, opacity: 1 },
      };
      fan.edges[`fan-${suffix}`] = {
        id: `fan-${suffix}`,
        source: { nodeId: "ramp", portId: "out" },
        target: { nodeId: id, portId: "input" },
      };
      // Each extra branch needs a sink of its own, or §V25 prunes it and proves nothing.
      const sinkId = `out${suffix}`;
      fan.nodes[sinkId] = {
        id: sinkId,
        type: "output",
        definitionVersion: 1,
        position: { x: 400, y: 200 },
        parameters: {},
      };
      fan.edges[`sink-${suffix}`] = {
        id: `sink-${suffix}`,
        source: { nodeId: id, portId: "out" },
        target: { nodeId: sinkId, portId: "input" },
      };
    }

    const fanPlan = compileParityGraph(fan, nominalCapabilities());
    expect(fanPlan.passes.filter((pass) => pass.kind === "effect" && pass.nodeId === "ramp")).toHaveLength(
      1,
    );
    expect(fanPlan.pruned).toEqual([]);

    const before = await renderAndCount(single);
    const after = await renderAndCount(fan);

    expect(before.passCount).toBe(3);
    expect(after.passCount).toBe(7);
    // One bind group per pass, so this tracks the plan exactly.
    expect(before.calls.createBindGroup).toBe(before.passCount);
    expect(after.calls.createBindGroup).toBe(after.passCount);
    // The claim: +2 buffers for +2 Level passes, +0 for the two extra Ramp consumers.
    expect(after.calls.createBuffer - before.calls.createBuffer).toBe(2);
    // And no new PROGRAMS: three distinct shaders before, three after.
    expect(after.calls.createShaderModule).toBe(before.calls.createShaderModule);
    expect(after.calls.createRenderPipeline).toBe(before.calls.createRenderPipeline);
  });

  /**
   * §V25 has a cost consequence, and this is the only place it is observable.
   *
   * "The compiler prunes unreached nodes" is asserted at plan level elsewhere. What nobody
   * checks is that pruning actually SAVES the GPU work — that a dead branch produces no
   * pipeline, no shader module and no bind group. Adding four disconnected nodes must move
   * every device counter by exactly zero.
   */
  it("a pruned branch costs the device nothing at all (§V25)", async () => {
    const clean = await compileOnMock(gradientLevelsGraph());
    const cleanCounts = { ...clean.instrumentation().calls };
    clean.backend.dispose();

    const withDeadCode = gradientLevelsGraph();
    for (const [index, type] of ["ramp", "checker", "blur", "level"].entries()) {
      const id = `dead${index}`;
      withDeadCode.nodes[id] = {
        id,
        type,
        definitionVersion: 1,
        position: { x: 0, y: 400 + index * 100 },
        parameters: {},
      };
    }

    const plan = compileParityGraph(withDeadCode, nominalCapabilities());
    expect(plan.pruned.length).toBeGreaterThanOrEqual(4);

    const dirty = await compileOnMock(withDeadCode);
    try {
      expect(dirty.instrumentation().calls).toEqual(cleanCounts);
    } finally {
      dirty.backend.dispose();
    }
  });

  /**
   * §V8, on a real chain rather than on the fixture plan.
   *
   * Once a plan is warm, a frame may encode and submit and do nothing else. A command
   * encoder per frame is the whole point and is exempt; every other counter must be flat
   * over a long run. Twenty frames rather than two, because the failure this catches — a
   * pipeline or bind group created lazily on some later path — does not show up on frame
   * three.
   */
  it("a warm frame loop allocates nothing on a real blur chain (§V8)", async () => {
    const plan = compileParityGraph(blurChainGraph(), nominalCapabilities());
    const { backend, instrumentation, diagnostics } = await harness();
    try {
      const compiled = await backend.compile(plan);
      const settings = paritySettings();
      const driver = createFrameDriver({
        backend,
        transport: offlineTransport({ fps: 60, seed: settings.randomSeed, mode: "fixed-step" }),
        pointer: createPointerSource(),
        resolution: () => [settings.outputResolution.width, settings.outputResolution.height],
      });
      driver.setPlan(compiled);

      for (let i = 0; i < 3; i += 1) driver.step();
      const before = { ...instrumentation().calls };
      const buildsBefore = backend.status.resourceBuilds;

      for (let i = 0; i < 20; i += 1) driver.step();
      const after = { ...instrumentation().calls };

      for (const key of Object.keys(before) as Array<keyof typeof before>) {
        if (key === "createCommandEncoder") continue;
        expect(`${key}=${after[key]}`).toBe(`${key}=${before[key]}`);
      }
      expect(after.createCommandEncoder).toBe(before.createCommandEncoder + 20);
      // The mock cannot see texture creation; the backend's own counter covers it.
      expect(backend.status.resourceBuilds).toBe(buildsBefore);
      // §V7: playback never reads back.
      expect(backend.status.readbacks).toBe(0);
      expect(diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    } finally {
      backend.dispose();
    }
  });

  /**
   * §V5 through the real parameter path.
   *
   * Changing a Level's gamma is the archetypal "drag a slider" edit. Recompiling the graph
   * after that edit must reach the backend as a plan whose STRUCTURE is unchanged, so no
   * shader module and no pipeline is created — the values land in the existing uniform
   * buffer. The backend suite proves the backend honours an identical signature; this
   * proves the compiler actually produces one for an edit a user makes.
   */
  it("a parameter edit produces no new pipeline or shader module (§V5)", async () => {
    const { backend, instrumentation, diagnostics } = await harness();
    try {
      const before = gradientLevelsGraph();
      await backend.compile(compileParityGraph(before, nominalCapabilities()));
      const baseline = { ...instrumentation().calls };
      const buildsBefore = backend.status.resourceBuilds;

      const edited = gradientLevelsGraph();
      edited.nodes["levels"]!.parameters["gamma1"] = 1.75;
      const editedPlan = compileParityGraph(edited, nominalCapabilities());
      await backend.compile(editedPlan);

      expect(instrumentation().calls.createRenderPipeline).toBe(baseline.createRenderPipeline);
      expect(instrumentation().calls.createShaderModule).toBe(baseline.createShaderModule);
      expect(instrumentation().calls.createBindGroup).toBe(baseline.createBindGroup);
      expect(backend.status.resourceBuilds).toBe(buildsBefore);
      expect(diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    } finally {
      backend.dispose();
    }
  });

  /**
   * The control case for the one above: a STRUCTURAL edit must cost something.
   *
   * Without this, "a parameter edit rebuilds nothing" would also pass on a backend that
   * never rebuilds anything, which is a much worse bug and would look identical.
   */
  it("a structural edit does build a new pipeline", async () => {
    const { backend, instrumentation } = await harness();
    try {
      await backend.compile(compileParityGraph(gradientLevelsGraph(), nominalCapabilities()));
      const baseline = instrumentation().calls.createRenderPipeline;

      const extended = gradientLevelsGraph();
      extended.nodes["extra"] = {
        id: "extra",
        type: "blur",
        definitionVersion: 1,
        position: { x: 300, y: 0 },
        parameters: { size: 3, filter: "gaussian", extend: "hold" },
      };
      // Rewire ramp -> extra -> levels. `e1` is the fixture's own ramp -> levels edge, so
      // it is REPLACED rather than added; `e-extra` is the new second half.
      extended.edges["e1"] = {
        id: "e1",
        source: { nodeId: "ramp", portId: "out" },
        target: { nodeId: "extra", portId: "input" },
      };
      extended.edges["e-extra"] = {
        id: "e-extra",
        source: { nodeId: "extra", portId: "out" },
        target: { nodeId: "levels", portId: "input" },
      };
      const extendedPlan = compileParityGraph(extended, nominalCapabilities());
      expect(extendedPlan.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
      expect(extendedPlan.order).toContain("extra");
      await backend.compile(extendedPlan);

      // A shader the device has never seen: a new module AND a new pipeline.
      expect(instrumentation().calls.createRenderPipeline).toBeGreaterThan(baseline);
    } finally {
      backend.dispose();
    }
  });

  /**
   * The exact device cost of the smallest possible graph, Solid -> Output.
   *
   * Written as equalities, not bounds, because the point is to notice a change. A
   * duplicated module, a second pipeline for the same program or a per-frame bind group is
   * the classic slow leak: nothing looks wrong, nothing fails, and the cost multiplies with
   * graph size. Two passes, two distinct shaders, one uniform buffer (Output takes no
   * parameters), one bind group each, one command encoder for the one frame.
   */
  it("costs exactly two programs and two bind groups for Solid -> Output", async () => {
    const { passCount, calls } = await renderAndCount(solidGraph());
    expect(passCount).toBe(2);
    expect(calls.createShaderModule).toBe(2);
    expect(calls.createRenderPipeline).toBe(2);
    expect(calls.createBindGroupLayout).toBe(2);
    expect(calls.createBindGroup).toBe(2);
    // Solid declares `color`; Output declares nothing. One parameterised pass, one buffer.
    expect(calls.createBuffer).toBe(1);
    expect(calls.createCommandEncoder).toBe(1);
    // Nothing in v1 emits a compute pass or a query set (§V58).
    expect(calls.createComputePipeline).toBe(0);
    expect(calls.createQuerySet).toBe(0);
  });

  /**
   * The sink presents into a target the plan names, and readback addresses that target by
   * the compiler's id — not by the node id (§V59).
   *
   * Worth pinning here because everything downstream (export, preview, the parity suite
   * itself) addresses output by `OutputRef`, and an id scheme change would otherwise show
   * up as an unrelated "unknown output" much later.
   */
  it("names the sink's render target port-scoped, not node-scoped (§V59)", async () => {
    const plan = compileParityGraph(solidGraph(), nominalCapabilities());
    const sink = plan.outputs.find((output) => output.nodeId === OUTPUT_NODE_ID);
    expect(sink).toBeDefined();
    expect(sink!.resourceId).not.toBe(OUTPUT_NODE_ID);
    expect(sink!.resourceId).toContain(OUTPUT_NODE_ID);
    expect(sink!.portId).not.toBe("");

    const { backend, diagnostics } = await harness();
    try {
      await backend.compile(plan);
      await expect(backend.readOutput("no-such-output")).rejects.toThrow(/unknown output/i);
      expect(diagnostics.some((d) => d.severity === "error")).toBe(true);
    } finally {
      backend.dispose();
    }
  });
});
