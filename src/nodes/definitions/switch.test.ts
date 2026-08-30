import { describe, expect, it } from "vitest";

import { createNodeRegistry, validateNodeDefinition } from "../registry/registry.ts";
import { MAX_TEXTURE_INPUTS } from "./common-ports.ts";
import { resolveSwitchIndex, switchNode } from "./switch.ts";
import { compileContext, inputResourceId, readNodePlan } from "./test-support.ts";

/** Switch — one of N inputs, chosen by a number (T235). */

/** `count` sources wired to the one variadic port, in that declared order. */
function pass(count: number, parameters = {}) {
  const inputs = Array.from({ length: count }, () => "inputs");
  const options = { inputs, parameters };
  const compiled = switchNode.compile(compileContext(options));
  const read = readNodePlan(compiled.passes, options);
  expect(read.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  const first = read.passes[0];
  if (first?.kind !== "effect") throw new Error("switch did not emit an effect pass.");
  return { compiled, pass: first };
}

describe("Switch (T235)", () => {
  it("registers with no manifest diagnostics", () => {
    expect(validateNodeDefinition(switchNode)).toEqual([]);
    expect(createNodeRegistry([switchNode]).list().map((d) => d.type)).toEqual(["switch"]);
  });

  it("selects with a UNIFORM, so a driven index never rebuilds the pipeline", () => {
    // The decision this node is shaped by, and the opposite of Composite's `operation`
    // (§V141) — deliberately. An operation changes approximately never, so specialising
    // the shader per operation is the right trade. An index is the thing you ANIMATE: an
    // LFO, a timer, a beat. Selecting by recompiling would make the node's entire purpose
    // its slowest path, and would quietly break §V5's uniform-only fast path for the one
    // parameter most likely to change every frame.
    const first = pass(3, { index: 0 });
    const second = pass(3, { index: 2 });
    expect(first.pass.uniforms?.["index"]).toBe(0);
    expect(second.pass.uniforms?.["index"]).toBe(2);
    expect(second.pass.shader).toBe(first.pass.shader);
  });

  it("wraps an out-of-range index instead of clamping it", () => {
    // Everything that generates a rising number — timer, LFO ramp, frame count — runs past
    // the end. Clamping turns "cycle through my sources", which is why people reach for a
    // Switch at all, into "stop on the last one", fixable only by typing a modulo into
    // every expression that drives it. Clamping stays available upstream (the value
    // graph's Limit); cycling would not be recoverable if this clamped.
    expect(resolveSwitchIndex(3, 3)).toBe(0);
    expect(resolveSwitchIndex(5, 3)).toBe(2);
    expect(resolveSwitchIndex(-1, 3)).toBe(2); // -1 is the last input, not the first
    expect(pass(3, { index: 7 }).pass.uniforms?.["index"]).toBe(1);
  });

  it("floors a fractional index rather than rounding it", () => {
    // A ramp from 0 to 3 should give each of three inputs an equal share of the ramp.
    // Rounding gives the first and last a HALF share each, which reads as a switcher whose
    // ends are twice as fast — the classic off-by-a-half in anything driven by a ramp.
    expect(resolveSwitchIndex(0.9, 3)).toBe(0);
    expect(resolveSwitchIndex(1.5, 3)).toBe(1);
    expect(resolveSwitchIndex(2.99, 3)).toBe(2);
  });

  it("declares no range on the index, so static and driven values mean the same thing", () => {
    // A declared max would REJECT a static 9 (§V66 validates against the range) while an
    // expression producing 9 wrapped happily — two answers to one question, with the
    // static one the surprising half. §V107's point about modes users cannot trust applies
    // to values too: the node's answer to "out of range" has to be the same either way.
    const index = switchNode.parameters["index"];
    expect(index?.type).toBe("number");
    expect(index?.type === "number" ? index.min : "set").toBeUndefined();
    expect(index?.type === "number" ? index.max : "set").toBeUndefined();
  });

  it("binds one texture per input, in the order the compiler hands them over", () => {
    // The index counts through the DOCUMENT's order (§V131, T225). Re-sorting here would
    // be a second opinion about what "input 2" means, and the user's would lose.
    expect(pass(3).pass.textures).toEqual([
      { binding: "inputTexture0", resourceId: inputResourceId("inputs", 0) },
      { binding: "inputTexture1", resourceId: inputResourceId("inputs", 1) },
      { binding: "inputTexture2", resourceId: inputResourceId("inputs", 2) },
    ]);
  });

  it("takes resolution and format from the first input, not the selected one", () => {
    // Both are resolved at COMPILE time (§V21) while the index moves per frame, so "the
    // selected input's size" is not a size a plan can have. Switching between differently
    // shaped sources resamples them into the first one's shape — and since T225 made the
    // order explicit, which input that is, is a choice rather than an accident.
    expect(switchNode.resolutionPolicy).toEqual({ kind: "inherit", input: "inputs" });
    expect(switchNode.formatPolicy).toEqual({ kind: "inherit", input: "inputs" });
  });

  it("gives every input its own branch, with the last as the default", () => {
    // WGSL needs a default arm, and the CPU has already put the index in range, so the
    // last input IS the default rather than an error path — no unreachable case, no
    // duplicated sample.
    const shader = pass(3).pass.shader;
    expect(shader).toContain("case 0u: { return textureSampleLevel(inputTexture0");
    expect(shader).toContain("case 1u: { return textureSampleLevel(inputTexture1");
    expect(shader).toContain("default: { return textureSampleLevel(inputTexture2");
    expect(shader).not.toContain("case 2u:");
  });

  it("changes its pass id with the input count, so a new source is new contents", () => {
    const three = pass(3).compiled.passes[0] as { id: string };
    const four = pass(4).compiled.passes[0] as { id: string };
    expect(three.id).not.toBe(four.id);
  });

  it("refuses more inputs than it can bind, naming the way out", () => {
    // One texture binding per input against WebGPU's 16-per-stage floor. Binding the first
    // eight and ignoring the rest would leave a source visibly wired and invisibly dead.
    const inputs = Array.from({ length: MAX_TEXTURE_INPUTS + 1 }, () => "inputs");
    const compiled = switchNode.compile(compileContext({ inputs }));
    expect(compiled.passes).toEqual([]);
    expect(compiled.diagnostics?.[0]?.code).toBe("node.compile.tooManyInputs");
  });

  it("reports rather than emitting a pass when nothing is wired", () => {
    const compiled = switchNode.compile(compileContext({ inputs: [] }));
    expect(compiled.passes).toEqual([]);
    expect(compiled.diagnostics?.[0]?.message).toContain('input port "inputs"');
  });
});
