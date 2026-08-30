import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Every source file must be GREPPABLE (found while starting T344).
 *
 * A single raw control byte — a NUL used as a separator inside a string literal — makes a
 * whole file read as BINARY to `grep`, `rg`, and anything else that sniffs content before
 * deciding whether to search it. The file compiles, its tests pass, and every repo-wide
 * search silently SKIPS it. No error, no warning, no output at all.
 *
 * That failure mode is specifically dangerous HERE. This project's dominant bug is
 * "built, tested, never wired" (§V220), and the way it gets found is by searching for
 * callers. Two files were invisible: `app/graph-pane.tsx` and `domain/parameters/pulse.ts`
 * — and `graph-pane.tsx` is the ONLY caller of `NodePreviewSlot` and `renderPreview`. A
 * search for either returned nothing, which is precisely the evidence someone would use
 * to conclude the node preview system has no caller.
 *
 * It surfaced only because `grep` and `sed` disagreed about the same line, which is not a
 * technique anyone should have to depend on.
 *
 * The fix is always the ESCAPE rather than the byte: the runtime value is identical and
 * the file stays text.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, "../..");

/** Tab, newline and carriage return are the only control bytes source may contain. */
const ALLOWED = new Set([0x09, 0x0a, 0x0d]);

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (/\.(ts|tsx|css|wgsl|json|md)$/.test(entry)) out.push(full);
  }
  return out;
}

describe("no source file is invisible to a repo-wide search", () => {
  it("contains no raw control bytes outside tab, newline and carriage return", () => {
    const offenders: string[] = [];
    for (const path of sourceFiles(SRC)) {
      const bytes = readFileSync(path);
      for (let index = 0; index < bytes.length; index += 1) {
        const byte = bytes[index] as number;
        if (byte >= 0x20 || ALLOWED.has(byte)) continue;
        const line = bytes.subarray(0, index).toString("utf8").split("\n").length;
        const hex = byte.toString(16).padStart(2, "0");
        offenders.push(
          `${relative(SRC, path)}:${line} holds byte 0x${hex} — write it as an escape, not as the byte`,
        );
        break;
      }
    }
    expect(offenders).toEqual([]);
  });

  it("scans a real tree, or it is asserting nothing", () => {
    // NON-VACUITY: a broken walk would report no offenders just as convincingly.
    expect(sourceFiles(SRC).length).toBeGreaterThan(300);
  });
});
