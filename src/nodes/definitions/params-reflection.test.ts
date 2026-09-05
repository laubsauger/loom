import { describe, expect, it } from "vitest";

import { SHADER_SOURCE_PARAMETER } from "../../domain/commands/apply-patch.ts";
import { effectiveParameterSchema, resolveParameters } from "../../domain/parameters/resolve.ts";
import type { GraphNode } from "../../domain/types/graph.ts";
import { SHARED_UNIFORMS_WGSL } from "../../runtime/backend/shared-uniforms.ts";
import { CUSTOM_WGSL_UNIFORM_BINDING } from "../shaders/custom-wgsl-default.wgsl.ts";
import { customWgslNode } from "./custom-wgsl.ts";
import { declaresUniformBlock, extractParamsStruct, reflectParamsStruct } from "./params-reflection.ts";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════
 * T1172 — THE REFLECTION MEMO, AND THE ONLY THING THAT CAN GO WRONG WITH IT
 * ═══════════════════════════════════════════════════════════════════════════════════
 *
 * The reflector is a pure function of the WGSL text and it is now memoised, because
 * §T1172 measured it running TWENTY-TWO TIMES A FRAME for E55's two `customWgsl` nodes —
 * five per-frame call sites, twenty of the twenty-two arriving through `op('reactor1')
 * .par.*` reads, at 0.3 ms per scan of a 41 KB source. §V163 says an animated document
 * recompiles every frame ON PURPOSE; what it does not say is that the same text must be
 * re-scanned each time.
 *
 * ⚠ A MEMO THAT OUTLIVES AN EDIT IS A STALE-VALUE BUG, and a stale SCHEMA is the worst
 * shape of it: the author adds `orbitSpeed: f32`, no control appears, and the uniform
 * binds nothing. That is the whole risk of this change and it is what these gates are
 * for. Speed is NOT asserted here — a timing assertion on a shared machine is a flake
 * (§V929), and the measurement lives in the task record. What is asserted is that every
 * answer belongs to the bytes it was asked about, at every layer a caller can reach:
 * the reflector, the node's own schema funnel (§V814), and a RESOLVE of a reflected
 * control that carries an expression.
 *
 * The last of those is §B181's lesson made mechanical. Twenty-six green tests hid a
 * frozen transport parameter for months because EVERY ONE OF THEM RESOLVED A STATIC —
 * so the gates below drive a reflected knob from the frame clock and assert the value
 * MOVES, which is the only claim a memo could break silently.
 */

const sourceWith = (fields: string): string => `${SHARED_UNIFORMS_WGSL}
struct Params { ${fields} };
@group(0) @binding(0) var inputSampler: sampler;
@group(0) @binding(1) var inputTexture: texture_2d<f32>;
@group(0) @binding(3) var<uniform> ${CUSTOM_WGSL_UNIFORM_BINDING}: Params;
@fragment fn fs(@location(0) uv: vec2f) -> @location(0) vec4f { return vec4f(params.gain); }`;

function customWgslNodeAt(source: string, parameters: GraphNode["parameters"] = {}): GraphNode {
  return {
    id: "n1",
    type: "customWgsl",
    definitionVersion: customWgslNode.version,
    position: { x: 0, y: 0 },
    label: "shader1",
    parameters: { [SHADER_SOURCE_PARAMETER]: source, ...parameters },
  };
}

const frameAt = (frameIndex: number) =>
  ({
    timeSeconds: frameIndex / 60,
    deltaSeconds: 1 / 60,
    frameIndex,
    mode: "realtime",
    randomSeed: 7,
  }) as const;

describe("T1172 — the reflection memo answers about the bytes it was asked about", () => {
  it("reflects each source's OWN fields, however many other sources it has been asked about", () => {
    // The failure a one-slot memo produces: B is asked between two asks about A, and A's
    // second answer is B's. Interleaved deliberately, because a cache that is correct
    // when read in blocks can still be wrong when read alternately — which is exactly
    // how E55 reads it (haze1's source and reactor1's source, every frame).
    const a = sourceWith("gain: f32,");
    const b = sourceWith("gain: f32, tilt: vec2f,");

    expect(reflectParamsStruct(a)).toEqual([{ name: "gain", wgsl: "f32" }]);
    expect(reflectParamsStruct(b)).toEqual([
      { name: "gain", wgsl: "f32" },
      { name: "tilt", wgsl: "vec2f" },
    ]);
    expect(reflectParamsStruct(a)).toEqual([{ name: "gain", wgsl: "f32" }]);
    expect(reflectParamsStruct(b)).toEqual([
      { name: "gain", wgsl: "f32" },
      { name: "tilt", wgsl: "vec2f" },
    ]);
  });

  it("gives one source's answer back for the same source — the memo, stated as identity", () => {
    // The one MECHANISM claim in this file, and it earns its place: nothing else here can
    // fail if the memo is deleted, so without it a regression that restores the 22
    // scans-per-frame lands green. Two calls, one array.
    const source = sourceWith("gain: f32, spin: f32,");
    expect(reflectParamsStruct(source)).toBe(reflectParamsStruct(source));
  });

  it("answers `declaresUniformBlock` per BINDING NAME, not once per source", () => {
    // The per-name cache is keyed on the name and then the source. Keyed on the source
    // alone, the first question asked about a text would answer every later one — so a
    // shader declaring `params` would report that it also declares `frameU`, and the
    // compiler would bind a block the source never asked for (§V288's silent-drop).
    const source = sourceWith("gain: f32,");
    expect(declaresUniformBlock(source, CUSTOM_WGSL_UNIFORM_BINDING)).toBe(true);
    expect(declaresUniformBlock(source, "nothingDeclaresThis")).toBe(false);
    expect(declaresUniformBlock(source, CUSTOM_WGSL_UNIFORM_BINDING)).toBe(true);
  });

  it("hands each caller its own `extractParamsStruct` result, so one cannot poison the next", () => {
    /*
     * The declared return type is mutable and a point kernel destructures it. A shared
     * object would let any caller's write become every later caller's answer.
     *
     * §V910: the mutation has to happen to a CACHE HIT, not to the first call. The first
     * call is the MISS path and returns a fresh wrapper whatever the implementation does,
     * so writing to it proves nothing — an earlier draft of this gate did exactly that and
     * stayed green against a deliberately shared object. Three calls: warm, poison the
     * value a hit handed back, then read.
     */
    const source = sourceWith("poisonCanary: f32,");
    extractParamsStruct(source);
    const onHit = extractParamsStruct(source);
    onHit.declaration = "struct Params { ruined: f32 };";
    onHit.rest = "";
    const afterwards = extractParamsStruct(source);
    expect(afterwards.declaration).toContain("poisonCanary: f32");
    expect(afterwards.rest).toContain("@fragment");
  });

  it("keeps answering correctly once the cache has been filled past its cap", () => {
    // FIFO eviction: the oldest entry goes. The hazard is not eviction, it is an entry
    // surviving under the WRONG key, so the check is that a long-evicted source and a
    // brand-new one both still reflect their own fields.
    const first = sourceWith("first: f32,");
    expect(reflectParamsStruct(first)).toEqual([{ name: "first", wgsl: "f32" }]);
    for (let index = 0; index < 200; index += 1) reflectParamsStruct(sourceWith(`filler${index}: f32,`));
    expect(reflectParamsStruct(first)).toEqual([{ name: "first", wgsl: "f32" }]);
    expect(reflectParamsStruct(sourceWith("last: vec3f,"))).toEqual([{ name: "last", wgsl: "vec3f" }]);
  });
});

