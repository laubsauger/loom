import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";

import { classifyEdit } from "../../compiler/recompile.ts";
import { testGraph, testNode } from "../../compiler/test-support.ts";
import { listExamples } from "../../examples/catalogue.ts";
import { runExample } from "../../examples/runner.ts";
import { effectiveParameterSchema } from "../../domain/parameters/resolve.ts";
import { createNodeRegistry } from "../registry/registry.ts";
import { allNodeDefinitions } from "./index.ts";
import { pointKernelAdvancedNode, pointKernelNode } from "./index.ts";
import { reflectParamsStruct as reflectFromNode } from "./custom-wgsl.ts";
import { reflectParamsStruct, extractParamsStruct } from "./params-reflection.ts";
import { compileContext } from "./test-support.ts";
import type { ParameterValue } from "../../domain/types/parameters.ts";

/**
 * T900 — POINT KERNELS ON THE REFLECTION, NOT ON THE FIXED SLOTS.
 *
 * §T880 landed `struct Params` reflection "as the RIGHT design, not the fixed-slot shortcut",
 * and the point kernels stayed on `value1`..`value4` — four generic slots named for their
 * INDEX rather than their meaning, with a hard ceiling of four. This file is the gate for
 * bringing them across BY REUSE, and its four load-bearing claims are:
 *
 *  1. ONE reflector. `custom-wgsl.ts` and the kernels read the same function, so a kernel's
 *     `lightColor: vec4f` and a shader's cannot come to mean different things.
 *  2. THE INVALIDATION SPLIT (§V5 vs the compile-time class). One reflection pass yields two
 *     classes: a reflected field is a UNIFORM WRITE and must never rebuild; the attribute
 *     schema is `compileTime` and MUST rebuild. Both directions are asserted, because getting
 *     it wrong in either direction is a shipped bug — every knob-turn recompiling the
 *     pipeline, or a layout change that silently never takes effect.
 *  3. §V588's budget, LOUD. Nine attributes is a diagnostic that names the number, never a
 *     silent truncation and never B33's silent pipeline failure.
 *  4. MIGRATION: parse forever, emit never. Shipped looms hold `value1`..`value4` and their
 *     kernels read `ctx.value1`; both keep working, and every shipped kernel resolves
 *     BYTE-EQUAL at frame 0.
 */

const registry = createNodeRegistry(allNodeDefinitions).view();

/** A kernel that declares knobs the way `customWgsl` does — and reads them the same way. */
const PARAM_KERNEL = `struct Params {
  orbitSpeed: f32,
  lightColor: vec4f,
  offset: vec2f,
};

fn process(p: Point, ctx: PointCtx) -> Point {
  var q = p;
  q.position = q.position + vec3f(ctx.params.offset, 0.0) * ctx.params.orbitSpeed * ctx.delta;
  return q;
}`;

/** The historical shape: one numbered slot, a comment where the name should have been. */
const SLOT_KERNEL = `fn process(p: Point, ctx: PointCtx) -> Point {
  var q = p;
  // value1 is the orbit speed. It says so here because the parameter could not say it.
  q.position = q.position * (1.0 + ctx.value1 * ctx.delta);
  return q;
}`;

const attributesOf = (count: number): string =>
  JSON.stringify([
    { name: "position", type: "vec3f", semantic: "position", default: [0, 0, 0] },
    ...Array.from({ length: count - 1 }, (_unused, index) => ({
      name: `extra${index}`,
      type: "f32",
      default: [0],
    })),
  ]);

const errorsOf = (result: { diagnostics?: ReadonlyArray<{ severity: string; message: string }> }): string =>
  (result.diagnostics ?? [])
    .filter((diagnostic) => diagnostic.severity === "error")
    .map((diagnostic) => diagnostic.message)
    .join(" | ");

const kernelShader = (parameters: Record<string, ParameterValue>): string => {
  const result = pointKernelNode.compile(compileContext({ nodeId: "sim", outputs: [], parameters }));
  expect(errorsOf(result)).toBe("");
  const pass = result.passes[0] as { shader: string; uniforms: Record<string, unknown> };
  return pass.shader;
};

