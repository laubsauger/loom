import { describe, expect, it } from "vitest";

import { hashSeed } from "../../domain/rng/rng.ts";
import { createNodeRegistry, validateNodeDefinition } from "../registry/registry.ts";
import { noiseNode } from "./noise.ts";
import { NOISE_FRAGMENT_WGSL, NOISE_TYPE_OPTIONS } from "../shaders/noise.wgsl.ts";
import { compileContext, readNodePlan } from "./test-support.ts";

/** Noise — TD Noise TOP parity (T70). */

function uniformsFor(parameters: Record<string, string | number | boolean> = {}) {
  const compiled = noiseNode.compile(compileContext({ parameters }));
  const read = readNodePlan(compiled.passes);
  expect(read.ok).toBe(true);
  const pass = read.passes[0];
  if (pass?.kind !== "effect") throw new Error("Noise did not emit an effect pass.");
  return pass;
}

describe("Noise node (T70)", () => {
  it("registers cleanly in a real registry with no manifest diagnostics", () => {
    expect(validateNodeDefinition(noiseNode)).toEqual([]);
    expect(createNodeRegistry([noiseNode]).get("noise")).toBe(noiseNode);
  });

  it("is a generator: no inputs, one rgba texture output, project resolution and format", () => {
    expect(noiseNode.inputs).toEqual([]);
    expect(noiseNode.outputs.map((port) => port.id)).toEqual(["out"]);
    expect(noiseNode.outputs[0]?.type).toEqual({ kind: "texture2d", sample: "float", channels: 4 });
    expect(noiseNode.resolutionPolicy).toEqual({ kind: "project" });
    expect(noiseNode.formatPolicy).toEqual({ kind: "project" });
  });

  /**
   * §C: the TD TOP family is the reference vocabulary. These are the names a TD user will
   * look for, abbreviations included — renaming one is a compatibility decision, not a
   * tidy-up, so it has to break this test.
   */
  it("uses TouchDesigner's own parameter names", () => {
    expect(Object.keys(noiseNode.parameters).sort()).toEqual(
      [
        "amp",
        "aspectcorrect",
        "exp",
        "gain",
        "harmon",
        "mono",
        "offset",
        "p",
        "period",
        "r",
        "rough",
        "s",
        "s4d",
        "seed",
        "spread",
        "speed",
        "t",
        "t4d",
        "type",
        "xord",
      ].sort(),
    );
  });

  it("round-trips its declared defaults into the compiled uniforms", () => {
    const pass = uniformsFor();
    expect(pass.uniforms).toMatchObject({
      ntype: 0,
      period: 0.25,
      harmon: 3,
      spread: 2,
      gain: 0.5,
      rough: 0.5,
      expo: 1,
      amp: 1,
      offset: 0,
      mono: 1,
      rot: 0,
      xord: 0,
      speed: 0,
      t4d: 0,
      s4d: 1,
      t: [0, 0, 0],
      s: [1, 1, 1],
      piv: [0, 0, 0],
    });
  });

  it("emits a pass the backend's plan reader accepts", () => {
    const compiled = noiseNode.compile(compileContext());
    const read = readNodePlan(compiled.passes);
    expect(read.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(read.ok).toBe(true);
    expect(read.passes).toHaveLength(1);
    expect(read.passes[0]?.kind).toBe("effect");
  });

  /**
   * §V44: the ONLY clock a node may read is the shared frame block the runtime fills from
   * `FrameEvaluationInput`. If the pass stopped declaring it, the 4D types would freeze
   * and nothing else would fail — so the binding is asserted, not assumed.
   *
   * §V436/T497: and it is the ABSOLUTE member of that block. Scrolling noise is FREE-RUNNING
   * — the same call B98 made for the LFO — so a timeline lap must not put the field back to
   * its frame-zero slice. `frameU.time` here is the bug, not a synonym, and asserting the
   * ABSENCE of it is the half that catches a well-meaning revert: the two clocks carry the
   * same number until the first wrap, so nothing else in this suite could tell them apart.
   */
  it("takes time from the shared frame uniform block, never a wall clock (§V44)", () => {
    const pass = uniformsFor({ speed: 1 });
    expect(pass.sharedBinding).toBe("frameU");
    expect(NOISE_FRAGMENT_WGSL).toContain("frameU.absTime");
    expect(NOISE_FRAGMENT_WGSL).toContain("var<uniform> frameU: SharedFrame");
    // The 4th dimension is where time enters the field.
    expect(NOISE_FRAGMENT_WGSL).toContain("params.t4d + (frameU.absTime * params.speed)");
    // Not the wrapping one, anywhere in the source — comments included, so a revert cannot
    // arrive wearing an explanation (§V443).
    expect(NOISE_FRAGMENT_WGSL).not.toContain("frameU.time");
  });

  /**
   * §V45: same seed, same field — the compile is pure, so the same parameters produce
   * byte-identical uniforms, and the shader derives every value from an integer hash of
   * those uniforms and the lattice. Nothing here samples a hardware RNG or a clock.
   */
  it("produces identical passes for the same seed, and different ones for a different seed", () => {
    const first = uniformsFor({ seed: 7 });
    const second = uniformsFor({ seed: 7 });
    expect(second.uniforms).toEqual(first.uniforms);
    expect(second.shader).toBe(first.shader);

    const other = uniformsFor({ seed: 8 });
    expect(other.uniforms?.["seed"]).not.toEqual(first.uniforms?.["seed"]);
    // Only the uniform VALUE changes: a reseed must not rebuild the pipeline (§V5).
    expect(other.shader).toBe(first.shader);
  });

  it("folds the seed with the domain's own hash, so CPU and GPU seeding agree (§V45)", () => {
    expect(uniformsFor({ seed: 12 }).uniforms?.["seed"]).toBe(hashSeed(12));
  });

  /**
   * The seed is deliberately NOT mixed with the node id: in TD, two Noise TOPs with the
   * same seed give the same image, and folding identity in would quietly break that.
   */
  it("gives two nodes with the same seed the same field", () => {
    const a = noiseNode.compile(compileContext({ nodeId: "alpha", parameters: { seed: 3 } }));
    const b = noiseNode.compile(compileContext({ nodeId: "beta", parameters: { seed: 3 } }));
    const uniformsOf = (passes: ReadonlyArray<unknown>) =>
      (passes[0] as { uniforms?: Record<string, unknown> }).uniforms;
    expect(uniformsOf(b.passes)).toEqual(uniformsOf(a.passes));
  });

  it("selects a noise type by uniform index, so auditioning types never recompiles (§V5)", () => {
    const perlin = uniformsFor({ type: "perlin2d" });
    const simplex = uniformsFor({ type: "simplex3d" });
    expect(simplex.uniforms?.["ntype"]).toBe(4);
    expect(simplex.shader).toBe(perlin.shader);
  });

  /**
   * Every declared type must have a branch in the shader. An option with no branch would
   * fall through to the default and silently render a different noise, which is the exact
   * failure mode that makes a half-implemented type menu worse than a short one.
   */
  it("implements every type it declares", () => {
    NOISE_TYPE_OPTIONS.forEach((option, index) => {
      const branch =
        index === NOISE_TYPE_OPTIONS.length - 1 ? "default: { return" : `case ${index}u: { return`;
      expect(NOISE_FRAGMENT_WGSL, option.value).toContain(branch);
    });
  });

  it("declares only the types it implements", () => {
    expect(NOISE_TYPE_OPTIONS.map((option) => option.value)).toEqual([
      "perlin2d",
      "perlin3d",
      "perlin4d",
      "simplex2d",
      "simplex3d",
      "alligator",
      "random",
    ]);
  });

  /** Aspect correction is a COMPILE-time fact: it comes from the resolved size (§V21). */
  it("derives aspect correction from the resolved output size", () => {
    const corrected = noiseNode.compile(compileContext({ resolution: [1600, 800] }));
    expect((corrected.passes[0] as { uniforms: { aspect: number } }).uniforms.aspect).toBe(2);

    const off = noiseNode.compile(
      compileContext({ resolution: [1600, 800], parameters: { aspectcorrect: false } }),
    );
    expect((off.passes[0] as { uniforms: { aspect: number } }).uniforms.aspect).toBe(1);
  });

  it("reports a diagnostic instead of a malformed pass when no target was assigned", () => {
    const compiled = noiseNode.compile(compileContext({ outputs: [] }));
    expect(compiled.passes).toEqual([]);
    expect(compiled.diagnostics?.[0]?.code).toBe("node.compile.missingResource");
  });

  /**
   * §V46: a stateful node must declare how it replays. Noise is a pure function of uv,
   * parameters and frame time — there is no history, so there is nothing to declare, and
   * claiming otherwise would tell an offline renderer to checkpoint something that does
   * not exist.
   */
  it("declares no temporal or stateful block, because it carries nothing across frames", () => {
    expect(noiseNode.temporal).toBeUndefined();
    expect(noiseNode.stateful).toBeUndefined();
  });
});
