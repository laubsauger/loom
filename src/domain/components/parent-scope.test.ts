import { describe, expect, it } from "vitest";
import {
  buildParentScope,
  formatParentReference,
  lookupParentScope,
  parentScopeDrivers,
  parseParentReference,
} from "./parent-scope.ts";
import { node } from "./test-support.ts";

/** §V81 — `parent.<key>` is lexical, resolved by walking the instance chain. */

describe("parseParentReference", () => {
  it("reads one hop", () => {
    expect(parseParentReference("parent.blur")).toEqual({ hops: 1, key: "blur" });
  });

  it("reads several hops for a deeply nested component", () => {
    expect(parseParentReference("parent.parent.parent.mix")).toEqual({ hops: 3, key: "mix" });
  });

  it("is not a reference without a key or without a hop", () => {
    expect(parseParentReference("parent.")).toBeNull();
    expect(parseParentReference("parent")).toBeNull();
    expect(parseParentReference("sibling.blur")).toBeNull();
    expect(parseParentReference("blur")).toBeNull();
  });

  it("round-trips", () => {
    expect(formatParentReference({ hops: 2, key: "gain" })).toBe("parent.parent.gain");
  });
});

describe("lookupParentScope", () => {
  // Outermost first, exactly as a resolved path hands them over.
  const scope = buildParentScope([{ mix: 0.25 }, { gain: 3 }, { blur: 7 }]);

  it("resolves the owning component at one hop", () => {
    const found = lookupParentScope(scope, { hops: 1, key: "blur" });
    expect(found).toMatchObject({ found: true, value: 7 });
  });

  it("resolves two and three levels out", () => {
    expect(lookupParentScope(scope, { hops: 2, key: "gain" })).toMatchObject({ value: 3 });
    expect(lookupParentScope(scope, { hops: 3, key: "mix" })).toMatchObject({ value: 0.25 });
  });

  it("REPORTS an unknown key instead of quietly returning undefined", () => {
    const found = lookupParentScope(scope, { hops: 1, key: "nope" });
    expect(found.found).toBe(false);
    if (found.found) throw new Error("unreachable");
    expect(found.reason).toBe("unknown-key");
    // The message names what IS published, because "undefined" is not a bug report.
    expect(found.message).toContain("blur");
  });

  it("reports reaching past the outermost component", () => {
    const found = lookupParentScope(scope, { hops: 4, key: "mix" });
    expect(found).toMatchObject({ found: false, reason: "too-deep" });
  });

  it("reports a binding evaluated outside any component", () => {
    expect(lookupParentScope(undefined, { hops: 1, key: "blur" })).toMatchObject({
      found: false,
      reason: "no-scope",
    });
  });

  it("does not read inherited object properties as published parameters", () => {
    // `parent.constructor` must not resolve to Object's constructor.
    const found = lookupParentScope(buildParentScope([{}]), { hops: 1, key: "constructor" });
    expect(found).toMatchObject({ found: false, reason: "unknown-key" });
  });
});

describe("parentScopeDrivers", () => {
  const radius = { type: "number", label: "Radius", default: 4, min: 0, max: 64 } as const;

  it("drives only the parameters that declare a binding", () => {
    const bound = node("b1", "test.blur", { radius: 4 }, {
      state: { parentBindings: { radius: "parent.blur" } },
    });
    const drivers = parentScopeDrivers(bound, buildParentScope([{ blur: 12 }]));
    expect(Object.keys(drivers)).toEqual(["radius"]);
    expect(drivers.radius?.({ node: bound, key: "radius", definition: radius })).toBe(12);
  });

  it("falls back to the stored value and reports when the parent has no such key", () => {
    const bound = node("b1", "test.blur", { radius: 4 }, {
      state: { parentBindings: { radius: "parent.nope" } },
    });
    const diagnostics: string[] = [];
    const drivers = parentScopeDrivers(bound, buildParentScope([{ blur: 12 }]), {
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic.code),
    });
    expect(drivers.radius?.({ node: bound, key: "radius", definition: radius })).toBeUndefined();
    expect(diagnostics).toEqual(["component.parentScope.unknown-key"]);
  });

  it("refuses a parent value the internal parameter cannot hold", () => {
    const bound = node("b1", "test.blur", { radius: 4 }, {
      state: { parentBindings: { radius: "parent.blur" } },
    });
    const diagnostics: string[] = [];
    const drivers = parentScopeDrivers(bound, buildParentScope([{ blur: "loud" }]), {
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic.code),
    });
    expect(drivers.radius?.({ node: bound, key: "radius", definition: radius })).toBeUndefined();
    expect(diagnostics).toEqual(["component.parentScope.type"]);
  });

  it("reports a malformed binding rather than treating it as a value", () => {
    const bound = node("b1", "test.blur", { radius: 4 }, {
      state: { parentBindings: { radius: "blur" } },
    });
    const diagnostics: string[] = [];
    const drivers = parentScopeDrivers(bound, buildParentScope([{ blur: 12 }]), {
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic.code),
    });
    expect(drivers.radius?.({ node: bound, key: "radius", definition: radius })).toBeUndefined();
    expect(diagnostics).toEqual(["component.parentScope.malformed"]);
  });
});
