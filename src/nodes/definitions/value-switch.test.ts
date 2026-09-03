import { describe, expect, it } from "vitest";

import type { FrameEvaluationInput } from "../../domain/types/frame.ts";
import type { GraphDocument } from "../../domain/types/graph.ts";
import { createValueGraphSession } from "../../domain/channels/value-graph.ts";
import { createNodeRegistry } from "../registry/registry.ts";
import { allNodeDefinitions } from "./index.ts";
import { valueSwitchNode } from "./value-graph-nodes.ts";

/**
 * T508 — Switch (CHOP): EXCLUSIVE, and asserted as exact equality rather than as change.
 *
 * The bug this node exists to make unreachable (§V457) is a SILENT CLOBBER, not a wrong
 * number: two value sources on one port merge `{...prior, ...next}` over sorted edge ids,
 * so the later one's channels win outright and the earlier source disappears with no
 * diagnostic. A test that asserted "the output changed when I flipped the index" passes on
 * a clobber, on a blend, and on a switch alike. So every assertion below is an exact bag
 * comparison — the selected source's channels, ALL of them, and NOTHING of the other's.
 *
 * Driven through the real `createValueGraphSession` rather than by calling `valueEvaluate`
 * by hand: the merge lives in the session, so a hand call cannot see whether the node
 * actually escapes it.
 */

const registry = createNodeRegistry(allNodeDefinitions).view();

const frameAt = (timeSeconds: number): FrameEvaluationInput => ({
  timeSeconds,
  deltaSeconds: 1 / 60,
  frameIndex: Math.round(timeSeconds * 60),
  mode: "realtime",
  randomSeed: 7,
});

/** Two constants with DELIBERATELY DIFFERENT values, plus a switch, in one graph. */
function switchGraph(
  index: number,
  wired: readonly string[],
  extra: Record<string, unknown> = {},
): GraphDocument {
  const nodes: Record<string, unknown> = {
    pickN: {
      id: "pickN",
      type: "valueSwitch",
      definitionVersion: 1,
      position: { x: 0, y: 0 },
      label: "pick1",
      parameters: { index, ...extra },
    },
  };
  const edges: Record<string, unknown> = {};
  wired.forEach((port, slot) => {
    const id = `src${slot}`;
    nodes[id] = {
      id,
      type: "constant",
      definitionVersion: 1,
      position: { x: 0, y: 0 },
      label: id,
      // `constant` publishes a single `value` channel — the same NAME from both sources,
      // which is exactly the collision the merge would resolve by clobbering.
      parameters: { value: (slot + 1) * 11 },
    };
    edges[`e${slot}`] = {
      id: `e${slot}`,
      source: { nodeId: id, portId: "out" },
      target: { nodeId: "pickN", portId: port },
    };
  });
  return { revision: 1, groups: {}, nodes, edges } as unknown as GraphDocument;
}

function evaluated(index: number, wired: readonly string[], extra: Record<string, unknown> = {}) {
  const session = createValueGraphSession(registry);
  return session.evaluate(switchGraph(index, wired, extra), frameAt(0));
}

function pickedBag(
  index: number,
  wired: readonly string[],
  extra: Record<string, unknown> = {},
): Record<string, number> {
  const result = evaluated(index, wired, extra);
  expect(result.diagnostics).toEqual([]);
  return { ...(result.byName.get("pick1") ?? {}) };
}

/** The same graph with crossfade ON — T1054's path, through the real session. */
const blended = (index: number, wired: readonly string[]): Record<string, number> =>
  pickedBag(index, wired, { crossfade: true });

