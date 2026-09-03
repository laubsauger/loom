import { describe, expect, it } from "vitest";

import { effectiveParameterSchema } from "../../domain/parameters/resolve.ts";
import { createNodeRegistry, validateNodeDefinition } from "../registry/registry.ts";
import { MAX_TEXTURE_INPUTS } from "./common-ports.ts";
import { resolveSwitchBlend, resolveSwitchIndex, switchNode } from "./switch.ts";
import { compileContext, inputResourceId, readNodePlan } from "./test-support.ts";

/**
 * The index's DECLARED step as a consumer gets it, through the funnel (§V814).
 *
 * Reads the manifest field rather than `declaredStep`, because §V11 forbids a node
 * definition (or its test) from importing `src/ui`. The interpretation of that field is
 * `drag-math`'s and is asserted where it may legally be imported —
 * `src/tests/guardrails/counting-parameters.test.ts` runs the same two cases through
 * `declaredStep` itself, across the whole registry.
 */
function indexStepWith(stored: Record<string, unknown>): number | undefined {
  const spec = effectiveParameterSchema(switchNode, stored)["index"];
  if (spec === undefined || spec.type !== "number") throw new Error("switch lost its index parameter.");
  return spec.step;
}

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

/**
 * T1054 — CROSSFADE. The picture claim is `switch-crossfade.gpu.test.ts`, on Dawn, in
 * bytes (§V147); these are the arithmetic and the schema underneath it.
 */
