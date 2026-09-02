import { readFileSync } from "node:fs";
import { fileURLToPath, URL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  categoryOf,
  compareExamples,
  firstParagraph,
  listExampleProjects,
} from "./example-catalogue.ts";
import type { ExampleCategory, ExampleProject } from "./example-catalogue.ts";
import { filterExamples, matchExampleScore, searchExamples } from "./example-search.ts";
import { categoriesOf, matchScore } from "./search.ts";
import { testNodeDefinitions } from "@nodes/registry/test-nodes.ts";

/**
 * The example library's categories, search and descriptions (T846).
 *
 * Every assertion here is against the SHIPPED set rather than a fixture, for §V88's
 * reason: the category is derived from the file's own node types and the description is
 * the file's own first paragraph, so a fixture would only prove the functions run. What
 * has to be true is that they still answer correctly for the 38 files in `examples/`.
 */

const shipped = listExampleProjects();

function example(overrides: Partial<ExampleProject> = {}): ExampleProject {
  return {
    fileName: "E9-Test.loom.json",
    name: "E9 Test",
    nodeCount: 3,
    text: "{}",
    description: "",
    category: "image",
    ...overrides,
  };
}

describe("category derivation (T846) — from the file's own node types, never declared", () => {
  it("gives every shipped example a category, and no example its own category", () => {
    expect(shipped.length).toBeGreaterThanOrEqual(38);

    const counts = new Map<string, number>();
    for (const entry of shipped) {
      counts.set(entry.category, (counts.get(entry.category) ?? 0) + 1);
    }

    // The point of a taxonomy: a bucket holding one file is a list with extra steps, and
    // a bucket holding most of them has not sorted anything. Both ends are asserted so
    // the 39th example cannot quietly turn this into either.
    for (const [category, count] of counts) {
      expect(count, `${category} holds ${count}`).toBeGreaterThan(1);
      expect(count, `${category} holds ${count}`).toBeLessThan(shipped.length / 2);
    }
    expect(counts.size).toBeGreaterThanOrEqual(4);
  });

  it("resolves overlap by PRECEDENCE, in the order the module declares", () => {
    // The rule that does the work: an audio input outranks everything downstream of it,
    // so a scene full of points that listens is an audio example. Assert the ladder
    // end to end rather than one rung — the ordering IS the design decision.
    const points = "pointKernel";
    expect(categoryOf(["audioPattern", "camera", points, "movieFileIn", "feedback"])).toBe("audio");
    expect(categoryOf(["camera", points, "movieFileIn", "feedback"])).toBe("video");
    expect(categoryOf(["camera", points, "feedback"])).toBe("3d");
    expect(categoryOf([points, "feedback"])).toBe("points");
    expect(categoryOf(["feedback"])).toBe("feedback");
    // The fallback is a real kind, not a leftover: no input, no scene, no points, no loop.
    expect(categoryOf(["noise", "blur", "output"])).toBe("image");
  });

  it("puts the examples the precedence is ABOUT where it says they go", () => {
    const categoryFor = (stem: string): ExampleCategory | undefined =>
      shipped.find((entry) => entry.fileName.startsWith(`${stem}-`))?.category;

    // Each of these STRADDLES the rung above it, which is the only way a shipped-set
    // assertion pins an ordering — an example matching one signature proves nothing
    // about precedence. E43 is audio AND video; E45 is audio over a 3D point scene;
    // E41 is video over a 3D point scene; E34 is 3D over points AND feedback; E9 is
    // points over feedback.
    expect(categoryFor("E43")).toBe("audio");
    expect(categoryFor("E45")).toBe("audio");
    expect(categoryFor("E41")).toBe("video");
    expect(categoryFor("E44")).toBe("video");
    expect(categoryFor("E34")).toBe("3d");
    expect(categoryFor("E25")).toBe("3d");
    expect(categoryFor("E9")).toBe("points");
    expect(categoryFor("E2")).toBe("feedback");
    expect(categoryFor("E5")).toBe("image");
  });

  it("`cache` alone does not make a simulation", () => {
    // It was in the feedback signature and was taken out: holding a frame is not looping.
    expect(categoryOf(["cache", "noise"])).toBe("image");
  });
});