describe("valueSwitch — one source, exactly (T508, §V457)", () => {
  it("index 0 is source A's bag EXACTLY, carrying nothing of B", () => {
    // 11, not 22, and not some function of both. `toEqual` on the whole bag is the point:
    // a clobber would read 22 here and a blend would read 16.5.
    expect(pickedBag(0, ["in1", "in2"])).toEqual({ value: 11 });
  });

  it("index 1 is source B's bag EXACTLY", () => {
    expect(pickedBag(1, ["in1", "in2"])).toEqual({ value: 22 });
  });

  it("wiring two sources to ONE port still clobbers — which is why the node exists", () => {
    // §V457 pinned, from the consumer's side. If someone later "fixes" the merge into a
    // blend or an error, this reddens and the fixer meets the reasoning before the change
    // ships. Since T509 the clobber is REPORTED rather than silent, so both halves are
    // asserted here: the value that survives, and the warning that says the other one did
    // not. A test that only checked the number would go green if the diagnostic vanished.
    const result = evaluated(0, ["in1", "in1"]);
    expect({ ...(result.byName.get("pick1") ?? {}) }).toEqual({ value: 22 });
    expect(result.diagnostics.map((entry) => entry.code)).toEqual(["valueGraph.channelShadowed"]);
    expect(result.diagnostics[0]?.severity).toBe("warning");
  });

  it("the index counts CONNECTED inputs and wraps, so -1 is the last", () => {
    const wired = ["in1", "in2", "in3"];
    expect(pickedBag(3, wired)).toEqual({ value: 11 });
    expect(pickedBag(-1, wired)).toEqual({ value: 33 });
    // A gap is not a branch: in1 and in3 wired is TWO inputs, so index 1 is in3's source.
    expect(pickedBag(1, ["in1", "in3"])).toEqual({ value: 22 });
  });

  it("an unconnected Switch publishes NOTHING rather than inventing a zero", () => {
    // T578: the name said "an empty bag" and the node stopped publishing one — T508/T541
    // made it absent from `byName` entirely. The intent is unchanged (a Switch with no
    // source must not invent a value), so the assertion states the absence directly
    // rather than only through `pickedBag`'s `?? {}`, which cannot tell empty from gone.
    expect(evaluated(0, []).byName.has("pick1")).toBe(false);
    expect(pickedBag(0, [])).toEqual({});
  });

  it("a fractional index still CUTS while crossfade is off, whatever the fraction", () => {
    // §V831's promise on the value side: a document written before T1054 evaluates to the
    // same numbers. 0.75 of the way to source B still reads source A exactly — floored,
    // not blended, and not 19.25 (which is what a blend would give).
    expect(pickedBag(0.75, ["in1", "in2"])).toEqual({ value: 11 });
  });

  it("the index is a plain drivable number — no declared range to reject a wrapped one", () => {
    // T235's argument, inherited: a driven index ramps past the end on purpose, so §V66
    // must not reject a static value an expression would have wrapped happily.
    const index = valueSwitchNode.parameters["index"];
    expect(index?.type).toBe("number");
    expect(index && "min" in index ? index.min : undefined).toBeUndefined();
    expect(index && "max" in index ? index.max : undefined).toBeUndefined();
  });
});

/**
 * T1054 — CROSSFADE on the value Switch: a per-channel lerp between the two neighbours.
 *
 * THREE sources and a fraction that is not 0.5, deliberately (§V854). With two inputs
 * "blends with the next" and "blends with the last" are the same claim, and at 0.5 a
 * blend is symmetric, so an INVERTED lerp would pass. Every expected number below is a
 * different value under all four hypotheses — hard select, inverted blend, blend with the
 * wrong neighbour, and the right one.
 *
 * The sources publish 11, 22 and 33, so the arithmetic is checkable by reading it, and
 * every fraction used is a negative power of two, so the expectations are EXACT rather
 * than a tolerance (§V147). Driven through the real session, like the rest of this file.
 */
