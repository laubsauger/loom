import { beforeAll, describe, expect, it } from "vitest";
import { Buffer } from "node:buffer";
import { createGraphStore } from "@domain/graph/store.ts";
import { createDomainBus } from "@domain/commands/index.ts";
import type { ParameterValue } from "@domain/types/parameters.ts";
import { createNodeRegistry } from "@nodes/registry/registry.ts";
import { allNodeDefinitions } from "@nodes/definitions/index.ts";
import { noiseNode } from "@nodes/definitions/noise.ts";
import { NOISE_FRAGMENT_WGSL } from "@nodes/shaders/noise.wgsl.ts";
import { nodeGpuHost, probeDawn } from "@runtime/backend/vgpu/node-gpu-host.ts";
import { settings } from "../../examples/documents/builders.ts";
import { displacementStackDocument } from "../../examples/documents/displacement-stack.ts";
import { renderHeadless } from "./render-harness.ts";
import { decodeComponents } from "./pixel-compare.ts";

// Test-only reference: the previous 16-iteration corner loop. Never a product mode.
const REFERENCE_PERLIN4 = `fn perlin4(p: vec4f, seed: u32) -> f32 {
  let base = floor(p);
  let cell = vec4i(base);
  let f = p - base;
  let u = quintic(f);
  var acc = 0.0;
  for (var k = 0u; k < 16u; k = k + 1u) {
    let o = vec4f(
      f32(k & 1u), f32((k >> 1u) & 1u),
      f32((k >> 2u) & 1u), f32((k >> 3u) & 1u),
    );
    let w = mix(vec4f(1.0) - u, u, o);
    acc = acc + (((w.x * w.y) * (w.z * w.w)) * dot(grad4(cell + vec4i(o), seed), f - o));
  }
  return acc * 1.2;
}`;
const PERLIN4 = /fn perlin4\(p: vec4f, seed: u32\) -> f32 \{[\s\S]*?return acc \* 1\.2;\n\}/;
const referenceShader = NOISE_FRAGMENT_WGSL.replace(PERLIN4, REFERENCE_PERLIN4);
const referenceNode = {
  ...noiseNode,
  type: "noise-loop-reference",
  compile: ((context) => {
    const result = noiseNode.compile(context);
    return { ...result, passes: result.passes.map(pass => {
      if (typeof pass !== "object" || pass === null || !("kind" in pass) || pass.kind !== "effect") {
        throw new Error("Noise reference did not emit an effect pass");
      }
      return { ...pass, shader: referenceShader };
    }) };
  }) satisfies typeof noiseNode.compile,
};

beforeAll(async () => {
  const probe = await probeDawn();
  expect(probe.available, probe.error).toBe(true);
});

async function fixture(parameters: Record<string, ParameterValue>) {
  const store = createGraphStore();
  const { bus } = createDomainBus({ store, registry: createNodeRegistry([...allNodeDefinitions, referenceNode]).view() });
  const result = await bus.execute("graph.applyPatch", {
    baseRevision: store.view.getGraph().revision,
    operations: [
      { op: "addNode", ref: "$noise", type: referenceNode.type, position: { x: 0, y: 0 }, parameters: { type: "perlin4d", period: 0.3, harmon: 2, t4d: 0.37, speed: 0.1, ...parameters } },
      { op: "addNode", ref: "$out", type: "output", position: { x: 300, y: 0 } },
      { op: "connect", source: { nodeId: "$noise", portId: "out" }, target: { nodeId: "$out", portId: "input" } },
    ], label: "Noise optimization comparison",
  }, { actor: { kind: "system", id: "noise-test" }, projectId: "noise-test", capabilities: [] });
  expect(result.status).toBe("applied");
  const graph = store.view.getGraph();
  const outputNodeId = Object.values(graph.nodes).find(node => node.type === "output")?.id;
  if (outputNodeId === undefined) throw new Error("Missing output node");
  return { graph, outputNodeId };
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  // A generic deep-equality matcher enumerates millions of typed-array keys and
  // exhausts the worker heap at full HD. Compare raw bytes without materializing keys.
  return Buffer.from(a.buffer, a.byteOffset, a.byteLength).equals(Buffer.from(b.buffer, b.byteOffset, b.byteLength));
}

