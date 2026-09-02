import { beforeAll, describe, expect, it } from "vitest";

import {
  classifyEdit,
  compileGraph,
  diffPlans,
  isUniformOnlyChange,
} from "../../compiler/index.ts";
import type { CompiledGraph } from "../../compiler/index.ts";
import { SHADER_SOURCE_PARAMETER } from "../../domain/commands/apply-patch.ts";
import type { FrameInputs, ReadbackImage } from "../../domain/types/backend.ts";
import type { RuntimeDiagnostic } from "../../domain/types/diagnostics.ts";
import type { GraphDocument, ProjectSettings } from "../../domain/types/graph.ts";
import { allNodeDefinitions } from "../../nodes/definitions/index.ts";
import type { PassDescriptor } from "../../runtime/backend/plan.ts";
import { createNodeRegistry } from "../../nodes/registry/registry.ts";
import { SHARED_UNIFORMS_WGSL } from "../../runtime/backend/shared-uniforms.ts";
import { createVgpuBackend } from "../../runtime/backend/vgpu/vgpu-backend.ts";
import type { LoomBackend } from "../../runtime/backend/index.ts";
import { nodeGpuHost, probeDawn } from "../../runtime/backend/vgpu/node-gpu-host.ts";
import { TOLERANCE_CROSS_GPU, decodeComponents } from "../headless/pixel-compare.ts";

/**
 * T23 — the Phase 0 exit criteria, executed (doc §24).
 *
 *   1. Changing a uniform updates the output live.
 *   2. Editing valid WGSL recompiles the effect.
 *   3. Invalid WGSL keeps the last valid output and shows an error.
 *
 * ## What would make a weak version of this pass while the product is broken
 *
 * (1) is the dangerous one. "Changing a uniform updates the output" is trivially true of
 * a system that rebuilds every pipeline on every keystroke — the picture changes, the
 * criterion looks met, and dragging a slider stutters at 4 fps because each frame of the
 * drag recompiled a shader. §V5 is the actual claim, and it is a NEGATIVE one: the
 * pipeline is untouched. So the assertion here is `status.resourceBuilds`, the backend's
 * own count of how many times it built GPU objects, and it must not move. A test that
 * only checked the pixels changed would pass against the broken product.
 *
 * (3) has the mirror hazard: "keeps the last valid output" is satisfied on paper by a
 * system that renders black, because black is *an* output. The assertion is therefore
 * that the post-failure frame is byte-identical to the last good frame AND that the good
 * frame was not itself blank — checked, not assumed.
 *
 * Everything runs on Dawn through `nodeGpuHost` (§V47): a real device, no canvas, no
 * compositor. A mock device executes no shaders, so it cannot tell a live uniform update
 * from a no-op, and it cannot fail to compile broken WGSL — which makes it the wrong
 * instrument for all three of these.
 */

const SIZE = 64;
const SOLID = [0.25, 0.5, 0.75, 1] as const;

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

/** Fails loudly rather than skipping: a machine without Dawn has verified none of this. */
function requireDawn(): void {
  if (dawnError !== undefined) {
    throw new Error(
      `Dawn (vgpu/node) could not start, so the Phase 0 exit criteria are unverified: ${dawnError}`,
    );
  }
}

/**
 * The Phase 0 spike graph, exactly as doc §24 describes it: a solid generator, a custom
 * WGSL effect with one uniform, and an output node with an offscreen target between them.
 */
function spikeGraph(options: { amount: number; source?: string }): GraphDocument {
  return {
    revision: 1,
    nodes: {
      src: {
        id: "src",
        type: "solid",
        definitionVersion: 1,
        position: { x: 0, y: 0 },
        parameters: { color: [...SOLID] },
      },
      fx: {
        id: "fx",
        type: "customWgsl",
        definitionVersion: 1,
        position: { x: 200, y: 0 },
        parameters: {
          amount: options.amount,
          ...(options.source === undefined ? {} : { [SHADER_SOURCE_PARAMETER]: options.source }),
        },
      },
      out: {
        id: "out",
        type: "output",
        definitionVersion: 1,
        position: { x: 400, y: 0 },
        parameters: {},
      },
    },
    edges: {
      e1: { id: "e1", source: { nodeId: "src", portId: "out" }, target: { nodeId: "fx", portId: "input" } },
      e2: { id: "e2", source: { nodeId: "fx", portId: "out" }, target: { nodeId: "out", portId: "input" } },
    },
    groups: {},
  };
}

