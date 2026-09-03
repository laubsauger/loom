import { describe, expect, it } from "vitest";

import { matteInputSideFor, matteNode } from "./matte.ts";
import { effectiveParameterSchema } from "../../domain/parameters/resolve.ts";
import { MATTE_ACCURATE, MATTE_FAST } from "../../runtime/models/model-catalogue.ts";
import { MATTE_INPUT_SIDE } from "../../runtime/models/matte-runner.ts";
import type { EnumParameter } from "../../domain/types/parameters.ts";
import type { NodeCompileContext } from "../../domain/types/node-definition.ts";
import type { DispatchPassDescriptor } from "../../runtime/backend/plan.ts";

/**
 * THE MATTE'S INPUT SIZE — §V827's per-artefact knob, on the second node to grow one.
 *
 * Read through `effectiveParameterSchema` and never off `matteNode.parameters`, for
 * §T903's reason exactly: §B166 and §B167 were both a surface reading the STATIC schema
 * while the node had computed a different one, and both rendered correctly and behaved
 * wrongly. A test reading the static field would be a third such surface.
 */
const schemaFor = (stored: Record<string, unknown>) => effectiveParameterSchema(matteNode, stored);

const enumOf = (stored: Record<string, unknown>, key: string): EnumParameter => {
  const found = schemaFor(stored)[key];
  if (found === undefined || found.type !== "enum") throw new Error(`${key} is not an enum`);
  return found;
};

/** The preprocess dispatch this node compiles for a given stored bag. */
function preprocessFor(stored: Record<string, unknown>): DispatchPassDescriptor {
  const context = {
    nodeId: "matte1",
    parameters: stored,
    inputs: { input: [{ resourceId: "tex:src", sampler: "linear" }] },
    outputs: { out: { resourceId: "tex:out" } },
    resolution: [1280, 720],
  } as unknown as NodeCompileContext;
  /* `CompiledNodeDescription.passes` is `unknown[]` by contract — the domain type stays
     free of the backend's plan shape — so the narrowing is this test's own. */
  const passes = matteNode.compile(context).passes as readonly DispatchPassDescriptor[];
  const pass = passes.find((candidate) => candidate.id === "matte1:preprocess");
  if (pass === undefined || pass.kind !== "dispatch") throw new Error("no preprocess pass");
  return pass;
}

describe("§V827 — the Input Size names its own MEASURED cost, per option", () => {
  it("offers only the sides that were measured, all multiples of MODNet's 32", () => {
    const sides = enumOf({}, "inputSide").options.map((option) => Number(option.value));
    expect(sides).toEqual([256, 320, 384, 512]);
    // Not a free number field: 500 is not a legal MODNet input and a text box invites one.
    for (const side of sides) expect(side % 32).toBe(0);
  });

  it("prints BOTH measured costs in every option, because they disagree by 100x", () => {
    // The whole decision this control supports is "which backend am I on". A label that
    // carried only the GPU number would make every option look free and would be the
    // reason someone on the wasm fallback never finds the 2.6 s sitting under 512.
    const labels = Object.fromEntries(
      enumOf({}, "inputSide").options.map((option) => [option.value, option.label]),
    );
    expect(labels["512"]).toContain("30 ms on a GPU");
    expect(labels["512"]).toContain("3.3 s on the CPU");
    expect(labels["256"]).toContain("12 ms on a GPU");
    expect(labels["256"]).toContain("0.7 s on the CPU");
  });

  it("⚠ says what the CHEAP options cost the PICTURE, which no published number does", () => {
    /*
     * §V856's shape, one level up. Measured over the sweep: 256 keeps 87% of 512's
     * coverage and puts its centroid within a texel of 512's while punching a hole
     * through the subject's chest, and 192 keeps 93% of it while losing an arm. So
     * coverage — the node's own published metric — CANNOT separate a good matte from a
     * holed one, and a label that quoted only milliseconds would be selling a silent
     * failure as a saving. The damage goes in the label, where the choice is made.
     */
    const options = enumOf({}, "inputSide").options;
    const cheap = options.filter((option) => Number(option.value) < 384);
    expect(cheap).toHaveLength(2);
    for (const option of cheap) expect(option.label).toMatch(/hole/);
    // And the sizes that HOLD say nothing about damage, so the warning still means something.
    for (const option of options.filter((o) => Number(o.value) >= 384)) {
      expect(option.label).not.toMatch(/hole/);
    }
  });

  it("defaults to 512 — the largest, and the opposite of depth's call (§T976)", () => {
    // Measured, not asserted: 512 is 30 ms on the provider `auto` reaches first, so the
    // 18 ms that 256 saves buys nothing and is paid for with a hole in the subject. Depth
    // defaulted DOWN because its model costs 2.7 s a run; the rule is the measurement, not
    // the direction, and the two nodes land opposite ways because their models do.
    expect(enumOf({}, "inputSide").default).toBe("512");
    expect(matteInputSideFor({})).toBe(MATTE_INPUT_SIDE);
  });

  it("is a REBUILD, not a uniform write (§V5)", () => {
    // The preprocess buffer's capacity and the dispatch's workgroup count are both sized
    // from it, so a live uniform write would leave the buffer at the old square.
    expect(schemaFor({})["inputSide"]?.compileTime).toBe(true);
  });
});

