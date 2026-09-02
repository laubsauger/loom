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

/** As much of the saved graph's shape as these gates read. */
interface Graph {
  nodes?: Record<
    string,
    { type?: string; label?: string; parameters?: Record<string, unknown> }
  >;
  edges?: Record<string, { source?: { portId?: string }; target?: { portId?: string } }>;
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
 * T890/§V808 — A FENCED REFERENCE MUST RESOLVE EVEN WHEN IT NAMES NO TYPE.
 *
 * T522 above reads only `name(type)` claims, and that type filter is exactly what makes
 * it precise and cheap. It is also what blinds it. §T885 is the instance: §T826 renamed
 * ONE node (`tearn`, which had collided with `tearb` on the label `tearb1`, became
 * `tearn1`) and left TWO stale references in `E40-Wake.md` — and the gate saw one.
 *
 *   tearng1 ─► tearnb1 ─► tearb1(valueLimit)   ← carries a type, T522 caught it
 *   shiftb1(transform) ┄ tearb1                ← carries none, unreachable by T522
 *
 * Both named the node that had been renamed; only one was a "claim" under the type
 * filter. §V808 is the shape of that: THE PRECISION THAT MAKES A GREP-BASED GATE CHEAP IS
 * THE SAME PROPERTY THAT BLINDS IT — a grep proves a string exists, not that it is the
 * right string in the right place.
 *
 * ## The filter, and why it reads four namespaces rather than carrying a list
 *
 * Inside fences only, tokens matching the house LABEL SHAPE — lowercase, letters, a
 * trailing digit (`tearb1`, `shiftb1`, `out1`) — with dotted tokens excluded exactly as
 * T522 excludes them and for the same reason. A token RESOLVES if the document holds it
 * as a node id, a node LABEL, a PARAMETER name, or a PORT name.
 *
 * That four-way lookup was not a guess; it is what the census forced. Measured on the
 * shipped catalogue BEFORE this was written: 643 label-shaped tokens in fences, 8 of
 * which did not resolve as node names. Six of those eight are real things that are simply
 * not nodes — `value1`/`value2` are the kernel's own generic scalar slots (T479) written
 * bare in a driver annotation, and `in1` is a real port — so reading parameters and ports
 * too dissolves them structurally instead of parking six entries in an exemption list
 * that would then have to be kept true. The remaining TWO were both defects:
 *
 *   - `E24`'s `─► hue1 ─► out1`, where the node is `out`, unlabelled. T522's own docblock
 *     names this pattern ("nodes named `state1`/`out1` where the document says
 *     `state`/`out`") — it caught those instances because they carried a type, and missed
 *     this one because it did not. Fixed with this gate.
 *   - `E40`'s `pathx1/y1`, below.
 *
 * ## THE BLIND SPOT, AND IT INCLUDES THE CASE THIS GATE WAS ASKED FOR
 *
 * Say it plainly, because the opposite is what a reader will assume: THIS GATE DOES NOT
 * CATCH §T885's SECOND DEFECT. It was red-verified against it and stayed green. The
 * annotation `shiftb1(transform) ┄ tearb1` names `tearb1`, which IS a real label in that
 * document — `tearb`'s. The defect was never that the name was missing; it was that the
 * name was the WRONG EXISTING NODE, because `shiftb1` binds `tearn1:high`. An existence
 * check cannot see that, and no amount of loosening this filter will make it.
 *
 * What would: reading the `┄` DRIVER notation and asserting the annotated node actually
 * binds the named one. That was scoped and REFUSED, with the reason measured — the
 * notation has at least five spellings in the shipped corpus (`x ┄ y`, `x ┄drives┄► y.p`,
 * `x ┄► y.p`, `f(node, param ┄ driver)`, `┄ source: "name" ┄`), several carrying
 * slash-compressed pairs (`eye.x/z ┄ orbax1/orbaz1`) and `·`-chained value nodes. A
 * half-parser that handled two of the five would go green on the three it did not read,
 * which is §V808 REPRODUCED rather than closed. It needs the bindings read from the
 * document against a notation that is regular first.
 *
 * So what this gate DOES buy, exactly: a reference to a name that is NOT THERE AT ALL —
 * the other half of the class, and the half that let `E24`'s `out1` sit unread. It also
 * does not read edge DIRECTION (a diagram drawing `a1 ─► b1` where the file wires
 * `b1 ─► a1` resolves both ends and passes), and a node whose label carries no trailing
 * digit does not match the label shape and is invisible to it — precisely as an untyped
 * reference was invisible to T522.
 */
describe("T890 — a fenced reference resolves against the document, typed or not", () => {
  const pairs = readdirSync(EXAMPLES_DIR)
    .filter((name) => name.endsWith(".md") && name.startsWith("E"))
    .map((name) => ({ md: name, loom: name.replace(/\.md$/, ".loom.json") }))
    .filter((pair) => existsSync(join(EXAMPLES_DIR, pair.loom)));

  /** Lowercase, letters, trailing digit. The house convention every label follows. */
  const LABEL_SHAPE = /^[a-z][a-zA-Z]*\d+$/;

  /**
   * A reference the document does not hold, kept because spelling it out costs more than
   * it is worth. Same convention as `doc-claims`' DELIBERATE: an exemption is only as
   * good as its stated reason, and a stale one is a gate declining to check something
   * that is now true.
   */
  const NOT_A_NODE: ReadonlyArray<{ doc: string; token: string; reason: string }> = [
    {
      doc: "E40-Wake.md",
      token: "y1",
      reason:
        "the tail of `pathx1/y1`, a slash-compressed pair naming `pathx1` and `pathy1` — both of which ship. Writing it out lengthens the line by four columns and pushes the junction's `┐` three columns off the `├` and `┘` it connects to, so the diagram would read as broken to buy one token.",
    },
  ];

  /** Every name the document answers to: node ids, labels, parameter names, port ids. */
  function documentTokens(loomText: string): ReadonlySet<string> {
    const parsed = JSON.parse(loomText) as {
      graph?: Graph;
      document?: { graph?: Graph };
    };
    const graph = parsed.graph ?? parsed.document?.graph ?? {};
    const tokens = new Set<string>();
    for (const [id, node] of Object.entries(graph.nodes ?? {})) {
      tokens.add(id);
      if (typeof node.label === "string" && node.label !== "") tokens.add(node.label);
      for (const parameter of Object.keys(node.parameters ?? {})) tokens.add(parameter);
    }
    for (const edge of Object.values(graph.edges ?? {})) {
      for (const side of [edge.source, edge.target]) {
        if (typeof side?.portId === "string") tokens.add(side.portId);
      }
    }
    return tokens;
  }

  /** Label-shaped, undotted tokens inside ``` fences. */
  function fencedReferences(markdown: string): string[] {
    const found: string[] = [];
    for (const [, block] of markdown.matchAll(/```[a-z]*\n([\s\S]*?)```/g)) {
      if (block === undefined) continue;
      for (const [, token] of block.matchAll(/(?<![\w.])([a-zA-Z_][\w-]*)(?![\w.])/g)) {
        if (token !== undefined && LABEL_SHAPE.test(token)) found.push(token);
      }
    }
    return found;
  }

  it("is reading real references, or it is reading nothing", () => {
    // §V739's guard: a scan that suddenly finds almost nothing has broken, and a gate
    // that passes because it stopped looking is worse than no gate. Census measured 643.
    const total = pairs.reduce(
      (count, pair) =>
        count + fencedReferences(readFileSync(join(EXAMPLES_DIR, pair.md), "utf8")).length,
      0,
    );
    expect(total).toBeGreaterThan(400);
  });

  it.each(pairs.map((pair) => [pair.md, pair] as const))(
    "%s references only names its document answers to",
    (_name, pair) => {
      const markdown = readFileSync(join(EXAMPLES_DIR, pair.md), "utf8");
      const tokens = documentTokens(readFileSync(join(EXAMPLES_DIR, pair.loom), "utf8"));
      const exempt = new Set(
        NOT_A_NODE.filter((entry) => entry.doc === pair.md).map((entry) => entry.token),
      );
      const dangling = [...new Set(fencedReferences(markdown))]
        .filter((token) => !tokens.has(token) && !exempt.has(token))
        .map((token) => `${token}: no node, parameter or port of that name in ${pair.loom}`);
      expect(dangling, dangling.join("\n")).toEqual([]);
    },
  );

  it("carries no exemption for a reference that now resolves", () => {
    // §V421's both-directions pin: a FIXED entry left un-struck fails as stale, so the
    // list cannot quietly outlive the reason it was written for.
    const stale = NOT_A_NODE.filter((entry) => {
      const loom = join(EXAMPLES_DIR, entry.doc.replace(/\.md$/, ".loom.json"));
      if (!existsSync(loom)) return true;
      return documentTokens(readFileSync(loom, "utf8")).has(entry.token);
    }).map((entry) => `${entry.doc}/${entry.token} resolves now — delete the exemption`);
    expect(stale, stale.join("\n")).toEqual([]);
  });
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
