import { describe, expect, it } from "vitest";

import { pointKernelAdvancedNode, liveCountBufferId } from "./point-kernel-advanced.ts";
import { renderPointsNode } from "./points.ts";
import { pointPairId } from "./points.ts";
import { compileContext } from "./test-support.ts";

/**
 * The advanced kernel at the fixture level (T322): pass order, the §V231 inversion,
 * the counted edge, and the indirect consumer. The kills-actually-compact half — on
 * VALUES, not buffer ids — lives in
 * `src/runtime/backend/vgpu/point-kernel-advanced.gpu.test.ts`.
 */

type PassShape = {
  id: string;
  buffers: Array<{ binding: string; resourceId: string; half?: string }>;
};

describe("pointKernelAdvanced — kill and compact (T322)", () => {
  it("emits kernel, tail clear, alive scan, scatter, spawn scan, copies, identity, finalize — in order", () => {
    const result = pointKernelAdvancedNode.compile(
      compileContext({ nodeId: "sim", outputs: [], parameters: { capacity: 1000 } }),
    );
    expect(result.diagnostics ?? []).toEqual([]);
    const ids = (result.passes as PassShape[]).map((pass) => pass.id.slice("sim:".length));
    expect(ids[0]).toBe("kernel");
    expect(ids[1]).toBe("clearDeadTail");
    expect(ids[2]).toBe("scanLocal");
    expect(ids[3]).toBe("scanBlocks");
    const scatters = ids.slice(4).filter((id) => id.startsWith("scatter:"));
    expect(scatters.length).toBeGreaterThan(0);
    // T323: the spawn tail, strictly after every survivor scatter.
    const tail = ids.slice(4 + scatters.length);
    expect(tail[0]).toBe("spawnScanLocal");
    expect(tail[1]).toBe("spawnScanBlocks");
    expect(tail.slice(2, -2).every((id) => id.startsWith("spawnCopy:"))).toBe(true);
    expect(tail[tail.length - 2]).toBe("spawnIdentity");
    expect(tail[tail.length - 1]).toBe("spawnFinalize");
  });

  it("scatter reads the write halves and lands in the READ halves (§V231's inversion)", () => {
    const result = pointKernelAdvancedNode.compile(
      compileContext({ nodeId: "sim", outputs: [], parameters: { capacity: 256 } }),
    );
    const scatters = (result.passes as PassShape[]).filter((pass) => pass.id.includes("scatter"));
    expect(scatters.length).toBeGreaterThan(0);
    for (const pass of scatters) {
      for (const binding of pass.buffers) {
        if (binding.binding.startsWith("in_")) expect(binding.half, binding.binding).toBe("write");
        if (binding.binding.startsWith("out_")) expect(binding.half, binding.binding).toBe("read");
      }
    }
    // And the pairs opt out of the compiler's swap: the data is already where next
    // frame reads it.
    for (const entry of result.scratch ?? []) {
      if (entry.kind === "bufferPair") expect(entry.swap, entry.key).toBe(false);
    }
  });

  it("publishes READ halves and the GPU-resident count — the payload, not a convention", () => {
    const result = pointKernelAdvancedNode.compile(
      compileContext({ nodeId: "sim", outputs: [], parameters: { capacity: 256 } }),
    );
    const out = result.pointsets?.["out"];
    expect(out?.count).toEqual({ buffer: liveCountBufferId("sim") });
    expect(out?.capacity).toBe(256);
    for (const [attribute, entry] of Object.entries(out?.pairs ?? {})) {
      expect(entry.half, attribute).toBe("read");
    }
    // The lifecycle flag is internal; the edge does not offer it as an attribute.
    expect(out?.pairs["alive"]).toBeUndefined();
  });

  it("refuses a schema that declares the injected alive flag", () => {
    const result = pointKernelAdvancedNode.compile(
      compileContext({
        nodeId: "sim",
        outputs: [],
        parameters: { attributes: '[{"name":"alive","type":"u32","default":[1]}]' },
      }),
    );
    expect(result.passes).toEqual([]);
    expect(result.diagnostics?.[0]?.code).toBe("node.points.attributes");
  });
});

