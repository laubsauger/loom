import { beforeAll, describe, expect, it } from "vitest";

import { createUniformAnimator } from "../../app/animate-parameters.ts";
import { compileGraph } from "../../compiler/index.ts";
import type { CompiledGraph } from "../../compiler/index.ts";
import { graphChannelResolver, hasAnimatedParameters } from "../../domain/channels/graph-channels.ts";
import type { GraphDocument, GraphNode, ProjectSettings } from "../../domain/types/graph.ts";
import type { StoredParameter } from "../../domain/types/parameters.ts";
import { allNodeDefinitions } from "../../nodes/definitions/index.ts";
import { createNodeRegistry } from "../../nodes/registry/registry.ts";
import { createVgpuBackend } from "../../runtime/backend/vgpu/vgpu-backend.ts";
import { nodeGpuHost, probeDawn } from "../../runtime/backend/vgpu/node-gpu-host.ts";
import { createFrameDriver } from "../../runtime/execution/frame-driver.ts";
import { offlineTransport } from "../../runtime/execution/offline-transport.ts";
import { createPointerSource } from "../../runtime/execution/pointer.ts";
import { OUTPUT_NODE_ID, paritySettings } from "../fixtures/parity-graphs.ts";
import { outputResourceIdOf } from "./render-harness.ts";

/**
 * T259 / §V163 — does a DRIVEN parameter move the picture?
 *
 * ## Why this test is on pixels and not on numbers
 *
 * The resolver was already correct: an LFO drives a parameter by name, deterministically,
 * from `FrameEvaluationInput`, and `graph-channels.test.ts` proves it returns a different
 * number at a different time. That test was green the entire time the screen did not
 * change, because nothing re-resolved per frame and nothing pushed the result at the GPU.
 * A test asserting "the resolver returns different numbers over time" would repeat that
 * mistake exactly — it is the same shape as B9, B10 and the animation gap in
 * `animation.test.ts`, where every layer passed and the seam belonged to nobody.
 *
 * So the claims here are a set, on bytes:
 *
 *   1. an LFO driving a visible parameter -> consecutive frames DIFFER;
 *   2. the same graph with that parameter STATIC -> consecutive frames are byte-identical,
 *      so what moved in (1) was the driven value and not some ambient clock in the shader;
 *   3. the same sequence rendered twice is byte-identical, because the value is a pure
 *      function of the frame (§V44, §V45) — an offline render matches the live preview.
 *
 * ## What it exercises
 *
 * The same two pieces the running app uses, not a re-implementation: `compileGraph` with
 * `resolution: { frame, channels }`, and `createUniformAnimator` — which is what
 * `use-frame-loop.ts` calls from the driver's own `onFrame`. Nothing about the plan's
 * structure is rebuilt: the animator refuses to write at all unless the per-frame plan is
 * a values-only variation of the structural one (§V5), so a version of this that
 * recompiled at frame rate could not pass.
 *
 * `driver.step()` renders a frame and THEN calls `onFrame`, so a value resolved at frame N
 * lands in frame N+1 here — one step of latency that the live path does not have, because
 * there `onFrame` runs inside the open GPU frame and the buffer write is submitted with
 * it. The assertions are on consecutive captured frames, which holds under either.
 */

const SIZE = 32;
const FPS = 60;

function drivenBy(channel: string): StoredParameter {
  return {
    mode: "driven",
    bindings: { driven: { kind: "driven", channel } },
  } as unknown as StoredParameter;
}

function node(id: string, type: string, extra: Partial<GraphNode> = {}): GraphNode {
  return {
    id,
    type,
    definitionVersion: 1,
    position: { x: 0, y: 0 },
    parameters: {},
    ...extra,
  } as GraphNode;
}

/**
 * circle -> output, with `softness` either driven by `lfo1` or pinned.
 *
 * `softness` is the edge gradient in uv units: sweeping it rewrites a wide band of texels,
 * so "the frames differ" cannot pass on one stray pixel. The circle's other parameters are
 * pinned so a default moving elsewhere in the node cannot make this test lie.
 */
function circleGraph(softness: StoredParameter | number): GraphDocument {
  return {
    revision: 1,
    groups: {},
    edges: {
      e1: {
        id: "e1",
        source: { nodeId: "shape", portId: "out" },
        target: { nodeId: OUTPUT_NODE_ID, portId: "input" },
      },
    },
    nodes: {
      // §V129: the LFO's NAME is its channel. This is the whole addressing story.
      lfo: node("lfo", "lfo", {
        label: "lfo1",
        parameters: { shape: "sine", frequency: 3, amplitude: 0.45, offset: 0.5, phase: 0 },
      }),
      shape: node("shape", "circle", {
        parameters: {
          mode: "fill",
          center: [0.5, 0.5],
          radius: [0.3, 0.3],
          softness,
          aspectcorrect: true,
        },
      }),
      [OUTPUT_NODE_ID]: node(OUTPUT_NODE_ID, "output", {}),
    },
  } as unknown as GraphDocument;
}

const settings: ProjectSettings = paritySettings({ size: SIZE });

let dawnError: string | undefined;

beforeAll(async () => {
  const probe = await probeDawn();
  dawnError = probe.error;
}, 60_000);

function requireDawn(): void {
  if (dawnError !== undefined) {
    throw new Error(`Dawn (vgpu/node) could not start, so T259 is unverified: ${dawnError}`);
  }
}