describe("T1172 — an edited shader still grows and loses controls (§V814)", () => {
  it("adds the control a newly declared field asks for", () => {
    // Through the funnel a node is read by, not the reflector directly: this is the
    // sentence the user experiences — "I added a field, the knob appeared".
    const before = effectiveParameterSchema(customWgslNode, customWgslNodeAt(sourceWith("gain: f32,")).parameters);
    expect(before["spin"]).toBeUndefined();

    const after = effectiveParameterSchema(
      customWgslNode,
      customWgslNodeAt(sourceWith("gain: f32, spin: f32,")).parameters,
    );
    expect(after["gain"]?.type).toBe("number");
    expect(after["spin"]?.type).toBe("number");
  });

  it("loses the control a deleted field no longer asks for", () => {
    const withSpin = effectiveParameterSchema(
      customWgslNode,
      customWgslNodeAt(sourceWith("gain: f32, spin: f32,")).parameters,
    );
    expect(withSpin["spin"]?.type).toBe("number");

    const withoutSpin = effectiveParameterSchema(
      customWgslNode,
      customWgslNodeAt(sourceWith("gain: f32,")).parameters,
    );
    expect(withoutSpin["spin"]).toBeUndefined();
  });

  it("changes a field's CONTROL KIND when its declared type changes", () => {
    // The subtler stale shape: the key survives and its meaning does not. `tint: vec3f`
    // is a colour picker; edited to `f32` it is a number, and a memo returning the old
    // definition would keep a picker over a scalar uniform.
    const asColour = effectiveParameterSchema(
      customWgslNode,
      customWgslNodeAt(sourceWith("tint: vec3f,")).parameters,
    );
    expect(asColour["tint"]?.type).toBe("color");

    const asNumber = effectiveParameterSchema(
      customWgslNode,
      customWgslNodeAt(sourceWith("tint: f32,")).parameters,
    );
    expect(asNumber["tint"]?.type).toBe("number");
  });
});

describe("T1172 — a memoised schema still resolves a MOVING value (§B181)", () => {
  /*
   * §B181's shape: every gate resolved a static, so a frozen driven parameter passed 26 of
   * them. A schema memo is exactly the kind of change that could freeze one — the schema
   * is what says a key exists and what its bounds are, and a stale schema silently drops
   * the key, at which point §V108 hands back the retained static forever and the picture
   * stops moving while every static assertion stays green.
   */
  const animated = customWgslNodeAt(sourceWith("gain: f32,"), {
    gain: {
      mode: "expression",
      bindings: {
        static: { kind: "static", value: 0.25 },
        expression: { kind: "expression", source: "time * 2" },
      },
    },
  });

  it("resolves a reflected control's EXPRESSION to a different number on a different frame", () => {
    const atZero = resolveParameters(animated, customWgslNode, { frame: frameAt(0) }).get("gain");
    const atSixty = resolveParameters(animated, customWgslNode, { frame: frameAt(60) }).get("gain");

    expect(atZero?.diagnostic).toBeNull();
    expect(atSixty?.diagnostic).toBeNull();
    // `time * 2` at frame 0 and frame 60 of a 60 fps timeline: 0 and 2.
    expect(atZero?.value).toBe(0);
    expect(atSixty?.value).toBe(2);
    // Driven, not the retained static — the exact distinction §B181's suite could not see.
    expect(atZero?.driven).toBe(true);
    expect(atSixty?.driven).toBe(true);
    expect(atSixty?.value).not.toBe(0.25);
  });

  it("keeps resolving the expression after the SAME source has been reflected many times", () => {
    // The memo's steady state, which is the state the app is in from frame two onward.
    for (let index = 0; index < 50; index += 1) resolveParameters(animated, customWgslNode, { frame: frameAt(index) });
    const late = resolveParameters(animated, customWgslNode, { frame: frameAt(120) }).get("gain");
    expect(late?.value).toBe(4);
    expect(late?.driven).toBe(true);
  });
});
