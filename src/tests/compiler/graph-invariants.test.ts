import { describe, expect, it } from "vitest";
import { compileGraph } from "../../compiler/compile.ts";
import { orderNodes } from "../../compiler/topology.ts";
import {
  createCompilerTestRegistry,
  testCapabilities,
  testEdge,
  testGraph,
  testNode,
  testSettings,
} from "../../compiler/test-support.ts";
import { arePortsCompatible, describePortType } from "../../domain/graph/port-compat.ts";
import type { GraphDocument } from "../../domain/types/graph.ts";
import type { PortType } from "../../domain/types/ports.ts";
import type { CompileEdge } from "../../compiler/types.ts";

/**
 * T45 gap-fill: graph-shape invariants the existing compiler suite does not reach.
 *
 * This file is deliberately NOT a second copy of `src/compiler/topology.test.ts`,
 * `prune.test.ts` or `port-compat.test.ts`. Everything here was chosen because the source
 * has a branch, a documented claim or an invariant clause that no existing assertion can
 * distinguish from its opposite. Where an existing test covers the same ground, the case
 * is left alone — a duplicated assertion buys nothing and doubles the cost of a rename.
 */

const settings = testSettings();
const capabilities = testCapabilities();
const registry = () => createCompilerTestRegistry().view();
const compile = (graph: GraphDocument) =>
  compileGraph({ graph, settings, registry: registry(), capabilities });

