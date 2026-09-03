import { describe, expect, it } from "vitest";

import type { FrameEvaluationInput } from "../../domain/types/frame.ts";
import type { GraphDocument } from "../../domain/types/graph.ts";
import type { ValueChannels } from "../../domain/types/node-definition.ts";
import { createValueGraphSession } from "../../domain/channels/value-graph.ts";
import { createNodeRegistry } from "../registry/registry.ts";
import { allNodeDefinitions } from "./index.ts";
import { valueMathNode } from "./value-graph-nodes.ts";

/**
 * T991 — Math's RANGE operation: re-mapping a span, per channel.
 *
 * Every assertion here is an EXACT bag, never a tolerance band and never "it changed":
 * a re-range is an affine map with a closed form, so the right answer is computable and
 * anything softer would pass on a map that is merely monotonic. The numbers are chosen
 * to be exact in binary floating point (quarters, halves, integers) so `toEqual` is
 * honest rather than lucky.
 *
 * Driven through the REAL `createValueGraphSession` rather than by calling
 * `valueEvaluate` by hand — the per-channel bag is assembled by the session, so a hand
 * call could not see whether a whole bag really re-ranges at once.
 */

const registry = createNodeRegistry(allNodeDefinitions).view();

const FRAME: FrameEvaluationInput = {
  timeSeconds: 0,
  deltaSeconds: 1 / 60,
  frameIndex: 0,
  mode: "realtime",
  randomSeed: 7,
};

/** `source → math`, with `math`'s parameters supplied verbatim. */
function chain(
  source: { type: string; parameters?: Record<string, unknown> },
  math: Record<string, unknown>,
  extraEdges: Record<string, unknown> = {},
  extraNodes: Record<string, unknown> = {},
): GraphDocument {
  return {
    revision: 1,
    groups: {},
    nodes: {
      src: {
        id: "src",
        type: source.type,
        definitionVersion: 1,
        position: { x: 0, y: 0 },
        label: "src1",
        parameters: source.parameters ?? {},
      },
      math: {
        id: "math",
        type: "valueMath",
        definitionVersion: 1,
        position: { x: 0, y: 0 },
        label: "math1",
        parameters: math,
      },
      ...extraNodes,
    },
    edges: {
      e0: { id: "e0", source: { nodeId: "src", portId: "out" }, target: { nodeId: "math", portId: "a" } },
      ...extraEdges,
    },
  } as unknown as GraphDocument;
}

function bagOf(graph: GraphDocument, pointer?: { x: number; y: number; buttons: number }): ValueChannels {
  const session = createValueGraphSession(registry);
  const result = session.evaluate(graph, FRAME, pointer === undefined ? undefined : { pointer });
  expect(result.diagnostics).toEqual([]);
  const bag = result.byName.get("math1");
  expect(bag).toBeDefined();
  return bag as ValueChannels;
}

/** One constant, re-ranged. The bag is `{ value }`, so the number is the whole answer. */
function ranged(input: number, bounds: Record<string, unknown>): number {
  const bag = bagOf(chain({ type: "constant", parameters: { value: input } }, { operation: "range", ...bounds }));
  const value = bag["value"];
  expect(typeof value).toBe("number");
  return value as number;
}

