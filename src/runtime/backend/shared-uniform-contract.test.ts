import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { SHARED_UNIFORMS_WGSL, initialSharedUniforms } from "./shared-uniforms.ts";

/**
 * T489 — every hand-written copy of `struct SharedFrame` still matches the real one.
 *
 * ## The bug this exists because of
 *
 * `SHARED_UNIFORMS_WGSL` is the contract, and the built-in shaders interpolate it, so they
 * regenerate together and cannot fall behind. A user-authored shader cannot: a `customWgsl`
 * node's source is TEXT in the document, so the struct is typed out once and then frozen.
 * E12-Fluid's stir shader is exactly that, and T468 — the round that gave texture shaders
 * the absolute clock — inserted `absTime`/`absFrame` into the canonical block and left that
 * copy on eight members. The copy still ran (vgpu adopts the layout the first binding
 * declares and writes by name, so the two extra values were simply dropped), which is the
 * worst possible failure: the shipped example that teaches people the contract taught a
 * contract with no absolute clock in it, and a user who typed `frameU.absTime` into it got
 * "no member named absTime" from a block whose buffer was carrying the number all along.
 *
 * That is §V437 in miniature — the round that delivered the clock to one surface broke the
 * documentation of another — and §V316's shape too: a contract stated in one place and
 * duplicated by hand in a second narrows the moment the first one grows.
 *
 * ## What is asserted
 *
 * A repo-wide scan, not a list of files. Any file that declares `struct SharedFrame` must
 * declare EXACTLY the canonical members, in order. A tenth member added to the block, or a
 * new example that copies today's text and is still around after the eleventh, fails here
 * rather than shipping a stale contract.
 */

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const SCANNED_DIRECTORIES = ["src", "examples"];
const SCANNED_EXTENSIONS = [".ts", ".tsx", ".wgsl", ".json", ".md"];
const SKIPPED = new Set(["node_modules", "dist", ".git", "test-results", "playwright-report"]);

function walk(directory: string, out: string[]): string[] {
  for (const entry of readdirSync(directory)) {
    if (SKIPPED.has(entry)) continue;
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (SCANNED_EXTENSIONS.some((extension) => entry.endsWith(extension))) out.push(path);
  }
  return out;
}

/** Member names in declaration order, from a `struct SharedFrame { ... }` body. */
function membersOf(body: string): string[] {
  return [...body.matchAll(/(\w+)\s*:\s*[\w<>,\s]+?,/g)].map((match) => match[1] as string);
}

/**
 * Every `struct SharedFrame { ... }` in the scanned tree, however it is spelled — a WGSL
 * source file, a template literal in TypeScript, or a JSON-escaped string inside a shipped
 * `.loom.json` document. The `\\n` alternative in the separator is what reaches the last of
 * those; without it the gate would have passed over the very file that motivated it.
 */
function declarations(): { path: string; members: string[] }[] {
  const found: { path: string; members: string[] }[] = [];
  for (const path of walk(join(ROOT, SCANNED_DIRECTORIES[0] as string), []).concat(
    walk(join(ROOT, SCANNED_DIRECTORIES[1] as string), []),
  )) {
    const text = readFileSync(path, "utf8");
    for (const match of text.matchAll(/struct SharedFrame\s*\{((?:[^{}]|\\n)*?)\}/g)) {
      const body = (match[1] as string).replace(/\\n/g, "\n");
      const relative = path.slice(ROOT.length);
      // This file quotes the struct's NAME in prose; it is the police, not the policed.
      if (relative.endsWith("shared-uniform-contract.test.ts")) continue;
      found.push({ path: relative, members: membersOf(body) });
    }
  }
  return found;
}

const CANONICAL = membersOf(SHARED_UNIFORMS_WGSL.slice(SHARED_UNIFORMS_WGSL.indexOf("{") + 1));

describe("T489 — the shared frame block has exactly one contract", () => {
  it("the canonical block and the value writer declare the same members, in the same order", () => {
    // The WGSL text and the JS object are two halves of one layout: vgpu reflects the
    // struct and writes the object into it by name, so a member in one and not the other is
    // either a silent zero or a silently dropped value.
    expect(CANONICAL).toEqual(Object.keys(initialSharedUniforms()));
  });

  it("the canonical block carries the ABSOLUTE pair (T461/T468)", () => {
    expect(CANONICAL).toContain("absTime");
    expect(CANONICAL).toContain("absFrame");
  });

  it("the scan actually finds the declarations it is supposed to police", () => {
    // A repo-wide regex that quietly matches nothing is a green test that checks nothing.
    // The canonical definition and E12's hand copy are both real and both must be seen.
    const paths = declarations().map((entry) => entry.path);
    expect(paths).toContain("src/runtime/backend/shared-uniforms.ts");
    expect(paths.some((path) => path.endsWith(".loom.json"))).toBe(true);
    expect(declarations().length).toBeGreaterThanOrEqual(3);
  });

  it("every hand-written copy in src/ and examples/ matches it member for member", () => {
    const drifted = declarations().filter((entry) => entry.members.join(",") !== CANONICAL.join(","));
    expect(
      drifted.map((entry) => `${entry.path}: [${entry.members.join(", ")}]`),
      `a copy of SharedFrame has fallen behind [${CANONICAL.join(", ")}]. A user reading that ` +
        "shader cannot reach the members it is missing, even though the bound buffer carries " +
        "them (T489/§V437).",
    ).toEqual([]);
  });
});
