import { describe, expect, it } from "vitest";

import { compileGraph } from "../../compiler/index.ts";
import { createValueGraphSession } from "../../domain/channels/value-graph.ts";
import { nonReproducibleRenderWarning } from "../../domain/render/reproducibility.ts";
import { serialiseMidiMapping, type MidiBinding } from "../../domain/midi/midi-mapping.ts";
import type { FrameEvaluationInput } from "../../domain/types/frame.ts";
import type { GraphDocument, ProjectSettings } from "../../domain/types/graph.ts";
import type { ParameterSlot } from "../../domain/types/parameters.ts";
import { TIER_B_CAPABILITIES } from "../../examples/runner.ts";
import { createNodeRegistry } from "../registry/registry.ts";
import { allNodeDefinitions } from "./index.ts";

/**
 * T942 tier 1 — MIDI In, END TO END, and the degraded path beside it every time.
 *
 * ## Why the assertions run through the COMPILER rather than through the node
 *
 * "The node publishes a bag" is the easy half and it proves almost nothing: the interesting
 * failure is a knob that publishes a number nothing downstream ever reads, which is exactly
 * the shape B25 and B27 both had — a service built, unit-tested and never wired, so the
 * feature did not exist in the product while every test was green. So the first gate below
 * takes a real document, evaluates the real value graph, hands its real resolver to the
 * real compiler, and asserts the number that lands in a PASS UNIFORM. Nothing short of the
 * whole chain working makes it pass.
 *
 * ## Why the reach test uses a SHADER's own reflected field
 *
 * The ask was to map "parameters, parameter sets or shader param references", and the point
 * of publishing into the channel seam is that the seam does not know or care what is on the
 * far end. A `customWgsl`'s controls ARE its shader's `struct Params` (T880), so driving one
 * of those from a learned CC is the proof that the reach is general rather than a list of
 * parameter kinds someone remembered to support.
 *
 * ## Both directions, always (§V461, §V537)
 *
 * Every "the knob drives it" assertion is paired with an "and with the device absent it
 * sits at its declared rest" one. A node that published a constant would satisfy half of
 * these, and a node that published nothing would satisfy the other half.
 */

const registry = createNodeRegistry(allNodeDefinitions).view();

const settings: ProjectSettings = {
  outputResolution: { width: 32, height: 32 },
  workingFormat: "rgba16float",
  colorPolicy: { workingSpace: "linear", displayTransform: "none" },
  randomSeed: 7,
  previewLongEdge: 64,
  previewFps: 30,
  limits: { maxResolution: 4096, maxBufferBytes: 1 << 28, maxDispatch: 65535, memoryBudgetBytes: 1 << 30 },
};

const frame: FrameEvaluationInput = {
  timeSeconds: 0,
  deltaSeconds: 1 / 60,
  frameIndex: 0,
  mode: "offline",
  randomSeed: 7,
};

const driven = (channel: string, retained: number): ParameterSlot => ({
  mode: "driven",
  bindings: { static: { kind: "static", value: retained }, driven: { kind: "driven", channel } },
});

/**
 * One control learned onto CC 74, channel 1, mapped into a band inside 0..1.
 *
 * The band is inside the unit interval on purpose: the parameters it drives here are a
 * colour component and a reflected `f32`, both of which are `bounded` (§B111) and clamp.
 * A band of 2..10 would be clamped to 1 at both ends and every assertion below would pass
 * for the wrong reason — the range arithmetic itself is pinned in `midi-mapping.test.ts`,
 * where nothing downstream can flatten it.
 */
const CUTOFF: MidiBinding = {
  channel: "cutoff",
  source: { kind: "cc", channel: 1, number: 74 },
  range: [0.25, 0.75],
  mode: "absolute",
};

/** A bend, whose rest is the CENTRE — the case a blind zero gets wrong. */
const BEND: MidiBinding = {
  channel: "bend",
  source: { kind: "pitchBend", channel: 1 },
  range: [-1, 1],
  mode: "absolute",
  rest: 0,
};

const SHADER = `struct Params { amount: f32, };
@group(0) @binding(0) var inputSampler: sampler;
@group(0) @binding(1) var inputTexture: texture_2d<f32>;
@group(0) @binding(2) var<uniform> params : Params;
@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  return textureSampleLevel(inputTexture, inputSampler, uv, 0.0) * params.amount;
}`;

/**
 * `midi1` → a driven `solid.color.r`, and a `customWgsl` whose SHADER's own `amount` field
 * is driven by the same learned control. One document, both reaches.
 */