const kernelPass = (parameters: Record<string, ParameterValue>) => {
  const result = pointKernelNode.compile(compileContext({ nodeId: "sim", outputs: [], parameters }));
  expect(errorsOf(result)).toBe("");
  return result.passes[0] as { shader: string; uniforms: Record<string, number | readonly number[]> };
};

describe("T900 — one reflector, shared with customWgsl", () => {
  it("is literally the same function the customWgsl node exports", () => {
    // Not "produces the same answer" — the SAME reference. A second implementation that
    // agrees today is the thing §V349 is about; this cannot drift because there is one.
    expect(reflectFromNode).toBe(reflectParamsStruct);
  });

  it("reads a kernel's struct Params exactly as it reads a shader's", () => {
    expect(reflectParamsStruct(PARAM_KERNEL)).toEqual([
      { name: "orbitSpeed", wgsl: "f32" },
      { name: "lightColor", wgsl: "vec4f" },
      { name: "offset", wgsl: "vec2f" },
    ]);
  });

  it("lifts the declaration out of the kernel body without touching the rest", () => {
    const { declaration, rest } = extractParamsStruct(PARAM_KERNEL);
    expect(declaration.startsWith("struct Params")).toBe(true);
    expect(rest).not.toContain("struct Params");
    expect(rest).toContain("fn process(p: Point, ctx: PointCtx) -> Point");
    // The author's own bytes, hoisted — not a re-emission that could disagree with them.
    expect(PARAM_KERNEL).toContain(declaration);
  });

  it("ignores a struct Params written inside a comment, and cuts nothing", () => {
    const commented = `// struct Params { fake: f32 };\n${SLOT_KERNEL}`;
    expect(reflectParamsStruct(commented)).toEqual([]);
    expect(extractParamsStruct(commented).rest).toBe(commented);
  });
});

describe("T900 — the kernel's Params become named typed controls (§V805)", () => {
  it("names the knobs after their meaning, with no ceiling of four", () => {
    const six = `struct Params { a: f32, b: f32, c: f32, d: f32, e: f32, f: f32 };\n${SLOT_KERNEL.replace("ctx.value1", "ctx.params.f")}`;
    const schema = pointKernelNode.parametersFor?.({ kernel: six }) ?? {};
    for (const name of ["a", "b", "c", "d", "e", "f"]) {
      expect(schema[name]?.type, name).toBe("number");
    }
    // The point of the whole task: six is more than four, and nothing had to be widened.
    expect(Object.keys(schema).filter((key) => /^[a-f]$/.test(key))).toHaveLength(6);
  });

  it("types each control from the field, and forks vec4f by NAME just as customWgsl does", () => {
    const schema = pointKernelNode.parametersFor?.({ kernel: PARAM_KERNEL }) ?? {};
    expect(schema["orbitSpeed"]).toMatchObject({ type: "number", label: "Orbit Speed" });
    expect(schema["lightColor"]).toMatchObject({ type: "color", space: "display" });
    expect(schema["offset"]).toMatchObject({ type: "vector", size: 2 });
  });

  it("reaches the kernel as ctx.params.<name>, mirrored into the ONE uniform block", () => {
    const pass = kernelPass({ kernel: PARAM_KERNEL, orbitSpeed: 2.5, lightColor: [1, 0, 0, 1], offset: [3, 4] });
    expect(pass.shader).toContain("params: Params,");
    expect(pass.shader).toContain("struct Params");
    // Declared before the PointCtx that carries it — WGSL has no forward declarations.
    expect(pass.shader.indexOf("struct Params")).toBeLessThan(pass.shader.indexOf("struct PointCtx"));
    expect(pass.uniforms["p_orbitSpeed"]).toBe(2.5);
    expect(pass.uniforms["p_lightColor"]).toEqual([1, 0, 0, 1]);
    expect(pass.uniforms["p_offset"]).toEqual([3, 4]);
  });

  it("costs a kernel that declares nothing exactly nothing (§V309)", () => {
    const shader = kernelShader({ kernel: SLOT_KERNEL });
    expect(shader).not.toContain("Params");
    expect(shader).not.toContain("kernelFrame.p_");
  });

  it("refuses a field it cannot turn into a control, by name (§V288)", () => {
    const result = pointKernelNode.compile(
      compileContext({
        nodeId: "sim",
        outputs: [],
        parameters: { kernel: `struct Params { m: mat4x4f };\n${SLOT_KERNEL}` },
      }),
    );
    expect(errorsOf(result)).toContain('struct Params field "m" is mat4x4f');
  });

  it("refuses a field that would shadow one of the node's own parameters", () => {
    const result = pointKernelNode.compile(
      compileContext({
        nodeId: "sim",
        outputs: [],
        parameters: { kernel: `struct Params { capacity: f32 };\n${SLOT_KERNEL}` },
      }),
    );
    expect(errorsOf(result)).toContain('struct Params declares "capacity"');
  });

  it("gives the advanced kernel's spawn hook the SAME knobs, from one declaration", () => {
    const result = pointKernelAdvancedNode.compile(
      compileContext({
        nodeId: "sim",
        outputs: [],
        parameters: {
          capacity: 256,
          kernel: PARAM_KERNEL,
          spawn: "fn spawn(child: Point, ctx: PointCtx) -> Point {\n  var q = child;\n  q.position = q.position * ctx.params.orbitSpeed;\n  return q;\n}",
          orbitSpeed: 1.5,
        },
      }),
    );
    expect(errorsOf(result)).toBe("");
    const hook = (result.passes as ReadonlyArray<{ id: string }>).find((pass) =>
      pass.id.endsWith(":spawnHook"),
    ) as { shader: string; uniforms: Record<string, unknown> } | undefined;
    expect(hook?.shader).toContain("params: Params,");
    expect(hook?.uniforms["p_orbitSpeed"]).toBe(1.5);
  });
});