describe("the stored side is read once, by the definition that declares its default", () => {
  it("takes a legal choice, in either spelling", () => {
    expect(matteInputSideFor({ inputSide: "320" })).toBe(320);
    expect(matteInputSideFor({ inputSide: 320 })).toBe(320);
  });

  it("falls back to the default for a side this model would refuse", () => {
    // 500 is not a multiple of 32; the session would throw on it rather than resize.
    expect(matteInputSideFor({ inputSide: "500" })).toBe(512);
    expect(matteInputSideFor({ inputSide: "" })).toBe(512);
    expect(matteInputSideFor({})).toBe(512);
  });

  it("holds for BOTH builds, whose graphs are both symbolic (§T965(c))", () => {
    expect(matteInputSideFor({ model: MATTE_FAST.id, inputSide: "256" })).toBe(256);
    expect(matteInputSideFor({ model: MATTE_ACCURATE.id, inputSide: "256" })).toBe(256);
    expect(schemaFor({ model: MATTE_FAST.id })["inputSide"]).toBeDefined();
  });
});

describe("the compiled pass is sized from the stored choice, not from the constant", () => {
  it("sizes the dispatch, the uniform AND the scratch buffer from one value", () => {
    /*
     * All three, in one assertion, because they are the failure this splits: sizing the
     * dispatch from the parameter and the buffer from the old constant runs, writes
     * 320x320 texels into a 512x512 buffer and hands the model a square whose bottom
     * two-fifths is whatever was there before — a plausible-looking matte of a picture
     * nobody sent. The uniform is what the WGSL divides by, so a stale one letterboxes
     * against the wrong square.
     */
    const pass = preprocessFor({ inputSide: "320" });
    expect(pass.workgroups).toEqual([40, 40, 1]);
    expect(pass.uniforms).toEqual({ side: 320 });

    const context = {
      nodeId: "matte1",
      parameters: { inputSide: "320" },
      inputs: { input: [{ resourceId: "tex:src", sampler: "linear" }] },
      outputs: { out: { resourceId: "tex:out" } },
      resolution: [1280, 720],
    } as unknown as NodeCompileContext;
    const scratch = matteNode.compile(context).scratch?.find((entry) => entry.key === "modelInput");
    expect(scratch?.kind === "buffer" ? scratch.capacity : undefined).toBe(320 * 320);
  });

  it("and the default compiles the 512 square it always did", () => {
    const pass = preprocessFor({});
    expect(pass.workgroups).toEqual([64, 64, 1]);
    expect(pass.uniforms).toEqual({ side: 512 });
  });
});
