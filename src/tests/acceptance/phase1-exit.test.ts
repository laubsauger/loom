import { beforeAll, describe, expect, it } from "vitest";

import { compileGraph, diffPlans, feedbackToReset } from "../../compiler/index.ts";
import type { CompiledGraph } from "../../compiler/index.ts";
import { loadProject, serializeProjectDocument } from "../../domain/project/index.ts";
import type { BackendCapabilities, FrameInputs, ReadbackImage } from "../../domain/types/backend.ts";
import type { RuntimeDiagnostic } from "../../domain/types/diagnostics.ts";
import type { GraphDocument } from "../../domain/types/graph.ts";
import { allNodeDefinitions } from "../../nodes/definitions/index.ts";
import type { PassDescriptor } from "../../runtime/backend/plan.ts";
import { createNodeRegistry } from "../../nodes/registry/registry.ts";
import type { ShaderloomBackend } from "../../runtime/backend/index.ts";
import { createVgpuBackend } from "../../runtime/backend/vgpu/vgpu-backend.ts";
import type { GpuHost, GpuSession } from "../../runtime/backend/vgpu/gpu-host.ts";
import { mockGpuHost } from "../../runtime/backend/vgpu/mock-gpu-host.ts";
import { nodeGpuHost, probeDawn } from "../../runtime/backend/vgpu/node-gpu-host.ts";
import { createPreviewSystem } from "../../runtime/previews/system.ts";
import { DEFAULT_PREVIEW_VIEW } from "../../runtime/previews/types.ts";
import type { PreviewRequest } from "../../runtime/previews/types.ts";
import { decodeComponents } from "../headless/pixel-compare.ts";
import { POC, POC_SIZE, pocDocument, pocGraph, pocSettings } from "./poc-graph.ts";

/**
 * T49 — the Phase 1 exit criteria, executed (doc §24), on the doc §27 PoC graph.
 *
 *   1. A feedback graph can run for ten minutes without accumulating GPU resources.
 *   2. One output can feed multiple consumers without duplicate execution.
 *   3. Any visible branch can show a live preview without readback.
 *
 * ## How each of these is faked, and what is done about it here
 *
 * (1) "ten minutes without accumulating" is a LEAK check, not a smoke test. A version that
 * runs some frames and asserts nothing crashed passes against a backend that allocates a
 * target per frame. So the assertions are on counters that must not move — `resourceBuilds`,
 * `estimatedResourceBytes`, `temporalResets` on a real device, and every `create*` counter
 * the mock device instruments except the one command encoder per frame. The frame count is
 * the criterion taken literally — 36000 frames is ten minutes at 60 fps — which at 64×64
 * costs about ten seconds of wall clock on Dawn. It is not a wall-clock simulation and does
 * not pretend to be one; it is the same number of allocations a ten-minute session makes.
 *
 * (2) "without duplicate execution" is not "both consumers render". A graph that renders
 * the shared producer twice renders both consumers perfectly. §V6 is a COUNT — one pass per
 * frame, one texture reused — and `plan.passes` is literally the per-frame encode list
 * (`vgpu-backend.encode` walks it exactly once per frame), so counting it is counting
 * executions. A negative control is included: the same graph with the fan-out undone — a
 * second identical Noise for the second consumer — must cost exactly one more pass, which
 * is what shows the count is measuring shared execution rather than counting nodes.
 *
 * (3) "without readback" is asserted structurally by
 * `src/runtime/previews/no-readback.test.ts` (it scans the scheduling path's sources for
 * every spelling of readback). The behavioural half is here: four branches of a live graph
 * are previewed on a real device for several frames while `status.readbacks` — the
 * backend's own counter, incremented inside `readOutput` — is required to stay at zero.
 * That claim would be vacuous if the previews never rendered, so the preview program's
 * bindings are checked against the main plan's resource ids and the surface is required to
 * have actually been drawn into.
 */

