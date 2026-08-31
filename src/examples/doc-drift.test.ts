import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { exampleRegistry } from "./runner.ts";

/**
 * T522 — EXAMPLE DOCS MUST NOT DESCRIBE A GRAPH THE FILE DOES NOT CONTAIN.
 *
 * Every example ships a `.md` beside its `.loom.json`, and the prose drifts: three
 * instances were found by hand (E5 described a picture the file never rendered; E13 and
 * E7 likewise), and this sweep's first run found six more — nodes named `state1`/`out1`
 * where the document says `state`/`out`, and types claimed as `limit`/`radial` where the
 * node is a `valueLimit`/`ramp`.
 *
 * ## What is gated, deliberately
 *
 * Only claims inside FENCED CODE BLOCKS, and only the graph-diagram idiom
 * `name(type, …)` where the claimed type is a real catalogue type. Prose is not gated —
 * a sentence cannot be checked without understanding it — and dotted tokens are not
 * gated either, because a fenced block full of WGSL is full of `eye.x` and
 * `vec3f(a, b, c)` and every heuristic short of a parser reads those as claims (the
 * type-in-catalogue filter is what makes `T(point)` math and `state1(feedback)` a
 * checkable statement). What survives the filter is exactly the part a reader uses to
 * navigate the graph: this node name, this type.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const EXAMPLES_DIR = join(HERE, "..", "..", "examples");

interface Claim {
  readonly name: string;
  readonly type: string;
}

/** `name(type, …)` occurrences inside ``` fences, filtered to real catalogue types. */
function fencedClaims(markdown: string, knownTypes: ReadonlySet<string>): Claim[] {
  const claims: Claim[] = [];
  for (const [, block] of markdown.matchAll(/```[a-z]*\n([\s\S]*?)```/g)) {
    if (block === undefined) continue;
    for (const [, name, args] of block.matchAll(/([a-zA-Z_][\w-]*)\(([^)]*)\)/g)) {
      const claimed = (args ?? "").trim().split(/[,\s]/)[0] ?? "";
      if (name !== undefined && knownTypes.has(claimed)) claims.push({ name, type: claimed });
    }
  }
  return claims;
}

interface DocumentNodes {
  readonly typeByName: ReadonlyMap<string, string>;
}

/** Node ids AND labels — the md may use either, exactly as the UI shows either. */
function documentNodes(loomText: string): DocumentNodes {
  const parsed = JSON.parse(loomText) as {
    graph?: { nodes?: Record<string, { type?: string; label?: string }> };
    document?: { graph?: { nodes?: Record<string, { type?: string; label?: string }> } };
  };
  const nodes = parsed.graph?.nodes ?? parsed.document?.graph?.nodes ?? {};
  const typeByName = new Map<string, string>();
  for (const [id, node] of Object.entries(nodes)) {
    if (typeof node.type !== "string") continue;
    typeByName.set(id, node.type);
    if (typeof node.label === "string" && node.label !== "") typeByName.set(node.label, node.type);
  }
  return { typeByName };
}

describe("T522 — example markdown matches the document it sits beside", () => {
  const registry = exampleRegistry();
  const knownTypes = new Set(registry.list().map((definition) => definition.type));

  const pairs = readdirSync(EXAMPLES_DIR)
    .filter((name) => name.endsWith(".md") && name.startsWith("E"))
    .map((name) => ({ md: name, loom: name.replace(/\.md$/, ".loom.json") }))
    .filter((pair) => {
      try {
        readFileSync(join(EXAMPLES_DIR, pair.loom));
        return true;
      } catch {
        return false;
      }
    });

  it("is measuring real pairs and real claims, or it is measuring nothing", () => {
    expect(pairs.length).toBeGreaterThan(10);
    const total = pairs.reduce(
      (count, pair) =>
        count +
        fencedClaims(readFileSync(join(EXAMPLES_DIR, pair.md), "utf8"), knownTypes).length,
      0,
    );
    // The graph-diagram idiom is house style; a sweep that found almost nothing would
    // mean the extraction broke, not that the docs stopped making claims.
    expect(total).toBeGreaterThan(20);
  });

  it.each(pairs.map((pair) => [pair.md, pair] as const))(
    "%s names only nodes its document contains, at their real types",
    (_name, pair) => {
      const markdown = readFileSync(join(EXAMPLES_DIR, pair.md), "utf8");
      const { typeByName } = documentNodes(readFileSync(join(EXAMPLES_DIR, pair.loom), "utf8"));
      const wrong = fencedClaims(markdown, knownTypes)
        .map((claim) => {
          const actual = typeByName.get(claim.name);
          if (actual === undefined) return `${claim.name}(${claim.type}): no node named "${claim.name}" in ${pair.loom}`;
          if (actual !== claim.type) return `${claim.name}(${claim.type}): the node's type is "${actual}"`;
          return null;
        })
        .filter((entry): entry is string => entry !== null);
      expect(wrong, wrong.join("\n")).toEqual([]);
    },
  );
});

