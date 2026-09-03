import { describe, expect, it } from "vitest";
import type { GraphComponentDefinition } from "../types/components.ts";
import {
  componentInstanceStateSchema,
  componentLibrarySchema,
  graphComponentDefinitionSchema,
  parseComponentDefinition,
  serializeComponentLibrary,
} from "./schemas.ts";
import { blurKnob, bloomComponent, graphOf, instanceNode, node } from "./test-support.ts";

/** T128 — the serialized surface. §V10: what is written must come back identical. */

const rich: GraphComponentDefinition = {
  ...bloomComponent("bloom", 3, [
    blurKnob,
    {
      key: "tint",
      definition: {
        type: "color",
        label: "Tint",
        default: [1, 0.5, 0.25, 1],
        space: "display",
        group: "Look",
      },
      targets: [{ nodeId: "blurA", key: "tint" }],
    },
    {
      key: "mode",
      definition: {
        type: "enum",
        label: "Mode",
        default: "over",
        options: [
          { value: "over", label: "Over" },
          { value: "add", label: "Add" },
        ],
      },
      targets: [],
    },
  ]),
  description: "Threshold, blur, add.",
  capabilities: [{ feature: "float32-filterable", reason: "HDR blur" }],
  migrations: [{ fromVersion: 1, toVersion: 2, description: "Radius became Blur." }],
};

describe("component definition round trip", () => {
  it("survives serialize -> JSON -> parse unchanged", () => {
    const encoded = JSON.parse(JSON.stringify(rich)) as unknown;
    const parsed = parseComponentDefinition(encoded);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error(parsed.issues.join("; "));
    expect(parsed.definition).toEqual(rich);
  });

  it("keeps the internal graph, including a nested component instance", () => {
    const nested: GraphComponentDefinition = {
      ...bloomComponent("outer", 1),
      graph: graphOf([
        instanceNode("inner", "bloom", 2, { blur: 6 }),
        node("b", "test.blur", { radius: 3 }, { ui: { bypassed: true } }),
      ]),
      inputs: [],
      outputs: [],
    };
    const parsed = graphComponentDefinitionSchema.parse(JSON.parse(JSON.stringify(nested)));
    expect(parsed.graph.nodes.inner?.type).toBe("component:bloom@2");
    expect(parsed.graph.nodes.b?.ui?.bypassed).toBe(true);
  });

  it("round-trips a whole library", () => {
    const library = serializeComponentLibrary([rich, bloomComponent("other", 1, [blurKnob])]);
    const parsed = componentLibrarySchema.parse(JSON.parse(JSON.stringify(library)));
    expect(parsed.components).toHaveLength(2);
    expect(parsed.schemaVersion).toBe(1);
  });

  it("rejects a componentId containing the version separator", () => {
    const parsed = parseComponentDefinition({ ...rich, componentId: "bloom@2" });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) throw new Error("unreachable");
    expect(parsed.issues.join(" ")).toContain("@");
  });

  it("rejects a version that is not a positive integer, since it is the pin (§V84)", () => {
    expect(parseComponentDefinition({ ...rich, version: 0 }).ok).toBe(false);
    expect(parseComponentDefinition({ ...rich, version: 1.5 }).ok).toBe(false);
  });

  it("reports where a bad definition went wrong instead of a bare false", () => {
    const parsed = parseComponentDefinition({ ...rich, inputs: [{ externalId: "" }] });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) throw new Error("unreachable");
    expect(parsed.issues.some((issue) => issue.startsWith("inputs.0."))).toBe(true);
  });
});

/**
 * T856 follow-up — the missing `code` arm, as the LIBRARY LOSS it actually was.
 *
 * Not a stripped key like §B111's `range`: a `z.discriminatedUnion` with no arm for the
 * discriminator it is handed REFUSES, and `componentLibrarySchema` wraps the definitions
 * in an array, so one published code parameter failed the parse of the whole file. The
 * observable in `starter-set.ts` is "no readable component library" — every component in
 * that document gone, including the ones with nothing wrong with them.
 *
 * The `source` definition below is `customWgsl`'s, copied rather than imported so this
 * gate keeps asserting the shape a component can carry even if that node moves. Eight
 * more ship beside it (midiIn, the four point-kernel slots, three on points).
 */
const codeKnob = {
  key: "source",
  definition: {
    type: "code",
    language: "wgsl",
    label: "Source",
    default: "fn main() -> vec4f { return vec4f(1.0); }",
    compileTime: true,
  },
  targets: [{ nodeId: "blurA", key: "source" }],
} as const satisfies GraphComponentDefinition["parameters"][number];

describe("a published code parameter (T856 follow-up)", () => {
  it("survives the round trip with its language and default intact", () => {
    const withCode: GraphComponentDefinition = bloomComponent("wgsl-fx", 1, [codeKnob]);
    const parsed = parseComponentDefinition(JSON.parse(JSON.stringify(withCode)) as unknown);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error(parsed.issues.join("; "));
    expect(parsed.definition).toEqual(withCode);
  });

  it("does not take the rest of the library down with it (starter-set's whole-file refusal)", () => {
    const library = serializeComponentLibrary([
      bloomComponent("wgsl-fx", 1, [codeKnob]),
      bloomComponent("plain", 1, [blurKnob]),
    ]);
    const parsed = componentLibrarySchema.safeParse(JSON.parse(JSON.stringify(library)));
    expect(parsed.success).toBe(true);
    if (!parsed.success) throw new Error(parsed.error.issues.map((i) => i.message).join("; "));
    // The innocent neighbour is the point: an unnamed arm refuses the ARRAY, so "plain"
    // disappeared from the catalogue because a sibling used a code parameter.
    expect(parsed.data.components.map((component) => component.componentId)).toEqual([
      "plain",
      "wgsl-fx",
    ]);
  });
});

describe("instance state round trip (§V79, §V84)", () => {
  it("keeps identity, pinned version, published values and overrides", () => {
    const state = {
      componentId: "bloom",
      version: 2,
      parameters: { blur: 12, tint: [1, 0, 0, 1] },
      overrides: { "blurA/radius": 3 },
    };
    expect(componentInstanceStateSchema.parse(JSON.parse(JSON.stringify(state)))).toEqual(state);
  });

  it("accepts an instance with no overrides at all — the normal case", () => {
    const state = { componentId: "bloom", version: 1, parameters: {} };
    expect(componentInstanceStateSchema.parse(state)).toEqual(state);
  });
});