describe("T900 — the invalidation split: one reflection, two classes", () => {
  const kernelGraph = (parameters: Record<string, ParameterValue>) =>
    testGraph([testNode("sim", "pointKernel", { parameters })]);

  it("TURNING A KNOB DOES NOT RECOMPILE (§V5) — the classifier says uniform-update", () => {
    const graph = kernelGraph({ kernel: PARAM_KERNEL, orbitSpeed: 1 });
    const decision = classifyEdit(
      { kind: "parameter", nodeId: "sim", parameters: ["orbitSpeed"] },
      { graph, registry },
    );
    expect(decision.work).toBe("uniform-update");
  });

  it("TURNING A KNOB DOES NOT RECOMPILE — and the generated WGSL proves it, byte for byte", () => {
    // The classifier's verdict is a claim about the pipeline; this is the pipeline. Same
    // shader text, different uniform value: a buffer write and nothing else (§V147's rule
    // applied to a compile-time claim — assert the artefact, not the intention).
    const cold = kernelPass({ kernel: PARAM_KERNEL, orbitSpeed: 1, lightColor: [1, 1, 1, 1], offset: [0, 0] });
    const warm = kernelPass({ kernel: PARAM_KERNEL, orbitSpeed: 9, lightColor: [1, 1, 1, 1], offset: [0, 0] });
    expect(warm.shader).toBe(cold.shader);
    expect(warm.uniforms["p_orbitSpeed"]).not.toBe(cold.uniforms["p_orbitSpeed"]);
  });

  it("A REFLECTED CONTROL IS NEVER compileTime — checked on the EFFECTIVE schema", () => {
    const node = testNode("sim", "pointKernel", { parameters: { kernel: PARAM_KERNEL } });
    const schema = effectiveParameterSchema(pointKernelNode, node.parameters);
    for (const key of ["orbitSpeed", "lightColor", "offset"]) {
      expect(schema[key]?.compileTime, key).not.toBe(true);
    }
    // …and the structural half of the SAME schema keeps its flag, or the split is one-sided.
    expect(schema["attributes"]?.compileTime).toBe(true);
    expect(schema["kernel"]?.compileTime).toBe(true);
  });

  it("AN ATTRIBUTE CHANGE DOES REBUILD — the classifier says recompile-region", () => {
    const graph = kernelGraph({ kernel: PARAM_KERNEL, attributes: attributesOf(2) });
    const decision = classifyEdit(
      { kind: "parameter", nodeId: "sim", parameters: ["attributes"] },
      { graph, registry },
    );
    expect(decision.work).toBe("recompile-region");
    expect(decision.reason).toContain("compile-time");
  });

  it("AN ATTRIBUTE CHANGE DOES REBUILD — and the module really is a different one", () => {
    // The half that would fail SILENTLY: a layout change classified as a uniform write
    // leaves the old pipeline bound and the new attribute never appears.
    const two = kernelPass({ kernel: SLOT_KERNEL, attributes: attributesOf(2) });
    const three = kernelPass({ kernel: SLOT_KERNEL, attributes: attributesOf(3) });
    expect(three.shader).not.toBe(two.shader);
    expect(three.shader).toContain("extra1");
    expect(two.shader).not.toContain("extra1");
  });

  it("EDITING THE STRUCT rebuilds, because the text it lives in is compileTime", () => {
    const graph = kernelGraph({ kernel: PARAM_KERNEL });
    const decision = classifyEdit(
      { kind: "parameter", nodeId: "sim", parameters: ["kernel"] },
      { graph, registry },
    );
    expect(decision.work).toBe("recompile-region");
  });
});

