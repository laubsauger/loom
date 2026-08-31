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
function switchGraph(index: number, wired: readonly string[]): GraphDocument {
  const nodes: Record<string, unknown> = {
    pickN: {
      id: "pickN",
      type: "valueSwitch",
      definitionVersion: 1,
      position: { x: 0, y: 0 },
      label: "pick1",
      parameters: { index },
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

function evaluated(index: number, wired: readonly string[]) {
  const session = createValueGraphSession(registry);
  return session.evaluate(switchGraph(index, wired), frameAt(0));
}

function pickedBag(index: number, wired: readonly string[]): Record<string, number> {
  const result = evaluated(index, wired);
  expect(result.diagnostics).toEqual([]);
  return { ...(result.byName.get("pick1") ?? {}) };
}

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

  it("the index is a plain drivable number — no declared range to reject a wrapped one", () => {
    // T235's argument, inherited: a driven index ramps past the end on purpose, so §V66
    // must not reject a static value an expression would have wrapped happily.
    const index = valueSwitchNode.parameters["index"];
    expect(index?.type).toBe("number");
    expect(index && "min" in index ? index.min : undefined).toBeUndefined();
    expect(index && "max" in index ? index.max : undefined).toBeUndefined();
  });
});
