import { describe, expect, it } from "vitest";
import { scratchResourceId } from "../../compiler/resources.ts";
import { validateNodeDefinition } from "../registry/registry.ts";
import { DATA_TEXTURE } from "./common-ports.ts";
import { effectiveParameterSchema } from "../../domain/parameters/resolve.ts";
import { floatMapInNode, FLOAT_MAP_TEXTURE_KEY, floatMapSourceIdFor } from "./float-map-in.ts";
import { compileContext, readNodePlan } from "./test-support.ts";

describe("Float Map In", () => {
  it("offers only validated Large sizes for the explicitly selected backend", () => {
    for (const depthBackend of ["wasm", "webgpu"] as const) {
      const schema = effectiveParameterSchema(floatMapInNode, { interpretation: "depth", depthModel: "depth-anything-v2-large-q4f16", depthBackend });
      const size = schema.inputSide;
      if (size?.type !== "enum") throw new Error("Depth input size must be an enum");
      expect(size.options.map(option => option.value)).toEqual(depthBackend === "wasm" ? ["266", "518"]
        : ["266", "392", "518", "644", "770", "896", "1036", "1288"]);
    }
    expect(floatMapInNode.requires).toBeUndefined();
  });

  /**
   * T1817b: Depth Pro 2 has two fixed boxes, not Depth Anything's sides, and its field of
   * view matters only to it. B is half precision and is not offered on the CPU.
   */
  it("offers Depth Pro 2 its two boxes on the backends it runs on, and its field of view only to it", () => {
    const sizes = (depthModel: string, depthBackend: string) => {
      const size = effectiveParameterSchema(floatMapInNode, { interpretation: "depth", depthModel, depthBackend }).inputSide;
      if (size?.type !== "enum") throw new Error("Depth input size must be an enum");
      return { values: size.options.map(option => option.value), labels: size.options.map(option => option.label), fallback: size.default };
    };
    expect(sizes("depthpro2-s-fp32", "webgpu")).toEqual({ values: ["640", "672"], labels: ["640 × 480 (4:3)", "672 × 384 (16:9)"], fallback: "640" });
    expect(sizes("depthpro2-s-fp32", "wasm").values).toEqual(["640", "672"]);
    expect(sizes("depthpro2-b-fp16", "webgpu").values).toEqual(["640", "672"]);
    expect(sizes("depthpro2-b-fp16", "wasm").values).toEqual([]);
    const backend = effectiveParameterSchema(floatMapInNode, { depthModel: "depthpro2-s-fp32" }).depthBackend;
    expect(backend?.type === "enum" && backend.default).toBe("webgpu");
    const model = effectiveParameterSchema(floatMapInNode, {}).depthModel;
    if (model?.type !== "enum") throw new Error("Depth model must be an enum");
    expect(model.options.filter(option => option.value.startsWith("depthpro2")).map(option => option.label))
      .toEqual(["Depth Pro 2 S FP32 · research only (94.0 MB)", "Depth Pro 2 B FP16 · research only (190.0 MB)"]);
    const fieldOfView = effectiveParameterSchema(floatMapInNode, {}).depthFieldOfView;
    expect(fieldOfView?.inactiveWhen?.({ interpretation: "depth", depthModel: "depthpro2-b-fp16" })).toBeNull();
    expect(fieldOfView?.inactiveWhen?.({ interpretation: "depth", depthModel: "depth-anything-v2-small" })).toBeTruthy();
    expect(fieldOfView?.inactiveWhen?.({ interpretation: "raw", depthModel: "depthpro2-s-fp32" })).toBeTruthy();
  });

  it("declares a data source with float32 storage and project resolution", () => {
    expect(validateNodeDefinition(floatMapInNode)).toEqual([]);
    expect(floatMapInNode.inputs).toEqual([expect.objectContaining({ id: "picture", optional: true })]);
    expect(floatMapInNode.outputs[0]?.type).toEqual(DATA_TEXTURE);
    expect(floatMapInNode.formatPolicy).toEqual({ kind: "fixed", format: "r32float" });
    expect(floatMapInNode.resolutionPolicy).toEqual({ kind: "project" });
  });

  it("compiles an unfiltered numerical blit through the ordinary backend plan", () => {
    const compiled = floatMapInNode.compile(compileContext({ inputs: [] }));
    expect(compiled.scratch).toEqual([{
      key: FLOAT_MAP_TEXTURE_KEY, kind: "external", sourceId: floatMapSourceIdFor("n1"), format: "r32float",
    }]);
    const read = readNodePlan(compiled.passes, { inputs: [], scratch: [FLOAT_MAP_TEXTURE_KEY] });
    expect(read.diagnostics.filter(diagnostic => diagnostic.severity === "error")).toEqual([]);
    const pass = read.passes[0];
    if (pass?.kind !== "effect") throw new Error("Float Map In did not compile an effect pass");
    expect(pass.textures).toEqual([{
      binding: "floatMapTexture", resourceId: scratchResourceId("n1", FLOAT_MAP_TEXTURE_KEY), sampled: "unfiltered",
    }]);
    expect(pass.samplers).toEqual([]);
    expect(pass.uniforms).toBeUndefined();
    expect(pass.shader).toContain("textureLoad(floatMapTexture, vec2i(position.xy), 0).r");
    expect(pass.shader).not.toMatch(/textureSample|srgb|pow\(/i);
  });

  it("uses stable opaque node identity across sizes and parameter changes", () => {
    const nodeId = "opaque:reference/α";
    for (const resolution of [[640, 480], [1920, 1080]] as const) {
      const compiled = floatMapInNode.compile(compileContext({
        nodeId, resolution, inputs: [], parameters: { interpretation: "depth", inputSide: "644", photo: "asset:photo" },
      }));
      expect(compiled.scratch?.[0]).toMatchObject({ sourceId: `${nodeId}:floatMap`, format: "r32float" });
    }
  });

  it("declares no pass or external source when its output is pruned", () => {
    expect(floatMapInNode.compile(compileContext({ inputs: [], outputs: [] }))).toEqual({ passes: [] });
  });

  it("prepares only on the explicit command pulse", () => {
    const parameters = effectiveParameterSchema(floatMapInNode, {});
    expect(parameters["file"]).toMatchObject({ type: "asset", kind: "binary" });
    expect(parameters["photo"]).toMatchObject({ type: "asset", kind: "image" });
    expect(parameters["interpretation"]).toMatchObject({ type: "enum", default: "raw" });
    expect(parameters["prepare"]).toMatchObject({ type: "pulse", fires: "photoMapping.prepare", input: { nodeIds: ["$node"] } });
    expect(parameters["photo"]?.inactiveWhen?.({ interpretation: "raw" })).toBeTruthy();
    expect(parameters["photo"]?.inactiveWhen?.({ interpretation: "depth" })).toBeNull();
    expect(parameters["photo"]?.inactiveWhen?.({ interpretation: "mask" })).toBeNull();
    expect(parameters["prepare"]?.inactiveWhen?.({ interpretation: "raw" })).toBeTruthy();
    expect(parameters["prepare"]?.inactiveWhen?.({ interpretation: "mask" })).toBeNull();
  });

  it("offers legal depth sizes only for depth preparation", () => {
    const inputSide = effectiveParameterSchema(floatMapInNode, {})["inputSide"];
    if (inputSide?.type !== "enum") throw new Error("Depth input size must be an enum");
    expect(inputSide.default).toBe("518");
    expect(inputSide.options.map(option => option.value)).toEqual(["266", "392", "518", "644", "770", "896", "1036", "1288"]);
    expect(inputSide.options.every(option => Number(option.value) % 14 === 0)).toBe(true);
    expect(inputSide.inactiveWhen?.({ interpretation: "depth" })).toBeNull();
    expect(inputSide.inactiveWhen?.({ interpretation: "mask" })).toBeTruthy();
    expect(inputSide.inactiveWhen?.({ interpretation: "raw" })).toBeTruthy();
  });

  it("fills an explicitly unassigned constant map in float32 without external resources", () => {
    for (const file of [undefined, ""]) for (const emptyValue of [0.5, 1, -2.5, 1.0000001192092896]) {
      const compiled = floatMapInNode.compile(compileContext({ inputs: [],
        parameters: { ...(file === undefined ? {} : { file }), emptySource: "constant", emptyValue } }));
      expect(compiled.scratch).toBeUndefined();
      expect(compiled.passes).toHaveLength(1);
      const read = readNodePlan(compiled.passes, { inputs: [], scratch: [] });
      expect(read.diagnostics.filter(diagnostic => diagnostic.severity === "error")).toEqual([]);
      const pass = read.passes[0];
      if (pass?.kind !== "effect") throw new Error("Unassigned Float Map In must compile an effect pass");
      expect(pass.textures).toEqual([]); expect(pass.samplers).toEqual([]);
      expect(pass.uniforms).toEqual({ emptyValue });
      expect(pass.uniformBinding).toBe("params");
      expect(pass.shader).toContain("return vec4f(params.emptyValue, 0.0, 0.0, 1.0)");
      expect(pass.shader).not.toMatch(/textureLoad|textureSample|srgb|pow\(/i);
    }
    expect(floatMapInNode.formatPolicy).toEqual({ kind: "fixed", format: "r32float" });
    expect(floatMapInNode.requires).toBeUndefined();
  });

  it("always loads an assigned locator even when unassigned-constant mode is selected", () => {
    for (const file of ["asset:depth", "file:///missing.loom.exr", "asset:corrupt", " "]) {
      const compiled = floatMapInNode.compile(compileContext({ inputs: [], parameters: { file, emptySource: "constant", emptyValue: 1 } }));
      expect(compiled.scratch).toEqual([{ key: FLOAT_MAP_TEXTURE_KEY, kind: "external", sourceId: floatMapSourceIdFor("n1"), format: "r32float" }]);
      const pass = readNodePlan(compiled.passes, { inputs: [], scratch: [FLOAT_MAP_TEXTURE_KEY] }).passes[0];
      if (pass?.kind !== "effect") throw new Error("Assigned Float Map In must compile its normal blit");
      expect(pass.uniforms).toBeUndefined();
      expect(pass.textures?.[0]?.resourceId).toBe(scratchResourceId("n1", FLOAT_MAP_TEXTURE_KEY));
    }
  });

  it("preserves required-file behavior by default and recompiles changes to source selection", () => {
    const schema = effectiveParameterSchema(floatMapInNode, {});
    expect(schema.emptySource).toMatchObject({ type: "enum", default: "error", compileTime: true });
    expect(schema.file?.compileTime).toBe(true);
    expect(schema.emptyValue).toMatchObject({ type: "number", default: 0.5, min: 0, max: 1, range: "soft" });
    for (const parameters of [{}, { file: "" }, { file: "", emptySource: "error" }]) {
      expect(floatMapInNode.compile(compileContext({ inputs: [], parameters })).scratch?.[0]?.kind).toBe("external");
    }
    const compiled = floatMapInNode.compile(compileContext({ inputs: [], parameters: { emptySource: "constant" } }));
    const pass = readNodePlan(compiled.passes, { inputs: [], scratch: [] }).passes[0];
    if (pass?.kind !== "effect") throw new Error("Unassigned Float Map In must compile an effect pass");
    expect(pass.uniforms).toEqual({ emptyValue: 0.5 });
    expect(schema.emptyValue?.inactiveWhen?.({ emptySource: "constant", file: "" })).toBeNull();
    expect(schema.emptyValue?.inactiveWhen?.({ emptySource: "constant", file: "asset:map" })).toBeTruthy();
  });

  it.each([NaN, Infinity, -Infinity])("refuses nonfinite unassigned constants: %s", emptyValue => {
    expect(() => floatMapInNode.compile(compileContext({ inputs: [], parameters: { emptySource: "constant", emptyValue } }))).toThrow(/must be finite/);
  });
});
