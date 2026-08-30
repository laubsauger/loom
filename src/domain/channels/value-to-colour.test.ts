import { describe, expect, it } from "vitest";
import { compileGraph } from "../../compiler/index.ts";
import { allNodeDefinitions } from "../../nodes/definitions/index.ts";
import { createNodeRegistry } from "../../nodes/registry/registry.ts";
import type { GraphDocument, ProjectSettings } from "../types/graph.ts";
import type { NodeDefinition } from "../types/node-definition.ts";
import type { ParameterSlot } from "../types/parameters.ts";
import type { FrameEvaluationInput } from "../types/frame.ts";
import { TIER_B_CAPABILITIES } from "../../examples/runner.ts";
import { graphChannelResolver } from "./graph-channels.ts";

/**
 * VALUE TO COLOUR — what a channel can and cannot carry (T389).
 *
 * The question this file answers, because guessing at it is how a feature gets built twice:
 * can an LFO drive a COLOUR? `ChannelResolver` returns `ParameterValue`, which is not
 * obviously scalar-only, so a colour-valued channel LOOKS expressible from the type alone.
 *
 * It is not, and the narrowing is deliberate rather than accidental: `valueChannel` is
 * declared to return `number`, `valueEvaluate` returns named numbers, and the one resolver
 * that turns a value node into a channel drops anything that is not a finite number. Three
 * places agree, so a node returning a vector would be silently ignored rather than
 * half-working — which is worth knowing before anyone widens one of them.
 *
 * What DOES work today, with no new code, is the §V113 compound path: a `color` parameter's
 * COMPONENTS are addressable slots, so `color.r`, `color.g` and `color.b` can each be driven
 * by their own channel and the resolver reassembles them into the vec4 the shader wants.
 * "Three channels" is not a workaround here, it is the mechanism — and it is strictly more
 * expressive than a colour-valued channel, because the three can come from different
 * sources.
 *
 * A LERP between two colours is a different question again and also already answered: it is
 * a `cross` between two images (E7 drives exactly that with an LFO), or a Ramp indexed by a
 * driven position (E2's palette). Neither needs a channel to carry a colour.
 */

const settings: ProjectSettings = {
  outputResolution: { width: 32, height: 32 },
  workingFormat: "rgba16float",
  colorPolicy: { workingSpace: "linear", displayTransform: "none" },
  randomSeed: 7,
  previewLongEdge: 64,
  previewFps: 30,
  limits: { maxResolution: 4096, maxBufferBytes: 1 << 28, maxDispatch: 65535, memoryBudgetBytes: 1 << 30 },
};

const registry = createNodeRegistry(allNodeDefinitions).view();

const driven = (channel: string, retained: number): ParameterSlot => ({
  mode: "driven",
  bindings: {
    static: { kind: "static", value: retained },
    driven: { kind: "driven", channel },
  },
});

/** solid1's colour, with red, green and blue each driven by a different LFO. */
function graph(): GraphDocument {
  const lfo = (id: string, label: string, frequency: number, phase: number) => ({
    id,
    type: "lfo",
    definitionVersion: 1,
    position: { x: 0, y: 0 },
    label,
    parameters: { shape: "sine", frequency, amplitude: 0.5, offset: 0.5, phase },
  });
  return {
    revision: 1,
    groups: {},
    nodes: {
      red: lfo("red", "lfoR", 0.5, 0),
      green: lfo("green", "lfoG", 0.5, 0.33),
      blue: lfo("blue", "lfoB", 0.5, 0.66),
      fill: {
        id: "fill",
        type: "solid",
        definitionVersion: 1,
        position: { x: 200, y: 0 },
        parameters: {
          "color.r": driven("lfoR", 0),
          "color.g": driven("lfoG", 0),
          "color.b": driven("lfoB", 0),
        },
      },
      out: { id: "out", type: "output", definitionVersion: 1, position: { x: 400, y: 0 }, parameters: {} },
    },
    edges: {
      e1: { id: "e1", source: { nodeId: "fill", portId: "out" }, target: { nodeId: "out", portId: "input" } },
    },
  } as unknown as GraphDocument;
}

