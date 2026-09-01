import { describe, expect, it } from "vitest";
import { ALL_MODELS, DEPTH_ACCURATE, DEPTH_LIVE, DEPTH_PROVIDERS, POSE_ACCURATE, POSE_LIVE, unreachableWithoutRemedy } from "./model-catalogue.ts";

describe("the pinned model catalogue", () => {
  it("pins every model to a revision, never to a moving reference", () => {
    // A moving ref changes the bytes under a document without the document changing,
    // which would make "same graph, same picture" quietly untrue and defeat replay.
    for (const model of ALL_MODELS) {
      expect(model.url).not.toContain("/resolve/main/");
      expect(model.url).toMatch(/\/resolve\/[0-9a-f]{40}\//);
    }
  });

  it("carries the byte counts measured from content-length, not from the model card", () => {
    // Acquisition refuses anything that does not match these, so a wrong number here
    // would reject the real file rather than accept a corrupt one.
    expect(DEPTH_ACCURATE.bytes).toBe(99_060_839);
    expect(DEPTH_LIVE.bytes).toBe(19_126_267);
    expect(POSE_ACCURATE.bytes).toBe(9_366_903);
    expect(POSE_LIVE.bytes).toBe(2_598_245);
  });

  it("gives every model a unique id, or the cache would serve one for another", () => {
    const ids = ALL_MODELS.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("keeps every variant on one licence and one host", () => {
    for (const model of ALL_MODELS) {
      expect(model.license).toBe("Apache-2.0");
      expect(model.url.startsWith("https://huggingface.co/")).toBe(true);
    }
  });
});

describe("the declared provider set (T736)", () => {
  /**
   * The point of naming unreachable providers at all: a provider that silently falls back
   * removes the choice by hiding it, and the owner asked for cross-platform CHOICE. So an
   * unreachable slot must carry what would change it, or the deferral becomes permanent
   * by forgetting — §V205's lesson, applied to platforms instead of factories.
   */
  it("requires every unreachable provider to name what would unblock it", () => {
    expect(unreachableWithoutRemedy()).toEqual([]);
  });

  it("declares Core ML unreachable from a page, with the desktop-shell condition", () => {
    const coreml = DEPTH_PROVIDERS.find((p) => p.id === "coreml");
    expect(coreml?.reachable).toBe(false);
    expect(coreml?.note).toContain("desktop shell");
  });

  it("keeps at least one reachable provider, or Depth could never run anywhere", () => {
    expect(DEPTH_PROVIDERS.filter((p) => p.reachable).length).toBeGreaterThan(0);
  });
});
