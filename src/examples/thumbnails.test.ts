import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EXAMPLES_DIR, listExamples } from "./catalogue.ts";
import { PNG_SIGNATURE } from "../runtime/export/png.ts";
import { THUMBNAIL_RESOLUTION, thumbnailStem } from "./thumbnail.ts";

/**
 * The thumbnail gate (T847, §V775). A thumbnail is a §V642 baseline in disguise — a still
 * regenerated with the example — so the property that matters is the one no single
 * regeneration can guarantee: that EVERY shipped loom has one. Without this gate the 38th
 * example ships without a card and the gallery has a hole, exactly the way §V775 says a
 * per-instance fix leaves the class open.
 *
 * Regenerate after a look change in the same commit:
 *   node --import ./src/mcp/alias-hooks.ts src/examples/build-thumbnails.ts [--only <name>]
 */

const thumbsDir = join(EXAMPLES_DIR, "thumbs");
const looms = listExamples();

describe("every shipped example has a thumbnail (T847)", () => {
  it("names at least the examples the catalogue ships", () => {
    // A guard on the guard: if the loom list came back empty the per-file checks below
    // would vacuously pass and the gate would guard nothing.
    expect(looms.length).toBeGreaterThan(30);
  });

  it.each(looms.map((loom) => loom.fileName))("%s has a thumbs/<stem>.png", (fileName) => {
    const path = join(thumbsDir, `${thumbnailStem(fileName)}.png`);
    expect(existsSync(path), `missing thumbnail: ${path} — run build-thumbnails.ts`).toBe(true);
  });

  it.each(looms.map((loom) => loom.fileName))("%s's thumbnail is a real, non-empty PNG", (fileName) => {
    const path = join(thumbsDir, `${thumbnailStem(fileName)}.png`);
    if (!existsSync(path)) return; // the existence gate above already fails, loudly
    const bytes = readFileSync(path);
    // A real file with pixels in it, not a zero-byte stub a half-finished run left behind.
    expect(statSync(path).size).toBeGreaterThan(0);
    // The PNG magic: proof it is an image, not JSON or an error written to the wrong path.
    expect([...bytes.subarray(0, 8)]).toEqual(PNG_SIGNATURE);
    // IHDR carries the dimensions at a fixed offset; assert the card size the seam promises.
    const width = bytes.readUInt32BE(16);
    const height = bytes.readUInt32BE(20);
    expect({ width, height }).toEqual({ width: THUMBNAIL_RESOLUTION.width, height: THUMBNAIL_RESOLUTION.height });
  });
});