function colourAt(frameIndex: number): readonly number[] {
  const frame: FrameEvaluationInput = {
    timeSeconds: frameIndex / 60,
    deltaSeconds: 1 / 60,
    frameIndex,
    mode: "offline",
    randomSeed: settings.randomSeed,
  };
  const document = graph();
  const plan = compileGraph({
    graph: document,
    settings,
    registry,
    capabilities: TIER_B_CAPABILITIES,
    resolution: { frame, channels: graphChannelResolver(document, registry) },
  });
  expect(plan.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  const pass = plan.passes.find((entry) => entry.kind === "effect" && entry.nodeId === "fill");
  if (pass === undefined || pass.kind !== "effect") throw new Error("no fill pass");
  const colour = pass.uniforms?.["color"];
  if (!Array.isArray(colour)) throw new Error("solid's colour uniform is not a vector");
  return colour;
}

describe("value to colour (T389)", () => {
  it("a channel carries a NUMBER — a colour-valued one is not expressible", () => {
    // The contract, stated where it is enforced. `valueChannel` is declared `-> number`, so
    // this cast is the only way to express the thing being ruled out.
    const vectorSource = {
      type: "fake.vectorSource",
      version: 1,
      title: "Vector Source",
      category: "value",
      inputs: [],
      outputs: [],
      parameters: {},
      resolutionPolicy: { kind: "project" },
      formatPolicy: { kind: "project" },
      valueChannel: () => [1, 0, 0, 1] as unknown as number,
      compile: () => ({ passes: [] }),
    } as unknown as NodeDefinition;

    const fakeRegistry = createNodeRegistry([...allNodeDefinitions, vectorSource]).view();
    const document = {
      revision: 1,
      groups: {},
      nodes: {
        src: { id: "src", type: "fake.vectorSource", definitionVersion: 1, position: { x: 0, y: 0 }, label: "vec1", parameters: {} },
      },
      edges: {},
    } as unknown as GraphDocument;

    const resolve = graphChannelResolver(document, fakeRegistry);
    const context = {
      node: document.nodes["src"]!,
      key: "color",
      definition: { type: "color", label: "Color", default: [0, 0, 0, 1] },
    } as never;

    // Not "returns the vector": the resolver's `Number.isFinite` guard drops it, so a value
    // node that tried to publish a colour would be reported as "channel not attached" and
    // the parameter would sit on its retained value. That is the honest failure, and it is
    // why widening this would have to be done deliberately in three places at once.
    expect(resolve("vec1", context)).toBeUndefined();
  });

  it("drives a COLOUR from three channels, one per component (§V113) — and it reaches the shader", () => {
    const first = colourAt(0);
    const later = colourAt(20);

    expect(first).toHaveLength(4);
    // Every component moved, and they moved by DIFFERENT amounts: the three LFOs are out of
    // phase, so a single channel driving the whole colour (or one component's value being
    // copied to the others) would show up as three equal deltas.
    const deltas = [0, 1, 2].map((index) => Math.abs((later[index] as number) - (first[index] as number)));
    for (const delta of deltas) expect(delta).toBeGreaterThan(0);
    expect(new Set(deltas.map((delta) => delta.toFixed(6))).size).toBe(3);

    // Alpha is untouched: no slot names it, so it keeps the manifest's default. A component
    // path that overwrote its siblings would fail here rather than looking plausible.
    expect(later[3]).toBe(1);
  });

  it("keeps the retained value when nothing supplies the channels (§V108)", () => {
    // The same document compiled WITHOUT a channel resolver — a structural compile, and the
    // state every host that has not attached the value graph is in. The colour must be the
    // retained statics, not zero, not last frame's.
    const document = graph();
    const plan = compileGraph({
      graph: document,
      settings,
      registry,
      capabilities: TIER_B_CAPABILITIES,
    });
    const pass = plan.passes.find((entry) => entry.kind === "effect" && entry.nodeId === "fill");
    if (pass === undefined || pass.kind !== "effect") throw new Error("no fill pass");
    expect(pass.uniforms?.["color"]).toEqual([0, 0, 0, 1]);
  });
});
