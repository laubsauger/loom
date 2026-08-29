import { describe, expect, it } from "vitest";

import {
  HARD_LIMITS,
  checkBufferBytes,
  checkDispatch,
  checkMemoryBudget,
  checkResolution,
  clampNodeResolutions,
  clampSettings,
  estimateProjectMemoryBytes,
} from "./limits.ts";
import { loadProject } from "./load.ts";
import { serializeProjectDocument } from "./serialize.ts";
import { definitionSource, testDefinition, testDocument, testSettings } from "./test-support.ts";

/**
 * T44 / §V24 — resource caps.
 *
 * The scenario these guard is a `.loom.json` that is not merely wrong but hostile: a
 * 30000 x 30000 output, a limits block that has been edited to permit it, a per-node
 * override big enough to exhaust the device. §V24 says over-cap gets a diagnostic and a
 * refusal — never a device loss — and the only place that can be true for a FILE is
 * before the graph is compiled, which is here.
 */

const limits = testSettings().limits;

describe("individual caps", () => {
  it("passes a value in range untouched", () => {
    expect(checkResolution(1920, limits)).toEqual({ ok: true, value: 1920, diagnostic: null });
  });

  it("clamps an absurd resolution and says what it did", () => {
    const check = checkResolution(30_000, limits);
    expect(check.ok).toBe(false);
    expect(check.value).toBe(limits.maxResolution);
    expect(check.diagnostic?.severity).toBe("error");
    expect(check.diagnostic?.code).toBe("project.limit.resolution");
    expect(check.diagnostic?.message).toContain("30,000");
  });

  it("rejects a value that is not a positive number at all", () => {
    for (const value of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(checkResolution(value, limits).ok).toBe(false);
    }
  });

  it("caps dispatch size and buffer bytes the same way", () => {
    expect(checkDispatch(1_000_000, limits).value).toBe(limits.maxDispatch);
    expect(checkBufferBytes(limits.maxBufferBytes * 4, limits).value).toBe(limits.maxBufferBytes);
    expect(checkDispatch(256, limits).ok).toBe(true);
    expect(checkBufferBytes(1024, limits).ok).toBe(true);
  });
});

describe("a document's own limits are not believed on sight", () => {
  it("clamps the limits block itself before anything is checked against it", () => {
    // The attack: raise maxResolution in the file, then ask for a texture that size.
    const settings = testSettings({
      outputResolution: { width: 30_000, height: 30_000 },
      limits: { ...limits, maxResolution: 1_000_000 },
    });

    const result = clampSettings(settings);

    expect(result.settings.limits.maxResolution).toBe(HARD_LIMITS.maxResolution);
    expect(result.settings.outputResolution).toEqual({
      width: HARD_LIMITS.maxResolution,
      height: HARD_LIMITS.maxResolution,
    });
    expect(result.clamped).toBe(true);
    expect(result.diagnostics.map((d) => d.code)).toContain("project.limit.settings");
  });

  it("leaves a sane settings block completely alone", () => {
    const settings = testSettings();
    const result = clampSettings(settings);
    expect(result.clamped).toBe(false);
    expect(result.settings).toEqual(settings);
    expect(result.diagnostics).toEqual([]);
  });
});

describe("per-node resolution overrides are clamped too (§V50)", () => {
  it("clamps a fixed override and names the node", () => {
    const document = testDocument();
    const node = document.graph.nodes["n1"];
    if (node === undefined) throw new Error("fixture");
    node.resolution = { mode: "fixed", width: 30_000, height: 20_000 };

    const result = clampNodeResolutions(document.graph, limits);

    expect(result.graph.nodes["n1"]?.resolution).toEqual({
      mode: "fixed",
      width: limits.maxResolution,
      height: limits.maxResolution,
    });
    expect(result.clamped).toBe(true);
    expect(result.diagnostics[0]?.nodeId).toBe("n1");
    expect(result.diagnostics[0]?.code).toBe("project.limit.nodeResolution");
  });

  it("does not touch a mode it does not understand (§V68)", () => {
    const document = testDocument();
    const node = document.graph.nodes["n1"];
    if (node === undefined) throw new Error("fixture");
    node.resolution = { mode: "aspect", ratio: "16:9" } as never;

    const result = clampNodeResolutions(document.graph, limits);

    expect(result.clamped).toBe(false);
    expect(result.graph.nodes["n1"]?.resolution).toEqual({ mode: "aspect", ratio: "16:9" });
  });
});

describe("the project memory budget is reported", () => {
  it("estimates from the nodes' actual sizes", () => {
    const document = testDocument();
    // Two nodes at 1920x1080, rgba16float = 8 bytes per texel.
    expect(estimateProjectMemoryBytes(document)).toBe(2 * 1920 * 1080 * 8);
    expect(checkMemoryBudget(document)).toBeNull();
  });

  it("warns when the estimate is already over the project's budget", () => {
    const document = testDocument({
      settings: testSettings({ limits: { ...limits, memoryBudgetBytes: 1024 } }),
    });
    const diagnostic = checkMemoryBudget(document);

    expect(diagnostic?.code).toBe("project.limit.memoryBudget");
    expect(diagnostic?.severity).toBe("warning");
  });
});

describe("caps are enforced at load, before the graph can reach a device", () => {
  it("opens a hostile document clamped, with diagnostics, rather than passing it on", () => {
    const document = testDocument({
      settings: testSettings({
        outputResolution: { width: 30_000, height: 30_000 },
        limits: { ...limits, maxResolution: 1_000_000 },
      }),
    });
    const node = document.graph.nodes["n1"];
    if (node === undefined) throw new Error("fixture");
    node.resolution = { mode: "fixed", width: 30_000, height: 30_000 };

    const loaded = loadProject(serializeProjectDocument(document), {
      nodes: definitionSource([testDefinition({ type: "gradient" }), testDefinition({ type: "output" })]),
    });
    if (!loaded.ok) throw new Error(loaded.reason);

    expect(loaded.document.settings.outputResolution.width).toBe(HARD_LIMITS.maxResolution);
    expect(loaded.document.graph.nodes["n1"]?.resolution).toEqual({
      mode: "fixed",
      width: HARD_LIMITS.maxResolution,
      height: HARD_LIMITS.maxResolution,
    });
    // The in-memory document is no longer the file, and the app is told.
    expect(loaded.changed).toBe(true);
    const codes = loaded.diagnostics.map((diagnostic) => diagnostic.code);
    expect(codes).toContain("project.limit.settings");
    expect(codes).toContain("project.limit.nodeResolution");
  });
});
