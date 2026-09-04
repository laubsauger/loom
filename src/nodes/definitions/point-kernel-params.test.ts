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

/**
 * §V588's budget after T1076 — the limit moved from a COUNT to a SIZE.
 *
 * It used to be nine attributes refused because 2n bindings exceeded the baseline 8 per
 * stage; the ceiling was four (B33's silent pipeline failure was the fifth). Packing made
 * the binding count independent of n, so the refusals below are the NEW bound: bytes in
 * one storage binding, against the baseline `maxStorageBufferBindingSize` of 128 MiB.
 *
 * Both halves are asserted, and the first is the whole ticket: nine attributes now COMPILE.
 */
describe("T1076 — §V588's budget is a SIZE now, and it is still LOUD", () => {
  it("compiles NINE attributes — the count ceiling is gone, and it costs two bindings", () => {
    const result = pointKernelNode.compile(
      compileContext({ nodeId: "sim", outputs: [], parameters: { attributes: attributesOf(9) } }),
    );
    expect(errorsOf(result)).toBe("");
    const pass = result.passes[0] as { buffers: ReadonlyArray<{ half?: string }> };
    // Its own read half and its own write half. Eighteen bindings, before.
    expect(pass.buffers.map((binding) => binding.half)).toEqual(["read", "write"]);
  });

  it("refuses a schema that does not FIT one storage binding, in MiB and in points", () => {
    /* 30 × vec4f = 480 bytes per point; at a million points that is 457.8 MiB per half
       against the baseline's 128, so the refusal has to say both the size and the
       capacity that would fit — "too many attributes" would be false as well as useless. */
    const wide = JSON.stringify([
      { name: "position", type: "vec3f", semantic: "position", default: [0, 0, 0] },
      ...Array.from({ length: 29 }, (_unused, index) => ({
        name: `wide${index}`,
        type: "vec4f",
        default: [0, 0, 0, 0],
      })),
    ]);
    const message = errorsOf(
      pointKernelNode.compile(
        compileContext({ nodeId: "sim", outputs: [], parameters: { attributes: wide, capacity: 1_000_000 } }),
      ),
    );
    expect(message).toContain("30 attributes at capacity 1000000");
    expect(message).toContain("maxStorageBufferBindingSize");
    expect(message).toContain("128.0 MiB");
    // The actionable half: how many points this schema DOES fit (464 B/point → 289 262).
    expect(message).toContain("bytes per point");
    expect(message).toContain("points — lower the capacity");
  });

  it("the SAME schema fits at a capacity that keeps every region inside one binding", () => {
    const wide = JSON.stringify([
      { name: "position", type: "vec3f", semantic: "position", default: [0, 0, 0] },
      ...Array.from({ length: 29 }, (_unused, index) => ({
        name: `wide${index}`,
        type: "vec4f",
        default: [0, 0, 0, 0],
      })),
    ]);
    expect(
      errorsOf(
        pointKernelNode.compile(
          compileContext({ nodeId: "sim", outputs: [], parameters: { attributes: wide, capacity: 200_000 } }),
        ),
      ),
    ).toBe("");
  });

  it("the advanced kernel fits far past its old three-attribute ceiling", () => {
    /* Three plus the injected flags word was the whole budget. The lifecycle passes are a
       fixed list now, so what decides is the same size bound as above. */
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
              { name: "c", type: "vec4f", default: [0, 0, 0, 0] },
              { name: "d", type: "vec3f", default: [0, 0, 0] },
            ]),
          },
        }),
      ),
    );
    expect(message).toBe("");
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
 * workgroups and uniform VALUES. 22 looms carry 44 kernels between them (T940 added dust,
 * T918 added E13's wall-placing kernel, T1070 added E54's Laplacian). A single changed
 * character in any generated module moves a digest, which is the point: the reflection had to
 * arrive as a pure ADDITION, costing a kernel that declares no `struct Params` exactly nothing.
 *
 * T1070 leaned on that hard and it held: `pointAt` is emitted only for a kernel that names it,
 * so the 18 entries captured at `d7d9e26` still match to the character with the neighbour read
 * in the generator. That is §V309 checked across 41 shipped kernels rather than asserted.
 *
 * Fix a failure by finding what the generated module gained; do NOT restamp a digest without
 * knowing which loom's picture moved.
 *
 * ⚑ FULLY RE-STAMPED AT T1076, and this is the one change that legitimately moves EVERY row
 * at once. Packing rewrote the storage half of every generated module — `in_position[i]`
 * became `pointLoad_position(i)` over one `array<u32>` binding per producer instead of one
 * per attribute — so no kernel's text survives and no digest could. What the digests are
 * still worth is what they were worth before: from here on, one changed character in one
 * loom moves one row. The pictures are held by the examples' own claims (56 GPU tests, all
 * green across this change), never by these numbers.
 */