describe("T900 — §V588's budget, enforced by the reflector and LOUD", () => {
  it("refuses nine attributes with a diagnostic that names the number (never a truncation)", () => {
    const result = pointKernelNode.compile(
      compileContext({ nodeId: "sim", outputs: [], parameters: { attributes: attributesOf(9) } }),
    );
    expect(result.passes).toEqual([]);
    const message = errorsOf(result);
    expect(message).toContain("9 attributes need 18 storage bindings");
    expect(message).toContain("the baseline limit is 8");
    expect(message).toContain("at most 4 attributes");
  });

  it("refuses FIVE on the plain kernel — the case that used to fail silently (B33)", () => {
    // The plain kernel had NO budget check at all: five attributes built ten bindings and
    // the pipeline failed with nothing said. Four is the whole budget (§V588).
    expect(errorsOf(
      pointKernelNode.compile(
        compileContext({ nodeId: "sim", outputs: [], parameters: { attributes: attributesOf(5) } }),
      ),
    )).toContain("the baseline limit is 8");
    expect(errorsOf(
      pointKernelNode.compile(
        compileContext({ nodeId: "sim", outputs: [], parameters: { attributes: attributesOf(4) } }),
      ),
    )).toBe("");
  });

  it("refuses FOUR on the advanced kernel, whose injected flags word takes the fourth slot", () => {
    const message = errorsOf(
      pointKernelAdvancedNode.compile(
        compileContext({
          nodeId: "sim",
          outputs: [],
          parameters: {
            capacity: 256,
            attributes: JSON.stringify([
              { name: "position", type: "vec3f", semantic: "position", default: [0, 0, 0] },
              { name: "id", type: "u32", semantic: "id", default: [0] },
              { name: "a", type: "f32", default: [0] },
              { name: "b", type: "f32", default: [0] },
            ]),
          },
        }),
      ),
    );
    expect(message).toContain("the baseline limit is 8");
    expect(message).toContain("at most 3 attributes");
  });
});

describe("T900 — migration: parse the legacy slots forever, emit them never (§V813's shape)", () => {
  it("keeps a slot a shipped kernel READS", () => {
    const schema = pointKernelNode.parametersFor?.({ kernel: SLOT_KERNEL }) ?? {};
    expect(schema["value1"]).toBeDefined();
    expect(schema["value2"]).toBeUndefined();
  });

  it("keeps a slot a shipped DOCUMENT stores, even when nothing reads it any more", () => {
    // A schema entry that vanished is a stored value with nowhere to land — the loader
    // preserves it and the inspector would never show it again.
    const schema = pointKernelNode.parametersFor?.({ kernel: SLOT_KERNEL, value3: 0.5 }) ?? {};
    expect(schema["value3"]).toBeDefined();
    expect(schema["value3"]?.inactiveWhen?.({ kernel: SLOT_KERNEL, value3: 0.5 })).toContain(
      "does not read ctx.value3",
    );
  });

  it("emits NONE onto a fresh kernel — four numbered knobs are no longer the greeting", () => {
    const schema = pointKernelNode.parametersFor?.({}) ?? {};
    for (const key of ["value1", "value2", "value3", "value4"]) {
      expect(schema[key], key).toBeUndefined();
    }
    // The structural controls are all still there, or a fresh node would lose its home.
    for (const key of ["capacity", "seed", "attributes", "kernel", "group"]) {
      expect(schema[key], key).toBeDefined();
    }
  });

  it("still generates ctx.valueN for a kernel that reads it", () => {
    expect(kernelShader({ kernel: SLOT_KERNEL })).toContain("value1: f32,");
  });
});

