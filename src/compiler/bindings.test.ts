import { describe, expect, it } from "vitest";

import type { BackendCapabilities } from "../domain/types/backend.ts";
import type { NodeDefinition } from "../domain/types/node-definition.ts";
import type { PassDescriptor } from "../runtime/backend/plan.ts";
import { compileGraph } from "./compile.ts";
import { bindingOverflows, describeOverflow, limitFor } from "./bindings.ts";
import { scratchResourceId } from "./resources.ts";
import {
  createCompilerTestRegistry,
  testCapabilities,
  testGraph,
  testNode,
  testSettings,
} from "./test-support.ts";

/**
 * T328 / B33 — a plan the GPU will decline is refused before a GPU exists.
 *
 * Nine storage buffers against a limit of eight does not throw: pipeline creation fails,
 * every dispatch silently no-ops, and the plan compiles with zero diagnostics while
 * frames keep "rendering". T327 put a persistent error net under the runtime. This is the
 * half that covers what a net cannot — a headless render, CI, and the user whose device
 * is stricter than the author's, which is the case the author never reproduces.
 */

const rgba = { kind: "texture2d", sample: "float", channels: 4 } as const;

const dispatch = (id: string, buffers: number): PassDescriptor =>
  ({
    kind: "dispatch",
    id,
    shader: "// kernel",
    entryPoint: "main",
    workgroups: [1, 1, 1],
    buffers: Array.from({ length: buffers }, (_, index) => ({
      binding: `b${index}`,
      resourceId: `buf${index}`,
    })),
  }) as PassDescriptor;

const withLimits = (limits: Record<string, number>): Pick<BackendCapabilities, "limits"> => ({
  limits,
});

describe("counting a pass's bindings (T328)", () => {
  it("refuses nine storage buffers against a baseline of eight — the B33 shape", () => {
    const [overflow] = bindingOverflows([dispatch("k", 9)], withLimits({}));
    expect(overflow?.what).toBe("storage buffers");
    expect(overflow?.count).toBe(9);
    expect(overflow?.limit).toBe(8);
  });

  it("allows exactly the limit — the boundary is not off by one", () => {
    expect(bindingOverflows([dispatch("k", 8)], withLimits({}))).toEqual([]);
  });

  it("believes a device that reports MORE headroom than the floor (§V12)", () => {
    // Discovery is what §V12 asks for, and it cuts both ways: a device that says it can
    // take sixteen may take sixteen, and refusing anyway would be inventing a limit.
    const generous = withLimits({ maxStorageBuffersPerShaderStage: 16 });
    expect(bindingOverflows([dispatch("k", 9)], generous)).toEqual([]);
  });

  it("believes a device that reports LESS, which is the whole point", () => {
    // The author's machine allows eight and this one allows four. Nothing about the
    // document changed; the plan is simply not runnable here, and the runtime net that
    // would have caught it is on the author's machine, not this one.
    const strict = withLimits({ maxStorageBuffersPerShaderStage: 4 });
    const [overflow] = bindingOverflows([dispatch("k", 5)], strict);
    expect(overflow?.limit).toBe(4);
    expect(overflow?.discovered).toBe(true);
  });

  it("falls back to the floor for an unreported limit, rather than to no limit", () => {
    // A report that omits the key is the headless and CI case. Skipping the check there
    // would disable it in exactly the runs that have no GPU to complain later; §V12's
    // rule is that HEADROOM needs discovering, and the floor is what every conforming
    // device already guarantees.
    expect(limitFor(withLimits({}), "maxStorageBuffersPerShaderStage")).toEqual({
      limit: 8,
      discovered: false,
    });
    expect(limitFor(withLimits({ maxStorageBuffersPerShaderStage: 8 }), "maxStorageBuffersPerShaderStage"))
      .toEqual({ limit: 8, discovered: true });
  });

  it("covers the CLASS, not just the buffers that bit us", () => {
    // Every one of these limits has been in the capability report since T13 with no
    // reader. Sampled textures matter first — the variadic Composite folds N inputs into
    // one pass, so it is the node most likely to walk into one of these next.
    const effect = {
      kind: "effect",
      id: "over",
      shader: "// blend",
      target: "t",
      textures: Array.from({ length: 17 }, (_, index) => ({
        binding: `t${index}`,
        resourceId: `tex${index}`,
      })),
      samplers: Array.from({ length: 17 }, (_, index) => ({
        binding: `s${index}`,
        resourceId: "sampler",
      })),
    } as unknown as PassDescriptor;

    const kinds = bindingOverflows([effect], withLimits({})).map((overflow) => overflow.what);
    expect(kinds).toContain("sampled textures");
    expect(kinds).toContain("samplers");
  });

  it("ignores passes that bind nothing a shader stage sees", () => {
    const swap = { kind: "swap", id: "swap:x", resourceId: "x" } as PassDescriptor;
    const counter = { kind: "counter", id: "c", op: "reset", resourceId: "x" } as PassDescriptor;
    expect(bindingOverflows([swap, counter], withLimits({}))).toEqual([]);
  });

  it("states the budget where it is hit, so nobody goes counting (§V228)", () => {
    const [overflow] = bindingOverflows([dispatch("kernel:step", 9)], withLimits({}));
    if (overflow === undefined) throw new Error("expected an overflow");
    const message = describeOverflow(overflow);
    // The pass, the count, the limit and its NAME — the same shape the advanced kernel's
    // own producer-side refusal uses, which spells out 2·(n−1)+2 rather than "too many".
    expect(message).toContain('"kernel:step"');
    expect(message).toContain("9 storage buffers");
    expect(message).toContain("maxStorageBuffersPerShaderStage is 8");

    // ...and it says WHERE the number came from, because "the baseline says 8" and "your
    // device says 8" send the reader to different places.
    expect(message).toContain("did not report its own");
    const [reported] = bindingOverflows(
      [dispatch("kernel:step", 9)],
      withLimits({ maxStorageBuffersPerShaderStage: 8 }),
    );
    expect(describeOverflow(reported as never)).toContain("this device's");
  });
});

