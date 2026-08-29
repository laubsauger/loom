import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * §V7 asserted structurally.
 *
 * "Previews are GPU→GPU; readback only for export, inspect or test" is the kind of rule that
 * decays into a comment nobody re-reads, and the failure is invisible: a per-frame `readOutput`
 * looks fine until someone opens a graph with thirty previews and every frame stalls on a map.
 * So this scans the actual sources.
 *
 * Two claims:
 *  1. No module on the scheduling path names any readback operation.
 *  2. The one module that DOES describe readback — `pixel-probe.ts`, the viewer's explicit
 *     inspection path (§V48) — is imported by none of them.
 */

const DIR = fileURLToPath(new URL(".", import.meta.url));

/** Every spelling by which pixels can come back from the GPU. */
const READBACK = [
  "readOutput",
  "readback",
  "mapAsync",
  "copyTextureToBuffer",
  "getMappedRange",
  "readPixels",
  "toDataURL",
];

const PROBE_MODULE = "pixel-probe.ts";

function sources(): string[] {
  return readdirSync(DIR)
    .filter((name) => name.endsWith(".ts"))
    .filter((name) => !name.endsWith(".test.ts"))
    .map((name) => join(DIR, name));
}

/**
 * Comments are stripped before scanning: this guard is about what the CODE does, and a doc
 * comment explaining "we never call readOutput here" must not read as a violation of itself.
 */
function code(file: string): string {
  return readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^[ \t]*\/\/.*$/gm, " ");
}

/**
 * `index.ts` is a barrel, not a path module: it re-exports the probe's TYPES and its pure
 * decoders so the viewer has one import site. It is excluded from the token scan and included
 * in nothing else, so it cannot smuggle an operation onto the scheduling path.
 */
const EXCLUDED = new Set([PROBE_MODULE, "index.ts"]);

const schedulingPath = sources().filter((file) => !EXCLUDED.has(basename(file)));

describe("§V7 — no readback on the preview scheduling path", () => {
  it("scans a non-trivial number of modules", () => {
    // Guards the guard: a broken walker must not pass silently.
    expect(schedulingPath.length).toBeGreaterThan(4);
  });

  it.each(schedulingPath.map((file) => [basename(file), file]))(
    "%s names no readback operation",
    (_name, file) => {
      expect(READBACK.filter((token) => code(file).includes(token))).toEqual([]);
    },
  );

  it("keeps the pixel probe out of the scheduling path's import graph", () => {
    for (const file of schedulingPath) {
      expect(code(file)).not.toContain(PROBE_MODULE);
    }
  });

  it("keeps the scheduling path free of GPU device access entirely", () => {
    // Previews describe passes; they never encode them. §V2 keeps GPU commands out of React,
    // and this keeps them out of the preview planner too — the backend owns encoding.
    for (const file of schedulingPath) {
      expect(code(file)).not.toMatch(/\bGPUDevice\b|\bcreateCommandEncoder\b|\bnavigator\.gpu\b/);
    }
  });
});