describe("T991 — Range re-maps a whole BAG, one channel at a time", () => {
  /**
   * §T982's point, asserted rather than assumed: a value input carries a bag, so the
   * three channels of a Mouse re-range together with nothing configured per channel.
   * Mouse is used because its three numbers arrive from the caller, so the expected bag
   * is arithmetic on known inputs rather than on whatever a source happened to produce.
   */
  it("re-ranges every channel of the bag through the same map", () => {
    const bag = bagOf(
      chain(
        { type: "mouse" },
        { operation: "range", fromLow: 0, fromHigh: 1, toLow: -1, toHigh: 1 },
      ),
      { x: 0.25, y: 0.75, buttons: 1 },
    );
    // 0..1 → -1..1 is `2x - 1`, applied to x, y AND buttons: the map does not know or
    // care what a channel means, which is what makes one node enough for a whole bag.
    expect(bag).toEqual({ x: -0.5, y: 0.5, buttons: 1 });
  });

  it("leaves the input untouched when the two spans are equal", () => {
    expect(ranged(0.4, { fromLow: 0, fromHigh: 1, toLow: 0, toHigh: 1 })).toBe(0.4);
  });

  /**
   * The B input is the OTHER operations' operand, and Range does not read it. Asserted
   * because the failure would be silent and plausible: a Range that still folded B in
   * would look right for every graph where B happens to be unwired.
   */
  it("ignores the B input, which belongs to the arithmetic operations", () => {
    const withB = chain(
      { type: "constant", parameters: { value: 0.25 } },
      { operation: "range", fromLow: 0, fromHigh: 1, toLow: 0, toHigh: 100 },
      { e1: { id: "e1", source: { nodeId: "other", portId: "out" }, target: { nodeId: "math", portId: "b" } } },
      {
        other: {
          id: "other",
          type: "constant",
          definitionVersion: 1,
          position: { x: 0, y: 0 },
          label: "other1",
          parameters: { value: 999 },
        },
      },
    );
    expect(bagOf(withB)).toEqual({ value: 25 });
  });
});

/**
 * OUTSIDE THE INPUT RANGE — the case the node exists to make a decision about.
 *
 * A MIDI CC calibrated over 0..1 and then pushed to 2 is not a hypothetical; it is the
 * first thing that happens. Clamp and Extrapolate both give a defensible answer and
 * they disagree by a factor of two here, so the tests pin WHICH, in both directions.
 */
describe("T991 — outside the input range is a stated choice, not a guess", () => {
  it("EXTRAPOLATES by default, carrying the value on past the output range", () => {
    // No `outside` stored at all: the default is what an untouched node does.
    expect(ranged(2, { fromLow: 0, fromHigh: 1, toLow: 0, toHigh: 10 })).toBe(20);
    expect(ranged(-1, { fromLow: 0, fromHigh: 1, toLow: 0, toHigh: 10 })).toBe(-10);
  });

  it("pins to the output range when Clamp is chosen", () => {
    expect(ranged(2, { fromLow: 0, fromHigh: 1, toLow: 0, toHigh: 10, outside: "clamp" })).toBe(10);
    expect(ranged(-1, { fromLow: 0, fromHigh: 1, toLow: 0, toHigh: 10, outside: "clamp" })).toBe(0);
  });

  /**
   * The case the clamp could wrongly swallow: a value INSIDE the range must come out of
   * both settings identically. A clamp implemented on the output rather than on the
   * position, or one that clamped before mapping, would still pass the two tests above.
   */
  it("leaves an in-range value alone under Clamp, exactly as Extrapolate does", () => {
    const bounds = { fromLow: 0, fromHigh: 1, toLow: 0, toHigh: 10 };
    expect(ranged(0.4, { ...bounds, outside: "clamp" })).toBe(4);
    expect(ranged(0.4, bounds)).toBe(4);
  });

  /**
   * An INVERTED input range is how a reversal is written, and it is the reason the clamp
   * is applied to the 0..1 position rather than to the output: with `From Low` above
   * `From High` there is no "which end is the maximum" question left to get wrong.
   */
  it("reverses through an inverted input range, and clamps at the right end", () => {
    expect(ranged(0.25, { fromLow: 1, fromHigh: 0, toLow: 0, toHigh: 1 })).toBe(0.75);
    expect(ranged(1.5, { fromLow: 1, fromHigh: 0, toLow: 0, toHigh: 1, outside: "clamp" })).toBe(0);
    expect(ranged(1.5, { fromLow: 1, fromHigh: 0, toLow: 0, toHigh: 1 })).toBe(-0.5);
  });

  /**
   * An inverted OUTPUT range is the assertion that tells position-clamping from
   * output-clamping apart, and nothing above does: with `To Low` BELOW `To High` the two
   * implementations agree on every input, so a clamp written on the output would have
   * passed every other test in this file. Under-range must reach `To Low` — the end
   * `From Low` maps to — whichever of the two output numbers is numerically larger.
   */
  it("clamps to the end that From Low names, even when the output range is inverted", () => {
    const reversal = { fromLow: 0, fromHigh: 1, toLow: 1, toHigh: 0 };
    expect(ranged(0.25, reversal)).toBe(0.75);
    expect(ranged(-1, { ...reversal, outside: "clamp" })).toBe(1);
    expect(ranged(2, { ...reversal, outside: "clamp" })).toBe(0);
  });
});

