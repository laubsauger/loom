import { describe, expect, it } from "vitest";
import { sourceReferenceName } from "../../domain/graph/source-references.ts";
import type { GraphNode } from "../../domain/types/graph.ts";
import type { ParameterSlot } from "../../domain/types/parameters.ts";
import { example } from "./helpers.ts";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════
 * T729 — E40 WAKE: a file whose subject is CHANGE, claimed the way §V681 requires.
 * ═══════════════════════════════════════════════════════════════════════════════════
 *
 * Every property worth having here is a statement about the relationship BETWEEN frames —
 * that the difference is taken against a delayed frame, that only motion enters the loop,
 * that the grade happens after the accumulation. A single rendered frame is evidence about
 * a moment and not about a motion, so these are structural by necessity rather than by
 * preference.
 */
describe("E40 Wake claims", () => {
  const { document, plan } = example("E40-Wake.loom.json");
  const nodes = document.graph.nodes as Record<string, GraphNode>;
  const edges = Object.values(document.graph.edges);
  const into = (target: string, port: string): string | undefined =>
    edges.find((e) => e.target.nodeId === target && e.target.portId === port)?.source.nodeId;

  /**
   * THE claim of the example. `moved1` must difference the live frame against the CACHED
   * one; wire both inputs to the same source and it is identically zero everywhere, the
   * wake never appears, and nothing in a still frame distinguishes that from a quiet moment.
   */
  it("differences the live frame against a DELAYED one, not against itself", () => {
    expect(nodes["moved"]?.type).toBe("difference");
    expect(into("moved", "in1")).toBe("pick");
    expect(into("moved", "in2")).toBe("past");
    expect(nodes["past"]?.type).toBe("cache");
    expect(into("past", "input")).toBe("pick");
    // A ring of N holds N-1 readable frames; asking deeper is CLAMPED with a warning, and
    // the runner asserts zero diagnostics, so the tap has to fit the ring it was given.
    const frames = nodes["past"]?.parameters["frames"] as number;
    const index = nodes["past"]?.parameters["index"] as number;
    expect(index).toBeGreaterThan(1);
    expect(index).toBeLessThanOrEqual(frames - 1);
  });

  /**
   * Grading BEFORE the accumulator makes the loop sum coloured light: the head pins white
   * and the tail carries no hue. Grading after it makes the palette a map of trail AGE.
   * So the loop closes UPSTREAM of the Lookup, which inverts §V471.5 for E34's reason —
   * a loop closing on the finished frame would smear the still bed along with the wake.
   */
  it("accumulates raw motion and grades what comes OUT, so the palette axis is age", () => {
    expect(sourceReferenceName(nodes["loop"]?.type ?? "", nodes["loop"]?.parameters ?? {})).toBe("born1");
    expect(into("born", "in2")).toBe("loop");
    // born -> paint, and emphatically not paint -> born.
    expect(into("paint", "source")).toBe("born");
    expect(edges.some((e) => e.source.nodeId === "paint" && e.target.nodeId === "born")).toBe(false);
    // The graded result reaches the output; the loop's own contents never do directly.
    expect(into("lay", "in2")).toBe("paint");
    // The still bed is laid in BELOW the wake and is not inside the loop.
    expect(into("lay", "in1")).toBe("under");
    expect(into("under", "input")).toBe("pick");
  });

  /**
   * §V694 turned into something a gate can see, and §V666 is why it is stated this widely.
   *
   * The first version of this claim walked only the nodes FEEDING the accumulator, which is
   * where the compounding argument lives. It went red on `gain1` and stayed GREEN on
   * `under1` — the instance that actually mattered, because `under1` sits DOWNSTREAM of the
   * loop and feeds `lay1` directly, so its negative reached the finished frame while
   * `gain1`'s was contained by the Lookup's clamp-by-indexing. A guard that catches the
   * harmless case and misses the harmful one is worse than none, so the property is stated
   * where it is actually true: in a float working format, a positive black level is a
   * SUBTRACTION, and this graph adds things together. Range is bought with `whitelevel`,
   * `brightness` and `gamma1`, all of which are non-negative on non-negative input.
   *
   * A NEGATIVE black level is fine and stays legal — that is a lift, not a subtraction, and
   * E34's `poolbase` uses one deliberately.
   */
  it("buys range without a single subtractive offset, anywhere in the graph", () => {
    const offenders = Object.entries(nodes)
      .filter(([, node]) => node.type === "level")
      .map(([id, node]) => ({ id, black: node.parameters["blacklevel"] }))
      .filter((entry) => typeof entry.black === "number" && entry.black > 0)
      .map((entry) => `${entry.id} subtracts ${String(entry.black)}`);
    expect(offenders).toEqual([]);
    // And the loop's decay is persistence itself, which cannot go negative by construction.
    const persistence = nodes["loop"]?.parameters["persistence"] as ParameterSlot | undefined;
    expect(persistence?.mode).toBe("driven");
  });

  /**
   * §V687: an example whose subject is change has NO null state that looks like anything.
   * The performer's own motion is load-bearing — this file rendered PURE BLACK when its
   * noise was a `perlin3d`, because `speed` advances the FOURTH dimension and a 3D noise
   * has none (T518). And the subject must be a moving OBJECT with an almost-still bed
   * behind it, or the detector sees motion everywhere and nothing stands out.
   */
  it("gives the understudy real motion, from a dimension that exists", () => {
    expect(nodes["bed"]?.parameters["type"]).toBe("perlin4d");
    expect(nodes["bed"]?.parameters["speed"] as number).toBeGreaterThan(0);
    // The subject moves on two free-running LFOs; the bed only simmers.
    const orb = nodes["orb"]?.parameters ?? {};
    for (const key of ["center.x", "center.y"]) {
      const slot = orb[key] as ParameterSlot | undefined;
      expect(slot?.mode, `orb1.${key} must be driven`).toBe("driven");
    }
    expect(nodes["bed"]?.parameters["speed"] as number).toBeLessThan(
      (nodes["pathx"]?.parameters["frequency"] as number) ?? 0,
    );
    expect(plan.passes.some((pass) => "nodeId" in pass && pass.nodeId === "clip")).toBe(true);
  });
});