const FRAME_ZERO_DIGESTS: Readonly<Record<string, string>> = {
  "E9-Ember.loom.json": "a2450efd16233b11",
  // T915 (static aim: value1 0.5 → 1) and T918 (the wall kernel) both changed E13's
  // resolved kernel state deliberately, then T920 rebuilt the optics kernel as a
  // marched BEAM (SDF bevel boundary, 9x61x3 slots) and T915b handed the aim to the
  // pointer exclusively (y angle / x walk, no authority blend); re-pinned at each.
  "E13-Prism.loom.json": "bc12d57b3409041f",
  "E16-Murmuration.loom.json": "2b02e7a2f6ae8dc8",
  "E20-Gooeyball.loom.json": "ae38e4e6b4c4a6be",
  "E25-Stage.loom.json": "39f2763f1195dd59",
  "E27-Relief.loom.json": "670d97efe970595c",
  "E28-Sundial.loom.json": "fd30a6a5d8a12088",
  "E30-Nave.loom.json": "79f18c0c294ff3c0",
  "E31-Corona.loom.json": "cdf805800334b838",
  "E32-Pasture.loom.json": "925da38ae3402e98",
  "E33-Obol.loom.json": "68029203112b3bbc",
  /* T1053 re-pinned this one, and the module's gain is enumerable: `aim1`, `sight1`,
     `mark1` and `mark2a` each grew a `struct Params` and its uniform members, and twelve
     literals became `ctx.params.<name>` reads. NO PICTURE MOVED — every promoted uniform
     carries the exact f32 the literal it replaced was, checked pass by pass against the
     HEAD file, and E34's other four kernels (unfold1, raise1, pool1, ricochet1) are
     byte-identical because nothing in them was artistic direction. */
  "E34-Lidar.loom.json": "2cd2ebeb02adecc6",
  "E35-Nova-Torus.loom.json": "738e4e77f2cf31d4",
  "E36-Facade.loom.json": "019eaf2401006054",
  "E37-Sirocco.loom.json": "2087d8858acc22c2",
  "E38-Sigil.loom.json": "e492f427a3823580",
  "E41-Cinder.loom.json": "aaf02cf8945776b3",
  "E42-Current.loom.json": "86e6d8f32668e072",
  "E45-Pulse.loom.json": "b28aa4050cc9445e",
  /*
   * ⚠ THREE ENTRIES CAPTURED LATER THAN THE REST, AND SAID SO RATHER THAN BLENDED IN.
   *
   * E49 and E50 shipped kernels and their authors never extended this table, so BOTH
   * assertions above have been failing for everyone since — the coverage list and the
   * `kernelCount` total (41 → 44). §B150's shape exactly: a gate red for every worker is
   * nobody's. Their digests are therefore NOT the `d7d9e26` baseline the others are; they
   * are what those two looms resolve to TODAY, stamped by T1070's author as the price of
   * landing on a green tree. If either picture drifted between shipping and now, this table
   * cannot tell you — the two examples' own claims can.
   *
   * E54's is a genuine first capture, which is what a new example's entry always is.
   */
  "E49-Lissajous.loom.json": "a81e0294e38b699b",
  "E50-Galvo.loom.json": "c0dbaf5a20363773",
  /* RE-STAMPED at c4e7483 (T1074), which put a Courant bound on the layout step: `push` is a
     raw sum over in-range pairs with a 1/r² singularity, so an unclamped step had a fixed
     point only up to Coupling ≈ 0.3 while the document rests at 0.449 and strikes to 0.95.
     That commit changed the kernel and did not re-stamp here, so this row was red on every
     tree from c4e7483 until now — §B150's shape a second time, in the same table that
     already records it. The example's own claims (`quorum-claims.gpu.test.ts`, 9 of them)
     and the §V885 look baseline both stayed green across that change and are what say the
     picture is intact; this digest only ever said "frame 0 is what it was".

     RE-STAMPED AGAIN (T1124/§V903), and the reason is a RESOLVED UNIFORM, not a kernel edit:
     E54's two drive lanes were stepped-then-clamped with draw ranges several times their
     clamp widths, so `clag1:bar` sat at exactly 0.950000 from f989 to f2979 and `dlim1`
     clamped 71 % of the disturbance's draws to zero. Re-ranging them (`cmul1` 2.6 → 0.76,
     `csub1` −0.45 → +0.20, `cstep1` seed 11 → 330, `dstep1` [−3, 1.2] → [−0.45, 0.55])
     changes the value `coupling` resolves to AT FRAME 0 — 0.449 → 0.867 — and this digest
     hashes the resolved passes, so it moves by construction. The kernel WGSL is byte-identical
     across the change; what moved is one number in the uniform block. Green in the same
     commit: the nine `quorum-claims.gpu.test.ts` claims, `channel-integrity`, `sync`,
     `doc-drift`, and the §V885 look row (re-measured in that commit, motion 0.03393 → 0.02956
     — see the commit message; that window is 2 seconds inside the FIRST phrase and the same
     file measured over the whole minute moves +16.5 %). */
  "E54-Quorum.loom.json": "700f1821ebfc353a",
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
    expect(kernelCount).toBe(44);
  });

  it.each(Object.keys(FRAME_ZERO_DIGESTS))("%s is unchanged at frame 0", (fileName) => {
    expect(digests.get(fileName)).toBe(FRAME_ZERO_DIGESTS[fileName]);
  });
});
