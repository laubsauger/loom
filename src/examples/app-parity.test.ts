import { describe, expect, it } from "vitest";

import { compileGraph } from "../compiler/index.ts";
import type { EffectPassDescriptor } from "../runtime/backend/plan.ts";
import { createComponentSystem } from "../domain/components/index.ts";
import { loadProject } from "../domain/project/index.ts";
import type { ChannelResolver } from "../domain/parameters/resolve.ts";
import { installStarterComponents } from "../editor/component/index.ts";
import { allNodeDefinitions } from "../nodes/definitions/index.ts";
import { createNodeRegistry } from "../nodes/registry/registry.ts";
import { listExamples } from "./catalogue.ts";
import { TIER_B_CAPABILITIES } from "./runner.ts";

/**
 * T790 — the APP-PARITY gate, built from B155's post-mortem.
 *
 * The example runner and the app are two compile entry points, and they differed in two
 * INPUTS, which is how E43 shipped 935/935 green on Dawn and black in the app:
 *
 *  1. COMPONENTS. The app always passes a components view, so it always FLATTENS; the
 *     runner never did, so `flatten.ts` dropping edge `order` (§V131) was invisible to
 *     every gate — the compiler's own sort is correct, and only the flattened copy lost
 *     the field. Every variadic port in the running app fell back to the id tiebreak.
 *  2. CHANNELS. The app's structural compile resolves with the live channel resolver;
 *     the runner resolves with none, so driven parameters fall back at info severity and
 *     a validation path that ERRORS on a live value (the B155 range error that turned
 *     `plan.ok` false and blacked the document) can never fire headless.
 *
 * This gate compiles every shipped example the way the APP does — components view built
 * the way `app-runtime.ts` boots it (starters first, then the document's own library),
 * and a channel resolver attached — and asserts no error-severity diagnostic. The
 * resolver answers EXTREME values rather than replaying audio: the parity property is
 * that a document's validity must not depend on what a signal was doing at the instant
 * of a compile, so any value a channel could ever produce must compile clean. A sweep at
 * −1e6, 0 and +1e6 catches the whole out-of-range class value-independently, which is
 * stronger than any recording. Channels answer only number-typed parameters; for any
 * other definition the resolver declines, which is the ordinary "not attached" state.
 */

const registryBase = createNodeRegistry(allNodeDefinitions).view();

function appCompile(fileText: string, channelValue: number) {
  const system = createComponentSystem(registryBase);
  installStarterComponents(system.components);
  const loaded = loadProject(fileText, { nodes: system.nodes });
  if (!loaded.ok) throw new Error(`did not load: ${loaded.reason}`);
  for (const definition of loaded.components) system.components.register(definition);
  const channels: ChannelResolver = (_name, context) =>
    context.definition.type === "number" ? channelValue : undefined;
  const plan = compileGraph({
    graph: loaded.document.graph,
    settings: loaded.document.settings,
    registry: system.nodes,
    capabilities: TIER_B_CAPABILITIES,
    components: system.components.view(),
    resolution: { channels },
  });
  return plan;
}

describe("T790 — every example compiles the way the APP compiles it", () => {
  const sweep = [-1e6, 0, 1e6];
  for (const file of listExamples()) {
    it(`${file.fileName} carries no error at any channel value`, () => {
      for (const value of sweep) {
        const plan = appCompile(file.text, value);
        const errors = plan.diagnostics
          .filter((d) => d.severity === "error")
          .map((d) => `${d.code}: ${d.message}`);
        expect(errors, `${file.fileName} @ channel=${value}`).toEqual([]);
      }
    });
  }

  /**
   * §V739's detail, applied: a gate whose right and wrong answers coincide cannot fail.
   * E43 is the shipped document whose declared variadic order CONTRADICTS the
   * alphabetical one — `e-clip-pick` sorts before `e-stand-pick`, but `order` puts stand
   * first — so this is the example-level pin that the app's flattened compile binds the
   * Switch's inputs by DECLARED order. When flatten.ts dropped `order`, index 0
   * presented the fileless movie clip and the whole rack rendered black (B155).
   */
  it("E43's Switch binds stand before clip — declared order, through the app's flattening", () => {
    const file = listExamples().find((entry) => entry.fileName === "E43-Splice.loom.json");
    if (file === undefined) throw new Error("E43-Splice.loom.json is not shipped");
    const plan = appCompile(file.text, 0);
    const pick = plan.passes.find(
      (pass): pass is EffectPassDescriptor => pass.kind === "effect" && pass.nodeId === "pick",
    );
    expect(pick).toBeDefined();
    const bindings = pick?.textures?.map((texture) => texture.resourceId);
    expect(bindings?.[0]).toContain("stand");
    expect(bindings?.[1]).toContain("clip");
  });
});