function spikeSettings(): ProjectSettings {
  return {
    outputResolution: { width: SIZE, height: SIZE },
    workingFormat: "rgba8unorm",
    // T375 (§V56): the criteria below are about a UNIFORM reaching a shader, asserted
    // against exact linear values. The Output node's display transform would ride on top
    // of every one of them, so this fixture turns it off and measures the working space.
    colorPolicy: { workingSpace: "linear", displayTransform: "none" },
    randomSeed: 7,
    previewLongEdge: 192,
    previewFps: 20,
    limits: {
      maxResolution: 4096,
      maxDispatch: 65_535,
      maxBufferBytes: 268_435_456,
      memoryBudgetBytes: 1_073_741_824,
    },
  };
}

/**
 * A valid edit with an unmistakable signature: channels rotate b→r, r→g, g→b. Chosen
 * over "multiply by a different constant" because a rotation cannot be confused with the
 * uniform change in criterion 1 — if the recompile silently did not happen, the pixels
 * come back in the ORIGINAL channel order and the test says so.
 */
const ROTATED_SOURCE = `${SHARED_UNIFORMS_WGSL}
struct Params { amount: f32, };

@group(0) @binding(0) var inputSampler: sampler;
@group(0) @binding(1) var inputTexture: texture_2d<f32>;
@group(0) @binding(2) var<uniform> frameU: SharedFrame;
@group(0) @binding(3) var<uniform> params: Params;

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let color = textureSampleLevel(inputTexture, inputSampler, uv, 0.0);
  return vec4f(color.b, color.r, color.g, color.a) * vec4f(params.amount, params.amount, params.amount, 1.0);
}`;

/** Fails WGSL compilation: `notAFunction` is not declared anywhere. */
const BROKEN_SOURCE = `${SHARED_UNIFORMS_WGSL}
struct Params { amount: f32, };

@group(0) @binding(0) var inputSampler: sampler;
@group(0) @binding(1) var inputTexture: texture_2d<f32>;
@group(0) @binding(2) var<uniform> frameU: SharedFrame;
@group(0) @binding(3) var<uniform> params: Params;

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  return notAFunction(uv) * params.amount;
}`;

function registry() {
  return createNodeRegistry(allNodeDefinitions).view();
}

function compile(graph: GraphDocument, capabilities: Parameters<typeof compileGraph>[0]["capabilities"]): CompiledGraph {
  const plan = compileGraph({ graph, settings: spikeSettings(), registry: registry(), capabilities });
  const errors = plan.diagnostics.filter((d) => d.severity === "error");
  if (errors.length > 0) throw new Error(`spike graph failed to compile: ${errors.map((d) => d.message).join("; ")}`);
  return plan;
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
    resolution: [SIZE, SIZE],
  };
}

function outputResourceId(plan: CompiledGraph): string {
  const match = plan.outputs.find((output) => output.nodeId === "out");
  if (match === undefined) throw new Error("the spike plan materialized no output for node 'out'");
  return match.resourceId;
}

interface Harness {
  readonly backend: LoomBackend;
  readonly diagnostics: RuntimeDiagnostic[];
  readonly capabilities: Awaited<ReturnType<LoomBackend["initialize"]>>;
}

async function harness(): Promise<Harness> {
  const backend = createVgpuBackend({ host: nodeGpuHost() });
  const diagnostics: RuntimeDiagnostic[] = [];
  backend.onDiagnostic((diagnostic) => diagnostics.push(diagnostic));
  // §V12: compile against what the DEVICE reports, never an assumed report.
  const capabilities = await backend.initialize({});
  return { backend, diagnostics, capabilities };
}

const quantise8 = (value: number): number => Math.round(Math.min(1, Math.max(0, value)) * 255) / 255;

/**
 * The colour of a frame that is one colour everywhere — and a hard failure if it is not.
 *
 * Every claim in this file is RELATIVE to this reading rather than to an absolute triple.
 * That is deliberate and it is not a weakening: the criteria under test are "the uniform
 * reaches the shader" and "the edited shader is what ran", and both are properties of how
 * one frame relates to another. The absolute value of a Solid's output is a colour-
 * management claim (§V56/§V57) belonging to a different gate, and pinning it here would
 * make this file fail for a reason it is not about. What IS pinned absolutely: the frame
 * is uniform, its channels are distinct, and its alpha is 1 — without those three, a
 * relative comparison could be comparing two blank images.
 */
