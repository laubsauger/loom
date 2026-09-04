import { describe, expect, it } from "vitest";
import { listExamples } from "../examples/catalogue.ts";
import { errorsOf, messagesOf, requireExample } from "../examples/runner.ts";
import { STARTER_EXAMPLE_FILE } from "./starter-document.ts";

/**
 * THE STARTER MUST COMPILE CLEAN, not merely load (B179's neighbourhood).
 *
 * "The starter renders" and "the starter's plan was installed" are different facts today,
 * and the gap between them is the worst possible thing to hand a new user. When a document
 * carries any compiler error, `use-frame-loop.ts` refuses to install the plan and the
 * backend keeps running the PREVIOUS program: the frame counter advances, the viewer keeps
 * moving, and nothing on screen says that what is being drawn is stale. A first boot into
 * that state looks like a working application and is not one — the newcomer would drag the
 * slider this document exists to offer them and see nothing happen.
 *
 * `runner.test.ts` already gates every shipped example this way, and this is deliberately
 * NOT a second copy of that: it is a gate on the CHOICE. Pointing
 * `STARTER_EXAMPLE_FILE` at a document with a warning-free load but an erroring compile —
 * or at a file that is not shipped at all — fails here, at the line that made the choice.
 *
 * Headless, and the reason `starter-document.ts` exists: `use-starter-project.ts` reads
 * the BROWSER catalogue through `@editor/library`, which brings React with it, so the
 * name lives in a module with no imports and both sides read the one constant.
 */

describe("the starter document (owner request: something is happening on first boot)", () => {
  const file = listExamples().find((entry) => entry.fileName === STARTER_EXAMPLE_FILE);

  it("is one of the shipped examples, so §V88 covers its bytes", () => {
    expect(
      file,
      `${STARTER_EXAMPLE_FILE} is not in examples/ — the app would boot to an empty canvas`,
    ).toBeDefined();
  });

  it("compiles CLEAN, so the first frame the newcomer sees is their document", () => {
    const { plan, result } = requireExample(file!);
    // The LOAD is clean — nothing migrated, nothing clamped, no unknown node type.
    expect(messagesOf(result.loadDiagnostics)).toEqual([]);
    expect(result.placeholders).toEqual([]);
    // And the COMPILE is clean. Zero errors is the letter of it: anything else leaves the
    // backend running the previous program while the viewer keeps moving, which is
    // indistinguishable from working. Zero diagnostics is the intent — a first boot that
    // puts a count on the problems tab says the tool is broken before the user has acted.
    expect(errorsOf(plan.diagnostics)).toEqual([]);
    expect(messagesOf(plan.diagnostics)).toEqual([]);
    // Non-vacuity: a plan that compiled to nothing would satisfy "no errors" trivially.
    expect(plan.passes.length).toBeGreaterThan(0);
  });

  it("asks for no permission and downloads nothing on a first boot", () => {
    /*
     * The node types that would open a browser permission dialog or start a fetch. Asserted
     * against the STARTER'S OWN GRAPH, so swapping the choice for an example with a webcam
     * in it fails here rather than in front of a new user.
     */
    const gated = new Set([
      "webcam",
      "audioFileIn",
      "audioDeviceIn",
      "audioPattern",
      "channelIn",
      "movieFileIn",
      "depth",
      "inference",
      "personMask",
      "midiIn",
      "osc",
    ]);
    const { document } = requireExample(file!);
    const types = Object.values(document.graph.nodes).map((node) => node.type);
    expect(types.filter((type) => gated.has(type))).toEqual([]);
    // Tiny enough to read at a glance — the other half of the ask.
    expect(types.length).toBeLessThanOrEqual(8);
  });
});
