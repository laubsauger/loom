import { describe, expect, it } from "vitest";

import { CompilerDiagnosticCode } from "../../compiler/index.ts";
import type { ProjectDocument } from "../../domain/types/graph.ts";
import { example, recompile, valueGraphRun, CENTRE } from "./helpers.ts";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════
 * THE CONCEPT HELPERS COMPILE THE EXAMPLE, NOT A SEVERED COPY OF IT (§T1067, §V854)
 * ═══════════════════════════════════════════════════════════════════════════════════
 *
 * `recompile()` and `valueGraphRun()` both built a BARE `exampleRegistry()` — a node view
 * with no `components`. §T1066 is the same mistake in the cook oracle: pointed at an example
 * that instantiates library components, a bare view has no `component:...` type, so the
 * compile emits `unknown-node-type`, severs the output edge, and returns a plan with (E51)
 * zero passes. The oracle then digested an untouched black target and reported green.
 *
 * The row calls the helpers' copy LATENT: every caller today is a component-free example, so
 * nothing exercised it. That is exactly why this file exists. A fix nothing calls is not a
 * fix, and the guard added alongside it would be vacuous — so these point the helpers at the
 * COMPONENT-BEARING examples the trap was waiting for, which is the first time either helper
 * has ever been handed one.
 *
 * §V316/§V908 — the component-bearing examples are DERIVED, not hand-listed, so this keeps
 * testing the thing it exists to test as the catalogue moves.
 */

/** Every shipped example that instantiates a library component — the trap's actual targets. */
const COMPONENT_BEARING = ["E47-Hologram.loom.json", "E51-Chorus.loom.json"] as const;

function componentInstanceIds(document: ProjectDocument): string[] {
  return Object.entries(document.graph.nodes)
    .filter(([, node]) => node.type.startsWith("component:"))
    .map(([id]) => id)
    .sort();
}

describe("the concept helpers keep the example's own component-aware registry (§T1067)", () => {
  it.each(COMPONENT_BEARING)("%s actually instantiates components, or the rest is vacuous", (fileName) => {
    const { document } = example(fileName);
    /*
     * The whole defect only exists for a graph containing a `component:` node. If these
     * examples ever stop carrying one, every claim below would still pass while testing
     * nothing, so the precondition fails loudly instead.
     */
    expect(
      componentInstanceIds(document),
      `${fileName} has no component instance, so it cannot distinguish a bare registry from a component-aware one`,
    ).not.toEqual([]);
  });

  it.each(COMPONENT_BEARING)("recompiles %s to the same live plan the runner validated", (fileName) => {
    const { document, plan } = example(fileName);

    // The mutation-free recompile is the identity: same registry, same graph, same plan.
    const again = recompile(document, document.graph);

    /*
     * Pass IDS, not a count. Under the bare registry the component instances vanished and the
     * graph was severed at the output — E51 compiled to ZERO passes — so this is the
     * consumer-visible difference between compiling the example and compiling a stump.
     */
    expect(again.passes.map((pass) => pass.id)).toEqual(plan.passes.map((pass) => pass.id));
    expect(again.passes.length).toBeGreaterThan(0);
    expect(
      again.diagnostics.filter((entry) => entry.code === CompilerDiagnosticCode.unknownNodeType),
    ).toEqual([]);
    // The flattened component contributed passes: instance-prefixed ids exist in the plan.
    const instances = componentInstanceIds(document);
    for (const instance of instances) {
      expect(
        again.passes.some((pass) => pass.id.includes(instance)),
        `no pass came from component instance ${instance} — it was flattened away, not compiled`,
      ).toBe(true);
    }
  });

  it.each(COMPONENT_BEARING)("steps a live value-graph session over %s without severing it", (fileName) => {
    const { document, plan } = example(fileName);
    // `valueGraphRun` carried the same bare registry, and its session ALSO reads the registry
    // to find driven parameters — a component instance is not a node to a bare view at all.
    const { plan: live } = valueGraphRun(document).step(CENTRE);
    expect(live.passes.map((pass) => pass.id)).toEqual(plan.passes.map((pass) => pass.id));
    expect(
      live.diagnostics.filter((entry) => entry.code === CompilerDiagnosticCode.unknownNodeType),
    ).toEqual([]);
  });

  it("refuses a document that did not come from example(), rather than compiling it bare", () => {
    /*
     * The safe construction is the ONLY one these helpers offer, so the unsafe input has to
     * fail loudly. A hand-made document has no remembered registry pair; silently falling
     * back to a bare one is precisely T1067.
     */
    const { document } = example(COMPONENT_BEARING[0]);
    const foreign: ProjectDocument = { ...document };
    expect(() => recompile(foreign, foreign.graph)).toThrow(/did not come from example\(\)/);
    expect(() => valueGraphRun(foreign)).toThrow(/did not come from example\(\)/);
  });
});