interface Capture {
  readonly frames: readonly Uint8Array[];
  /** How many uniform blocks the animator wrote across the whole run. */
  readonly written: number;
  readonly resourceBuilds: number;
}

/**
 * Renders `frames` frames the way the app does: one structural compile, one
 * `backend.compile`, and per frame a values-only re-resolve pushed with `updateUniforms`.
 */
async function render(graph: GraphDocument, frames: number): Promise<Capture> {
  const registry = createNodeRegistry(allNodeDefinitions).view();
  const backend = createVgpuBackend({ host: nodeGpuHost() });
  try {
    const capabilities = await backend.initialize({});
    const base: CompiledGraph = compileGraph({ graph, settings, registry, capabilities });
    const errors = base.diagnostics.filter((entry) => entry.severity === "error");
    expect(errors.map((entry) => entry.message)).toEqual([]);

    const outputResourceId = outputResourceIdOf(base, OUTPUT_NODE_ID);
    const compiled = await backend.compile(base);

    // Exactly the gate the frame loop uses. A static graph gets no animator at all.
    const animated = hasAnimatedParameters(graph);
    const channels = graphChannelResolver(graph, registry);
    const animator = createUniformAnimator();
    let written = 0;

    const driver = createFrameDriver({
      backend,
      transport: offlineTransport({ fps: FPS, seed: settings.randomSeed, mode: "fixed-step" }),
      pointer: createPointerSource(),
      resolution: () => [SIZE, SIZE],
      onFrame: (inputs) => {
        if (!animated) return;
        const next = compileGraph({
          graph,
          settings,
          registry,
          capabilities,
          resolution: { frame: inputs.frame, channels },
        });
        const count = animator.push(backend, base, next);
        // Null = the per-frame plan was NOT a values-only variation, which would mean the
        // frame loop had been asked to recompile at frame rate (§V5).
        expect(count, "an animated parameter changed the plan's structure").not.toBeNull();
        written += count ?? 0;
      },
    });
    driver.setPlan(compiled);

    const captured: Uint8Array[] = [];
    for (let index = 0; index < frames; index += 1) {
      driver.step();
      const image = await backend.readOutput(outputResourceId);
      captured.push(image.bytes);
    }

    return { frames: captured, written, resourceBuilds: backend.status.resourceBuilds };
  } finally {
    backend.dispose();
  }
}

function differingBytes(a: Uint8Array, b: Uint8Array): number {
  let count = 0;
  for (let index = 0; index < a.length; index += 1) if (a[index] !== b[index]) count += 1;
  return count;
}

describe("T259 — a driven parameter moves the picture (§V163)", () => {
  it("renders different frames while an LFO drives a visible parameter", async () => {
    requireDawn();
    const capture = await render(circleGraph(drivenBy("lfo1")), 4);

    // Frame 0 renders from the compile-time value; the pushed values reach the frames
    // after it, so the claim is about CONSECUTIVE frames rather than about frame 0.
    for (let index = 1; index + 1 < capture.frames.length; index += 1) {
      const previous = capture.frames[index];
      const current = capture.frames[index + 1];
      if (previous === undefined || current === undefined) throw new Error("missing frame");
      // Not "at least one byte": a soft edge sweeping across a 32x32 circle rewrites a
      // wide band, and a one-texel difference would be noise rather than animation.
      expect(
        differingBytes(previous, current),
        `frames ${index} and ${index + 1} are identical — nothing moved`,
      ).toBeGreaterThan(20);
    }

    expect(capture.written, "no uniform block was ever written").toBeGreaterThan(0);
  }, 60_000);

  it("renders IDENTICAL frames once the same parameter is static", async () => {
    requireDawn();
    const graph = circleGraph(0.4);
    expect(hasAnimatedParameters(graph), "the control graph is not actually static").toBe(false);

    const capture = await render(graph, 4);
    expect(capture.written).toBe(0);

    for (let index = 0; index + 1 < capture.frames.length; index += 1) {
      const previous = capture.frames[index];
      const current = capture.frames[index + 1];
      if (previous === undefined || current === undefined) throw new Error("missing frame");
      // If these differ, whatever moved in the case above was an ambient clock inside the
      // shader and not the driven value — which would also make offline renders
      // irreproducible (§V44).
      expect(differingBytes(previous, current)).toBe(0);
    }
  }, 60_000);

  it("never rebuilds GPU resources to animate a value (§V5)", async () => {
    requireDawn();
    const capture = await render(circleGraph(drivenBy("lfo1")), 6);
    // One build, for the one `backend.compile`. Anything above that is a per-frame
    // recompile wearing a different name.
    expect(capture.resourceBuilds).toBe(1);
  }, 60_000);

  it("replays byte-for-byte, because the value is a function of the frame (§V44, §V45)", async () => {
    requireDawn();
    const first = await render(circleGraph(drivenBy("lfo1")), 3);
    const second = await render(circleGraph(drivenBy("lfo1")), 3);

    expect(first.frames.length).toBe(second.frames.length);
    for (let index = 0; index < first.frames.length; index += 1) {
      const a = first.frames[index];
      const b = second.frames[index];
      if (a === undefined || b === undefined) throw new Error("missing frame");
      expect(differingBytes(a, b), `frame ${index} differs between two identical runs`).toBe(0);
    }
  }, 90_000);
});
