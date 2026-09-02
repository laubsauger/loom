import { describe, expect, it } from "vitest";

import type { NodeCompileContext } from "../../domain/types/node-definition.ts";
import type { LogicalExecutionPlan } from "../../domain/types/backend.ts";
import { readExecutionPlan } from "../../runtime/backend/plan.ts";
import { createNodeRegistry, validateNodeDefinition } from "../registry/registry.ts";
import { SHADER_SOURCE_PARAMETER } from "../../domain/commands/apply-patch.ts";
import { customWgslNode, declaresUniformBlock, paramsStructFields } from "./custom-wgsl.ts";
import {
  CUSTOM_WGSL_DEFAULT_SOURCE,
  CUSTOM_WGSL_SHARED_BINDING,
  CUSTOM_WGSL_UNIFORM_BINDING,
} from "../shaders/custom-wgsl-default.wgsl.ts";
import { SHARED_UNIFORMS_WGSL } from "../../runtime/backend/shared-uniforms.ts";

/** CustomWGSL — user-authored fragment effect (T15). */

function contextFor(overrides: Partial<NodeCompileContext> = {}): NodeCompileContext {
  return {
    nodeId: "n1",
    outputs: { out: { portId: "out", resourceId: "target-1" } },
    inputs: { input: [{ portId: "input", resourceId: "scene", sampler: "linear" }] },
    sampler: "sampler:linear",
    parameters: { [SHADER_SOURCE_PARAMETER]: CUSTOM_WGSL_DEFAULT_SOURCE },
    ...overrides,
  };
}

function firstPass(context: NodeCompileContext) {
  const pass = customWgslNode.compile(context).passes[0];
  return pass as {
    shader?: string;
    uniforms?: Record<string, unknown>;
    uniformBinding?: string;
    sharedBinding?: string;
  };
}

describe("CustomWGSL node (T15)", () => {
  it("registers cleanly in a real registry with no manifest diagnostics", () => {
    expect(validateNodeDefinition(customWgslNode)).toEqual([]);
    const registry = createNodeRegistry([customWgslNode]);
    expect(registry.get("customWgsl")).toBe(customWgslNode);
  });

  it("has one rgba input, one rgba output, resolution and format inherited from input", () => {
    const rgba = { kind: "texture2d", sample: "float", channels: 4 };
    expect(customWgslNode.inputs).toEqual([{ id: "input", label: "Input", type: rgba }]);
    expect(customWgslNode.outputs).toEqual([{ id: "out", label: "Out", type: rgba }]);
    expect(customWgslNode.resolutionPolicy).toEqual({ kind: "inherit", input: "input" });
    expect(customWgslNode.formatPolicy).toEqual({ kind: "inherit", input: "input" });
  });

  it(`exposes its shader under the established "${SHADER_SOURCE_PARAMETER}" parameter name`, () => {
    expect(SHADER_SOURCE_PARAMETER).toBe("source");
    const parameter = customWgslNode.parameters[SHADER_SOURCE_PARAMETER];
    expect(parameter).toBeDefined();
    // T492: source is CODE now — the kind every editing surface derives from.
    expect(parameter?.type).toBe("code");
    // compileTime: editing the shader changes structure and must force a rebuild (§V5).
    expect(parameter?.compileTime).toBe(true);
  });

  it("ships the default source as the shader parameter's default", () => {
    const parameter = customWgslNode.parameters[SHADER_SOURCE_PARAMETER];
    expect(parameter?.type === "code" ? parameter.default : undefined).toBe(
      CUSTOM_WGSL_DEFAULT_SOURCE,
    );
  });

  it("compiles the current source into a plan-shaped pass bound to its connected input", () => {
    const compiled = customWgslNode.compile(contextFor());
    const plan: LogicalExecutionPlan = {
      passes: compiled.passes,
      resources: [
        { kind: "target", id: "target-1", size: [64, 64], format: "rgba8unorm" },
        { kind: "target", id: "scene", size: [64, 64], format: "rgba8unorm" },
        { kind: "sampler", id: "linear", filter: "linear" },
      ],
      diagnostics: [],
    };
    const read = readExecutionPlan(plan);
    expect(read.ok).toBe(true);

    const pass = read.passes[0];
    expect(pass?.kind).toBe("effect");
    if (pass?.kind === "effect") {
      expect(pass.shader).toBe(CUSTOM_WGSL_DEFAULT_SOURCE);
      expect(pass.target).toBe("target-1");
      expect(pass.textures).toEqual([{ binding: "inputTexture", resourceId: "scene" }]);
      expect(pass.samplers).toEqual([{ binding: "inputSampler", resourceId: "linear" }]);
    }
  });

  it("uses an edited source verbatim rather than falling back to the default", () => {
    const edited = `// edited\n${CUSTOM_WGSL_DEFAULT_SOURCE}`;
    const compiled = customWgslNode.compile(
      contextFor({ parameters: { [SHADER_SOURCE_PARAMETER]: edited } }),
    );
    const pass = compiled.passes[0] as { shader?: unknown };
    expect(pass.shader).toBe(edited);
  });

  it("reports a diagnostic instead of a malformed pass when its input is not connected", () => {
    const compiled = customWgslNode.compile(contextFor({ inputs: {} }));
    expect(compiled.passes).toEqual([]);
    expect(compiled.diagnostics?.[0]?.code).toBe("node.compile.missingResource");
  });
});

