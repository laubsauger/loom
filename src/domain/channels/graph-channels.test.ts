import { describe, expect, it } from "vitest";

import type { GraphDocument, GraphNode } from "../types/graph.ts";
import type { NodeId } from "../types/ids.ts";
import type { FrameEvaluationInput } from "../types/frame.ts";
import { createNodeRegistry } from "../../nodes/registry/registry.ts";
import { allNodeDefinitions, blurNode } from "../../nodes/definitions/index.ts";
import { resolveParameters } from "../parameters/resolve.ts";
import { graphChannelResolver, hasAnimatedParameters } from "./graph-channels.ts";

/**
 * The driven mode comes ALIVE (T238, T203, §V143): a parameter driven by channel
 * `lfo1` reads the LFO node named `lfo1`, per frame, through the one resolver.
 */

function node(id: string, type: string, extra: Partial<GraphNode> = {}): GraphNode {
  return {
    id: id as NodeId,
    type,
    definitionVersion: 1,
    position: { x: 0, y: 0 },
    parameters: {},
    ...extra,
  };
}

function graphWith(...nodes: GraphNode[]): GraphDocument {
  return {
    revision: 1,
    nodes: Object.fromEntries(nodes.map((n) => [n.id, n])),
    edges: {},
    groups: {},
  } as unknown as GraphDocument;
}

const registry = createNodeRegistry(allNodeDefinitions).view();

const frameAt = (timeSeconds: number): FrameEvaluationInput => ({
  timeSeconds,
  deltaSeconds: 1 / 60,
  frameIndex: Math.round(timeSeconds * 60),
  mode: "realtime",
  randomSeed: 7,
});

describe("graphChannelResolver (T238-T240)", () => {
  const lfo = node("n-lfo", "lfo", {
    label: "lfo1",
    parameters: { shape: "sine", frequency: 1, amplitude: 0.5, offset: 0.5, phase: 0 },
  });
  const driven = node("n-blur", "blur", {
    label: "blur1",
    parameters: {
      size: { mode: "driven", bindings: { driven: { kind: "driven", channel: "lfo1" } } },
    },
  });

  it("drives a parameter from an LFO by NAME, per frame — something finally moves", () => {
    const graph = graphWith(lfo, driven);
    const channels = graphChannelResolver(graph, registry);

    const at = (t: number) =>
      resolveParameters(driven, blurNode, { frame: frameAt(t), channels }).values["size"];

    expect(at(0.25)).toBeCloseTo(1, 10); // crest: 0.5 + 0.5·sin(π/2)
    expect(at(0.75)).toBeCloseTo(0, 10); // trough
    expect(at(0.25)).toBe(at(0.25)); // §V45: same frame, same value, every time
  });

  it("returns undefined — retained value in effect — for a name that is no value source", () => {
    const graph = graphWith(driven); // no lfo1 in the document
    const channels = graphChannelResolver(graph, registry);
    const resolved = resolveParameters(driven, blurNode, { frame: frameAt(1), channels });
    expect(resolved.get("size")?.value).toBe(8); // blur's manifest default
    expect(resolved.get("size")?.diagnostic?.code).toBe("parameter.driven");
  });

  it("reads the source's parameters as their STATIC view — no channel-of-channel recursion", () => {
    const recursive = node("n-lfo2", "lfo", {
      label: "lfo1",
      parameters: {
        frequency: { mode: "driven", bindings: { driven: { kind: "driven", channel: "lfo1" } } },
        amplitude: 1,
        offset: 0,
        shape: "saw",
      },
    });
    const graph = graphWith(recursive, driven);
    const channels = graphChannelResolver(graph, registry);
    // Frequency's driven slot has no static payload, so the manifest default (1) rules;
    // the point is that this terminates and yields a finite number.
    const value = channels("lfo1", { node: driven, key: "size", definition: blurNode.parameters["size"]!, frame: frameAt(0.5) });
    expect(typeof value).toBe("number");
    expect(Number.isFinite(value)).toBe(true);
  });
});

describe("hasAnimatedParameters", () => {
  it("is false for a static document and true once any slot animates", () => {
    expect(hasAnimatedParameters(graphWith(node("a", "solid")))).toBe(false);
    expect(
      hasAnimatedParameters(
        graphWith(
          node("a", "solid", {
            parameters: {
              amount: { mode: "expression", bindings: { expression: { kind: "expression", source: "time" } } },
            },
          }),
        ),
      ),
    ).toBe(true);
  });

  /**
   * T988 — `map` is the fifth mode and it is the one this predicate leaves out. That is a
   * decision, so it is gated: the reason has to be checkable, not remembered.
   *
   * §V287: a map has NO CPU value. `resolveStored`'s `map` branch returns the RETAINED
   * static and files the mapping as data for the consumer to compile, so the number the
   * inspector reads is the same at every frame. Saying "animated" here would arm the
   * panel's 10 Hz sampler — a timer, a `setState` and a full inspector re-render, ten
   * times a second — for a value that provably cannot move.
   */
  it("excludes `map`, because a mapped parameter's CPU value is the same at every frame", () => {
    const mapped = node("a", "blur", {
      parameters: {
        size: {
          mode: "map",
          bindings: {
            map: { kind: "map", attribute: "size" },
            static: { kind: "static", value: 12 },
          },
        },
      },
    });

    // The reason, measured rather than asserted: resolve the same parameter a thousand
    // frames apart and it is the retained 12 both times. If that ever stopped being true,
    // THIS is the assertion that has to fail before the predicate is changed.
    const early = resolveParameters(mapped, blurNode, { frame: frameAt(0) }).values["size"];
    const late = resolveParameters(mapped, blurNode, { frame: frameAt(1000) }).values["size"];
    expect(early).toBe(12);
    expect(late).toBe(early);

    expect(hasAnimatedParameters(graphWith(mapped))).toBe(false);
  });
});