function uniformColor(image: ReadbackImage, what: string): readonly [number, number, number, number] {
  const components = decodeComponents(image.bytes, image.format);
  expect(components.length, `${what}: empty readback`).toBeGreaterThan(0);
  const first = [
    components[0] ?? 0,
    components[1] ?? 0,
    components[2] ?? 0,
    components[3] ?? 0,
  ] as const;
  let worst = 0;
  for (let i = 0; i < components.length; i += 1) {
    worst = Math.max(worst, Math.abs((components[i] ?? 0) - (first[i % 4] ?? 0)));
  }
  expect(worst, `${what}: the frame is not one colour (spread ${worst.toFixed(6)})`).toBe(0);
  return first;
}

function expectColor(
  image: ReadbackImage,
  expected: readonly number[],
  what: string,
): void {
  const actual = uniformColor(image, what);
  let worst = 0;
  for (let i = 0; i < 4; i += 1) worst = Math.max(worst, Math.abs((actual[i] ?? 0) - (expected[i] ?? 0)));
  expect(
    worst,
    `${what}: expected ${expected.map((v) => v.toFixed(4)).join(", ")}, got ${actual.map((v) => v.toFixed(4)).join(", ")}`,
  ).toBeLessThanOrEqual(TOLERANCE_CROSS_GPU);
}