/**
 * T516 — CLOCK CLAIMS INSIDE FENCES ARE VERBATIM QUOTES.
 *
 * Two docs were fixed by hand after the code moved underneath them, and the census that
 * built this gate found a third live: E13's fence still showed `abstime * 7 % 360`
 * after T565 dropped the workaround from the shipped expression. Prose may paraphrase;
 * a FENCE that shows clock code is read as the file's contents, so it has to BE the
 * file's contents.
 *
 * Scoped tight so it stays credible (a text gate over free prose is noise): only
 * fenced lines carrying a clock token, and of those, only (a) double-quoted strings —
 * the `roll1.r = "abstime * 7"` idiom — and (b) WGSL-shaped lines reading `ctx.` or
 * `frameU.`. Diagram arrows (`←`, `─`) are relationship annotations, exempt. The
 * census measured one hit and zero noise on the shipped catalogue.
 */
describe("T516 — fenced clock claims match the shipped code", () => {
  const pairs = readdirSync(EXAMPLES_DIR)
    .filter((name) => name.endsWith(".md") && name.startsWith("E"))
    .map((name) => ({ md: name, loom: name.replace(/\.md$/, ".loom.json") }))
    .filter((pair) => existsSync(join(EXAMPLES_DIR, pair.loom)));

  const CLOCK = /ctx\.(absTime|time)\b|frameU\.(absTime|time)\b|\babstime\b/;

  function clockCorpus(loomText: string): string {
    const parsed = JSON.parse(loomText) as {
      graph?: { nodes?: Record<string, { parameters?: Record<string, unknown> }> };
      document?: { graph?: { nodes?: Record<string, { parameters?: Record<string, unknown> }> } };
    };
    const nodes = parsed.graph?.nodes ?? parsed.document?.graph?.nodes ?? {};
    const chunks: string[] = [];
    for (const node of Object.values(nodes)) {
      for (const value of Object.values(node.parameters ?? {})) {
        if (typeof value === "string") chunks.push(value);
        else if (typeof value === "object" && value !== null) {
          const source = (value as { bindings?: { expression?: { source?: string } } }).bindings?.expression?.source;
          if (source !== undefined) chunks.push(source);
        }
      }
    }
    return chunks.join("\n");
  }

  for (const pair of pairs) {
    it(`${pair.md} quotes the clock code it ships`, () => {
      const markdown = readFileSync(join(EXAMPLES_DIR, pair.md), "utf8");
      const corpus = clockCorpus(readFileSync(join(EXAMPLES_DIR, pair.loom), "utf8"));
      const stale: string[] = [];
      for (const [, block] of markdown.matchAll(/```[a-z]*\n([\s\S]*?)```/g)) {
        if (block === undefined) continue;
        for (const line of block.split("\n")) {
          if (!CLOCK.test(line)) continue;
          for (const [, quoted] of line.matchAll(/"([^"]+)"/g)) {
            if (quoted !== undefined && CLOCK.test(quoted) && !corpus.includes(quoted)) {
              stale.push(`quoted "${quoted}" is not in the shipped document`);
            }
          }
          if ((line.includes("ctx.") || line.includes("frameU.")) && !line.includes("←") && !line.includes("─")) {
            const trimmed = line.trim();
            if (!corpus.includes(trimmed)) stale.push(`line \`${trimmed}\` is not in the shipped document`);
          }
        }
      }
      expect(stale, `${pair.md}: ${stale.join("; ")} — the fence claims code the file does not contain (T516)`).toEqual([]);
    });
  }
});