describe("descriptions (T846, §V88) — the example's own `.md`, not a second table", () => {
  it("gives every shipped example the first paragraph of its own document", () => {
    for (const entry of shipped) {
      const stem = entry.fileName.replace(/\.loom\.json$/, "");
      expect(entry.description, `examples/${stem}.md is missing or has no prose`).not.toBe("");
      // Prose, not a heading, not a fence, not a table row — the three things that would
      // silently pass a "non-empty" check while showing the user syntax.
      expect(entry.description.startsWith("#"), entry.fileName).toBe(false);
      expect(entry.description.includes("```"), entry.fileName).toBe(false);
      expect(entry.description.includes("|"), entry.fileName).toBe(false);
      // Flattened to one line: a card lays out its own text.
      expect(entry.description.includes("\n"), entry.fileName).toBe(false);
    }
  });

  it("is the sentence the document actually opens with", () => {
    const sounding = shipped.find((entry) => entry.fileName.startsWith("E44-"));
    expect(sounding?.description.startsWith(
      "A monocular depth model turns a flat picture into a distance map.",
    )).toBe(true);
    // Inline markdown is stripped, so `pointsFromTexture` reads as a word, not as syntax.
    expect(sounding?.description.includes("`")).toBe(false);
    expect(sounding?.description.includes("pointsFromTexture")).toBe(true);
  });

  it("skips headings, fences, tables and quotes rather than showing them", () => {
    expect(firstParagraph("# E9 — Ember\n\nA fire front.\n\nMore.")).toBe("A fire front.");
    expect(firstParagraph("# T\n\n```\nwiring\n```\n\nThe prose.")).toBe("The prose.");
    expect(firstParagraph("# T\n\n| a | b |\n| - | - |\n\nThe prose.")).toBe("The prose.");
    expect(firstParagraph("**bold** and *thin* and `code` and [link](u)")).toBe(
      "bold and thin and code and link",
    );
    // No prose at all yields nothing — never a heading dressed up as a description.
    expect(firstParagraph("# Only a heading")).toBe("");
  });
});

describe("thumbnails (§T847) — absence is a card without a picture, never a broken one", () => {
  it("either carries a url or carries no key at all", () => {
    for (const entry of shipped) {
      if (entry.thumbnailUrl === undefined) continue;
      expect(entry.thumbnailUrl, entry.fileName).not.toBe("");
      expect(entry.thumbnailUrl.endsWith(".png"), entry.fileName).toBe(true);
    }
  });

  it("joins on the loom's own stem, so the seam is the file name and nothing else", () => {
    // The rows that DO have one prove the join; the interface allows the rest to be
    // absent, which is what keeps the 39th example's row correct before its thumb lands.
    const withThumbs = shipped.filter((entry) => entry.thumbnailUrl !== undefined);
    for (const entry of withThumbs) {
      const stem = entry.fileName.replace(/\.loom\.json$/, "");
      expect(entry.thumbnailUrl, entry.fileName).toContain(stem);
    }
  });
});