/**
 * T1076 — the SIZE row, which is a different row KIND rather than another count.
 *
 * Packing point attributes into one buffer per producer moved the ceiling: a kernel spends
 * a fixed handful of bindings whatever the schema's size, and what can go wrong instead is
 * the BYTES one of them carries. `maxStorageBufferBindingSize` is bytes-per-binding, not a
 * count per pass, so it could not be jammed into `count(pass)` — a pass binding one 200 MiB
 * region and three tiny ones has no meaningful "count" to compare.
 *
 * The schema-level refusal (`points/packing.ts`) speaks in attributes and capacity and
 * fires before a plan exists. THIS is the device-aware backstop, and the only one that
 * lowers when a real device reports less than the baseline.
 */
describe("T1076 — the per-binding SIZE budget", () => {
  const region = (id: string, bytes: number): PassDescriptor =>
    ({
      kind: "dispatch",
      id,
      shader: "// kernel",
      entryPoint: "main",
      workgroups: [1, 1, 1],
      buffers: [{ binding: "pk_0", resourceId: "points", offset: 0, bytes }],
    }) as PassDescriptor;

  it("refuses a region past the baseline 128 MiB, and states it in MiB", () => {
    const [overflow] = bindingOverflows([region("sim:kernel", 201_326_592)], withLimits({}));
    if (overflow === undefined) throw new Error("expected an overflow");
    expect(overflow.unit).toBe("bytes");
    expect(overflow.binding).toBe("pk_0");
    const message = describeOverflow(overflow);
    expect(message).toContain('"sim:kernel"');
    // Bytes, said in MiB: "binds 201326592; the limit is 134217728" is a number nobody
    // can hold, and the decision it feeds is "how many points fit".
    expect(message).toContain("192.0 MiB to storage buffer \"pk_0\"");
    expect(message).toContain("maxStorageBufferBindingSize is 128.0 MiB");
    expect(message).toContain("did not report its own");
  });

  it("allows exactly the limit — the boundary is not off by one", () => {
    expect(bindingOverflows([region("sim:kernel", 134_217_728)], withLimits({}))).toEqual([]);
  });

  it("measures EACH binding, so one huge region among small ones is still refused", () => {
    const mixed = {
      kind: "dispatch",
      id: "sim:kernel",
      shader: "// kernel",
      entryPoint: "main",
      workgroups: [1, 1, 1],
      buffers: [
        { binding: "pk_0", resourceId: "points", offset: 0, bytes: 1024 },
        { binding: "pk_1", resourceId: "points", offset: 1024, bytes: 268_435_456 },
      ],
    } as PassDescriptor;
    const overflows = bindingOverflows([mixed], withLimits({}));
    expect(overflows.map((entry) => entry.binding)).toEqual(["pk_1"]);
  });

  it("lowers on a device that reports LESS than the baseline (§V12's direction)", () => {
    const strict = withLimits({ maxStorageBufferBindingSize: 16_777_216 });
    const [overflow] = bindingOverflows([region("sim:kernel", 33_554_432)], strict);
    if (overflow === undefined) throw new Error("expected an overflow on the strict device");
    expect(describeOverflow(overflow)).toContain("this device's maxStorageBufferBindingSize is 16.0 MiB");
    // …and the SAME plan is clean against the baseline, which is what makes it a device
    // fact rather than a plan fact.
    expect(bindingOverflows([region("sim:kernel", 33_554_432)], withLimits({}))).toEqual([]);
  });

  it("says nothing about a plain whole-buffer binding, which declares no size", () => {
    // A binding with no `bytes` is not a region; its size lives in the resource table, and
    // reporting a guess here would be a guarantee this cannot make (the §V12 rule the
    // storage-texture row is left out for).
    expect(bindingOverflows([dispatch("effect:blur", 3)], withLimits({}))).toEqual([]);
  });
});

