import { describe, expect, it } from "vitest";

import { compileGraph } from "../../compiler/index.ts";
import { createValueGraphSession } from "../../domain/channels/value-graph.ts";
import { nonReproducibleRenderWarning } from "../../domain/render/reproducibility.ts";
import { effectiveParameterSchema } from "../../domain/parameters/resolve.ts";
import type { FrameEvaluationInput } from "../../domain/types/frame.ts";
import type { GraphDocument, ProjectSettings } from "../../domain/types/graph.ts";
import type { ParameterSlot } from "../../domain/types/parameters.ts";
import { TIER_B_CAPABILITIES } from "../../examples/runner.ts";
import { createNodeRegistry } from "../registry/registry.ts";
import { allNodeDefinitions } from "./index.ts";

/**
 * T942 tier 3 — OSC In and OSC Out as NODES, end to end, with the degraded path beside
 * every claim.
 *
 * ## Why the assertions run through the COMPILER rather than through the node
 *
 * "The node publishes a bag" is the easy half and proves almost nothing: the interesting
 * failure is a channel that publishes a number nothing downstream reads, which is B25's
 * and B27's shape exactly — built, unit-tested, never wired. So the first block takes a
 * real document, evaluates the real value graph, hands its real resolver to the real
 * compiler, and asserts the number that lands in a PASS UNIFORM.
 *
 * ## Why the reach test uses a SHADER's own reflected field
 *
 * The point of publishing into the channel seam is that the seam does not care what is on
 * the far end. A `customWgsl`'s controls ARE its shader's `struct Params` (T880), so
 * driving one from an OSC address proves the reach is general rather than a list of
 * parameter kinds someone remembered to support.
 *
 * ## The node IS the interface (the owner's ruling), so that is what is asserted
 *
 * `oscIn` grows its own Address and Rest parameters out of its `controls` declaration via
 * `parametersFor`. The block below asserts the GENERATION, because a pane-free design that
 * generated nothing would be indistinguishable from a node with no interface at all.
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

const SHADER = `struct Params { amount: f32, };
@group(0) @binding(0) var inputSampler: sampler;
@group(0) @binding(1) var inputTexture: texture_2d<f32>;
@group(0) @binding(2) var<uniform> params : Params;
@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  return textureSampleLevel(inputTexture, inputSampler, uv, 0.0) * params.amount;
}`;

/**
 * `osc1` → a driven `level.opacity`, and a `customWgsl` whose SHADER's own `amount` field
 * is driven by the same address. One document, both reaches.
 *
 * `parameters` here is what the NODE ITSELF holds — `controls` plus the generated
 * `<name>Address` / `<name>Rest` keys. There is no JSON blob and no pane; this shape IS
 * the user interface.
 */