describe("T1265 — full-resolution Noise optimization", () => {
  it("expands all 16 corners in their original accumulation order", () => {
    const body = NOISE_FRAGMENT_WGSL.match(PERLIN4)?.[0];
    expect(body).toBeDefined();
    expect([...body!.matchAll(/let k = (\d+)u;/g)].map(match => Number(match[1]))).toEqual(Array.from({ length: 16 }, (_, i) => i));
    expect(body).not.toContain("for (");
    expect(referenceShader).not.toBe(NOISE_FRAGMENT_WGSL);
  });

  const cases: Array<{ name: string; parameters: Record<string, ParameterValue>; width: number; height: number }> = [
    { name: "720p", parameters: {}, width: 1280, height: 720 },
    { name: "1080p", parameters: { seed: 19 }, width: 1920, height: 1080 },
    { name: "transformed color", parameters: { mono: false, seed: -3, t: [-0.4, 0.7, -0.3], s: [0.7, 1.3, 0.8], r: 37, t4d: -0.7, s4d: 1.9 }, width: 384, height: 216 },
    { name: "base octave", parameters: { harmon: 0, seed: 0 }, width: 384, height: 216 },
    { name: "eight extra octaves", parameters: { harmon: 8, seed: 2147483647, period: 0.07 }, width: 384, height: 216 },
    { name: "HDR", parameters: { mono: false, amp: 3, offset: -0.6, exp: 1.3, seed: 101 }, width: 384, height: 216 },
  ];
  it.each(cases)("$name repeats exactly and stays within float rounding of the reference", async ({ parameters, width, height }) => {
    const { graph, outputNodeId } = await fixture(parameters);
    const request = { graph, outputNodeId, settings: settings({ outputResolution: { width, height } }), frames: 8, capture: [0, 3, 7], animate: true };
    const optimizedNode = { ...referenceNode, compile: noiseNode.compile };
    const reference = await renderHeadless({ ...request, host: nodeGpuHost(), nodes: [referenceNode] });
    const first = await renderHeadless({ ...request, host: nodeGpuHost(), nodes: [optimizedNode] });
    const second = await renderHeadless({ ...request, host: nodeGpuHost(), nodes: [optimizedNode] });
    for (const result of [reference, first, second]) expect(result.diagnostics.filter(d => d.severity === "error")).toEqual([]);
    expect(first.frames).toHaveLength(3);
    expect(sameBytes(first.frames[0]!.bytes, first.frames[2]!.bytes)).toBe(false);
    for (let frame = 0; frame < 3; frame++) {
      expect(sameBytes(first.frames[frame]!.bytes, second.frames[frame]!.bytes)).toBe(true);
      const old = decodeComponents(reference.frames[frame]!.bytes, "rgba16float");
      const next = decodeComponents(first.frames[frame]!.bytes, "rgba16float");
      // Per-component bound, no allowance for a percentage of bad pixels. The
      // owner accepted rounding, not a precision reduction or nondeterministic replay.
      let worst = 0;
      for (let i = 0; i < old.length; i++) {
        const error = Math.abs(next[i]! - old[i]!) / Math.max(1, Math.abs(old[i]!));
        worst = Math.max(worst, error);
      }
      expect(worst).toBeLessThanOrEqual(1 / 1024);
    }
  }, 90_000);

  it("replays the animated full-HD displacement chain exactly on independent devices", async () => {
    const request = { graph: displacementStackDocument.graph, settings: settings({ outputResolution: { width: 1920, height: 1080 } }), frames: 8, capture: [0, 3, 7], animate: true };
    const first = await renderHeadless({ ...request, host: nodeGpuHost() });
    const second = await renderHeadless({ ...request, host: nodeGpuHost() });
    expect(sameBytes(first.frames[0]!.bytes, first.frames[2]!.bytes)).toBe(false);
    for (let i = 0; i < 3; i++) expect(sameBytes(first.frames[i]!.bytes, second.frames[i]!.bytes)).toBe(true);
  }, 90_000);
});