describe("renderPoints on a counted edge (T322)", () => {
  it("converts the live count to draw arguments and draws indirect", () => {
    const result = renderPointsNode.compile(
      compileContext({
        nodeId: "draw",
        inputs: ["points"],
        sources: { points: "sim" },
        pointsets: {
          points: {
            pairs: { position: { pair: pointPairId("sim", "position"), half: "read" } },
            capacity: 256,
            topology: "points",
            count: { buffer: liveCountBufferId("sim") },
          },
        },
        parameters: { count: 100 },
      }),
    );
    expect(result.diagnostics ?? []).toEqual([]);
    const [args, draw] = result.passes as [
      PassShape & { uniforms: Record<string, number> },
      { instances: unknown; buffers: Array<{ binding: string; half?: string }> },
    ];
    expect(args.id).toBe("draw:drawArgs");
    expect(args.uniforms).toEqual({ vertexCount: 6, maxInstances: 100 });
    expect(draw.instances).toEqual({ indirect: pointPairId("draw", "drawArgs") });
    // The payload's half, not the old convention: a compacted producer says "read".
    expect(draw.buffers[0]?.half).toBe("read");
    expect(result.scratch).toEqual([
      { kind: "buffer", key: "drawArgs", stride: 4, capacity: 4, usage: "indirect" },
    ]);
  });
});

