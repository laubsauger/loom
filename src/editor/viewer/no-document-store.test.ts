import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * §V16 asserted structurally — preview pixels and per-frame metrics never enter the document
 * store and never re-render the node tree.
 *
 * The failure this prevents is specific and expensive: someone writes the hovered pixel value,
 * or the current tile rect, into the zustand graph store "just for now". Every write there
 * bumps the revision (§V33), lands in the audit ring (§V31), makes the project dirty, and
 * schedules an autosave (T101) — sixty times a second while a pointer moves. The preview
 * system is deliberately built so it has no way to do that: it holds no store reference at all.
 *
 * The out-of-document channel that DOES exist — `NodeRuntimeStore`, already coalesced to
 * <= 10 Hz — is the one previews use for node-facing status. This guard also stops a second
 * one being grown here by accident.
 */

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const OWNED = [join(ROOT, "runtime", "previews"), join(ROOT, "editor", "viewer")];

/** Mutating or subscribing to canonical document state, by any spelling. */
const FORBIDDEN: ReadonlyArray<{ pattern: RegExp; why: string }> = [
  { pattern: /\bfrom\s+["']zustand/, why: "a store subscription belongs to the document layer" },
  { pattern: /\bfrom\s+["']immer["']/, why: "document drafts are the command bus's business" },
  { pattern: /@domain\/graph\/store/, why: "the graph store is not a preview dependency" },
  { pattern: /@domain\/commands/, why: "previews mutate nothing, so they need no command bus" },
  { pattern: /\bapplyPatch\b|\bGraphPatch\b/, why: "previews are not a mutation path (§V29)" },
  { pattern: /\buseStore\b/, why: "no component here subscribes to the document" },
];

function collect(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      collect(path, out);
      continue;
    }
    if (!/\.(ts|tsx)$/.test(entry.name)) continue;
    if (/\.test\.(ts|tsx)$/.test(entry.name)) continue;
    out.push(path);
  }
  return out;
}

const files = OWNED.flatMap((dir) => collect(dir));

describe("§V16 — nothing preview-related touches the document store", () => {
  it("scans both owned directories", () => {
    // Guards the guard.
    expect(files.length).toBeGreaterThan(8);
    expect(files.some((file) => file.includes("previews"))).toBe(true);
    expect(files.some((file) => file.includes("viewer"))).toBe(true);
  });

  it.each(files.map((file) => [relative(ROOT, file), file]))("%s", (_name, file) => {
    const source = readFileSync(file, "utf8");
    const violations = FORBIDDEN.filter((rule) => rule.pattern.test(source)).map(
      (rule) => rule.why,
    );
    expect(violations).toEqual([]);
  });
});

describe("§V63 — the preview runtime stays worker-movable", () => {
  const runtimeFiles = files.filter((file) => file.includes(join("runtime", "previews")));

  it.each(runtimeFiles.map((file) => [relative(ROOT, file), file]))(
    "%s reads no DOM global",
    (_name, file) => {
      // Lint enforces this too (T92); the test states WHY it matters. `devicePixelRatio` is a
      // `window` property, and reading it here rather than taking it as an argument is the
      // single most likely way this directory would acquire a DOM dependency.
      const source = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, " ");
      expect(source).not.toMatch(/\bwindow\.|\bdocument\.|\bnavigator\./);
    },
  );
});
