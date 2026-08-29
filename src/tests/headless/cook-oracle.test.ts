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
