import { describe, expect, it } from "vitest";

import { buildExampleFiles } from "../../examples/example-files.ts";
import type { ExampleFile } from "../../examples/catalogue.ts";
import { exampleRegistry, requireExample } from "../../examples/runner.ts";
import { probeDawn } from "../../runtime/backend/vgpu/node-gpu-host.ts";
import { fuzzScript, renderUnderPolicy, scriptFor } from "./cook-oracle.ts";

/**
 * T249 (§V157, §V147): the cook oracle — the gate built BEFORE the cooking feature.
 *
 * Every shipped example renders twice, `cookPolicy: "always"` vs `"auto"`, through the
 * same scripted edit session (param edit, animated flip, rewire, bypass, feedback
 * pulse, mode switch, rename — each through the real bus at a fixed frame), and the
 * two runs must be byte-identical at EVERY frame index. Not the last frame: a
 * one-frame lag is THE signature cooking failure and it self-corrects by the end, so
 * an end-state comparison would wave through exactly the bug this exists to catch.
 *
 * Today "auto" IS "always" and the oracle holds trivially — which is the point: T254's
 * gating cannot land without keeping it green, and `setCookPolicy` stays forever as
 * the bisect switch when someone suspects cooking in the wild.
 */

const FRAMES = 80;

/** Oracle resolution: the comparison is policy-vs-policy, not about pixels-per-inch. */
function oracleSettings(settings: Parameters<typeof renderUnderPolicy>[0]["settings"]) {
  return { ...settings, outputResolution: { width: 128, height: 72 } };
}

describe("cook oracle (T249, §V157)", () => {
  const registry = exampleRegistry();

  const files: ExampleFile[] = buildExampleFiles().map((file) => ({
    fileName: file.fileName,
    path: file.fileName,
    text: file.text,
  }));

  for (const file of files) {
    it(`${file.fileName}: "auto" is byte-identical to "always" at every frame`, async () => {
      const probe = await probeDawn();
      if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);

      const { document } = requireExample(file);
      const settings = oracleSettings(document.settings);
      const script = scriptFor(document.graph, registry);
      expect(script.length).toBeGreaterThan(3); // the session actually edits things

      const base = { graph: document.graph, settings, registry, script, frames: FRAMES };
      const always = await renderUnderPolicy({ ...base, policy: "always" });
      const auto = await renderUnderPolicy({ ...base, policy: "auto" });

      expect(always).toHaveLength(FRAMES);
      // EVERY frame index, named on failure — "frame 51 diverged" is the whole report.
      for (let frame = 0; frame < FRAMES; frame += 1) {
        expect(auto[frame], `frame ${frame} diverged between policies`).toBe(always[frame]);
      }
      // And the run is not a static poster: the edits visibly changed the picture.
      expect(new Set(always).size).toBeGreaterThan(1);
    }, 120_000);
  }

  it("bus-fuzzed variant: seeded random edit storms agree too", async () => {
    const probe = await probeDawn();
    if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);

    const file = files[0];
    if (file === undefined) throw new Error("no examples shipped");
    const { document } = requireExample(file);
    const settings = oracleSettings(document.settings);
    const script = fuzzScript(document.graph, registry, 1337, 24, FRAMES);
    expect(script.length).toBeGreaterThan(0);

    const base = { graph: document.graph, settings, registry, script, frames: FRAMES };
    const always = await renderUnderPolicy({ ...base, policy: "always" });
    const auto = await renderUnderPolicy({ ...base, policy: "auto" });
    for (let frame = 0; frame < FRAMES; frame += 1) {
      expect(auto[frame], `frame ${frame} diverged under fuzz`).toBe(always[frame]);
    }
  }, 120_000);
});

describe("the oracle SEES the value graph (T633)", () => {
  const registry = exampleRegistry();

  /**
   * A value-graph-only animation: nothing edits the document, the ONLY motion is an LFO
   * driving a circle's softness through the channel resolver. Before T633 the oracle
   * rendered with no resolver, every driven parameter fell back to its static value, and
   * a graph like this hashed all frames identical — E33's first build did exactly that,
   * so the oracle waved through the one failure class it exists to catch.
   */
  it("an LFO-driven parameter moves the pixels with an EMPTY script", async () => {
    const probe = await probeDawn();
    if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);

    const node = (id: string, type: string, extra: Record<string, unknown> = {}) =>
      ({ id, type, definitionVersion: 1, position: { x: 0, y: 0 }, parameters: {}, ...extra }) as never;
    const graph = {
      revision: 1,
      groups: {},
      edges: {
        e1: { id: "e1", source: { nodeId: "shape", portId: "out" }, target: { nodeId: "out", portId: "input" } },
      },
      nodes: {
        // §V129: the LFO's NAME is its channel.
        lfo: node("lfo", "lfo", { label: "lfo1", parameters: { shape: "sine", frequency: 3, amplitude: 0.45, offset: 0.5, phase: 0 } }),
        shape: node("shape", "circle", {
          parameters: {
            mode: "fill",
            center: [0.5, 0.5],
            radius: [0.3, 0.3],
            softness: { mode: "driven", bindings: { driven: { kind: "driven", channel: "lfo1" } } },
            aspectcorrect: true,
          },
        }),
        out: node("out", "output", {}),
      },
    } as never;

    const settings = {
      outputResolution: { width: 128, height: 72 },
      workingFormat: "rgba8unorm",
      randomSeed: 7,
      previewLongEdge: 192,
      previewFps: 20,
      limits: { maxResolution: 4096, maxDispatch: 65_535, maxBufferBytes: 268_435_456, memoryBudgetBytes: 1_073_741_824 },
    } as never;

    const digests = await renderUnderPolicy({
      graph,
      settings,
      registry,
      policy: "always",
      script: [],
      frames: 12,
    });

    // MOTION, not just "ran": the driven softness rewrites a band of texels every frame.
    expect(new Set(digests).size).toBeGreaterThan(1);
    // And determinism holds with the resolver in the loop: the same run twice is
    // byte-identical (§V44/§V45) — the resolver must not have smuggled in a wall clock.
    const again = await renderUnderPolicy({ graph, settings, registry, policy: "always", script: [], frames: 12 });
    expect(again).toEqual(digests);
  }, 120_000);
});