/** A node that binds `count` storage buffers — the B33 repro, as a node. */
function hungryNode(count: number): NodeDefinition {
  return {
    type: "fx.hungry",
    version: 1,
    title: "Hungry",
    category: "filter",
    inputs: [],
    outputs: [{ id: "out", label: "Out", type: rgba }],
    parameters: {},
    compile: (context) => {
      const nodeId = (context as { nodeId: string }).nodeId;
      const keys = Array.from({ length: count }, (_, index) => `b${index}`);
      return {
        scratch: keys.map((key) => ({ kind: "buffer" as const, key, stride: 4, capacity: 16 })),
        passes: [
          {
            kind: "dispatch",
            id: `${nodeId}:step`,
            nodeId,
            shader: "// kernel",
            entryPoint: "main",
            workgroups: [1, 1, 1] as const,
            buffers: keys.map((key) => ({
              binding: key,
              resourceId: scratchResourceId(nodeId, key),
            })),
          },
        ],
      };
    },
  };
}

function compileWithHungryNode(count: number, capabilities: BackendCapabilities) {
  const registry = createCompilerTestRegistry([hungryNode(count)]);
  const graph = testGraph([testNode("hungry", "fx.hungry")]);
  return compileGraph({
    graph,
    settings: testSettings(),
    registry: registry.view(),
    capabilities,
    sinks: [{ nodeId: "hungry", portId: "out", kind: "preview" }],
  });
}

describe("the compiler refuses an over-budget plan (T328, B33)", () => {
  it("errors on nine storage buffers, naming the node", () => {
    const compiled = compileWithHungryNode(9, testCapabilities());
    const overflow = compiled.diagnostics.find(
      (diagnostic) => diagnostic.code === "compiler/binding-budget",
    );
    expect(overflow?.severity).toBe("error");
    expect(overflow?.nodeId).toBe("hungry");
    expect(overflow?.message).toContain("9 storage buffers");
    // §V9's neighbour: an over-budget plan is not a plan. It must not reach the backend
    // reporting success, which is what "compiles clean and renders nothing" was.
    expect(compiled.ok).toBe(false);
  });

  it("compiles the same graph clean at eight — non-vacuity", () => {
    const compiled = compileWithHungryNode(8, testCapabilities());
    expect(
      compiled.diagnostics.filter((diagnostic) => diagnostic.code === "compiler/binding-budget"),
    ).toEqual([]);
    // And it genuinely compiles, so the contrast above is "the budget refused it" rather
    // than "this fixture never compiled either way".
    expect(compiled.ok).toBe(true);
  });

  it("refuses on a strict device what it accepts on a generous one", () => {
    // Same document, same build, two devices — and the only thing that decided it was the
    // capability report. This is the run the author never sees.
    const strict: BackendCapabilities = {
      ...testCapabilities(),
      limits: { maxTextureDimension2D: 8192, maxStorageBuffersPerShaderStage: 4 },
    };
    const generous: BackendCapabilities = {
      ...testCapabilities(),
      limits: { maxTextureDimension2D: 8192, maxStorageBuffersPerShaderStage: 32 },
    };
    expect(
      compileWithHungryNode(6, strict).diagnostics.some((d) => d.code === "compiler/binding-budget"),
    ).toBe(true);
    expect(
      compileWithHungryNode(6, generous).diagnostics.some((d) => d.code === "compiler/binding-budget"),
    ).toBe(false);
  });
});
