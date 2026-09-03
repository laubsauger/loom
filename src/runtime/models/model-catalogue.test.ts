import { describe, expect, it } from "vitest";
import { ALL_MODELS, DEPTH_ACCURATE, DEPTH_LIVE, DEPTH_PROVIDERS, MATTE_RVM, POSE_ACCURATE, POSE_LIVE, unreachableWithoutRemedy } from "./model-catalogue.ts";

describe("the pinned model catalogue", () => {
  it("pins every model immutably — a revision in the URL, or a hash of the bytes", () => {
    // A moving ref changes the bytes under a document without the document changing,
    // which would make "same graph, same picture" quietly untrue and defeat replay.
    //
    // T1040 widened this from "a 40-hex revision path" to "pinned by SOMETHING", because
    // RVM is a GitHub release asset at a tagged version and has no `/resolve/<sha>/` to
    // match. That is not a weaker pin: a revision path trusts the HOST to keep serving the
    // same bytes under the same name, a recorded hash CHECKS the bytes that arrived, and
    // acquisition refuses a mismatch. Either satisfies this; neither does not.
    for (const model of ALL_MODELS) {
      expect(model.url).not.toContain("/resolve/main/");
      const revisionPinned = /\/resolve\/[0-9a-f]{40}\//.test(model.url);
      const hashPinned = /^[0-9a-f]{64}$/.test(model.sha256 ?? "");
      expect({ id: model.id, pinned: revisionPinned || hashPinned }).toEqual({
        id: model.id,
        pinned: true,
      });
    }
  });

  it("carries the byte counts measured from content-length, not from the model card", () => {
    // Acquisition refuses anything that does not match these, so a wrong number here
    // would reject the real file rather than accept a corrupt one.
    expect(DEPTH_ACCURATE.bytes).toBe(99_060_839);
    expect(DEPTH_LIVE.bytes).toBe(19_126_267);
    expect(POSE_ACCURATE.bytes).toBe(9_366_903);
    expect(POSE_LIVE.bytes).toBe(2_598_245);
    // T1040 — read off the artefact twice, on two days' downloads.
    expect(MATTE_RVM.bytes).toBe(14_975_696);
    expect(MATTE_RVM.sha256).toBe(
      "88d4531297118f595bf2fd60f6f566aec2e559393802d1f436c380f0cbbd2828",
    );
  });

  it("gives every model a unique id, or the cache would serve one for another", () => {
    const ids = ALL_MODELS.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("keeps every variant of the same repository on one licence", () => {
    // The original claim was "one licence and one host" for the whole catalogue, which was
    // true while every artefact was a HuggingFace conversion and stopped being true when
    // RVM arrived from its author's own GitHub release under GPL-3.0. The property worth
    // keeping is the one the depth pair was built on: two weight files from ONE repository
    // are one acquisition story and cannot disagree about their terms.
    const byRepo = new Map<string, Set<string>>();
    for (const model of ALL_MODELS) {
      const repo = model.url.split("/").slice(0, 5).join("/");
      const licences = byRepo.get(repo) ?? new Set<string>();
      licences.add(model.license);
      byRepo.set(repo, licences);
    }
    for (const [repo, licences] of byRepo) {
      expect({ repo, licences: [...licences].length }).toEqual({ repo, licences: 1 });
    }
  });

  it("names the copyleft artefacts, so a second one re-opens the ruling", () => {
    // §V858 ruled GPL-3.0 no bar HERE, on one specific artefact, because the weights are
    // fetched by the user's browser at run time and never redistributed by us. That ruling
    // is about a fetch, not about copyleft in general, so it must not be inherited silently
    // by whatever lands next: a second GPL model turns this red and someone re-reads it.
    expect(ALL_MODELS.filter((m) => m.license.startsWith("GPL")).map((m) => m.id)).toEqual([
      "rvm-mobilenetv3",
    ]);
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