describe("§V4 — 'every path in the cycle crosses a temporal node'", () => {
  /**
   * THE case the invariant is actually about, and the one nothing tested.
   *
   * §V4 does not say "a cycle containing a temporal node is legal", it says every PATH
   * around the cycle must cross one. The existing suite only has the two all-or-nothing
   * shapes: a loop with no temporal edge (rejected) and a loop with one (accepted). Both
   * pass under the weaker reading.
   *
   * Here `blur -> feedback -> blur` is legal on its own, and then a same-frame chord
   * `feedback.source <- blur` is... the same edge. So the mixed shape needs three nodes:
   * a -> b -> c -> a where only c -> a is temporal, PLUS a same-frame shortcut c -> b that
   * closes a second loop (b -> c -> b) crossing no temporal output at all. That inner loop
   * is illegal and must be reported even though the outer one is fine.
   */
  it("rejects a same-frame sub-cycle inside an otherwise-legal temporal loop", () => {
    const graph = testGraph(
      [
        testNode("gen", "fx.generator"),
        testNode("a", "fx.composite"),
        testNode("fb", "fx.feedback"),
        testNode("out", "fx.output"),
      ],
      [
        testEdge("seed", ["gen", "out"], ["a", "layers"]),
        // Legal outer loop: a -> fb -> a, closed by fb's TEMPORAL output.
        testEdge("a-fb", ["a", "out"], ["fb", "source"]),
        testEdge("fb-a", ["fb", "out"], ["a", "layers"]),
        // Illegal inner loop: a -> b -> a, entirely same-frame.
        testEdge("a-b", ["a", "out"], ["out", "source"]),
        testEdge("b-a", ["out", "out"], ["a", "layers"]),
        testEdge("fb-out", ["fb", "out"], ["out", "source"]),
      ],
    );

    const plan = compile(graph);
    const cycleErrors = plan.diagnostics.filter(
      (diagnostic) => diagnostic.severity === "error" && diagnostic.code.includes("cycle"),
    );
    expect(cycleErrors.length).toBeGreaterThan(0);
    expect(plan.ok).toBe(false);
    // The same-frame participants must be named; naming only the temporal loop would be
    // a diagnostic pointing at the one part of the graph that is fine.
    expect(cycleErrors.map((d) => d.message).join(" ")).toMatch(/\ba\b/);
  });

  /**
   * A node feeding its own temporal input is the canonical one-node feedback loop, and it
   * is legal. `topology.ts` builds its self-loop set from CURRENT-FRAME edges only, which
   * is what makes this work — a claim that survives only as long as something checks it.
   */
  it("accepts a node wired to its own temporal output", () => {
    const graph = testGraph(
      [testNode("fb", "fx.feedback"), testNode("out", "fx.output")],
      [
        testEdge("self", ["fb", "out"], ["fb", "source"]),
        testEdge("present", ["fb", "out"], ["out", "source"]),
      ],
    );

    const plan = compile(graph);
    expect(plan.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(plan.ok).toBe(true);
    expect(plan.order).toContain("fb");
    expect(plan.feedback.map((pair) => pair.nodeId)).toContain("fb");
  });

  /**
   * Two independent illegal cycles produce two diagnostics, deterministically ordered.
   *
   * `topology.ts` states that its components are sorted and its groups ordered by first id
   * "so the diagnostics are stable". With only ever one cycle in the suite, that sort has
   * never been exercised — and an unstable diagnostic order makes the problems tab reshuffle
   * itself on every recompile.
   */
  it("reports each independent cycle once, in a stable order", () => {
    const nodes = new Set(["a", "b", "y", "z"]);
    const edges: CompileEdge[] = [
      { id: "ab", source: { nodeId: "a", portId: "out" }, target: { nodeId: "b", portId: "in" }, temporal: false },
      { id: "ba", source: { nodeId: "b", portId: "out" }, target: { nodeId: "a", portId: "in" }, temporal: false },
      { id: "yz", source: { nodeId: "y", portId: "out" }, target: { nodeId: "z", portId: "in" }, temporal: false },
      { id: "zy", source: { nodeId: "z", portId: "out" }, target: { nodeId: "y", portId: "in" }, temporal: false },
    ];

    const first = orderNodes(nodes, edges);
    const second = orderNodes(nodes, [...edges].reverse());

    expect(first.cycles).toHaveLength(2);
    expect(first.cycles).toEqual(second.cycles);
    expect(first.cycles[0]).toEqual(["a", "b"]);
    expect(first.cycles[1]).toEqual(["y", "z"]);
  });

  /**
   * The cycle-detection walk is written iteratively "so a deep graph cannot blow the JS
   * stack". That is a claim about behaviour at a size no test has ever tried; a recursive
   * rewrite would pass every existing assertion and then crash on a real project.
   *
   * 20k nodes rather than a token 100: the default V8 stack overflows somewhere around
   * 10k frames, so this actually straddles the boundary the comment is about.
   */
  it("orders a 20k-node chain without exhausting the stack", () => {
    const depth = 20_000;
    const nodes = new Set<string>();
    const edges: CompileEdge[] = [];
    for (let i = 0; i < depth; i += 1) {
      nodes.add(`n${i}`);
      if (i > 0) {
        edges.push({
          id: `e${i}`,
          source: { nodeId: `n${i - 1}`, portId: "out" },
          target: { nodeId: `n${i}`, portId: "in" },
          temporal: false,
        });
      }
    }

    const result = orderNodes(nodes, edges);
    expect(result.cycles).toEqual([]);
    expect(result.order).toHaveLength(depth);
    expect(result.order[0]).toBe("n0");
    expect(result.order.at(-1)).toBe(`n${depth - 1}`);
  });

  /** The degenerate input. Cheap, and the one shape a guard clause typically forgets. */
  it("handles an empty node set", () => {
    const result = orderNodes(new Set(), []);
    expect(result.order).toEqual([]);
    expect(result.cycles).toEqual([]);
    expect(result.currentFrameEdges).toEqual([]);
    expect(result.temporalEdges).toEqual([]);
    expect(result.diagnostics).toEqual([]);
  });
});

describe("topological order — shapes the chain tests cannot distinguish", () => {
  /**
   * The diamond: a -> b, a -> c, b -> d, c -> d.
   *
   * A chain test passes under any correct-ish traversal. A diamond is where a Kahn walk
   * with an unsorted ready set starts flapping between runs, because b and c become ready
   * simultaneously. The tie-break must be lexicographic and it must be the SAME every time.
   */
  it("orders a diamond deterministically, with both middles before the join", () => {
    const nodes = new Set(["a", "b", "c", "d"]);
    const edges: CompileEdge[] = [
      { id: "ab", source: { nodeId: "a", portId: "out" }, target: { nodeId: "b", portId: "in" }, temporal: false },
      { id: "ac", source: { nodeId: "a", portId: "out" }, target: { nodeId: "c", portId: "in" }, temporal: false },
      { id: "bd", source: { nodeId: "b", portId: "out" }, target: { nodeId: "d", portId: "in" }, temporal: false },
      { id: "cd", source: { nodeId: "c", portId: "out" }, target: { nodeId: "d", portId: "in" }, temporal: false },
    ];

    const forward = orderNodes(nodes, edges);
    const shuffled = orderNodes(new Set(["d", "c", "b", "a"]), [...edges].reverse());

    expect(forward.order).toEqual(["a", "b", "c", "d"]);
    expect(shuffled.order).toEqual(forward.order);
  });

  /**
   * Across disconnected components the rule is "smallest READY id first", not
   * "finish one component, then the next".
   *
   * The two are indistinguishable unless a component's later node sorts AFTER another
   * component's root, so the ids here are chosen to separate them: `a1 -> z2` and
   * `b1 -> b2`. Component-at-a-time would give a1, z2, b1, b2; the actual rule gives
   * a1, b1, b2, z2. Both are valid topological orders, which is exactly why the choice has
   * to be pinned — swapping between them silently reorders every pass in a branchy project
   * and turns a plan signature diff into noise.
   */
  it("takes the smallest READY id across disconnected components", () => {
    const nodes = new Set(["a1", "z2", "b1", "b2"]);
    const edges: CompileEdge[] = [
      { id: "a", source: { nodeId: "a1", portId: "out" }, target: { nodeId: "z2", portId: "in" }, temporal: false },
      { id: "b", source: { nodeId: "b1", portId: "out" }, target: { nodeId: "b2", portId: "in" }, temporal: false },
    ];
    expect(orderNodes(nodes, edges).order).toEqual(["a1", "b1", "b2", "z2"]);
    // And it does not depend on how the inputs were handed over.
    expect(orderNodes(new Set(["b2", "b1", "z2", "a1"]), [...edges].reverse()).order).toEqual([
      "a1",
      "b1",
      "b2",
      "z2",
    ]);
  });

  /**
   * An edge naming a node outside the kept set is ignored entirely — it must not leave a
   * phantom in-degree behind, or the node it points at never becomes ready and silently
   * vanishes from the plan. This is what makes prune-then-order safe as an ordering.
   */
  it("ignores an edge whose endpoint was pruned away", () => {
    const nodes = new Set(["kept"]);
    const edges: CompileEdge[] = [
      { id: "ghost", source: { nodeId: "gone", portId: "out" }, target: { nodeId: "kept", portId: "in" }, temporal: false },
    ];
    expect(orderNodes(nodes, edges).order).toEqual(["kept"]);
  });
});

describe("§V25 — pruning happens before ordering", () => {
  /**
   * A cycle among nodes no sink reaches must NOT be reported.
   *
   * "The compiler evaluates only nodes reachable backward from active sinks" has a second
   * half nobody states: it must not FAIL on dead code either. A disconnected experiment
   * left in a corner of the graph should not stop the project rendering.
   */
  it("does not report an illegal cycle that lives entirely in pruned nodes", () => {
    const graph = testGraph(
      [
        testNode("gen", "fx.generator"),
        testNode("out", "fx.output"),
        testNode("dead1", "fx.composite"),
        testNode("dead2", "fx.composite"),
      ],
      [
        testEdge("live", ["gen", "out"], ["out", "source"]),
        testEdge("d12", ["dead1", "out"], ["dead2", "layers"]),
        testEdge("d21", ["dead2", "out"], ["dead1", "layers"]),
      ],
    );

    const plan = compile(graph);
    expect(plan.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(plan.ok).toBe(true);
    expect([...plan.pruned].sort()).toEqual(["dead1", "dead2"]);
  });

  /** `pruned` is sorted. Only ever asserted with a single element until now. */
  it("reports pruned nodes in a stable sorted order", () => {
    const graph = testGraph(
      [
        testNode("gen", "fx.generator"),
        testNode("out", "fx.output"),
        testNode("zeta", "fx.generator"),
        testNode("alpha", "fx.generator"),
        testNode("mid", "fx.generator"),
      ],
      [testEdge("live", ["gen", "out"], ["out", "source"])],
    );
    expect(compile(graph).pruned).toEqual(["alpha", "mid", "zeta"]);
  });

  /**
   * One bad edge prunes a whole branch, and that is a bigger consequence than the
   * type-mismatch diagnostic on its own suggests.
   *
   * `pruneToActiveSinks` walks only edges that PASSED validation, so a §V13 rejection does
   * not merely flag the edge — everything upstream of it disappears from the plan too. A
   * user sees one red port and their entire chain stop rendering. Pinned here so the
   * double consequence is a decision rather than a surprise.
   */
  it("prunes the whole upstream branch behind a type-incompatible edge", () => {
    const graph = testGraph(
      [testNode("gen", "fx.generator"), testNode("mono", "fx.mono"), testNode("out", "fx.output")],
      [
        // rgba(4ch) -> mono(1ch): rejected by §V13.
        testEdge("bad", ["gen", "out"], ["mono", "source"]),
        testEdge("present", ["mono", "out"], ["out", "source"]),
      ],
    );

    const plan = compile(graph);
    expect(plan.diagnostics.some((d) => d.severity === "error")).toBe(true);
    expect(plan.pruned).toContain("gen");
    expect(plan.order).not.toContain("gen");
  });
});

describe("§V13 — port compatibility branches with no coverage", () => {
  const texture = (channels: 1 | 2 | 4): PortType => ({
    kind: "texture2d",
    sample: "float",
    channels,
  });

  /** Only 1 and 4 were ever tested; 2 is a real declaration in the union. */
  it("treats a 2-channel texture as its own type", () => {
    expect(arePortsCompatible(texture(2), texture(2))).toBe(true);
    expect(arePortsCompatible(texture(2), texture(4))).toBe(false);
    expect(arePortsCompatible(texture(2), texture(1))).toBe(false);
  });

  /**
   * `arePortsCompatible` is directional for pointsets alone: a producer carrying MORE
   * attributes than the consumer requires is accepted. Every caller passes
   * `(sourcePort.type, targetPort.type)` — reverse those arguments anywhere and only
   * pointset edges break, silently, and no existing test notices because every other
   * family is symmetric.
   */
  it("is asymmetric for pointset, which is what makes argument order load-bearing", () => {
    const rich: PortType = {
      kind: "pointset",
      requires: [
        { name: "position", type: "vec3f" },
        { name: "colour", type: "vec4f" },
      ],
    };
    const lean: PortType = { kind: "pointset", requires: [{ name: "position", type: "vec3f" }] };

    expect(arePortsCompatible(rich, lean)).toBe(true);
    expect(arePortsCompatible(lean, rich)).toBe(false);
  });

  /**
   * Diagnostic strings the user reads. Three of eight branches were covered; a family that
   * stringifies to `[object Object]` or to a bare kind makes "cannot connect X to Y"
   * useless exactly when someone needs it.
   */
  it("describes every port family distinguishably", () => {
    const described = [
      describePortType({ kind: "buffer", element: "Particle", access: "read" }),
      describePortType({ kind: "matrix", columns: 4, rows: 4 }),
      describePortType({ kind: "pointset", requires: [] }),
      describePortType({ kind: "pointset", requires: [{ name: "position", type: "vec3f" }], topology: "lines" }),
      describePortType({ kind: "material", model: "pbr" }),
      describePortType({ kind: "camera" }),
    ];

    for (const text of described) {
      expect(text).not.toContain("object Object");
      expect(text.trim()).not.toBe("");
    }
    expect(new Set(described).size).toBe(described.length);
  });

  /**
   * The exhaustive `default: return false`.
   *
   * Unreachable from typed callers, reachable from PARSED data — and there is live drift
   * that makes it so: `portTypeSchema` in `src/domain/types/schemas.ts` declares a
   * `{kind:"geometry"}` member the `PortType` union does not have. A document carrying one
   * must refuse to connect rather than fall through to `true`.
   */
  it("refuses a port kind it does not know rather than defaulting to compatible", () => {
    const unknown = { kind: "geometry", topology: "mesh" } as unknown as PortType;
    expect(arePortsCompatible(unknown, unknown)).toBe(false);
    expect(arePortsCompatible(unknown, { kind: "camera" })).toBe(false);
  });
});
