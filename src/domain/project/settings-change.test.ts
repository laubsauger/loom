import { describe, expect, it } from "vitest";
import { DEFAULT_PROJECT_SETTINGS } from "../types/graph.ts";
import type { ProjectSettings } from "../types/graph.ts";
import { classifySettingsChange, structuralSettingsKey } from "./settings-change.ts";

/**
 * §V178 — settings edits classify PER FIELD (T272).
 *
 * The invariant exists because of one specific mistake: treating "settings changed" as a
 * single event, so dragging an fps field rebuilds every GPU resource sixty times a second
 * — and does so BECAUSE the user is adjusting how often it draws.
 */

const base: ProjectSettings = DEFAULT_PROJECT_SETTINGS;
const withSettings = (patch: Partial<ProjectSettings>): ProjectSettings => ({ ...base, ...patch });

describe("what a settings edit costs", () => {
  it("calls a RATE change non-structural — the whole point of §V178", () => {
    for (const patch of [{ fps: 30 }, { previewFps: 10 }, { previewLongEdge: 96 }]) {
      const change = classifySettingsChange(base, withSettings(patch));
      expect(change.changed).toEqual(Object.keys(patch));
      expect(change.structural).toBe(false);
    }
  });

  it("calls resolution, format and limits STRUCTURAL", () => {
    const patches: Array<Partial<ProjectSettings>> = [
      { outputResolution: { width: 3840, height: 2160 } },
      { workingFormat: "rgba8unorm" },
      { limits: { ...base.limits, maxResolution: 8192 } },
    ];
    for (const patch of patches) {
      expect(classifySettingsChange(base, withSettings(patch)).structural).toBe(true);
    }
  });

  it("calls the SEED structural, although no pipeline depends on it", () => {
    // The plan captures the seed at compile time (§V45: same seed, same field, on any
    // GPU). Classifying it as a rate would make the edit silently do nothing, which is
    // worse than the rebuild it costs.
    expect(classifySettingsChange(base, withSettings({ randomSeed: 9 })).structural).toBe(true);
  });

  it("reports NO change when a field is set to what it already is", () => {
    // Not an error and not an edit: this must not burn a revision, an undo slot, or a
    // recompile — which is exactly what an identity comparison would have done.
    const change = classifySettingsChange(base, withSettings({ outputResolution: { ...base.outputResolution } }));
    expect(change.changed).toEqual([]);
    expect(change.structural).toBe(false);
  });

  it("sees through a rebuilt nested object", () => {
    // `{width, height}` compared by reference would read as changed on every edit that
    // spread the settings — recompiling the world for a fps drag.
    const rebuilt = withSettings({ limits: { ...base.limits } });
    expect(classifySettingsChange(base, rebuilt).changed).toEqual([]);
  });

  it("names every field that differs, not just the first", () => {
    const change = classifySettingsChange(base, withSettings({ fps: 24, randomSeed: 3 }));
    expect(change.changed).toEqual(["fps", "randomSeed"]);
    expect(change.structural).toBe(true);
  });
});

describe("the structural key is what a compile may depend on", () => {
  it("is UNCHANGED by every non-structural field", () => {
    const key = structuralSettingsKey(base);
    for (const patch of [{ fps: 24 }, { previewFps: 5 }, { previewLongEdge: 64 }]) {
      expect(structuralSettingsKey(withSettings(patch))).toBe(key);
    }
  });

  it("changes for every structural field", () => {
    const key = structuralSettingsKey(base);
    const patches: Array<Partial<ProjectSettings>> = [
      { outputResolution: { width: 640, height: 480 } },
      { workingFormat: "rgba8unorm" },
      { randomSeed: 42 },
      { limits: { ...base.limits, maxDispatch: 1024 } },
    ];
    for (const patch of patches) {
      expect(structuralSettingsKey(withSettings(patch))).not.toBe(key);
    }
  });

  it("is stable across a rebuilt-but-equal settings object", () => {
    // The key is what the compile memo compares; if it were identity-sensitive the memo
    // would miss every cache hit and §V178 would be unenforceable.
    expect(structuralSettingsKey({ ...base, limits: { ...base.limits } })).toBe(
      structuralSettingsKey(base),
    );
  });
});