/**
 * B7 / T166 — a kernel receives uniforms AND time, and the default declares nothing that
 * is not bound.
 *
 * The old failure had two halves and both are asserted here. `compile()` emitted no
 * `uniformBinding` and no `sharedBinding`, so `params` and the shared frame block were
 * never written; and the shipped default declared a `Params { time, amount }` block anyway,
 * so the first edit to it read zeroes with nothing to blame.
 */
describe("custom kernels receive uniforms and time (B7/T166)", () => {
  it("binds this node's parameters as `params` on the emitted pass", () => {
    const pass = firstPass(contextFor({ parameters: { [SHADER_SOURCE_PARAMETER]: CUSTOM_WGSL_DEFAULT_SOURCE, amount: 0.25 } }));
    expect(pass.uniformBinding).toBe(CUSTOM_WGSL_UNIFORM_BINDING);
    expect(pass.uniforms).toEqual({ amount: 0.25 });
  });

  /**
   * §V44: the shared frame block is the ONLY way time reaches a kernel. Without
   * `sharedBinding` the runtime does not bind it at all — `frameU.time` stays 0 forever and
   * an animated custom shader is simply impossible.
   */
  it("binds the shared frame block so `frameU.time` is real", () => {
    expect(firstPass(contextFor()).sharedBinding).toBe(CUSTOM_WGSL_SHARED_BINDING);
  });

  it("exposes `amount` as a runtime parameter, not a compile-time one (§V5)", () => {
    const parameter = customWgslNode.parameters["amount"];
    expect(parameter?.type).toBe("number");
    expect(parameter?.compileTime).toBeFalsy();
    expect(parameter?.type === "number" ? parameter.default : undefined).toBe(1);
  });

  /**
   * The structural version of "the default does not lie": every uniform block the default
   * source DECLARES is a block the compiled pass BINDS, and vice versa. Read off the source
   * with the node's own reader rather than eyeballed against a copy of the text, so editing
   * one without the other fails here.
   */
  it("declares exactly the uniform blocks the compiled pass binds", () => {
    const pass = firstPass(contextFor());
    const declared = ["frameU", "params"].filter((name) =>
      declaresUniformBlock(CUSTOM_WGSL_DEFAULT_SOURCE, name),
    );
    const bound = [pass.sharedBinding, pass.uniformBinding].filter(
      (name): name is string => name !== undefined,
    );
    expect(declared.sort()).toEqual(bound.sort());
    expect(declared).toHaveLength(2);
  });

  /**
   * `Params.time` is gone on purpose. A per-pass uniform block is written at compile time
   * and on parameter change (§V5, §V21) — it cannot carry a per-frame clock, and the node
   * has nothing to put there. Leaving the field would rebuild the same trap.
   */
  it("does not offer a `time` field in its own uniform block", () => {
    expect(firstPass(contextFor()).uniforms).not.toHaveProperty("time");
    expect(CUSTOM_WGSL_DEFAULT_SOURCE).toContain("var<uniform> frameU: SharedFrame");
  });

  /**
   * §V436/T497 — WHICH CLOCK THE STARTER TEACHES, and the assertion is on the READ rather
   * than on the text, because §V443: this source deliberately NAMES `frameU.time` in a
   * comment pointing at the other choice, so `toContain("frameU.time")` — which is what
   * this file asserted before T497 — passes whichever clock the body actually uses.
   *
   * Every user who makes a shader opens this file, so what it demonstrates is what gets
   * copied. It demonstrated the TIMELINE clock, which wraps at the out point (T455), and so
   * every shader written by imitation inherited a seam at the loop. That is §V437's shape:
   * the absolute clock reached the surfaces and never reached the thing teaching them.
   */
  it("pulses on the ABSOLUTE clock, so the shader people copy laps seamlessly", () => {
    const body = CUSTOM_WGSL_DEFAULT_SOURCE.replace(/\/\/[^\n]*/g, "");
    expect(body).toContain("sin(frameU.absTime)");
    expect(body).not.toContain("frameU.time");
    // The other clock is still REACHABLE and still named where the bindings are declared —
    // a starter that hid it would teach a different wrong thing (§V436: it is a decision).
    expect(CUSTOM_WGSL_DEFAULT_SOURCE).toContain("absTime");
    expect(CUSTOM_WGSL_DEFAULT_SOURCE).toContain("frameU.time");
  });

  /**
   * The reason the bindings are gated rather than always emitted: the runtime matches by
   * NAME and refuses a value with no declaration. E2's Gray-Scott kernel declares neither
   * block — everything it needs is a compile-time `const` — and handing it a `params`
   * buffer would break a project that renders fine today.
   */
  it("omits a binding the user's own source never declares", () => {
    const bare = `@group(0) @binding(0) var inputSampler: sampler;
@group(0) @binding(1) var inputTexture: texture_2d<f32>;
@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  return textureSampleLevel(inputTexture, inputSampler, uv, 0.0);
}`;
    const pass = firstPass(contextFor({ parameters: { [SHADER_SOURCE_PARAMETER]: bare } }));
    expect(pass.uniformBinding).toBeUndefined();
    expect(pass.uniforms).toBeUndefined();
    expect(pass.sharedBinding).toBeUndefined();
  });

  it("reads a declaration, not a mention of the name in a comment", () => {
    const commented = `// params: not declared, just discussed
/* var<uniform> params: Params; */
@group(0) @binding(0) var inputSampler: sampler;
@group(0) @binding(1) var inputTexture: texture_2d<f32>;
@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  return textureSampleLevel(inputTexture, inputSampler, uv, 0.0);
}`;
    expect(declaresUniformBlock(commented, "params")).toBe(false);
    expect(firstPass(contextFor({ parameters: { [SHADER_SOURCE_PARAMETER]: commented } })).uniformBinding).toBeUndefined();
  });

  it("binds a block a hand-written kernel declares for itself", () => {
    const mine = `struct Params { amount: f32, };
@group(0) @binding(0) var inputSampler: sampler;
@group(0) @binding(1) var inputTexture: texture_2d<f32>;
@group(0) @binding(2) var<uniform> params : Params;
@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  return textureSampleLevel(inputTexture, inputSampler, uv, 0.0) * params.amount;
}`;
    const pass = firstPass(contextFor({ parameters: { [SHADER_SOURCE_PARAMETER]: mine, amount: 0.5 } }));
    expect(pass.uniformBinding).toBe("params");
    expect(pass.uniforms).toEqual({ amount: 0.5 });
    expect(pass.sharedBinding).toBeUndefined();
  });

  /** The default's binding names have to match the block the runtime actually fills (§T16). */
  it("names the shared block with the struct the runtime declares", () => {
    expect(CUSTOM_WGSL_DEFAULT_SOURCE).toContain(SHARED_UNIFORMS_WGSL);
    expect(CUSTOM_WGSL_DEFAULT_SOURCE).toContain(
      `var<uniform> ${CUSTOM_WGSL_SHARED_BINDING}: SharedFrame;`,
    );
  });

  /**
   * T880 — the uniform SLOTS. A shader opts into a fixed vocabulary by naming a field in its
   * own `struct Params`, and gets EXACTLY those bound — the property that keeps E43/E45's
   * §V147 identity intact (an amount-only kernel is handed only `amount`, never a colour).
   */
  describe("the uniform slots (T880, B)", () => {
    const withParams = (fields: string) => `${SHARED_UNIFORMS_WGSL}
struct Params { ${fields} };
@group(0) @binding(0) var inputSampler: sampler;
@group(0) @binding(1) var inputTexture: texture_2d<f32>;
@group(0) @binding(3) var<uniform> params: Params;
@fragment fn fs(@location(0) uv: vec2f) -> @location(0) vec4f { return params.color1 * params.scalar1; }`;

    it("parses the field names its own Params struct declares, ignoring comments", () => {
      const fields = paramsStructFields(withParams("color1: vec4f, scalar1: f32, /* color2 */"));
      expect([...fields].sort()).toEqual(["color1", "scalar1"]);
    });

    it("binds ONLY the slots the struct declares — a colour when asked, its value from the param", () => {
      const source = withParams("color1: vec4f, scalar1: f32,");
      const pass = firstPass(contextFor({ parameters: { [SHADER_SOURCE_PARAMETER]: source, color1: [0.2, 0.4, 0.6, 1], scalar1: 0.5 } }));
      expect(pass.uniforms).toEqual({ color1: [0.2, 0.4, 0.6, 1], scalar1: 0.5 });
      // The slots the struct did NOT name are never handed to the kernel.
      expect(pass.uniforms).not.toHaveProperty("color2");
      expect(pass.uniforms).not.toHaveProperty("amount");
      expect(pass.uniforms).not.toHaveProperty("scalar2");
    });

    it("keeps §V147: an amount-only kernel is still handed amount and nothing else", () => {
      const source = withParams("amount: f32,");
      const pass = firstPass(contextFor({ parameters: { [SHADER_SOURCE_PARAMETER]: source, amount: 0, color1: [1, 0, 0, 1] } }));
      // color1 is set on the node but the shader never declared it, so it is not bound —
      // the E43 identity (amount = 0 → byte-identical) cannot be perturbed by an unused slot.
      expect(pass.uniforms).toEqual({ amount: 0 });
    });

    it("dims a slot the shader has not declared (§V146), and lights it once declared", () => {
      const declares = customWgslNode.parameters["color1"];
      if (declares?.type !== "color") throw new Error("color1 is not a colour param");
      const off = declares.inactiveWhen?.({ [SHADER_SOURCE_PARAMETER]: "struct Params { amount: f32, };" });
      const on = declares.inactiveWhen?.({ [SHADER_SOURCE_PARAMETER]: "struct Params { color1: vec4f, };" });
      expect(typeof off).toBe("string"); // a reason to dim it
      expect(on).toBeNull(); // declared → active
    });
  });
});