const FRAMES_LONG_RUN = 36_000; // ten minutes at 60 fps — the criterion, literally
const FRAMES_MOCK_RUN = 600;

/**
 * A pass's node, where it has one. `swap` passes carry no `nodeId` — the union is closed
 * (§V58) so this narrows rather than casts, and a new pass kind stops it compiling.
 */
function nodeOf(pass: PassDescriptor): string | undefined {
  return pass.kind === "swap" ? undefined : pass.nodeId;
}

let dawnError: string | undefined;

beforeAll(async () => {
  const probe = await probeDawn();
  dawnError = probe.error;
}, 60_000);

function requireDawn(): void {
  if (dawnError !== undefined) {
    throw new Error(
      `Dawn (vgpu/node) could not start, so the Phase 1 exit criteria are unverified: ${dawnError}`,
    );
  }
}

function registry() {
  return createNodeRegistry(allNodeDefinitions).view();
}

function compile(graph: GraphDocument, capabilities: BackendCapabilities): CompiledGraph {
  return compileGraph({ graph, settings: pocSettings(), registry: registry(), capabilities });
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
    pointer: { x: 0, y: 0, buttons: 0 },
    resolution: [POC_SIZE, POC_SIZE],
  };
}

function outputResourceId(plan: CompiledGraph): string {
  const match = plan.outputs.find((output) => output.nodeId === POC.output);
  if (match === undefined) throw new Error("the PoC plan materialized no output");
  return match.resourceId;
}

/** Dawn, plus a handle on the live `GPUDevice` so a surface stub can mint real textures. */
function capturingDawnHost(): { host: GpuHost; device: () => GPUDevice | undefined } {
  const inner = nodeGpuHost();
  let session: GpuSession | undefined;
  return {
    host: {
      label: "dawn-capturing",
      async create(options) {
        session = await inner.create(options);
        return session;
      },
    },
    device: () => session?.gpu.gpu as GPUDevice | undefined,
  };
}

interface Harness {
  readonly backend: ShaderloomBackend;
  readonly diagnostics: RuntimeDiagnostic[];
  readonly capabilities: BackendCapabilities;
}

async function harness(host: GpuHost): Promise<Harness> {
  const backend = createVgpuBackend({ host });
  const diagnostics: RuntimeDiagnostic[] = [];
  backend.onDiagnostic((diagnostic) => diagnostics.push(diagnostic));
  const capabilities = await backend.initialize({});
  return { backend, diagnostics, capabilities };
}

function errorsOf(diagnostics: readonly RuntimeDiagnostic[]): RuntimeDiagnostic[] {
  return diagnostics.filter((diagnostic) => diagnostic.severity === "error");
}

/** Largest per-channel difference between two readbacks of the same size and format. */
function maxDifference(a: ReadbackImage, b: ReadbackImage): number {
  expect(a.format).toBe(b.format);
  expect(a.rowStride).toBe(b.rowStride);
  const left = decodeComponents(a.bytes, a.format);
  const right = decodeComponents(b.bytes, b.format);
  let worst = 0;
  for (let i = 0; i < left.length; i += 1) {
    worst = Math.max(worst, Math.abs((left[i] ?? 0) - (right[i] ?? 0)));
  }
  return worst;
}

