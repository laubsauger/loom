import { describe, expect, it } from "vitest";
import { listExamples } from "./catalogue.ts";
import { requireExample } from "./runner.ts";
import type { GraphDocument } from "../domain/types/graph.ts";

/**
 * ⚑ T1124 / §V903 — EVERY STEPPED-THEN-CLAMPED VALUE LANE DECLARES ITS DUTY CYCLE.
 *
 * THE DEFECT THIS EXISTS FOR, and it shipped in THREE lanes across TWO examples before
 * anybody printed the number: a `valueStep` draws uniformly on [minimum, maximum], the
 * chain multiplies and adds, and a `valueLimit` clamps. When the mapped draw range is
 * several times the clamp's width, the clamp stops being a limiter and becomes THE SIGNAL —
 * the value spends its life on one bound or the other and the envelope the author wrote
 * exists only in the parameters. E54's Coupling lane spanned 2.600 into a clamp 0.700 wide
 * and `clag1:bar` sat at EXACTLY 0.950000 from f989 to f2979; its disturbance lane spanned
 * 4.200 into a clamp 0.500 wide and was silent for 29 consecutive seconds. Both read from
 * outside as a step that never fires, and the owner reported them that way, correctly.
 *
 * WHY A DECLARATION AND NOT A FLOOR. A near-total clamp can be exactly right: E45 Pulse
 * reshapes its held 0..1 so the outer thirds land ON the poles, because a VJ set CUTS and
 * blends as the exception — 8.3 % interior is the authored behaviour there, and a universal
 * floor would condemn it. What cannot be right is nobody knowing the number. So this gate
 * asserts the DECLARED duty cycle against the one the parameters imply, and separately
 * asserts that every lane of this shape in the catalogue appears below — a new lane that
 * ships pinned fails for being undeclared, and a retune that silently changes an authored
 * duty cycle fails for disagreeing with its own row.
 *
 * (E45's own docblock still describes the earlier `x3, -1` reshape while the file ships
 * `x12, -5.5` — 33 % interior against the shipped 8.3 %. That comment is E45's to fix; the
 * row below records what the file ACTUALLY does, which is the point of the table.)
 *
 * WHAT IS ASSERTED IS SEED-FREE. `valueStep`'s draw is uniform over its declared interval,
 * so the interior fraction is exact arithmetic on the shipped parameters — no render, no
 * clock, no project seed. The LONGEST SILENT RUN, §V903's other half, is a property of the
 * particular seed sequence and belongs in each example's own claims file, where the seed is.
 */

/**
 * Fraction of a lane's draws that land STRICTLY INSIDE its clamp, to three places.
 * Keyed `<example file> <valueStep node id>`.
 */
const DECLARED_INTERIOR: Record<string, number> = {
  /* E45 (T828): the clamp IS the signal ON PURPOSE — the outer thirds of the phrase pick
     land on the poles so the set cuts hard, and a mid-range pick blends as the exception. */
  "E45-Pulse.loom.json step": 0.083,
  /* E54 Coupling (T1124): re-ranged from `x2.6 - 0.45` (26.9 % interior, 46.2 % pinned to
     the ceiling) to `x0.76 + 0.20`, so the phrase envelope is in the OUTPUT and not only in
     the parameters. The clamp still limits — it just no longer does the authoring. */
  "E54-Quorum.loom.json cstep": 0.921,
  /* E54 disturbance (T1124): re-ranged from [-3, 1.2] (11.9 % interior, 71.4 % clamped to
     silence) to [-0.45, 0.55]. The 45 % that still clamp to zero are the REST in rest-and-
     strike; what changed is that resting is now a designed minority rather than the lane's
     whole behaviour. */
  "E54-Quorum.loom.json dstep": 0.5,
};

const num = (value: unknown, fallback: number): number => (typeof value === "number" ? value : fallback);

interface Lane {
  readonly key: string;
  readonly interior: number;
  readonly detail: string;
}

/**
 * Every `valueStep` in `graph` whose output reaches a `valueLimit` through nothing but
 * multiply/add — the only chain over which the mapped draw interval stays exactly known.
 * Anything else (a curve, a second value input, a lag between) is skipped rather than
 * guessed at, so this gate never asserts about a distribution it cannot derive.
 */
function lanesOf(fileName: string, graph: GraphDocument): Lane[] {
  const out: Lane[] = [];
  for (const step of Object.values(graph.nodes)) {
    if (step.type !== "valueStep") continue;
    let mul = 1;
    let add = 0;
    let at = step.id;
    for (let hop = 0; hop < 8; hop += 1) {
      const edges = Object.values(graph.edges).filter((edge) => edge.source.nodeId === at);
      if (edges.length !== 1) break;
      const next = graph.nodes[edges[0]?.target.nodeId ?? ""];
      if (next === undefined) break;
      if (next.type === "valueMath") {
        const operation = next.parameters?.["operation"];
        const operand = num(next.parameters?.["operand"], 0);
        if (operation === "multiply") { mul *= operand; add *= operand; }
        else if (operation === "add") { add += operand; }
        else break;
        at = next.id;
        continue;
      }
      if (next.type !== "valueLimit") break;
      const low = num(next.parameters?.["minimum"], 0);
      const high = num(next.parameters?.["maximum"], 1);
      const mapped = [num(step.parameters?.["minimum"], 0) * mul + add, num(step.parameters?.["maximum"], 1) * mul + add];
      const a = Math.min(...mapped);
      const b = Math.max(...mapped);
      const span = b - a;
      const overlap = Math.max(0, Math.min(b, high) - Math.max(a, low));
      out.push({
        key: `${fileName} ${step.id}`,
        interior: span === 0 ? 1 : overlap / span,
        detail: `draws [${a.toFixed(3)}, ${b.toFixed(3)}] into clamp [${low}, ${high}] (${(span / (high - low)).toFixed(2)} clamp-widths)`,
      });
      break;
    }
  }
  return out;
}

const LANES: Lane[] = [];
for (const file of listExamples()) {
  const graph = (requireExample(file) as { document?: { graph?: GraphDocument } }).document?.graph;
  if (graph === undefined) continue;
  LANES.push(...lanesOf(file.fileName, graph));
}

describe("T1124/§V903 — a stepped-then-clamped lane declares how much of its clamp it occupies", () => {
  it("covers exactly the lanes of this shape in the catalogue — an undeclared one is a lane nobody measured", () => {
    expect(LANES.map((lane) => lane.key).sort()).toEqual(Object.keys(DECLARED_INTERIOR).sort());
  });

  it.each(LANES.map((lane) => [lane.key, lane] as const))(
    "%s occupies the interior it declares",
    (key, lane) => {
      const declared = DECLARED_INTERIOR[key];
      expect(declared, `${key} has no declared duty cycle`).toBeDefined();
      expect(
        Number(lane.interior.toFixed(3)),
        `${key} ${lane.detail}: ${(100 * lane.interior).toFixed(1)} % of its draws land inside the clamp, ` +
          `against the ${(100 * (declared ?? 0)).toFixed(1)} % this table declares. A clamp is not a limiter on a ` +
          `signal that rarely reaches it — when the draw range is several clamp-widths wide THE CLAMP IS THE ` +
          `SIGNAL and the envelope exists only in the parameters (§V903). Either the retune is wrong or the ` +
          `declaration is stale; decide which, and say the DUTY CYCLE rather than the range.`,
      ).toBe(declared);
    },
  );
});