describe("Switch crossfade (T1054)", () => {
  it("names the two inputs a fractional index sits between, and how far across", () => {
    // Three inputs, so "blends with the NEXT one" is distinguishable from "blends with the
    // last" — with two it is not, and a fixture that cannot tell them apart proves neither.
    expect(resolveSwitchBlend(0.25, 3)).toEqual({ index: 0, next: 1, fraction: 0.25 });
    expect(resolveSwitchBlend(1.75, 3)).toEqual({ index: 1, next: 2, fraction: 0.75 });
  });

  it("wraps the NEXT input at the seam, so the last one fades into the first", () => {
    // The reason crossfade had to respect T235's wrap rather than clamp at the end: a
    // driven index ramps off the end on purpose, and a blend that stopped there would make
    // the last input's share of the ramp behave differently from every other input's.
    expect(resolveSwitchBlend(2.5, 3)).toEqual({ index: 2, next: 0, fraction: 0.5 });
  });

  it("is continuous THROUGH the seam and through zero", () => {
    // The discontinuity this rules out: `fraction` from a `%` would flip sign below zero,
    // so a ramp crossing 0 downward would jump instead of fading. Approaching an integer
    // from below must land arbitrarily close to that integer's own input.
    // Exact values, not a tolerance band (§V147): every fraction here is a negative power
    // of two, so it is representable and `toEqual` can be used at full strength. Walking up
    // to the seam, the pair stays (2 → 0) and the weight goes to input 0 in the limit.
    expect(resolveSwitchBlend(2.5, 3)).toEqual({ index: 2, next: 0, fraction: 0.5 });
    expect(resolveSwitchBlend(2.9375, 3)).toEqual({ index: 2, next: 0, fraction: 0.9375 });
    expect(resolveSwitchBlend(2.99609375, 3)).toEqual({ index: 2, next: 0, fraction: 0.99609375 });
    // ...and AT the seam the answer is input 0 itself, which is the value that limit
    // approaches. A blend that clamped at the last input, or restarted the pair, would
    // leave a 100%-wide jump exactly here.
    expect(resolveSwitchBlend(3, 3)).toEqual({ index: 0, next: 1, fraction: 0 });

    // Downward through zero: -0.25 is three quarters of the way from input 2 toward input 0.
    expect(resolveSwitchBlend(-0.25, 3)).toEqual({ index: 2, next: 0, fraction: 0.75 });
  });

  it("agrees with the hard select at every integer index", () => {
    // Crossfade must never move the picture where it is not crossfading. A fraction of 0 is
    // what the shader short-circuits on, so this is also the reason "off" costs one sample.
    for (const raw of [-3, -1, 0, 1, 2, 5]) {
      const blend = resolveSwitchBlend(raw, 3);
      expect(blend.fraction).toBe(0);
      expect(blend.index).toBe(resolveSwitchIndex(raw, 3));
    }
  });

  it("sends blend 0 while the toggle is off, however fractional the index is", () => {
    // §V831's promise, at the uniform: an existing document has no `crossfade` key at all,
    // and must produce the pass it always produced. A fractional index still FLOORS.
    const off = pass(3, { index: 1.75 }).pass;
    expect(off.uniforms).toEqual({ index: 1, next: 2, blend: 0 });
    // And an explicit false is the same pass as an absent key, so the default is not a
    // second behaviour.
    expect(pass(3, { index: 1.75, crossfade: false }).pass.uniforms).toEqual(off.uniforms);
  });

  it("sends the fraction once the toggle is on, without changing the program", () => {
    const on = pass(3, { index: 1.75, crossfade: true }).pass;
    expect(on.uniforms).toEqual({ index: 1, next: 2, blend: 0.75 });
    // The SAME shader as the toggle-off case: crossfade is a uniform, not a variant, so
    // turning it on (or driving it) never rebuilds the pipeline — §V5's fast path, and the
    // reason it is not `compileTime` (T1014 measured that a driven structural parameter is
    // refused outright at runtime, so a compileTime toggle would break §V107's other modes).
    expect(on.shader).toBe(pass(3, { index: 1.75 }).pass.shader);
  });

  it("blends toward the FIRST input at the seam, in the uniforms", () => {
    expect(pass(3, { index: 2.5, crossfade: true }).pass.uniforms).toEqual({ index: 2, next: 0, blend: 0.5 });
  });

  it("short-circuits to one sample in the shader when the blend is zero", () => {
    // The cost claim (§V228) is in the description: crossfade costs ONE EXTRA SAMPLE. That
    // is only true if the off path does not sample twice, which is what the early return is.
    const shader = pass(3).pass.shader;
    expect(shader).toContain("if (params.blend <= 0.0)");
    expect(shader).toContain("return mix(base, sampleInput(u32(params.next + 0.5), uv), params.blend);");
    // No clamp on the blend result: `mix` is convex so it cannot manufacture an alpha above
    // the inputs' own (§V833), and clamping would make crossfade clip an over-range alpha
    // that the hard select passes through — a bigger change than the blend itself (§V838).
    expect(shader).not.toContain("clamp(");
  });

  it("snaps the index to whole inputs while crossfade is off, and frees it when it is on", () => {
    // T1047 gave the index step 1 because an index counts. That is true while selection is
    // DISCRETE and false the moment the fraction becomes the control: an integer rung would
    // make crossfade unreachable by the one gesture anyone would use to reach it. So the
    // step is a property of the INSTANCE (§T880's `parametersFor`), not of the type.
    expect(indexStepWith({})).toBe(1);
    expect(indexStepWith({ crossfade: false })).toBe(1);
    expect(indexStepWith({ crossfade: true })).toBeUndefined();
  });

  it("frees the index for a crossfade in any DYNAMIC mode, because none is knowable here", () => {
    // §V107: the toggle takes every mode. A schema that only recognised a stored `true`
    // would leave the index snapping for exactly the users who animated the toggle — the
    // ones most likely to want the fraction.
    for (const mode of ["expression", "driven", "bind"] as const) {
      expect(indexStepWith({ crossfade: { mode, bindings: {} } }), mode).toBeUndefined();
    }
    // ...but a crossfade PARKED on a static false is still a promise that selection is
    // discrete, so it keeps the rung. Without this the rule above would be satisfied by a
    // schema that freed the step unconditionally, which is T1047 quietly repealed.
    expect(
      indexStepWith({ crossfade: { mode: "static", bindings: { static: { kind: "static", value: false } } } }),
    ).toBe(1);
  });
});