describe("T49 Phase 1 exit — the doc §27 PoC graph is a real project", () => {
  it("survives save and reload through the loader a user's file goes through", () => {
    const text = serializeProjectDocument(pocDocument());
    const loaded = loadProject(text, { nodes: registry() });

    expect(loaded.ok, loaded.ok ? "" : loaded.reason).toBe(true);
    if (!loaded.ok) return;
    // §V10: nothing in this graph may come back as a placeholder, and nothing may be
    // migrated or clamped — an example whose shape only survives because the loader
    // rewrote it is not the shape that was saved.
    expect(loaded.placeholders).toEqual([]);
    expect(loaded.changed).toBe(false);
    expect(loaded.diagnostics.filter((d) => d.severity !== "info")).toEqual([]);
    expect(loaded.document.graph).toEqual(pocGraph());
  });

  it("has the shape doc §27 asks for: fan-out, one temporal edge, a multi-input composite", () => {
    const graph = pocGraph();
    const consumersOf = (nodeId: string): string[] =>
      Object.values(graph.edges)
        .filter((edge) => edge.source.nodeId === nodeId)
        .map((edge) => `${edge.target.nodeId}:${edge.target.portId}`)
        .sort();

    expect(consumersOf(POC.noise)).toEqual([`${POC.colorize}:input`, `${POC.displace}:source`]);
    expect(consumersOf(POC.composite)).toEqual([`${POC.feedback}:in`, `${POC.output}:input`]);

    // Multi-input composite: two distinct input ports, each fed by a different branch.
    const compositeInputs = Object.values(graph.edges)
      .filter((edge) => edge.target.nodeId === POC.composite)
      .map((edge) => `${edge.source.nodeId}->${edge.target.portId}`)
      .sort();
    expect(compositeInputs).toEqual([`${POC.level}->in1`, `${POC.colorize}->in2`].sort());

    // §V4: the cycle mix → echo → warp → grade → mix is legal because exactly ONE of its
    // edges leaves a temporal output. Every other edge is a current-frame edge.
    const feedbackSources = Object.values(graph.edges).filter(
      (edge) => edge.source.nodeId === POC.feedback,
    );
    expect(feedbackSources).toHaveLength(1);
    expect(feedbackSources[0]?.target).toEqual({ nodeId: POC.displace, portId: "disp" });
  });

  it("compiles with no diagnostics and prunes nothing", async () => {
    requireDawn();
    const { backend, capabilities } = await harness(nodeGpuHost());
    try {
      const plan = compile(pocGraph(), capabilities);
      expect(plan.diagnostics).toEqual([]);
      expect(plan.ok).toBe(true);
      expect(plan.pruned).toEqual([]);
      expect([...plan.order].sort()).toEqual(Object.keys(pocGraph().nodes).sort());
      expect(plan.feedback.map((pair) => pair.nodeId)).toEqual([POC.feedback]);
    } finally {
      backend.dispose();
    }
  }, 60_000);
});