describe("valueSwitch crossfade (T1054)", () => {
  const three = ["in1", "in2", "in3"];

  it("lerps the two neighbouring bags at a fractional index", () => {
    // 11·0.75 + 22·0.25 = 13.75. A hard select reads 11, an inverted lerp 19.25, and a
    // blend with the LAST input 16.5 — so this one number rules out all three.
    expect(blended(0.25, three)).toEqual({ value: 13.75 });
  });

  it("is EXACTLY the selected bag at every integer index, not a lerp weighted to nothing", () => {
    // The endpoints are what make crossfade safe to leave on: at a whole index it is the
    // same bag a hard select produces, so the two agree wherever both are defined.
    expect(blended(0, three)).toEqual({ value: 11 });
    expect(blended(1, three)).toEqual({ value: 22 });
    expect(blended(2, three)).toEqual({ value: 33 });
    expect(blended(3, three)).toEqual({ value: 11 }); // wrapped, still exact
  });

  it("fades the LAST source into the FIRST across the seam", () => {
    // 33·0.75 + 11·0.25 = 27.5. Clamping at the last input would read 33; blending toward
    // in2 would read 30.25. T235's wrap is what crossfade inherits here.
    expect(blended(2.25, three)).toEqual({ value: 27.5 });
  });

  it("is continuous through the seam", () => {
    // Walking up to index 3 the value must approach source A's 11, and AT 3 it is 11. The
    // gap is 33·2^-8 + 11·(1 − 2^-8) − 11 = 22·2^-8 = 0.0859375 exactly — a discontinuity
    // would leave the whole 22 between the two readings instead.
    expect(blended(2.99609375, three)).toEqual({ value: 11.0859375 });
    expect(blended(3, three)).toEqual({ value: 11 });
    expect(blended(2.99609375, three)["value"]! - blended(3, three)["value"]!).toBe(22 * 2 ** -8);
  });

  it("still cuts, exactly, when the toggle is off", () => {
    // The §V831 anchor beside its own blend: same graph, same fractional index, toggle the
    // one parameter. If this ever read 13.75 the default would have moved.
    expect(pickedBag(0.25, three)).toEqual({ value: 11 });
    expect(blended(0.25, three)).toEqual({ value: 13.75 });
  });

  it("counts CONNECTED inputs, so a gap is not a branch to fade into", () => {
    // Two wired ports out of four is a two-input switch: 11·0.75 + 22·0.25, where in2's
    // absence must not become a third branch reading zero.
    expect(blended(0.25, ["in1", "in3"])).toEqual({ value: 13.75 });
  });

  it("fades a channel the other source does not publish, rather than holding it", () => {
    // §T982 made a value input carry a BAG, so the two sides can carry different channel
    // NAMES. An orphan channel has no counterpart, and carrying it through unweighted
    // would break the endpoint identity above — at t=0 the output must be source A's bag
    // exactly, which a union carrying B's channels at full strength would not be. So it
    // fades with its own side's weight, which is what a crossfader does.
    const session = createValueGraphSession(registry);
    const graph = {
      revision: 1,
      groups: {},
      nodes: {
        num: { id: "num", type: "constant", definitionVersion: 1, position: { x: 0, y: 0 }, label: "num", parameters: { value: 8 } },
        ptr: { id: "ptr", type: "mouse", definitionVersion: 1, position: { x: 0, y: 0 }, label: "ptr", parameters: {} },
        pick: {
          id: "pick", type: "valueSwitch", definitionVersion: 1, position: { x: 0, y: 0 },
          label: "pick1", parameters: { index: 0.25, crossfade: true },
        },
      },
      edges: {
        e0: { id: "e0", source: { nodeId: "num", portId: "out" }, target: { nodeId: "pick", portId: "in1" } },
        e1: { id: "e1", source: { nodeId: "ptr", portId: "out" }, target: { nodeId: "pick", portId: "in2" } },
      },
    } as unknown as GraphDocument;

    // `constant` publishes {value}; `mouse` publishes {x, y, buttons}. No channel is shared,
    // so EVERY channel here is an orphan and each one carries its own side's weight.
    const result = session.evaluate(graph, frameAt(0), { pointer: { x: 0.5, y: 0.25, buttons: 1 } });
    expect(result.diagnostics).toEqual([]);
    expect({ ...(result.byName.get("pick1") ?? {}) }).toEqual({
      value: 8 * 0.75, // 6 — source A's channel, three quarters of the way out
      x: 0.5 * 0.25, // 0.125 — source B's channels, a quarter of the way in
      y: 0.25 * 0.25, // 0.0625
      buttons: 1 * 0.25, // 0.25
    });
  });
});