function documentWith(bindings: readonly MidiBinding[], device = ""): GraphDocument {
  return {
    revision: 1,
    groups: {},
    nodes: {
      midi: {
        id: "midi",
        type: "midiIn",
        definitionVersion: 1,
        position: { x: 0, y: 0 },
        label: "midi1",
        parameters: { device, mapping: serialiseMidiMapping(bindings) },
      },
      fill: {
        id: "fill",
        type: "solid",
        definitionVersion: 1,
        position: { x: 200, y: 0 },
        label: "fill1",
        parameters: {},
      },
      /*
       * A BUILT-IN parameter, driven. `level.opacity` rather than a colour component,
       * deliberately: a colour is decoded display→linear on its way to the uniform (§V56),
       * so a colour assertion would be checking the colour transform as much as the MIDI
       * path, and 0.75 would arrive as 0.5225 for a reason that has nothing to do with
       * this row.
       */
      gain: {
        id: "gain",
        type: "level",
        definitionVersion: 1,
        position: { x: 300, y: 0 },
        label: "gain1",
        parameters: { opacity: driven("midi1:cutoff", 0) },
      },
      shade: {
        id: "shade",
        type: "customWgsl",
        definitionVersion: 1,
        position: { x: 400, y: 0 },
        label: "shade1",
        parameters: { source: SHADER, amount: driven("midi1:cutoff", 0) },
      },
      out: { id: "out", type: "output", definitionVersion: 1, position: { x: 600, y: 0 }, label: "out1", parameters: {} },
    },
    edges: {
      e1: { id: "e1", source: { nodeId: "fill", portId: "out" }, target: { nodeId: "gain", portId: "input" } },
      e3: { id: "e3", source: { nodeId: "gain", portId: "out" }, target: { nodeId: "shade", portId: "input" } },
      e2: { id: "e2", source: { nodeId: "shade", portId: "out" }, target: { nodeId: "out", portId: "input" } },
    },
  } as unknown as GraphDocument;
}

/** The channel seam, exactly as the session publishes it. `null` = no MIDI at all. */
function channelsFrom(readings: Readonly<Record<string, number>> | null) {
  return readings === null ? undefined : (name: string): number | undefined => readings[name];
}

interface Rendered {
  readonly bag: Readonly<Record<string, number>>;
  /** `level.opacity` — a built-in numeric parameter, driven. */
  readonly opacity: number;
  readonly amount: number;
  readonly errors: readonly string[];
}

/** The whole chain: value graph → resolver → compiler → the uniforms a pass will bind. */
function render(document: GraphDocument, readings: Readonly<Record<string, number>> | null): Rendered {
  const session = createValueGraphSession(registry);
  const channels = channelsFrom(readings);
  const values = session.evaluate(document, frame, channels === undefined ? {} : { channels });
  const plan = compileGraph({
    graph: document,
    settings,
    registry,
    capabilities: TIER_B_CAPABILITIES,
    resolution: { frame, channels: values.resolver },
  });
  const gain = plan.passes.find((entry) => entry.kind === "effect" && entry.nodeId === "gain");
  const shade = plan.passes.find((entry) => entry.kind === "effect" && entry.nodeId === "shade");
  if (gain === undefined || gain.kind !== "effect") throw new Error("no level pass");
  if (shade === undefined || shade.kind !== "effect") throw new Error("no shade pass");
  return {
    bag: values.byName.get("midi1") ?? {},
    opacity: gain.uniforms?.["opacity"] as number,
    amount: shade.uniforms?.["amount"] as number,
    errors: plan.diagnostics.filter((entry) => entry.severity === "error").map((entry) => entry.message),
  };
}