function documentWith(parameters: Record<string, unknown>): GraphDocument {
  return {
    revision: 1,
    groups: {},
    nodes: {
      osc: {
        id: "osc",
        type: "oscIn",
        definitionVersion: 1,
        position: { x: 0, y: 0 },
        label: "osc1",
        parameters: { port: 9000, ...parameters },
      },
      fill: { id: "fill", type: "solid", definitionVersion: 1, position: { x: 200, y: 0 }, label: "fill1", parameters: {} },
      /*
       * A BUILT-IN parameter, driven. `level.opacity` rather than a colour component,
       * deliberately: a colour is decoded display→linear on its way to the uniform (§V56),
       * so a colour assertion would be checking the colour transform as much as the OSC
       * path (`midi.test.ts` made the same choice for the same reason).
       */
      gain: {
        id: "gain",
        type: "level",
        definitionVersion: 1,
        position: { x: 300, y: 0 },
        label: "gain1",
        parameters: { opacity: driven("osc1:cutoff", 0) },
      },
      shade: {
        id: "shade",
        type: "customWgsl",
        definitionVersion: 1,
        position: { x: 400, y: 0 },
        label: "shade1",
        parameters: { source: SHADER, amount: driven("osc1:cutoff", 0) },
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

/** The channel seam, exactly as the session publishes it. `null` = no helper at all. */
function channelsFrom(readings: Readonly<Record<string, number>> | null) {
  return readings === null ? undefined : (name: string): number | undefined => readings[name];
}

interface Rendered {
  readonly bag: Readonly<Record<string, number>>;
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
    bag: values.byName.get("osc1") ?? {},
    opacity: gain.uniforms?.["opacity"] as number,
    amount: shade.uniforms?.["amount"] as number,
    errors: plan.diagnostics.filter((entry) => entry.severity === "error").map((entry) => entry.message),
  };
}

const CUTOFF = { controls: "cutoff", cutoffAddress: "/synth/cutoff", cutoffRest: 0.25 };

describe("THE NODE IS THE INTERFACE — its schema grows from its own declaration (§T880)", () => {
  it("declares nothing per-control until a control is named", () => {
    const bare = effectiveParameterSchema(registry.get("oscIn"), {});
    expect(Object.keys(bare).sort()).toEqual(["controls", "port"]);
  });

  it("grows one Address and one Rest parameter per declared name", () => {
    const grown = effectiveParameterSchema(registry.get("oscIn"), { controls: "cutoff pan" });
    expect(Object.keys(grown).sort()).toEqual([
      "controls",
      "cutoffAddress",
      "cutoffRest",
      "panAddress",
      "panRest",
      "port",
    ]);
    // Ordinary parameters, not a bespoke widget: a string field and a number field, which
    // is what makes them drivable, undoable and visible to the agent for free.
    expect(grown["cutoffAddress"]?.type).toBe("string");
    expect(grown["cutoffRest"]?.type).toBe("number");
  });

  it("ignores a name that could not make an identifier, rather than mangling it", () => {
    // A generated key must be an identifier. A name that cannot make one has no row —
    // dropped, the way an unsupported MIDI message is dropped at the decoder (§T959).
    const grown = effectiveParameterSchema(registry.get("oscIn"), { controls: "cut-off 9lives ok" });
    expect(Object.keys(grown)).toContain("okAddress");
    expect(Object.keys(grown)).not.toContain("cut-offAddress");
    expect(Object.keys(grown)).not.toContain("9livesAddress");
  });

  it("declares a name once, because a name is an ADDRESS (§V129)", () => {
    const grown = effectiveParameterSchema(registry.get("oscIn"), { controls: "cutoff cutoff" });
    expect(Object.keys(grown).filter((key) => key === "cutoffAddress")).toHaveLength(1);
  });
});

describe("AN OSC ADDRESS DRIVES A PARAMETER, all the way into a pass uniform", () => {
  it("the bag is keyed by the USER'S name, so osc1:cutoff is the address (§V129)", () => {
    const { bag } = render(documentWith(CUTOFF), { "osc:/synth/cutoff": 0.5 });
    // `cutoff`, not `/synth/cutoff`. The node names channels and the parameter names the
    // wire, so re-pointing at a different sender leaves every driven parameter alone.
    expect(Object.keys(bag)).toEqual(["cutoff"]);
  });

  it("moves a built-in parameter to EXACTLY the value that arrived", () => {
    // Unlike a 7-bit CC there is no full scale to normalise against, so the number is the
    // number. Three points, so a node returning a constant cannot pass.
    expect(render(documentWith(CUTOFF), { "osc:/synth/cutoff": 0 }).opacity).toBeCloseTo(0, 6);
    expect(render(documentWith(CUTOFF), { "osc:/synth/cutoff": 0.625 }).opacity).toBeCloseTo(0.625, 6);
    expect(render(documentWith(CUTOFF), { "osc:/synth/cutoff": 1 }).opacity).toBeCloseTo(1, 6);
  });

  it("moves a SHADER's own reflected `struct Params` field, through the same seam", () => {
    // The generality claim, checked rather than asserted: nothing in the OSC path knows
    // what a reflected shader field is, and it drives one anyway.
    expect(render(documentWith(CUTOFF), { "osc:/synth/cutoff": 0.625 }).amount).toBeCloseTo(0.625, 6);
    expect(render(documentWith(CUTOFF), { "osc:/synth/cutoff": 0.125 }).amount).toBeCloseTo(0.125, 6);
  });

  it("the same address drives BOTH at once — a parameter SET, not one slot", () => {
    const rendered = render(documentWith(CUTOFF), { "osc:/synth/cutoff": 0.4 });
    expect(rendered.opacity).toBeCloseTo(rendered.amount, 6);
  });

  it("publishes every declared control from ONE node, the way Mouse publishes x/y/buttons", () => {
    const { bag } = render(
      documentWith({
        controls: "cutoff pan",
        cutoffAddress: "/synth/cutoff",
        cutoffRest: 0.25,
        panAddress: "/pad/xy/1",
        panRest: -1,
      }),
      { "osc:/synth/cutoff": 0.5, "osc:/pad/xy/1": 0.8 },
    );
    expect(bag).toEqual({ cutoff: 0.5, pan: 0.8 });
  });

  it("reads the address it was pointed at, and not a neighbouring one", () => {
    // Both directions: a reading under a DIFFERENT address must not be picked up, or
    // pointing a row anywhere would silently mean nothing.
    expect(render(documentWith(CUTOFF), { "osc:/synth/other": 0.9 }).opacity).toBeCloseTo(0.25, 6);
  });
});

describe("A DOCUMENT WITH NO HELPER LOADS AND RENDERS (§T715, §T948, §V353)", () => {
  /*
   * The three absences a user actually meets — no helper, no port, nothing sent — all
   * reaching the same place: a compiled plan with no errors and every driven parameter
   * holding a defined number. §T715's constraint verbatim.
   */
  it("no channel seam whatsoever is a degraded render, not a broken one", () => {
    // A hosted build, a stopped helper and a headless render are all this case. `channels`
    // is not merely empty, it is ABSENT — the shape a value graph built without the hook
    // actually has.
    const none = render(
      documentWith({ controls: "cutoff pan", cutoffAddress: "/synth/cutoff", cutoffRest: 0.25, panAddress: "/synth/pan", panRest: -1 }),
      null,
    );
    expect(none.errors).toEqual([]);
    // The DECLARED rests, not zeros: a control whose neutral is not zero must not open
    // hard over (§V353's rule — deterministic silence is not a blind number).
    expect(none.bag).toEqual({ cutoff: 0.25, pan: -1 });
    expect(none.opacity).toBeCloseTo(0.25, 6);
    expect(none.amount).toBeCloseTo(0.25, 6);
  });

  it("a helper that is attached but silent is the same degraded render", () => {
    const silent = render(documentWith(CUTOFF), {});
    expect(silent.errors).toEqual([]);
    expect(silent.bag).toEqual({ cutoff: 0.25 });
  });

  it("a control that was named but never pointed anywhere still publishes, at its rest", () => {
    expect(render(documentWith({ controls: "waiting", waitingRest: 0.4 }), { "osc:/synth/cutoff": 1 }).bag).toEqual({
      waiting: 0.4,
    });
  });

  it("an address that could never be published is treated as UNBOUND, not as a live name", () => {
    // `:` collides with the value graph's own `name:channel` separator, so an address
    // carrying one is refused at the seam. The row still exists and still publishes.
    expect(render(documentWith({ controls: "bad", badAddress: "/a:b", badRest: 0.3 }), { "osc:/a:b": 1 }).bag).toEqual({
      bad: 0.3,
    });
  });

  it("publishes a NUMBER for every declared channel — never an absent one", () => {
    // §V353's reasoning: a missing channel would dangle every driven parameter, where a
    // rest keeps the whole graph evaluating.
    const { bag } = render(documentWith({ controls: "a b c" }), null);
    expect(Object.keys(bag)).toEqual(["a", "b", "c"]);
    for (const value of Object.values(bag)) expect(Number.isFinite(value)).toBe(true);
  });
});

describe("OSC OUT is a WIRE that also listens", () => {
  function throughOscOut(feed: Record<string, unknown>): Readonly<Record<string, number>> {
    const document = {
      revision: 1,
      groups: {},
      nodes: {
        osc: {
          id: "osc",
          type: "oscIn",
          definitionVersion: 1,
          position: { x: 0, y: 0 },
          label: "osc1",
          parameters: { port: 9000, ...feed },
        },
        send: {
          id: "send",
          type: "oscOut",
          definitionVersion: 1,
          position: { x: 200, y: 0 },
          label: "send1",
          parameters: { host: "127.0.0.1", port: 9001, address: "/loom" },
        },
      },
      edges: {
        e1: { id: "e1", source: { nodeId: "osc", portId: "out" }, target: { nodeId: "send", portId: "in" } },
      },
    } as unknown as GraphDocument;
    const session = createValueGraphSession(registry);
    const values = session.evaluate(document, frame, { channels: () => 0.5 });
    return values.byName.get("send1") ?? {};
  }

  it("passes its input bag through unchanged, so it can sit inline in a chain", () => {
    // The passthrough is what lets a plot on this node show exactly what is being sent,
    // and it is also what makes `valueEvaluate` PURE — the send is pumped from the live
    // session, so an offline render of this document transmits nothing.
    expect(throughOscOut({ controls: "a b", aAddress: "/x", bAddress: "/y" })).toEqual({ a: 0.5, b: 0.5 });
  });

  it("has no default destination — a fresh node ships with none (§T950 gap 4)", () => {
    const schema = effectiveParameterSchema(registry.get("oscOut"), {});
    const host = schema["host"];
    const port = schema["port"];
    expect(host?.type === "string" ? host.default : "unset").toBe("");
    expect(port?.type === "number" ? port.default : -1).toBe(0);
  });
});

describe("§V329 — the classification has a CONSEQUENCE, not just an entry", () => {
  it("a render over OSC In warns, and names the node", () => {
    // The gate in `reproducibility.test.ts` only proves the node was classified. This
    // proves the classification does something: delete the entry and this fails too.
    const warning = nonReproducibleRenderWarning(documentWith(CUTOFF), registry);
    expect(warning).not.toBeNull();
    expect(warning?.severity).toBe("warning");
    expect(warning?.message).toContain('OSC In "osc1"');
  });

  it("OSC Out alone does NOT warn — it is a wire, and its render reproduces", () => {
    // The other half of the classification, and the one that could be wrong quietly: a
    // document that only SENDS renders the same pixels every time, so warning about it
    // would be crying wolf on every export (§V91's spirit).
    const sendOnly = {
      revision: 1,
      groups: {},
      nodes: {
        lfo: { id: "lfo", type: "lfo", definitionVersion: 1, position: { x: 0, y: 0 }, label: "lfo1", parameters: {} },
        send: {
          id: "send",
          type: "oscOut",
          definitionVersion: 1,
          position: { x: 200, y: 0 },
          label: "send1",
          parameters: { host: "127.0.0.1", port: 9001 },
        },
      },
      edges: { e1: { id: "e1", source: { nodeId: "lfo", portId: "out" }, target: { nodeId: "send", portId: "in" } } },
    } as unknown as GraphDocument;
    expect(nonReproducibleRenderWarning(sendOnly, registry)).toBeNull();
  });
});