describe("spawn hook (T339)", () => {
  it("emits NO pass when empty — children stay copies at zero cost", () => {
    const bare = pointKernelAdvancedNode.compile(
      compileContext({ nodeId: "sim", outputs: [], parameters: { capacity: 256 } }),
    );
    const withEmpty = pointKernelAdvancedNode.compile(
      compileContext({ nodeId: "sim", outputs: [], parameters: { capacity: 256, spawn: "   " } }),
    );
    expect((withEmpty.passes as PassShape[]).map((pass) => pass.id)).toEqual(
      (bare.passes as PassShape[]).map((pass) => pass.id),
    );
    expect((bare.passes as PassShape[]).some((pass) => pass.id.includes("spawnHook"))).toBe(false);
  });

  it("appends the in-place pass LAST, bound to the read halves and the counts", () => {
    const result = pointKernelAdvancedNode.compile(
      compileContext({
        nodeId: "sim",
        outputs: [],
        parameters: {
          capacity: 256,
          spawn: "fn spawn(child: Point, ctx: PointCtx) -> Point { var q = child; return q; }",
        },
      }),
    );
    expect(result.diagnostics ?? []).toEqual([]);
    const passes = result.passes as PassShape[];
    const hook = passes[passes.length - 1];
    expect(hook?.id).toBe("sim:spawnHook");
    for (const binding of hook?.buffers ?? []) {
      if (binding.binding.startsWith("io_")) expect(binding.half, binding.binding).toBe("read");
    }
    // n+1 bindings — the whole reason the two-pass design fits where one pass cannot.
    expect(hook?.buffers.length).toBe(4); // position, velocity, id + counts
  });

  it("refuses a hook without the contract signature", () => {
    const result = pointKernelAdvancedNode.compile(
      compileContext({
        nodeId: "sim",
        outputs: [],
        parameters: { capacity: 256, spawn: "fn nope() -> f32 { return 1.0; }" },
      }),
    );
    expect(result.passes).toEqual([]);
    expect(result.diagnostics?.[0]?.code).toBe("node.points.spawn");
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════════════
 * B122/T604 — EVERY pass mirrors its own block, including the ones the catalogue never
 * compiles.
 * ═══════════════════════════════════════════════════════════════════════════════════
 *
 * `catalogue-chain.test.ts` already asserts this property for the whole registry, and it
 * is exact set-equality in BOTH directions: a record missing a member the shader declares
 * is a silent zero (§V182 — vgpu writes by reflected name, so an unreserved member reads
 * whatever it reads), and a record naming a member the shader does NOT declare is a value
 * bound to nothing.
 *
 * THE HOLE THIS FILLS, and it is structural rather than an oversight: that gate builds one
 * minimal graph per node type from DEFAULT parameters. `spawn` defaults to "", so the spawn
 * HOOK pass does not exist there and has never been policed by anything. It is the one pass
 * on this node whose block deliberately differs — §V507: the hook reports
 * `usesFirstRun: false` because a newborn on frame 900 is not a fresh buffer — so it is
 * exactly the pass a blanket "add firstRun to the frame uniforms" fix breaks, in the
 * direction the catalogue cannot see. Measured: that fix passes `catalogue-chain`,
 * `point-kernel-advanced.test.ts` and the Dawn suite, and fails only here.
 *
 * A pass that exists only under a non-default parameter needs a gate that sets one.
 */
describe("B122 — the plan reserves exactly what each generated block declares", () => {
  /** Member names of the uniform struct a pass binds. Mirrors catalogue-chain's reader. */
  const structMembers = (shader: string, binding: string): string[] => {
    const structName = new RegExp(`var<uniform>\\s+${binding}\\s*:\\s*(\\w+)\\s*;`).exec(shader)?.[1];
    if (structName === undefined) return [];
    const body = new RegExp(`struct\\s+${structName}\\s*\\{([^}]*)\\}`).exec(shader)?.[1];
    if (body === undefined) return [];
    return body
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "")
      .split(",")
      .map((entry) => entry.split(":")[0]?.trim() ?? "")
      .filter((name) => name.length > 0);
  };

  // A kernel that spawns and a hook that shapes the newborn — the configuration that
  // brings the spawn-hook pass into existence at all.
  const KERNEL = `fn process(p: Point, ctx: PointCtx) -> Point {
  var q = p;
  if (q.id == 0u) { q.spawnCount = 1u; return q; }
  q.position = q.position + vec3f(1.0, 0.0, 0.0);
  if (q.position.x > 10.0) { q.alive = 0u; }
  return q;
}`;
  const HOOK = `fn spawn(child: Point, ctx: PointCtx) -> Point {
  var q = child;
  q.position = vec3f(0.0, 0.0, 0.0);
  return q;
}`;

  type UniformPass = { id: string; kind: string; shader: string; uniformBinding?: string; uniforms?: Record<string, unknown> };
  const passes = (): UniformPass[] =>
    pointKernelAdvancedNode.compile(
      compileContext({ nodeId: "sim", outputs: [], parameters: { capacity: 128, kernel: KERNEL, spawn: HOOK } }),
    ).passes as unknown as UniformPass[];

  it("the fixture actually produces the passes it claims to police (§V461)", () => {
    // Without the hook parameter set there IS no spawn-hook pass, and this whole describe
    // would assert over a pass list that cannot fail the way it is meant to fail.
    const ids = passes().map((pass) => pass.id);
    expect(ids).toContain("sim:spawnHook");
    expect(ids).toContain("sim:clearDeadTail");
    expect(ids).toContain("sim:spawnFinalize");
  });

  it("every dispatch pass's record equals its block, member for member", () => {
    const drifted = passes()
      .filter((pass) => pass.kind === "dispatch" && pass.uniformBinding !== undefined && pass.uniforms !== undefined)
      .map((pass) => {
        const declared = structMembers(pass.shader, pass.uniformBinding as string).sort();
        const reserved = Object.keys(pass.uniforms ?? {}).sort();
        return { id: pass.id, declared, reserved };
      })
      .filter((entry) => entry.declared.join(",") !== entry.reserved.join(","));
    expect(
      drifted.map((entry) => `${entry.id}: declares [${entry.declared.join(", ")}] reserves [${entry.reserved.join(", ")}]`),
      "a generated pass's uniform record no longer matches its own block (§V182). Missing a " +
        "declared member is a silent zero; naming an undeclared one binds a value to nothing.",
    ).toEqual([]);
  });

  /**
   * The two halves of B122 named individually, so a failure says WHICH direction broke
   * rather than only that something did. `firstRun` is the member both guards read
   * (`lifecycle.ts` — the live-count guard and the newborn-id base), and the one the
   * lifecycle passes declared without reserving.
   */
  it("the lifecycle passes RESERVE firstRun — the name the backend fills per dispatch", () => {
    const byId = new Map(passes().map((pass) => [pass.id, pass]));
    for (const id of ["sim:clearDeadTail", "sim:spawnFinalize", "sim:spawnIdentity"]) {
      expect(Object.keys(byId.get(id)?.uniforms ?? {}), `${id} must reserve firstRun`).toContain("firstRun");
    }
  });

  it("the spawn HOOK does NOT reserve it — a newborn mid-simulation is not fresh (§V507)", () => {
    const hook = passes().find((pass) => pass.id === "sim:spawnHook");
    expect(Object.keys(hook?.uniforms ?? {})).not.toContain("firstRun");
    expect(structMembers(hook?.shader ?? "", "kernelFrame")).not.toContain("firstRun");
  });
});