describe("A LEARNED CC DRIVES A PARAMETER, all the way into a pass uniform", () => {
  it("the bag is keyed by the USER'S name, so midi1:cutoff is the address (§V129)", () => {
    const { bag } = render(documentWith([CUTOFF]), { "midi:*:cc1.74": 127 });
    // `cutoff`, not `cc74`. The node names channels and the mapping names hardware, so a
    // document survives being re-learned onto a different controller.
    expect(Object.keys(bag)).toEqual(["cutoff"]);
  });

  it("moves a built-in parameter across the band the mapping declared", () => {
    expect(render(documentWith([CUTOFF]), { "midi:*:cc1.74": 0 }).opacity).toBeCloseTo(0.25, 6);
    expect(render(documentWith([CUTOFF]), { "midi:*:cc1.74": 127 }).opacity).toBeCloseTo(0.75, 6);
    expect(render(documentWith([CUTOFF]), { "midi:*:cc1.74": 64 }).opacity).toBeCloseTo(0.25 + 0.5 * (64 / 127), 6);
  });

  it("moves a SHADER's own reflected `struct Params` field, through the same seam", () => {
    // The generality claim, checked rather than asserted: nothing in the MIDI path knows
    // what a reflected shader field is, and it drives one anyway.
    expect(render(documentWith([CUTOFF]), { "midi:*:cc1.74": 127 }).amount).toBeCloseTo(0.75, 6);
    expect(render(documentWith([CUTOFF]), { "midi:*:cc1.74": 0 }).amount).toBeCloseTo(0.25, 6);
  });

  it("the same knob drives BOTH at once — a parameter SET, not one slot", () => {
    const rendered = render(documentWith([CUTOFF]), { "midi:*:cc1.74": 127 });
    expect(rendered.opacity).toBeCloseTo(rendered.amount, 6);
  });

  it("publishes every learned control from ONE node, the way Mouse publishes x/y/buttons", () => {
    const { bag } = render(documentWith([CUTOFF, BEND]), {
      "midi:*:cc1.74": 127,
      "midi:*:bend1": 16383,
    });
    expect(bag).toEqual({ cutoff: 0.75, bend: 1 });
  });

  it("reads the DEVICE-scoped name when a device is picked, not the any-device one", () => {
    // Both directions: with the device set, the `*` reading must NOT be picked up, or
    // choosing a controller would silently mean nothing.
    const picked = documentWith([CUTOFF], "port-7");
    expect(render(picked, { "midi:port-7:cc1.74": 127 }).opacity).toBeCloseTo(0.75, 6);
    expect(render(picked, { "midi:*:cc1.74": 127 }).opacity).toBeCloseTo(0.25, 6);
  });
});

describe("A DOCUMENT NAMING AN ABSENT DEVICE LOADS AND RENDERS (§T715, §T948, §V353)", () => {
  /*
   * The three absences a user actually meets, all reaching the same place: a compiled plan
   * with no errors and every driven parameter holding a defined number. §T715's constraint
   * verbatim — the node always exists, always publishes its output type, and the document
   * renders, degraded.
   */
  it("a device that is not attached: the channels sit at their declared rest", () => {
    const absent = render(documentWith([CUTOFF, BEND], "port-that-is-not-here"), {
      "midi:*:cc1.74": 127,
      "midi:*:bend1": 16383,
    });
    expect(absent.errors).toEqual([]);
    // `cutoff` rests at range[0]; `bend` rests at its declared CENTRE rather than at -1.
    expect(absent.bag).toEqual({ cutoff: 0.25, bend: 0 });
    expect(absent.opacity).toBeCloseTo(0.25, 6);
  });

  it("no Web MIDI at all — no channel seam whatsoever — is the same degraded render", () => {
    // Safari, a denied prompt and a headless render are all this case. `channels` is not
    // merely empty, it is ABSENT, which is the shape a value graph built without the hook
    // actually has.
    const none = render(documentWith([CUTOFF, BEND]), null);
    expect(none.errors).toEqual([]);
    expect(none.bag).toEqual({ cutoff: 0.25, bend: 0 });
    expect(none.amount).toBeCloseTo(0.25, 6);
  });

  it("publishes a NUMBER for every learned channel — never an absent one", () => {
    // §V353's reasoning applied: a missing feature would dangle every driven parameter,
    // where a rest value keeps the whole graph evaluating.
    const { bag } = render(documentWith([CUTOFF, BEND]), null);
    for (const value of Object.values(bag)) expect(Number.isFinite(value)).toBe(true);
  });

  it("a control that was named but never learned still publishes, at its rest", () => {
    const unlearned: MidiBinding = { channel: "waiting", source: null, range: [0.25, 1], mode: "absolute" };
    expect(render(documentWith([unlearned]), { "midi:*:cc1.74": 127 }).bag).toEqual({ waiting: 0.25 });
  });

  it("a mapping that will not parse degrades to an empty bag, not to a broken render", () => {
    const document = documentWith([]) as unknown as { nodes: Record<string, { parameters: Record<string, unknown> }> };
    document.nodes["midi"]!.parameters["mapping"] = "[{ this is not json";
    const broken = render(document as unknown as GraphDocument, null);
    expect(broken.errors).toEqual([]);
    expect(broken.bag).toEqual({});
    // The driven slot falls back to its retained static (§V108) rather than to NaN.
    expect(broken.opacity).toBe(0);
  });
});

describe("§V329 — the classification has a CONSEQUENCE, not just an entry", () => {
  it("a render over a MIDI controller warns, and names the node", () => {
    // The gate in `reproducibility.test.ts` only proves the node was classified. This
    // proves the classification does something: delete the entry and this fails too.
    const warning = nonReproducibleRenderWarning(documentWith([CUTOFF]), registry);
    expect(warning).not.toBeNull();
    expect(warning?.severity).toBe("warning");
    expect(warning?.message).toContain('MIDI In "midi1"');
    expect(warning?.suggestion).toContain('MIDI In "midi1"');
  });
});