describe("T23 Phase 0 exit — changing a uniform updates the output live (§V5)", () => {
  it("writes the new value and rebuilds NOTHING", async () => {
    requireDawn();
    const { backend, diagnostics, capabilities } = await harness();
    try {
      const before = compile(spikeGraph({ amount: 1 }), capabilities);
      const compiledBefore = await backend.compile(before);
      const buildsAfterFirstCompile = backend.status.resourceBuilds;
      expect(buildsAfterFirstCompile).toBeGreaterThan(0);

      backend.render(compiledBefore, frameInputs(0));
      const first = await backend.readOutput(outputResourceId(before));
      const base = uniformColor(first, "amount = 1 renders a passthrough of the solid");
      // Three distinct channels and opaque alpha: the reference every later assertion is
      // relative to must be a real picture, not a grey or a blank.
      expect(new Set([base[0], base[1], base[2]]).size).toBe(3);
      expect(base[3]).toBe(1);

      // The edit. This is what a slider drag produces: one parameter, one node.
      const after = compile(spikeGraph({ amount: 0.5 }), capabilities);

      // The classifier's answer, and the plan-level proof behind it. Both, because the
      // classifier could be right about the wrong plan or wrong about the right one.
      expect(
        classifyEdit(
          { kind: "parameter", nodeId: "fx", parameters: ["amount"] },
          { graph: spikeGraph({ amount: 0.5 }), registry: registry() },
        ).work,
      ).toBe("uniform-update");
      expect(isUniformOnlyChange(before, after)).toBe(true);
      const diff = diffPlans(before, after);
      expect(diff.resourcesToCreate).toEqual([]);
      expect(diff.passesToBuild).toEqual([]);

      // THE assertion. A recompile here would still change the picture; §V5 says the
      // picture must change without one.
      const compiledAfter = await backend.compile(after);
      expect(
        backend.status.resourceBuilds,
        "a uniform-only change must not build a single GPU resource (§V5)",
      ).toBe(buildsAfterFirstCompile);

      backend.render(compiledAfter, frameInputs(1));
      const second = await backend.readOutput(outputResourceId(after));
      // The shader is `rgb * params.amount`, alpha untouched. Halving `amount` must halve
      // exactly the three colour channels of the frame we just measured — a change the
      // uniform can produce and nothing else in this graph can.
      expectColor(
        second,
        [quantise8(base[0] * 0.5), quantise8(base[1] * 0.5), quantise8(base[2] * 0.5), base[3]],
        "amount = 0.5 halves rgb and leaves alpha",
      );

      expect(diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    } finally {
      backend.dispose();
    }
  }, 60_000);

  it("the in-place uniform write path changes the picture with no compile at all", async () => {
    requireDawn();
    const { backend, capabilities } = await harness();
    try {
      const plan = compile(spikeGraph({ amount: 1 }), capabilities);
      const compiled = await backend.compile(plan);
      const builds = backend.status.resourceBuilds;
      backend.render(compiled, frameInputs(0));
      const base = uniformColor(
        await backend.readOutput(outputResourceId(plan)),
        "reference frame at amount = 1",
      );

      const pass = plan.passes.find((entry) => nodeOf(entry) === "fx");
      expect(pass, "the custom WGSL node must emit a pass").toBeDefined();

      // `updateUniforms` carries values and nothing else — the type has no room for a
      // shader, a binding or a size, which is what makes §V5 structural rather than
      // merely observed. This is the path a 60 Hz drag actually takes.
      backend.updateUniforms({ passId: pass?.id ?? "", values: { amount: 0.25 } });
      expect(backend.status.resourceBuilds).toBe(builds);

      backend.render(compiled, frameInputs(1));
      const bytes = await backend.readOutput(outputResourceId(plan));
      expectColor(
        bytes,
        [quantise8(base[0] * 0.25), quantise8(base[1] * 0.25), quantise8(base[2] * 0.25), base[3]],
        "updateUniforms reaches the shader",
      );
    } finally {
      backend.dispose();
    }
  }, 60_000);
});

describe("T23 Phase 0 exit — editing valid WGSL recompiles the effect", () => {
  it("rebuilds the pass, keeps the targets, and the new maths reaches the pixels", async () => {
    requireDawn();
    const { backend, diagnostics, capabilities } = await harness();
    try {
      const before = compile(spikeGraph({ amount: 1 }), capabilities);
      const compiledBefore = await backend.compile(before);
      backend.render(compiledBefore, frameInputs(0));
      const base = uniformColor(
        await backend.readOutput(outputResourceId(before)),
        "the default source is a passthrough",
      );
      expect(new Set([base[0], base[1], base[2]]).size).toBe(3);
      const builds = backend.status.resourceBuilds;

      const after = compile(spikeGraph({ amount: 1, source: ROTATED_SOURCE }), capabilities);

      // A shader-body edit is a recompile, not a uniform write — the opposite of §V5's
      // case, and the plan says so before the device is asked.
      expect(isUniformOnlyChange(before, after)).toBe(false);
      expect(
        classifyEdit(
          { kind: "shaderSource", nodeId: "fx", interfaceChanged: false },
          { graph: spikeGraph({ amount: 1, source: ROTATED_SOURCE }), registry: registry() },
        ).work,
      ).toBe("recompile-shader");
      const diff = diffPlans(before, after);
      expect(diff.passesToBuild, "only the edited node's pass is rebuilt").toEqual(
        before.passes.filter((p) => nodeOf(p) === "fx").map((p) => p.id),
      );
      // Nothing structural changed, so every target survives the edit (§V62b).
      expect(diff.resourcesToCreate).toEqual([]);
      expect(diff.resourcesToDestroy).toEqual([]);

      const compiledAfter = await backend.compile(after);
      expect(backend.status.resourceBuilds, "a shader edit DOES build").toBeGreaterThan(builds);

      backend.render(compiledAfter, frameInputs(1));
      const rotated = await backend.readOutput(outputResourceId(after));
      // b, r, g, a — a permutation of the SAME frame, which no uniform value could have
      // produced. If the recompile silently did not happen, the channels come back in
      // their original order and this fails naming both triples.
      expectColor(rotated, [base[2], base[0], base[1], base[3]], "the edited shader is what ran");

      expect(diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    } finally {
      backend.dispose();
    }
  }, 60_000);
});

/**
 * ## §V9 — was RED until T217. Kept as history, because how it failed is worth knowing.
 *
 * This gate found a real defect: on a real Dawn device, invalid WGSL was ACCEPTED. vgpu
 * raises `VGPUError VGPU-COMPILE-FAILED` from an ASYNCHRONOUS pipeline-store path
 * (`where: "<label>.compileSync"`), so it never reached `buildResources`'s `try/catch` and
 * surfaced as an unhandled rejection on stderr. `compile()` resolved, the broken program
 * installed, the previous VALID program was released, `stale` stayed false, and zero
 * diagnostics reached `onDiagnostic`. The picture only looked retained because Dawn
 * discarded the whole command buffer.
 *
 * The part worth remembering: `vgpu-backend.test.ts` covered this same invariant on
 * `vgpu/mock` and PASSED throughout — the mock rejected bad WGSL synchronously and Dawn did
 * not. A gate greener than the product. V9 had been false on real hardware since the
 * backend landed, and every mock-based test agreed it was fine.
 *
 * T217 fixed both halves: the backend now drains the device's async verdict before
 * installing a program, and the mock can be told to fail asynchronously through vgpu's own
 * error-scope path — so the mock exercises the same code a device does rather than a
 * kinder parallel one. Do not weaken either half; a mock more forgiving than the device is
 * worse than no mock, because it converts an open question into a false answer.
 */
describe("T23 Phase 0 exit — invalid WGSL keeps the last valid output and shows an error (§V9)", () => {
  it("retains the last good pixels, flags the output stale, and reports an error against the node", async () => {
    requireDawn();
    const { backend, diagnostics, capabilities } = await harness();
    try {
      const good = compile(spikeGraph({ amount: 1, source: ROTATED_SOURCE }), capabilities);
      const compiledGood = await backend.compile(good);
      backend.render(compiledGood, frameInputs(0));
      const lastValid = await backend.readOutput(outputResourceId(good));
      // "Keeps the last valid output" is only a claim worth making if the last valid
      // output was a picture. A blank frame satisfies a naive reading of §V9, so the
      // reference is checked for being one colour, three distinct channels, opaque.
      const good0 = uniformColor(lastValid, "the last valid frame");
      expect(new Set([good0[0], good0[1], good0[2]]).size).toBe(3);
      expect(Math.max(good0[0], good0[1], good0[2])).toBeGreaterThan(0);
      const builds = backend.status.resourceBuilds;

      // The broken edit. The graph COMPILER is happy — it does not parse WGSL — so this
      // failure necessarily happens at the device, which is the case §V9 is about.
      const broken = compile(spikeGraph({ amount: 1, source: BROKEN_SOURCE }), capabilities);
      expect(broken.ok, "the graph compiler does not parse WGSL and must not claim to").toBe(true);

      let installed: Awaited<ReturnType<LoomBackend["compile"]>> | undefined;
      let rejection: unknown;
      try {
        installed = await backend.compile(broken);
      } catch (error) {
        rejection = error;
      }

      expect(
        rejection,
        "compile() accepted a shader Dawn refuses to build, and installed it as the live program",
      ).toBeDefined();
      expect(installed).toBeUndefined();

      // §V9, first clause: the retained program is what still renders, flagged stale.
      expect(backend.status.stale, "the output is flagged stale, not silently swapped").toBe(true);
      expect(backend.status.resourceBuilds, "a failed build releases and rebuilds nothing").toBe(
        builds,
      );

      // §V27: the error is a structured diagnostic attributed to the node whose shader
      // failed — that attribution is what puts it on the node badge and in the problems
      // tab, and it is what an unattributed "compile failed" string cannot do. The
      // backend publishes it on `onDiagnostic`, which is the stream the composition root
      // funnels into the problems list; a stderr dump reaches nobody.
      const errors = diagnostics.filter((d) => d.severity === "error");
      expect(errors.length, "no error diagnostic reached the problems tab").toBeGreaterThan(0);
      expect(errors.map((d) => d.nodeId)).toContain("fx");
      expect(errors.every((d) => d.message.length > 0)).toBe(true);

      // §V9, the part a "did it change?" test would miss: keep rendering and the pixels
      // are the LAST VALID ones, byte for byte — not black, not the broken shader's.
      backend.render(compiledGood, frameInputs(1));
      const afterFailure = await backend.readOutput(outputResourceId(good));
      expect(Array.from(afterFailure.bytes)).toEqual(Array.from(lastValid.bytes));

      // Recovery (doc §27: "a visible shader error followed by recovery").
      const fixed = compile(spikeGraph({ amount: 0.5, source: ROTATED_SOURCE }), capabilities);
      const compiledFixed = await backend.compile(fixed);
      expect(backend.status.stale).toBe(false);
      backend.render(compiledFixed, frameInputs(2));
      const recovered = await backend.readOutput(outputResourceId(fixed));
      expectColor(
        recovered,
        [quantise8(good0[0] * 0.5), quantise8(good0[1] * 0.5), quantise8(good0[2] * 0.5), good0[3]],
        "the fixed shader renders again, at the new amount",
      );
    } finally {
      backend.dispose();
    }
  }, 60_000);
});