describe("example search (T846) — the node library's ladder over a different record", () => {
  it("scores by the SAME tiers as the node library, and does not re-derive them", () => {
    // §V748's pin, stated as an assertion rather than as a comment: an example whose
    // name matches exactly and a node whose title matches exactly must score the same,
    // because there is one ladder. A copied ladder would drift the first time it is tuned.
    const node = testNodeDefinitions[0];
    expect(node).toBeDefined();
    if (node === undefined) return;
    expect(matchExampleScore(example({ name: "Ember" }), "ember")).toBe(
      matchScore(node, node.title),
    );
  });

  it("finds an example by a word in its name, its stem, or its description", () => {
    const found = (query: string): string[] =>
      searchExamples(shipped, query).map((entry) => entry.fileName);

    expect(found("sounding")).toContain("E44-Sounding.loom.json");
    expect(found("E44")).toContain("E44-Sounding.loom.json");
    // The description tier is what makes the taxonomy's precedence survivable: E45 is
    // filed under `audio`, and someone hunting point systems still finds it by prose.
    const byProse = found("constellation");
    expect(byProse).toContain("E45-Pulse.loom.json");
    expect(byProse.length).toBeLessThan(shipped.length);
  });

  it("does not rank every example alike for `loom` or `json`", () => {
    // The stem, not the file name: `E44-Sounding.loom.json` word-splits to include
    // "loom" and "json", and indexing those would make one query match all 38.
    expect(searchExamples(shipped, "json")).toHaveLength(0);
    expect(searchExamples(shipped, "loom").length).toBeLessThan(shipped.length);
  });

  it("returns nothing for a query nothing matches, rather than everything", () => {
    expect(searchExamples(shipped, "zzzznotathing")).toEqual([]);
    expect(filterExamples(shipped, { query: "zzzznotathing" })).toEqual([]);
  });

  it("breaks ties on natural order, so E9 precedes E10", () => {
    // Every example matches the empty query at the same score; the order must be the
    // catalogue's, not `localeCompare`'s, which files E10 between E1 and E2.
    const names = filterExamples(shipped, {}).map((entry) => entry.fileName);
    expect(names.indexOf("E9-Ember.loom.json")).toBeLessThan(
      names.indexOf("E10-Instanced-Torus.loom.json"),
    );
    expect([...shipped].sort(compareExamples).map((entry) => entry.fileName)).toEqual(names);
  });

  it("applies the category as a hard filter, then ranks inside it", () => {
    const audio = filterExamples(shipped, { category: "audio" });
    expect(audio.length).toBeGreaterThan(1);
    for (const entry of audio) expect(entry.category).toBe("audio");

    // A query that matches outside the category does not smuggle a row back in.
    const narrowed = filterExamples(shipped, { category: "audio", query: "sounding" });
    expect(narrowed.every((entry) => entry.category === "audio")).toBe(true);
    expect(narrowed.map((entry) => entry.fileName)).not.toContain("E44-Sounding.loom.json");
  });

  it("derives the filter's category list from the catalogue, with no second list", () => {
    // The same `categoriesOf` the node pane calls (§V754/§V487) — one derivation, so a
    // new category appears in the filter the moment an example earns it.
    expect(categoriesOf(shipped)).toEqual([...new Set(shipped.map((e) => e.category))].sort());
  });
});

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));

/** Native pixel size, straight out of the PNG's IHDR — no image library needed. */
function pngSize(file: string): { width: number; height: number } {
  const header = readFileSync(file).subarray(0, 24);
  expect(header.subarray(12, 16).toString("ascii"), file).toBe("IHDR");
  return { width: header.readUInt32BE(16), height: header.readUInt32BE(20) };
}

describe("§T888 — the hover card is as wide as the thumbnail actually is", () => {
  const thumbs = shipped
    .map((entry) => entry.fileName.replace(/\.loom\.json$/, ""))
    .map((stem) => `${ROOT}examples/thumbs/${stem}.png`)
    .filter((file) => {
      try {
        readFileSync(file);
        return true;
      } catch {
        // §T847's seam allows a loom to land before its thumb. That absence is that
        // gate's business; this one only speaks about the thumbs that exist.
        return false;
      }
    });

  it("renders every thumbnail at ONE native size, and that size is 16:9", () => {
    expect(thumbs.length).toBeGreaterThan(0);
    const sizes = new Set(
      thumbs.map((file) => {
        const { width, height } = pngSize(file);
        return `${width}x${height}`;
      }),
    );
    // One size, or "the card is as wide as the thumbnail" has no single answer.
    expect([...sizes]).toHaveLength(1);

    const { width, height } = pngSize(thumbs[0] as string);
    // This is what `aspect-ratio: 16 / 9` on `.cardThumb` is ASSERTING about the source.
    // If the render ever stops being 16:9, `object-fit: cover` starts silently cropping.
    expect(width * 9).toBe(height * 16);
  });

  it("derives the card's width from that size rather than picking one by eye", () => {
    const { width } = pngSize(thumbs[0] as string);
    const css = readFileSync(`${ROOT}src/editor/library/library.module.css`, "utf8");
    const declared = /--card-thumb-width:\s*(\d+)px/.exec(css)?.[1];

    /*
     * The owner reported the card as "a bit wide", and the cause was a number that had
     * drifted from its source: §T877 moved the card onto the popover primitive and it
     * inherited a 420px cap, upscaling a 256px image ~1.5x. jsdom does no layout, so the
     * rendered width is not observable here — what IS observable, and what actually went
     * wrong, is the CSS quietly disagreeing with the asset it is sizing.
     */
    expect(declared, "`--card-thumb-width` in library.module.css").toBe(String(width));
  });
});