describe("T49 Phase 1 exit — one output feeds multiple consumers without duplicate execution (§V6)", () => {
  it("emits exactly one pass per node and hands both consumers the same texture", async () => {
    requireDawn();
    const { backend, capabilities } = await harness(nodeGpuHost());
    try {
      const plan = compile(pocGraph(), capabilities);

      // `encode()` walks `plan.passes` once per frame, so this list IS the per-frame
      // execution order. One entry per kept node, plus one swap per feedback pair.
      // T425/§V358: a feedback loop carries its region MARKERS even at one step per
      // frame — they encode nothing and build nothing, so they are excluded the same
      // way swaps are.
      const effectPasses = plan.passes.filter((pass) => pass.kind !== "swap" && pass.kind !== "loop");
      const swapPasses = plan.passes.filter((pass) => pass.kind === "swap");
      expect(effectPasses).toHaveLength(plan.order.length);
      expect(swapPasses).toHaveLength(plan.feedback.length);

      // The claim, stated as a count: Noise has two consumers and runs once.
      const noisePasses = plan.passes.filter((pass) => nodeOf(pass) === POC.noise);
      expect(noisePasses, "Noise is executed once per frame, not once per consumer").toHaveLength(1);

      // …and the texture is REUSED, not copied: both consumers name the identical id.
      const noiseResource = plan.outputs.find((o) => o.nodeId === POC.noise)?.resourceId;
      expect(noiseResource).toBeDefined();
      const boundBy = (nodeId: string): string[] =>
        plan.passes
          .filter((pass) => nodeOf(pass) === nodeId)
          .flatMap((pass) => ("textures" in pass ? (pass.textures ?? []) : []))
          .map((binding) => binding.resourceId);
      expect(boundBy(POC.displace)).toContain(noiseResource);
      expect(boundBy(POC.colorize)).toContain(noiseResource);

      // The second fan-out, same claim: Composite runs once and feeds both the loop and
      // the output from one texture.
      expect(plan.passes.filter((pass) => nodeOf(pass) === POC.composite)).toHaveLength(1);
      const compositeResource = plan.outputs.find((o) => o.nodeId === POC.composite)?.resourceId;
      expect(boundBy(POC.feedback)).toContain(compositeResource);
      expect(boundBy(POC.output)).toContain(compositeResource);

      // NEGATIVE CONTROL. "One pass per node" is also true of a graph with no fan-out at
      // all, so on its own it does not show that SHARING is what saved the work. The
      // control is the same graph with the sharing undone: a second, identical Noise
      // wired to the second consumer. That must cost exactly one extra pass — which is
      // the pass the fan-out version does not pay for.
      const duplicated = pocGraph();
      const original = duplicated.nodes[POC.noise];
      if (original === undefined) throw new Error("the PoC graph lost its Noise node");
      duplicated.nodes["noise2"] = { ...original, id: "noise2", position: { x: -520, y: 240 } };
      duplicated.edges["e-noise-tint"] = {
        id: "e-noise-tint",
        source: { nodeId: "noise2", portId: "out" },
        target: { nodeId: POC.colorize, portId: "input" },
      };
      const unshared = compile(duplicated, capabilities);
      expect(unshared.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
      expect(
        unshared.passes.length,
        "duplicating the shared producer did not cost a pass — the counts are not measuring execution",
      ).toBe(plan.passes.length + 1);
    } finally {
      backend.dispose();
    }
  }, 60_000);

  it("builds one pipeline and one bind group per pass — no per-consumer duplicates", async () => {
    // The mock device is the one that COUNTS device calls; Dawn does not expose them.
    // A backend that materialised the shared producer once per consumer would show up
    // here as more pipelines than passes.
    const host = mockGpuHost();
    const { backend, capabilities } = await harness(host);
    try {
      const plan = compile(pocGraph(), capabilities);
      await backend.compile(plan);
      const calls = host.instrumentation?.calls;
      const effectPasses = plan.passes.filter((pass) => pass.kind !== "swap" && pass.kind !== "loop").length;
      expect(calls?.createRenderPipeline).toBe(effectPasses);
      expect(calls?.createShaderModule).toBe(effectPasses);
    } finally {
      backend.dispose();
    }
  });
});

describe("T49 Phase 1 exit — a feedback graph runs long without accumulating GPU resources (§V22)", () => {
  it(`holds every resource counter constant across ${FRAMES_LONG_RUN} frames on a real device`, async () => {
    requireDawn();
    const { backend, diagnostics, capabilities } = await harness(nodeGpuHost());
    try {
      const plan = compile(pocGraph(), capabilities);
      const compiled = await backend.compile(plan);
      const resourceId = outputResourceId(plan);

      backend.render(compiled, frameInputs(0));
      const early = await backend.readOutput(resourceId);

      const builds = backend.status.resourceBuilds;
      const bytes = backend.status.estimatedResourceBytes;
      const resets = backend.status.temporalResets;
      const readbacks = backend.status.readbacks;
      expect(builds).toBe(1);
      expect(bytes).toBeGreaterThan(0);

      // The playback segment. Nothing is read, nothing is compiled, nothing is resized.
      for (let index = 1; index < FRAMES_LONG_RUN; index += 1) {
        backend.render(compiled, frameInputs(index));
      }

      expect(backend.status.resourceBuilds, "playback rebuilt GPU resources").toBe(builds);
      expect(backend.status.estimatedResourceBytes, "the resource set grew").toBe(bytes);
      expect(backend.status.temporalResets, "feedback history was reset mid-run").toBe(resets);
      // §V7: playback itself performs no readback, so the counter is untouched by the loop.
      expect(backend.status.readbacks).toBe(readbacks);
      expect(backend.status.framesSubmitted).toBe(FRAMES_LONG_RUN);
      expect(backend.status.halted).toBe(false);
      expect(errorsOf(diagnostics)).toEqual([]);

      // NON-VACUITY: a stalled loop also has a constant resource count. The picture must
      // have kept moving — the feedback pair is advancing and the noise field animating.
      const late = await backend.readOutput(resourceId);
      expect(
        maxDifference(early, late),
        `the graph produced the same image ${FRAMES_LONG_RUN} frames apart: the loop is not running`,
      ).toBeGreaterThan(1 / 255);
    } finally {
      backend.dispose();
    }
    /*
     * T780 — 300 s, and the number is MEASURED rather than picked.
     *
     * This run takes 37-65 s alone depending on the machine's state, so the old 120 s left
     * under 2x headroom. This project now runs several agents at once, and a jsdom suite
     * measured 3.3x wall-time inflation at load 40 and worse at 110 — so a 2x margin is
     * smaller than the contention the project itself routinely creates, and the test timed
     * out for at least two workers on changes that could not have caused it.
     *
     * A timeout here is a HANG DETECTOR, not a performance gate: nothing in the suite
     * asserts on duration, so a budget that only fires under contention buys no slowdown
     * signal and costs an attribution hunt every time (§V491, §V713). 300 s is ~4.6x the
     * slow-machine time — above the contention factor, still far below a real hang.
     */
  }, 300_000);

  it(`creates nothing but one command encoder per frame across ${FRAMES_MOCK_RUN} frames (§V8)`, async () => {
    // Dawn reports totals, not per-call counts. The mock device instruments every
    // `create*`, which is the only place "no allocation inside the frame loop" is
    // directly observable — and an allocation leak shows up as a counter that climbs.
    const host = mockGpuHost();
    const { backend, capabilities } = await harness(host);
    try {
      const plan = compile(pocGraph(), capabilities);
      const compiled = await backend.compile(plan);

      // WARM-UP, and why it is not a licence to ignore the first frames: bind groups are
      // built lazily on first encode, and the feedback pair alternates between two reads,
      // so the steady state is reached at the second swap and not before. Anything that
      // is still growing after four frames is growing per frame, which is the leak this
      // test is for. The warm-up total is asserted below so it cannot hide a large one.
      const warmUp = 4;
      for (let index = 0; index < warmUp; index += 1) backend.render(compiled, frameInputs(index));
      const baseline = { ...host.instrumentation?.calls };
      const effectPasses = plan.passes.filter((pass) => pass.kind !== "swap" && pass.kind !== "loop").length;
      // One bind group per pass, plus one for the pair's other half — bounded, not per frame.
      expect(baseline.createBindGroup).toBeLessThanOrEqual(effectPasses + plan.feedback.length);

      for (let index = warmUp; index < FRAMES_MOCK_RUN; index += 1) {
        backend.render(compiled, frameInputs(index));
      }
      const after = { ...host.instrumentation?.calls };

      for (const [key, value] of Object.entries(after)) {
        const before = baseline[key as keyof typeof baseline] ?? 0;
        if (key === "createCommandEncoder") {
          // Exactly one encoder per frame, and never two.
          expect(value - before).toBe(FRAMES_MOCK_RUN - warmUp);
          continue;
        }
        expect(value, `${key} grew during playback: ${before} -> ${value}`).toBe(before);
      }
    } finally {
      backend.dispose();
    }
  }, 120_000);

  it("keeps the feedback pair — and its contents — across an unrelated structural edit (§V62)", async () => {
    requireDawn();
    const { backend, diagnostics, capabilities } = await harness(nodeGpuHost());
    try {
      const before = compile(pocGraph(), capabilities);
      const compiledBefore = await backend.compile(before);
      const resourceId = outputResourceId(before);

      // Let the loop build up real history. A one-frame-old pair is indistinguishable
      // from a freshly cleared one, so a reset would be invisible.
      for (let index = 0; index < 90; index += 1) backend.render(compiledBefore, frameInputs(index));
      const settled = await backend.readOutput(resourceId);

      // The edit: a Blur spliced into the OUTPUT branch. Connected, not pruned, changes
      // the plan — and has nothing to do with the feedback loop. (The trap this replaces:
      // adding a node that no sink reaches, which the compiler prunes, so the plan does
      // not change and the test proves nothing.)
      const edited = pocGraph();
      edited.nodes["soften"] = {
        id: "soften",
        type: "blur",
        definitionVersion: 1,
        position: { x: 390, y: 0 },
        parameters: { size: 2, filter: "gaussian", extend: "hold" },
      };
      delete edited.edges["e-mix-out"];
      edited.edges["e-mix-soften"] = {
        id: "e-mix-soften",
        source: { nodeId: POC.composite, portId: "out" },
        target: { nodeId: "soften", portId: "input" },
      };
      edited.edges["e-soften-out"] = {
        id: "e-soften-out",
        source: { nodeId: "soften", portId: "out" },
        target: { nodeId: POC.output, portId: "input" },
      };

      const after = compile(edited, capabilities);
      expect(after.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
      expect(after.order).toContain("soften");

      // The plan-level claim: the edit adds a resource and a pass, and touches neither
      // the ping-pong's identity nor its reset signature.
      const pingPongId = before.feedback[0]?.resourceId ?? "";
      expect(pingPongId).not.toBe("");
      const diff = diffPlans(before, after);
      expect(diff.resourcesToKeep).toContain(pingPongId);
      expect(feedbackToReset(before, after), "an unrelated edit asked for a reset").toEqual([]);

      const resets = backend.status.temporalResets;
      const compiledAfter = await backend.compile(after);
      expect(backend.status.temporalResets, "the recompile cleared feedback history").toBe(resets);
      expect(backend.status.lastBuild?.resourcesReused ?? 0).toBeGreaterThan(0);

      backend.render(compiledAfter, frameInputs(90));
      const continued = await backend.readOutput(outputResourceId(after));

      // THE assertion: the pair's CONTENTS survived. A reset would have restarted the
      // trail from the clear colour, which is what a device rendering this graph from
      // frame zero produces — so that is what `continued` is compared against.
      const fresh = await harness(nodeGpuHost());
      try {
        const freshPlan = compile(edited, capabilities);
        const freshCompiled = await fresh.backend.compile(freshPlan);
        fresh.backend.render(freshCompiled, frameInputs(0));
        const fromScratch = await fresh.backend.readOutput(outputResourceId(freshPlan));
        expect(
          maxDifference(continued, fromScratch),
          "after an unrelated edit the graph rendered its frame-zero image: history was reset",
        ).toBeGreaterThan(1 / 255);
      } finally {
        fresh.backend.dispose();
      }

      // And it really did continue: one blurred frame later the image is close to, but
      // not identical to, the settled one.
      expect(maxDifference(continued, settled)).toBeLessThan(0.5);
      expect(errorsOf(diagnostics)).toEqual([]);
    } finally {
      backend.dispose();
    }
  }, 120_000);
});

describe("T49 Phase 1 exit — any visible branch previews without readback (§V7)", () => {
  it("previews four live branches for many frames with the readback counter at zero", async () => {
    requireDawn();
    const { host, device } = capturingDawnHost();
    const { backend, diagnostics, capabilities } = await harness(host);
    let surfaceFrames = 0;
    try {
      const plan = compile(pocGraph(), capabilities);
      const compiled = await backend.compile(plan);

      // A structural stand-in for a canvas (§V70): the runtime is HANDED a surface and
      // never creates one, so a `{width, height, getContext}` object is all it needs.
      const context = {
        configure() {},
        unconfigure() {},
        getCurrentTexture: () => {
          surfaceFrames += 1;
          const live = device();
          if (live === undefined) throw new Error("no live Dawn device for the preview surface");
          // Dawn's preferred surface format, and the usage flags a swap-chain texture
          // carries: RENDER_ATTACHMENT | TEXTURE_BINDING.
          return live.createTexture({ size: [512, 512], format: "bgra8unorm", usage: 0x10 | 0x04 });
        },
      };
      const canvas = {
        width: 512,
        height: 512,
        getContext: (kind: string) => (kind === "webgpu" ? context : null),
      };

      const previewHost = backend.previewHost(canvas);
      const system = createPreviewSystem({ host: previewHost, capacity: 8 });

      // Doc §27: "Live previews on Noise, Colorize, Feedback, and Composite." The
      // Feedback one is the interesting entry — its source is a ping-pong pair, so its
      // binding has to be re-pointed every frame rather than bound once.
      const branches = [POC.noise, POC.colorize, POC.feedback, POC.composite];
      const requests: PreviewRequest[] = branches.map((nodeId, index) => {
        const output = plan.outputs.find((o) => o.nodeId === nodeId);
        if (output === undefined) throw new Error(`no materialized output for "${nodeId}"`);
        return {
          ref: { nodeId, portId: output.portId },
          source: { resourceId: output.resourceId, size: output.size, format: output.format, space: output.space },
          rect: { x: index * 110, y: 8, width: 96, height: 96 },
          area: { width: 96, height: 96 },
          visible: true,
          pinned: false,
          collapsed: false,
          occluded: false,
          view: DEFAULT_PREVIEW_VIEW,
        };
      });

      const readbacksBefore = backend.status.readbacks;
      let firstProgram: ReturnType<typeof system.plan> | undefined;
      for (let index = 0; index < 120; index += 1) {
        const inputs = frameInputs(index);
        const planned = system.plan({
          requests,
          frame: inputs.frame,
          surface: { x: 0, y: 0, width: 512, height: 512 },
          devicePixelRatio: 1,
          previewFps: 20,
          previewLongEdge: 192,
        });
        firstProgram ??= planned;
        backend.render(compiled, inputs);
        system.present(planned.command);
      }

      // NON-VACUITY, part one: all four branches were actually scheduled, none suspended.
      expect(firstProgram?.schedule.suspended).toEqual([]);
      expect(firstProgram?.schedule.active.map((entry) => entry.ref.nodeId).sort()).toEqual(
        [...branches].sort(),
      );

      // NON-VACUITY, part two: each preview pass samples the branch's OWN plan resource.
      // A preview program bound to nothing would also perform no readback.
      const previewSources = (firstProgram?.program.passes ?? []).flatMap((pass) =>
        (pass.textures ?? []).map((binding) => binding.resourceId),
      );
      for (const nodeId of branches) {
        const resourceId = plan.outputs.find((o) => o.nodeId === nodeId)?.resourceId;
        expect(previewSources, `no preview pass samples "${nodeId}"`).toContain(resourceId);
      }
      // The Feedback branch previews the ping-pong pair itself, not a copy of it.
      expect(previewSources).toContain(plan.feedback[0]?.resourceId);

      // NON-VACUITY, part three: the surface really received encoded frames.
      expect(surfaceFrames).toBeGreaterThan(0);

      // THE assertion. `readbacks` is incremented inside `readOutput`, the runtime's only
      // pixel-read path (§V48), so a preview implemented by reading pixels back and
      // re-uploading them cannot pass this.
      expect(
        backend.status.readbacks,
        "previewing four branches performed a GPU readback (§V7)",
      ).toBe(readbacksBefore);
      expect(errorsOf(diagnostics)).toEqual([]);

      previewHost.dispose();
    } finally {
      backend.dispose();
    }
  }, 120_000);
});
