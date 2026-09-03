import { describe, expect, it } from "vitest";

import type { NodeCompileContext } from "../../domain/types/node-definition.ts";
import type { LogicalExecutionPlan } from "../../domain/types/backend.ts";
import { readExecutionPlan } from "../../runtime/backend/plan.ts";
import { createNodeRegistry, validateNodeDefinition } from "../registry/registry.ts";
import { SHADER_SOURCE_PARAMETER } from "../../domain/commands/apply-patch.ts";
import { customWgslNode, declaresUniformBlock, reflectParamsStruct } from "./custom-wgsl.ts";
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
   * T880 — the shader's `struct Params` reflects into the node's controls (code-first). A
   * shader gets EXACTLY the fields it declares bound, each shaped to its WGSL type — the
   * property that keeps E43/E45's §V147 identity intact (an amount-only kernel is handed only
   * `amount`, never a colour it never named).
   */
  describe("the reflected parameters (T880)", () => {
    const withParams = (fields: string) => `${SHARED_UNIFORMS_WGSL}
struct Params { ${fields} };
@group(0) @binding(0) var inputSampler: sampler;
@group(0) @binding(1) var inputTexture: texture_2d<f32>;
@group(0) @binding(3) var<uniform> params: Params;
@fragment fn fs(@location(0) uv: vec2f) -> @location(0) vec4f { return params.lightColor * params.orbitSpeed; }`;

    it("reflects each field's name and WGSL type, ignoring comments", () => {
      const fields = reflectParamsStruct(withParams("lightColor: vec4f, orbitSpeed: f32, /* skip: u32 */"));
      expect(fields).toEqual([
        { name: "lightColor", wgsl: "vec4f" },
        { name: "orbitSpeed", wgsl: "f32" },
      ]);
    });

    it("grows a typed parameter PER field — a colour by name, a number for f32", () => {
      const schema = customWgslNode.parametersFor!({ [SHADER_SOURCE_PARAMETER]: withParams("lightColor: vec4f, orbitSpeed: f32,") });
      expect(schema["lightColor"]?.type).toBe("color"); // named a colour → RGBA picker
      expect(schema["orbitSpeed"]?.type).toBe("number"); // plain f32 → a number
      expect(schema["lightColor"]?.label).toBe("Light Color");
      // The source editor is always present; a field the struct did not name is not.
      expect(schema[SHADER_SOURCE_PARAMETER]?.type).toBe("code");
      expect(schema["scalar9"]).toBeUndefined();
    });

    /**
     * T1053 — THE AUTHOR'S SENTENCE, AND THE PROOF IT IS NOT A SECOND PLACE TO KEEP IT.
     *
     * A reflected label comes from the field NAME, which says what a knob is called and
     * nothing about what turning it does — so every promoted constant arrived documented as
     * "reaches the kernel as `params.x`", which the user could already read off the struct.
     * The trailing `//` comment is where that sentence already is in any shader anybody
     * writes, so it is read rather than re-declared: there is no annotation key that can
     * come to disagree with the field it annotates.
     *
     * The three cases that matter are the three asserted: a note wins over the caller's
     * generic help, a field WITHOUT one is untouched (which is what keeps every shipped
     * shader reflecting exactly as it did), and a note is found through a block comment —
     * `maskComments` blanks a `/* … *\/` to spaces of the same LENGTH but not the same LINE
     * COUNT, so the note is located by INDEX in the masked text and read from the original.
     */
    it("takes a field's trailing // comment as the control's description", () => {
      const source = withParams("\n  orbitSpeed: f32, // How fast the lanterns swing.\n  glow: f32,\n");
      const schema = customWgslNode.parametersFor!({ [SHADER_SOURCE_PARAMETER]: source });
      expect(schema["orbitSpeed"]?.description).toBe("How fast the lanterns swing.");
      // ...and a field that says nothing keeps the generic help, unchanged from before T1053.
      expect(schema["glow"]?.description).toBe("Reaches the kernel as `params.glow` (f32).");
    });

    /**
     * The two ways the wrong pair of copies gets this wrong, and both were live for one
     * revision of §T1053 before this test existed.
     *
     * READING THE LINE END OFF THE COMMENT-MASKED COPY. `maskComments` blanks a `/* … *\/`
     * to spaces of the same LENGTH, which deletes the newlines inside it — so a field whose
     * line is ended by an opening block comment appears, in that copy, to run on into the
     * NEXT field's line and to steal the note that belongs there. `a` below has nothing to
     * say and must be reported as saying nothing.
     *
     * SEARCHING FOR `//` IN THE RAW SOURCE. A block comment that happens to contain a slash
     * pair is not a line comment, and reading it as one turns the tail of somebody's prose
     * into a control's description. Hence the block-masked copy: it leaves exactly the real
     * line comments visible, at their original indices.
     */
    it("gives a line-ending block comment's note to the field after it, not the one before", () => {
      const fields = reflectParamsStruct(withParams("\n  a: f32, /* spans\n  lines */ b: f32, // b's own\n"));
      expect(fields).toEqual([{ name: "a", wgsl: "f32" }, { name: "b", wgsl: "f32", note: "b's own" }]);
    });

    it("does not read a slash pair inside a block comment as a note", () => {
      const fields = reflectParamsStruct(withParams("\n  a: f32, /* holds // slashes */\n  b: f32,\n"));
      expect(fields).toEqual([{ name: "a", wgsl: "f32" }, { name: "b", wgsl: "f32" }]);
    });

    it("a vec4f NOT named as a colour stays a vector, not a picker (the vec3f/vec4f fork)", () => {
      const schema = customWgslNode.parametersFor!({ [SHADER_SOURCE_PARAMETER]: withParams("offset: vec4f,") });
      expect(schema["offset"]?.type).toBe("vector");
    });

    it("binds ONLY the declared fields, each shaped to its type", () => {
      const source = withParams("lightColor: vec4f, orbitSpeed: f32,");
      const pass = firstPass(contextFor({ parameters: { [SHADER_SOURCE_PARAMETER]: source, lightColor: [0.2, 0.4, 0.6, 1], orbitSpeed: 0.5 } }));
      expect(pass.uniforms).toEqual({ lightColor: [0.2, 0.4, 0.6, 1], orbitSpeed: 0.5 });
      expect(pass.uniforms).not.toHaveProperty("amount");
    });

    it("keeps §V147: an amount-only kernel is still handed amount and nothing else", () => {
      const source = withParams("amount: f32,");
      const pass = firstPass(contextFor({ parameters: { [SHADER_SOURCE_PARAMETER]: source, amount: 0, lightColor: [1, 0, 0, 1] } }));
      // lightColor is set on the node but the shader never declared it, so it is not bound —
      // the E43 identity (amount = 0 → byte-identical) cannot be perturbed by an unused control.
      expect(pass.uniforms).toEqual({ amount: 0 });
    });

    it("a vec3f colour takes rgb, a vec4f colour takes rgba", () => {
      const three = firstPass(contextFor({ parameters: { [SHADER_SOURCE_PARAMETER]: withParams("tint: vec3f,"), tint: [0.1, 0.2, 0.3, 1] } }));
      expect(three.uniforms).toEqual({ tint: [0.1, 0.2, 0.3] });
      const four = firstPass(contextFor({ parameters: { [SHADER_SOURCE_PARAMETER]: withParams("tint: vec4f,"), tint: [0.1, 0.2, 0.3, 0.4] } }));
      expect(four.uniforms).toEqual({ tint: [0.1, 0.2, 0.3, 0.4] });
    });

    /**
     * §T1059 — THE SHADER THAT ATE ITS OWN EDITOR.
     *
     * `struct Params { source: f32 }` is a perfectly ordinary thing to write, and it used to
     * overwrite `SOURCE_PARAM` in the reflected schema. The KEY survived and its code-ness did
     * not, so the shader editor disappeared off the node — no error, nothing to click, and no
     * way back short of editing the `.loom.json` by hand. The one control that could have
     * repaired the shader was the one the shader deleted.
     *
     * The point kernels have refused this since T900 and `customWgsl` did not, so the fix is
     * that same pair applied here rather than a second answer to the same question (§V349): the
     * node's own key wins, the reflected field is dropped, and the compiler says which field and
     * what to rename it to (§V288).
     *
     * The first test reads the CODE-NESS of the surviving parameter, not merely its presence —
     * the key was never the thing that was lost, so an assertion on `!== undefined` would have
     * passed against the bug (§V870). The second proves the drop is not the silent kind.
     */
    it("keeps its shader editor when a field is named after the source parameter", () => {
      const schema = customWgslNode.parametersFor!({
        [SHADER_SOURCE_PARAMETER]: withParams("source: f32, orbitSpeed: f32,"),
      });
      const editor = schema[SHADER_SOURCE_PARAMETER];
      // `type: "code"` is what mounts the WGSL editor; a `number` here IS the vanished editor.
      expect(editor?.type).toBe("code");
      expect(editor).toMatchObject({
        language: "wgsl",
        compileTime: true,
        default: CUSTOM_WGSL_DEFAULT_SOURCE,
      });
      // The collision costs the colliding field only — everything else still reflects.
      expect(schema["orbitSpeed"]?.type).toBe("number");
    });

    it("refuses the colliding field by name instead of dropping it in silence (§V288)", () => {
      const compiled = customWgslNode.compile(
        contextFor({ parameters: { [SHADER_SOURCE_PARAMETER]: withParams("source: f32,") } }),
      );
      expect(compiled.passes).toEqual([]);
      const said = (compiled.diagnostics ?? []).find((entry) => entry.code === "node.customWgsl.params");
      expect(said?.severity).toBe("error");
      expect(said?.message).toContain('"source"');
      expect(said?.suggestion).toContain("sourceParam");
    });

    it("says nothing and compiles normally when no field takes an owned name", () => {
      const compiled = customWgslNode.compile(
        contextFor({ parameters: { [SHADER_SOURCE_PARAMETER]: withParams("orbitSpeed: f32,") } }),
      );
      // The legitimate case the guard could swallow: `ownKeys` is one name, not "anything the
      // static manifest happens to list" — `amount` in particular must still reflect, because
      // E43/E45 are shaders whose only control IS a declared `amount`.
      expect(compiled.diagnostics ?? []).toEqual([]);
      expect(compiled.passes).toHaveLength(1);
      const amountOnly = customWgslNode.parametersFor!({ [SHADER_SOURCE_PARAMETER]: withParams("amount: f32,") });
      expect(amountOnly["amount"]?.type).toBe("number");
    });
  });
});
