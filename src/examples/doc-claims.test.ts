import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { EXAMPLES_DIR, listExamples } from "./catalogue.ts";
import { allNodeDefinitions } from "../nodes/definitions/index.ts";
import { requireExample } from "./runner.ts";

/**
 * B83/§V332 — a concept doc must not name a NODE TYPE its graph does not contain.
 *
 * B83 is the instance: `E20-Gooeyball.md` named `renderSurface` three times while the
 * shipped `.json` contained it zero times. The T446/T447 ports→references redirect had
 * rewritten the graph onto `geometry` + `render`, and the doc — written before the
 * convention changed — kept looking authoritative. §V332's whole point is that this is a
 * CLASS, not an accident: the doc written next gets it right and every doc written before
 * keeps the old claim. So it is gated rather than corrected, and the sweep that found B83
 * (§V186b: grep the claim, not the file) is now the sweep that runs on every commit.
 *
 * SCOPED TO camelCase TYPES on purpose. `render`, `light`, `edge`, `mirror`, `cross` are
 * ordinary English and appear in every doc legitimately; `renderSurface`, `audioFileIn`,
 * `pointTopology` cannot be anything but a claim about a node. That is the whole set worth
 * gating, and a looser filter would be noise nobody reads.
 *
 * A doc that names a node it does not USE, on purpose, says so here with its reason — the
 * `NOT_CONSTRUCTED` convention from the composition-seams gate. Two exist today and both
 * are deliberate: an instruction to the reader, and a note about a sibling node.
 */

const DELIBERATE: ReadonlyArray<{ doc: string; type: string; reason: string }> = [
  {
    doc: "E24-Audio-Reaction-Diffusion.md",
    type: "audioIn",
    reason:
      "T504: `audioFileIn` is now genuinely IN this graph (branch 1 of the Switch) so its exemption is gone, but the microphone is still only an instruction — a shipped `audioIn` opens the device on load, which an example must not do. The doc says how to add it as branch 2.",
  },
  {
    doc: "E34-Lidar.md",
    type: "renderPoints",
    reason:
      "the T642 deviation paragraph: it names the node whose group-predicate seam the lit scene path LACKS, to say the readings here are a workaround and not the idiom. A statement about an absent capability, deliberately about a node this graph cannot use.",
  },
  {
    doc: "E27-Relief.md",
    type: "audioIn",
    reason:
      "the UNDERSTUDY paragraph, generalising: the pattern this example establishes for `webcam` is what would let the two audio inputs be exampled under §V363 too. A statement about a FUTURE graph, deliberately not applied here — one example, one claim.",
  },
  {
    doc: "E34-Lidar.md",
    type: "renderPoints",
    reason:
      "the T642 deviation paragraph: it names the node whose group-predicate seam the lit scene path LACKS, to say the readings here are a workaround and not the idiom. A statement about an absent capability, deliberately about a node this graph cannot use.",
  },
  {
    doc: "E27-Relief.md",
    type: "audioFileIn",
    reason: "the file half of the same generalisation.",
  },
  {
    doc: "E29-Descent.md",
    type: "audioFileIn",
    reason:
      "an INSTRUCTION to the reader, the same one E24 carries: the example ships the deterministic audioPattern (§V363) so it plays with no asset, and the doc says which node to swap in to drive it from a real track.",
  },
  {
    doc: "E13-Prism.md",
    type: "renderInstances",
    reason:
      "a struck-through limitation note about a SIBLING renderer (T369 closed it), explicitly contrasted with the renderPoints this example does use.",
  },
];

describe("concept docs name only nodes their graphs contain (B83, §V332)", () => {
  const camelTypes = allNodeDefinitions.map((definition) => definition.type).filter((type) => /[A-Z]/.test(type));

  it("has a camelCase type set worth gating", () => {
    // A guard on the guard: if the catalogue ever renamed every compound type to a single
    // word, this whole file would pass by having nothing to check (§V337).
    expect(camelTypes.length).toBeGreaterThan(10);
    expect(camelTypes).toContain("renderSurface");
  });

  it.each(listExamples().map((file) => file.fileName))("%s", (fileName) => {
    const { document } = requireExample(
      listExamples().find((file) => file.fileName === fileName) as ReturnType<typeof listExamples>[number],
    );
    const present = new Set(Object.values(document.graph.nodes).map((node) => node.type));
    const docName = fileName.replace(/\.loom\.json$/, ".md");
    const docPath = join(EXAMPLES_DIR, docName);
    // A shipped example with no concept doc yet makes no claims to check. It is NOT
    // silently fine — `readme.test.ts` (T349) fails it by name for exactly this — and
    // duplicating that red here would be two failures for one cause (§V350: gate the
    // outermost observable, once). A doc that exists is always checked.
    if (!existsSync(docPath)) return;
    const prose = readFileSync(docPath, "utf8");
    const excused = new Set(DELIBERATE.filter((entry) => entry.doc === docName).map((entry) => entry.type));

    const claimed = camelTypes.filter(
      (type) => new RegExp(`\\b${type}\\b`).test(prose) && !present.has(type) && !excused.has(type),
    );
    expect(
      claimed,
      `${docName} names ${claimed.join(", ")}, which its graph does not contain. Fix the prose, or add it to DELIBERATE with the reason.`,
    ).toEqual([]);
  });

  it("excuses nothing that is no longer needed", () => {
    // An excuse that has gone stale is the same lie one level up: it says a doc names a
    // node deliberately when the doc stopped naming it at all.
    for (const entry of DELIBERATE) {
      const prose = readFileSync(join(EXAMPLES_DIR, entry.doc), "utf8");
      expect(new RegExp(`\\b${entry.type}\\b`).test(prose), `${entry.doc} no longer names ${entry.type}`).toBe(true);
      expect(entry.reason.length).toBeGreaterThan(20);
    }
  });
});
