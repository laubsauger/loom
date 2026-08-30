import { describe, expect, it } from "vitest";

import type { NodeDefinition } from "../../domain/types/node-definition.ts";
import { createNodeRegistry, validateNodeDefinition } from "../registry/registry.ts";
import {
  BLUR_SCRATCH_KEY,
  blurNode,
  convolveNode,
  displaceNode,
  edgeNode,
  filterNodes,
  remapNode,
} from "./filters.ts";
import { uvNode } from "./generators.ts";
import { CHANNEL_OPTIONS, EXTEND_OPTIONS } from "./parameter-readers.ts";
import { WGSL_EXTEND } from "../shaders/common.wgsl.ts";
import { UV_FRAGMENT_WGSL } from "../shaders/generators.wgsl.ts";
import { scratchResourceId } from "../../compiler/resources.ts";
import {
  compileContext,
  inputResourceId,
  outputResourceId,
  readNodePlan,
} from "./test-support.ts";

/** Neighbourhood filters: Blur, Displace (T40). */

function readPasses(
  definition: NodeDefinition,
  parameters = {},
  resolution?: readonly [number, number],
) {
  const compiled = definition.compile(
    compileContext({
      inputs: definition.inputs.map((port) => port.id),
      parameters,
      ...(resolution === undefined ? {} : { resolution }),
    }),
  );
  const options = {
    inputs: definition.inputs.map((port) => port.id),
    parameters,
    ...(resolution === undefined ? {} : { resolution }),
    // Whatever the node declared, declared back — exactly what the compiler materializes.
    scratch: (compiled.scratch ?? []).map((entry) => entry.key),
  };
  const read = readNodePlan(compiled.passes, options);
  expect(read.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  expect(read.ok).toBe(true);
  const passes = read.passes.map((pass) => {
    if (pass.kind !== "effect") throw new Error(`${definition.type} emitted a non-effect pass.`);
    return pass;
  });
  return { compiled, passes };
}

function firstPass(definition: NodeDefinition, parameters = {}, resolution?: readonly [number, number]) {
  const pass = readPasses(definition, parameters, resolution).passes[0];
  if (pass === undefined) throw new Error(`${definition.type} did not emit an effect pass.`);
  return pass;
}

describe("filter nodes (T40)", () => {
  it("all register together with no manifest diagnostics", () => {
    for (const definition of filterNodes) expect(validateNodeDefinition(definition)).toEqual([]);
    expect(createNodeRegistry(filterNodes).list().map((d) => d.type)).toEqual([
      "blur",
      "convolve",
      "displace",
      "edge",
      "remap",
    ]);
  });

  it("agree with the shader about which extend mode each enum index means", () => {
    expect(EXTEND_OPTIONS.map((option) => option.value)).toEqual([
      "hold",
      "repeat",
      "mirror",
      "zero",
    ]);
    expect(WGSL_EXTEND).toContain("if (m == 1u)");
    expect(WGSL_EXTEND).toContain("if (m == 2u)");
    expect(WGSL_EXTEND).toContain("u32(mode + 0.5) == 3u");
  });

  describe("Blur", () => {
    /**
     * A blur radius is in pixels, so the node needs its own texel size. It comes from the
     * COMPILE-time resolved resolution (§V21), never from the shared frame block, whose
     * `resolution` is the presentation surface's rather than this pass's target's.
     */
    it("derives its texel size from the resolved output size", () => {
      const pass = firstPass(blurNode, {}, [800, 400]);
      expect(pass.uniforms?.["texel"]).toEqual([1 / 800, 1 / 400]);
    });

    /**
     * §V5. The kernel is resolved on the CPU — even the LOOP BOUND arrives as a uniform —
     * so changing the size or the filter type never regenerates the shader source and
     * never forces a pipeline rebuild.
     */
    it("changes only uniforms when the size or filter changes (§V5)", () => {
      const base = firstPass(blurNode);
      const bigger = firstPass(blurNode, { size: 32, filter: "box" });
      expect(bigger.uniforms).toMatchObject({ size: 32, ftype: 1, taps: 32, stride: 1 });
      expect(bigger.uniforms?.["taps"]).not.toBe(base.uniforms?.["taps"]);
      expect(bigger.shader).toBe(base.shader);
    });

    it("inherits resolution and format from its input", () => {
      expect(blurNode.resolutionPolicy).toEqual({ kind: "inherit", input: "input" });
      expect(blurNode.formatPolicy).toEqual({ kind: "inherit", input: "input" });
    });

    /**
     * T147 — the separable pair.
     *
     * The single-pass version this replaced sampled a 9x9 grid whose SPACING grew with the
     * size, so 81 taps had to cover a kernel of any width and the result stopped being a
     * blur past a few dozen pixels. A separable Gaussian factorises exactly, but it needs
     * somewhere to put the horizontal half — which is what `scratch` is for.
     */
    it("emits a horizontal pass into scratch and a vertical pass that samples it", () => {
      const { compiled, passes } = readPasses(blurNode);
      expect(compiled.scratch).toEqual([{ key: BLUR_SCRATCH_KEY }]);
      expect(passes).toHaveLength(2);

      const scratch = scratchResourceId("n1", BLUR_SCRATCH_KEY);
      const [horizontal, vertical] = passes;

      // Pass one reads the node's input and writes the intermediate.
      expect(horizontal?.target).toBe(scratch);
      expect(horizontal?.textures).toEqual([
        { binding: "inputTexture", resourceId: inputResourceId("input") },
      ]);

      // Pass two reads the intermediate and writes the node's real output. If these two
      // were swapped, or the second still read the input, the node would blur one axis.
      expect(vertical?.textures).toEqual([{ binding: "inputTexture", resourceId: scratch }]);
      expect(vertical?.target).toBe(outputResourceId("out"));
    });

    /** One axis each, or it is not a separable pair — it is the same pass twice. */
    it("runs one axis per pass", () => {
      const [horizontal, vertical] = readPasses(blurNode).passes;
      expect(horizontal?.uniforms?.["dir"]).toEqual([1, 0]);
      expect(vertical?.uniforms?.["dir"]).toEqual([0, 1]);
    });

    /**
     * The honest-radius claim from the node's doc, as an assertion.
     *
     * `stride` is the pixel distance between taps: at or below 1 the kernel is fully
     * sampled, above it the kernel is being resampled. The old shader's effective stride
     * was size/4 at every size — 16 pixels at size 64 — which is the under-sampling this
     * replaces, so the boundary is worth pinning rather than describing.
     */
    it("keeps taps at most one pixel apart up to the size its docs claim", () => {
      for (const size of [1, 8, 20, 42]) {
        const uniforms = firstPass(blurNode, { size }).uniforms;
        expect(Number(uniforms?.["stride"]), `gaussian size ${size}`).toBeLessThanOrEqual(1);
      }
      for (const size of [1, 16, 64]) {
        const uniforms = firstPass(blurNode, { size, filter: "box" }).uniforms;
        expect(Number(uniforms?.["stride"]), `box size ${size}`).toBeLessThanOrEqual(1);
      }
    });

    it("caps the tap count and widens the stride instead of growing without bound", () => {
      const wide = firstPass(blurNode, { size: 128 }).uniforms;
      expect(wide?.["taps"]).toBe(64);
      // 3 sigma = 1.5 * size = 192 px, spread over 64 taps per side.
      expect(wide?.["stride"]).toBeCloseTo(3, 6);

      const modest = firstPass(blurNode, { size: 8 }).uniforms;
      expect(Number(modest?.["taps"])).toBeLessThan(64);
    });

    /**
     * A box means a flat kernel over exactly the declared radius; a Gaussian runs to
     * 3 sigma, and sigma is size/2 — the same relation the shader derives, which is why
     * only `size` crosses the boundary and not a second, redundant `sigma`.
     */
    it("spans the declared radius for a box and three sigma for a gaussian", () => {
      const box = firstPass(blurNode, { size: 16, filter: "box" }).uniforms;
      expect(Number(box?.["taps"]) * Number(box?.["stride"])).toBeCloseTo(16, 6);

      const gaussian = firstPass(blurNode, { size: 16 }).uniforms;
      expect(Number(gaussian?.["taps"]) * Number(gaussian?.["stride"])).toBeCloseTo(24, 6);
    });

    /** Both passes share the shader, so a size change stays a uniform write (§V5). */
    it("uses one shader for both axes", () => {
      const { passes } = readPasses(blurNode);
      expect(passes[0]?.shader).toBe(passes[1]?.shader);
    });
  });

  describe("Displace", () => {
    /**
     * §V56/§V57: the displacement input is DATA. Colour-converting it would rescale the
     * offsets through a gamma curve and silently move the geometry. The port says so, and
     * the node converts neither input.
     */
    it("declares the displacement input as data, not colour", () => {
      const disp = displaceNode.inputs.find((port) => port.id === "disp");
      expect(disp?.description).toMatch(/DATA, not colour/);
    });

    /**
     * Shape follows the image being displaced, not the field doing the displacing — a
     * low-resolution noise driving a full-resolution image is normal, and must not shrink
     * the result.
     */
    it("takes resolution and format from the source, not the displacement field", () => {
      expect(displaceNode.resolutionPolicy).toEqual({ kind: "inherit", input: "source" });
      expect(displaceNode.formatPolicy).toEqual({ kind: "inherit", input: "source" });
    });

    it("binds both textures and defaults to red/green as the two drivers, TD-style", () => {
      const pass = firstPass(displaceNode);
      expect(pass.textures).toEqual([
        { binding: "inputTexture", resourceId: inputResourceId("source") },
        { binding: "displaceTexture", resourceId: inputResourceId("disp") },
      ]);
      expect(pass.uniforms).toMatchObject({
        sourcex: 1,
        sourcey: 2,
        weight: [0.1, 0.1],
        offset: [0.5, 0.5],
      });
    });

    it("reports which input is missing rather than emitting half a pass", () => {
      const compiled = displaceNode.compile(compileContext({ inputs: ["source"] }));
      expect(compiled.passes).toEqual([]);
      expect(compiled.diagnostics?.[0]?.message).toContain('input port "disp"');
    });
  });
});

/**
 * Remap (T279) — the decisions that are arguments, not code.
 */
describe("Remap (T279)", () => {
  it("uses the field as a position where Displace uses it as an offset", () => {
    // The entire difference between the two nodes, and nothing about the names says which
    // is which. Displace adds the field to the pixel's own coordinate; Remap replaces it.
    // A constant field therefore collapses the source to one pixel here and merely slides
    // the image in Displace — if this assertion ever flips, one node has become the other.
    expect(firstPass(displaceNode).shader).toContain("uv + (shift * params.weight)");
    expect(firstPass(remapNode).shader).not.toContain("uv +");
  });

  it("consumes the UV generator's output as an identity map, v unflipped", () => {
    // The reason this node exists: `uv` produced coordinates nothing could read. Our
    // fragment coordinate runs v DOWN and the generator writes that coordinate straight
    // into green, so Remap must read green as v with no flip for `uv -> Remap.map` to be
    // a passthrough. TD's Remap TOP documents the opposite for its input ("green: 0 =
    // bottom row"), which is right for TD's bottom-up image space; adopting it here would
    // make our own generator produce an upside-down warp out of the box. Both halves of
    // that contract are asserted, so changing either module alone fails here.
    const flipv = uvNode.parameters["flipv"];
    expect(flipv?.type === "boolean" ? flipv.default : undefined).toBe(false);
    expect(UV_FRAGMENT_WGSL).toContain("return vec4f(uv.x, v, 0.0, 1.0)");

    const red = CHANNEL_OPTIONS.findIndex((option) => option.value === "red");
    const green = CHANNEL_OPTIONS.findIndex((option) => option.value === "green");
    expect(firstPass(remapNode).uniforms).toMatchObject({
      sourcex: red,
      sourcey: green,
      flip: [0, 0],
    });
  });

  it("takes its shape from the map and its pixels from the source", () => {
    // Not the composite family's "inherit everything from input 1": there is one lookup
    // per pixel OF THE MAP, so the map's resolution is the output's, while the pixels
    // written out are the source's and carry the source's format and colour space. Lookup
    // splits its policies for the same reason (§V57) — index image vs palette.
    expect(remapNode.resolutionPolicy).toEqual({ kind: "inherit", input: "map" });
    expect(remapNode.formatPolicy).toEqual({ kind: "inherit", input: "source" });
  });

  it("reports which input is missing rather than emitting half a pass", () => {
    const compiled = remapNode.compile(compileContext({ inputs: ["source"] }));
    expect(compiled.passes).toEqual([]);
    expect(compiled.diagnostics?.[0]?.message).toContain('input port "map"');
  });
});

/**
 * Edge and Convolve (T241) — the two decisions in each that are arguments, not code.
 */
describe("Edge (T241)", () => {
  it("passes alpha through instead of differentiating it", () => {
    // Under straight alpha (§V56) coverage is not colour, and the edges of coverage are a
    // different question. Differentiating alpha would make every fully opaque image come
    // back completely transparent — surprising, and useless.
    const { shader } = firstPass(edgeNode);
    expect(shader).toContain("source.a");
    expect(shader).not.toContain("gx.a");
  });

  it("uses the true gradient length, not the cheap anisotropic sum", () => {
    // |gx| + |gy| reports diagonal edges up to 41% stronger than axis-aligned ones. The
    // saving is irrelevant on a GPU and the bias is visible.
    expect(firstPass(edgeNode).shader).toContain("sqrt((gx * gx) + (gy * gy))");
  });

  it("scales its sampling with the target resolution", () => {
    // A fixed texel step would make the kernel a different physical size at every
    // resolution, so an Edge would change character when the project resolution changed.
    const uniforms = firstPass(edgeNode, {}, [200, 100]).uniforms as { texel?: readonly number[] };
    expect(uniforms.texel).toEqual([1 / 200, 1 / 100]);
  });
});

describe("Convolve (T241)", () => {
  it("defaults to the identity kernel", () => {
    // A freshly dropped Convolve must do nothing visible. Defaulting to a blur or an
    // emboss would make an untouched node look broken in the other direction.
    const uniforms = firstPass(convolveNode).uniforms as Record<string, unknown>;
    expect([uniforms["row0"], uniforms["row1"], uniforms["row2"]]).toEqual([
      [0, 0, 0],
      [0, 1, 0],
      [0, 0, 0],
    ]);
  });

  it("guards normalisation against a zero-sum kernel", () => {
    // Zero-sum is the NORMAL case for edge kernels, not a mistake, so normalising one has
    // to pass the raw result through rather than divide by nothing.
    expect(firstPass(convolveNode).shader).toContain("abs(weight) > 1e-6");
  });

  it("takes the kernel as three rows so the inspector can show a grid", () => {
    // Nine separately-named scalars would be identical to the compiler and unreadable to a
    // person. The shape of this parameter set is the feature.
    for (const key of ["row0", "row1", "row2"]) {
      const parameter = convolveNode.parameters[key];
      expect(parameter?.type).toBe("vector");
      expect(parameter?.type === "vector" ? parameter.size : 0).toBe(3);
    }
  });
});