/**
 * Frame-0 byte equality for every shipped kernel (§T900's gate).
 *
 * Captured at `d7d9e26`, the commit before this work: a digest per shipped loom over every
 * pass belonging to a `pointKernel` or `pointKernelAdvanced` node — shader text, bindings,
 * workgroups and uniform VALUES. 19 looms carry 41 kernels between them (T940 added dust,
 * T918 added
 * E13's wall-placing kernel). A single changed
 * character in any generated module moves a digest, which is the point: the reflection had to
 * arrive as a pure ADDITION, costing a kernel that declares no `struct Params` exactly nothing.
 *
 * Fix a failure by finding what the generated module gained; do NOT restamp a digest without
 * knowing which loom's picture moved.
 */
const FRAME_ZERO_DIGESTS: Readonly<Record<string, string>> = {
  "E9-Ember.loom.json": "f0a7e8f0752c7653",
  // T915 (static aim: value1 0.5 → 1) and T918 (the wall kernel) both changed E13's
  // resolved kernel state deliberately, then T920 rebuilt the optics kernel as a
  // marched BEAM (SDF bevel boundary, 9x61x3 slots) and T915b handed the aim to the
  // pointer exclusively (y angle / x walk, no authority blend); re-pinned at each.
  "E13-Prism.loom.json": "dd4803f6936180c9",
  "E16-Murmuration.loom.json": "74f35048da9b841e",
  "E20-Gooeyball.loom.json": "7d059f6ab538949e",
  "E25-Stage.loom.json": "8ef074cc584fae53",
  "E27-Relief.loom.json": "6868f37d1a076be9",
  "E28-Sundial.loom.json": "28de7e0352112df2",
  "E30-Nave.loom.json": "d7f747ddcd79b736",
  "E31-Corona.loom.json": "c05b011af924a64a",
  "E32-Pasture.loom.json": "002d6556e7b4ad55",
  "E33-Obol.loom.json": "14656c8f2ff68456",
  "E34-Lidar.loom.json": "f141b86c9c184175",
  "E35-Nova-Torus.loom.json": "baac3790d7cf1e5f",
  "E36-Facade.loom.json": "7eedb60eaa117c0c",
  "E37-Sirocco.loom.json": "2a0f435d5f185759",
  "E38-Sigil.loom.json": "d0abd8b6f76fe60f",
  "E41-Cinder.loom.json": "d2d99371b37df6dc",
  "E42-Current.loom.json": "ebbc42ae6a703f1c",
  "E45-Pulse.loom.json": "f53677b3d9af9290",
};

const POINT_KERNEL_TYPES = new Set(["pointKernel", "pointKernelAdvanced"]);

describe("T900 — every shipped kernel resolves byte-equal at frame 0", () => {
  const digests = new Map<string, string>();
  let kernelCount = 0;
  for (const file of listExamples()) {
    const result = runExample(file);
    const graph = result.document?.graph;
    if (graph === undefined) continue;
    const passes = (result.read?.passes ?? []).filter((pass) => {
      const nodeId = (pass as { nodeId?: string }).nodeId;
      return nodeId !== undefined && POINT_KERNEL_TYPES.has(graph.nodes[nodeId]?.type ?? "");
    });
    if (passes.length === 0) continue;
    kernelCount += Object.values(graph.nodes).filter((node) => POINT_KERNEL_TYPES.has(node.type)).length;
    digests.set(file.fileName, createHash("sha256").update(JSON.stringify(passes)).digest("hex").slice(0, 16));
  }

  it("covers exactly the looms that carry kernels — a shrinking gate is a passing gate", () => {
    expect([...digests.keys()].sort()).toEqual(Object.keys(FRAME_ZERO_DIGESTS).sort());
    expect(kernelCount).toBe(41);
  });

  it.each(Object.keys(FRAME_ZERO_DIGESTS))("%s is unchanged at frame 0", (fileName) => {
    expect(digests.get(fileName)).toBe(FRAME_ZERO_DIGESTS[fileName]);
  });
});