/**
 * A DEGENERATE INPUT SPAN — `From Low == From High`, which is a divide by zero.
 *
 * It is a real input twice over: it is what an un-calibrated pair looks like before
 * anyone touches it, and it is a value `From High` passes THROUGH while being dragged
 * from 1 to 0. So the answer has to be a number, and the same number for every input,
 * because a zero-width input span genuinely distinguishes nothing.
 */
describe("T991 — a degenerate input range answers To Low, never Infinity", () => {
  it("maps every input to To Low, on both sides of the collapsed bound", () => {
    const bounds = { fromLow: 0.5, fromHigh: 0.5, toLow: 3, toHigh: 9 };
    expect(ranged(0.1, bounds)).toBe(3);
    expect(ranged(0.5, bounds)).toBe(3);
    expect(ranged(2, bounds)).toBe(3);
  });

  it("stays finite, so nothing downstream is handed a NaN or an Infinity", () => {
    const bag = bagOf(
      chain({ type: "mouse" }, { operation: "range", fromLow: 1, fromHigh: 1, toLow: 0, toHigh: 1 }),
      { x: 0.25, y: 0.75, buttons: 1 },
    );
    expect(bag).toEqual({ x: 0, y: 0, buttons: 0 });
    for (const value of Object.values(bag)) expect(Number.isFinite(value)).toBe(true);
  });

  it("does not silently pass the input through, which would look like a working wire", () => {
    expect(ranged(0.7, { fromLow: 0.5, fromHigh: 0.5, toLow: 0, toHigh: 1 })).not.toBe(0.7);
  });

  it("obeys the choice of clamp too — the degenerate answer is the same either way", () => {
    const bounds = { fromLow: 0.5, fromHigh: 0.5, toLow: 3, toHigh: 9, outside: "clamp" };
    expect(ranged(2, bounds)).toBe(3);
  });
});

/**
 * §V831 — ADDING an option and ADDING parameters is safe; the moment a DEFAULT moves,
 * every stored document silently means something else. Examples store `valueMath` as
 * `{ operation, operand }` and nothing more, so the six original operations and the
 * `add` default are load-bearing bytes.
 */
describe("§V831 — an existing valueMath document is untouched", () => {
  it("keeps `add` as the default operation and the six originals in order", () => {
    const operation = valueMathNode.parameters["operation"];
    expect(operation?.type).toBe("enum");
    if (operation?.type !== "enum") throw new Error("unreachable — the assertion above");
    expect(operation.default).toBe("add");
    expect(operation.options.map((option) => option.value)).toEqual([
      "add",
      "subtract",
      "multiply",
      "divide",
      "minimum",
      "maximum",
      "range",
    ]);
  });

  it("resolves a stored `multiply` exactly as it did before Range existed", () => {
    const bag = bagOf(chain({ type: "mouse" }, { operation: "multiply", operand: 2 }), {
      x: 0.25,
      y: 0.75,
      buttons: 1,
    });
    expect(bag).toEqual({ x: 0.5, y: 1.5, buttons: 2 });
  });
});

/**
 * §V146 — the bounds are live controls in one operation out of seven, and the operand is
 * dead in exactly one. Both directions are asserted: a predicate that always dimmed, or
 * one that never did, is the same class of lie.
 */
describe("§V146 — the panel says which half of Math is doing the work", () => {
  it("dims the range bounds for an arithmetic operation, and not for Range", () => {
    for (const key of ["fromLow", "fromHigh", "toLow", "toHigh", "outside"]) {
      const definition = valueMathNode.parameters[key];
      expect(definition, key).toBeDefined();
      expect(definition?.inactiveWhen?.({ operation: "add" }), key).toBeTruthy();
      expect(definition?.inactiveWhen?.({ operation: "range" }), key).toBeNull();
    }
  });

  it("dims the operand for Range, and not for an arithmetic operation", () => {
    const operand = valueMathNode.parameters["operand"];
    expect(operand?.inactiveWhen?.({ operation: "range" })).toBeTruthy();
    expect(operand?.inactiveWhen?.({ operation: "multiply" })).toBeNull();
  });
});
