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
 * `NOT_CONSTRUCTED` convention from the composition-seams gate. Every entry is either an
 * instruction to the reader, a statement about a FUTURE graph, or a note about a sibling
 * node — and an exemption is only as good as its stated reason. T696 is the instance:
 * `E34-Lidar.md`/`renderPoints` was listed TWICE, verbatim, on the reason "a node this
 * graph cannot use", and T672 then gave E34 a real `renderPoints` for its light pool. A
 * stale exemption is a gate declining to check a claim that is no longer true, so both
 * copies were deleted with the work that falsified them.
 */

const DELIBERATE: ReadonlyArray<{ doc: string; type: string; reason: string }> = [
  {
    doc: "E55-Reactor.md",
    type: "audioIn",
    reason:
      "E24's ruling, applied (T1141): a shipped `audioIn` opens the capture device on load, so the microphone is an instruction in the prose — replace `track1`, set `source1` to 1 — and never a node in the file.",
  },
  {
    doc: "E51-Chorus.md",
    type: "audioIn",
    reason:
      "E24's ruling, applied: a shipped `audioIn` opens the capture device on load, and T1014's measurement on THIS graph shows an unselected texture-switch branch is not pruned — `cut1` and `cam1` both emit passes while sitting on index 1. So the microphone is an INSTRUCTION, not a node: the doc says where to wire it (`source1.in3`) and states that the device opens regardless of the value switch, which is why the example does not ship one.",
  },
  {
    doc: "E24-Audio-Reaction-Diffusion.md",
    type: "audioIn",
    reason:
      "T504: `audioFileIn` is now genuinely IN this graph (branch 1 of the Switch) so its exemption is gone, but the microphone is still only an instruction — a shipped `audioIn` opens the device on load, which an example must not do. The doc says how to add it as branch 2.",
  },
  {
    doc: "E27-Relief.md",
    type: "audioIn",
    reason:
      "the UNDERSTUDY paragraph, generalising: the pattern this example establishes for `webcam` is what would let the two audio inputs be exampled under §V363 too. A statement about a FUTURE graph, deliberately not applied here — one example, one claim.",
  },
  {
    doc: "E27-Relief.md",
    type: "audioFileIn",
    reason: "the file half of the same generalisation.",
  },
  {
    doc: "E39-Rosette.md",
    type: "audioFileIn",
    reason:
      "T729: an INSTRUCTION to the reader — swap the deterministic pattern for a real track. The graph ships `audioPattern` so it plays on open (§V363); a shipped `audioFileIn` would carry an asset the file cannot hold (§V363's session-only assets).",
  },
  {
    doc: "E39-Rosette.md",
    type: "webcam",
    reason:
      "T729: named as the third Switch branch the reader can add, generalising E27's understudy pattern (§V411). Not in this graph — a live camera opens the device on load, which an example must not do.",
  },
  {
    doc: "E40-Wake.md",
    type: "audioFileIn",
    reason:
      "T729: the same instruction as E39's, and it matters more here because the gain pairs are fitted to a measured field and the doc says which band drives what.",
  },
  {
    doc: "E40-Wake.md",
    type: "webcam",
    reason:
      "T729: named as the branch to add, and this is the graph where it pays off most — frame differencing on a live camera is what the technique was invented for. Still not shipped, for E27's reason.",
  },
  {
    doc: "E29-Descent.md",
    type: "audioFileIn",
    reason:
      "an INSTRUCTION to the reader, the same one E24 carries: the example ships the deterministic audioPattern (§V363) so it plays with no asset, and the doc says which node to swap in to drive it from a real track.",
  },
  /* T710 removed E13's `renderInstances` exemption with the sentence that needed it: the
     rebuilt Prism is a 3D scene and no longer draws sprites, so the struck-through note
     contrasting the two point renderers had nothing left to contrast. An exemption
     outlives its prose exactly as easily as prose outlives its graph. */
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
