import { describe, expect, it } from "vitest";

import type { NodeDefinition } from "../../domain/types/node-definition.ts";
import { NodeDefinitionError, createNodeRegistry, isStatefulNode, validateNodeDefinition } from "./registry.ts";
import { createTestRegistry, feedbackNode, solidNode } from "./test-nodes.ts";

/** Node registry (§I.registry, T12) and the §V46 stateful declaration (T66). */

const base = (overrides: Partial<NodeDefinition> = {}): NodeDefinition => ({
  type: "x.test",
  version: 1,
  title: "Test",
  category: "test",
  inputs: [],
  outputs: [{ id: "out", label: "Out", type: { kind: "texture2d", sample: "float", channels: 4 } }],
  parameters: {},
  compile: () => ({ passes: [] }),
  ...overrides,
});

describe("node registry (§I.registry)", () => {
  it("registers, looks up, and lists definitions deterministically", () => {
    const registry = createTestRegistry();
    expect(registry.has("test.solid")).toBe(true);
    expect(registry.get("test.solid")?.title).toBe("Solid");
    const types = registry.list().map((definition) => definition.type);
    expect(types).toEqual([...types].sort());
    expect(registry.categories()).toEqual([...registry.categories()].sort());
  });

  it("throws with a diagnostic for an unknown type rather than returning a stub", () => {
    const registry = createTestRegistry();
    expect(() => registry.require("test.nope")).toThrow(NodeDefinitionError);
    try {
      registry.require("test.nope");
    } catch (error) {
      expect((error as NodeDefinitionError).diagnostics[0]?.code).toBe("node.unknownType");
    }
  });

  it("refuses a duplicate type registration", () => {
    const registry = createNodeRegistry([solidNode]);
    expect(() => registry.register(solidNode)).toThrow(/already registered/);
  });

  it("resolves ports by direction", () => {
    const registry = createTestRegistry();
    expect(registry.port("test.blur", "source", "input")?.label).toBe("Source");
    // "source" is an input, so it must not resolve as an output.
    expect(registry.port("test.blur", "source", "output")).toBeUndefined();
    expect(registry.port("test.composite", "layers", "input")?.variadic).toBe(true);
  });

  it("hands out a read-only view with no register method", () => {
    const view = createTestRegistry().view() as unknown as Record<string, unknown>;
    expect(view["register"]).toBeUndefined();
    expect(view["has"]).toBeTypeOf("function");
  });

  it("rejects duplicate port ids and empty types", () => {
    expect(
      validateNodeDefinition(
        base({
          inputs: [{ id: "a", label: "A", type: { kind: "event" } }],
          outputs: [{ id: "a", label: "A", type: { kind: "event" } }],
        }),
      ).map((d) => d.code),
    ).toContain("node.port.duplicate");
    expect(validateNodeDefinition(base({ type: "" })).map((d) => d.code)).toContain("node.type");
    expect(validateNodeDefinition(base({ version: 0 })).map((d) => d.code)).toContain("node.version");
  });

  it("rejects a manifest whose own parameter default is invalid", () => {
    const diagnostics = validateNodeDefinition(
      base({ parameters: { amount: { type: "number", label: "Amount", default: 5, min: 0, max: 1 } } }),
    );
    expect(diagnostics.map((d) => d.code)).toContain("node.parameter.default");
  });

  it("rejects an enum default that is not one of its options", () => {
    const diagnostics = validateNodeDefinition(
      base({
        parameters: {
          mode: { type: "enum", label: "Mode", default: "nope", options: [{ value: "over", label: "Over" }] },
        },
      }),
    );
    expect(diagnostics.map((d) => d.code)).toContain("node.parameter.default");
  });
});

describe("stateful declaration (§V46)", () => {
  it("accepts a temporal node that declares its behaviour", () => {
    expect(validateNodeDefinition(feedbackNode)).toEqual([]);
    expect(isStatefulNode(feedbackNode)).toBe(true);
    expect(createTestRegistry().statefulDeclaration("test.feedback")).toEqual({
      reset: true,
      deterministicReplay: true,
      checkpoint: false,
      randomAccess: false,
    });
  });

  it("refuses a temporal node with no stateful declaration", () => {
    const undeclared = base({
      type: "x.feedback",
      temporal: { outputs: ["out"], resetOn: ["device"] },
    });
    const diagnostics = validateNodeDefinition(undeclared);
    expect(diagnostics.map((d) => d.code)).toContain("node.stateful.undeclared");
    expect(() => createNodeRegistry().register(undeclared)).toThrow(NodeDefinitionError);
  });

  it("refuses a temporal output that is not an actual output port", () => {
    const diagnostics = validateNodeDefinition(
      base({
        temporal: { outputs: ["ghost"], resetOn: ["load"] },
        stateful: { reset: true, deterministicReplay: true, checkpoint: false, randomAccess: false },
      }),
    );
    expect(diagnostics.map((d) => d.code)).toContain("node.temporal.port");
  });

  it("refuses randomAccess without deterministicReplay", () => {
    const diagnostics = validateNodeDefinition(
      base({ stateful: { reset: true, deterministicReplay: false, checkpoint: true, randomAccess: true } }),
    );
    expect(diagnostics.map((d) => d.code)).toContain("node.stateful.inconsistent");
  });

  it("reports a stateless node as stateless", () => {
    expect(isStatefulNode(solidNode)).toBe(false);
    expect(createTestRegistry().statefulDeclaration("test.solid")).toBeUndefined();
  });
});
